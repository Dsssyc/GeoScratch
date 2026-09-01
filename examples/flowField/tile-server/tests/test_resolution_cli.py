from __future__ import annotations

import json
import sys

import pytest

from geoscratch_flow_field_tiles import cog, collection


def test_snapshot_plan_cli_accepts_explicit_matrix(
    synthetic_source,
    tmp_path,
    monkeypatch,
    capsys,
):
    monkeypatch.setattr(sys, "argv", [
        "flow-field-cog-build",
        "--source",
        str(synthetic_source.directory),
        "--descriptor",
        str(synthetic_source.descriptor_path),
        "--output",
        str(tmp_path / "cog-cache"),
        "--time-index",
        "0",
        "--matrix",
        "10",
        "--plan-only",
    ])

    cog.main()

    manifest = json.loads(capsys.readouterr().out)
    assert manifest["resolution"]["requested"]["matrixId"] == "10"
    assert manifest["matrixDecision"]["relation"] == "explicitly-requested"


def test_collection_plan_cli_accepts_explicit_matrix(
    synthetic_source,
    tmp_path,
    monkeypatch,
    capsys,
):
    monkeypatch.setattr(sys, "argv", [
        "flow-field-cog-collection-build",
        "--source",
        str(synthetic_source.directory),
        "--descriptor",
        str(synthetic_source.descriptor_path),
        "--output",
        str(tmp_path / "cog-collection"),
        "--time-indices",
        "0",
        "--matrix",
        "10",
        "--plan-only",
    ])

    collection.main()

    manifest = json.loads(capsys.readouterr().out)
    snapshot_plan = manifest["snapshotPlan"]
    assert snapshot_plan["resolution"]["requested"]["matrixId"] == "10"
    assert snapshot_plan["matrixDecision"]["relation"] == "explicitly-requested"


@pytest.mark.parametrize("main", (cog.main, collection.main))
def test_cli_rejects_an_out_of_range_matrix(main, monkeypatch, capsys):
    monkeypatch.setattr(sys, "argv", ["flow-field-build", "--matrix", "25"])

    with pytest.raises(SystemExit) as error:
        main()

    assert error.value.code == 2
    assert "matrix_id must be an integer in [0, 24]" in capsys.readouterr().err


@pytest.mark.parametrize("main", (cog.main, collection.main))
def test_verify_cli_does_not_silently_ignore_matrix(main, monkeypatch, capsys):
    monkeypatch.setattr(
        sys,
        "argv",
        ["flow-field-build", "--verify-existing", "--matrix", "10"],
    )

    with pytest.raises(SystemExit) as error:
        main()

    assert error.value.code == 2
    assert "cannot be combined" in capsys.readouterr().err
