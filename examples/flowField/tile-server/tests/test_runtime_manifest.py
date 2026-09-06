from __future__ import annotations

import copy
from dataclasses import replace

import pytest

from geoscratch_flow_field_tiles.cog import build_velocity_cog_snapshot
from geoscratch_flow_field_tiles.cog_tiles import CogVelocityTileReader
from geoscratch_flow_field_tiles.cog_overviews import (
    LEGACY_SEMANTIC_OVERVIEW_POLICY,
    SEMANTIC_OVERVIEW_POLICY,
)
from geoscratch_flow_field_tiles.resolution import (
    FixedWebMercatorResolution,
    StationSpacingResolution,
)
from geoscratch_flow_field_tiles.runtime_manifest import (
    FLOW_RG32F_MEDIA_TYPE,
    LEGACY_RUNTIME_ADAPTER_VERSION,
    RUNTIME_ADAPTER_VERSION,
    RUNTIME_MAXIMUM_MATRIX_CAP,
    RUNTIME_MINIMUM_MATRIX,
    _sample_adjacency,
    build_cog_runtime_manifest,
    build_cog_runtime_page_index,
    runtime_matrices_for_source_ceiling,
    runtime_adapter_version_for_snapshot_schema,
    runtime_support_filter,
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
    page_index = build_cog_runtime_page_index(
        descriptor,
        readers,
        bounds,
        source_ceiling_matrix=9,
    )
    manifest = build_cog_runtime_manifest(
        descriptor,
        "flow-cog-collection-synthetic-v3",
        page_index,
        quality,
        source_ceiling_selection_relation="statistically-selected",
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

    runtime_matrices = runtime_matrices_for_source_ceiling(9)
    assert page_index.source_ceiling_matrix == 9
    assert page_index.manifest()["sourceCeilingMatrixId"] == "9"
    assert page_index.matrices == runtime_matrices
    assert addresses == sorted(addresses)
    assert len(addresses) == len(set(addresses))
    assert [limit["matrixId"] for limit in page_index.limits] == [
        str(matrix) for matrix in runtime_matrices
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
        "2672cd0c08d07fe6298394802abce03f3a49b630ff8fd794ea324954a7a082fa"
    )
    for page in (page_index.pages[0], page_index.pages[-1]):
        tile = readers[page["timeIndex"]].read_tile(
            page["matrixId"],
            page["tileRow"],
            page["tileCol"],
        )
        assert page["path"] == (
            f"tiles/WebMercatorQuad/{page['sampleKey']}/{page['matrixId']}/"
            f"{page['tileRow']}/{page['tileCol']}.rg32f"
        )
        assert page["sampleKey"] == f"t{page['timeIndex']:02d}"
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
        source_ceiling_matrix=9,
    )

    assert rebuilt == page_index
    assert rebuilt.manifest() == page_index.manifest()


def test_subset_selection_preserves_original_descriptor_time_indices(runtime_fixture):
    descriptor, bounds, readers, quality, _page_index, _manifest = runtime_fixture
    subset = build_cog_runtime_page_index(
        descriptor,
        {1: readers[1]},
        bounds,
        source_ceiling_matrix=9,
    )
    manifest = build_cog_runtime_manifest(
        descriptor,
        "flow-cog-collection-subset-t01-v2",
        subset,
        quality,
        source_ceiling_selection_relation="statistically-selected",
    )

    validate_cog_runtime_manifest(manifest)
    assert subset.time_indices == (1,)
    assert {page["timeIndex"] for page in subset.pages} == {1}
    assert {page["sampleKey"] for page in subset.pages} == {"t01"}
    assert [time["timeIndex"] for time in manifest["times"]] == [1]
    assert [time["sampleKey"] for time in manifest["times"]] == ["t01"]
    assert manifest["temporal"] == {
        "coverage": "subset",
        "sourceSampleCount": 2,
        "sampleAdjacency": [],
    }
    assert all("/t01/" in page["path"] for page in manifest["pages"])
    assert manifest["timeMaximumSpeeds"] == [
        {
            "sampleKey": "t01",
            "timeIndex": 1,
            "pageMaximumSpeed": subset.time_maximum_speeds[0]["pageMaximumSpeed"],
        }
    ]


def test_runtime_manifest_is_a_schema_two_browser_contract(runtime_fixture):
    descriptor, _bounds, _readers, quality, page_index, manifest = runtime_fixture

    validate_cog_runtime_manifest(manifest)
    assert manifest["schemaVersion"] == 2
    assert manifest["contentVersion"] == "flow-cog-collection-synthetic-v3"
    assert page_index.adapter_version == RUNTIME_ADAPTER_VERSION
    assert page_index.manifest()["adapterVersion"] == RUNTIME_ADAPTER_VERSION
    assert manifest["stationCount"] == descriptor.station_count
    assert manifest["authority"] == descriptor.authority.manifest()
    assert [time["sampleKey"] for time in manifest["times"]] == ["t00", "t01"]
    assert [time["timeIndex"] for time in manifest["times"]] == [0, 1]
    assert manifest["temporal"] == {
        "coverage": "full",
        "sourceSampleCount": 2,
        "sampleAdjacency": [{
            "lowerSampleKey": "t00",
            "upperSampleKey": "t01",
            "kind": "interpolable",
            "interpolation": "component-wise-linear",
        }],
    }
    assert manifest["sourceCeiling"] == {
        "tileMatrixSetId": "WebMercatorQuad",
        "matrixId": "9",
        "selectionRelation": "statistically-selected",
    }
    assert manifest["tileMatrixSet"]["minTileMatrix"] == "4"
    assert manifest["tileMatrixSet"]["maxTileMatrix"] == "9"
    assert manifest["tileMatrixSet"]["tileMatrixIds"] == [
        str(matrix) for matrix in runtime_matrices_for_source_ceiling(9)
    ]
    assert manifest["representation"] == {
        "mediaType": FLOW_RG32F_MEDIA_TYPE,
        "fieldKind": "vector",
        "channels": 2,
        "componentOrder": ["u", "v"],
        "sampleType": "float32-le",
        "layout": "rg-interleaved",
        "sampleRegistration": "pixel-center",
        "spatialInterpolation": "bilinear",
        "tileWidth": 256,
        "tileHeight": 256,
        "unsupportedVelocity": [0.0, 0.0],
        "missingPageSemantics": "unavailable",
        "activitySupport": "nearest-texel-zero",
    }
    assert manifest["quality"] == quality
    assert manifest["construction"] == {
        "algorithmVersion": RUNTIME_ADAPTER_VERSION,
        "adapterVersion": RUNTIME_ADAPTER_VERSION,
        "collectionContentVersion": "flow-cog-collection-synthetic-v3",
        "pageSetSha256": page_index.page_set_sha256,
        "levelConstruction": "cog-physical-or-global-semantic-recursive",
        "supportFilter": SEMANTIC_OVERVIEW_POLICY,
        "publicationPolicy": {
            "kind": "bounded-source-ceiling",
            "minimumMatrixId": str(RUNTIME_MINIMUM_MATRIX),
            "maximumMatrixCap": str(RUNTIME_MAXIMUM_MATRIX_CAP),
            "resolvedMaximumMatrixId": "9",
        },
    }


@pytest.mark.parametrize("adapter_version", (
    LEGACY_RUNTIME_ADAPTER_VERSION,
    RUNTIME_ADAPTER_VERSION,
))
@pytest.mark.parametrize("mutation", (
    lambda value: value["construction"].update({"adapterVersion": "unsupported"}),
    lambda value: value["construction"].update({"algorithmVersion": "unsupported"}),
    lambda value: value["construction"].update({"supportFilter": "ordinary-average"}),
    lambda value: value["representation"].update({"activitySupport": "bilinear"}),
    lambda value: value.update({"schemaVersion": 3}),
))
def test_runtime_rejects_cross_version_sampling_contracts(runtime_fixture, adapter_version, mutation):
    descriptor, _bounds, _readers, quality, page_index, _manifest = runtime_fixture
    manifest = build_cog_runtime_manifest(
        descriptor,
        "isolated-adapter-contract",
        replace(page_index, adapter_version=adapter_version),
        quality,
        source_ceiling_selection_relation="statistically-selected",
    )
    validate_cog_runtime_manifest(manifest)
    mutation(manifest)
    with pytest.raises(ValueError):
        validate_cog_runtime_manifest(manifest)


def test_runtime_requires_exact_adapter_specific_activity_support(runtime_fixture):
    _descriptor, _bounds, _readers, _quality, _page_index, manifest = runtime_fixture
    missing = copy.deepcopy(manifest)
    missing["representation"].pop("activitySupport")
    with pytest.raises(ValueError, match="representation"):
        validate_cog_runtime_manifest(missing)
    relabelled = copy.deepcopy(manifest)
    relabelled["construction"].update({
        "adapterVersion": LEGACY_RUNTIME_ADAPTER_VERSION,
        "algorithmVersion": LEGACY_RUNTIME_ADAPTER_VERSION,
        "supportFilter": LEGACY_SEMANTIC_OVERVIEW_POLICY,
    })
    with pytest.raises(ValueError, match="representation"):
        validate_cog_runtime_manifest(relabelled)


def test_runtime_rejects_unknown_snapshot_and_adapter_versions():
    assert runtime_adapter_version_for_snapshot_schema(2) == LEGACY_RUNTIME_ADAPTER_VERSION
    assert runtime_adapter_version_for_snapshot_schema(3) == RUNTIME_ADAPTER_VERSION
    assert runtime_support_filter(LEGACY_RUNTIME_ADAPTER_VERSION) == LEGACY_SEMANTIC_OVERVIEW_POLICY
    assert runtime_support_filter(RUNTIME_ADAPTER_VERSION) == SEMANTIC_OVERVIEW_POLICY
    for value in (None, True, 1, 4, "3", 3.0):
        with pytest.raises(ValueError):
            runtime_adapter_version_for_snapshot_schema(value)
    for value in (None, [], {}, "flow-cog-wmq-rg32f-v4"):
        with pytest.raises(ValueError):
            runtime_support_filter(value)


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
        lambda manifest: manifest["representation"].update({
            "sampleRegistration": "global-texel-lattice",
        }),
        lambda manifest: manifest["representation"].update({
            "spatialInterpolation": "nearest",
        }),
        lambda manifest: manifest.update({"unexpected": True}),
        lambda manifest: manifest["pages"][0].update({"sampleKey": "t99"}),
        lambda manifest: manifest["timeMaximumSpeeds"][0].update({
            "sampleKey": "t99",
        }),
        lambda manifest: manifest["temporal"]["sampleAdjacency"][0].update({
            "interpolation": "none",
        }),
        lambda manifest: manifest["sourceCeiling"].update({"matrixId": "15"}),
        lambda manifest: manifest["authority"].update({"time": "guessed"}),
        lambda manifest: manifest["quality"].update({"approvalReason": ""}),
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
        ({}, bounds, 9),
        ({0: readers[0], 1: readers[0]}, bounds, 9),
        (readers, (bounds[0], bounds[1], bounds[2] + 0.01, bounds[3]), 9),
        (readers, bounds, 8),
        (readers, bounds, 10),
    )
    for selected, selected_bounds, source_ceiling in cases:
        with pytest.raises(ValueError):
            build_cog_runtime_page_index(
                descriptor,
                selected,
                selected_bounds,
                source_ceiling_matrix=source_ceiling,
            )


def test_manifest_build_rejects_descriptor_and_quality_drift(runtime_fixture):
    descriptor, _bounds, _readers, _quality, page_index, _manifest = runtime_fixture

    with pytest.raises(ValueError, match="quality"):
        build_cog_runtime_manifest(
            descriptor,
            "flow-cog-collection-synthetic-v1",
            page_index,
            {"particleSimulation": "not-approved"},
            source_ceiling_selection_relation="statistically-selected",
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
            source_ceiling_selection_relation="statistically-selected",
        )


def test_runtime_matrix_publication_is_bounded_by_source_ceiling_and_z10_cap():
    assert runtime_matrices_for_source_ceiling(9) == tuple(range(4, 10))
    assert runtime_matrices_for_source_ceiling(10) == tuple(range(4, 11))
    assert runtime_matrices_for_source_ceiling(15) == tuple(range(4, 11))

    for invalid in (True, 3, 25, 10.0):
        with pytest.raises(ValueError):
            runtime_matrices_for_source_ceiling(invalid)


def test_sample_adjacency_marks_omitted_source_times_as_explicit_gaps():
    assert _sample_adjacency((0, 1, 4, 9)) == [
        {
            "lowerSampleKey": "t00",
            "upperSampleKey": "t01",
            "kind": "interpolable",
            "interpolation": "component-wise-linear",
        },
        {
            "lowerSampleKey": "t01",
            "upperSampleKey": "t04",
            "kind": "gap",
            "interpolation": "none",
            "reason": "omitted-source-samples",
        },
        {
            "lowerSampleKey": "t04",
            "upperSampleKey": "t09",
            "kind": "gap",
            "interpolation": "none",
            "reason": "omitted-source-samples",
        },
    ]


def test_fixed_z10_source_ceiling_publishes_z4_through_z10(
    synthetic_source,
    tmp_path,
):
    built = build_velocity_cog_snapshot(
        synthetic_source.directory,
        tmp_path / "cog-cache",
        time_index=0,
        descriptor_path=synthetic_source.descriptor_path,
        resolution=FixedWebMercatorResolution(10),
    )
    reader = CogVelocityTileReader(built.manifest_path, built.cog_path)
    descriptor = read_source_descriptor(synthetic_source.descriptor_path)
    bounds = load_source_snapshot(
        synthetic_source.directory,
        time_index=0,
        descriptor_path=synthetic_source.descriptor_path,
    ).geographic_bounds
    page_index = build_cog_runtime_page_index(
        descriptor,
        {0: reader},
        bounds,
        source_ceiling_matrix=10,
    )
    quality = {
        "particleSimulation": "not-approved",
        "approvalReason": "test-only",
    }
    manifest = build_cog_runtime_manifest(
        descriptor,
        "flow-cog-collection-fixed-z10-v2",
        page_index,
        quality,
        source_ceiling_selection_relation="explicitly-requested",
    )

    validate_cog_runtime_manifest(manifest)
    assert page_index.source_ceiling_matrix == 10
    assert page_index.matrices == tuple(range(4, 11))
    assert manifest["sourceCeiling"] == {
        "tileMatrixSetId": "WebMercatorQuad",
        "matrixId": "10",
        "selectionRelation": "explicitly-requested",
    }
    assert manifest["tileMatrixSet"]["tileMatrixIds"] == [
        str(matrix) for matrix in range(4, 11)
    ]
    assert manifest["tileMatrixSet"]["maxTileMatrix"] == "10"
    assert any(page["matrixId"] == "10" for page in manifest["pages"])
