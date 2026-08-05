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
    WEB_MERCATOR_QUAD_LIMITS,
    build_dem_cog,
)


def test_manifest_separates_source_from_standard_web_mercator_tiles(built_dem):
    manifest = json.loads(built_dem.manifest_path.read_text(encoding="utf-8"))

    assert manifest["schemaVersion"] == 2
    assert manifest["sourceHash"] == DEM_SOURCE_SHA256
    assert manifest["contentVersion"] == f"dem-{DEM_SOURCE_SHA256[:16]}-cog-wmq-v3"
    assert manifest["source"] == {
        "crs": "EPSG:4326",
        "geographicBounds": list(DEM_BOUNDS),
        "rasterDimensions": {"width": 1024, "height": 558},
        "sampleType": "uint8",
        "bitsPerSample": 8,
    }
    assert manifest["projectedBounds"]["crs"] == (
        "http://www.opengis.net/def/crs/EPSG/0/3857"
    )
    assert len(manifest["projectedBounds"]["bounds"]) == 4
    assert manifest["tileMatrixSet"] == {
        "id": "WebMercatorQuad",
        "uri": "http://www.opengis.net/def/tilematrixset/OGC/1.0/WebMercatorQuad",
        "crs": "http://www.opengis.net/def/crs/EPSG/0/3857",
        "cornerOfOrigin": "topLeft",
        "tileRowDirection": "south",
        "tileColDirection": "east",
        "tileWidth": 256,
        "tileHeight": 256,
        "minTileMatrix": "4",
        "maxTileMatrix": "10",
        "tileMatrixIds": [str(zoom) for zoom in range(4, 11)],
        "limits": list(WEB_MERCATOR_QUAD_LIMITS),
    }
    assert manifest["nativeResolution"]["closestTileMatrix"] == "10"
    assert manifest["nativeResolution"]["resampling"] == "nearest"
    assert manifest["nodata"] is None
    assert manifest["scale"] == pytest.approx(
        (DEM_ELEVATION_MAX - DEM_ELEVATION_MIN) / 255
    )
    assert manifest["offset"] == DEM_ELEVATION_MIN
    assert manifest["overviewLevels"] == [2, 4, 8]
    assert manifest["pixelOrientation"] == {
        "source": "north-up-row-major",
        "cog": "north-up-row-major",
        "tile": "north-up-row-major",
    }
    assert manifest["cacheValidators"] == {
        "coherence": "immutable",
        "encodedRepresentation": "image/png",
        "decoderVersion": "dem-png-unorm8-v1",
        "etag": "content-version-and-standard-tile",
    }
    serialized = json.dumps(manifest, sort_keys=True)
    assert "GeoScratchLocalRasterQuad" not in serialized
    assert "southwest" not in serialized


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
