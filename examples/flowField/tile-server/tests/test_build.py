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
    _downsample_parent,
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


def test_coarse_pages_are_component_wise_two_by_two_child_averages(built_tiles):
    manifest = json.loads(built_tiles.manifest_path.read_text(encoding="utf-8"))
    pages = {
        (page["timeIndex"], int(page["matrixId"]), page["tileRow"], page["tileCol"]): page
        for page in manifest["pages"]
    }
    parent = next(page for page in manifest["pages"] if page["timeIndex"] == 0)
    level = int(parent["matrixId"])
    parent_key = (0, level, parent["tileRow"], parent["tileCol"])
    composite = np.zeros((TILE_SIZE * 2, TILE_SIZE * 2, 2), dtype=np.float64)
    for child_y in range(2):
        for child_x in range(2):
            child_key = (
                0,
                level + 1,
                parent["tileRow"] * 2 + child_y,
                parent["tileCol"] * 2 + child_x,
            )
            child = pages.get(child_key)
            if child is None:
                continue
            values = np.fromfile(
                _page_path(built_tiles.output_directory, child),
                dtype="<f4",
            ).reshape(TILE_SIZE, TILE_SIZE, 2)
            row = child_y * TILE_SIZE
            col = child_x * TILE_SIZE
            composite[row:row + TILE_SIZE, col:col + TILE_SIZE] = values
    expected = composite.reshape(TILE_SIZE, 2, TILE_SIZE, 2, 2).mean(
        axis=(1, 3),
        dtype=np.float64,
    ).astype("<f4")
    actual = np.fromfile(
        _page_path(built_tiles.output_directory, pages[parent_key]),
        dtype="<f4",
    ).reshape(TILE_SIZE, TILE_SIZE, 2)
    assert np.array_equal(actual, expected)


def test_existing_artifact_verification_recomputes_every_page_hash(built_tiles):
    facts = verify_existing_tiles(built_tiles.output_directory)

    assert facts["pageCount"] == built_tiles.page_count
    assert facts["totalRawPageBytes"] == built_tiles.total_raw_page_bytes
    assert facts["contentVersion"] == built_tiles.content_version


def test_downsampling_rejects_a_missing_child_inside_declared_coverage(tmp_path):
    child_limit = {
        "matrixId": "9",
        "minTileRow": 20,
        "maxTileRow": 20,
        "minTileCol": 40,
        "maxTileCol": 40,
    }

    with pytest.raises(RuntimeError, match="Covered RG32F child page is missing"):
        _downsample_parent(
            tmp_path,
            time_index=0,
            child_level=9,
            parent_row=10,
            parent_col=20,
            child_limit=child_limit,
        )


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
