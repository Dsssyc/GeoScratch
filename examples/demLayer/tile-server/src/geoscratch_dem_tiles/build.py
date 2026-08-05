from __future__ import annotations

import argparse
import hashlib
import json
import os
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
import morecantile
import rasterio
from PIL import Image
from rasterio.transform import from_bounds
from rasterio.warp import transform_bounds
from rio_cogeo.cogeo import cog_translate, cog_validate
from rio_cogeo.profiles import cog_profiles


DEM_BOUNDS = (
    120.04373606134682,
    31.173901952209487,
    121.96623240116922,
    32.08401085804678,
)
DEM_ELEVATION_MIN = -80.06899999999999
DEM_ELEVATION_MAX = 4.3745
DEM_SOURCE_SHA256 = "aa7a584830f198772d242df1ce1ae47e21b2bdc85bfc1f97101af8be986c57e1"
DEM_WIDTH = 1024
DEM_HEIGHT = 558
TILE_SIZE = 256
WEB_MERCATOR_QUAD_MIN_ZOOM = 4
WEB_MERCATOR_QUAD_MAX_ZOOM = 10
WEB_MERCATOR_QUAD_URI = (
    "http://www.opengis.net/def/tilematrixset/OGC/1.0/WebMercatorQuad"
)
WEB_MERCATOR_CRS_URI = "http://www.opengis.net/def/crs/EPSG/0/3857"
OVERVIEW_LEVELS = (2, 4, 8)
BUILD_SCHEMA_VERSION = 2

WEB_MERCATOR_QUAD = morecantile.tms.get("WebMercatorQuad")


def _tile_matrix_limits() -> tuple[dict[str, int | str], ...]:
    west, south, east, north = DEM_BOUNDS
    limits: list[dict[str, int | str]] = []
    for zoom in range(WEB_MERCATOR_QUAD_MIN_ZOOM, WEB_MERCATOR_QUAD_MAX_ZOOM + 1):
        north_west = WEB_MERCATOR_QUAD.tile(west, north, zoom)
        south_east = WEB_MERCATOR_QUAD.tile(east, south, zoom)
        limits.append({
            "matrixId": str(zoom),
            "minTileRow": north_west.y,
            "maxTileRow": south_east.y,
            "minTileCol": north_west.x,
            "maxTileCol": south_east.x,
        })
    return tuple(limits)


WEB_MERCATOR_QUAD_LIMITS = _tile_matrix_limits()

TILE_SERVER_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_SOURCE_PATH = TILE_SERVER_ROOT.parent / "assets" / "dem.png"
DEFAULT_OUTPUT_DIRECTORY = TILE_SERVER_ROOT / "cache"


@dataclass(frozen=True)
class BuildResult:
    output_directory: Path
    cog_path: Path
    manifest_path: Path
    source_hash: str


def _source_hash(source_path: Path) -> str:
    digest = hashlib.sha256()
    with source_path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _manifest(source_hash: str) -> dict[str, Any]:
    projected_bounds = transform_bounds("EPSG:4326", "EPSG:3857", *DEM_BOUNDS)
    native_matrix = WEB_MERCATOR_QUAD.matrix(WEB_MERCATOR_QUAD_MAX_ZOOM)
    projected_pixel_size = (
        (projected_bounds[2] - projected_bounds[0]) / DEM_WIDTH,
        (projected_bounds[3] - projected_bounds[1]) / DEM_HEIGHT,
    )
    return {
        "schemaVersion": BUILD_SCHEMA_VERSION,
        "sourceHash": source_hash,
        "contentVersion": f"dem-{source_hash[:16]}-cog-wmq-v3",
        "source": {
            "crs": "EPSG:4326",
            "geographicBounds": list(DEM_BOUNDS),
            "rasterDimensions": {"width": DEM_WIDTH, "height": DEM_HEIGHT},
            "sampleType": "uint8",
            "bitsPerSample": 8,
        },
        "projectedBounds": {
            "crs": WEB_MERCATOR_CRS_URI,
            "bounds": list(projected_bounds),
        },
        "tileMatrixSet": {
            "id": "WebMercatorQuad",
            "uri": WEB_MERCATOR_QUAD_URI,
            "crs": WEB_MERCATOR_CRS_URI,
            "cornerOfOrigin": "topLeft",
            "tileRowDirection": "south",
            "tileColDirection": "east",
            "tileWidth": TILE_SIZE,
            "tileHeight": TILE_SIZE,
            "minTileMatrix": str(WEB_MERCATOR_QUAD_MIN_ZOOM),
            "maxTileMatrix": str(WEB_MERCATOR_QUAD_MAX_ZOOM),
            "tileMatrixIds": [
                str(zoom)
                for zoom in range(WEB_MERCATOR_QUAD_MIN_ZOOM, WEB_MERCATOR_QUAD_MAX_ZOOM + 1)
            ],
            "limits": list(WEB_MERCATOR_QUAD_LIMITS),
        },
        "nativeResolution": {
            "closestTileMatrix": str(WEB_MERCATOR_QUAD_MAX_ZOOM),
            "tileMatrixCellSizeMeters": native_matrix.cellSize,
            "sourceProjectedPixelSizeMeters": list(projected_pixel_size),
            "tileMatrixCellsPerSourcePixel": [
                projected_pixel_size[0] / native_matrix.cellSize,
                projected_pixel_size[1] / native_matrix.cellSize,
            ],
            "resampling": "nearest",
        },
        "nodata": None,
        "scale": (DEM_ELEVATION_MAX - DEM_ELEVATION_MIN) / 255,
        "offset": DEM_ELEVATION_MIN,
        "overviewLevels": list(OVERVIEW_LEVELS),
        "pixelOrientation": {
            "source": "north-up-row-major",
            "cog": "north-up-row-major",
            "tile": "north-up-row-major",
        },
        "outerBoundary": "clamp",
        "cacheValidators": {
            "coherence": "immutable",
            "encodedRepresentation": "image/png",
            "decoderVersion": "dem-png-unorm8-v1",
            "etag": "content-version-and-standard-tile",
        },
    }


def _read_source(source_path: Path) -> np.ndarray:
    if not source_path.is_file():
        raise FileNotFoundError(f"DEM source does not exist: {source_path}")
    source_hash = _source_hash(source_path)
    if source_hash != DEM_SOURCE_SHA256:
        raise ValueError(
            f"DEM source hash mismatch: expected {DEM_SOURCE_SHA256}, received {source_hash}"
        )
    with Image.open(source_path) as image:
        if image.mode != "L" or image.size != (DEM_WIDTH, DEM_HEIGHT):
            raise ValueError(
                "DEM source must be the canonical 1024 by 558 8-bit grayscale image"
            )
        return np.asarray(image, dtype=np.uint8).copy()


def _write_source_geotiff(path: Path, north_up_source: np.ndarray, source_hash: str) -> None:
    transform = from_bounds(*DEM_BOUNDS, DEM_WIDTH, DEM_HEIGHT)
    profile = {
        "driver": "GTiff",
        "width": DEM_WIDTH,
        "height": DEM_HEIGHT,
        "count": 1,
        "dtype": "uint8",
        "crs": "EPSG:4326",
        "transform": transform,
        "nodata": None,
    }
    with rasterio.open(path, "w", **profile) as dataset:
        dataset.write(north_up_source, 1)
        dataset.update_tags(
            GEOSCRATCH_SOURCE_SHA256=source_hash,
            GEOSCRATCH_SOURCE_ORIENTATION="north-up-row-major",
            GEOSCRATCH_COG_ORIENTATION="north-up-row-major",
        )


def _write_cog(source_tiff: Path, destination: Path) -> None:
    profile = cog_profiles.get("deflate")
    profile.update({
        "blockxsize": TILE_SIZE,
        "blockysize": TILE_SIZE,
        "predictor": 2,
        "zlevel": 9,
    })
    cog_translate(
        source_tiff,
        destination,
        profile,
        overview_level=len(OVERVIEW_LEVELS),
        overview_resampling="nearest",
        in_memory=False,
        quiet=True,
        forward_band_tags=True,
        forward_ns_tags=True,
    )
    valid, errors, warnings = cog_validate(destination, strict=True)
    if not valid:
        raise RuntimeError(
            "Generated DEM COG failed validation: "
            + json.dumps({"errors": errors, "warnings": warnings}, sort_keys=True)
        )


def build_dem_cog(source_path: str | Path, output_directory: str | Path) -> BuildResult:
    source = Path(source_path).resolve()
    output = Path(output_directory).resolve()
    source_hash = _source_hash(source) if source.is_file() else ""
    north_up_source = _read_source(source)
    output.mkdir(parents=True, exist_ok=True)

    cog_path = output / "dem.cog.tif"
    manifest_path = output / "manifest.json"
    with tempfile.TemporaryDirectory(prefix="geoscratch-dem-cog-", dir=output) as temporary:
        temporary_directory = Path(temporary)
        source_tiff = temporary_directory / "source.tif"
        temporary_cog = temporary_directory / "dem.cog.tif"
        temporary_manifest = temporary_directory / "manifest.json"
        _write_source_geotiff(source_tiff, north_up_source, source_hash)
        _write_cog(source_tiff, temporary_cog)
        temporary_manifest.write_text(
            json.dumps(_manifest(source_hash), indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        os.replace(temporary_cog, cog_path)
        os.replace(temporary_manifest, manifest_path)

    return BuildResult(output, cog_path, manifest_path, source_hash)


def main() -> None:
    parser = argparse.ArgumentParser(description="Build the GeoScratch DEM COG artifact")
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE_PATH)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT_DIRECTORY)
    arguments = parser.parse_args()
    result = build_dem_cog(arguments.source, arguments.output)
    print(json.dumps({
        "cog": str(result.cog_path),
        "manifest": str(result.manifest_path),
        "sourceHash": result.source_hash,
    }, sort_keys=True))


if __name__ == "__main__":
    main()
