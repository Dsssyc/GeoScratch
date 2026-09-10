from __future__ import annotations

import hashlib
import json
import math
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

import numpy as np

from .contracts import (
    DelaunayTopology,
    TriangleLinearInterpolation,
    read_interpolation_spec,
    read_topology_spec,
)


TILE_SERVER_ROOT = Path(__file__).resolve().parents[3] / "flowField" / "tile-server"
DEFAULT_DESCRIPTOR_PATH = TILE_SERVER_ROOT / "source-dataset.json"
DEFAULT_DATA_DIRECTORY = (
    TILE_SERVER_ROOT.parent.parent / "public" / "json" / "examples" / "flow"
)
SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")


@dataclass(frozen=True)
class FieldSourceDescriptor:
    time_index: int
    model_time: int | float
    filename: str
    sha256: str


@dataclass(frozen=True)
class SourceAuthority:
    unit: Literal["authoritative", "unconfirmed"] = "unconfirmed"
    basis: Literal["authoritative", "unconfirmed"] = "unconfirmed"
    time: Literal["authoritative", "unconfirmed"] = "unconfirmed"
    phase: Literal["authoritative", "unconfirmed"] = "unconfirmed"
    topology: Literal["authoritative", "inferred"] = "inferred"

    def __post_init__(self) -> None:
        for name in ("unit", "basis", "time", "phase"):
            if getattr(self, name) not in {"authoritative", "unconfirmed"}:
                raise ValueError(f"authority.{name} must be authoritative or unconfirmed")
        if self.topology not in {"authoritative", "inferred"}:
            raise ValueError("authority.topology must be authoritative or inferred")

    def manifest(self) -> dict[str, str]:
        return {
            "unit": self.unit,
            "basis": self.basis,
            "time": self.time,
            "phase": self.phase,
            "topology": self.topology,
        }


@dataclass(frozen=True)
class SourceDescriptor:
    schema_version: Literal[2, 3]
    dataset_id: str
    source_revision: str
    station_count: int
    field_count: int
    unit: str
    basis: str
    time_unit: str | None
    phase: str
    authority: SourceAuthority
    station_filename: str
    station_sha256: str
    fields: tuple[FieldSourceDescriptor, ...]
    topology: DelaunayTopology
    interpolation: TriangleLinearInterpolation


@dataclass(frozen=True)
class SourceDataset:
    descriptor: SourceDescriptor
    stations: np.ndarray
    fields: tuple[np.ndarray, ...]
    geographic_bounds: tuple[float, float, float, float]
    source_hash: str


@dataclass(frozen=True)
class SourceSnapshot:
    descriptor: SourceDescriptor
    field_descriptor: FieldSourceDescriptor
    stations: np.ndarray
    field: np.ndarray
    geographic_bounds: tuple[float, float, float, float]
    source_hash: str


def _require_integer(value: Any, name: str, minimum: int = 0) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < minimum:
        raise ValueError(f"{name} must be an integer greater than or equal to {minimum}")
    return value


def _require_string(value: Any, name: str) -> str:
    if not isinstance(value, str) or not value:
        raise ValueError(f"{name} must be a non-empty string")
    return value


def _require_filename(value: Any, name: str) -> str:
    filename = _require_string(value, name)
    if Path(filename).name != filename:
        raise ValueError(f"{name} must be a source-directory filename")
    return filename


def _require_sha256(value: Any, name: str) -> str:
    digest = _require_string(value, name)
    if SHA256_PATTERN.fullmatch(digest) is None:
        raise ValueError(f"{name} must be a lowercase SHA-256 digest")
    return digest


def _require_finite_number(value: Any, name: str) -> int | float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{name} must be a finite number")
    if isinstance(value, float) and not math.isfinite(value):
        raise ValueError(f"{name} must be a finite number")
    return value


def _read_authority(value: Any) -> SourceAuthority:
    if not isinstance(value, dict) or set(value) != {
        "unit",
        "basis",
        "time",
        "phase",
        "topology",
    }:
        raise ValueError(
            "authority must contain exactly unit, basis, time, phase, and topology"
        )
    return SourceAuthority(
        unit=value["unit"],
        basis=value["basis"],
        time=value["time"],
        phase=value["phase"],
        topology=value["topology"],
    )


def read_source_descriptor(path: str | Path = DEFAULT_DESCRIPTOR_PATH) -> SourceDescriptor:
    descriptor_path = Path(path).resolve()
    raw = json.loads(descriptor_path.read_text(encoding="utf-8"))
    if not isinstance(raw, dict) or raw.get("schemaVersion") not in {2, 3}:
        raise ValueError("Flow Field source descriptor schemaVersion must be 2 or 3")
    schema_version = raw["schemaVersion"]
    allowed = {
        "schemaVersion",
        "datasetId",
        "sourceRevision",
        "stationCount",
        "fieldCount",
        "unit",
        "basis",
        "phase",
        "station",
        "fields",
        "topology",
        "interpolation",
    }
    if schema_version == 3:
        allowed |= {"timeUnit", "authority"}
    unknown = set(raw) - allowed
    if unknown:
        raise ValueError(
            f"Flow Field source descriptor contains unknown keys: {sorted(unknown)}"
        )
    station_count = _require_integer(raw.get("stationCount"), "stationCount", 3)
    field_count = _require_integer(raw.get("fieldCount"), "fieldCount", 1)
    station = raw.get("station")
    if not isinstance(station, dict):
        raise ValueError("station must be an object")
    if set(station) != {"file", "sha256"}:
        raise ValueError("station must contain exactly file and sha256")
    raw_fields = raw.get("fields")
    if not isinstance(raw_fields, list) or len(raw_fields) != field_count:
        raise ValueError("fields length must equal fieldCount")
    fields: list[FieldSourceDescriptor] = []
    previous_model_time: int | float | None = None
    for expected_time_index, field in enumerate(raw_fields):
        if not isinstance(field, dict):
            raise ValueError(f"fields[{expected_time_index}] must be an object")
        if set(field) != {"timeIndex", "modelTime", "file", "sha256"}:
            raise ValueError(
                f"fields[{expected_time_index}] contains unknown or missing keys"
            )
        time_index = _require_integer(
            field.get("timeIndex"),
            f"fields[{expected_time_index}].timeIndex",
        )
        if schema_version == 2:
            model_time = _require_integer(
                field.get("modelTime"),
                f"fields[{expected_time_index}].modelTime",
            )
            if time_index != expected_time_index or model_time != expected_time_index:
                raise ValueError(
                    "Flow Field schema 2 source times must be the ordered ordinals 0..N-1"
                )
        else:
            model_time = _require_finite_number(
                field.get("modelTime"),
                f"fields[{expected_time_index}].modelTime",
            )
            if time_index != expected_time_index:
                raise ValueError("Flow Field source timeIndex values must be dense from zero")
            if previous_model_time is not None and model_time <= previous_model_time:
                raise ValueError(
                    "Flow Field schema 3 modelTime values must be strictly increasing"
                )
            previous_model_time = model_time
        fields.append(FieldSourceDescriptor(
            time_index=time_index,
            model_time=model_time,
            filename=_require_filename(
                field.get("file"),
                f"fields[{expected_time_index}].file",
            ),
            sha256=_require_sha256(
                field.get("sha256"),
                f"fields[{expected_time_index}].sha256",
            ),
        ))
    topology = read_topology_spec(raw.get("topology"))
    interpolation = read_interpolation_spec(raw.get("interpolation"))
    if schema_version == 2:
        if raw.get("unit") != "legacy-flow-unit":
            raise ValueError("Flow Field source unit must be legacy-flow-unit")
        if raw.get("basis") != "source-u-v":
            raise ValueError("Flow Field source basis must be source-u-v")
        if raw.get("phase") != "unspecified":
            raise ValueError("Flow Field source phase must be unspecified")
        unit = raw["unit"]
        basis = raw["basis"]
        time_unit = None
        phase = raw["phase"]
        authority = SourceAuthority()
    else:
        unit = _require_string(raw.get("unit"), "unit")
        basis = _require_string(raw.get("basis"), "basis")
        time_unit = _require_string(raw.get("timeUnit"), "timeUnit")
        phase = _require_string(raw.get("phase"), "phase")
        authority = _read_authority(raw.get("authority"))
        if topology.kind == "delaunay" and authority.topology != "inferred":
            raise ValueError("Delaunay topology authority must be inferred")
    return SourceDescriptor(
        schema_version=schema_version,
        dataset_id=_require_string(raw.get("datasetId"), "datasetId"),
        source_revision=_require_string(raw.get("sourceRevision"), "sourceRevision"),
        station_count=station_count,
        field_count=field_count,
        unit=unit,
        basis=basis,
        time_unit=time_unit,
        phase=phase,
        authority=authority,
        station_filename=_require_filename(station.get("file"), "station.file"),
        station_sha256=_require_sha256(station.get("sha256"), "station.sha256"),
        fields=tuple(fields),
        topology=topology,
        interpolation=interpolation,
    )


def _read_float32_pairs(
    path: Path,
    expected_count: int,
    expected_hash: str,
    label: str,
) -> np.ndarray:
    if not path.is_file():
        raise FileNotFoundError(f"{label} source does not exist: {path}")
    payload = path.read_bytes()
    digest = hashlib.sha256(payload).hexdigest()
    if digest != expected_hash:
        raise ValueError(
            f"{label} source hash mismatch: expected {expected_hash}, received {digest}"
        )
    expected_byte_length = expected_count * 2 * np.dtype("<f4").itemsize
    if len(payload) != expected_byte_length:
        raise ValueError(
            f"{label} source byte length mismatch: expected {expected_byte_length}, "
            f"received {len(payload)}"
        )
    values = np.frombuffer(payload, dtype="<f4").reshape(expected_count, 2).copy()
    if not np.isfinite(values).all():
        raise ValueError(f"{label} source must contain finite float32 pairs")
    return values


def source_descriptor_identity_manifest(
    descriptor: SourceDescriptor,
) -> dict[str, Any]:
    """Return the complete descriptor facts needed to reproduce source identity."""
    if not isinstance(descriptor, SourceDescriptor):
        raise TypeError("descriptor must be a SourceDescriptor")
    return {
        "schemaVersion": descriptor.schema_version,
        "datasetId": descriptor.dataset_id,
        "sourceRevision": descriptor.source_revision,
        "stationCount": descriptor.station_count,
        "fieldCount": descriptor.field_count,
        "stationSha256": descriptor.station_sha256,
        "fields": [
            {
                "timeIndex": field.time_index,
                "modelTime": field.model_time,
                "file": field.filename,
                "sha256": field.sha256,
            }
            for field in descriptor.fields
        ],
        "unit": descriptor.unit,
        "basis": descriptor.basis,
        "timeUnit": descriptor.time_unit or "ordinal",
        "phase": descriptor.phase,
        "authority": descriptor.authority.manifest(),
    }


def source_descriptor_identity_manifest_hash(value: object) -> str:
    """Validate embedded descriptor facts and reproduce their canonical source hash."""
    expected_keys = {
        "schemaVersion",
        "datasetId",
        "sourceRevision",
        "stationCount",
        "fieldCount",
        "stationSha256",
        "fields",
        "unit",
        "basis",
        "timeUnit",
        "phase",
        "authority",
    }
    if not isinstance(value, dict) or set(value) != expected_keys:
        raise ValueError("Flow Field source descriptor identity is invalid")
    schema_version = value["schemaVersion"]
    station_count = _require_integer(value["stationCount"], "stationCount", 3)
    field_count = _require_integer(value["fieldCount"], "fieldCount", 1)
    dataset_id = _require_string(value["datasetId"], "datasetId")
    source_revision = _require_string(value["sourceRevision"], "sourceRevision")
    station_sha256 = _require_sha256(value["stationSha256"], "stationSha256")
    unit = _require_string(value["unit"], "unit")
    basis = _require_string(value["basis"], "basis")
    time_unit = _require_string(value["timeUnit"], "timeUnit")
    phase = _require_string(value["phase"], "phase")
    authority = _read_authority(value["authority"])
    fields = value["fields"]
    if schema_version not in {2, 3} or not isinstance(fields, list) or (
        len(fields) != field_count
    ):
        raise ValueError("Flow Field source descriptor identity is invalid")
    normalized_fields: list[dict[str, Any]] = []
    previous_model_time: int | float | None = None
    for expected_index, field in enumerate(fields):
        if not isinstance(field, dict) or set(field) != {
            "timeIndex", "modelTime", "file", "sha256"
        }:
            raise ValueError("Flow Field source descriptor time inventory is invalid")
        time_index = _require_integer(field["timeIndex"], "timeIndex")
        if time_index != expected_index:
            raise ValueError("Flow Field source descriptor time inventory is invalid")
        model_time = _require_finite_number(field["modelTime"], "modelTime")
        if schema_version == 2:
            if not isinstance(model_time, int) or model_time != expected_index:
                raise ValueError("Flow Field schema 2 model time identity is invalid")
        elif previous_model_time is not None and model_time <= previous_model_time:
            raise ValueError("Flow Field source model times must be strictly increasing")
        previous_model_time = model_time
        normalized_fields.append({
            "timeIndex": time_index,
            "modelTime": model_time,
            "file": _require_filename(field["file"], "field.file"),
            "sha256": _require_sha256(field["sha256"], "field.sha256"),
        })
    if schema_version == 2:
        if (
            unit != "legacy-flow-unit"
            or basis != "source-u-v"
            or time_unit != "ordinal"
            or phase != "unspecified"
            or authority != SourceAuthority()
        ):
            raise ValueError("Flow Field schema 2 descriptor identity is invalid")
        facts = [
            dataset_id,
            source_revision,
            str(station_count),
            str(field_count),
            station_sha256,
            *(
                f"{field['timeIndex']}:{field['modelTime']}:{field['file']}:{field['sha256']}"
                for field in normalized_fields
            ),
            unit,
            basis,
            phase,
        ]
        payload = "\n".join(facts).encode("utf-8")
    else:
        payload = json.dumps(
            {
                "schemaVersion": schema_version,
                "datasetId": dataset_id,
                "sourceRevision": source_revision,
                "stationCount": station_count,
                "fieldCount": field_count,
                "stationSha256": station_sha256,
                "fields": normalized_fields,
                "unit": unit,
                "basis": basis,
                "timeUnit": time_unit,
                "phase": phase,
                "authority": authority.manifest(),
            },
            allow_nan=False,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def source_descriptor_hash(descriptor: SourceDescriptor) -> str:
    """Return the descriptor-only source identity without reading field payloads."""
    return source_descriptor_identity_manifest_hash(
        source_descriptor_identity_manifest(descriptor)
    )


def source_snapshot_identity_manifest_hash(
    descriptor_identity: object,
    time_index: int,
) -> str:
    """Reproduce one snapshot identity from validated embedded descriptor facts."""
    source_descriptor_identity_manifest_hash(descriptor_identity)
    if not isinstance(descriptor_identity, dict):
        raise ValueError("Flow Field source descriptor identity is invalid")
    fields = descriptor_identity["fields"]
    if (
        isinstance(time_index, bool)
        or not isinstance(time_index, int)
        or time_index < 0
        or time_index >= len(fields)
    ):
        raise ValueError("Flow Field source snapshot index is invalid")
    field = fields[time_index]
    schema_version = descriptor_identity["schemaVersion"]
    if schema_version == 2:
        facts = [
            descriptor_identity["datasetId"],
            descriptor_identity["sourceRevision"],
            str(descriptor_identity["stationCount"]),
            descriptor_identity["stationSha256"],
            f"{field['timeIndex']}:{field['modelTime']}:{field['file']}:{field['sha256']}",
            descriptor_identity["unit"],
            descriptor_identity["basis"],
            descriptor_identity["phase"],
        ]
        payload = "\n".join(facts).encode("utf-8")
    else:
        payload = json.dumps(
            {
                "schemaVersion": schema_version,
                "datasetId": descriptor_identity["datasetId"],
                "sourceRevision": descriptor_identity["sourceRevision"],
                "stationCount": descriptor_identity["stationCount"],
                "stationSha256": descriptor_identity["stationSha256"],
                "field": field,
                "unit": descriptor_identity["unit"],
                "basis": descriptor_identity["basis"],
                "timeUnit": descriptor_identity["timeUnit"],
                "phase": descriptor_identity["phase"],
                "authority": descriptor_identity["authority"],
            },
            allow_nan=False,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def source_snapshot_hash(
    descriptor: SourceDescriptor,
    field: FieldSourceDescriptor,
) -> str:
    """Return one descriptor-bound snapshot identity without reading payload bytes."""
    if not isinstance(descriptor, SourceDescriptor):
        raise TypeError("descriptor must be a SourceDescriptor")
    if not isinstance(field, FieldSourceDescriptor) or field not in descriptor.fields:
        raise ValueError("field must belong to the source descriptor")
    return source_snapshot_identity_manifest_hash(
        source_descriptor_identity_manifest(descriptor),
        field.time_index,
    )


def _canonical_snapshot_time_indices(
    values: tuple[int, ...],
    field_count: int,
) -> tuple[int, ...]:
    requested = tuple(values)
    if not requested:
        raise ValueError("time_indices must contain at least one index")
    if any(isinstance(value, bool) or not isinstance(value, int) for value in requested):
        raise ValueError("time_indices must contain integers")
    if len(set(requested)) != len(requested):
        raise ValueError("time_indices must not contain duplicates")
    if any(value < 0 or value >= field_count for value in requested):
        raise ValueError("time_indices contain an index outside the source descriptor")
    return tuple(sorted(requested))


def load_source_snapshots(
    data_directory: str | Path = DEFAULT_DATA_DIRECTORY,
    *,
    time_indices: tuple[int, ...],
    descriptor_path: str | Path = DEFAULT_DESCRIPTOR_PATH,
) -> tuple[SourceSnapshot, ...]:
    requested = tuple(time_indices)
    source_directory = Path(data_directory).resolve()
    descriptor = read_source_descriptor(descriptor_path)
    selected = _canonical_snapshot_time_indices(requested, len(descriptor.fields))
    stations = _read_float32_pairs(
        source_directory / descriptor.station_filename,
        descriptor.station_count,
        descriptor.station_sha256,
        "station",
    )
    stations.setflags(write=False)
    bounds = (
        float(stations[:, 0].min()),
        float(stations[:, 1].min()),
        float(stations[:, 0].max()),
        float(stations[:, 1].max()),
    )
    snapshots: list[SourceSnapshot] = []
    for time_index in selected:
        field_descriptor = descriptor.fields[time_index]
        snapshots.append(SourceSnapshot(
            descriptor=descriptor,
            field_descriptor=field_descriptor,
            stations=stations,
            field=_read_float32_pairs(
                source_directory / field_descriptor.filename,
                descriptor.station_count,
                field_descriptor.sha256,
                f"time {time_index}",
            ),
            geographic_bounds=bounds,
            source_hash=source_snapshot_hash(descriptor, field_descriptor),
        ))
    return tuple(snapshots)


def load_source_snapshot(
    data_directory: str | Path = DEFAULT_DATA_DIRECTORY,
    *,
    time_index: int,
    descriptor_path: str | Path = DEFAULT_DESCRIPTOR_PATH,
) -> SourceSnapshot:
    if isinstance(time_index, bool) or not isinstance(time_index, int):
        raise ValueError("time_index must be an integer")
    try:
        return load_source_snapshots(
            data_directory,
            time_indices=(time_index,),
            descriptor_path=descriptor_path,
        )[0]
    except ValueError as error:
        if str(error) == "time_indices contain an index outside the source descriptor":
            raise ValueError("time_index is outside the source descriptor") from error
        raise


def load_source_dataset(
    data_directory: str | Path = DEFAULT_DATA_DIRECTORY,
    *,
    descriptor_path: str | Path = DEFAULT_DESCRIPTOR_PATH,
) -> SourceDataset:
    source_directory = Path(data_directory).resolve()
    descriptor = read_source_descriptor(descriptor_path)
    station_path = source_directory / descriptor.station_filename
    stations = _read_float32_pairs(
        station_path,
        descriptor.station_count,
        descriptor.station_sha256,
        "station",
    )
    fields = tuple(
        _read_float32_pairs(
            source_directory / field.filename,
            descriptor.station_count,
            field.sha256,
            f"time {field.time_index}",
        )
        for field in descriptor.fields
    )
    return SourceDataset(
        descriptor=descriptor,
        stations=stations,
        fields=fields,
        geographic_bounds=(
            float(stations[:, 0].min()),
            float(stations[:, 1].min()),
            float(stations[:, 0].max()),
            float(stations[:, 1].max()),
        ),
        source_hash=source_descriptor_hash(descriptor),
    )
