from __future__ import annotations

import errno
import json
import os
import stat
import tempfile
import threading
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol, TextIO


FLOW_COG_EVENT_TYPE = "flow-field-cog-build-event"


@dataclass(frozen=True, slots=True)
class JobProgressEvent:
    """One versioned machine-readable Flow COG job event."""

    job_id: str
    sequence: int
    event: str
    stage: str | None
    time_index: int
    completed: int | None = None
    total: int | None = None
    unit: str | None = None

    def __post_init__(self) -> None:
        if not isinstance(self.job_id, str) or not self.job_id:
            raise ValueError("job_id must be a non-empty string")
        if isinstance(self.sequence, bool) or not isinstance(self.sequence, int):
            raise ValueError("sequence must be a positive integer")
        if self.sequence <= 0:
            raise ValueError("sequence must be a positive integer")
        if not isinstance(self.event, str) or not self.event:
            raise ValueError("event must be a non-empty string")
        if self.stage is not None and (
            not isinstance(self.stage, str) or not self.stage
        ):
            raise ValueError("stage must be None or a non-empty string")
        if (
            isinstance(self.time_index, bool)
            or not isinstance(self.time_index, int)
            or self.time_index < 0
        ):
            raise ValueError("time_index must be a non-negative integer")
        progress_values = (self.completed, self.total, self.unit)
        if all(value is None for value in progress_values):
            return
        if self.completed is None or self.total is None or self.unit is None:
            raise ValueError("completed, total, and unit must be supplied together")
        if (
            isinstance(self.completed, bool)
            or not isinstance(self.completed, int)
            or self.completed < 0
            or isinstance(self.total, bool)
            or not isinstance(self.total, int)
            or self.total < 0
            or self.completed > self.total
        ):
            raise ValueError("progress must satisfy 0 <= completed <= total")
        if not isinstance(self.unit, str) or not self.unit:
            raise ValueError("unit must be a non-empty string")

    def manifest(self) -> dict[str, Any]:
        progress = None
        if self.completed is not None:
            progress = {
                "completed": self.completed,
                "total": self.total,
                "unit": self.unit,
            }
        return {
            "schemaVersion": 1,
            "type": FLOW_COG_EVENT_TYPE,
            "jobId": self.job_id,
            "sequence": self.sequence,
            "event": self.event,
            "stage": self.stage,
            "timeIndex": self.time_index,
            "progress": progress,
        }


class ProgressSink(Protocol):
    def emit(self, event: JobProgressEvent) -> None: ...


class JsonlProgressSink:
    """Write one flushed JSON object per line, or remain silent without a stream."""

    def __init__(self, stream: TextIO | None = None) -> None:
        self.stream = stream
        self._lock = threading.Lock()

    def emit(self, event: JobProgressEvent) -> None:
        if not isinstance(event, JobProgressEvent):
            raise TypeError("event must be a JobProgressEvent")
        if self.stream is None:
            return
        line = json.dumps(
            event.manifest(),
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        )
        with self._lock:
            self.stream.write(f"{line}\n")
            self.stream.flush()


class ProgressEmitter:
    """Assign monotonic job-local sequence numbers and notify an optional sink."""

    def __init__(
        self,
        job_id: str,
        time_index: int,
        sink: ProgressSink | None = None,
    ) -> None:
        if not isinstance(job_id, str) or not job_id:
            raise ValueError("job_id must be a non-empty string")
        if (
            isinstance(time_index, bool)
            or not isinstance(time_index, int)
            or time_index < 0
        ):
            raise ValueError("time_index must be a non-negative integer")
        self.job_id = job_id
        self.time_index = time_index
        self.sink = sink
        self._sequence = 0
        self._lock = threading.Lock()

    def emit(
        self,
        event: str,
        *,
        stage: str | None,
        completed: int | None = None,
        total: int | None = None,
        unit: str | None = None,
    ) -> JobProgressEvent:
        with self._lock:
            progress_event = JobProgressEvent(
                job_id=self.job_id,
                sequence=self._sequence + 1,
                event=event,
                stage=stage,
                time_index=self.time_index,
                completed=completed,
                total=total,
                unit=unit,
            )
            if self.sink is not None:
                self.sink.emit(progress_event)
            self._sequence = progress_event.sequence
            return progress_event


class OutputLockConflictError(RuntimeError):
    """Stable non-blocking failure raised when another process owns a lock."""

    code = "FLOW_COG_OUTPUT_LOCKED"

    def __init__(
        self,
        lock_path: Path,
        owner_metadata: object | None,
    ) -> None:
        self.lock_path = lock_path
        self.owner_metadata = owner_metadata
        super().__init__(f"{self.code}: {lock_path}")


class OutputLock:
    """Cross-platform advisory output lock whose lock file is never unlinked."""

    def __init__(
        self,
        path: str | Path,
        *,
        metadata: Mapping[str, Any] | None = None,
    ) -> None:
        self.path = _local_lock_path(path)
        self.metadata_path = self.path.with_name(f"{self.path.name}.metadata.json")
        self.metadata = dict(metadata or {})
        self._descriptor: int | None = None

    @property
    def acquired(self) -> bool:
        return self._descriptor is not None

    def acquire(self) -> OutputLock:
        if self.acquired:
            raise RuntimeError("OutputLock is already acquired")
        flags = os.O_RDWR | os.O_CREAT | getattr(os, "O_CLOEXEC", 0)
        flags |= getattr(os, "O_NOFOLLOW", 0)
        try:
            descriptor = os.open(self.path, flags, 0o600)
        except OSError as error:
            if self.path.is_symlink():
                raise ValueError(
                    f"output lock cannot be a symbolic link: {self.path}"
                ) from error
            raise
        try:
            if not stat.S_ISREG(os.fstat(descriptor).st_mode):
                raise ValueError(f"output lock must be a regular file: {self.path}")
            if os.fstat(descriptor).st_size == 0:
                os.write(descriptor, b"\0")
                _best_effort_fsync(descriptor)
            try:
                _acquire_advisory_lock(descriptor)
            except OSError as error:
                if error.errno not in _LOCK_CONFLICT_ERRNOS:
                    raise
                owner = _read_json_if_available(self.metadata_path)
                raise OutputLockConflictError(self.path, owner) from error
            self._descriptor = descriptor
            atomic_write_json(self.metadata_path, self.metadata)
        except BaseException:
            if self._descriptor is not None:
                self.release()
            else:
                os.close(descriptor)
            raise
        return self

    def release(self) -> None:
        descriptor = self._descriptor
        if descriptor is None:
            return
        self._descriptor = None
        try:
            _release_advisory_lock(descriptor)
        finally:
            os.close(descriptor)

    def __enter__(self) -> OutputLock:
        return self.acquire()

    def __exit__(self, _error_type, _error, _traceback) -> None:
        self.release()


_LOCK_CONFLICT_ERRNOS = {
    errno.EACCES,
    errno.EAGAIN,
    getattr(errno, "EDEADLK", errno.EAGAIN),
}


def _acquire_advisory_lock(descriptor: int) -> None:
    os.lseek(descriptor, 0, os.SEEK_SET)
    if os.name == "nt":
        import msvcrt

        msvcrt.locking(descriptor, msvcrt.LK_NBLCK, 1)
        return
    import fcntl

    fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)


def _release_advisory_lock(descriptor: int) -> None:
    os.lseek(descriptor, 0, os.SEEK_SET)
    if os.name == "nt":
        import msvcrt

        msvcrt.locking(descriptor, msvcrt.LK_UNLCK, 1)
        return
    import fcntl

    fcntl.flock(descriptor, fcntl.LOCK_UN)


def _local_lock_path(path: str | Path) -> Path:
    requested = Path(os.path.abspath(os.fspath(path)))
    parent = requested.parent.resolve(strict=True)
    if not parent.is_dir():
        raise NotADirectoryError(f"output lock parent is not a directory: {parent}")
    lock_path = parent / requested.name
    if lock_path.is_symlink():
        raise ValueError(f"output lock cannot be a symbolic link: {lock_path}")
    return lock_path


def _read_json_if_available(path: Path) -> object | None:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def atomic_write_json(path: str | Path, value: Any) -> Path:
    """Atomically replace one local JSON file after flushing its bytes."""

    destination = _local_destination(path)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{destination.name}.",
        suffix=".tmp",
        dir=destination.parent,
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(
            descriptor,
            "w",
            encoding="utf-8",
            newline="\n",
        ) as stream:
            json.dump(
                value,
                stream,
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
            )
            stream.write("\n")
            stream.flush()
            _best_effort_fsync(stream.fileno())
        os.replace(temporary, destination)
        _best_effort_fsync_directory(destination.parent)
    finally:
        if temporary.exists():
            temporary.unlink()
    return destination


def _local_destination(path: str | Path) -> Path:
    requested = Path(os.path.abspath(os.fspath(path)))
    parent = requested.parent.resolve(strict=True)
    if not parent.is_dir():
        raise NotADirectoryError(f"JSON destination parent is not a directory: {parent}")
    destination = parent / requested.name
    if destination.is_symlink():
        raise ValueError(f"JSON destination cannot be a symbolic link: {destination}")
    return destination


def _best_effort_fsync(descriptor: int) -> None:
    try:
        os.fsync(descriptor)
    except OSError:
        pass


def _best_effort_fsync_directory(directory: Path) -> None:
    flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
    try:
        descriptor = os.open(directory, flags)
    except OSError:
        return
    try:
        _best_effort_fsync(descriptor)
    finally:
        os.close(descriptor)
