from __future__ import annotations

import hashlib
import json
import shutil

import numpy as np
import pytest
import rasterio
from rio_cogeo.cogeo import cog_validate

from geoscratch_flow_field_tiles.cog import (
    COG_ARTIFACT_MARKER,
    build_velocity_cog_snapshot,
    verify_velocity_cog_snapshot,
)
from geoscratch_flow_field_tiles.resolution import StationSpacingResolution


def _test_resolution() -> StationSpacingResolution:
    return StationSpacingResolution(
        minimum_support_points=3,
        minimum_support_fraction=0.10,
        minimum_matrix=9,
        maximum_matrix=9,
    )


def _rewrite_construction_identity(output, mutate) -> dict:
    manifest_path = output / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    mutate(manifest)
    facts = manifest["construction"]["facts"]
    construction_sha = hashlib.sha256(
        json.dumps(facts, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    manifest["construction"]["sha256"] = construction_sha
    time_index = facts["snapshot"]["timeIndex"]
    matrix_id = facts["plan"]["grid"]["matrixId"]
    content_version = (
        f"flow-cog-{construction_sha[:16]}-t{time_index:02d}-z{matrix_id}-v2"
    )
    manifest["contentVersion"] = content_version
    manifest_path.write_text(
        json.dumps(manifest, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    output.joinpath(COG_ARTIFACT_MARKER).write_text(
        json.dumps({
            "kind": "geoscratch-flow-field-cog-artifact",
            "contentVersion": content_version,
        }, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    return manifest


@pytest.fixture(scope="module")
def built_cog(synthetic_source, tmp_path_factory):
    output = tmp_path_factory.mktemp("flow-cog-parent") / "cog-cache"
    return build_velocity_cog_snapshot(
        synthetic_source.directory,
        output,
        time_index=0,
        descriptor_path=synthetic_source.descriptor_path,
        resolution=_test_resolution(),
    )


def test_snapshot_builds_one_valid_two_band_float32_cog_with_semantic_overviews(
    built_cog,
):
    valid, errors, warnings = cog_validate(built_cog.cog_path, strict=True)

    assert valid, {"errors": errors, "warnings": warnings}
    assert errors == []
    with rasterio.open(built_cog.cog_path) as dataset:
        assert dataset.crs.to_string() == "EPSG:3857"
        assert dataset.count == 2
        assert dataset.dtypes == ("float32", "float32")
        assert dataset.descriptions == ("U", "V")
        assert dataset.nodata is None
        assert dataset.block_shapes == [(256, 256), (256, 256)]
        assert dataset.overviews(1) == [2]
        assert dataset.overviews(2) == [2]
        assert dataset.tags()["GEOSCRATCH_OVERVIEW_POLICY"] == (
            "recursive-conservative-vector-box-v1"
        )
        assert dataset.transform.e < 0
        assert np.isfinite(dataset.read((1, 2))).all()
    with rasterio.open(built_cog.cog_path, OVERVIEW_LEVEL=0) as overview:
        assert (overview.width, overview.height) == (256, 128)
        assert np.isfinite(overview.read((1, 2))).all()


def test_cog_manifest_records_statistical_selection_and_unapproved_role(built_cog):
    manifest = json.loads(built_cog.manifest_path.read_text(encoding="utf-8"))
    marker = json.loads(
        built_cog.output_directory.joinpath(COG_ARTIFACT_MARKER).read_text(
            encoding="utf-8"
        )
    )

    assert manifest["artifactType"] == "flow-field-cog-snapshot"
    assert manifest["schemaVersion"] == 2
    assert manifest["snapshot"]["timeIndex"] == 0
    assert manifest["construction"]["facts"]["plan"]["matrixDecision"] == {
        "selectedMatrixId": "9",
        "outputMatrixId": "9",
        "relation": "statistically-selected",
    }
    assert manifest["construction"]["facts"]["encoding"]["overviewPolicy"][
        "kind"
    ] == "recursive-conservative-vector-box-v1"
    assert manifest["construction"]["facts"]["encoding"]["pixelDigestLayout"] == {
        "blockOrder": "top-to-bottom-left-to-right",
        "withinBlock": "band-first-north-up-row-major",
        "sampleEncoding": "float32-le",
        "partialBlocks": "logical-window-only",
    }
    assert manifest["construction"]["facts"]["support"]["overviewLevels"][0][
        "nominalFactor"
    ] == 2
    assert manifest["preflight"]["budget"]["approved"]
    assert manifest["preflight"]["staging"]["peakStagedBytes"] > 0
    assert manifest["preflight"]["staging"]["observationCount"] > 0
    assert manifest["quality"] == {
        "artifactRole": "reconstruction-prototype",
        "particleSimulation": "not-approved",
        "approvalReason": "inferred-topology-and-source-semantics-unapproved",
    }
    assert marker == {
        "kind": "geoscratch-flow-field-cog-artifact",
        "contentVersion": manifest["contentVersion"],
    }


def test_cog_verifier_checks_container_and_pixel_identity(built_cog):
    facts = verify_velocity_cog_snapshot(built_cog.output_directory)

    assert facts["contentVersion"] == built_cog.content_version
    assert facts["cogSha256"] == built_cog.cog_sha256
    assert facts["matrixId"] == "9"
    assert facts["particleSimulation"] == "not-approved"


def test_repeated_snapshot_build_preserves_pixels_and_content_identity(
    built_cog,
    synthetic_source,
    tmp_path,
):
    rebuilt = build_velocity_cog_snapshot(
        synthetic_source.directory,
        tmp_path / "cog-cache",
        time_index=0,
        descriptor_path=synthetic_source.descriptor_path,
        resolution=_test_resolution(),
    )

    assert rebuilt.content_version == built_cog.content_version
    with rasterio.open(built_cog.cog_path) as first, rasterio.open(rebuilt.cog_path) as second:
        assert first.profile == second.profile
        assert first.tags() == second.tags()
        assert first.overviews(1) == second.overviews(1)
        assert np.array_equal(first.read((1, 2)), second.read((1, 2)))
    with (
        rasterio.open(built_cog.cog_path, OVERVIEW_LEVEL=0) as first,
        rasterio.open(rebuilt.cog_path, OVERVIEW_LEVEL=0) as second,
    ):
        assert np.array_equal(first.read((1, 2)), second.read((1, 2)))


def test_verifier_rejects_self_consistent_path_traversal(built_cog, tmp_path):
    output = tmp_path / "cog-cache"
    shutil.copytree(built_cog.output_directory, output)
    shutil.copy2(built_cog.cog_path, tmp_path / "external.cog.tif")
    _rewrite_construction_identity(
        output,
        lambda manifest: manifest["construction"]["facts"]["cog"].update({
            "path": "../external.cog.tif",
        }),
    )

    with pytest.raises(ValueError, match="ownership"):
        verify_velocity_cog_snapshot(output)


def test_verifier_rejects_self_consistent_false_validation_facts(
    built_cog,
    tmp_path,
):
    output = tmp_path / "cog-cache"
    shutil.copytree(built_cog.output_directory, output)
    _rewrite_construction_identity(
        output,
        lambda manifest: manifest["construction"]["facts"]["cog"].update({
            "overviewCount": 0,
        }),
    )

    with pytest.raises(ValueError, match="validation facts"):
        verify_velocity_cog_snapshot(output)


@pytest.mark.parametrize("scope", ("base", "overview"))
def test_verifier_rejects_self_consistent_false_support_counts(
    built_cog,
    tmp_path,
    scope,
):
    output = tmp_path / scope / "cog-cache"
    output.parent.mkdir()
    shutil.copytree(built_cog.output_directory, output)

    def mutate(manifest):
        support = manifest["construction"]["facts"]["support"]
        if scope == "base":
            support["bilinearSafePixelCount"] += 1
        else:
            support["overviewLevels"][0]["bilinearSafePixelCount"] += 1

    _rewrite_construction_identity(output, mutate)

    with pytest.raises(ValueError, match="support"):
        verify_velocity_cog_snapshot(output)


def test_replacement_refuses_owned_marker_with_unrelated_residue(
    built_cog,
    synthetic_source,
    tmp_path,
):
    output = tmp_path / "cog-cache"
    shutil.copytree(built_cog.output_directory, output)
    residue = output / "notes.txt"
    residue.write_text("belongs to the user\n", encoding="utf-8")

    with pytest.raises(ValueError, match="unowned"):
        build_velocity_cog_snapshot(
            synthetic_source.directory,
            output,
            time_index=0,
            descriptor_path=synthetic_source.descriptor_path,
            resolution=_test_resolution(),
        )

    assert residue.read_text(encoding="utf-8") == "belongs to the user\n"
