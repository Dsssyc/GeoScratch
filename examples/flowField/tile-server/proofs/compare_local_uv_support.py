"""Read-only t10/t11 ROI proof; never creates a TIFF, dataset or cache record.

Run with the tile-server Python environment. The fixed approximate north-branch
ROI is a diagnostic sample, not a reconstruction of the user's screenshot camera.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path

import numpy as np
import rasterio
from rasterio.windows import Window, from_bounds
from scipy.ndimage import binary_erosion, label

from geoscratch_flow_field_tiles.cog_overviews import LEGACY_SEMANTIC_OVERVIEW_POLICY, reduce_semantic_overview
from geoscratch_flow_field_tiles.contracts import TriangleLinearInterpolation
from geoscratch_flow_field_tiles.contracts import read_topology_spec
from geoscratch_flow_field_tiles.interpolation import prepare_triangle_linear_stencil
from geoscratch_flow_field_tiles.topology import prepare_topology, project_lon_lat
from uv_support_policy import candidate_policy_manifest, reduce_nonexpanding_uv, sample_tin_centers


ROI = (121.0, 31.65, 121.65, 31.95)
MAXIMUM_PATCH_PIXELS = 1_000_000


def read_pairs(path: Path, expected_hash: str, count: int) -> np.ndarray:
    """Verify that the experiment uses the immutable descriptor's original bytes."""
    if path.stat().st_size != count * 2 * 4:
        raise ValueError(f"Unexpected source pair count: {path}")
    data = path.read_bytes()
    if hashlib.sha256(data).hexdigest() != expected_hash:
        raise ValueError(f"Source hash does not match descriptor: {path}")
    return np.frombuffer(data, dtype="<f4").reshape(count, 2)


def metrics(values: np.ndarray, roi_mask: np.ndarray) -> dict[str, object]:
    support = np.any(values != 0.0, axis=2) & roi_mask
    components, count = label(support, np.ones((3, 3), dtype=np.uint8))
    sizes = np.bincount(components.ravel())[1:]
    return {
        "nonzeroPixels": int(support.sum()),
        "connectedComponents8": count,
        "largestComponentsPixels": sorted(sizes.tolist(), reverse=True)[:5],
    }


def run_proof(source: Path, collection: Path, descriptor_path: Path) -> dict[str, object]:
    descriptor = json.loads(descriptor_path.read_text(encoding="utf-8"))
    station_record = descriptor["station"]
    stations = read_pairs(source / station_record["file"], station_record["sha256"],
                         descriptor["stationCount"])
    topology = prepare_topology(stations, read_topology_spec(descriptor["topology"]))
    projected_roi = project_lon_lat(np.array([[ROI[0], ROI[1]], [ROI[2], ROI[3]]])).ravel()
    first_path = collection / "snapshots" / "t10" / "flow-t10.cog.tif"
    with rasterio.open(first_path) as dataset:
        bounds_window = from_bounds(*projected_roi, dataset.transform)
        # Align the local patch with all four real overview grids. The halo is
        # wider than legacy z6's cumulative support footprint, so patch borders
        # cannot manufacture an apparent difference inside the measured ROI.
        col = max(0, math.floor(bounds_window.col_off / 16) * 16 - 64)
        row = max(0, math.floor(bounds_window.row_off / 16) * 16 - 64)
        right = min(dataset.width, math.ceil((bounds_window.col_off + bounds_window.width) / 16) * 16 + 64)
        bottom = min(dataset.height, math.ceil((bounds_window.row_off + bounds_window.height) / 16) * 16 + 64)
        width, height = right - col, bottom - row
        if width < 1 or height < 1 or width * height > MAXIMUM_PATCH_PIXELS:
            raise ValueError("Diagnostic window exceeded its bounded pixel budget")
        transform = dataset.window_transform(Window(col, row, width, height))
        pixel_size = dataset.res[0]
    xs = transform.c + (np.arange(width) + .5) * transform.a
    ys = transform.f + (np.arange(height) + .5) * transform.e
    x, y = np.meshgrid(xs, ys)
    longitudes = x / 6_378_137 * 180 / math.pi
    latitudes = np.arctan(np.sinh(y / 6_378_137)) * 180 / math.pi
    stencil = prepare_triangle_linear_stencil(topology, longitudes.ravel(), latitudes.ravel(),
        TriangleLinearInterpolation(stationary_policy="require-all-moving"))
    samples = []
    for key in ("t10", "t11"):
        record = next(value for value in descriptor["fields"] if value["timeIndex"] == int(key[1:]))
        field = read_pairs(source / record["file"], record["sha256"], descriptor["stationCount"])
        unique_field = topology.aggregate_field(field)
        all_moving = sample_tin_centers(stencil, unique_field, all_moving=True).reshape(height, width, 2)
        ordinary = sample_tin_centers(stencil, unique_field, all_moving=False).reshape(height, width, 2)
        legacy = all_moving.copy()
        legacy[~binary_erosion(np.any(all_moving != 0, axis=2), structure=np.ones((3, 3), bool))] = 0.0
        manifest_path = collection / "snapshots" / key / "manifest.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        construction = manifest["construction"]["facts"]
        if construction["plan"]["grid"]["matrixId"] != "10":
            raise ValueError("Local proof requires the existing z10 base grid")
        if construction["encoding"]["overviewPolicy"]["kind"] != "recursive-conservative-vector-box-v1":
            raise ValueError("Legacy comparison requires an explicitly identified old overview policy")
        levels = []
        for index in range(5):
            factor = 2 ** index
            level_height, level_width = ordinary.shape[:2]
            centers_x = transform.c + (np.arange(level_width) + .5) * transform.a * factor
            centers_y = transform.f + (np.arange(level_height) + .5) * transform.e * factor
            in_roi = (centers_x[None, :] >= projected_roi[0]) & (centers_x[None, :] <= projected_roi[2])
            in_roi = in_roi & (centers_y[:, None] >= projected_roi[1]) & (centers_y[:, None] <= projected_roi[3])
            cog_path = collection / "snapshots" / key / f"flow-{key}.cog.tif"
            with rasterio.open(cog_path, **({} if index == 0 else {"OVERVIEW_LEVEL": index - 1})) as dataset:
                stored = np.moveaxis(dataset.read((1, 2), window=Window(
                    col // factor, row // factor, level_width, level_height
                )), 0, 2)
            support_mismatch = int(np.count_nonzero(
                (np.any(stored != 0, axis=2) != np.any(legacy != 0, axis=2)) & in_roi
            ))
            if support_mismatch:
                raise AssertionError(f"Legacy reconstruction differs from stored {key} z{10-index}")
            variants = {name: metrics(values, in_roi) for name, values in (
                ("legacyStored", stored), ("allMovingWithoutErosion", all_moving),
                ("ordinaryLinearWithoutErosion", ordinary),
            )}
            for value in variants.values():
                value["baseEquivalentAreaPixels"] = value["nonzeroPixels"] * factor * factor
            levels.append({"matrixId": str(10 - index), "legacySupportMismatchPixels": support_mismatch,
                           "variants": variants})
            if index < 4:
                legacy = reduce_semantic_overview(legacy, policy=LEGACY_SEMANTIC_OVERVIEW_POLICY).values
                all_moving = reduce_nonexpanding_uv(all_moving)
                ordinary = reduce_nonexpanding_uv(ordinary)
        samples.append({"sampleKey": key, "sourceSha256": record["sha256"], "levels": levels})
    return {
        "policy": candidate_policy_manifest(),
        "diagnosticRoiLonLat": ROI,
        "isScreenshotCameraReproduction": False,
        "baseGrid": {"matrixId": "10", "pixelSizeMercatorMeters": pixel_size,
                     "patchPixels": width * height, "maximumPatchPixels": MAXIMUM_PATCH_PIXELS},
        "sourceStationSha256": station_record["sha256"],
        "topologyPolicy": descriptor["topology"],
        "samples": samples,
        "limits": ["No physical shoreline or wet/dry truth was added.",
                   "Ordinary linear interpolation can be nonzero inside mixed zero/nonzero triangles.",
                   "All-four overviews preserve represented base zeros, not unsampled subpixel geometry.",
                   "Zero-footprint filtering must also be enforced by the frontend.",
                   "No production policy, manifest, COG or default configuration was modified."],
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    server = Path(__file__).resolve().parents[1]
    parser.add_argument("--source", type=Path, default=server.parents[1] / "public" / "json" / "examples" / "flow")
    parser.add_argument("--collection", type=Path, default=server / "cog-collection")
    parser.add_argument("--descriptor", type=Path, default=server / "source-dataset.json")
    args = parser.parse_args()
    with rasterio.Env(GDAL_PAM_ENABLED="NO"):
        print(json.dumps(run_proof(args.source, args.collection, args.descriptor), indent=2, sort_keys=True))
