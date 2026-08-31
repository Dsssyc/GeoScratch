from __future__ import annotations

import hashlib
import json

import numpy as np
import pytest

from geoscratch_flow_field_tiles import SourceAuthority, source_descriptor_hash
from geoscratch_flow_field_tiles.descriptor import (
    generate_source_descriptor,
    main as descriptor_main,
)
from geoscratch_flow_field_tiles.source import read_source_descriptor


def _write_pairs(path, values) -> str:
    payload = np.asarray(values, dtype="<f4").tobytes(order="C")
    path.write_bytes(payload)
    return hashlib.sha256(payload).hexdigest()


def _source_files(tmp_path):
    source = tmp_path / "source"
    source.mkdir()
    stations = np.asarray([
        [120.0, 31.0],
        [120.1, 31.0],
        [120.0, 31.1],
        [120.1, 31.1],
    ], dtype=np.float32)
    fields = {
        10: np.asarray([[2, 1], [3, 2], [4, 3], [5, 4]], dtype=np.float32),
        2: np.asarray([[1, 2], [2, 3], [3, 4], [4, 5]], dtype=np.float32),
    }
    station_hash = _write_pairs(source / "station.bin", stations)
    field_hashes = {
        index: _write_pairs(source / f"uv_{index}.bin", values)
        for index, values in fields.items()
    }
    return source, station_hash, field_hashes


def test_generator_discovers_velocity_files_in_numeric_order_without_claiming_semantics(
    tmp_path,
):
    source, station_hash, field_hashes = _source_files(tmp_path)
    output = tmp_path / "generated.json"

    result = generate_source_descriptor(
        source,
        output,
        dataset_id="generated-flow",
        source_revision="generated-v1",
    )

    raw = json.loads(output.read_text(encoding="utf-8"))
    assert raw["schemaVersion"] == 3
    assert raw["stationCount"] == 4
    assert raw["station"] == {"file": "station.bin", "sha256": station_hash}
    assert [field["file"] for field in raw["fields"]] == ["uv_2.bin", "uv_10.bin"]
    assert [field["timeIndex"] for field in raw["fields"]] == [0, 1]
    assert [field["modelTime"] for field in raw["fields"]] == [2, 10]
    assert [field["sha256"] for field in raw["fields"]] == [
        field_hashes[2],
        field_hashes[10],
    ]
    assert raw["unit"] == "unspecified"
    assert raw["basis"] == "unspecified"
    assert raw["timeUnit"] == "unspecified"
    assert raw["phase"] == "unspecified"
    assert raw["authority"] == SourceAuthority().manifest()
    assert raw["topology"]["kind"] == "delaunay"
    assert raw["topology"]["duplicatePolicy"] == "error"
    assert result.descriptor_sha256 == hashlib.sha256(output.read_bytes()).hexdigest()
    assert result.source_hash == source_descriptor_hash(result.descriptor)


def test_generator_cli_accepts_explicit_semantics_times_and_authority(
    tmp_path,
    capsys,
):
    source, _station_hash, _field_hashes = _source_files(tmp_path)
    output = tmp_path / "explicit.json"

    descriptor_main([
        "--source", str(source),
        "--output", str(output),
        "--dataset-id", "authoritative-flow",
        "--source-revision", "model-run-7",
        "--model-times", "0.25,1.5",
        "--unit", "meter-per-second",
        "--basis", "east-north",
        "--time-unit", "hour",
        "--phase", "cold-start",
        "--unit-authority", "authoritative",
        "--basis-authority", "authoritative",
        "--time-authority", "authoritative",
        "--phase-authority", "authoritative",
        "--duplicate-policy", "mean",
        "--maximum-edge-length-meters", "5000",
    ])

    descriptor = read_source_descriptor(output)
    terminal = json.loads(capsys.readouterr().out)
    assert [field.model_time for field in descriptor.fields] == [0.25, 1.5]
    assert descriptor.unit == "meter-per-second"
    assert descriptor.basis == "east-north"
    assert descriptor.time_unit == "hour"
    assert descriptor.phase == "cold-start"
    assert descriptor.authority == SourceAuthority(
        unit="authoritative",
        basis="authoritative",
        time="authoritative",
        phase="authoritative",
        topology="inferred",
    )
    assert descriptor.topology.duplicate_policy == "mean"
    assert descriptor.topology.maximum_edge_length_meters == 5_000.0
    assert terminal["descriptor"] == str(output)
    assert terminal["stationCount"] == 4
    assert terminal["fieldCount"] == 2


@pytest.mark.parametrize("failure", ("station-nan", "velocity-nan", "wrong-count"))
def test_generator_rejects_invalid_pair_payloads(tmp_path, failure):
    source, _station_hash, _field_hashes = _source_files(tmp_path)
    if failure == "station-nan":
        values = np.fromfile(source / "station.bin", dtype="<f4")
        values[0] = np.nan
        source.joinpath("station.bin").write_bytes(values.tobytes())
    elif failure == "velocity-nan":
        values = np.fromfile(source / "uv_2.bin", dtype="<f4")
        values[0] = np.inf
        source.joinpath("uv_2.bin").write_bytes(values.tobytes())
    else:
        source.joinpath("uv_2.bin").write_bytes(np.zeros(6, dtype="<f4").tobytes())

    with pytest.raises(ValueError, match="finite float32 pairs|pair count mismatch"):
        generate_source_descriptor(
            source,
            tmp_path / "invalid.json",
            dataset_id="invalid-flow",
            source_revision="invalid-v1",
        )


def test_generator_rejects_ambiguous_numeric_velocity_names(tmp_path):
    source, _station_hash, _field_hashes = _source_files(tmp_path)
    source.joinpath("uv_02.bin").write_bytes(source.joinpath("uv_2.bin").read_bytes())

    with pytest.raises(ValueError, match="repeat numeric index 2"):
        generate_source_descriptor(
            source,
            tmp_path / "ambiguous.json",
            dataset_id="ambiguous-flow",
            source_revision="ambiguous-v1",
        )


def test_generator_refuses_existing_output_without_explicit_overwrite(tmp_path):
    source, _station_hash, _field_hashes = _source_files(tmp_path)
    output = tmp_path / "descriptor.json"
    output.write_text("user data", encoding="utf-8")

    with pytest.raises(FileExistsError, match="already exists"):
        generate_source_descriptor(
            source,
            output,
            dataset_id="generated-flow",
            source_revision="generated-v1",
        )
    assert output.read_text(encoding="utf-8") == "user data"

    generate_source_descriptor(
        source,
        output,
        dataset_id="generated-flow",
        source_revision="generated-v1",
        overwrite=True,
    )
    assert read_source_descriptor(output).schema_version == 3


@pytest.mark.parametrize("filename", ("station.bin", "uv_2.bin"))
def test_generator_never_overwrites_station_or_velocity_input(
    tmp_path,
    filename,
):
    source, _station_hash, _field_hashes = _source_files(tmp_path)
    output = source / filename
    original = output.read_bytes()

    with pytest.raises(ValueError, match="cannot replace station or velocity input"):
        generate_source_descriptor(
            source,
            output,
            dataset_id="generated-flow",
            source_revision="generated-v1",
            overwrite=True,
        )

    assert output.read_bytes() == original
