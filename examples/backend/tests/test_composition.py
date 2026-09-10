from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import Response
from fastapi.testclient import TestClient

from geoscratch_examples_backend import service


def test_unavailable_datasets_keep_liveness_and_report_recovery(tmp_path):
    with TestClient(service.create_app(tmp_path / "dem", tmp_path / "flow")) as client:
        health = client.get("/api/health")
        assert health.status_code == 200
        assert health.headers["cache-control"] == "no-store"
        assert health.json()["status"] == "degraded"
        for name in ("dem", "flow"):
            assert health.json()["modules"][name]["status"] == "unavailable"
            for path in ("manifest.json", "health", "tiles/WebMercatorQuad/0/0/0.png"):
                response = client.get(f"/api/{name}/{path}")
                assert response.status_code == 503
                assert response.json()["detail"]["dataset"] == name
                assert response.json()["detail"]["code"] == "EXAMPLES_DATASET_UNAVAILABLE"
                assert response.json()["detail"]["preparation"]
                assert response.headers["cache-control"] == "no-store"


def test_mounts_preserve_payload_headers_queries_and_conditional_requests(monkeypatch, tmp_path):
    from fastapi import Request

    app = FastAPI()
    payload = b"exact immutable page bytes"

    @app.get("/tiles/page.bin")
    def page(request: Request):
        assert request.query_params["v"] == "content-1"
        headers = {"ETag": '"page-hash"', "Cache-Control": "public, no-cache"}
        if request.headers.get("if-none-match") == headers["ETag"]:
            return Response(status_code=304, headers=headers)
        return Response(payload, media_type="application/octet-stream", headers=headers)

    monkeypatch.setattr(service, "_flow_app", lambda output: app)
    with TestClient(service.create_app(tmp_path / "missing", tmp_path)) as client:
        first = client.get("/api/flow/tiles/page.bin?v=content-1")
        assert first.status_code == 200
        assert first.content == payload
        assert first.headers["content-type"] == "application/octet-stream"
        assert first.headers["cache-control"] == "public, no-cache"
        assert client.get("/api/flow/tiles/page.bin?v=content-1", headers={
            "If-None-Match": first.headers["etag"],
        }).status_code == 304
        assert client.get("/api/dem/manifest.json").status_code == 503
        assert client.get("/api/health").json()["modules"]["flow"]["status"] == "ready"
        assert client.get("/manifest.json").status_code == 404


def test_moved_modules_keep_original_data_locations():
    from geoscratch_dem_tiles.build import DEFAULT_OUTPUT_DIRECTORY, DEFAULT_SOURCE_PATH
    from geoscratch_flow_field_tiles.source import DEFAULT_DESCRIPTOR_PATH, DEFAULT_DATA_DIRECTORY
    from geoscratch_flow_field_tiles.collection import DEFAULT_COG_COLLECTION_DIRECTORY
    from geoscratch_flow_field_tiles.cog import DEFAULT_COG_OUTPUT_DIRECTORY
    from geoscratch_flow_field_tiles.build import DEFAULT_OUTPUT_DIRECTORY as FLOW_OUTPUT

    examples = Path(__file__).resolve().parents[2]
    assert DEFAULT_OUTPUT_DIRECTORY == examples / "underwaterTerrain/tile-server/cache"
    assert DEFAULT_SOURCE_PATH == examples / "underwaterTerrain/assets/dem.png"
    assert DEFAULT_DESCRIPTOR_PATH == examples / "flowField/tile-server/source-dataset.json"
    assert DEFAULT_DATA_DIRECTORY == examples / "public/json/examples/flow"
    assert DEFAULT_COG_COLLECTION_DIRECTORY == examples / "flowField/tile-server/cog-collection"
    assert DEFAULT_COG_OUTPUT_DIRECTORY == examples / "flowField/tile-server/cog-cache"
    assert FLOW_OUTPUT == examples / "flowField/tile-server/cache"
