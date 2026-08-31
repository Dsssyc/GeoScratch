from __future__ import annotations

import copy
from dataclasses import replace

import pytest

from geoscratch_flow_field_tiles.cog import build_velocity_cog_snapshot
from geoscratch_flow_field_tiles.cog_tiles import CogVelocityTileReader
from geoscratch_flow_field_tiles.resolution import StationSpacingResolution
from geoscratch_flow_field_tiles.runtime_manifest import (
    RUNTIME_ADAPTER_VERSION,
    RUNTIME_MATRICES,
    build_cog_runtime_manifest,
    build_cog_runtime_page_index,
    validate_cog_runtime_manifest,
)
from geoscratch_flow_field_tiles.source import (
    load_source_snapshot,
    read_source_descriptor,
)


def _resolution() -> StationSpacingResolution:
    return StationSpacingResolution(
        minimum_support_points=3,
        minimum_support_fraction=0.10,
        minimum_matrix=9,
        maximum_matrix=9,
    )


@pytest.fixture(scope="module")
def runtime_fixture(synthetic_source, tmp_path_factory):
    readers = {}
    for time_index in (0, 1):
        parent = tmp_path_factory.mktemp(f"flow-runtime-cog-t{time_index:02d}")
        built = build_velocity_cog_snapshot(
            synthetic_source.directory,
            parent / "cog-cache",
            time_index=time_index,
            descriptor_path=synthetic_source.descriptor_path,
            resolution=_resolution(),
        )
        readers[time_index] = CogVelocityTileReader(
            built.manifest_path,
            built.cog_path,
        )
    descriptor = read_source_descriptor(synthetic_source.descriptor_path)
    bounds = load_source_snapshot(
        synthetic_source.directory,
        time_index=0,
        descriptor_path=synthetic_source.descriptor_path,
    ).geographic_bounds
    quality = {
        "artifactRole": "reconstruction-prototype",
        "particleSimulation": "not-approved",
        "approvalReason": "inferred-topology-and-source-semantics-unapproved",
    }
    page_index = build_cog_runtime_page_index(descriptor, readers, bounds)
    manifest = build_cog_runtime_manifest(
        descriptor,
        "flow-cog-collection-synthetic-v1",
        page_index,
        quality,
    )
    return descriptor, bounds, readers, quality, page_index, manifest


def test_page_index_freezes_time_matrix_row_column_order_and_actual_bytes(runtime_fixture):
    _descriptor, _bounds, readers, _quality, page_index, _manifest = runtime_fixture
    addresses = [
        (
            page["timeIndex"],
            int(page["matrixId"]),
            page["tileRow"],
            page["tileCol"],
        )
        for page in page_index.pages
    ]

    assert page_index.matrices == RUNTIME_MATRICES
    assert addresses == sorted(addresses)
    assert len(addresses) == len(set(addresses))
    assert [limit["matrixId"] for limit in page_index.limits] == [
        str(matrix) for matrix in RUNTIME_MATRICES
    ]
    assert page_index.limits == (
        {"matrixId": "4", "minTileRow": 6, "maxTileRow": 6,
         "minTileCol": 13, "maxTileCol": 13},
        {"matrixId": "5", "minTileRow": 13, "maxTileRow": 13,
         "minTileCol": 26, "maxTileCol": 26},
        {"matrixId": "6", "minTileRow": 26, "maxTileRow": 26,
         "minTileCol": 53, "maxTileCol": 53},
        {"matrixId": "7", "minTileRow": 52, "maxTileRow": 52,
         "minTileCol": 106, "maxTileCol": 107},
        {"matrixId": "8", "minTileRow": 104, "maxTileRow": 104,
         "minTileCol": 213, "maxTileCol": 214},
        {"matrixId": "9", "minTileRow": 208, "maxTileRow": 208,
         "minTileCol": 427, "maxTileCol": 428},
    )
    assert page_index.page_set_sha256 == (
        "c34b1fc41ec12e9bd7d85b0e2312b5086cbbeabffc13f8a1e2a083ccaa7a4f66"
    )
    for page in (page_index.pages[0], page_index.pages[-1]):
        tile = readers[page["timeIndex"]].read_tile(
            page["matrixId"],
            page["tileRow"],
            page["tileCol"],
        )
        assert page["path"] == (
            f"tiles/WebMercatorQuad/t{page['timeIndex']:02d}/{page['matrixId']}/"
            f"{page['tileRow']}/{page['tileCol']}.rg32f"
        )
        assert page["byteLength"] == len(tile.content) == 524_288
        assert page["sha256"] == tile.sha256
        assert page["maximumSpeed"] == tile.maximum_speed


def test_page_index_is_deterministic_for_reader_mapping_order(runtime_fixture):
    descriptor, bounds, readers, _quality, page_index, _manifest = runtime_fixture
    reversed_readers = {1: readers[1], 0: readers[0]}

    rebuilt = build_cog_runtime_page_index(
        descriptor,
        reversed_readers,
        bounds,
    )

    assert rebuilt == page_index
    assert rebuilt.manifest() == page_index.manifest()


def test_subset_selection_preserves_original_descriptor_time_indices(runtime_fixture):
    descriptor, bounds, readers, quality, _page_index, _manifest = runtime_fixture
    subset = build_cog_runtime_page_index(descriptor, {1: readers[1]}, bounds)
    manifest = build_cog_runtime_manifest(
        descriptor,
        "flow-cog-collection-subset-t01-v1",
        subset,
        quality,
    )

    validate_cog_runtime_manifest(manifest)
    assert subset.time_indices == (1,)
    assert {page["timeIndex"] for page in subset.pages} == {1}
    assert [time["timeIndex"] for time in manifest["times"]] == [1]
    assert all("/t01/" in page["path"] for page in manifest["pages"])
    assert manifest["timeMaximumSpeeds"] == [
        {
            "timeIndex": 1,
            "pageMaximumSpeed": subset.time_maximum_speeds[0]["pageMaximumSpeed"],
        }
    ]


def test_runtime_manifest_is_a_schema_one_browser_superset(runtime_fixture):
    descriptor, _bounds, _readers, quality, page_index, manifest = runtime_fixture

    validate_cog_runtime_manifest(manifest)
    assert manifest["schemaVersion"] == 1
    assert manifest["contentVersion"] == "flow-cog-collection-synthetic-v1"
    assert manifest["stationCount"] == descriptor.station_count
    assert [time["timeIndex"] for time in manifest["times"]] == [0, 1]
    assert manifest["tileMatrixSet"]["minTileMatrix"] == "4"
    assert manifest["tileMatrixSet"]["maxTileMatrix"] == "9"
    assert manifest["tileMatrixSet"]["tileMatrixIds"] == [
        str(matrix) for matrix in RUNTIME_MATRICES
    ]
    assert manifest["encoding"] == {
        "channels": 2,
        "componentOrder": ["u", "v"],
        "sampleType": "float32-le",
        "layout": "rg-interleaved",
        "tileWidth": 256,
        "tileHeight": 256,
    }
    assert manifest["construction"] == {
        "algorithmVersion": RUNTIME_ADAPTER_VERSION,
        "adapterVersion": RUNTIME_ADAPTER_VERSION,
        "collectionContentVersion": "flow-cog-collection-synthetic-v1",
        "pageSetSha256": page_index.page_set_sha256,
        "sampleRegistration": "pixel-center",
        "levelConstruction": "cog-physical-or-global-semantic-recursive",
        "supportFilter": "recursive-conservative-vector-box-v1",
        "unsupportedVelocity": [0.0, 0.0],
        "quality": quality,
    }


@pytest.mark.parametrize(
    "mutation",
    (
        lambda manifest: manifest["pages"][0].update({"sha256": "0" * 64}),
        lambda manifest: manifest["pages"].__setitem__(
            slice(0, 2),
            [manifest["pages"][1], manifest["pages"][0]],
        ),
        lambda manifest: manifest["tileMatrixSet"]["limits"][0].update({
            "minTileRow": manifest["tileMatrixSet"]["limits"][0]["minTileRow"] + 1,
        }),
        lambda manifest: manifest["timeMaximumSpeeds"][0].update({
            "pageMaximumSpeed": 999.0,
        }),
        lambda manifest: manifest["construction"].update({
            "sampleRegistration": "global-texel-lattice",
        }),
    ),
)
def test_runtime_validator_rejects_page_structure_identity_and_summary_tampering(
    runtime_fixture,
    mutation,
):
    _descriptor, _bounds, _readers, _quality, _page_index, manifest = runtime_fixture
    changed = copy.deepcopy(manifest)
    mutation(changed)

    with pytest.raises(ValueError):
        validate_cog_runtime_manifest(changed)


def test_page_index_rejects_reader_selection_bounds_and_matrix_drift(runtime_fixture):
    descriptor, bounds, readers, _quality, _page_index, _manifest = runtime_fixture

    cases = (
        ({}, bounds, RUNTIME_MATRICES),
        ({0: readers[0], 1: readers[0]}, bounds, RUNTIME_MATRICES),
        (readers, (bounds[0], bounds[1], bounds[2] + 0.01, bounds[3]), RUNTIME_MATRICES),
        (readers, bounds, (5, 6, 7, 8, 9)),
    )
    for selected, selected_bounds, matrices in cases:
        with pytest.raises(ValueError):
            build_cog_runtime_page_index(
                descriptor,
                selected,
                selected_bounds,
                matrices,
            )


def test_manifest_build_rejects_descriptor_and_quality_drift(runtime_fixture):
    descriptor, _bounds, _readers, _quality, page_index, _manifest = runtime_fixture

    with pytest.raises(ValueError, match="quality"):
        build_cog_runtime_manifest(
            descriptor,
            "flow-cog-collection-synthetic-v1",
            page_index,
            {"particleSimulation": "not-approved"},
        )
    with pytest.raises(ValueError, match="another descriptor"):
        build_cog_runtime_manifest(
            replace(descriptor, dataset_id="another-dataset"),
            "flow-cog-collection-synthetic-v1",
            page_index,
            {
                "particleSimulation": "not-approved",
                "approvalReason": "unapproved",
            },
        )
