from __future__ import annotations

import hashlib
import json
import shutil

import numpy as np
import pytest
import rasterio
from rio_cogeo.cogeo import cog_validate

import geoscratch_flow_field_tiles.cog as cog_module
from geoscratch_flow_field_tiles.cog import (
    COG_ARTIFACT_MARKER,
    build_velocity_cog_snapshot,
    verify_velocity_cog_snapshot,
)
from geoscratch_flow_field_tiles.resolution import (
    FixedWebMercatorResolution,
    StationSpacingResolution,
)
from geoscratch_flow_field_tiles.contracts import TriangleLinearInterpolation


class RecordingProgressSink:
    def __init__(self):
        self.events = []

    def emit(self, event):
        self.events.append(event)


class FailingProgressSink:
    def __init__(self, stage, event):
        self.stage = stage
        self.event = event

    def emit(self, value):
        if value.stage == self.stage and value.event == self.event:
            raise RuntimeError("progress sink failed")


def _test_resolution() -> StationSpacingResolution:
    return StationSpacingResolution(
        minimum_support_points=3,
        minimum_support_fraction=0.10,
        minimum_matrix=9,
        maximum_matrix=9,
    )


def _test_cog_budget():
    return cog_module.CogBuildBudget(
        max_blocks=128,
        max_raw_pyramid_bytes=256 * 1024 * 1024,
        max_staged_bytes=64 * 1024 * 1024,
        minimum_free_bytes=32 * 1024 * 1024,
    )


def _base_batch_inputs(synthetic_source, output_parent):
    snapshots = tuple(
        cog_module.load_source_snapshot(
            synthetic_source.directory,
            time_index=time_index,
            descriptor_path=synthetic_source.descriptor_path,
        )
        for time_index in (0, 1)
    )
    budget = _test_cog_budget()
    plan = cog_module.plan_velocity_cog_snapshot(
        snapshots[0].stations,
        snapshots[0].geographic_bounds,
        output_parent,
        resolution=_test_resolution(),
        budget=budget,
    )
    topology_spec = cog_module.resolve_topology(snapshots[0].descriptor.topology)
    interpolation = cog_module.resolve_interpolation(
        snapshots[0].descriptor.interpolation
    )
    topology = cog_module.prepare_topology(snapshots[0].stations, topology_spec)
    unique_fields = tuple(topology.aggregate_field(snapshot.field) for snapshot in snapshots)
    return snapshots, plan, topology, unique_fields, interpolation, budget


def _base_write_item(root, snapshot, unique_field, budget, progress_callback=None):
    root.mkdir(parents=True)
    return cog_module._CogBaseWriteItem(
        path=root / "base.tif",
        snapshot=snapshot,
        unique_field=unique_field,
        staging_guard=cog_module.CogStagingGuard(
            root=root,
            budget=budget,
            initial_available_bytes=shutil.disk_usage(root).free,
        ),
        progress_callback=progress_callback,
    )


def _rewrite_construction_identity(output, mutate) -> dict:
    manifest_path = output / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    mutate(manifest)
    facts = manifest["construction"]["facts"]
    construction_sha = hashlib.sha256(
        json.dumps(facts, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    manifest["construction"]["sha256"] = construction_sha
    time_index = facts["snapshot"]["timeIndex"]
    matrix_id = facts["plan"]["grid"]["matrixId"]
    content_version = (
        f"flow-cog-{construction_sha[:16]}-t{time_index:02d}-z{matrix_id}-v{manifest['schemaVersion']}"
    )
    manifest["contentVersion"] = content_version
    manifest_path.write_text(
        json.dumps(manifest, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    output.joinpath(COG_ARTIFACT_MARKER).write_text(
        json.dumps({
            "kind": "geoscratch-flow-field-cog-artifact",
            "contentVersion": content_version,
        }, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    return manifest


@pytest.fixture(scope="module")
def built_cog(synthetic_source, tmp_path_factory):
    output = tmp_path_factory.mktemp("flow-cog-parent") / "cog-cache"
    return build_velocity_cog_snapshot(
        synthetic_source.directory,
        output,
        time_index=0,
        descriptor_path=synthetic_source.descriptor_path,
        resolution=_test_resolution(),
    )


@pytest.fixture(scope="module")
def fixed_cog(synthetic_source, tmp_path_factory):
    output = tmp_path_factory.mktemp("flow-fixed-cog-parent") / "cog-cache"
    return build_velocity_cog_snapshot(
        synthetic_source.directory,
        output,
        time_index=0,
        descriptor_path=synthetic_source.descriptor_path,
        resolution=FixedWebMercatorResolution(10),
    )


def test_snapshot_builds_one_valid_two_band_float32_cog_with_semantic_overviews(
    built_cog,
):
    valid, errors, warnings = cog_validate(built_cog.cog_path, strict=True)

    assert valid, {"errors": errors, "warnings": warnings}
    assert errors == []
    with rasterio.open(built_cog.cog_path) as dataset:
        assert dataset.crs.to_string() == "EPSG:3857"
        assert dataset.count == 2
        assert dataset.dtypes == ("float32", "float32")
        assert dataset.descriptions == ("U", "V")
        assert dataset.nodata is None
        assert dataset.block_shapes == [(256, 256), (256, 256)]
        assert dataset.overviews(1) == [2]
        assert dataset.overviews(2) == [2]
        assert dataset.tags()["GEOSCRATCH_OVERVIEW_POLICY"] == (
            "recursive-zero-preserving-vector-box-v2"
        )
        assert dataset.transform.e < 0
        assert np.isfinite(dataset.read((1, 2))).all()
    with rasterio.open(built_cog.cog_path, OVERVIEW_LEVEL=0) as overview:
        assert (overview.width, overview.height) == (256, 128)
        assert np.isfinite(overview.read((1, 2))).all()


def test_cog_manifest_records_statistical_selection_and_unapproved_role(built_cog):
    manifest = json.loads(built_cog.manifest_path.read_text(encoding="utf-8"))
    marker = json.loads(
        built_cog.output_directory.joinpath(COG_ARTIFACT_MARKER).read_text(
            encoding="utf-8"
        )
    )

    assert manifest["artifactType"] == "flow-field-cog-snapshot"
    assert manifest["schemaVersion"] == 3
    assert manifest["contentVersion"] == f"flow-cog-{manifest['construction']['sha256'][:16]}-t00-z9-v3"
    assert manifest["snapshot"]["timeIndex"] == 0
    assert manifest["construction"]["facts"]["plan"]["matrixDecision"] == {
        "selectedMatrixId": "9",
        "outputMatrixId": "9",
        "relation": "statistically-selected",
    }
    assert manifest["construction"]["facts"]["encoding"]["overviewPolicy"][
        "kind"
    ] == "recursive-zero-preserving-vector-box-v2"
    assert manifest["construction"]["facts"]["encoding"]["pixelDigestLayout"] == {
        "blockOrder": "top-to-bottom-left-to-right",
        "withinBlock": "band-first-north-up-row-major",
        "sampleEncoding": "float32-le",
        "partialBlocks": "logical-window-only",
    }
    assert manifest["construction"]["facts"]["support"]["overviewLevels"][0][
        "nominalFactor"
    ] == 2
    assert manifest["preflight"]["budget"]["approved"]
    assert manifest["preflight"]["staging"]["peakStagedBytes"] > 0
    assert manifest["preflight"]["staging"]["observationCount"] > 0
    assert manifest["quality"] == {
        "artifactRole": "reconstruction-prototype",
        "particleSimulation": "not-approved",
        "approvalReason": "inferred-topology-and-source-semantics-unapproved",
    }
    assert marker == {
        "kind": "geoscratch-flow-field-cog-artifact",
        "contentVersion": manifest["contentVersion"],
    }


def test_new_cog_interpolates_zero_vertex_without_rejecting_its_entire_triangle(synthetic_source, tmp_path):
    source = tmp_path / "mixed-zero-source"
    shutil.copytree(synthetic_source.directory, source)
    descriptor_path = source / "source-dataset.json"
    descriptor = json.loads(descriptor_path.read_text())
    values = synthetic_source.fields[0].copy()
    values[0] = [0.0, 0.0]
    payload = np.asarray(values, dtype="<f4").tobytes()
    (source / descriptor["fields"][0]["file"]).write_bytes(payload)
    descriptor["fields"][0]["sha256"] = hashlib.sha256(payload).hexdigest()
    descriptor["interpolation"]["stationaryPolicy"] = "interpolate"
    descriptor_path.write_text(json.dumps(descriptor))
    outputs = []
    for policy in ("interpolate", "require-all-moving"):
        built = build_velocity_cog_snapshot(source, tmp_path / policy / "cog-cache",
            descriptor_path=descriptor_path, resolution=FixedWebMercatorResolution(10),
            interpolation=TriangleLinearInterpolation(stationary_policy=policy))
        manifest = json.loads(built.manifest_path.read_text())
        support = manifest["construction"]["facts"]["support"]
        assert manifest["schemaVersion"] == 3
        assert "bilinearSafePixelCount" not in support
        assert support["candidatePixelCount"] == support["storedNonzeroPixelCount"]
        with rasterio.open(built.cog_path) as dataset:
            outputs.append(np.any(dataset.read((1, 2)) != 0.0, axis=0))
    assert np.count_nonzero(outputs[0] & ~outputs[1]) > 0
    assert np.all(outputs[1] <= outputs[0])


def test_schema_3_float_time_and_authority_round_trip_through_cog_manifest(
    synthetic_source,
    tmp_path,
):
    raw = json.loads(synthetic_source.descriptor_path.read_text(encoding="utf-8"))
    raw.update({
        "schemaVersion": 3,
        "unit": "meter-per-second",
        "basis": "east-north",
        "timeUnit": "hour",
        "phase": "cold-start",
        "authority": {
            "unit": "authoritative",
            "basis": "authoritative",
            "time": "authoritative",
            "phase": "authoritative",
            "topology": "inferred",
        },
    })
    raw["fields"][0]["modelTime"] = 0.25
    raw["fields"][1]["modelTime"] = 1.75
    descriptor_path = tmp_path / "source-v3.json"
    descriptor_path.write_text(json.dumps(raw), encoding="utf-8")
    result = build_velocity_cog_snapshot(
        synthetic_source.directory,
        tmp_path / "v3" / "cog-cache",
        time_index=0,
        descriptor_path=descriptor_path,
        resolution=_test_resolution(),
    )

    manifest = json.loads(result.manifest_path.read_text(encoding="utf-8"))
    authority = raw["authority"]
    assert manifest["source"]["descriptorSchemaVersion"] == 3
    assert manifest["source"]["unit"] == "meter-per-second"
    assert manifest["source"]["basis"] == "east-north"
    assert manifest["source"]["timeUnit"] == "hour"
    assert manifest["source"]["phase"] == "cold-start"
    assert manifest["source"]["authority"] == authority
    assert manifest["snapshot"]["modelTime"] == 0.25
    assert manifest["snapshot"]["timeUnit"] == "hour"
    assert manifest["snapshot"]["authority"] == authority
    assert verify_velocity_cog_snapshot(result.output_directory)["contentVersion"] == (
        result.content_version
    )


def test_cog_verifier_checks_container_and_pixel_identity(built_cog):
    facts = verify_velocity_cog_snapshot(built_cog.output_directory)

    assert facts["contentVersion"] == built_cog.content_version
    assert facts["cogSha256"] == built_cog.cog_sha256
    assert facts["matrixId"] == "9"
    assert facts["particleSimulation"] == "not-approved"


def test_fixed_resolution_build_round_trips_through_deep_verification(fixed_cog):
    manifest = json.loads(fixed_cog.manifest_path.read_text(encoding="utf-8"))
    plan = manifest["construction"]["facts"]["plan"]

    assert plan["resolution"]["requested"] == {
        "kind": "fixed-web-mercator-matrix",
        "matrixSet": "WebMercatorQuad",
        "matrixId": "10",
    }
    assert plan["matrixDecision"] == {
        "selectedMatrixId": "10",
        "outputMatrixId": "10",
        "relation": "explicitly-requested",
    }
    assert verify_velocity_cog_snapshot(fixed_cog.output_directory)["matrixId"] == "10"


@pytest.mark.parametrize("field", ("requested", "resolved", "matrixDecision"))
def test_verifier_rejects_self_consistent_fixed_resolution_tampering(
    fixed_cog,
    tmp_path,
    field,
):
    output = tmp_path / field / "cog-cache"
    output.parent.mkdir()
    shutil.copytree(fixed_cog.output_directory, output)

    def mutate(manifest):
        plan = manifest["construction"]["facts"]["plan"]
        if field == "requested":
            plan["resolution"]["requested"]["matrixId"] = "09"
        elif field == "resolved":
            plan["resolution"]["resolved"]["matrixPixelSizeMeters"] += 1.0
        else:
            plan["matrixDecision"]["relation"] = "statistically-selected"

    _rewrite_construction_identity(output, mutate)

    with pytest.raises(ValueError, match="resolution|matrix decision"):
        verify_velocity_cog_snapshot(output)


def test_repeated_snapshot_build_preserves_pixels_and_content_identity(
    built_cog,
    synthetic_source,
    tmp_path,
    capsys,
):
    rebuilt = build_velocity_cog_snapshot(
        synthetic_source.directory,
        tmp_path / "cog-cache",
        time_index=0,
        descriptor_path=synthetic_source.descriptor_path,
        resolution=_test_resolution(),
    )

    assert capsys.readouterr() == ("", "")
    assert rebuilt.content_version == built_cog.content_version
    assert rebuilt.cog_sha256 == built_cog.cog_sha256
    assert rebuilt.cog_size_bytes == built_cog.cog_size_bytes
    with rasterio.open(built_cog.cog_path) as first, rasterio.open(rebuilt.cog_path) as second:
        assert first.profile == second.profile
        assert first.tags() == second.tags()
        assert first.overviews(1) == second.overviews(1)
        assert np.array_equal(first.read((1, 2)), second.read((1, 2)))
    with (
        rasterio.open(built_cog.cog_path, OVERVIEW_LEVEL=0) as first,
        rasterio.open(rebuilt.cog_path, OVERVIEW_LEVEL=0) as second,
    ):
        assert np.array_equal(first.read((1, 2)), second.read((1, 2)))


def test_batch_base_writer_reuses_spatial_stencils_and_preserves_each_snapshot(
    synthetic_source,
    tmp_path,
    monkeypatch,
):
    snapshots, plan, topology, unique_fields, interpolation, budget = (
        _base_batch_inputs(synthetic_source, tmp_path)
    )
    real_centers = cog_module._cog_pixel_centers_window
    real_prepare = cog_module.prepare_triangle_linear_stencil
    real_apply = cog_module.apply_pixel_center_block
    calls = {"centers": 0, "prepare": 0, "apply": 0}

    def counted_centers(*args, **kwargs):
        calls["centers"] += 1
        return real_centers(*args, **kwargs)

    def counted_prepare(*args, **kwargs):
        calls["prepare"] += 1
        return real_prepare(*args, **kwargs)

    def counted_apply(*args, **kwargs):
        calls["apply"] += 1
        return real_apply(*args, **kwargs)

    monkeypatch.setattr(cog_module, "_cog_pixel_centers_window", counted_centers)
    monkeypatch.setattr(cog_module, "prepare_triangle_linear_stencil", counted_prepare)
    monkeypatch.setattr(cog_module, "apply_pixel_center_block", counted_apply)

    sequential_items = tuple(
        _base_write_item(
            tmp_path / "sequential" / f"t{time_index:02d}",
            snapshot,
            unique_field,
            budget,
        )
        for time_index, (snapshot, unique_field) in enumerate(
            zip(snapshots, unique_fields, strict=True)
        )
    )
    sequential_support = tuple(
        cog_module._write_intermediate_tiff(
            item.path,
            item.snapshot,
            plan,
            topology,
            item.unique_field,
            interpolation,
            cog_module.CogEncoding(),
            item.staging_guard,
            item.progress_callback,
        )
        for item in sequential_items
    )
    assert calls == {
        "centers": plan.grid.block_count * 2,
        "prepare": plan.grid.block_count * 2,
        "apply": plan.grid.block_count * 2,
    }

    calls.update(centers=0, prepare=0, apply=0)
    batch_progress = ([], [])
    batch_items = tuple(
        _base_write_item(
            tmp_path / "batch" / f"t{time_index:02d}",
            snapshot,
            unique_field,
            budget,
            lambda completed, total, records=batch_progress[time_index]: records.append(
                (completed, total)
            ),
        )
        for time_index, (snapshot, unique_field) in enumerate(
            zip(snapshots, unique_fields, strict=True)
        )
    )
    batch_support = cog_module._write_intermediate_tiff_batch(
        batch_items,
        plan,
        topology,
        interpolation,
        cog_module.CogEncoding(),
    )

    assert calls == {
        "centers": plan.grid.block_count,
        "prepare": plan.grid.block_count,
        "apply": plan.grid.block_count * 2,
    }
    assert batch_support == sequential_support
    assert batch_progress == (
        [(plan.grid.block_count, plan.grid.block_count)],
        [(plan.grid.block_count, plan.grid.block_count)],
    )
    for sequential, batch in zip(sequential_items, batch_items, strict=True):
        assert (
            batch.staging_guard.observation_count
            == sequential.staging_guard.observation_count
        )
        with rasterio.open(sequential.path) as expected, rasterio.open(batch.path) as actual:
            assert actual.profile == expected.profile
            assert actual.tags() == expected.tags()
            assert actual.tags(1) == expected.tags(1)
            assert actual.tags(2) == expected.tags(2)
            assert np.array_equal(actual.read((1, 2)), expected.read((1, 2)))


def test_batch_base_writer_closes_and_removes_every_output_on_failure(
    synthetic_source,
    tmp_path,
    monkeypatch,
):
    snapshots, plan, topology, unique_fields, interpolation, budget = (
        _base_batch_inputs(synthetic_source, tmp_path)
    )
    items = tuple(
        _base_write_item(
            tmp_path / "failure" / f"t{time_index:02d}",
            snapshot,
            unique_field,
            budget,
        )
        for time_index, (snapshot, unique_field) in enumerate(
            zip(snapshots, unique_fields, strict=True)
        )
    )
    real_apply = cog_module.apply_pixel_center_block
    real_rasterio_open = cog_module.rasterio.open
    apply_count = 0
    opened_writers = []

    def record_open_writer(*args, **kwargs):
        writer = real_rasterio_open(*args, **kwargs)
        opened_writers.append(writer)
        return writer

    def fail_second_apply(*args, **kwargs):
        nonlocal apply_count
        apply_count += 1
        if apply_count == 2:
            raise RuntimeError("synthetic batch base failure")
        return real_apply(*args, **kwargs)

    monkeypatch.setattr(cog_module.rasterio, "open", record_open_writer)
    monkeypatch.setattr(cog_module, "apply_pixel_center_block", fail_second_apply)

    with pytest.raises(RuntimeError, match="synthetic batch base failure"):
        cog_module._write_intermediate_tiff_batch(
            items,
            plan,
            topology,
            interpolation,
            cog_module.CogEncoding(),
        )

    assert apply_count == 2
    assert len(opened_writers) == 2
    assert all(writer.closed for writer in opened_writers)
    assert all(not item.path.exists() for item in items)


def test_snapshot_build_reports_ordered_structured_stage_progress(
    synthetic_source,
    tmp_path,
):
    sink = RecordingProgressSink()
    result = build_velocity_cog_snapshot(
        synthetic_source.directory,
        tmp_path / "progress" / "cog-cache",
        time_index=0,
        descriptor_path=synthetic_source.descriptor_path,
        resolution=_test_resolution(),
        progress=sink,
        job_id="snapshot-job-7",
    )

    assert result.content_version.endswith("-t00-z9-v3")
    assert [event.sequence for event in sink.events] == list(
        range(1, len(sink.events) + 1)
    )
    assert all(event.job_id == "snapshot-job-7" for event in sink.events)
    expected_stages = [
        "source",
        "planning",
        "topology",
        "base",
        "overview-00",
        "cog-copy",
        "semantic-verification",
        "manifest",
        "install",
    ]
    assert list(dict.fromkeys(event.stage for event in sink.events)) == expected_stages
    for stage in expected_stages:
        stage_events = [event for event in sink.events if event.stage == stage]
        assert stage_events[0].event == "stage.started"
        assert any(event.event == "stage.progress" for event in stage_events)
        assert stage_events[-1].event == "stage.completed"
        progress_events = [
            event for event in stage_events if event.event == "stage.progress"
        ]
        assert all(event.completed <= event.total for event in progress_events)
    base_progress = [
        event
        for event in sink.events
        if event.stage == "base" and event.event == "stage.progress"
    ]
    assert base_progress[-1].completed == base_progress[-1].total == 2


def test_progress_sink_failure_before_install_leaves_no_artifact(
    synthetic_source,
    tmp_path,
):
    output = tmp_path / "preinstall-failure" / "cog-cache"

    with pytest.raises(RuntimeError, match="progress sink failed"):
        build_velocity_cog_snapshot(
            synthetic_source.directory,
            output,
            time_index=0,
            descriptor_path=synthetic_source.descriptor_path,
            resolution=_test_resolution(),
            progress=FailingProgressSink("manifest", "stage.completed"),
            job_id="failed-before-install",
        )

    assert not output.exists()


def test_finalizer_failure_preserves_prepared_inputs_and_cleans_staging(
    synthetic_source,
    tmp_path,
    monkeypatch,
):
    output = tmp_path / "finalizer-failure" / "cog-cache"
    captured = {}

    def fail_finalizer(**kwargs):
        captured.update(kwargs)
        assert kwargs["source_tiff"].is_file()
        raise RuntimeError("synthetic finalizer failure")

    monkeypatch.setattr(
        cog_module,
        "_finalize_velocity_cog_snapshot",
        fail_finalizer,
    )

    with pytest.raises(RuntimeError, match="synthetic finalizer failure"):
        build_velocity_cog_snapshot(
            synthetic_source.directory,
            output,
            time_index=0,
            descriptor_path=synthetic_source.descriptor_path,
            resolution=_test_resolution(),
        )

    assert set(captured) == {
        "snapshot",
        "plan",
        "prepared_topology",
        "duplicate_statistics",
        "interpolation",
        "encoding",
        "staging_guard",
        "staged",
        "output",
        "source_tiff",
        "support",
        "emitter",
    }
    assert captured["snapshot"].field_descriptor.time_index == 0
    assert captured["plan"].grid.matrix_id == 9
    assert captured["prepared_topology"].source_station_count == 4
    assert captured["duplicate_statistics"].location_count == 0
    assert captured["interpolation"].kind == "triangle-linear"
    assert captured["encoding"] == cog_module.CogEncoding()
    assert captured["staging_guard"].root == captured["staged"]
    assert captured["source_tiff"].parent == captured["staged"]
    assert captured["output"] == output
    assert captured["support"]["pixelSha256"]
    assert captured["emitter"].time_index == 0
    assert not output.exists()
    assert tuple(output.parent.glob(".cog-cache.build-*")) == ()


def test_snapshot_cleanup_preserves_a_recreated_active_staging_path(
    synthetic_source,
    tmp_path,
    monkeypatch,
):
    output = tmp_path / "recreated-staging" / "cog-cache"
    recreated = None

    def replace_staging_then_fail(**kwargs):
        nonlocal recreated
        staged = kwargs["staged"]
        moved = staged.with_name(f"{staged.name}.moved")
        staged.rename(moved)
        staged.mkdir()
        staged.joinpath("belongs-to-later-work.txt").write_text(
            "preserve me\n",
            encoding="utf-8",
        )
        recreated = staged
        raise RuntimeError("synthetic recreated staging failure")

    monkeypatch.setattr(
        cog_module,
        "_finalize_velocity_cog_snapshot",
        replace_staging_then_fail,
    )

    with pytest.raises(RuntimeError, match="recreated staging failure"):
        build_velocity_cog_snapshot(
            synthetic_source.directory,
            output,
            time_index=0,
            descriptor_path=synthetic_source.descriptor_path,
            resolution=_test_resolution(),
        )

    assert recreated is not None
    assert recreated.joinpath("belongs-to-later-work.txt").read_text(
        encoding="utf-8"
    ) == "preserve me\n"
    assert not output.exists()


def test_progress_sink_failure_during_install_rolls_back_previous_artifact(
    synthetic_source,
    tmp_path,
):
    output = tmp_path / "install-failure" / "cog-cache"
    original = build_velocity_cog_snapshot(
        synthetic_source.directory,
        output,
        time_index=0,
        descriptor_path=synthetic_source.descriptor_path,
        resolution=_test_resolution(),
    )
    original_manifest = original.manifest_path.read_bytes()

    with pytest.raises(RuntimeError, match="progress sink failed"):
        build_velocity_cog_snapshot(
            synthetic_source.directory,
            output,
            time_index=0,
            descriptor_path=synthetic_source.descriptor_path,
            resolution=_test_resolution(),
            progress=FailingProgressSink("install", "stage.completed"),
            job_id="failed-during-install",
        )

    assert original.manifest_path.read_bytes() == original_manifest
    assert verify_velocity_cog_snapshot(output)["contentVersion"] == (
        original.content_version
    )


def test_verifier_rejects_self_consistent_path_traversal(built_cog, tmp_path):
    output = tmp_path / "cog-cache"
    shutil.copytree(built_cog.output_directory, output)
    shutil.copy2(built_cog.cog_path, tmp_path / "external.cog.tif")
    _rewrite_construction_identity(
        output,
        lambda manifest: manifest["construction"]["facts"]["cog"].update({
            "path": "../external.cog.tif",
        }),
    )

    with pytest.raises(ValueError, match="ownership"):
        verify_velocity_cog_snapshot(output)


@pytest.mark.parametrize("filename", (COG_ARTIFACT_MARKER, "manifest.json"))
def test_verifier_rejects_symlinked_snapshot_identity_files(
    built_cog,
    tmp_path,
    filename,
):
    output = tmp_path / "cog-cache"
    shutil.copytree(built_cog.output_directory, output)
    path = output / filename
    external = tmp_path / f"external-{filename.lstrip('.')}"
    path.rename(external)
    path.symlink_to(external)
    original = external.read_bytes()

    with pytest.raises(ValueError, match="ownership"):
        verify_velocity_cog_snapshot(output)

    assert path.is_symlink()
    assert external.read_bytes() == original


def test_verifier_rejects_a_snapshot_root_symlink(built_cog, tmp_path):
    alias = tmp_path / "cog-cache-alias"
    alias.symlink_to(built_cog.output_directory, target_is_directory=True)

    with pytest.raises(ValueError, match="ownership"):
        verify_velocity_cog_snapshot(alias)

    assert alias.is_symlink()


def test_verifier_rejects_self_consistent_false_validation_facts(
    built_cog,
    tmp_path,
):
    output = tmp_path / "cog-cache"
    shutil.copytree(built_cog.output_directory, output)
    _rewrite_construction_identity(
        output,
        lambda manifest: manifest["construction"]["facts"]["cog"].update({
            "overviewCount": 0,
        }),
    )

    with pytest.raises(ValueError, match="validation facts"):
        verify_velocity_cog_snapshot(output)


@pytest.mark.parametrize("scope", ("base", "overview"))
def test_verifier_rejects_self_consistent_false_support_counts(
    built_cog,
    tmp_path,
    scope,
):
    output = tmp_path / scope / "cog-cache"
    output.parent.mkdir()
    shutil.copytree(built_cog.output_directory, output)

    def mutate(manifest):
        support = manifest["construction"]["facts"]["support"]
        if scope == "base":
            support["storedNonzeroPixelCount"] += 1
        else:
            support["overviewLevels"][0]["storedNonzeroPixelCount"] += 1

    _rewrite_construction_identity(output, mutate)

    with pytest.raises(ValueError, match="support"):
        verify_velocity_cog_snapshot(output)


def test_replacement_refuses_owned_marker_with_unrelated_residue(
    built_cog,
    synthetic_source,
    tmp_path,
):
    output = tmp_path / "cog-cache"
    shutil.copytree(built_cog.output_directory, output)
    residue = output / "notes.txt"
    residue.write_text("belongs to the user\n", encoding="utf-8")

    with pytest.raises(ValueError, match="unowned"):
        build_velocity_cog_snapshot(
            synthetic_source.directory,
            output,
            time_index=0,
            descriptor_path=synthetic_source.descriptor_path,
            resolution=_test_resolution(),
        )

    assert residue.read_text(encoding="utf-8") == "belongs to the user\n"


def test_successful_snapshot_replacement_retains_the_previous_owned_backup(
    synthetic_source,
    tmp_path,
):
    output = tmp_path / "cog-cache"
    first = build_velocity_cog_snapshot(
        synthetic_source.directory,
        output,
        time_index=0,
        descriptor_path=synthetic_source.descriptor_path,
        resolution=_test_resolution(),
    )
    second = build_velocity_cog_snapshot(
        synthetic_source.directory,
        output,
        time_index=1,
        descriptor_path=synthetic_source.descriptor_path,
        resolution=_test_resolution(),
    )

    backup = second.replaced_backup_directory
    assert backup is not None and backup.is_dir()
    assert verify_velocity_cog_snapshot(backup)["contentVersion"] == (
        first.content_version
    )
    assert verify_velocity_cog_snapshot(output)["contentVersion"] == (
        second.content_version
    )


def test_snapshot_install_preserves_a_dangling_target_that_appears_later(
    synthetic_source,
    tmp_path,
):
    output = tmp_path / "cog-cache"

    class InjectDanglingTarget:
        def emit(self, event):
            if event.event == "stage.started" and event.stage == "install":
                output.symlink_to(tmp_path / "missing-target", target_is_directory=True)

    with pytest.raises(ValueError, match="changed to unowned content"):
        build_velocity_cog_snapshot(
            synthetic_source.directory,
            output,
            time_index=0,
            descriptor_path=synthetic_source.descriptor_path,
            resolution=_test_resolution(),
            progress=InjectDanglingTarget(),
        )

    assert output.is_symlink()
    assert not output.exists()
    assert tuple(tmp_path.glob(".cog-cache.build-*")) == ()
