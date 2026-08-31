from __future__ import annotations

import hashlib
import json
import os
import shutil
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

from .cog import (
    CogBuildBudget,
    CogBuildPlan,
    CogEncoding,
    plan_velocity_cog_snapshot,
)
from .contracts import (
    InterpolationSpec,
    TopologySpec,
    resolve_interpolation,
    resolve_topology,
)
from .resolution import ResolutionSpec
from .source import (
    DEFAULT_DATA_DIRECTORY,
    DEFAULT_DESCRIPTOR_PATH,
    load_source_snapshot,
    read_source_descriptor,
    source_descriptor_hash,
)


TILE_SERVER_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_COG_COLLECTION_DIRECTORY = TILE_SERVER_ROOT / "cog-collection"
COG_COLLECTION_MARKER = ".flow-field-cog-collection.json"
COG_COLLECTION_WORK_MARKER = ".flow-field-cog-collection-work.json"
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


class CogCollectionConflictError(RuntimeError):
    code = "FLOW_COG_COLLECTION_CONFLICT"


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


def _safe_collection_output(output_directory: str | Path) -> Path:
    requested = Path(os.path.abspath(os.fspath(output_directory)))
    if requested.name != "cog-collection" or requested.parent == Path(requested.anchor):
        raise ValueError(
            "Flow Field COG collection output must be an explicit cog-collection directory"
        )
    requested.parent.mkdir(parents=True, exist_ok=True)
    if requested.is_symlink():
        raise ValueError("Flow Field COG collection output cannot be a symbolic link")
    return requested.parent.resolve(strict=True) / requested.name


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
    return {entry.name for entry in output.iterdir()} == {
        COG_COLLECTION_MARKER,
        "manifest.json",
        "runtime-manifest.json",
        "snapshots",
    }


def _capture_collection_output_state(output: Path) -> CogCollectionOutputState:
    if not output.exists():
        return CogCollectionOutputState("absent", None, None, None, None, ())
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
    )


def _install_collection_directory(
    staged: Path,
    output: Path,
    expected_state: CogCollectionOutputState,
    *,
    replace_existing: bool,
) -> None:
    if _capture_collection_output_state(output) != expected_state:
        raise CogCollectionConflictError(
            "FLOW_COG_COLLECTION_CHANGED_DURING_BUILD"
        )
    if expected_state.kind == "absent":
        os.replace(staged, output)
        return
    if not replace_existing:
        raise CogCollectionConflictError(
            "published Flow Field COG collection already exists"
        )
    backup = output.parent / f".{output.name}.backup-{uuid.uuid4().hex}"
    os.replace(output, backup)
    try:
        os.replace(staged, output)
    except BaseException:
        os.replace(backup, output)
        raise
    shutil.rmtree(backup)


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
            },
            "observed": {
                "selectedSnapshotCount": self.selected_snapshot_count,
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
) -> CogCollectionPlan:
    descriptor = read_source_descriptor(descriptor_path)
    selected = canonical_time_indices(time_indices, descriptor.field_count)
    if not isinstance(encoding, CogEncoding):
        raise TypeError("encoding must be a CogEncoding")
    if not isinstance(collection_budget, CogCollectionBudget):
        raise TypeError("collection_budget must be a CogCollectionBudget")
    output = Path(os.path.abspath(os.fspath(output_directory)))
    if not output.parent.is_dir():
        raise FileNotFoundError(f"COG collection output parent does not exist: {output.parent}")
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
        "runtimeMatrices": {
            "minimum": str(RUNTIME_MINIMUM_MATRIX),
            "maximum": str(RUNTIME_MAXIMUM_MATRIX),
        },
    }
    request_sha256 = hashlib.sha256(
        json.dumps(request_facts, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    available_bytes = shutil.disk_usage(output.parent).free
    estimated = collection_budget.estimated_snapshot_bytes
    projected = None if estimated is None else estimated * len(selected)
    required = (
        None
        if projected is None
        else projected + snapshot_budget.max_staged_bytes + snapshot_budget.minimum_free_bytes
    )
    violations: list[str] = []
    if len(selected) > 1 and estimated is None:
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
        minimum_free_bytes=snapshot_budget.minimum_free_bytes,
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
