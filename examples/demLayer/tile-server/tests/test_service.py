import io
import json

import numpy as np
from fastapi.testclient import TestClient
from PIL import Image

from geoscratch_dem_tiles.service import create_app


SAMPLE_POINTS = (
    (0, 0),
    (1023, 0),
    (0, 557),
    (1023, 557),
    (512, 279),
    (53, 274),
    (377, 91),
    (734, 501),
    (911, 203),
)


def decode_tile(content: bytes) -> np.ndarray:
    return np.asarray(Image.open(io.BytesIO(content)).convert("L"), dtype=np.uint8)


def test_health_manifest_cors_and_cache_contract(built_dem):
    with TestClient(create_app(built_dem.output_directory)) as client:
        health = client.get("/health")
        manifest = client.get("/manifest.json", headers={"Origin": "http://localhost:5173"})

    assert health.status_code == 200
    assert health.json() == {
        "status": "ok",
        "contentVersion": f"dem-{built_dem.source_hash[:16]}-cog-v2",
    }
    assert health.headers["cache-control"] == "no-store"
    assert manifest.status_code == 200
    assert manifest.json() == json.loads(built_dem.manifest_path.read_text(encoding="utf-8"))
    assert manifest.headers["cache-control"] == "public, max-age=300"
    assert manifest.headers["etag"] == f'"{built_dem.source_hash}"'
    assert manifest.headers["access-control-allow-origin"] == "*"


def test_finest_tiles_preserve_legacy_flip_y_geographic_mapping(
    built_dem,
    dem_source,
):
    source = np.asarray(Image.open(dem_source).convert("L"), dtype=np.uint8)

    with TestClient(create_app(built_dem.output_directory)) as client:
        for logical_x, logical_y in SAMPLE_POINTS:
            page_x = logical_x // 256
            page_y = logical_y // 256
            response = client.get(f"/tiles/3/{page_x}/{page_y}.png")
            tile = decode_tile(response.content)

            assert response.status_code == 200
            assert response.headers["content-type"] == "image/png"
            assert response.headers["cache-control"] == "public, max-age=31536000, immutable"
            assert response.headers["x-dem-valid-width"] == str(min(256, 1024 - page_x * 256))
            assert response.headers["x-dem-valid-height"] == str(min(256, 558 - page_y * 256))
            assert tile.shape == (256, 256)
            source_y = source.shape[0] - 1 - logical_y
            assert tile[logical_y % 256, logical_x % 256] == source[source_y, logical_x]


def test_tiles_expose_each_cog_overview_as_a_local_pyramid(built_dem):
    with TestClient(create_app(built_dem.output_directory)) as client:
        for zoom, page_x, page_y in ((0, 0, 0), (1, 0, 0), (2, 1, 1), (3, 3, 2)):
            response = client.get(f"/tiles/{zoom}/{page_x}/{page_y}.png")

            assert response.status_code == 200
            assert decode_tile(response.content).shape == (256, 256)
            assert response.headers["x-dem-overview-decimation"] == str(2 ** (3 - zoom))


def test_out_of_range_and_unavailable_cog_are_distinct(built_dem, tmp_path):
    with TestClient(create_app(built_dem.output_directory)) as client:
        outside = client.get("/tiles/3/4/0.png")
        invalid_zoom = client.get("/tiles/4/0/0.png")

    unavailable_directory = tmp_path / "unavailable"
    unavailable_directory.mkdir()
    unavailable_directory.joinpath("manifest.json").write_bytes(
        built_dem.manifest_path.read_bytes()
    )
    with TestClient(create_app(unavailable_directory)) as client:
        unavailable = client.get("/tiles/3/0/0.png")

    assert outside.status_code == 404
    assert outside.json()["detail"]["code"] == "DEM_TILE_OUT_OF_RANGE"
    assert invalid_zoom.status_code == 404
    assert invalid_zoom.json()["detail"]["code"] == "DEM_TILE_OUT_OF_RANGE"
    assert unavailable.status_code == 503
    assert unavailable.json()["detail"]["code"] == "DEM_COG_UNAVAILABLE"


def test_stats_are_bounded_aggregates_without_request_history(built_dem):
    with TestClient(create_app(built_dem.output_directory)) as client:
        client.get("/tiles/3/0/0.png")
        client.get("/tiles/3/4/0.png")
        stats = client.get("/stats")

    assert stats.status_code == 200
    assert stats.headers["cache-control"] == "no-store"
    assert stats.json() == {
        "tileRequests": 2,
        "tileSuccesses": 1,
        "tileNotFound": 1,
        "tileFailures": 0,
        "cogWindowReads": 1,
        "bytesServed": stats.json()["bytesServed"],
        "overviewReads": {"1": 1, "2": 0, "4": 0, "8": 0},
    }
    assert stats.json()["bytesServed"] > 0
    assert "history" not in stats.json()
    assert "requests" not in stats.json()
