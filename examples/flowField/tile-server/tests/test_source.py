from __future__ import annotations

import hashlib
import json

import numpy as np
import pytest

import geoscratch_flow_field_tiles.source as source_module
from geoscratch_flow_field_tiles import (
    DelaunayTopology,
    TriangleLinearInterpolation,
)
from geoscratch_flow_field_tiles.source import (
    SourceAuthority,
    load_source_dataset,
    load_source_snapshot,
    read_source_descriptor,
    source_descriptor_hash,
)


EXPECTED_STATION_HASH = (
    "1d50f140b8333b78d0c2784a3a85ede2cc3f0085bdb923a0fd3d7d7334409ec1"
)
EXPECTED_FIELD_HASHES = (
    "75d47f2e64178530ba36302e135046768db09edb30040ee5f8bd69426babb81d",
    "6368fccc436309e594f5813e2cba38aa316efafcd924c80ba8bcfc62a4606648",
    "0adf5f0fe1dec72d66a76fac9b0d1a8afad56946b03f9e7da951a56710b5530b",
    "d6d6db6e5ed8fe14ff2d823d1a5c9e7a4c112a83a1cbd0f4ff52c3e29102325d",
    "10d3cc1d1a2681d1e3f5363ae29f42be0e768d95bd7635c11c9f13b087ae816a",
    "c598c9ebca8bad56eafe71102593aa3b3a121250eb9e509d139d1655d25fae8b",
    "b191404c6cb1dc88ad69c64abad85d3a188c30ff3874e3f532fd932a8c29e33b",
    "3794f7e19ccffa9180d78ec0611c2ce314648b42cdbe45904172801168907978",
    "30a649009bc739b5818d0e4039d4bf2e28931c7ae9c58a5905b6f901bff6d80d",
    "cd83e7a864adc031907568b4a62d0ca5c3bcee66caed5f20fdabd1b066d0f648",
    "a5020f32818ab0d1ec290ee4be9263768d1182d5a2f27966f893aa6b538ebb58",
    "3430eea7ac25a630a4a8fb49c19c43a8c73bb47886a5717cab718d4ada873c43",
    "a362bd8b5ba8be8e04eac625f357acd17e121558131cfe9456d5b14ca49ac699",
    "7e7ebec339d629ae82010b5f2dc4c7c778fbcd33fb669ce1b78633c1712dd460",
    "ff79711c754d831435bb3c8e314b9f62491407c48714bb50fed537aca6b34473",
    "5a94a1b0803d98cc9791a25b93205e419af9b0240be17ae3403dc8b2fefe97c2",
    "9137a3dc0a1097c67bb3697908075e12f148cd8aa5004c7add7b2ae9bd54f404",
    "4889b0249f945c2aa86236df4e0c040862de2118efa10b115d502530432a6cfe",
    "449a8ed5964c395c4630b3992fb5c103984ef07afb12239f1b2cd33a688b53f6",
    "0e3351a1dd5789d314b27c414eb88360df11f680353986c4d28f66fffd7b8fa3",
    "0b5b392dd88ffd752a72eac360d3d0253500b314baf8c5bf45942002e0174dbb",
    "afec66ad9f67be51e38ea7581a70fe44d5e14b336902ac8e35d33cef6442c91d",
    "6e06da56c172be5574d64e519757de3f23bb5d1f6ad7e61c3dbdc3b2fe47584c",
    "f1e53cc31048aa1dec52775b252fc4c06fdaec8a869f78b9032f32d780adf060",
    "42744783e565d81b2ed58effd019eafbbcb2fed85197ab03b46c655e081bf759",
    "1d956347384c730f65907d6723ab43cd8695ba38bc22e256c4c08714db08ce04",
    "8d7ad6e84acc954a4210f47d1f40a93c82f0e7497c9ab3d5f10a550be5624f9a",
)


def test_source_descriptor_freezes_all_verified_repository_hashes():
    descriptor_path = source_module.DEFAULT_DESCRIPTOR_PATH
    raw = json.loads(descriptor_path.read_text(encoding="utf-8"))

    assert raw["stationCount"] == 117_148
    assert raw["fieldCount"] == 27
    assert raw["schemaVersion"] == 2
    assert raw["topology"] == {
        "duplicatePolicy": "mean",
        "kind": "delaunay",
        "localSpacingNeighbors": 8,
        "maximumEdgeLengthMeters": 5_000.0,
        "maximumEdgeRatio": 16.0,
    }
    assert raw["interpolation"] == {
        "kind": "triangle-linear",
        "stationaryEpsilon": 0.0,
        "stationaryPolicy": "require-all-moving",
    }
    assert raw["station"]["sha256"] == EXPECTED_STATION_HASH
    assert tuple(field["sha256"] for field in raw["fields"]) == EXPECTED_FIELD_HASHES
    assert [field["timeIndex"] for field in raw["fields"]] == list(range(27))
    assert [field["modelTime"] for field in raw["fields"]] == list(range(27))
    assert raw["unit"] == "legacy-flow-unit"
    assert raw["basis"] == "source-u-v"
    assert raw["phase"] == "unspecified"


def test_source_loads_little_endian_pairs_and_typed_build_strategies(
    synthetic_source,
):
    descriptor = read_source_descriptor(synthetic_source.descriptor_path)
    dataset = load_source_dataset(
        synthetic_source.directory,
        descriptor_path=synthetic_source.descriptor_path,
    )

    assert descriptor.station_count == 4
    assert descriptor.topology == DelaunayTopology(maximum_edge_ratio=None)
    assert descriptor.interpolation == TriangleLinearInterpolation()
    assert dataset.stations.dtype == np.dtype("<f4")
    assert dataset.stations.shape == (4, 2)
    assert np.array_equal(dataset.stations, synthetic_source.stations.astype(np.float32))
    assert len(dataset.fields) == 2
    assert all(field.dtype == np.dtype("<f4") for field in dataset.fields)


def test_schema_2_descriptor_and_existing_source_identities_remain_unchanged():
    descriptor = read_source_descriptor()

    assert descriptor.schema_version == 2
    assert descriptor.time_unit is None
    assert descriptor.authority == SourceAuthority()
    assert source_descriptor_hash(descriptor) == (
        "377405f75a361a5ac165530884db7e6885938510f41d857f72e555dc1eb095c0"
    )
    assert load_source_snapshot(time_index=0).source_hash == (
        "284eec65ca4d6e0d0cef7ddff06527bf5a89657e3c5427b893a76af63285550b"
    )


def test_schema_3_accepts_strictly_increasing_finite_model_times(
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
            "phase": "unconfirmed",
            "topology": "inferred",
        },
    })
    raw["fields"][0]["modelTime"] = 0.25
    raw["fields"][1]["modelTime"] = 1.75
    descriptor_path = tmp_path / "source-dataset-v3.json"
    descriptor_path.write_text(json.dumps(raw), encoding="utf-8")

    descriptor = read_source_descriptor(descriptor_path)

    assert descriptor.schema_version == 3
    assert descriptor.time_unit == "hour"
    assert descriptor.authority == SourceAuthority(
        unit="authoritative",
        basis="authoritative",
        time="authoritative",
        phase="unconfirmed",
        topology="inferred",
    )
    assert [field.time_index for field in descriptor.fields] == [0, 1]
    assert [field.model_time for field in descriptor.fields] == [0.25, 1.75]


@pytest.mark.parametrize(
    ("model_times", "message"),
    (
        ((0.0, 0.0), "strictly increasing"),
        ((2.0, 1.0), "strictly increasing"),
        ((0.0, float("inf")), "finite number"),
        ((0.0, True), "finite number"),
    ),
)
def test_schema_3_rejects_invalid_model_times(
    synthetic_source,
    tmp_path,
    model_times,
    message,
):
    raw = json.loads(synthetic_source.descriptor_path.read_text(encoding="utf-8"))
    raw.update({
        "schemaVersion": 3,
        "timeUnit": "unspecified",
        "authority": {
            "unit": "unconfirmed",
            "basis": "unconfirmed",
            "time": "unconfirmed",
            "phase": "unconfirmed",
            "topology": "inferred",
        },
    })
    for field, model_time in zip(raw["fields"], model_times, strict=True):
        field["modelTime"] = model_time
    descriptor_path = tmp_path / "invalid-v3.json"
    descriptor_path.write_text(json.dumps(raw), encoding="utf-8")

    with pytest.raises(ValueError, match=message):
        read_source_descriptor(descriptor_path)


def test_schema_3_requires_inferred_authority_for_current_delaunay(
    synthetic_source,
    tmp_path,
):
    raw = json.loads(synthetic_source.descriptor_path.read_text(encoding="utf-8"))
    raw.update({
        "schemaVersion": 3,
        "timeUnit": "unspecified",
        "authority": {
            "unit": "unconfirmed",
            "basis": "unconfirmed",
            "time": "unconfirmed",
            "phase": "unconfirmed",
            "topology": "authoritative",
        },
    })
    descriptor_path = tmp_path / "authoritative-delaunay.json"
    descriptor_path.write_text(json.dumps(raw), encoding="utf-8")

    with pytest.raises(ValueError, match="Delaunay topology authority must be inferred"):
        read_source_descriptor(descriptor_path)


def test_schema_3_source_hash_binds_time_unit_authority_and_exact_model_time(
    synthetic_source,
    tmp_path,
):
    raw = json.loads(synthetic_source.descriptor_path.read_text(encoding="utf-8"))
    raw.update({
        "schemaVersion": 3,
        "timeUnit": "second",
        "authority": {
            "unit": "unconfirmed",
            "basis": "unconfirmed",
            "time": "unconfirmed",
            "phase": "unconfirmed",
            "topology": "inferred",
        },
    })

    def digest(value):
        path = tmp_path / f"descriptor-{len(list(tmp_path.iterdir()))}.json"
        path.write_text(json.dumps(value), encoding="utf-8")
        return source_descriptor_hash(read_source_descriptor(path))

    baseline = digest(raw)
    changed_time_unit = json.loads(json.dumps(raw))
    changed_time_unit["timeUnit"] = "hour"
    changed_authority = json.loads(json.dumps(raw))
    changed_authority["authority"]["time"] = "authoritative"
    changed_model_time = json.loads(json.dumps(raw))
    changed_model_time["fields"][1]["modelTime"] = 1.5

    assert len({
        baseline,
        digest(changed_time_unit),
        digest(changed_authority),
        digest(changed_model_time),
    }) == 4


def test_source_rejects_hash_drift_before_triangulation(
    synthetic_source,
    tmp_path,
):
    descriptor = json.loads(
        synthetic_source.descriptor_path.read_text(encoding="utf-8")
    )
    descriptor["station"]["sha256"] = "0" * 64
    descriptor_path = tmp_path / "source-dataset.json"
    descriptor_path.write_text(json.dumps(descriptor), encoding="utf-8")

    with pytest.raises(ValueError, match="station source hash mismatch"):
        load_source_dataset(
            synthetic_source.directory,
            descriptor_path=descriptor_path,
        )


def test_source_rejects_non_finite_velocity_even_with_matching_hash(
    synthetic_source,
    tmp_path,
):
    source_directory = tmp_path / "source"
    source_directory.mkdir()
    for path in synthetic_source.directory.iterdir():
        if path.is_file():
            source_directory.joinpath(path.name).write_bytes(path.read_bytes())
    values = np.fromfile(source_directory / "uv_0.bin", dtype="<f4")
    values[0] = np.nan
    payload = values.astype("<f4", copy=False).tobytes()
    source_directory.joinpath("uv_0.bin").write_bytes(payload)
    descriptor = json.loads(
        synthetic_source.descriptor_path.read_text(encoding="utf-8")
    )
    descriptor["fields"][0]["sha256"] = hashlib.sha256(payload).hexdigest()
    descriptor_path = source_directory / "source-dataset.json"
    descriptor_path.write_text(json.dumps(descriptor), encoding="utf-8")

    with pytest.raises(ValueError, match="finite float32 pairs"):
        load_source_dataset(source_directory, descriptor_path=descriptor_path)


def test_source_descriptor_rejects_unknown_schema_keys(synthetic_source, tmp_path):
    descriptor = json.loads(
        synthetic_source.descriptor_path.read_text(encoding="utf-8")
    )
    descriptor["topolgy"] = descriptor["topology"]
    descriptor_path = tmp_path / "source-dataset.json"
    descriptor_path.write_text(json.dumps(descriptor), encoding="utf-8")

    with pytest.raises(ValueError, match="unknown keys"):
        read_source_descriptor(descriptor_path)


def test_snapshot_loads_only_the_selected_velocity_file(synthetic_source, tmp_path):
    source_directory = tmp_path / "source"
    source_directory.mkdir()
    source_directory.joinpath("station.bin").write_bytes(
        synthetic_source.directory.joinpath("station.bin").read_bytes()
    )
    source_directory.joinpath("uv_0.bin").write_bytes(
        synthetic_source.directory.joinpath("uv_0.bin").read_bytes()
    )

    snapshot = load_source_snapshot(
        source_directory,
        time_index=0,
        descriptor_path=synthetic_source.descriptor_path,
    )

    assert snapshot.field_descriptor.time_index == 0
    assert np.array_equal(snapshot.stations, synthetic_source.stations.astype(np.float32))
    assert np.array_equal(snapshot.field, synthetic_source.fields[0])
    assert snapshot.source_hash != load_source_dataset(
        synthetic_source.directory,
        descriptor_path=synthetic_source.descriptor_path,
    ).source_hash


def test_snapshot_rejects_invalid_time_index(synthetic_source):
    with pytest.raises(ValueError, match="time_index"):
        load_source_snapshot(
            synthetic_source.directory,
            time_index=2,
            descriptor_path=synthetic_source.descriptor_path,
        )
