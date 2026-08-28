from __future__ import annotations

import hashlib
from dataclasses import replace

import numpy as np
import pytest
import rasterio
from rasterio.enums import MaskFlags
from rasterio.transform import from_origin
from rio_cogeo.cogeo import cog_validate

from geoscratch_flow_field_tiles.cog_overviews import (
    SEMANTIC_OVERVIEW_POLICY,
    SemanticOverviewArtifact,
    assemble_semantic_overview_cog,
    plan_semantic_overview_levels,
    reduce_semantic_overview,
    write_explicit_overview_vrt,
    write_semantic_overviews,
)
from geoscratch_flow_field_tiles.cog import (
    CogEncoding,
    CogGrid,
    _validate_cog,
)


def _base_values() -> np.ndarray:
    values = np.empty((530, 600, 2), dtype=np.float32)
    values[..., 0] = 2.0
    values[..., 1] = -4.0
    values[:4] = 0.0
    values[-4:] = 0.0
    values[:, :4] = 0.0
    values[:, -4:] = 0.0
    values[254:258, 254:258] = 0.0
    values[300:302, 300:302] = np.asarray([
        [[1.0, 0.0], [-1.0, 0.0]],
        [[1.0, 0.0], [-1.0, 0.0]],
    ], dtype=np.float32)
    return values


def _write_base(path, values: np.ndarray) -> None:
    profile = {
        "driver": "GTiff",
        "width": values.shape[1],
        "height": values.shape[0],
        "count": 2,
        "dtype": "float32",
        "crs": "EPSG:3857",
        "transform": from_origin(1000.0, 2000.0, 2.0, 2.0),
        "nodata": None,
        "tiled": True,
        "blockxsize": 256,
        "blockysize": 256,
        "compress": "DEFLATE",
        "predictor": 3,
        "zlevel": 1,
        "interleave": "pixel",
    }
    with rasterio.open(path, "w", **profile) as dataset:
        dataset.write(np.moveaxis(values, 2, 0))
        dataset.set_band_description(1, "U")
        dataset.set_band_description(2, "V")
        dataset.update_tags(
            AREA_OR_POINT="Point",
            GEOSCRATCH_ARTIFACT="flow-field-cog-snapshot",
            GEOSCRATCH_SOURCE_HASH="a" * 64,
            GEOSCRATCH_TIME_INDEX="0",
            GEOSCRATCH_SAMPLE_REGISTRATION="pixel-center",
        )
        dataset.update_tags(1, GEOSCRATCH_COMPONENT="u")
        dataset.update_tags(2, GEOSCRATCH_COMPONENT="v")


def _block_digest(path) -> str:
    digest = hashlib.sha256()
    with rasterio.open(path) as dataset:
        for _block, window in dataset.block_windows(1):
            digest.update(dataset.read((1, 2), window=window).tobytes(order="C"))
    return digest.hexdigest()


@pytest.fixture()
def semantic_pyramid(tmp_path):
    base = tmp_path / "base.tif"
    values = _base_values()
    _write_base(base, values)
    with rasterio.open(base) as source:
        levels = plan_semantic_overview_levels(
            source.width,
            source.height,
            tuple(source.transform)[:6],
            block_size=256,
        )
    artifacts = write_semantic_overviews(
        base,
        tmp_path,
        levels,
        block_size=256,
    )
    return tmp_path, base, values, levels, artifacts


def test_streamed_overviews_equal_the_recursive_whole_array_reference(
    semantic_pyramid,
):
    _root, _base, values, levels, artifacts = semantic_pyramid
    reference = values

    assert [level.nominal_factor for level in levels] == [2, 4]
    for level, artifact in zip(levels, artifacts, strict=True):
        reference_result = reduce_semantic_overview(reference)
        reference = reference_result.values
        with rasterio.open(artifact.path) as dataset:
            actual = np.moveaxis(dataset.read((1, 2)), 0, 2)
            assert (dataset.width, dataset.height) == (level.width, level.height)
            assert dataset.transform == rasterio.Affine(*level.transform)
        assert np.array_equal(actual, reference)
        assert artifact.candidate_valid_count == (
            reference_result.candidate_valid_count
        )
        assert artifact.bilinear_safe_count == reference_result.bilinear_safe_count
        assert artifact.cancellation_to_zero_count == (
            reference_result.cancellation_to_zero_count
        )
        digest = hashlib.sha256()
        with rasterio.open(artifact.path) as dataset:
            for _block, window in dataset.block_windows(1):
                digest.update(dataset.read((1, 2), window=window).tobytes(order="C"))
        assert artifact.pixel_sha256 == digest.hexdigest()
        assert not np.signbit(actual[actual == 0.0]).any()


def test_vrt_and_cog_preserve_every_custom_overview_pixel(semantic_pyramid):
    root, base, values, levels, artifacts = semantic_pyramid
    vrt = write_explicit_overview_vrt(root / "semantic.vrt", base, artifacts)
    cog = root / "semantic.cog.tif"
    assemble_semantic_overview_cog(
        vrt,
        cog,
        block_size=256,
        compression_level=9,
        big_tiff="IF_SAFER",
    )

    valid, errors, warnings = cog_validate(cog, strict=True, quiet=True)
    assert valid, {"errors": errors, "warnings": warnings}
    assert errors == []
    assert warnings == []
    with rasterio.open(cog) as dataset:
        assert dataset.overviews(1) == [level.nominal_factor for level in levels]
        assert dataset.overviews(2) == dataset.overviews(1)
        assert np.array_equal(np.moveaxis(dataset.read((1, 2)), 0, 2), values)
        assert dataset.tags()["GEOSCRATCH_OVERVIEW_POLICY"] == (
            SEMANTIC_OVERVIEW_POLICY
        )
        assert dataset.nodata is None
        assert all(flags == [MaskFlags.all_valid] for flags in dataset.mask_flag_enums)
    for index, artifact in enumerate(artifacts):
        with rasterio.open(cog, OVERVIEW_LEVEL=index) as overview:
            with rasterio.open(artifact.path) as expected:
                assert (overview.width, overview.height) == (
                    artifact.level.width,
                    artifact.level.height,
                )
                assert np.array_equal(
                    overview.read((1, 2)),
                    expected.read((1, 2)),
                )


def test_explicit_vrt_rejects_missing_or_external_overview_sources(
    semantic_pyramid,
    tmp_path,
):
    root, base, _values, _levels, artifacts = semantic_pyramid
    missing = replace(artifacts[0], path=root / "missing.tif")
    with pytest.raises(FileNotFoundError, match="overview source"):
        write_explicit_overview_vrt(root / "missing.vrt", base, (missing,))

    external_path = tmp_path / "external" / artifacts[0].path.name
    external_path.parent.mkdir()
    external_path.write_bytes(artifacts[0].path.read_bytes())
    external = replace(artifacts[0], path=external_path)
    with pytest.raises(ValueError, match="staging directory"):
        write_explicit_overview_vrt(root / "external.vrt", base, (external,))


def test_semantic_verifier_rejects_a_strict_valid_forged_overview(tmp_path):
    base_values = np.zeros((512, 512, 2), dtype=np.float32)
    base_values[254:256, 254:256] = 1.0
    base = tmp_path / "base.tif"
    _write_base(base, base_values)
    with rasterio.open(base) as source:
        level = plan_semantic_overview_levels(
            source.width,
            source.height,
            tuple(source.transform)[:6],
            block_size=256,
        )[0]
        bounds = tuple(source.bounds)
        base_transform = tuple(source.transform)[:6]

    forged_values = np.zeros((level.height, level.width, 2), dtype=np.float32)
    forged_values[127, 127] = 1.0
    forged_path = tmp_path / "forged-overview.tif"
    with rasterio.open(
        forged_path,
        "w",
        driver="GTiff",
        width=level.width,
        height=level.height,
        count=2,
        dtype="float32",
        crs="EPSG:3857",
        transform=rasterio.Affine(*level.transform),
        nodata=None,
        tiled=True,
        blockxsize=256,
        blockysize=256,
        compress="DEFLATE",
        predictor=3,
        interleave="pixel",
    ) as dataset:
        dataset.write(np.moveaxis(forged_values, 2, 0))

    artifact = SemanticOverviewArtifact(
        level=level,
        path=forged_path,
        pixel_sha256=_block_digest(forged_path),
        candidate_valid_count=1,
        bilinear_safe_count=1,
        cancellation_to_zero_count=0,
        size_bytes=forged_path.stat().st_size,
    )
    vrt = write_explicit_overview_vrt(
        tmp_path / "forged.vrt",
        base,
        (artifact,),
    )
    cog = tmp_path / "forged.cog.tif"
    encoding = CogEncoding()
    assemble_semantic_overview_cog(
        vrt,
        cog,
        block_size=encoding.block_size,
        compression_level=encoding.compression_level,
        big_tiff=encoding.big_tiff,
    )
    record = artifact.manifest()
    support = {
        "pixelSha256": _block_digest(base),
        "rawAdvectablePixelCount": 4,
        "representableAdvectablePixelCount": 4,
        "roundedZeroPixelCount": 0,
        "bilinearSafePixelCount": 4,
        "overviewPolicy": encoding.manifest()["overviewPolicy"],
        "overviewLevels": [record],
    }
    grid = CogGrid(
        matrix_id=0,
        min_tile_row=0,
        max_tile_row=1,
        min_tile_col=0,
        max_tile_col=1,
        width=512,
        height=512,
        pixel_size_meters=2.0,
        transform=base_transform,
        projected_bounds=bounds,
    )

    valid, errors, warnings = cog_validate(cog, strict=True, quiet=True)
    assert valid, {"errors": errors, "warnings": warnings}
    with pytest.raises(RuntimeError, match="recursive semantic reduction"):
        _validate_cog(
            cog,
            grid,
            encoding,
            support["pixelSha256"],
            support,
            (record,),
            expected_source_hash="a" * 64,
            expected_time_index=0,
        )
