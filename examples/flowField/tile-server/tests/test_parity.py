from __future__ import annotations

import json
import math

import numpy as np

from geoscratch_flow_field_tiles.build import (
    MAX_TILE_MATRIX,
    TILE_SIZE,
    build_velocity_tiles,
)
from geoscratch_flow_field_tiles.interpolation import prepare_triangle_linear_stencil
from geoscratch_flow_field_tiles.topology import prepare_topology


WEB_MERCATOR_RADIUS = 6_378_137.0


def _texel_lon_lat(page: dict, texel_row: int, texel_col: int) -> tuple[float, float]:
    level = int(page["matrixId"])
    world_cells = (1 << level) * TILE_SIZE
    global_col = page["tileCol"] * TILE_SIZE + texel_col
    global_row = page["tileRow"] * TILE_SIZE + texel_row
    longitude = global_col / world_cells * 360.0 - 180.0
    mercator_y = math.pi * (1.0 - 2.0 * global_row / world_cells)
    latitude = math.degrees(math.atan(math.sinh(mercator_y)))
    return longitude, latitude


def _reference_velocity(
    point: tuple[float, float],
    topology,
    field: np.ndarray,
) -> np.ndarray:
    stencil = prepare_triangle_linear_stencil(
        topology,
        np.asarray([point[0]]),
        np.asarray([point[1]]),
    )
    return stencil.apply(topology, field)[0]


def test_finest_pages_match_float64_global_barycentric_reference(
    built_tiles,
    synthetic_source,
):
    manifest = json.loads(built_tiles.manifest_path.read_text(encoding="utf-8"))
    pages = [
        page for page in manifest["pages"]
        if page["timeIndex"] == 0 and int(page["matrixId"]) == MAX_TILE_MATRIX
    ]
    from geoscratch_flow_field_tiles.source import load_source_dataset
    dataset = load_source_dataset(
        synthetic_source.directory,
        descriptor_path=synthetic_source.descriptor_path,
    )
    topology = prepare_topology(dataset.stations, dataset.descriptor.topology)

    sampled = 0
    for page in pages:
        values = np.fromfile(
            built_tiles.output_directory / page["path"],
            dtype="<f4",
        ).reshape(TILE_SIZE, TILE_SIZE, 2)
        active = np.argwhere(np.linalg.norm(values.astype(np.float64), axis=2) > 0)
        for texel_row, texel_col in active[::max(1, len(active) // 7)][:7]:
            expected = _reference_velocity(
                _texel_lon_lat(page, int(texel_row), int(texel_col)),
                topology,
                dataset.fields[0],
            ).astype(np.float32)
            assert np.array_equal(values[texel_row, texel_col], expected)
            sampled += 1
    assert sampled >= 7


def test_unsupported_triangles_lower_to_zero_velocity_without_an_extra_plane(
    tmp_path,
):
    import hashlib
    stations = np.asarray([
        [120.0, 31.6], [120.1, 31.6], [120.1, 31.7], [120.0, 31.7],
    ], dtype="<f4")
    field = np.asarray([[1, 1], [2, 2], [3, 3], [4, 4]], dtype="<f4")
    source = tmp_path / "source"
    source.mkdir()
    station_payload = stations.tobytes()
    field_payload = field.tobytes()
    source.joinpath("station.bin").write_bytes(station_payload)
    source.joinpath("uv_0.bin").write_bytes(field_payload)
    descriptor = {
        "schemaVersion": 2,
        "datasetId": "unsupported-synthetic-flow",
        "sourceRevision": "synthetic-v1",
        "stationCount": 4,
        "fieldCount": 1,
        "topology": {
            "kind": "delaunay",
            "duplicatePolicy": "error",
            "localSpacingNeighbors": 8,
            "maximumEdgeRatio": None,
            "maximumEdgeLengthMeters": 2_000.0,
        },
        "interpolation": {
            "kind": "triangle-linear",
            "stationaryPolicy": "require-all-moving",
            "stationaryEpsilon": 0.0,
        },
        "unit": "legacy-flow-unit",
        "basis": "source-u-v",
        "phase": "unspecified",
        "station": {
            "file": "station.bin",
            "sha256": hashlib.sha256(station_payload).hexdigest(),
        },
        "fields": [{
            "timeIndex": 0,
            "modelTime": 0,
            "file": "uv_0.bin",
            "sha256": hashlib.sha256(field_payload).hexdigest(),
        }],
    }
    descriptor_path = source / "source-dataset.json"
    descriptor_path.write_text(json.dumps(descriptor), encoding="utf-8")
    result = build_velocity_tiles(
        source,
        tmp_path / "cache",
        descriptor_path=descriptor_path,
    )
    manifest = json.loads(result.manifest_path.read_text(encoding="utf-8"))

    assert all(
        not np.fromfile(result.output_directory / page["path"], dtype="<f4").any()
        for page in manifest["pages"]
    )
    assert manifest["encoding"]["channels"] == 2
