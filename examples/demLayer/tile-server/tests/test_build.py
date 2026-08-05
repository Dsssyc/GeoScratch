import hashlib
import json

import numpy as np
import pytest
import rasterio
from PIL import Image
from rio_cogeo.cogeo import cog_validate

from geoscratch_dem_tiles.build import (
    DEM_BOUNDS,
    DEM_ELEVATION_MAX,
    DEM_ELEVATION_MIN,
    DEM_SOURCE_SHA256,
    build_dem_cog,
)


def test_manifest_freezes_source_and_local_raster_pyramid(built_dem):
    manifest = json.loads(built_dem.manifest_path.read_text(encoding="utf-8"))

    assert manifest["schemaVersion"] == 1
    assert manifest["sourceHash"] == DEM_SOURCE_SHA256
    assert manifest["contentVersion"] == f"dem-{DEM_SOURCE_SHA256[:16]}-cog-v2"
    assert manifest["crs"] == "EPSG:4326"
    assert manifest["bounds"] == list(DEM_BOUNDS)
    assert manifest["rasterDimensions"] == {"width": 1024, "height": 558}
    assert manifest["tileMatrixSet"] == {
        "id": "GeoScratchLocalRasterQuad",
        "origin": "southwest",
        "axisOrder": ["east", "north"],
    }
    assert manifest["tileSize"] == 256
    assert manifest["minZoom"] == 0
    assert manifest["maxZoom"] == 3
    assert manifest["nodata"] is None
    assert manifest["sampleType"] == "uint8"
    assert manifest["scale"] == pytest.approx(
        (DEM_ELEVATION_MAX - DEM_ELEVATION_MIN) / 255
    )
    assert manifest["offset"] == DEM_ELEVATION_MIN
    assert manifest["overviewLevels"] == [2, 4, 8]
    assert manifest["pixelOrientation"] == {
        "source": "north-up-row-major",
        "cog": "north-up-row-major",
        "tile": "south-up-row-major",
    }
    assert manifest["levels"] == [
        {"zoom": 0, "decimation": 8, "width": 128, "height": 70, "pagesX": 1, "pagesY": 1},
        {"zoom": 1, "decimation": 4, "width": 256, "height": 140, "pagesX": 1, "pagesY": 1},
        {"zoom": 2, "decimation": 2, "width": 512, "height": 279, "pagesX": 2, "pagesY": 2},
        {"zoom": 3, "decimation": 1, "width": 1024, "height": 558, "pagesX": 4, "pagesY": 3},
    ]


def test_cog_is_valid_north_up_and_preserves_every_source_sample(built_dem, dem_source):
    source = np.asarray(Image.open(dem_source).convert("L"), dtype=np.uint8)
    valid, errors, warnings = cog_validate(str(built_dem.cog_path), strict=True)

    assert valid, {"errors": errors, "warnings": warnings}
    with rasterio.open(built_dem.cog_path) as dataset:
        assert dataset.crs.to_string() == "EPSG:4326"
        assert tuple(dataset.bounds) == pytest.approx(DEM_BOUNDS)
        assert dataset.width == 1024
        assert dataset.height == 558
        assert dataset.dtypes == ("uint8",)
        assert dataset.nodata is None
        assert dataset.block_shapes == [(256, 256)]
        assert dataset.overviews(1) == [2, 4, 8]
        assert dataset.transform.e < 0
        assert np.array_equal(dataset.read(1), source)


def test_repeated_builds_have_identical_pixels_and_metadata_semantics(
    built_dem,
    dem_source,
    tmp_path,
):
    rebuilt = build_dem_cog(dem_source, tmp_path / "rebuilt")

    assert rebuilt.manifest_path.read_bytes() == built_dem.manifest_path.read_bytes()
    with rasterio.open(built_dem.cog_path) as first, rasterio.open(rebuilt.cog_path) as second:
        assert first.profile == second.profile
        assert first.tags() == second.tags()
        assert first.overviews(1) == second.overviews(1)
        assert np.array_equal(first.read(1), second.read(1))


def test_declared_source_hash_matches_repository_asset(dem_source):
    assert hashlib.sha256(dem_source.read_bytes()).hexdigest() == DEM_SOURCE_SHA256
