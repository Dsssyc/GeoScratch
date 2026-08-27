from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

from .contracts import (
    DelaunayTopology,
    TriangleLinearInterpolation,
    read_interpolation_spec,
    read_topology_spec,
)


TILE_SERVER_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_DESCRIPTOR_PATH = TILE_SERVER_ROOT / "source-dataset.json"
DEFAULT_DATA_DIRECTORY = (
    TILE_SERVER_ROOT.parent.parent / "public" / "json" / "examples" / "flow"
)
SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")


@dataclass(frozen=True)
class FieldSourceDescriptor:
    time_index: int
    model_time: int
    filename: str
    sha256: str


@dataclass(frozen=True)
class SourceDescriptor:
    dataset_id: str
    source_revision: str
    station_count: int
    field_count: int
    unit: str
    basis: str
    phase: str
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


def read_source_descriptor(path: str | Path = DEFAULT_DESCRIPTOR_PATH) -> SourceDescriptor:
    descriptor_path = Path(path).resolve()
    raw = json.loads(descriptor_path.read_text(encoding="utf-8"))
    if not isinstance(raw, dict) or raw.get("schemaVersion") != 2:
        raise ValueError("Flow Field source descriptor schemaVersion must be 2")
    station_count = _require_integer(raw.get("stationCount"), "stationCount", 3)
    field_count = _require_integer(raw.get("fieldCount"), "fieldCount", 1)
    if raw.get("unit") != "legacy-flow-unit":
        raise ValueError("Flow Field source unit must be legacy-flow-unit")
    if raw.get("basis") != "source-u-v":
        raise ValueError("Flow Field source basis must be source-u-v")
    if raw.get("phase") != "unspecified":
        raise ValueError("Flow Field source phase must be unspecified")
    station = raw.get("station")
    if not isinstance(station, dict):
        raise ValueError("station must be an object")
    raw_fields = raw.get("fields")
    if not isinstance(raw_fields, list) or len(raw_fields) != field_count:
        raise ValueError("fields length must equal fieldCount")
    fields: list[FieldSourceDescriptor] = []
    for expected_time_index, field in enumerate(raw_fields):
        if not isinstance(field, dict):
            raise ValueError(f"fields[{expected_time_index}] must be an object")
        time_index = _require_integer(
            field.get("timeIndex"),
            f"fields[{expected_time_index}].timeIndex",
        )
        model_time = _require_integer(
            field.get("modelTime"),
            f"fields[{expected_time_index}].modelTime",
        )
        if time_index != expected_time_index or model_time != expected_time_index:
            raise ValueError("Flow Field source times must be the ordered ordinals 0..N-1")
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
    return SourceDescriptor(
        dataset_id=_require_string(raw.get("datasetId"), "datasetId"),
        source_revision=_require_string(raw.get("sourceRevision"), "sourceRevision"),
        station_count=station_count,
        field_count=field_count,
        unit=raw["unit"],
        basis=raw["basis"],
        phase=raw["phase"],
        station_filename=_require_filename(station.get("file"), "station.file"),
        station_sha256=_require_sha256(station.get("sha256"), "station.sha256"),
        fields=tuple(fields),
        topology=read_topology_spec(raw.get("topology")),
        interpolation=read_interpolation_spec(raw.get("interpolation")),
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


def _aggregate_source_hash(descriptor: SourceDescriptor) -> str:
    facts = [
        descriptor.dataset_id,
        descriptor.source_revision,
        str(descriptor.station_count),
        str(descriptor.field_count),
        descriptor.station_sha256,
        *(
            f"{field.time_index}:{field.model_time}:{field.filename}:{field.sha256}"
            for field in descriptor.fields
        ),
        descriptor.unit,
        descriptor.basis,
        descriptor.phase,
    ]
    return hashlib.sha256("\n".join(facts).encode("utf-8")).hexdigest()


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
        source_hash=_aggregate_source_hash(descriptor),
    )
