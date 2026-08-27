from __future__ import annotations

import hashlib
import json
from pathlib import Path

import numpy as np
import pytest

from geoscratch_flow_field_tiles import BuildBudget, TriangleLinearInterpolation
from geoscratch_flow_field_tiles.build import (
    MAX_TILE_MATRIX,
    MIN_TILE_MATRIX,
    PAGE_BYTE_LENGTH,
    TILE_SIZE,
    _render_page,
    _runtime_covered_texel_bounds,
    _texel_lattice,
    _texel_lattice_window,
    build_velocity_tiles,
    validate_artifact_manifest,
    verify_existing_tiles,
)


def _page_path(output_directory: Path, page: dict) -> Path:
    return output_directory / page["path"]


def test_manifest_is_velocity_only_standard_web_mercator_quad(built_tiles):
    manifest = json.loads(built_tiles.manifest_path.read_text(encoding="utf-8"))
    marker = json.loads(
        built_tiles.output_directory.joinpath(".flow-field-artifact.json").read_text(
            encoding="utf-8"
        )
    )

    assert manifest["schemaVersion"] == 1
    assert marker == {
        "kind": "geoscratch-flow-field-artifact",
        "contentVersion": manifest["contentVersion"],
    }
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
    assert manifest["construction"]["algorithmVersion"] == "flow-rg32f-wmq-v4"
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
    assert manifest["construction"]["supportFilter"] == "bilinear-safe-erosion-1"
    assert len(manifest["construction"]["pageSetSha256"]) == 64
    quality = manifest["construction"]["quality"]
    assert quality["finestMatrixId"] == str(MAX_TILE_MATRIX)
    assert quality["particleSimulation"] == "not-approved"
    assert quality["approvalReason"] == "resolution-error-budget-unset"
    assert quality["runtimeSampling"] == "global-lattice-bilinear"
    assert quality["supportFilter"] == "bilinear-safe-erosion-1"
    assert len(quality["levelSupport"]) == (
        (MAX_TILE_MATRIX - MIN_TILE_MATRIX + 1) * 2
    )
    assert [
        (record["matrixId"], record["timeIndex"])
        for record in quality["stationReconstruction"]
    ] == [
        (str(level), time_index)
        for level in range(MIN_TILE_MATRIX, MAX_TILE_MATRIX + 1)
        for time_index in range(2)
    ]
    assert all(
        record["topologyVertexCount"] == 4
        and record["velocityRmse"] >= 0
        and record["maximumVelocityError"] >= 0
        and record["stationaryFalseMovingCount"] == 0
        for record in quality["stationReconstruction"]
    )
    assert manifest["contentVersion"].endswith("-v4")


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


def test_programmatic_interpolation_configuration_enters_content_identity(
    built_tiles,
    synthetic_source,
    tmp_path,
):
    configured = build_velocity_tiles(
        synthetic_source.directory,
        tmp_path / "cache",
        descriptor_path=synthetic_source.descriptor_path,
        interpolation=TriangleLinearInterpolation(stationary_epsilon=0.5),
    )
    manifest = json.loads(configured.manifest_path.read_text(encoding="utf-8"))

    assert manifest["construction"]["interpolation"]["stationaryEpsilon"] == 0.5
    assert manifest["construction"]["quality"]["stationReconstruction"][0][
        "stationaryEpsilon"
    ] == 0.5
    assert configured.content_version != built_tiles.content_version
    assert verify_existing_tiles(configured.output_directory)["contentVersion"] == (
        configured.content_version
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
    assert len(facts["pageSetSha256"]) == 64
    assert facts["finestStationaryFalseMovingCount"] >= 0
    assert facts["finestMovingCollapsedCount"] >= 0
    assert facts["particleSimulation"] == "not-approved"


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


@pytest.mark.parametrize(
    "mutate",
    (
        lambda manifest: manifest["pages"].pop(),
        lambda manifest: manifest["pages"].reverse(),
        lambda manifest: manifest["encoding"].update({"channels": 3}),
        lambda manifest: manifest["tileMatrixSet"]["limits"][0].update({
            "maxTileCol": 999,
        }),
        lambda manifest: manifest["budgets"].update({"timePageCount": 1}),
        lambda manifest: manifest["pages"][0].update({"sha256": "0" * 64}),
        lambda manifest: manifest["pages"][0].update({"maximumSpeed": 999.0}),
        lambda manifest: manifest.update({"maximumSpeed": 1.0e30}),
        lambda manifest: manifest.update({"timeMaximumSpeeds": []}),
        lambda manifest: manifest["projectedBounds"].update({
            "bounds": [0.0, 0.0, 1.0, 1.0],
        }),
        lambda manifest: manifest.update({
            "stationCount": manifest["stationCount"] + 1,
        }),
        lambda manifest: manifest["times"][0].update({"phase": "changed"}),
        lambda manifest: manifest.update({"source": []}),
        lambda manifest: manifest["construction"]["quality"][
            "stationReconstruction"
        ][0].update({"stationaryFalseMovingCount": 10**9}),
    ),
)
def test_manifest_validation_rejects_incomplete_or_mutated_page_products(
    built_tiles,
    mutate,
):
    manifest = json.loads(built_tiles.manifest_path.read_text(encoding="utf-8"))
    mutate(manifest)

    with pytest.raises(ValueError):
        validate_artifact_manifest(manifest)


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


def test_lattice_halo_clamps_at_webmercator_world_edges():
    west_longitude, north_latitude = _texel_lattice_window(4, 0, 0, padding=1)
    east_longitude, south_latitude = _texel_lattice_window(4, 15, 15, padding=1)

    assert west_longitude.min() == -180.0
    assert east_longitude.max() < 180.0
    assert np.isfinite(north_latitude).all()
    assert np.isfinite(south_latitude).all()


def test_runtime_coverage_clamp_uses_the_declared_half_texel_outer_policy():
    level = 9
    world_cells = (1 << level) * TILE_SIZE
    east_global = 100 * TILE_SIZE + 255.2
    south_global = 80 * TILE_SIZE + 255.7
    east = east_global / world_cells * 360.0 - 180.0
    south_mercator = np.pi * (1.0 - 2.0 * south_global / world_cells)
    south = np.degrees(np.arctan(np.sinh(south_mercator)))

    _minimum_x, _minimum_y, maximum_x, maximum_y = _runtime_covered_texel_bounds(
        (east - 0.001, south, east, south + 0.001),
        level,
    )

    assert maximum_x == int(np.floor(east_global - 0.5))
    assert maximum_y == int(np.floor(south_global - 0.5))


def test_bilinear_safe_filter_erodes_all_lattice_nodes_around_invalid_support():
    side = TILE_SIZE + 2
    raw_support = np.ones((side, side), dtype=bool)
    raw_support[129, 129] = False

    class StubStencil:
        target_count = side * side

        @staticmethod
        def apply_unique_with_support(_field):
            values = np.ones((side * side, 2), dtype="<f4")
            return values, raw_support.reshape(-1)

    rendered = _render_page(StubStencil(), np.ones((1, 2)))

    assert rendered.raw_advectable_count == TILE_SIZE * TILE_SIZE - 1
    assert rendered.bilinear_safe_count == TILE_SIZE * TILE_SIZE - 9
    assert np.array_equal(rendered.values[127:130, 127:130], np.zeros((3, 3, 2)))
    assert np.array_equal(rendered.values[0, 0], np.ones(2))


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


def test_builder_rejects_a_symlink_output_without_touching_its_target(
    synthetic_source,
    tmp_path,
):
    target = tmp_path / "target"
    target.mkdir()
    sentinel = target / "keep.txt"
    sentinel.write_text("keep", encoding="utf-8")
    output = tmp_path / "cache"
    output.symlink_to(target, target_is_directory=True)

    with pytest.raises(ValueError, match="symbolic link"):
        build_velocity_tiles(
            synthetic_source.directory,
            output,
            descriptor_path=synthetic_source.descriptor_path,
        )

    assert sentinel.read_text(encoding="utf-8") == "keep"


def test_builder_resolves_a_symlinked_parent_without_losing_leaf_safety(
    synthetic_source,
    tmp_path,
):
    target = tmp_path / "target-parent"
    target.mkdir()
    alias = tmp_path / "alias-parent"
    alias.symlink_to(target, target_is_directory=True)

    result = build_velocity_tiles(
        synthetic_source.directory,
        alias / "cache",
        descriptor_path=synthetic_source.descriptor_path,
    )

    assert result.output_directory == target.resolve() / "cache"
    assert result.manifest_path.is_file()


def test_builder_refuses_to_replace_an_unowned_cache_directory(
    synthetic_source,
    tmp_path,
):
    output = tmp_path / "cache"
    output.mkdir()
    sentinel = output / "keep.txt"
    sentinel.write_text("keep", encoding="utf-8")

    with pytest.raises(ValueError, match="non-artifact"):
        build_velocity_tiles(
            synthetic_source.directory,
            output,
            descriptor_path=synthetic_source.descriptor_path,
        )

    assert sentinel.read_text(encoding="utf-8") == "keep"


def test_builder_rejects_an_over_budget_plan_before_topology_preparation(
    synthetic_source,
    tmp_path,
    monkeypatch,
):
    import geoscratch_flow_field_tiles.build as build_module

    def unexpected_topology(*_args, **_kwargs):
        raise AssertionError("topology preparation ran before the budget gate")

    monkeypatch.setattr(build_module, "prepare_topology", unexpected_topology)
    with pytest.raises(ValueError, match="spatial page budget"):
        build_velocity_tiles(
            synthetic_source.directory,
            tmp_path / "cache",
            descriptor_path=synthetic_source.descriptor_path,
            budget=BuildBudget(max_spatial_pages=1),
        )


@pytest.mark.parametrize(
    "arguments",
    (
        {"max_spatial_pages": 0},
        {"max_raw_page_bytes": 0},
        {"minimum_free_bytes": 0},
    ),
)
def test_build_budget_validates_positive_integer_limits(arguments):
    with pytest.raises(ValueError):
        BuildBudget(**arguments)
