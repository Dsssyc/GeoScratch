import io
import json
import random

import numpy as np
from fastapi.testclient import TestClient
from PIL import Image
from rio_tiler.io import Reader

from geoscratch_dem_tiles.service import create_app


STANDARD_TILES = (
    (4, 6, 13),
    (7, 51, 106),
    (8, 104, 214),
    (9, 208, 428),
    (10, 415, 853),
    (10, 418, 858),
)


def decode_tile(content: bytes) -> np.ndarray:
    return np.asarray(Image.open(io.BytesIO(content)).convert("L"), dtype=np.uint8)


def expected_tile(cog_path, zoom: int, row: int, col: int) -> np.ndarray:
    with Reader(str(cog_path)) as reader:
        image = reader.tile(
            col,
            row,
            zoom,
            tilesize=256,
            indexes=1,
            resampling_method="nearest",
        )
    return np.ma.filled(image.array, 0)[0].astype(np.uint8, copy=False)


def test_health_manifest_cors_and_cache_contract(built_dem):
    with TestClient(create_app(built_dem.output_directory)) as client:
        health = client.get("/health")
        manifest = client.get("/manifest.json", headers={"Origin": "http://localhost:5173"})

    assert health.status_code == 200
    assert health.json() == {
        "status": "ok",
        "contentVersion": f"dem-{built_dem.source_hash[:16]}-cog-wmq-v3",
    }
    assert health.headers["cache-control"] == "no-store"
    assert manifest.status_code == 200
    assert manifest.json() == json.loads(built_dem.manifest_path.read_text(encoding="utf-8"))
    assert manifest.headers["cache-control"] == "public, max-age=300"
    assert manifest.headers["etag"] == f'"{built_dem.source_hash}"'
    assert manifest.headers["access-control-allow-origin"] == "*"


def test_standard_tiles_match_rio_tiler_without_vertical_flip(built_dem):
    with TestClient(create_app(built_dem.output_directory)) as client:
        for zoom, row, col in STANDARD_TILES:
            response = client.get(f"/tiles/WebMercatorQuad/{zoom}/{row}/{col}.png")
            tile = decode_tile(response.content)

            assert response.status_code == 200
            assert response.headers["content-type"] == "image/png"
            assert response.headers["cache-control"] == "public, max-age=31536000, immutable"
            assert response.headers["x-dem-tile-matrix"] == str(zoom)
            assert response.headers["x-dem-tile-row"] == str(row)
            assert response.headers["x-dem-tile-col"] == str(col)
            assert tile.shape == (256, 256)
            assert np.array_equal(tile, expected_tile(built_dem.cog_path, zoom, row, col))


def test_seeded_standard_tiles_preserve_corners_center_and_random_pixels(built_dem):
    rng = random.Random(20260805)
    with TestClient(create_app(built_dem.output_directory)) as client:
        for zoom, row, col in STANDARD_TILES:
            response = client.get(f"/tiles/WebMercatorQuad/{zoom}/{row}/{col}.png")
            actual = decode_tile(response.content)
            expected = expected_tile(built_dem.cog_path, zoom, row, col)
            points = [(0, 0), (255, 0), (0, 255), (255, 255), (128, 128)]
            points.extend((rng.randrange(256), rng.randrange(256)) for _ in range(8))
            for x, y in points:
                assert actual[y, x] == expected[y, x]


def test_etag_is_stable_and_supports_conditional_requests(built_dem):
    path = "/tiles/WebMercatorQuad/10/416/855.png"
    with TestClient(create_app(built_dem.output_directory)) as client:
        first = client.get(path)
        second = client.get(path)
        conditional = client.get(path, headers={"If-None-Match": first.headers["etag"]})

    assert first.headers["etag"] == second.headers["etag"]
    assert conditional.status_code == 304
    assert conditional.content == b""


def test_invalid_standard_coordinates_and_old_routes_are_absent(built_dem):
    with TestClient(create_app(built_dem.output_directory)) as client:
        invalid_matrix = client.get("/tiles/WebMercatorQuad/11/0/0.png")
        invalid_row = client.get("/tiles/WebMercatorQuad/10/414/853.png")
        invalid_col = client.get("/tiles/WebMercatorQuad/10/415/852.png")
        old_route = client.get("/tiles/3/0/0.png")
        full_image = client.get("/dem.png")

    for response in (invalid_matrix, invalid_row, invalid_col):
        assert response.status_code == 404
        assert response.json()["detail"]["code"] == "DEM_TILE_OUT_OF_RANGE"
    assert old_route.status_code == 404
    assert full_image.status_code == 404


def test_unavailable_cog_is_distinct_from_out_of_coverage(built_dem, tmp_path):
    unavailable_directory = tmp_path / "unavailable"
    unavailable_directory.mkdir()
    unavailable_directory.joinpath("manifest.json").write_bytes(
        built_dem.manifest_path.read_bytes()
    )
    with TestClient(create_app(unavailable_directory)) as client:
        unavailable = client.get("/tiles/WebMercatorQuad/10/415/853.png")

    assert unavailable.status_code == 503
    assert unavailable.json()["detail"]["code"] == "DEM_COG_UNAVAILABLE"


def test_stats_are_bounded_aggregates_without_request_history(built_dem):
    with TestClient(create_app(built_dem.output_directory)) as client:
        client.get("/tiles/WebMercatorQuad/10/415/853.png")
        client.get("/tiles/WebMercatorQuad/10/414/853.png")
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
        "matrixReads": {str(zoom): int(zoom == 10) for zoom in range(4, 11)},
    }
    assert stats.json()["bytesServed"] > 0
    assert "history" not in stats.json()
    assert "requests" not in stats.json()
