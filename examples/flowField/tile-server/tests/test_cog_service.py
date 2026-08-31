from __future__ import annotations

import hashlib
import json
import os
import shutil

import pytest
from fastapi.testclient import TestClient

from geoscratch_flow_field_tiles.cog import CogBuildBudget
from geoscratch_flow_field_tiles.cog_tiles import CogVelocityTileReader
from geoscratch_flow_field_tiles.collection import (
    CogCollectionBudget,
    build_velocity_cog_collection,
)
from geoscratch_flow_field_tiles.resolution import StationSpacingResolution
from geoscratch_flow_field_tiles.service import create_app


def _resolution() -> StationSpacingResolution:
    return StationSpacingResolution(
        minimum_support_points=3,
        minimum_support_fraction=0.10,
        minimum_matrix=9,
        maximum_matrix=9,
    )


def _snapshot_budget() -> CogBuildBudget:
    return CogBuildBudget(
        max_blocks=128,
        max_raw_pyramid_bytes=256 * 1024 * 1024,
        max_staged_bytes=64 * 1024 * 1024,
        minimum_free_bytes=32 * 1024 * 1024,
    )


@pytest.fixture(scope="module")
def served_collection(synthetic_source, tmp_path_factory):
    output = tmp_path_factory.mktemp("flow-cog-service") / "cog-collection"
    return build_velocity_cog_collection(
        synthetic_source.directory,
        output,
        time_indices=(0, 1),
        descriptor_path=synthetic_source.descriptor_path,
        resolution=_resolution(),
        snapshot_budget=_snapshot_budget(),
        collection_budget=CogCollectionBudget(
            max_collection_bytes=1024**3,
            estimated_snapshot_bytes=4 * 1024 * 1024,
        ),
    )


def _manifests(served_collection):
    collection = json.loads(
        served_collection.manifest_path.read_text(encoding="utf-8")
    )
    runtime = json.loads(
        served_collection.runtime_manifest_path.read_text(encoding="utf-8")
    )
    return collection, runtime


def _route(page):
    return "/" + page["path"]


def test_collection_health_and_runtime_manifest_contract(served_collection):
    collection, runtime = _manifests(served_collection)
    runtime_bytes = served_collection.runtime_manifest_path.read_bytes()
    with TestClient(create_app(served_collection.output_directory)) as client:
        health = client.get("/health")
        manifest = client.get(
            "/manifest.json",
            headers={"Origin": "http://localhost:5173"},
        )
        conditional = client.get(
            "/manifest.json",
            headers={"If-None-Match": manifest.headers["etag"]},
        )

    assert health.status_code == 200
    assert health.json() == {
        "status": "ok",
        "contentVersion": collection["contentVersion"],
        "pageCount": len(runtime["pages"]),
        "particleSimulation": "not-approved",
        "backend": "cog-collection",
    }
    assert manifest.status_code == 200
    assert manifest.content == runtime_bytes
    assert manifest.json() == runtime
    assert manifest.headers["cache-control"] == "public, max-age=31536000, immutable"
    assert manifest.headers["access-control-allow-origin"] == "*"
    assert conditional.status_code == 304
    assert conditional.content == b""


def test_collection_tile_is_read_from_cog_and_matches_runtime_page_identity(
    served_collection,
):
    collection, runtime = _manifests(served_collection)
    page = next(
        record
        for record in runtime["pages"]
        if record["timeIndex"] == 1 and record["matrixId"] == "8"
    )
    snapshot = collection["snapshots"][1]
    reader = CogVelocityTileReader(
        served_collection.output_directory / snapshot["manifestPath"],
        served_collection.output_directory / snapshot["cogPath"],
    )
    expected = reader.read_tile(
        page["matrixId"],
        page["tileRow"],
        page["tileCol"],
    )

    with TestClient(create_app(served_collection.output_directory)) as client:
        response = client.get(_route(page), headers={"Range": "bytes=0-99"})
        conditional = client.get(
            _route(page),
            headers={"If-None-Match": response.headers["etag"]},
        )
        direct_cog = client.get("/snapshots/t01/flow-t01.cog.tif")

    assert response.status_code == 200
    assert response.content == expected.content
    assert len(response.content) == page["byteLength"] == 524_288
    assert hashlib.sha256(response.content).hexdigest() == page["sha256"]
    assert expected.maximum_speed == page["maximumSpeed"]
    assert response.headers["content-type"] == "application/vnd.geoscratch.flow-rg32f"
    assert response.headers["etag"] == f'"{page["sha256"]}"'
    assert response.headers["cache-control"] == "public, max-age=31536000, immutable"
    assert "accept-ranges" not in response.headers
    assert "content-range" not in response.headers
    assert conditional.status_code == 304
    assert conditional.content == b""
    assert direct_cog.status_code == 404


def test_collection_service_keeps_structured_404_and_bounded_cog_stats(
    served_collection,
):
    _collection, runtime = _manifests(served_collection)
    page = runtime["pages"][0]
    missing = _route(page).replace("/t00/", "/t99/")

    with TestClient(create_app(served_collection.output_directory)) as client:
        success = client.get(_route(page))
        conditional = client.get(
            _route(page),
            headers={"If-None-Match": success.headers["etag"]},
        )
        not_found = client.get(missing)
        stats = client.get("/stats")

    assert success.status_code == 200
    assert conditional.status_code == 304
    assert not_found.status_code == 404
    assert not_found.json()["detail"]["code"] == "FLOW_FIELD_TILE_OUT_OF_RANGE"
    assert stats.json() == {
        "tileRequests": 3,
        "tileSuccesses": 1,
        "tileNotFound": 1,
        "tileFailures": 0,
        "tileNotModified": 1,
        "cogWindowReads": 1,
        "bytesServed": page["byteLength"],
        "matrixReads": {
            str(matrix): int(str(matrix) == page["matrixId"])
            for matrix in range(4, 10)
        },
        "timeReads": {"t00": 1, "t01": 0},
    }


@pytest.mark.parametrize("change", ("missing", "fingerprint"))
def test_conditional_request_cannot_hide_missing_or_changed_cog(
    served_collection,
    tmp_path,
    change,
):
    output = tmp_path / "cog-collection"
    shutil.copytree(served_collection.output_directory, output)
    collection = json.loads(output.joinpath("manifest.json").read_text(encoding="utf-8"))
    runtime = json.loads(
        output.joinpath("runtime-manifest.json").read_text(encoding="utf-8")
    )
    page = runtime["pages"][0]
    snapshot = collection["snapshots"][page["timeIndex"]]
    cog_path = output / snapshot["cogPath"]
    app = create_app(output)
    if change == "missing":
        cog_path.unlink()
    else:
        stat = cog_path.stat()
        os.utime(
            cog_path,
            ns=(stat.st_atime_ns, stat.st_mtime_ns + 1_000_000),
        )

    with TestClient(app) as client:
        response = client.get(
            _route(page),
            headers={"If-None-Match": f'"{page["sha256"]}"'},
        )

    assert response.status_code == 503
    assert response.json()["detail"]["code"] == (
        "FLOW_FIELD_TILE_ARTIFACT_UNAVAILABLE"
    )


def test_collection_service_rejects_invalid_window_concurrency(served_collection):
    with pytest.raises(ValueError, match="max_window_reads"):
        create_app(served_collection.output_directory, max_cog_window_reads=0)
