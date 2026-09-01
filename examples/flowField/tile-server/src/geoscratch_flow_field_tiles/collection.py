from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import shutil
import sys
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Iterable

import morecantile
import numpy as np
import rasterio
import rio_cogeo
import scipy

from ._version import PACKAGE_VERSION
from .cog import (
    COG_ARTIFACT_MARKER,
    CogBuildBudget,
    CogBuildPlan,
    CogEncoding,
    plan_velocity_cog_snapshot,
    verify_velocity_cog_snapshot,
)
from .cog_batch import (
    CogSnapshotBatchExecutionBudget,
    CogSnapshotBatchItem,
    build_velocity_cog_snapshot_batch,
)
from .cog_tiles import CogVelocityTileReader
from .contracts import (
    InterpolationSpec,
    TopologySpec,
    resolve_interpolation,
    resolve_topology,
)
from .resolution import (
    FixedWebMercatorResolution,
    ResolutionSpec,
    validate_resolution_selection_manifest,
)
from .runtime_manifest import (
    CogRuntimePageIndex,
    build_cog_runtime_page_index,
    build_cog_runtime_manifest,
    validate_cog_runtime_manifest,
)
from .job_control import (
    JobProgressEvent,
    OutputLock,
    ProgressEmitter,
    ProgressSink,
    atomic_write_json,
)
from .source import (
    DEFAULT_DATA_DIRECTORY,
    DEFAULT_DESCRIPTOR_PATH,
    SourceDescriptor,
    load_source_snapshot,
    read_source_descriptor,
    source_descriptor_hash,
    source_snapshot_hash,
)


TILE_SERVER_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_COG_COLLECTION_DIRECTORY = TILE_SERVER_ROOT / "cog-collection"
COG_COLLECTION_MARKER = ".flow-field-cog-collection.json"
COG_COLLECTION_WORK_MARKER = ".flow-field-cog-collection-work.json"
COG_SNAPSHOT_WORK_MARKER = ".flow-field-cog-snapshot-work.json"
COG_COLLECTION_SCHEMA_VERSION = 1
COG_COLLECTION_ADAPTER_VERSION = "flow-cog-wmq-rg32f-v1"
RUNTIME_MINIMUM_MATRIX = 4
RUNTIME_MAXIMUM_MATRIX = 9


@dataclass(frozen=True, slots=True)
class CogCollectionOutputState:
    kind: str
    device: int | None
    inode: int | None
    marker_sha256: str | None
    manifest_sha256: str | None
    inventory: tuple[str, ...]
    tree_fingerprint_sha256: str | None


class CogCollectionConflictError(RuntimeError):
    code = "FLOW_COG_COLLECTION_CONFLICT"


@dataclass(frozen=True, slots=True)
class CogCollectionBuildResult:
    output_directory: Path
    manifest_path: Path
    runtime_manifest_path: Path
    content_version: str
    status: str
    snapshot_count: int
    page_count: int
    replaced_backup_directory: Path | None = None


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _canonical_sha256(value: object) -> str:
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()


def _is_sha256_value(value: object) -> bool:
    return isinstance(value, str) and len(value) == 64 and all(
        character in "0123456789abcdef" for character in value
    )


def _encoded_json(value: object) -> bytes:
    return (
        json.dumps(
            value,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        )
        + "\n"
    ).encode("utf-8")


def _collection_output_path(
    output_directory: str | Path,
    *,
    create_parent: bool,
) -> Path:
    requested = Path(os.path.abspath(os.fspath(output_directory)))
    if requested.name != "cog-collection" or requested.parent == Path(requested.anchor):
        raise ValueError(
            "Flow Field COG collection output must be an explicit cog-collection directory"
        )
    if create_parent:
        requested.parent.mkdir(parents=True, exist_ok=True)
    elif not requested.parent.is_dir():
        raise FileNotFoundError(
            f"COG collection output parent does not exist: {requested.parent}"
        )
    if requested.is_symlink():
        raise ValueError("Flow Field COG collection output cannot be a symbolic link")
    return requested.parent.resolve(strict=True) / requested.name


def _safe_collection_output(output_directory: str | Path) -> Path:
    return _collection_output_path(output_directory, create_parent=True)


def _safe_child_path(root: Path, value: object, label: str) -> Path:
    if not isinstance(value, str) or not value:
        raise ValueError(f"{label} must be a non-empty relative path")
    relative = Path(value)
    if relative.is_absolute() or ".." in relative.parts or relative.as_posix() != value:
        raise ValueError(f"{label} must be a canonical relative path")
    resolved = root.joinpath(relative)
    if resolved.is_symlink():
        raise ValueError(f"{label} cannot be a symbolic link")
    return resolved


def _read_json_object(path: Path, label: str) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError(f"{label} is unreadable") from error
    if not isinstance(value, dict):
        raise ValueError(f"{label} must be an object")
    return value


def _is_owned_collection_directory(output: Path) -> bool:
    if output.is_symlink() or not output.is_dir():
        return False
    marker_path = output / COG_COLLECTION_MARKER
    manifest_path = output / "manifest.json"
    runtime_manifest_path = output / "runtime-manifest.json"
    snapshots_path = output / "snapshots"
    if (
        not marker_path.is_file()
        or not manifest_path.is_file()
        or not runtime_manifest_path.is_file()
        or marker_path.is_symlink()
        or manifest_path.is_symlink()
        or runtime_manifest_path.is_symlink()
        or snapshots_path.is_symlink()
        or not snapshots_path.is_dir()
    ):
        return False
    try:
        marker = _read_json_object(marker_path, "collection marker")
        manifest = _read_json_object(manifest_path, "collection manifest")
    except ValueError:
        return False
    if marker != {
        "kind": "geoscratch-flow-field-cog-collection",
        "contentVersion": manifest.get("contentVersion"),
    }:
        return False
    if (
        manifest.get("schemaVersion") != COG_COLLECTION_SCHEMA_VERSION
        or manifest.get("artifactType") != "flow-field-cog-collection"
    ):
        return False
    if {entry.name for entry in output.iterdir()} != {
        COG_COLLECTION_MARKER,
        "manifest.json",
        "runtime-manifest.json",
        "snapshots",
    }:
        return False
    records = manifest.get("snapshots")
    if not isinstance(records, list) or not records:
        return False
    expected_names: set[str] = set()
    for record in records:
        if not isinstance(record, dict):
            return False
        time_index = record.get("timeIndex")
        if isinstance(time_index, bool) or not isinstance(time_index, int) or time_index < 0:
            return False
        name = f"t{time_index:02d}"
        if name in expected_names or record.get("directory") != f"snapshots/{name}":
            return False
        child = snapshots_path / name
        cog_path = record.get("cogPath")
        if (
            child.is_symlink()
            or not child.is_dir()
            or not isinstance(cog_path, str)
            or Path(cog_path).parent.as_posix() != f"snapshots/{name}"
        ):
            return False
        cog_name = Path(cog_path).name
        if {entry.name for entry in child.iterdir()} != {
            ".flow-field-cog-artifact.json",
            "manifest.json",
            cog_name,
        }:
            return False
        if any(entry.is_symlink() for entry in child.iterdir()):
            return False
        expected_names.add(name)
    return {entry.name for entry in snapshots_path.iterdir()} == expected_names


def _collection_tree_fingerprint(output: Path) -> str:
    digest = hashlib.sha256()
    for path in sorted(output.rglob("*"), key=lambda value: value.relative_to(output).as_posix()):
        relative = path.relative_to(output).as_posix()
        stat_result = path.lstat()
        record = (
            relative,
            stat_result.st_mode,
            stat_result.st_dev,
            stat_result.st_ino,
            stat_result.st_size,
            stat_result.st_mtime_ns,
            stat_result.st_ctime_ns,
        )
        digest.update(json.dumps(record, separators=(",", ":")).encode("utf-8") + b"\n")
    return digest.hexdigest()


def _capture_collection_output_state(output: Path) -> CogCollectionOutputState:
    if output.is_symlink():
        raise ValueError("Flow Field COG collection output cannot be a symbolic link")
    if not os.path.lexists(output):
        return CogCollectionOutputState("absent", None, None, None, None, (), None)
    if not _is_owned_collection_directory(output):
        raise ValueError("Flow Field refuses an unowned COG collection directory")
    stat_result = output.stat()
    return CogCollectionOutputState(
        kind="owned",
        device=stat_result.st_dev,
        inode=stat_result.st_ino,
        marker_sha256=_sha256(output / COG_COLLECTION_MARKER),
        manifest_sha256=_sha256(output / "manifest.json"),
        inventory=tuple(sorted(entry.name for entry in output.iterdir())),
        tree_fingerprint_sha256=_collection_tree_fingerprint(output),
    )


def _install_collection_directory(
    staged: Path,
    output: Path,
    expected_state: CogCollectionOutputState,
    *,
    replace_existing: bool,
    commit_callback: Callable[[], None] | None = None,
) -> Path | None:
    if _capture_collection_output_state(output) != expected_state:
        raise CogCollectionConflictError(
            "FLOW_COG_COLLECTION_CHANGED_DURING_BUILD"
        )
    if expected_state.kind == "absent":
        os.replace(staged, output)
        try:
            if commit_callback is not None:
                commit_callback()
        except BaseException:
            os.replace(output, staged)
            raise
        return None
    if not replace_existing:
        raise CogCollectionConflictError(
            "published Flow Field COG collection already exists"
        )
    backup = output.parent / f".{output.name}.backup-{uuid.uuid4().hex}"
    os.replace(output, backup)
    try:
        os.replace(staged, output)
        if commit_callback is not None:
            commit_callback()
    except BaseException:
        if output.exists():
            os.replace(output, staged)
        os.replace(backup, output)
        raise
    return backup


def _shared_snapshot_contract(manifest: dict[str, Any]) -> dict[str, Any]:
    construction = manifest.get("construction")
    facts = construction.get("facts") if isinstance(construction, dict) else None
    if not isinstance(facts, dict):
        raise ValueError("Flow Field COG snapshot construction facts are invalid")
    source = facts.get("source")
    snapshot = facts.get("snapshot")
    topology = facts.get("topology")
    if (
        not isinstance(source, dict)
        or not isinstance(snapshot, dict)
        or not isinstance(topology, dict)
    ):
        raise ValueError("Flow Field COG snapshot shared facts are invalid")
    shared_source = dict(source)
    shared_source.pop("sourceHash", None)
    shared_topology = dict(topology)
    shared_topology.pop("maximumDuplicateVelocityDifference", None)
    schema_version = source.get("descriptorSchemaVersion", 2)
    semantics = {
        "descriptorSchemaVersion": schema_version,
        "unit": snapshot.get("unit"),
        "basis": snapshot.get("basis"),
        "timeUnit": source.get("timeUnit", "ordinal"),
        "phase": snapshot.get("phase"),
        "authority": source.get("authority", {
            "unit": "unconfirmed",
            "basis": "unconfirmed",
            "time": "unconfirmed",
            "phase": "unconfirmed",
            "topology": "inferred",
        }),
    }
    shared = {
        "source": shared_source,
        "semantics": semantics,
        "topology": shared_topology,
        "interpolation": facts.get("interpolation"),
        "plan": facts.get("plan"),
        "encoding": facts.get("encoding"),
        "dependencies": facts.get("dependencies"),
        "quality": manifest.get("quality"),
    }
    if any(value is None for value in shared.values()):
        raise ValueError("Flow Field COG snapshot shared contract is incomplete")
    return shared


def _snapshot_record(
    directory: Path,
    descriptor: SourceDescriptor,
    time_index: int,
    expected_plan: CogBuildPlan,
    expected_encoding: CogEncoding,
) -> tuple[dict[str, Any], dict[str, Any]]:
    if directory.is_symlink() or not directory.is_dir():
        raise ValueError("Flow Field COG snapshot directory is invalid")
    manifest_path = directory / "manifest.json"
    manifest = _read_json_object(manifest_path, "snapshot manifest")
    construction = manifest.get("construction")
    facts = construction.get("facts") if isinstance(construction, dict) else None
    snapshot = facts.get("snapshot") if isinstance(facts, dict) else None
    source = facts.get("source") if isinstance(facts, dict) else None
    cog = facts.get("cog") if isinstance(facts, dict) else None
    field = descriptor.fields[time_index]
    if (
        not isinstance(snapshot, dict)
        or not isinstance(source, dict)
        or not isinstance(cog, dict)
        or snapshot.get("timeIndex") != time_index
        or snapshot.get("modelTime") != field.model_time
        or snapshot.get("velocityHash") != field.sha256
        or snapshot.get("unit") != descriptor.unit
        or snapshot.get("basis") != descriptor.basis
        or snapshot.get("phase") != descriptor.phase
        or source.get("datasetId") != descriptor.dataset_id
        or source.get("sourceRevision") != descriptor.source_revision
        or source.get("stationCount") != descriptor.station_count
        or source.get("stationHash") != descriptor.station_sha256
        or source.get("sourceHash") != source_snapshot_hash(descriptor, field)
        or manifest.get("sourceHash") != source_snapshot_hash(descriptor, field)
        or facts.get("plan") != expected_plan.construction_manifest()
        or facts.get("encoding") != expected_encoding.manifest()
    ):
        raise ValueError(
            f"Flow Field COG snapshot t{time_index:02d} does not match the collection plan"
        )
    cog_name = cog.get("path")
    if not isinstance(cog_name, str) or Path(cog_name).name != cog_name:
        raise ValueError("Flow Field COG snapshot path is invalid")
    cog_path = directory / cog_name
    if (
        cog_path.is_symlink()
        or not cog_path.is_file()
        or cog_path.stat().st_size != cog.get("sizeBytes")
    ):
        raise ValueError("Flow Field COG snapshot file identity is invalid")
    if {entry.name for entry in directory.iterdir()} != {
        ".flow-field-cog-artifact.json",
        "manifest.json",
        cog_name,
    } or any(entry.is_symlink() for entry in directory.iterdir()):
        raise ValueError("Flow Field COG snapshot inventory is invalid")
    relative_directory = f"snapshots/t{time_index:02d}"
    record = {
        "timeIndex": time_index,
        "modelTime": field.model_time,
        "velocityHash": field.sha256,
        "sourceHash": manifest.get("sourceHash"),
        "directory": relative_directory,
        "manifestPath": f"{relative_directory}/manifest.json",
        "manifestSha256": _sha256(manifest_path),
        "contentVersion": manifest.get("contentVersion"),
        "cogPath": f"{relative_directory}/{cog_name}",
        "cogSha256": cog.get("sha256"),
        "cogSizeBytes": cog.get("sizeBytes"),
    }
    if (
        not isinstance(record["sourceHash"], str)
        or not isinstance(record["contentVersion"], str)
        or not isinstance(record["cogSha256"], str)
        or len(record["manifestSha256"]) != 64
    ):
        raise ValueError("Flow Field COG snapshot identity is incomplete")
    return record, _shared_snapshot_contract(manifest)


def _collect_snapshot_records(
    snapshots_directory: Path,
    descriptor: SourceDescriptor,
    plan: CogCollectionPlan,
    encoding: CogEncoding,
) -> tuple[tuple[dict[str, Any], ...], dict[str, Any]]:
    expected_names = {f"t{time_index:02d}" for time_index in plan.time_indices}
    if (
        snapshots_directory.is_symlink()
        or not snapshots_directory.is_dir()
        or {entry.name for entry in snapshots_directory.iterdir()} != expected_names
    ):
        raise ValueError("Flow Field COG collection snapshot inventory is invalid")
    records: list[dict[str, Any]] = []
    shared_contract: dict[str, Any] | None = None
    for time_index in plan.time_indices:
        record, shared = _snapshot_record(
            snapshots_directory / f"t{time_index:02d}",
            descriptor,
            time_index,
            plan.snapshot_plan,
            encoding,
        )
        if shared_contract is None:
            shared_contract = shared
        elif shared != shared_contract:
            raise ValueError("Flow Field COG snapshots do not share one construction contract")
        records.append(record)
    if shared_contract is None:
        raise ValueError("Flow Field COG collection has no snapshots")
    return tuple(records), shared_contract


def _regular_file_bytes(root: Path) -> int:
    total = 0
    for path in root.rglob("*"):
        if path.is_symlink():
            raise ValueError("Flow Field COG artifact cannot contain symbolic links")
        if path.is_file():
            total += path.stat().st_size
        elif not path.is_dir():
            raise ValueError("Flow Field COG artifact contains an unsupported entry")
    return total


def _measure_resume_snapshots(
    output: Path,
    request_sha256: str,
    descriptor: SourceDescriptor,
    time_indices: tuple[int, ...],
    snapshot_plan: CogBuildPlan,
    encoding: CogEncoding,
) -> tuple[int, int]:
    work = output.parent / f".{output.name}.work-{request_sha256[:24]}"
    if not work.exists():
        return 0, 0
    if work.is_symlink() or not work.is_dir():
        raise ValueError("Flow Field COG collection work path is invalid")
    marker_path = work / COG_COLLECTION_WORK_MARKER
    if marker_path.is_symlink():
        raise ValueError("Flow Field COG collection work marker cannot be a symbolic link")
    marker = _read_json_object(marker_path, "collection work marker")
    if marker != {
        "kind": "geoscratch-flow-field-cog-collection-work",
        "requestSha256": request_sha256,
    }:
        raise CogCollectionConflictError("FLOW_COG_COLLECTION_RESUME_IDENTITY_MISMATCH")
    snapshots = work / "payload" / "snapshots"
    builds = work / "snapshot-builds"
    if snapshots.exists() and (snapshots.is_symlink() or not snapshots.is_dir()):
        raise ValueError("Flow Field COG collection work snapshots are invalid")
    if builds.exists() and (builds.is_symlink() or not builds.is_dir()):
        raise ValueError("Flow Field COG collection snapshot builds are invalid")
    expected_names = {f"t{time_index:02d}" for time_index in time_indices}
    if snapshots.exists() and any(
        entry.name not in expected_names for entry in snapshots.iterdir()
    ):
        raise ValueError("Flow Field COG collection work has an unexpected snapshot")
    if builds.exists() and any(
        entry.name not in expected_names for entry in builds.iterdir()
    ):
        raise ValueError("Flow Field COG collection work has an unexpected snapshot build")
    count = 0
    size_bytes = 0
    for time_index in time_indices:
        directory = snapshots / f"t{time_index:02d}"
        if os.path.lexists(directory):
            if directory.is_symlink() or not directory.is_dir():
                raise ValueError("Flow Field COG collection snapshot target is invalid")
        elif builds.exists():
            build_parent = builds / f"t{time_index:02d}"
            if os.path.lexists(build_parent) and (
                build_parent.is_symlink() or not build_parent.is_dir()
            ):
                raise ValueError("Flow Field COG snapshot work directory is invalid")
            staged = build_parent / "cog-cache"
            if os.path.lexists(staged):
                expected_marker = {
                    "kind": "geoscratch-flow-field-cog-snapshot-work",
                    "requestSha256": request_sha256,
                    "timeIndex": time_index,
                }
                marker_path = build_parent / COG_SNAPSHOT_WORK_MARKER
                residue = tuple(build_parent.glob(".cog-cache.build-*"))
                if (
                    build_parent.is_symlink()
                    or not build_parent.is_dir()
                    or marker_path.is_symlink()
                    or _read_json_object(marker_path, "snapshot work marker")
                    != expected_marker
                    or residue
                    or {entry.name for entry in build_parent.iterdir()}
                    != {COG_SNAPSHOT_WORK_MARKER, "cog-cache"}
                ):
                    raise ValueError(
                        "Flow Field COG complete snapshot work identity is invalid"
                    )
                directory = staged
        if not directory.exists():
            continue
        _snapshot_record(
            directory,
            descriptor,
            time_index,
            snapshot_plan,
            encoding,
        )
        count += 1
        size_bytes += _regular_file_bytes(directory)
    return count, size_bytes


def _source_collection_contract(
    descriptor: SourceDescriptor,
    geographic_bounds: tuple[float, float, float, float],
) -> dict[str, Any]:
    return {
        "descriptorSchemaVersion": descriptor.schema_version,
        "datasetId": descriptor.dataset_id,
        "sourceRevision": descriptor.source_revision,
        "sourceHash": source_descriptor_hash(descriptor),
        "crs": "EPSG:4326",
        "geographicBounds": list(geographic_bounds),
        "stationCount": descriptor.station_count,
        "stationHash": descriptor.station_sha256,
        "unit": descriptor.unit,
        "basis": descriptor.basis,
        "timeUnit": descriptor.time_unit or "ordinal",
        "phase": descriptor.phase,
        "authority": descriptor.authority.manifest(),
    }


def _build_collection_manifests(
    descriptor: SourceDescriptor,
    plan: CogCollectionPlan,
    geographic_bounds: tuple[float, float, float, float],
    records: tuple[dict[str, Any], ...],
    shared_contract: dict[str, Any],
    page_index: CogRuntimePageIndex,
    snapshot_artifact_bytes: int,
) -> tuple[dict[str, Any], dict[str, Any]]:
    source_contract = _source_collection_contract(descriptor, geographic_bounds)
    facts = {
        "requestSha256": plan.request_sha256,
        "request": plan.request_facts,
        "source": source_contract,
        "selection": {
            "coverage": plan.coverage,
            "timeIndices": list(plan.time_indices),
            "snapshotCount": len(plan.time_indices),
            "sourceFieldCount": descriptor.field_count,
        },
        "sharedSnapshotContract": shared_contract,
        "snapshots": list(records),
        "runtimePageIndex": page_index.manifest(),
        "adapter": {
            "version": COG_COLLECTION_ADAPTER_VERSION,
            "advertisedMinimumMatrixId": str(RUNTIME_MINIMUM_MATRIX),
            "advertisedMaximumMatrixId": str(RUNTIME_MAXIMUM_MATRIX),
            "sampleRegistration": "pixel-center",
            "unsupportedVelocity": [0.0, 0.0],
        },
    }
    construction_sha256 = _canonical_sha256(facts)
    base_matrix = shared_contract["plan"]["grid"]["matrixId"]
    content_version = (
        f"flow-cog-collection-{construction_sha256[:16]}-"
        f"t{len(records)}-z{base_matrix}-v1"
    )
    quality = shared_contract["quality"]
    runtime_manifest = build_cog_runtime_manifest(
        descriptor,
        content_version,
        page_index,
        quality,
    )
    runtime_bytes = _encoded_json(runtime_manifest)
    manifest = {
        "schemaVersion": COG_COLLECTION_SCHEMA_VERSION,
        "artifactType": "flow-field-cog-collection",
        "datasetId": descriptor.dataset_id,
        "sourceRevision": descriptor.source_revision,
        "sourceHash": source_contract["sourceHash"],
        "contentVersion": content_version,
        "coverage": plan.coverage,
        "selection": facts["selection"],
        "source": source_contract,
        "snapshots": list(records),
        "construction": {
            "sha256": construction_sha256,
            "facts": facts,
        },
        "runtimeManifest": {
            "path": "runtime-manifest.json",
            "sha256": hashlib.sha256(runtime_bytes).hexdigest(),
            "pageCount": len(page_index.pages),
            "pageSetSha256": page_index.page_set_sha256,
        },
        "quality": quality,
    }
    marker_bytes = _encoded_json({
        "kind": "geoscratch-flow-field-cog-collection",
        "contentVersion": content_version,
    })
    storage = {
        "snapshotArtifactBytes": snapshot_artifact_bytes,
        "runtimeManifestBytes": len(runtime_bytes),
        "collectionManifestBytes": 0,
        "collectionMarkerBytes": len(marker_bytes),
        "totalArtifactBytes": 0,
    }
    manifest["storage"] = storage
    for _iteration in range(8):
        manifest_bytes = len(_encoded_json(manifest))
        total_bytes = (
            snapshot_artifact_bytes
            + len(runtime_bytes)
            + len(marker_bytes)
            + manifest_bytes
        )
        updated = {
            **storage,
            "collectionManifestBytes": manifest_bytes,
            "totalArtifactBytes": total_bytes,
        }
        if updated == storage:
            break
        storage = updated
        manifest["storage"] = storage
    else:
        raise RuntimeError("Flow Field COG collection storage facts did not stabilize")
    return manifest, runtime_manifest


def _validate_collection_manifest_identity(
    manifest: object,
    runtime_manifest_bytes: bytes,
) -> dict[str, Any]:
    if not isinstance(manifest, dict):
        raise ValueError("Flow Field COG collection manifest must be an object")
    construction = manifest.get("construction")
    facts = construction.get("facts") if isinstance(construction, dict) else None
    runtime_record = manifest.get("runtimeManifest")
    if (
        manifest.get("schemaVersion") != COG_COLLECTION_SCHEMA_VERSION
        or manifest.get("artifactType") != "flow-field-cog-collection"
        or not isinstance(facts, dict)
        or not isinstance(runtime_record, dict)
    ):
        raise ValueError("Flow Field COG collection manifest contract is invalid")
    expected_construction = _canonical_sha256(facts)
    shared = facts.get("sharedSnapshotContract")
    selection = facts.get("selection")
    source = facts.get("source")
    snapshots = facts.get("snapshots")
    page_index = facts.get("runtimePageIndex")
    adapter = facts.get("adapter")
    request = facts.get("request")
    if (
        construction.get("sha256") != expected_construction
        or not isinstance(shared, dict)
        or not isinstance(selection, dict)
        or not isinstance(source, dict)
        or not isinstance(snapshots, list)
        or not isinstance(page_index, dict)
        or not isinstance(adapter, dict)
        or not isinstance(request, dict)
        or not snapshots
    ):
        raise ValueError("Flow Field COG collection construction identity is invalid")
    try:
        shared_plan = shared["plan"]
        base_matrix = shared_plan["grid"]["matrixId"]
        time_indices = selection["timeIndices"]
    except (KeyError, TypeError) as error:
        raise ValueError("Flow Field COG collection shared contract is invalid") from error
    try:
        selected_matrix, matrix_relation = validate_resolution_selection_manifest(
            shared_plan.get("resolution"),
            source_station_count=source.get("stationCount"),
        )
    except ValueError as error:
        raise ValueError("Flow Field COG collection resolution identity is invalid") from error
    if (
        base_matrix != str(selected_matrix)
        or shared_plan.get("matrixDecision")
        != {
            "selectedMatrixId": str(selected_matrix),
            "outputMatrixId": str(selected_matrix),
            "relation": matrix_relation,
        }
    ):
        raise ValueError("Flow Field COG collection matrix decision is invalid")
    source_field_count = selection.get("sourceFieldCount")
    expected_full_selection = (
        list(range(source_field_count))
        if isinstance(source_field_count, int) and not isinstance(source_field_count, bool)
        else None
    )
    selection_is_valid = (
        isinstance(time_indices, list)
        and bool(time_indices)
        and all(
            not isinstance(value, bool) and isinstance(value, int) and value >= 0
            for value in time_indices
        )
        and time_indices == sorted(set(time_indices))
        and isinstance(source_field_count, int)
        and not isinstance(source_field_count, bool)
        and source_field_count > 0
        and all(value < source_field_count for value in time_indices)
        and selection.get("snapshotCount") == len(time_indices)
        and (
            (
                selection.get("coverage") == "full"
                and time_indices == expected_full_selection
            )
            or (
                selection.get("coverage") == "subset"
                and time_indices != expected_full_selection
            )
        )
    )
    source_is_valid = (
        source.get("descriptorSchemaVersion") in {2, 3}
        and isinstance(source.get("datasetId"), str)
        and bool(source["datasetId"])
        and isinstance(source.get("sourceRevision"), str)
        and bool(source["sourceRevision"])
        and _is_sha256_value(source.get("sourceHash"))
        and source.get("crs") == "EPSG:4326"
        and isinstance(source.get("geographicBounds"), list)
        and len(source["geographicBounds"]) == 4
        and isinstance(source.get("stationCount"), int)
        and not isinstance(source.get("stationCount"), bool)
        and source["stationCount"] >= 3
        and _is_sha256_value(source.get("stationHash"))
        and all(
            isinstance(source.get(key), str) and bool(source[key])
            for key in ("unit", "basis", "timeUnit", "phase")
        )
        and isinstance(source.get("authority"), dict)
        and set(source["authority"]) == {"unit", "basis", "time", "phase", "topology"}
        and all(
            source["authority"].get(key) in {"authoritative", "unconfirmed"}
            for key in ("unit", "basis", "time", "phase")
        )
        and source["authority"].get("topology") == "inferred"
    )
    shared_source = shared.get("source")
    shared_semantics = shared.get("semantics")
    shared_topology = shared.get("topology")
    source_matches_children = (
        isinstance(shared_source, dict)
        and isinstance(shared_semantics, dict)
        and isinstance(shared_topology, dict)
        and all(
            source.get(key) == shared_source.get(key)
            for key in (
                "datasetId",
                "sourceRevision",
                "crs",
                "geographicBounds",
                "stationCount",
                "stationHash",
            )
        )
        and all(
            source.get(key) == shared_semantics.get(key)
            for key in (
                "descriptorSchemaVersion",
                "unit",
                "basis",
                "timeUnit",
                "phase",
                "authority",
            )
        )
        and shared_topology.get("resolved") == "delaunay"
        and shared_topology.get("inferred") is True
    )
    if (
        not selection_is_valid
        or not source_is_valid
        or not source_matches_children
        or facts.get("requestSha256") != _canonical_sha256(request)
        or request.get("source")
        != {
            "datasetId": source.get("datasetId"),
            "sourceRevision": source.get("sourceRevision"),
            "sourceHash": source.get("sourceHash"),
            "stationCount": source.get("stationCount"),
            "stationHash": source.get("stationHash"),
        }
        or request.get("selection")
        != {
            "timeIndices": time_indices,
            "coverage": selection.get("coverage"),
        }
        or request.get("snapshotConstruction") != shared.get("plan")
        or request.get("encoding") != shared.get("encoding")
        or request.get("interpolation") != shared.get("interpolation")
        or not isinstance(shared.get("dependencies"), dict)
        or not isinstance(shared.get("topology"), dict)
        or not isinstance(request.get("toolchain"), dict)
        or not isinstance(request["toolchain"].get("flowFieldTools"), str)
        or not request["toolchain"]["flowFieldTools"]
        or any(
            request["toolchain"].get(key) != shared.get("dependencies", {}).get(key)
            for key in ("numpy", "rasterio", "gdal", "rioCogeo")
        )
        or request["toolchain"].get("scipy")
        != shared.get("topology", {}).get("implementationVersion")
        or not isinstance(request.get("topology"), dict)
        or request["topology"].get("kind") != shared.get("topology", {}).get("requested")
        or request["topology"].get("duplicatePolicy")
        != shared.get("topology", {}).get("duplicatePolicy")
        or {
            "kind": "local-spacing-edge",
            "localSpacingNeighbors": request["topology"].get("localSpacingNeighbors"),
            "maximumEdgeRatio": request["topology"].get("maximumEdgeRatio"),
            "maximumEdgeLengthMeters": request["topology"].get(
                "maximumEdgeLengthMeters"
            ),
        }
        != shared.get("topology", {}).get("supportHeuristic")
        or request.get("adapterVersion") != COG_COLLECTION_ADAPTER_VERSION
        or request.get("runtimeMatrices")
        != {
            "minimum": str(RUNTIME_MINIMUM_MATRIX),
            "maximum": str(RUNTIME_MAXIMUM_MATRIX),
        }
        or adapter
        != {
            "version": COG_COLLECTION_ADAPTER_VERSION,
            "advertisedMinimumMatrixId": str(RUNTIME_MINIMUM_MATRIX),
            "advertisedMaximumMatrixId": str(RUNTIME_MAXIMUM_MATRIX),
            "sampleRegistration": "pixel-center",
            "unsupportedVelocity": [0.0, 0.0],
        }
        or page_index.get("descriptorSha256") != source.get("sourceHash")
        or page_index.get("sourceBounds") != source.get("geographicBounds")
        or page_index.get("timeIndices") != time_indices
        or page_index.get("matrices")
        != [str(matrix) for matrix in range(RUNTIME_MINIMUM_MATRIX, RUNTIME_MAXIMUM_MATRIX + 1)]
    ):
        raise ValueError("Flow Field COG collection semantic contract is invalid")
    expected_version = (
        f"flow-cog-collection-{expected_construction[:16]}-"
        f"t{len(snapshots)}-z{base_matrix}-v1"
    )
    storage = manifest.get("storage")
    marker_byte_length = len(_encoded_json({
        "kind": "geoscratch-flow-field-cog-collection",
        "contentVersion": expected_version,
    }))
    if (
        not isinstance(storage, dict)
        or set(storage) != {
            "snapshotArtifactBytes",
            "runtimeManifestBytes",
            "collectionManifestBytes",
            "collectionMarkerBytes",
            "totalArtifactBytes",
        }
        or any(
            isinstance(value, bool) or not isinstance(value, int) or value < 0
            for value in storage.values()
        )
        or storage["runtimeManifestBytes"] != len(runtime_manifest_bytes)
        or storage["collectionManifestBytes"] != len(_encoded_json(manifest))
        or storage["collectionMarkerBytes"] != marker_byte_length
        or storage["totalArtifactBytes"]
        != (
            storage["snapshotArtifactBytes"]
            + storage["runtimeManifestBytes"]
            + storage["collectionManifestBytes"]
            + storage["collectionMarkerBytes"]
        )
    ):
        raise ValueError("Flow Field COG collection storage identity is invalid")
    if (
        manifest.get("contentVersion") != expected_version
        or manifest.get("datasetId") != source.get("datasetId")
        or manifest.get("sourceRevision") != source.get("sourceRevision")
        or manifest.get("sourceHash") != source.get("sourceHash")
        or manifest.get("source") != source
        or manifest.get("selection") != selection
        or manifest.get("snapshots") != snapshots
        or manifest.get("coverage") != selection.get("coverage")
        or selection.get("snapshotCount") != len(snapshots)
        or not isinstance(time_indices, list)
        or [record.get("timeIndex") for record in snapshots] != time_indices
    ):
        raise ValueError("Flow Field COG collection top-level identity is invalid")
    expected_runtime_sha = hashlib.sha256(runtime_manifest_bytes).hexdigest()
    if runtime_record != {
        "path": "runtime-manifest.json",
        "sha256": expected_runtime_sha,
        "pageCount": len(page_index.get("pages", [])),
        "pageSetSha256": page_index.get("pageSetSha256"),
    }:
        raise ValueError("Flow Field COG collection runtime identity is invalid")
    try:
        runtime_manifest = json.loads(runtime_manifest_bytes)
    except json.JSONDecodeError as error:
        raise ValueError("Flow Field COG runtime manifest is unreadable") from error
    validate_cog_runtime_manifest(runtime_manifest)
    runtime_times = runtime_manifest.get("times")
    expected_runtime_times = [
        {
            "timeIndex": record.get("timeIndex"),
            "modelTime": record.get("modelTime"),
            "unit": source.get("timeUnit"),
            "phase": source.get("phase"),
            "sourceHash": record.get("velocityHash"),
        }
        for record in snapshots
    ]
    if (
        runtime_manifest.get("contentVersion") != expected_version
        or runtime_manifest.get("datasetId") != source.get("datasetId")
        or runtime_manifest.get("sourceRevision") != source.get("sourceRevision")
        or runtime_manifest.get("sourceHash") != source.get("sourceHash")
        or runtime_manifest.get("stationCount") != source.get("stationCount")
        or runtime_manifest.get("source")
        != {
            "crs": "EPSG:4326",
            "geographicBounds": source.get("geographicBounds"),
        }
        or runtime_manifest.get("unit") != source.get("unit")
        or runtime_manifest.get("basis") != source.get("basis")
        or runtime_times != expected_runtime_times
        or runtime_manifest.get("pages") != page_index.get("pages")
        or runtime_manifest.get("construction", {}).get("pageSetSha256")
        != page_index.get("pageSetSha256")
        or manifest.get("quality") != shared.get("quality")
        or runtime_manifest.get("construction", {}).get("quality")
        != shared.get("quality")
    ):
        raise ValueError("Flow Field COG collection runtime contract is inconsistent")
    return {
        "contentVersion": expected_version,
        "requestSha256": facts.get("requestSha256"),
        "timeIndices": tuple(time_indices),
        "pageCount": runtime_record["pageCount"],
        "pageSetSha256": runtime_record["pageSetSha256"],
        "quality": manifest["quality"],
    }


def _validate_declared_snapshot(
    root: Path,
    record: object,
    shared_contract: dict[str, Any],
    *,
    deep: bool,
) -> CogVelocityTileReader:
    if not isinstance(record, dict):
        raise ValueError("Flow Field COG collection snapshot record is invalid")
    time_index = record.get("timeIndex")
    if isinstance(time_index, bool) or not isinstance(time_index, int) or time_index < 0:
        raise ValueError("Flow Field COG collection snapshot time is invalid")
    expected_directory = f"snapshots/t{time_index:02d}"
    expected_manifest = f"{expected_directory}/manifest.json"
    if (
        record.get("directory") != expected_directory
        or record.get("manifestPath") != expected_manifest
    ):
        raise ValueError("Flow Field COG collection snapshot path is invalid")
    directory = _safe_child_path(root, record["directory"], "snapshot directory")
    manifest_path = _safe_child_path(root, record["manifestPath"], "snapshot manifest")
    if directory.is_symlink() or not directory.is_dir() or not manifest_path.is_file():
        raise ValueError("Flow Field COG collection snapshot artifact is missing")
    manifest = _read_json_object(manifest_path, "snapshot manifest")
    marker_path = _safe_child_path(
        root,
        f"{expected_directory}/{COG_ARTIFACT_MARKER}",
        "snapshot marker",
    )
    if marker_path.is_symlink() or _read_json_object(
        marker_path,
        "snapshot marker",
    ) != {
        "kind": "geoscratch-flow-field-cog-artifact",
        "contentVersion": record.get("contentVersion"),
    }:
        raise ValueError("Flow Field COG collection snapshot marker is invalid")
    construction = manifest.get("construction")
    facts = construction.get("facts") if isinstance(construction, dict) else None
    snapshot = facts.get("snapshot") if isinstance(facts, dict) else None
    cog = facts.get("cog") if isinstance(facts, dict) else None
    if (
        not isinstance(snapshot, dict)
        or not isinstance(cog, dict)
        or _sha256(manifest_path) != record.get("manifestSha256")
        or manifest.get("contentVersion") != record.get("contentVersion")
        or manifest.get("sourceHash") != record.get("sourceHash")
        or snapshot.get("timeIndex") != time_index
        or snapshot.get("modelTime") != record.get("modelTime")
        or snapshot.get("velocityHash") != record.get("velocityHash")
        or _shared_snapshot_contract(manifest) != shared_contract
    ):
        raise ValueError("Flow Field COG collection snapshot identity is invalid")
    cog_name = cog.get("path")
    expected_cog_path = f"{expected_directory}/{cog_name}"
    if record.get("cogPath") != expected_cog_path:
        raise ValueError("Flow Field COG collection COG path is invalid")
    cog_path = _safe_child_path(root, expected_cog_path, "snapshot COG")
    if (
        cog_path.is_symlink()
        or not cog_path.is_file()
        or cog_path.stat().st_size != record.get("cogSizeBytes")
        or cog.get("sizeBytes") != record.get("cogSizeBytes")
        or cog.get("sha256") != record.get("cogSha256")
        or (not deep and _sha256(cog_path) != record.get("cogSha256"))
    ):
        raise ValueError("Flow Field COG collection COG identity is invalid")
    if deep:
        verified = verify_velocity_cog_snapshot(directory)
        if (
            verified["contentVersion"] != record["contentVersion"]
            or verified["cogSha256"] != record["cogSha256"]
            or verified["cogSizeBytes"] != record["cogSizeBytes"]
        ):
            raise ValueError("Flow Field COG collection snapshot verification changed")
    return CogVelocityTileReader(manifest_path, cog_path)


def verify_velocity_cog_collection(
    output_directory: str | Path = DEFAULT_COG_COLLECTION_DIRECTORY,
    *,
    deep: bool = True,
) -> dict[str, Any]:
    requested = Path(os.path.abspath(os.fspath(output_directory)))
    if requested.is_symlink():
        raise ValueError("Flow Field COG collection directory cannot be a symbolic link")
    output = requested.resolve()
    if not _is_owned_collection_directory(output):
        raise ValueError("Flow Field COG collection directory ownership is invalid")
    manifest_path = output / "manifest.json"
    runtime_path = output / "runtime-manifest.json"
    manifest = _read_json_object(manifest_path, "collection manifest")
    runtime_bytes = runtime_path.read_bytes()
    identity = _validate_collection_manifest_identity(manifest, runtime_bytes)
    storage = manifest["storage"]
    if (
        manifest_path.stat().st_size != storage["collectionManifestBytes"]
        or runtime_path.stat().st_size != storage["runtimeManifestBytes"]
        or (output / COG_COLLECTION_MARKER).stat().st_size
        != storage["collectionMarkerBytes"]
        or _regular_file_bytes(output / "snapshots")
        != storage["snapshotArtifactBytes"]
        or _regular_file_bytes(output) != storage["totalArtifactBytes"]
    ):
        raise ValueError("Flow Field COG collection storage facts are invalid")
    marker = _read_json_object(output / COG_COLLECTION_MARKER, "collection marker")
    if marker != {
        "kind": "geoscratch-flow-field-cog-collection",
        "contentVersion": identity["contentVersion"],
    }:
        raise ValueError("Flow Field COG collection marker is invalid")
    facts = manifest["construction"]["facts"]
    records = facts["snapshots"]
    shared_contract = facts["sharedSnapshotContract"]
    expected_snapshot_names = {
        f"t{time_index:02d}" for time_index in identity["timeIndices"]
    }
    snapshots_directory = output / "snapshots"
    if (
        snapshots_directory.is_symlink()
        or {entry.name for entry in snapshots_directory.iterdir()}
        != expected_snapshot_names
    ):
        raise ValueError("Flow Field COG collection snapshot inventory is invalid")
    readers: dict[int, CogVelocityTileReader] = {}
    for record in records:
        reader = _validate_declared_snapshot(
            output,
            record,
            shared_contract,
            deep=deep,
        )
        readers[record["timeIndex"]] = reader
    if deep:
        runtime_manifest = json.loads(runtime_bytes)
        page_records = {
            (
                page["timeIndex"],
                page["matrixId"],
                page["tileRow"],
                page["tileCol"],
            ): page
            for page in runtime_manifest["pages"]
        }
        for key, page in page_records.items():
            time_index, matrix_id, tile_row, tile_col = key
            tile = readers[time_index].read_tile(matrix_id, tile_row, tile_col)
            if (
                tile.sha256 != page["sha256"]
                or len(tile.content) != page["byteLength"]
                or tile.maximum_speed != page["maximumSpeed"]
            ):
                raise ValueError("Flow Field COG runtime page verification failed")
    return identity


def _prepare_collection_work(
    output: Path,
    plan: CogCollectionPlan,
    *,
    resume: bool,
) -> Path:
    work = output.parent / f".{output.name}.work-{plan.request_sha256[:24]}"
    marker_path = work / COG_COLLECTION_WORK_MARKER
    expected_marker = {
        "kind": "geoscratch-flow-field-cog-collection-work",
        "requestSha256": plan.request_sha256,
    }
    if work.exists():
        if work.is_symlink() or not work.is_dir():
            raise ValueError("Flow Field COG collection work path is invalid")
        if not resume:
            raise CogCollectionConflictError(
                "Flow Field COG collection work already exists; use resume"
            )
        if marker_path.is_symlink():
            raise ValueError(
                "Flow Field COG collection work marker cannot be a symbolic link"
            )
        if _read_json_object(marker_path, "collection work marker") != expected_marker:
            raise CogCollectionConflictError("FLOW_COG_COLLECTION_RESUME_IDENTITY_MISMATCH")
    else:
        work.mkdir()
        atomic_write_json(marker_path, expected_marker)
    payload = work / "payload"
    snapshots = payload / "snapshots"
    builds = work / "snapshot-builds"
    for directory in (payload, snapshots, builds):
        if directory.exists():
            if directory.is_symlink() or not directory.is_dir():
                raise ValueError("Flow Field COG collection work directory is invalid")
        else:
            directory.mkdir()
    allowed = {COG_COLLECTION_WORK_MARKER, "payload", "snapshot-builds", "state.json"}
    if any(entry.name not in allowed for entry in work.iterdir()):
        raise ValueError("Flow Field COG collection work contains unowned content")
    return work


def _recover_snapshot_build(
    build_parent: Path,
    *,
    resume: bool,
    request_sha256: str,
    time_index: int,
    discard_incomplete: bool,
) -> Path | None:
    marker_path = build_parent / COG_SNAPSHOT_WORK_MARKER
    expected_marker = {
        "kind": "geoscratch-flow-field-cog-snapshot-work",
        "requestSha256": request_sha256,
        "timeIndex": time_index,
    }
    if os.path.lexists(marker_path):
        if marker_path.is_symlink() or _read_json_object(
            marker_path,
            "snapshot work marker",
        ) != expected_marker:
            raise CogCollectionConflictError(
                "FLOW_COG_COLLECTION_RESUME_IDENTITY_MISMATCH"
            )
    else:
        if any(build_parent.iterdir()):
            raise ValueError(
                "Flow Field COG snapshot work is unmarked and contains user content"
            )
        atomic_write_json(marker_path, expected_marker)
    staged = build_parent / "cog-cache"
    residue = tuple(build_parent.glob(".cog-cache.build-*"))
    if staged.exists():
        if not resume:
            raise CogCollectionConflictError("snapshot work exists; use resume")
        if residue or {entry.name for entry in build_parent.iterdir()} != {
            COG_SNAPSHOT_WORK_MARKER,
            "cog-cache",
        }:
            raise ValueError("Flow Field COG snapshot work contains unowned content")
        verify_velocity_cog_snapshot(staged)
        return staged
    if residue:
        if not resume:
            raise CogCollectionConflictError("incomplete snapshot work exists; use resume")
        if not discard_incomplete:
            raise CogCollectionConflictError(
                "incomplete snapshot work is preserved; use discard_incomplete"
            )
        for path in residue:
            if path.is_symlink() or not path.is_dir():
                raise ValueError("Flow Field COG snapshot staging residue is invalid")
            shutil.rmtree(path)
    if {entry.name for entry in build_parent.iterdir()} != {COG_SNAPSHOT_WORK_MARKER}:
        raise ValueError("Flow Field COG snapshot work contains unowned content")
    return None


def _require_collection_size_budget(
    observed_bytes: int,
    budget: CogCollectionBudget,
) -> None:
    if observed_bytes > budget.max_collection_bytes:
        raise OSError(
            "Flow Field COG collection compressed byte budget was exceeded: "
            f"{observed_bytes} > {budget.max_collection_bytes}"
        )


def _require_descriptor_matches_plan(
    descriptor: SourceDescriptor,
    plan: CogCollectionPlan,
    expected: SourceDescriptor | None = None,
) -> None:
    source = plan.request_facts.get("source")
    selection = plan.request_facts.get("selection")
    if (
        not isinstance(source, dict)
        or not isinstance(selection, dict)
        or (expected is not None and descriptor != expected)
        or descriptor.dataset_id != source.get("datasetId")
        or descriptor.source_revision != source.get("sourceRevision")
        or source_descriptor_hash(descriptor) != source.get("sourceHash")
        or descriptor.station_count != source.get("stationCount")
        or descriptor.station_sha256 != source.get("stationHash")
        or list(plan.time_indices) != selection.get("timeIndices")
    ):
        raise CogCollectionConflictError("FLOW_COG_SOURCE_CHANGED_DURING_BUILD")


class _CollectionProgressTracker:
    def __init__(self, delegate: ProgressSink | None) -> None:
        self.delegate = delegate
        self.started: JobProgressEvent | None = None
        self.last_sequence = 0
        self.completed = False

    def emit(self, event: JobProgressEvent) -> None:
        if self.delegate is not None:
            self.delegate.emit(event)
        if event.event == "job.started" and event.stage == "collection":
            self.started = event
        if self.started is not None and event.job_id == self.started.job_id:
            self.last_sequence = event.sequence
            if event.event == "job.completed" and event.stage == "collection":
                self.completed = True

    def emit_failure(self) -> None:
        if self.delegate is None or self.started is None or self.completed:
            return
        failure = JobProgressEvent(
            job_id=self.started.job_id,
            sequence=self.last_sequence + 1,
            event="job.failed",
            stage="collection",
            time_index=self.started.time_index,
        )
        try:
            self.delegate.emit(failure)
        except BaseException:
            pass


def _build_velocity_cog_collection(
    data_directory: str | Path = DEFAULT_DATA_DIRECTORY,
    output_directory: str | Path = DEFAULT_COG_COLLECTION_DIRECTORY,
    *,
    time_indices: tuple[int, ...],
    descriptor_path: str | Path = DEFAULT_DESCRIPTOR_PATH,
    topology: TopologySpec | None = None,
    interpolation: InterpolationSpec | None = None,
    resolution: ResolutionSpec | None = None,
    encoding: CogEncoding = CogEncoding(),
    snapshot_budget: CogBuildBudget = CogBuildBudget(),
    batch_execution_budget: CogSnapshotBatchExecutionBudget = (
        CogSnapshotBatchExecutionBudget()
    ),
    collection_budget: CogCollectionBudget | None = None,
    resume: bool = False,
    replace_existing: bool = False,
    discard_incomplete: bool = False,
    progress: ProgressSink | None = None,
) -> CogCollectionBuildResult:
    if collection_budget is None:
        collection_budget = CogCollectionBudget()
    output = _safe_collection_output(output_directory)
    job_id = uuid.uuid4().hex
    lock_path = output.parent / f".{output.name}.lock"
    lock = OutputLock(lock_path, metadata={
        "jobId": job_id,
        "output": str(output),
        "pid": os.getpid(),
    })
    with lock:
        plan = plan_velocity_cog_collection(
            data_directory,
            output,
            time_indices=time_indices,
            descriptor_path=descriptor_path,
            topology=topology,
            interpolation=interpolation,
            resolution=resolution,
            encoding=encoding,
            snapshot_budget=snapshot_budget,
            batch_execution_budget=batch_execution_budget,
            collection_budget=collection_budget,
        )
        atomic_write_json(lock.metadata_path, {
            "jobId": job_id,
            "output": str(output),
            "pid": os.getpid(),
            "requestSha256": plan.request_sha256,
        })
        emitter = ProgressEmitter(job_id, plan.time_indices[0], progress)
        initial_state = _capture_collection_output_state(output)
        if initial_state.kind == "owned":
            installed = verify_velocity_cog_collection(output, deep=False)
            if installed["requestSha256"] == plan.request_sha256:
                emitter.emit(
                    "job.skipped",
                    stage="collection",
                    completed=1,
                    total=1,
                    unit="collections",
                )
                return CogCollectionBuildResult(
                    output_directory=output,
                    manifest_path=output / "manifest.json",
                    runtime_manifest_path=output / "runtime-manifest.json",
                    content_version=installed["contentVersion"],
                    status="already-published",
                    snapshot_count=len(installed["timeIndices"]),
                    page_count=installed["pageCount"],
                )
            if not replace_existing:
                raise CogCollectionConflictError(
                    "published Flow Field COG collection has another identity"
                )
        plan.require_output_approved()
        descriptor = read_source_descriptor(descriptor_path)
        _require_descriptor_matches_plan(descriptor, plan)
        first_snapshot = load_source_snapshot(
            data_directory,
            time_index=plan.time_indices[0],
            descriptor_path=descriptor_path,
        )
        _require_descriptor_matches_plan(
            read_source_descriptor(descriptor_path),
            plan,
            descriptor,
        )
        work = _prepare_collection_work(output, plan, resume=resume)
        payload = work / "payload"
        snapshots_directory = payload / "snapshots"
        emitter.emit("job.started", stage="collection")
        accumulated_cog_bytes = 0
        verified_time_indices: set[int] = set()
        missing_items: list[CogSnapshotBatchItem] = []
        promotion_emitters = {
            time_index: ProgressEmitter(
                f"{job_id}-promotion-t{time_index:02d}",
                time_index,
                progress,
            )
            for time_index in plan.time_indices
        }

        def record_verified_snapshot(
            directory: Path,
            time_index: int,
            *,
            target: Path,
            skipped: bool,
        ) -> None:
            nonlocal accumulated_cog_bytes
            record, _shared = _snapshot_record(
                directory,
                descriptor,
                time_index,
                plan.snapshot_plan,
                encoding,
            )
            accumulated_cog_bytes += record["cogSizeBytes"]
            _require_collection_size_budget(
                accumulated_cog_bytes,
                collection_budget,
            )
            if directory != target:
                if os.path.lexists(target):
                    raise CogCollectionConflictError(
                        "Flow Field COG snapshot target appeared during build"
                    )
                os.replace(directory, target)
            verified_time_indices.add(time_index)
            atomic_write_json(work / "state.json", {
                "kind": "geoscratch-flow-field-cog-collection-state",
                "requestSha256": plan.request_sha256,
                "verifiedTimeIndices": [
                    value
                    for value in plan.time_indices
                    if value in verified_time_indices
                ],
            })
            promotion_emitters[time_index].emit(
                "job.skipped" if skipped else "stage.completed",
                stage="snapshot",
                completed=1,
                total=1,
                unit="snapshots",
            )
            emitter.emit(
                "stage.progress",
                stage="snapshots",
                completed=len(verified_time_indices),
                total=len(plan.time_indices),
                unit="snapshots",
            )

        for time_index in plan.time_indices:
            _require_descriptor_matches_plan(
                read_source_descriptor(descriptor_path),
                plan,
                descriptor,
            )
            target = snapshots_directory / f"t{time_index:02d}"
            if os.path.lexists(target):
                if target.is_symlink() or not target.is_dir():
                    raise ValueError("Flow Field COG collection snapshot target is invalid")
                verify_velocity_cog_snapshot(target)
                record_verified_snapshot(
                    target,
                    time_index,
                    target=target,
                    skipped=True,
                )
                continue
            build_parent = work / "snapshot-builds" / f"t{time_index:02d}"
            if os.path.lexists(build_parent):
                if build_parent.is_symlink() or not build_parent.is_dir():
                    raise ValueError("Flow Field COG snapshot work directory is invalid")
            else:
                build_parent.mkdir()
            recovered = _recover_snapshot_build(
                build_parent,
                resume=resume,
                request_sha256=plan.request_sha256,
                time_index=time_index,
                discard_incomplete=discard_incomplete,
            )
            if recovered is not None:
                record_verified_snapshot(
                    recovered,
                    time_index,
                    target=target,
                    skipped=True,
                )
                continue
            missing_items.append(CogSnapshotBatchItem(
                time_index=time_index,
                output_directory=build_parent / "cog-cache",
                job_id=f"{job_id}-t{time_index:02d}",
            ))

        chunk_size = batch_execution_budget.max_snapshots
        for start in range(0, len(missing_items), chunk_size):
            chunk = tuple(missing_items[start:start + chunk_size])
            _require_descriptor_matches_plan(
                read_source_descriptor(descriptor_path),
                plan,
                descriptor,
            )
            results = build_velocity_cog_snapshot_batch(
                data_directory,
                items=chunk,
                descriptor_path=descriptor_path,
                topology=topology,
                interpolation=interpolation,
                resolution=resolution,
                encoding=encoding,
                budget=snapshot_budget,
                execution_budget=batch_execution_budget,
                progress=progress,
            )
            _require_descriptor_matches_plan(
                read_source_descriptor(descriptor_path),
                plan,
                descriptor,
            )
            for item, result in zip(chunk, results, strict=True):
                target = snapshots_directory / f"t{item.time_index:02d}"
                record_verified_snapshot(
                    result.output_directory,
                    item.time_index,
                    target=target,
                    skipped=False,
                )
        records, shared = _collect_snapshot_records(
            snapshots_directory,
            descriptor,
            plan,
            encoding,
        )
        _require_descriptor_matches_plan(
            read_source_descriptor(descriptor_path),
            plan,
            descriptor,
        )
        readers = {
            record["timeIndex"]: CogVelocityTileReader(
                payload / record["manifestPath"],
                payload / record["cogPath"],
            )
            for record in records
        }
        emitter.emit("stage.started", stage="runtime-page-index")
        page_index = build_cog_runtime_page_index(
            descriptor,
            readers,
            first_snapshot.geographic_bounds,
        )
        emitter.emit(
            "stage.completed",
            stage="runtime-page-index",
            completed=len(page_index.pages),
            total=len(page_index.pages),
            unit="pages",
        )
        manifest, runtime_manifest = _build_collection_manifests(
            descriptor,
            plan,
            first_snapshot.geographic_bounds,
            records,
            shared,
            page_index,
            _regular_file_bytes(snapshots_directory),
        )
        atomic_write_json(payload / "runtime-manifest.json", runtime_manifest)
        atomic_write_json(payload / "manifest.json", manifest)
        atomic_write_json(payload / COG_COLLECTION_MARKER, {
            "kind": "geoscratch-flow-field-cog-collection",
            "contentVersion": manifest["contentVersion"],
        })
        _require_collection_size_budget(
            _regular_file_bytes(payload),
            collection_budget,
        )
        verified = verify_velocity_cog_collection(payload, deep=False)
        emitter.emit("stage.started", stage="install")

        def complete_install() -> None:
            emitter.emit(
                "stage.progress",
                stage="install",
                completed=1,
                total=1,
                unit="directories",
            )
            emitter.emit("stage.completed", stage="install")
            emitter.emit("job.completed", stage="collection")

        replaced_backup = _install_collection_directory(
            payload,
            output,
            initial_state,
            replace_existing=replace_existing,
            commit_callback=complete_install,
        )
    return CogCollectionBuildResult(
        output_directory=output,
        manifest_path=output / "manifest.json",
        runtime_manifest_path=output / "runtime-manifest.json",
        content_version=verified["contentVersion"],
        status="published",
        snapshot_count=len(verified["timeIndices"]),
        page_count=verified["pageCount"],
        replaced_backup_directory=replaced_backup,
    )


def build_velocity_cog_collection(
    data_directory: str | Path = DEFAULT_DATA_DIRECTORY,
    output_directory: str | Path = DEFAULT_COG_COLLECTION_DIRECTORY,
    *,
    time_indices: tuple[int, ...],
    descriptor_path: str | Path = DEFAULT_DESCRIPTOR_PATH,
    topology: TopologySpec | None = None,
    interpolation: InterpolationSpec | None = None,
    resolution: ResolutionSpec | None = None,
    encoding: CogEncoding = CogEncoding(),
    snapshot_budget: CogBuildBudget = CogBuildBudget(),
    batch_execution_budget: CogSnapshotBatchExecutionBudget = (
        CogSnapshotBatchExecutionBudget()
    ),
    collection_budget: CogCollectionBudget | None = None,
    resume: bool = False,
    replace_existing: bool = False,
    discard_incomplete: bool = False,
    progress: ProgressSink | None = None,
) -> CogCollectionBuildResult:
    tracker = _CollectionProgressTracker(progress)
    try:
        return _build_velocity_cog_collection(
            data_directory,
            output_directory,
            time_indices=time_indices,
            descriptor_path=descriptor_path,
            topology=topology,
            interpolation=interpolation,
            resolution=resolution,
            encoding=encoding,
            snapshot_budget=snapshot_budget,
            batch_execution_budget=batch_execution_budget,
            collection_budget=collection_budget,
            resume=resume,
            replace_existing=replace_existing,
            discard_incomplete=discard_incomplete,
            progress=tracker,
        )
    except BaseException:
        tracker.emit_failure()
        raise


@dataclass(frozen=True, slots=True)
class CogCollectionBudget:
    """Bounds final temporal storage without changing snapshot resolution."""

    max_collection_bytes: int = 64 * 1024 * 1024 * 1024
    estimated_snapshot_bytes: int | None = None

    def __post_init__(self) -> None:
        if (
            isinstance(self.max_collection_bytes, bool)
            or not isinstance(self.max_collection_bytes, int)
            or self.max_collection_bytes <= 0
        ):
            raise ValueError("max_collection_bytes must be a positive integer")
        if self.estimated_snapshot_bytes is not None and (
            isinstance(self.estimated_snapshot_bytes, bool)
            or not isinstance(self.estimated_snapshot_bytes, int)
            or self.estimated_snapshot_bytes <= 0
        ):
            raise ValueError("estimated_snapshot_bytes must be a positive integer or None")


@dataclass(frozen=True, slots=True)
class CogCollectionBudgetAssessment:
    budget: CogCollectionBudget
    available_bytes: int
    selected_snapshot_count: int
    snapshot_staging_bytes: int
    minimum_free_bytes: int
    batch_execution_budget: CogSnapshotBatchExecutionBudget
    existing_snapshot_count: int
    existing_snapshot_bytes: int
    remaining_snapshot_count: int
    execution_peak_bytes: int
    projected_final_bytes: int | None
    required_available_bytes: int | None
    violations: tuple[str, ...]

    @property
    def approved(self) -> bool:
        return not self.violations

    def manifest(self) -> dict[str, Any]:
        return {
            "approved": self.approved,
            "violations": list(self.violations),
            "limits": {
                "maxCollectionBytes": self.budget.max_collection_bytes,
                "estimatedSnapshotBytes": self.budget.estimated_snapshot_bytes,
                "snapshotMaxStagedBytes": self.snapshot_staging_bytes,
                "minimumFreeBytes": self.minimum_free_bytes,
                "batchExecution": {
                    "maxSnapshots": self.batch_execution_budget.max_snapshots,
                    "maxStagedBytes": self.batch_execution_budget.max_staged_bytes,
                    "minimumFreeBytes": (
                        self.batch_execution_budget.minimum_free_bytes
                    ),
                },
            },
            "observed": {
                "selectedSnapshotCount": self.selected_snapshot_count,
                "existingSnapshotCount": self.existing_snapshot_count,
                "existingSnapshotBytes": self.existing_snapshot_bytes,
                "remainingSnapshotCount": self.remaining_snapshot_count,
                "executionPeakBytes": self.execution_peak_bytes,
                "availableBytes": self.available_bytes,
                "projectedFinalBytes": self.projected_final_bytes,
                "requiredAvailableBytes": self.required_available_bytes,
            },
        }


@dataclass(frozen=True, slots=True)
class CogCollectionPlan:
    time_indices: tuple[int, ...]
    field_count: int
    coverage: str
    request_sha256: str
    request_facts: dict[str, Any]
    snapshot_plan: CogBuildPlan
    budget: CogCollectionBudgetAssessment

    def manifest(self) -> dict[str, Any]:
        return {
            "schemaVersion": COG_COLLECTION_SCHEMA_VERSION,
            "artifactType": "flow-field-cog-collection-plan",
            "requestSha256": self.request_sha256,
            "coverage": self.coverage,
            "selection": {
                "timeIndices": list(self.time_indices),
                "snapshotCount": len(self.time_indices),
                "sourceFieldCount": self.field_count,
            },
            "request": self.request_facts,
            "snapshotPlan": self.snapshot_plan.manifest(),
            "collectionBudget": self.budget.manifest(),
        }

    def require_output_approved(self) -> None:
        if self.budget.remaining_snapshot_count > 0:
            self.snapshot_plan.require_output_approved()
        if self.budget.approved:
            return
        raise ValueError(
            "Flow Field COG collection exceeds configured budgets: "
            + ", ".join(self.budget.violations)
        )


def canonical_time_indices(
    values: Iterable[int],
    field_count: int,
) -> tuple[int, ...]:
    if isinstance(field_count, bool) or not isinstance(field_count, int) or field_count <= 0:
        raise ValueError("field_count must be a positive integer")
    requested = tuple(values)
    if not requested:
        raise ValueError("Flow Field COG collection selection cannot be empty")
    if any(isinstance(value, bool) or not isinstance(value, int) for value in requested):
        raise ValueError("Flow Field COG collection time indices must be integers")
    if len(set(requested)) != len(requested):
        raise ValueError("Flow Field COG collection time indices cannot contain duplicates")
    if any(value < 0 or value >= field_count for value in requested):
        raise ValueError("Flow Field COG collection time index is outside the descriptor")
    return tuple(sorted(requested))


def parse_time_indices(value: str, field_count: int) -> tuple[int, ...]:
    if not isinstance(value, str) or not value or value.strip() != value:
        raise ValueError("--time-indices must be a comma-separated integer list")
    tokens = value.split(",")
    if any(not token or token.strip() != token for token in tokens):
        raise ValueError("--time-indices must not contain empty or padded entries")
    try:
        parsed = tuple(int(token, 10) for token in tokens)
    except ValueError as error:
        raise ValueError("--time-indices must contain decimal integers") from error
    if any(str(number) != token for number, token in zip(parsed, tokens, strict=True)):
        raise ValueError("--time-indices must use canonical decimal integers")
    return canonical_time_indices(parsed, field_count)


def parse_time_range(value: str, field_count: int) -> tuple[int, ...]:
    if not isinstance(value, str) or value.count(":") != 1:
        raise ValueError("--time-range must use START:STOP")
    start_text, stop_text = value.split(":")
    if not start_text or not stop_text:
        raise ValueError("--time-range must include START and STOP")
    try:
        start = int(start_text, 10)
        stop = int(stop_text, 10)
    except ValueError as error:
        raise ValueError("--time-range must contain decimal integers") from error
    if str(start) != start_text or str(stop) != stop_text:
        raise ValueError("--time-range must use canonical decimal integers")
    if start < 0 or stop > field_count or start >= stop:
        raise ValueError("--time-range must be a non-empty descriptor range")
    return tuple(range(start, stop))


def plan_velocity_cog_collection(
    data_directory: str | Path = DEFAULT_DATA_DIRECTORY,
    output_directory: str | Path = DEFAULT_COG_COLLECTION_DIRECTORY,
    *,
    time_indices: tuple[int, ...],
    descriptor_path: str | Path = DEFAULT_DESCRIPTOR_PATH,
    topology: TopologySpec | None = None,
    interpolation: InterpolationSpec | None = None,
    resolution: ResolutionSpec | None = None,
    encoding: CogEncoding = CogEncoding(),
    snapshot_budget: CogBuildBudget = CogBuildBudget(),
    collection_budget: CogCollectionBudget = CogCollectionBudget(),
    batch_execution_budget: CogSnapshotBatchExecutionBudget = (
        CogSnapshotBatchExecutionBudget()
    ),
) -> CogCollectionPlan:
    descriptor = read_source_descriptor(descriptor_path)
    selected = canonical_time_indices(time_indices, descriptor.field_count)
    if not isinstance(encoding, CogEncoding):
        raise TypeError("encoding must be a CogEncoding")
    if not isinstance(collection_budget, CogCollectionBudget):
        raise TypeError("collection_budget must be a CogCollectionBudget")
    if not isinstance(batch_execution_budget, CogSnapshotBatchExecutionBudget):
        raise TypeError(
            "batch_execution_budget must be a CogSnapshotBatchExecutionBudget"
        )
    output = _collection_output_path(output_directory, create_parent=False)
    snapshot = load_source_snapshot(
        data_directory,
        time_index=selected[0],
        descriptor_path=descriptor_path,
    )
    snapshot_plan = plan_velocity_cog_snapshot(
        snapshot.stations,
        snapshot.geographic_bounds,
        output.parent,
        resolution=resolution,
        budget=snapshot_budget,
    )
    resolved_topology = resolve_topology(
        descriptor.topology if topology is None else topology
    )
    resolved_interpolation = resolve_interpolation(
        descriptor.interpolation if interpolation is None else interpolation
    )
    request_facts = {
        "source": {
            "datasetId": descriptor.dataset_id,
            "sourceRevision": descriptor.source_revision,
            "sourceHash": source_descriptor_hash(descriptor),
            "stationCount": descriptor.station_count,
            "stationHash": descriptor.station_sha256,
        },
        "selection": {
            "timeIndices": list(selected),
            "coverage": "full" if len(selected) == descriptor.field_count else "subset",
        },
        "topology": resolved_topology.manifest(),
        "interpolation": resolved_interpolation.manifest(),
        "snapshotConstruction": snapshot_plan.construction_manifest(),
        "encoding": encoding.manifest(),
        "adapterVersion": COG_COLLECTION_ADAPTER_VERSION,
        "toolchain": {
            "flowFieldTools": PACKAGE_VERSION,
            "python": platform.python_version(),
            "numpy": np.__version__,
            "scipy": scipy.__version__,
            "morecantile": morecantile.__version__,
            "rasterio": rasterio.__version__,
            "gdal": rasterio.__gdal_version__,
            "rioCogeo": rio_cogeo.__version__,
        },
        "runtimeMatrices": {
            "minimum": str(RUNTIME_MINIMUM_MATRIX),
            "maximum": str(RUNTIME_MAXIMUM_MATRIX),
        },
    }
    request_sha256 = hashlib.sha256(
        json.dumps(request_facts, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    existing_count, existing_bytes = _measure_resume_snapshots(
        output,
        request_sha256,
        descriptor,
        selected,
        snapshot_plan,
        encoding,
    )
    remaining_count = len(selected) - existing_count
    available_bytes = shutil.disk_usage(output.parent).free
    minimum_free_bytes = max(
        snapshot_budget.minimum_free_bytes,
        batch_execution_budget.minimum_free_bytes,
    )
    execution_peak_bytes = max(
        snapshot_budget.max_staged_bytes + snapshot_budget.minimum_free_bytes,
        (
            batch_execution_budget.max_staged_bytes
            + batch_execution_budget.minimum_free_bytes
        ),
    )
    estimated = collection_budget.estimated_snapshot_bytes
    projected = (
        existing_bytes + estimated * remaining_count
        if estimated is not None
        else (existing_bytes if remaining_count == 0 else None)
    )
    required = (
        minimum_free_bytes
        if remaining_count == 0
        else (
            (0 if estimated is None else estimated * remaining_count)
            + execution_peak_bytes
        )
    )
    violations: list[str] = []
    if snapshot_plan.grid.matrix_id < RUNTIME_MAXIMUM_MATRIX:
        violations.append(
            "runtime adapter base matrix "
            f"{snapshot_plan.grid.matrix_id} < {RUNTIME_MAXIMUM_MATRIX}"
        )
    if remaining_count > 1 and estimated is None:
        violations.append("compressed snapshot estimate is required for multi-time output")
    if projected is not None and projected > collection_budget.max_collection_bytes:
        violations.append(
            f"collection byte budget {projected} > {collection_budget.max_collection_bytes}"
        )
    if required is not None and required > available_bytes:
        violations.append(f"collection free-space budget {required} > {available_bytes}")
    assessment = CogCollectionBudgetAssessment(
        budget=collection_budget,
        available_bytes=available_bytes,
        selected_snapshot_count=len(selected),
        snapshot_staging_bytes=snapshot_budget.max_staged_bytes,
        minimum_free_bytes=minimum_free_bytes,
        batch_execution_budget=batch_execution_budget,
        existing_snapshot_count=existing_count,
        existing_snapshot_bytes=existing_bytes,
        remaining_snapshot_count=remaining_count,
        execution_peak_bytes=execution_peak_bytes,
        projected_final_bytes=projected,
        required_available_bytes=required,
        violations=tuple(violations),
    )
    return CogCollectionPlan(
        time_indices=selected,
        field_count=descriptor.field_count,
        coverage="full" if len(selected) == descriptor.field_count else "subset",
        request_sha256=request_sha256,
        request_facts=request_facts,
        snapshot_plan=snapshot_plan,
        budget=assessment,
    )


def _selected_times(arguments: argparse.Namespace, field_count: int) -> tuple[int, ...]:
    selected = sum((
        bool(arguments.all_times),
        arguments.time_range is not None,
        arguments.time_indices is not None,
    ))
    if selected != 1:
        raise ValueError(
            "choose exactly one of --all-times, --time-range, or --time-indices"
        )
    if arguments.all_times:
        return tuple(range(field_count))
    if arguments.time_range is not None:
        return parse_time_range(arguments.time_range, field_count)
    return parse_time_indices(arguments.time_indices, field_count)


def main() -> None:
    snapshot_defaults = CogBuildBudget()
    batch_defaults = CogSnapshotBatchExecutionBudget()
    collection_defaults = CogCollectionBudget()
    parser = argparse.ArgumentParser(
        description="Plan, build, resume, or verify a temporal Flow Field COG collection"
    )
    parser.add_argument("--source", type=Path, default=DEFAULT_DATA_DIRECTORY)
    parser.add_argument("--descriptor", type=Path, default=DEFAULT_DESCRIPTOR_PATH)
    parser.add_argument("--output", type=Path, default=DEFAULT_COG_COLLECTION_DIRECTORY)
    parser.add_argument(
        "--matrix",
        type=int,
        help=(
            "explicit WebMercatorQuad base matrix in [0, 24]; "
            "omit to use station-spacing statistics"
        ),
    )
    selection = parser.add_mutually_exclusive_group()
    selection.add_argument("--all-times", action="store_true")
    selection.add_argument("--time-range", metavar="START:STOP")
    selection.add_argument("--time-indices", metavar="N,N,...")
    parser.add_argument("--plan-only", action="store_true")
    parser.add_argument("--verify-existing", action="store_true")
    parser.add_argument(
        "--identity-only",
        action="store_true",
        help="verify container/file identities without re-reading every runtime page",
    )
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--discard-incomplete-work", action="store_true")
    parser.add_argument("--replace-existing", action="store_true")
    parser.add_argument(
        "--estimated-snapshot-bytes",
        type=int,
        help="measured or externally justified compressed bytes per snapshot",
    )
    parser.add_argument(
        "--max-collection-bytes",
        type=int,
        default=collection_defaults.max_collection_bytes,
    )
    parser.add_argument("--max-blocks", type=int, default=snapshot_defaults.max_blocks)
    parser.add_argument(
        "--max-raw-pyramid-bytes",
        type=int,
        default=snapshot_defaults.max_raw_pyramid_bytes,
    )
    parser.add_argument(
        "--max-staged-bytes",
        type=int,
        default=snapshot_defaults.max_staged_bytes,
    )
    parser.add_argument(
        "--minimum-free-bytes",
        type=int,
        default=snapshot_defaults.minimum_free_bytes,
    )
    parser.add_argument(
        "--batch-size",
        type=int,
        choices=(1, 2),
        default=batch_defaults.max_snapshots,
    )
    parser.add_argument(
        "--max-batch-staged-bytes",
        type=int,
        default=batch_defaults.max_staged_bytes,
    )
    parser.add_argument(
        "--batch-minimum-free-bytes",
        type=int,
        default=batch_defaults.minimum_free_bytes,
    )
    events = parser.add_mutually_exclusive_group()
    events.add_argument("--events-stderr", action="store_true")
    events.add_argument("--events-file", type=Path)
    arguments = parser.parse_args()
    try:
        resolution = (
            None
            if arguments.matrix is None
            else FixedWebMercatorResolution(arguments.matrix)
        )
    except ValueError as error:
        parser.error(str(error))
    if arguments.verify_existing:
        if (
            arguments.plan_only
            or arguments.resume
            or arguments.replace_existing
            or arguments.discard_incomplete_work
            or arguments.all_times
            or arguments.time_range is not None
            or arguments.time_indices is not None
            or arguments.events_stderr
            or arguments.events_file is not None
            or arguments.matrix is not None
        ):
            parser.error("--verify-existing cannot be combined with build options")
        print(json.dumps(
            verify_velocity_cog_collection(
                arguments.output,
                deep=not arguments.identity_only,
            ),
            sort_keys=True,
        ))
        return
    if arguments.identity_only:
        parser.error("--identity-only requires --verify-existing")
    if arguments.discard_incomplete_work and not arguments.resume:
        parser.error("--discard-incomplete-work requires --resume")
    descriptor = read_source_descriptor(arguments.descriptor)
    try:
        selected = _selected_times(arguments, descriptor.field_count)
    except ValueError as error:
        parser.error(str(error))
    snapshot_budget = CogBuildBudget(
        max_blocks=arguments.max_blocks,
        max_raw_pyramid_bytes=arguments.max_raw_pyramid_bytes,
        max_staged_bytes=arguments.max_staged_bytes,
        minimum_free_bytes=arguments.minimum_free_bytes,
    )
    collection_budget = CogCollectionBudget(
        max_collection_bytes=arguments.max_collection_bytes,
        estimated_snapshot_bytes=arguments.estimated_snapshot_bytes,
    )
    batch_execution_budget = CogSnapshotBatchExecutionBudget(
        max_snapshots=arguments.batch_size,
        max_staged_bytes=arguments.max_batch_staged_bytes,
        minimum_free_bytes=arguments.batch_minimum_free_bytes,
    )
    if arguments.plan_only:
        if (
            arguments.resume
            or arguments.replace_existing
            or arguments.events_stderr
            or arguments.events_file is not None
        ):
            parser.error("--plan-only cannot resume or replace output")
        result = plan_velocity_cog_collection(
            arguments.source,
            arguments.output,
            time_indices=selected,
            descriptor_path=arguments.descriptor,
            resolution=resolution,
            snapshot_budget=snapshot_budget,
            batch_execution_budget=batch_execution_budget,
            collection_budget=collection_budget,
        )
        print(json.dumps(result.manifest(), sort_keys=True))
        return
    stream = None
    close_stream = False
    try:
        if arguments.events_stderr:
            stream = sys.stderr
        elif arguments.events_file is not None:
            event_path = Path(os.path.abspath(os.fspath(arguments.events_file)))
            if event_path.is_symlink() or not event_path.parent.is_dir():
                parser.error("--events-file must be a local non-symlink path")
            stream = event_path.open("a", encoding="utf-8")
            close_stream = True
        from .job_control import JsonlProgressSink

        result = build_velocity_cog_collection(
            arguments.source,
            arguments.output,
            time_indices=selected,
            descriptor_path=arguments.descriptor,
            resolution=resolution,
            snapshot_budget=snapshot_budget,
            batch_execution_budget=batch_execution_budget,
            collection_budget=collection_budget,
            resume=arguments.resume,
            replace_existing=arguments.replace_existing,
            discard_incomplete=arguments.discard_incomplete_work,
            progress=None if stream is None else JsonlProgressSink(stream),
        )
    finally:
        if close_stream and stream is not None:
            stream.close()
    print(json.dumps({
        "batchExecution": {
            "maxSnapshots": batch_execution_budget.max_snapshots,
            "maxStagedBytes": batch_execution_budget.max_staged_bytes,
            "minimumFreeBytes": batch_execution_budget.minimum_free_bytes,
        },
        "contentVersion": result.content_version,
        "manifest": str(result.manifest_path),
        "output": str(result.output_directory),
        "pageCount": result.page_count,
        "runtimeManifest": str(result.runtime_manifest_path),
        "snapshotCount": result.snapshot_count,
        "status": result.status,
        "replacedBackup": (
            None
            if result.replaced_backup_directory is None
            else str(result.replaced_backup_directory)
        ),
    }, sort_keys=True))


if __name__ == "__main__":
    main()
