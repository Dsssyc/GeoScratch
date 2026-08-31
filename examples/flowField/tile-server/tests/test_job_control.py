from __future__ import annotations

import io
import json
import subprocess
import sys
import textwrap

import pytest

from geoscratch_flow_field_tiles.job_control import (
    JsonlProgressSink,
    OutputLock,
    ProgressEmitter,
    atomic_write_json,
)


LOCK_PROBE = textwrap.dedent("""
    import json
    import sys

    from geoscratch_flow_field_tiles.job_control import (
        OutputLock,
        OutputLockConflictError,
    )

    try:
        with OutputLock(sys.argv[1], metadata={"jobId": "child"}):
            print(json.dumps({"status": "acquired"}, sort_keys=True))
    except OutputLockConflictError as error:
        print(json.dumps({
            "code": error.code,
            "owner": error.owner_metadata,
            "status": "conflict",
        }, sort_keys=True))
""")


def test_atomic_json_replaces_the_complete_destination(tmp_path):
    destination = tmp_path / "state.json"
    destination.write_text('{"state":"old"}\n', encoding="utf-8")

    result = atomic_write_json(destination, {"state": "新", "sequence": 2})

    assert result == destination
    assert destination.read_text(encoding="utf-8") == (
        '{"sequence":2,"state":"新"}\n'
    )
    assert json.loads(destination.read_text(encoding="utf-8")) == {
        "sequence": 2,
        "state": "新",
    }
    assert list(tmp_path.glob(".state.json.*.tmp")) == []


def test_atomic_json_keeps_the_previous_file_when_serialization_fails(tmp_path):
    destination = tmp_path / "state.json"
    previous = b'{"state":"old"}\n'
    destination.write_bytes(previous)

    with pytest.raises(TypeError):
        atomic_write_json(destination, {"invalid": object()})

    assert destination.read_bytes() == previous
    assert list(tmp_path.glob(".state.json.*.tmp")) == []


def test_output_lock_conflicts_across_processes_and_releases_without_unlinking(
    tmp_path,
):
    lock_path = tmp_path / ".cog-cache.lock"
    lock = OutputLock(lock_path, metadata={"jobId": "parent", "timeIndex": 0})

    with lock:
        conflict = subprocess.run(
            [sys.executable, "-c", LOCK_PROBE, str(lock_path)],
            check=True,
            capture_output=True,
            text=True,
        )
        conflict_payload = json.loads(conflict.stdout)
        assert conflict_payload == {
            "code": "FLOW_COG_OUTPUT_LOCKED",
            "owner": {"jobId": "parent", "timeIndex": 0},
            "status": "conflict",
        }
        assert lock.acquired
        assert lock_path.is_file()
        assert json.loads(lock.metadata_path.read_text(encoding="utf-8")) == {
            "jobId": "parent",
            "timeIndex": 0,
        }

    assert not lock.acquired
    assert lock_path.is_file()
    acquired = subprocess.run(
        [sys.executable, "-c", LOCK_PROBE, str(lock_path)],
        check=True,
        capture_output=True,
        text=True,
    )
    assert json.loads(acquired.stdout) == {"status": "acquired"}
    assert lock_path.is_file()
    assert json.loads(lock.metadata_path.read_text(encoding="utf-8")) == {
        "jobId": "child",
    }


def test_progress_emitter_assigns_sequences_and_jsonl_sink_flushes_events():
    stream = io.StringIO()
    emitter = ProgressEmitter(
        "job-123",
        4,
        JsonlProgressSink(stream),
    )

    started = emitter.emit("stage.started", stage="base")
    progressed = emitter.emit(
        "stage.progress",
        stage="base",
        completed=64,
        total=128,
        unit="blocks",
    )

    assert (started.sequence, progressed.sequence) == (1, 2)
    assert [json.loads(line) for line in stream.getvalue().splitlines()] == [
        {
            "schemaVersion": 1,
            "type": "flow-field-cog-build-event",
            "jobId": "job-123",
            "sequence": 1,
            "event": "stage.started",
            "stage": "base",
            "timeIndex": 4,
            "progress": None,
        },
        {
            "schemaVersion": 1,
            "type": "flow-field-cog-build-event",
            "jobId": "job-123",
            "sequence": 2,
            "event": "stage.progress",
            "stage": "base",
            "timeIndex": 4,
            "progress": {
                "completed": 64,
                "total": 128,
                "unit": "blocks",
            },
        },
    ]


def test_progress_defaults_to_no_output_and_rejects_partial_progress():
    emitter = ProgressEmitter("job-silent", 0, JsonlProgressSink())

    assert emitter.emit("job.started", stage=None).sequence == 1
    with pytest.raises(ValueError, match="supplied together"):
        emitter.emit(
            "stage.progress",
            stage="base",
            completed=1,
        )
    assert emitter.emit("job.failed", stage=None).sequence == 2
