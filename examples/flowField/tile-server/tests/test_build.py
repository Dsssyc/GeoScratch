from __future__ import annotations

import hashlib
import json
from pathlib import Path

import numpy as np
import pytest

from geoscratch_flow_field_tiles.build import (
    MAX_TILE_MATRIX,
    MIN_TILE_MATRIX,
    PAGE_BYTE_LENGTH,
    TILE_SIZE,
    _texel_lattice,
    build_velocity_tiles,
    verify_existing_tiles,
)


def _page_path(output_directory: Path, page: dict) -> Path:
    return output_directory / page["path"]


def test_manifest_is_velocity_only_standard_web_mercator_quad(built_tiles):
    manifest = json.loads(built_tiles.manifest_path.read_text(encoding="utf-8"))

    assert manifest["schemaVersion"] == 1
    assert manifest["tileMatrixSet"]["id"] == "WebMercatorQuad"
    assert manifest["tileMatrixSet"]["cornerOfOrigin"] == "topLeft"
    assert manifest["tileMatrixSet"]["tileRowDirection"] == "south"
    assert manifest["tileMatrixSet"]["tileColDirection"] == "east"
    assert manifest["tileMatrixSet"]["tileMatrixIds"] == [
        str(level) for level in range(MIN_TILE_MATRIX, MAX_TILE_MATRIX + 1)
    ]
    assert manifest["encoding"] == {
        "channels": 2,
        "componentOrder": ["u", "v"],
        "sampleType": "float32-le",
        "layout": "rg-interleaved",
        "tileWidth": 256,
        "tileHeight": 256,
    }
    assert manifest["unit"] == "legacy-flow-unit"
    assert manifest["basis"] == "source-u-v"
    assert manifest["source"]["crs"] == "EPSG:4326"
    assert manifest["stationCount"] == 4
    assert [time["timeIndex"] for time in manifest["times"]] == [0, 1]
    assert [time["modelTime"] for time in manifest["times"]] == [0, 1]
    assert all(time["unit"] == "ordinal" for time in manifest["times"])
    assert all(time["phase"] == "unspecified" for time in manifest["times"])
    assert not any(word in json.dumps(manifest).lower() for word in (
        "boundary", "depth", "wet", "sdf", "vector-feature",
    ))
    assert manifest["construction"]["algorithmVersion"] == "flow-rg32f-wmq-v3"
    topology = manifest["construction"]["topology"]
    assert {
        "requested": topology["requested"],
        "resolved": topology["resolved"],
        "inferred": topology["inferred"],
    } == {
        "requested": "delaunay",
        "resolved": "delaunay",
        "inferred": True,
    }
    assert manifest["construction"]["interpolation"]["resolved"] == (
        "triangle-linear"
    )
    assert manifest["construction"]["interpolation"]["stationaryPolicy"] == (
        "require-all-moving"
    )
    quality = manifest["construction"]["quality"]
    assert quality["finestMatrixId"] == str(MAX_TILE_MATRIX)
    assert quality["runtimeSampling"] == "global-lattice-bilinear"
    assert [record["timeIndex"] for record in quality["stationReconstruction"]] == [
        0,
        1,
    ]
    assert all(
        record["topologyVertexCount"] == 4
        and record["velocityRmse"] >= 0
        and record["maximumVelocityError"] >= 0
        and record["stationaryFalseMovingCount"] == 0
        for record in quality["stationReconstruction"]
    )
    assert manifest["contentVersion"].endswith("-v3")


def test_every_page_has_exact_little_endian_rg32f_bytes_and_hash(built_tiles):
    manifest = json.loads(built_tiles.manifest_path.read_text(encoding="utf-8"))
    expected_order = sorted(
        manifest["pages"],
        key=lambda page: (
            page["timeIndex"],
            int(page["matrixId"]),
            page["tileRow"],
            page["tileCol"],
        ),
    )

    assert manifest["pages"] == expected_order
    assert manifest["budgets"]["timePageCount"] == len(manifest["pages"])
    assert manifest["budgets"]["totalRawPageBytes"] == (
        len(manifest["pages"]) * PAGE_BYTE_LENGTH
    )
    for page in manifest["pages"]:
        path = _page_path(built_tiles.output_directory, page)
        payload = path.read_bytes()
        values = np.frombuffer(payload, dtype="<f4")
        assert page["path"] == (
            "tiles/WebMercatorQuad/"
            f"t{page['timeIndex']:02d}/{page['matrixId']}/"
            f"{page['tileRow']}/{page['tileCol']}.rg32f"
        )
        assert path.stat().st_size == TILE_SIZE * TILE_SIZE * 2 * 4
        assert page["byteLength"] == PAGE_BYTE_LENGTH
        assert values.shape == (TILE_SIZE * TILE_SIZE * 2,)
        assert np.isfinite(values).all()
        assert hashlib.sha256(payload).hexdigest() == page["sha256"]
        assert page["maximumSpeed"] >= 0


def test_repeated_builds_have_identical_manifest_and_page_bytes(
    built_tiles,
    synthetic_source,
    tmp_path,
):
    rebuilt = build_velocity_tiles(
        synthetic_source.directory,
        tmp_path / "cache",
        descriptor_path=synthetic_source.descriptor_path,
    )
    assert rebuilt.manifest_path.read_bytes() == built_tiles.manifest_path.read_bytes()
    first_manifest = json.loads(built_tiles.manifest_path.read_text(encoding="utf-8"))
    for page in first_manifest["pages"]:
        assert _page_path(rebuilt.output_directory, page).read_bytes() == (
            _page_path(built_tiles.output_directory, page).read_bytes()
        )


def test_every_level_is_directly_mapped_from_the_prepared_topology(built_tiles):
    manifest = json.loads(built_tiles.manifest_path.read_text(encoding="utf-8"))
    construction = manifest["construction"]
    mapping = construction["mapping"]

    assert construction["levelConstruction"] == "direct"
    assert construction["sampleRegistration"] == "global-texel-lattice"
    assert [entry["matrixId"] for entry in mapping] == [
        str(level) for level in range(MIN_TILE_MATRIX, MAX_TILE_MATRIX + 1)
    ]
    assert sum(entry["pageCount"] for entry in mapping) == (
        manifest["budgets"]["spatialPageCount"]
    )
    assert all(
        entry["targetCount"] == entry["pageCount"] * TILE_SIZE * TILE_SIZE
        for entry in mapping
    )


def test_existing_artifact_verification_recomputes_every_page_hash(built_tiles):
    facts = verify_existing_tiles(built_tiles.output_directory)

    assert facts["pageCount"] == built_tiles.page_count
    assert facts["totalRawPageBytes"] == built_tiles.total_raw_page_bytes
    assert facts["contentVersion"] == built_tiles.content_version


def test_existing_artifact_verification_rejects_stale_construction_contract(
    built_tiles,
    tmp_path,
):
    output = tmp_path / "cache"
    output.mkdir()
    manifest = json.loads(built_tiles.manifest_path.read_text(encoding="utf-8"))
    manifest["construction"]["sampleRegistration"] = "texel-center"
    output.joinpath("manifest.json").write_text(json.dumps(manifest), encoding="utf-8")

    with pytest.raises(ValueError, match="construction contract"):
        verify_existing_tiles(output)


def test_global_texel_lattice_is_continuous_across_adjacent_pages():
    left_longitude, left_latitude = _texel_lattice(9, 208, 426)
    right_longitude, right_latitude = _texel_lattice(9, 208, 427)
    south_longitude, south_latitude = _texel_lattice(9, 209, 426)
    longitude_step = left_longitude[1] - left_longitude[0]

    assert right_longitude[0] == pytest.approx(
        left_longitude[TILE_SIZE - 1] + longitude_step
    )
    assert right_latitude[0] == left_latitude[0]
    assert south_longitude[0] == left_longitude[0]
    assert south_latitude[0] < left_latitude[(TILE_SIZE - 1) * TILE_SIZE]


def test_builder_rejects_a_non_cache_output_before_source_processing(
    synthetic_source,
    tmp_path,
):
    with pytest.raises(ValueError, match="explicit cache directory"):
        build_velocity_tiles(
            synthetic_source.directory,
            tmp_path / "workspace",
            descriptor_path=synthetic_source.descriptor_path,
        )
