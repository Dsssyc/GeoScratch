from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pytest


@dataclass(frozen=True)
class SyntheticSource:
    directory: Path
    descriptor_path: Path
    stations: np.ndarray
    fields: tuple[np.ndarray, ...]


def _write_float32_pairs(path: Path, values: np.ndarray) -> str:
    payload = np.asarray(values, dtype="<f4").tobytes(order="C")
    path.write_bytes(payload)
    return hashlib.sha256(payload).hexdigest()


@pytest.fixture(scope="session")
def synthetic_source(tmp_path_factory: pytest.TempPathFactory) -> SyntheticSource:
    directory = tmp_path_factory.mktemp("flow-field-source")
    # 120.9375 is an exact z9 tile-column edge. The fixture therefore proves that
    # one global topology is sampled consistently on both adjacent pages.
    stations = np.asarray([
        [120.9275, 31.6900],
        [120.9475, 31.6900],
        [120.9475, 31.7100],
        [120.9275, 31.7100],
    ], dtype=np.float64)
    fields = (
        np.asarray([[1, 2], [3, 4], [5, 6], [7, 8]], dtype=np.float32),
        np.asarray([[-2, 1], [0, 3], [2, 5], [4, 7]], dtype=np.float32),
    )
    station_hash = _write_float32_pairs(directory / "station.bin", stations)
    field_records = []
    for time_index, values in enumerate(fields):
        filename = f"uv_{time_index}.bin"
        field_records.append({
            "timeIndex": time_index,
            "modelTime": time_index,
            "file": filename,
            "sha256": _write_float32_pairs(directory / filename, values),
        })
    descriptor = {
        "schemaVersion": 2,
        "datasetId": "synthetic-flow-field",
        "sourceRevision": "synthetic-v1",
        "stationCount": 4,
        "fieldCount": len(fields),
        "topology": {
            "kind": "delaunay",
            "duplicatePolicy": "error",
            "localSpacingNeighbors": 8,
            "maximumEdgeRatio": None,
            "maximumEdgeLengthMeters": None,
        },
        "interpolation": {
            "kind": "triangle-linear",
            "stationaryPolicy": "require-all-moving",
            "stationaryEpsilon": 0.0,
        },
        "unit": "legacy-flow-unit",
        "basis": "source-u-v",
        "phase": "unspecified",
        "station": {"file": "station.bin", "sha256": station_hash},
        "fields": field_records,
    }
    descriptor_path = directory / "source-dataset.json"
    descriptor_path.write_text(
        json.dumps(descriptor, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    return SyntheticSource(directory, descriptor_path, stations, fields)


@pytest.fixture(scope="session")
def built_tiles(
    synthetic_source: SyntheticSource,
    tmp_path_factory: pytest.TempPathFactory,
):
    from geoscratch_flow_field_tiles.build import build_velocity_tiles

    output_directory = tmp_path_factory.mktemp("flow-field-build-parent") / "cache"
    return build_velocity_tiles(
        synthetic_source.directory,
        output_directory,
        descriptor_path=synthetic_source.descriptor_path,
    )
