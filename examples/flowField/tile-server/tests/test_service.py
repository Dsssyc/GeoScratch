from __future__ import annotations

import json

from fastapi.testclient import TestClient

from geoscratch_flow_field_tiles.service import create_app


def _first_page(built_tiles) -> dict:
    manifest = json.loads(built_tiles.manifest_path.read_text(encoding="utf-8"))
    return manifest["pages"][0]


def _route(page: dict) -> str:
    return "/" + page["path"]


def test_health_and_manifest_are_immutable_and_conditional(built_tiles):
    with TestClient(create_app(built_tiles.output_directory)) as client:
        health = client.get("/health")
        manifest = client.get("/manifest.json", headers={"Origin": "http://localhost:5173"})
        conditional = client.get(
            "/manifest.json",
            headers={"If-None-Match": manifest.headers["etag"]},
        )

    assert health.status_code == 200
    assert health.json() == {
        "status": "ok",
        "contentVersion": built_tiles.content_version,
        "pageCount": built_tiles.page_count,
    }
    assert health.headers["cache-control"] == "no-store"
    assert manifest.status_code == 200
    assert manifest.headers["cache-control"] == "public, max-age=31536000, immutable"
    assert manifest.headers["access-control-allow-origin"] == "*"
    assert conditional.status_code == 304
    assert conditional.content == b""


def test_tile_returns_exact_rg32f_bytes_hash_etag_and_304(built_tiles):
    page = _first_page(built_tiles)
    expected = (built_tiles.output_directory / page["path"]).read_bytes()
    with TestClient(create_app(built_tiles.output_directory)) as client:
        first = client.get(_route(page))
        second = client.get(
            _route(page),
            headers={"If-None-Match": first.headers["etag"]},
        )

    assert first.status_code == 200
    assert first.content == expected
    assert first.headers["content-type"] == "application/vnd.geoscratch.flow-rg32f"
    assert first.headers["content-length"] == str(page["byteLength"])
    assert first.headers["cache-control"] == "public, max-age=31536000, immutable"
    assert first.headers["etag"] == f'"{page["sha256"]}"'
    assert second.status_code == 304
    assert second.content == b""


def test_invalid_time_matrix_and_coordinates_are_structured_404s(built_tiles):
    page = _first_page(built_tiles)
    invalid_routes = (
        _route(page).replace("/t00/", "/t99/"),
        _route(page).replace(f"/{page['matrixId']}/", "/99/"),
        _route(page).replace(f"/{page['tileRow']}/", "/9999/"),
    )
    with TestClient(create_app(built_tiles.output_directory)) as client:
        responses = [client.get(route) for route in invalid_routes]

    assert all(response.status_code == 404 for response in responses)
    assert all(
        response.json()["detail"]["code"] == "FLOW_FIELD_TILE_OUT_OF_RANGE"
        for response in responses
    )


def test_missing_declared_page_is_a_structured_503(built_tiles, tmp_path):
    output = tmp_path / "unavailable"
    output.mkdir()
    output.joinpath("manifest.json").write_bytes(built_tiles.manifest_path.read_bytes())
    page = _first_page(built_tiles)
    with TestClient(create_app(output)) as client:
        response = client.get(_route(page))

    assert response.status_code == 503
    assert response.json()["detail"]["code"] == (
        "FLOW_FIELD_TILE_ARTIFACT_UNAVAILABLE"
    )


def test_conditional_request_cannot_hide_a_missing_declared_page(built_tiles, tmp_path):
    output = tmp_path / "conditional-unavailable"
    output.mkdir()
    output.joinpath("manifest.json").write_bytes(built_tiles.manifest_path.read_bytes())
    page = _first_page(built_tiles)
    with TestClient(create_app(output)) as client:
        response = client.get(
            _route(page),
            headers={"If-None-Match": f'"{page["sha256"]}"'},
        )

    assert response.status_code == 503
    assert response.json()["detail"]["code"] == (
        "FLOW_FIELD_TILE_ARTIFACT_UNAVAILABLE"
    )


def test_stats_are_bounded_aggregates_without_request_history(built_tiles):
    page = _first_page(built_tiles)
    with TestClient(create_app(built_tiles.output_directory)) as client:
        client.get(_route(page))
        client.get(_route(page).replace("/t00/", "/t99/"))
        stats = client.get("/stats")

    payload = stats.json()
    assert stats.status_code == 200
    assert stats.headers["cache-control"] == "no-store"
    assert payload["tileRequests"] == 2
    assert payload["tileSuccesses"] == 1
    assert payload["tileNotFound"] == 1
    assert payload["tileFailures"] == 0
    assert payload["bytesServed"] == page["byteLength"]
    assert set(payload["matrixReads"]) == {str(level) for level in range(4, 10)}
    assert set(payload["timeReads"]) == {"t00", "t01"}
    assert "history" not in payload
    assert "requestHistory" not in payload


def test_service_refuses_a_stale_builder_manifest(built_tiles, tmp_path):
    output = tmp_path / "stale"
    output.mkdir()
    manifest = json.loads(built_tiles.manifest_path.read_text(encoding="utf-8"))
    manifest["construction"]["algorithmVersion"] = "flow-rg32f-wmq-v1"
    output.joinpath("manifest.json").write_text(json.dumps(manifest), encoding="utf-8")

    try:
        create_app(output)
    except ValueError as error:
        assert "construction contract" in str(error)
    else:
        raise AssertionError("service accepted a stale construction contract")
