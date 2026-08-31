from __future__ import annotations

import hashlib
import json

import numpy as np
import pytest
import rasterio
from rasterio.windows import Window

from geoscratch_flow_field_tiles.cog import build_velocity_cog_snapshot
from geoscratch_flow_field_tiles.cog_overviews import reduce_semantic_overview_block
from geoscratch_flow_field_tiles.cog_tiles import (
    TILE_BYTE_LENGTH,
    CogVelocityTileReader,
    _ArrayLevel,
    _global_pixel_origin,
    _parse_manifest,
    _reduce_global_level,
    _validate_values,
)
from geoscratch_flow_field_tiles.resolution import StationSpacingResolution


def _test_resolution() -> StationSpacingResolution:
    return StationSpacingResolution(
        minimum_support_points=3,
        minimum_support_fraction=0.10,
        minimum_matrix=9,
        maximum_matrix=9,
    )


@pytest.fixture(scope="module")
def cog_reader_fixture(synthetic_source, tmp_path_factory):
    output = tmp_path_factory.mktemp("flow-cog-tile-reader") / "cog-cache"
    built = build_velocity_cog_snapshot(
        synthetic_source.directory,
        output,
        time_index=0,
        descriptor_path=synthetic_source.descriptor_path,
        resolution=_test_resolution(),
    )
    reader = CogVelocityTileReader(built.manifest_path, built.cog_path)
    manifest = json.loads(built.manifest_path.read_text(encoding="utf-8"))
    return built, reader, manifest


def _decode(content: bytes) -> np.ndarray:
    return np.frombuffer(content, dtype="<f4").reshape(256, 256, 2)


def _expected_physical_tile(cog_path, manifest, matrix, row, col):
    plan = manifest["construction"]["facts"]["plan"]
    grid = plan["grid"]
    base_matrix = int(grid["matrixId"])
    factor = 1 << (base_matrix - matrix)
    overview_index = None if factor == 1 else base_matrix - matrix - 1
    width = grid["width"] if factor == 1 else plan["overviewLevels"][overview_index]["width"]
    height = grid["height"] if factor == 1 else plan["overviewLevels"][overview_index]["height"]
    origin_col, origin_row = _global_pixel_origin(
        grid["tileLimits"]["minTileCol"],
        grid["tileLimits"]["minTileRow"],
        factor,
    )
    source_col = col * 256 - origin_col
    source_row = row * 256 - origin_row
    col_start = max(0, source_col)
    row_start = max(0, source_row)
    col_end = min(width, source_col + 256)
    row_end = min(height, source_row + 256)
    expected = np.zeros((256, 256, 2), dtype="<f4")
    if col_start < col_end and row_start < row_end:
        options = {} if overview_index is None else {"OVERVIEW_LEVEL": overview_index}
        with rasterio.open(cog_path, **options) as dataset:
            bands = dataset.read(
                (1, 2),
                window=Window(
                    col_start,
                    row_start,
                    col_end - col_start,
                    row_end - row_start,
                ),
                out_dtype="float32",
            )
        values = np.moveaxis(bands, 0, 2)
        destination_col = col_start - source_col
        destination_row = row_start - source_row
        expected[
            destination_row:destination_row + values.shape[0],
            destination_col:destination_col + values.shape[1],
        ] = values
    return expected


def test_base_and_physical_overview_are_exact_integer_windows(cog_reader_fixture):
    built, reader, manifest = cog_reader_fixture

    for matrix in (9, 8):
        min_row, _max_row, min_col, _max_col = reader.tile_limits(matrix)
        tile = reader.read_tile(str(matrix), min_row, min_col)
        actual = _decode(tile.content)
        expected = _expected_physical_tile(
            built.cog_path,
            manifest,
            matrix,
            min_row,
            min_col,
        )

        assert np.array_equal(actual, expected)
        assert len(tile.content) == TILE_BYTE_LENGTH
        assert tile.sha256 == hashlib.sha256(tile.content).hexdigest()
        assert tile.maximum_speed == pytest.approx(
            np.linalg.norm(expected.astype(np.float64), axis=2).max(initial=0.0)
        )


def test_physical_overview_partial_extent_is_canonical_positive_zero(cog_reader_fixture):
    _built, reader, _manifest = cog_reader_fixture
    tile = _decode(reader.read_tile("8", 104, 213).content)

    assert np.array_equal(tile[128:, :, :], np.zeros((128, 256, 2), dtype=np.float32))
    assert np.array_equal(tile[:, :128, :], np.zeros((256, 128, 2), dtype=np.float32))
    assert not np.signbit(tile[tile == 0.0]).any()


def test_adjacent_base_tiles_reconstruct_one_contiguous_cog_window(cog_reader_fixture):
    built, reader, _manifest = cog_reader_fixture
    left = _decode(reader.read_tile("9", 208, 427).content)
    right = _decode(reader.read_tile("9", 208, 428).content)

    with rasterio.open(built.cog_path) as dataset:
        expected = np.moveaxis(dataset.read((1, 2), out_dtype="float32"), 0, 2)

    assert np.array_equal(np.concatenate((left, right), axis=1), expected)


def _manual_lower_levels(cog_path, manifest):
    plan = manifest["construction"]["facts"]["plan"]
    grid = plan["grid"]
    base_matrix = int(grid["matrixId"])
    overview_index = len(plan["overviewLevels"]) - 1
    terminal = plan["overviewLevels"][overview_index]
    terminal_matrix = base_matrix - overview_index - 1
    factor = terminal["nominalFactor"]
    origin_col, origin_row = _global_pixel_origin(
        grid["tileLimits"]["minTileCol"],
        grid["tileLimits"]["minTileRow"],
        factor,
    )
    with rasterio.open(cog_path, OVERVIEW_LEVEL=overview_index) as dataset:
        values = np.moveaxis(dataset.read((1, 2), out_dtype="float32"), 0, 2)
    levels = {terminal_matrix: (origin_col, origin_row, values)}
    for matrix in range(terminal_matrix - 1, 3, -1):
        source_col, source_row, source = levels[matrix + 1]
        source_height, source_width, _channels = source.shape
        parent_col = source_col // 2
        parent_row = source_row // 2
        parent_col_end = (source_col + source_width + 1) // 2
        parent_row_end = (source_row + source_height + 1) // 2
        parent_width = parent_col_end - parent_col
        parent_height = parent_row_end - parent_row
        child_col = (parent_col - 1) * 2
        child_row = (parent_row - 1) * 2
        child = np.zeros(
            ((parent_height + 2) * 2, (parent_width + 2) * 2, 2),
            dtype="<f4",
        )
        destination_col = source_col - child_col
        destination_row = source_row - child_row
        child[
            destination_row:destination_row + source_height,
            destination_col:destination_col + source_width,
        ] = source
        reduced = reduce_semantic_overview_block(
            child,
            output_height=parent_height,
            output_width=parent_width,
        ).values
        levels[matrix] = (parent_col, parent_row, reduced)
    return levels


def _expected_array_tile(level, row, col):
    origin_col, origin_row, values = level
    expected = np.zeros((256, 256, 2), dtype="<f4")
    source_col = col * 256 - origin_col
    source_row = row * 256 - origin_row
    source_height, source_width, _channels = values.shape
    col_start = max(0, source_col)
    row_start = max(0, source_row)
    col_end = min(source_width, source_col + 256)
    row_end = min(source_height, source_row + 256)
    if col_start < col_end and row_start < row_end:
        destination_col = col_start - source_col
        destination_row = row_start - source_row
        expected[
            destination_row:destination_row + row_end - row_start,
            destination_col:destination_col + col_end - col_start,
        ] = values[row_start:row_end, col_start:col_end]
    return expected


def test_z4_and_z5_use_global_wmq_recursive_semantic_reduction(cog_reader_fixture):
    built, reader, manifest = cog_reader_fixture
    expected_levels = _manual_lower_levels(built.cog_path, manifest)

    for matrix in (5, 4):
        min_row, _max_row, min_col, _max_col = reader.tile_limits(matrix)
        actual = _decode(reader.read_tile(matrix, min_row, min_col).content)
        expected = _expected_array_tile(expected_levels[matrix], min_row, min_col)

        assert np.array_equal(actual, expected)
        assert np.isfinite(actual).all()
        assert not np.signbit(actual[actual == 0.0]).any()


def test_terminal_nominal_factor_is_the_global_address_authority():
    assert _global_pixel_origin(27_310, 13_278, 512) == (13_655, 6_639)
    with pytest.raises(ValueError, match="not aligned"):
        _global_pixel_origin(27_311, 13_279, 512)


def test_unaligned_terminal_ifd_is_not_address_authority_and_z6_is_derived_globally(
    tmp_path,
):
    cog_path = tmp_path / "flow-t00.cog.tif"
    cog_path.write_bytes(b"test")
    overview_levels = []
    width = 512
    height = 512
    for index in range(9):
        width = (width + 1) // 2
        height = (height + 1) // 2
        overview_levels.append({
            "index": index,
            "nominalFactor": 1 << (index + 1),
            "width": width,
            "height": height,
        })
    facts = {
        "source": {
            "geographicBounds": [120.0, 31.0, 120.1, 31.1],
        },
        "snapshot": {"timeIndex": 0},
        "plan": {
            "grid": {
                "matrixId": "15",
                "width": 512,
                "height": 512,
                "sampleRegistration": "pixel-center",
                "tileLimits": {
                    "minTileRow": 13_279,
                    "maxTileRow": 13_280,
                    "minTileCol": 27_311,
                    "maxTileCol": 27_312,
                },
            },
            "overviewLevels": overview_levels,
        },
        "encoding": {
            "bands": 2,
            "sampleType": "float32",
            "componentOrder": ["u", "v"],
            "overviewPolicy": {"kind": "recursive-conservative-vector-box-v1"},
        },
        "cog": {"path": cog_path.name, "sizeBytes": cog_path.stat().st_size},
    }
    manifest = {
        "schemaVersion": 2,
        "artifactType": "flow-field-cog-snapshot",
        "construction": {
            "facts": facts,
            "sha256": hashlib.sha256(
                json.dumps(facts, sort_keys=True, separators=(",", ":")).encode(
                    "utf-8"
                )
            ).hexdigest(),
        },
    }

    parsed = _parse_manifest(manifest, cog_path)

    assert min(parsed["physical_levels"]) == 7
    assert 6 not in parsed["physical_levels"]
    assert len(parsed["overview_shapes"]) == 9
    source = _ArrayLevel(
        matrix=7,
        global_col=27_311,
        global_row=13_279,
        values=np.broadcast_to(
            np.asarray([1.0, 2.0], dtype="<f4"),
            (8, 8, 2),
        ).copy(),
    )
    derived = _reduce_global_level(source, 6)
    assert (derived.global_col, derived.global_row) == (13_655, 6_639)
    assert derived.values.shape == (5, 5, 2)
    assert np.array_equal(derived.values[2, 2], np.asarray([1.0, 2.0], dtype="<f4"))


def test_reader_rejects_matrices_and_coordinates_outside_coverage(cog_reader_fixture):
    _built, reader, _manifest = cog_reader_fixture

    for request in (
        (3, 6, 13),
        (10, 208, 427),
        (9, 207, 427),
        (9, 208, 426),
    ):
        with pytest.raises(KeyError):
            reader.read_tile(*request)
    with pytest.raises(TypeError):
        reader.read_tile("09", 208, 427)
    with pytest.raises(TypeError):
        reader.read_tile("9", True, 427)


def test_value_validation_rejects_nonfinite_and_negative_zero():
    nonfinite = np.zeros((1, 1, 2), dtype=np.float32)
    nonfinite[0, 0, 0] = np.nan
    with pytest.raises(ValueError, match="non-finite"):
        _validate_values(nonfinite, "test")

    negative_zero = np.zeros((1, 1, 2), dtype=np.float32)
    negative_zero[0, 0, 1] = np.float32(-0.0)
    with pytest.raises(ValueError, match="negative zero"):
        _validate_values(negative_zero, "test")
