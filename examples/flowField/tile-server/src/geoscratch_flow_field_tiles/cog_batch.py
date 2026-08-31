from __future__ import annotations

import os
import shutil
import stat
from dataclasses import dataclass
from pathlib import Path


MAX_SUPPORTED_BATCH_SNAPSHOTS = 2


@dataclass(frozen=True, slots=True)
class CogSnapshotBatchItem:
    """One execution-only snapshot target in a bounded COG batch."""

    time_index: int
    output_directory: str | Path
    job_id: str | None = None

    def __post_init__(self) -> None:
        if (
            isinstance(self.time_index, bool)
            or not isinstance(self.time_index, int)
            or self.time_index < 0
        ):
            raise ValueError("time_index must be a non-negative integer")
        if self.job_id is not None and (
            not isinstance(self.job_id, str) or not self.job_id
        ):
            raise ValueError("job_id must be None or a non-empty string")
        try:
            requested = Path(os.path.abspath(os.fspath(self.output_directory)))
        except TypeError as error:
            raise TypeError("output_directory must be path-like") from error
        if requested.is_symlink():
            raise ValueError("batch output directory cannot be a symbolic link")
        parent = requested.parent.resolve(strict=True)
        if not parent.is_dir():
            raise NotADirectoryError(
                f"batch output parent is not a directory: {parent}"
            )
        object.__setattr__(self, "output_directory", parent / requested.name)


@dataclass(frozen=True, slots=True)
class CogSnapshotBatchExecutionBudget:
    """Bounds execution concurrency and aggregate temporary storage."""

    max_snapshots: int = MAX_SUPPORTED_BATCH_SNAPSHOTS
    max_staged_bytes: int = 16 * 1024**3
    minimum_free_bytes: int = 8 * 1024**3

    def __post_init__(self) -> None:
        for name, value in (
            ("max_snapshots", self.max_snapshots),
            ("max_staged_bytes", self.max_staged_bytes),
            ("minimum_free_bytes", self.minimum_free_bytes),
        ):
            if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
                raise ValueError(f"{name} must be a positive integer")
        if self.max_snapshots > MAX_SUPPORTED_BATCH_SNAPSHOTS:
            raise ValueError(
                f"max_snapshots cannot exceed {MAX_SUPPORTED_BATCH_SNAPSHOTS}"
            )


@dataclass(frozen=True, slots=True)
class CogBatchStagingObservation:
    """One execution observation; it is not an artifact-manifest record."""

    stage: str
    registered_root_count: int
    staged_bytes: int
    available_bytes: int
    peak_staged_bytes: int
    minimum_available_bytes: int
    observation_count: int


def validate_snapshot_batch_items(
    items: tuple[CogSnapshotBatchItem, ...],
    budget: CogSnapshotBatchExecutionBudget = CogSnapshotBatchExecutionBudget(),
) -> tuple[CogSnapshotBatchItem, ...]:
    """Validate and retain one deterministic execution order for a batch."""
    if not isinstance(budget, CogSnapshotBatchExecutionBudget):
        raise TypeError("budget must be a CogSnapshotBatchExecutionBudget")
    selected = tuple(items)
    if not selected:
        raise ValueError("snapshot batch must contain at least one item")
    if any(not isinstance(item, CogSnapshotBatchItem) for item in selected):
        raise TypeError("snapshot batch items must be CogSnapshotBatchItem values")
    if len(selected) > budget.max_snapshots:
        raise ValueError(
            f"snapshot batch size {len(selected)} exceeds {budget.max_snapshots}"
        )
    time_indices = tuple(item.time_index for item in selected)
    if len(set(time_indices)) != len(time_indices):
        raise ValueError("snapshot batch time indices must be unique")
    outputs = tuple(Path(item.output_directory) for item in selected)
    if len(set(outputs)) != len(outputs):
        raise ValueError("snapshot batch canonical output directories must be unique")
    devices = {_filesystem_device(output.parent) for output in outputs}
    if len(devices) != 1:
        raise ValueError("snapshot batch outputs must share one filesystem")
    return selected


class CogBatchStagingGuard:
    """Observe aggregate regular-file staging across registered owned roots."""

    def __init__(
        self,
        items: tuple[CogSnapshotBatchItem, ...],
        budget: CogSnapshotBatchExecutionBudget = CogSnapshotBatchExecutionBudget(),
    ) -> None:
        self.items = validate_snapshot_batch_items(items, budget)
        self.budget = budget
        self.filesystem_directory = Path(self.items[0].output_directory).parent
        self.filesystem_device = _filesystem_device(self.filesystem_directory)
        self.allowed_parents = tuple(
            Path(item.output_directory).parent for item in self.items
        )
        self.initial_available_bytes = shutil.disk_usage(
            self.filesystem_directory
        ).free
        self.peak_staged_bytes = 0
        self.minimum_available_bytes = self.initial_available_bytes
        self.observation_count = 0
        self._roots: list[Path] = []

    @property
    def roots(self) -> tuple[Path, ...]:
        return tuple(self._roots)

    def register(self, root: str | Path) -> Path:
        requested = Path(os.path.abspath(os.fspath(root)))
        if requested.is_symlink():
            raise ValueError("batch staging root cannot be a symbolic link")
        registered = requested.resolve(strict=True)
        if not registered.is_dir():
            raise NotADirectoryError(
                f"batch staging root is not a directory: {registered}"
            )
        if _filesystem_device(registered) != self.filesystem_device:
            raise ValueError("batch staging root must share the output filesystem")
        if not any(
            registered == parent or registered.is_relative_to(parent)
            for parent in self.allowed_parents
        ):
            raise ValueError("batch staging root must belong to an output parent")
        if registered in self._roots:
            raise ValueError("batch staging root is already registered")
        self._roots.append(registered)
        return registered

    def observe(self, stage: str) -> CogBatchStagingObservation:
        if not isinstance(stage, str) or not stage:
            raise ValueError("stage must be a non-empty string")
        staged_bytes = sum(_regular_file_bytes(root) for root in self._roots)
        available_bytes = shutil.disk_usage(self.filesystem_directory).free
        peak_staged_bytes = max(self.peak_staged_bytes, staged_bytes)
        minimum_available_bytes = min(
            self.minimum_available_bytes,
            available_bytes,
        )
        observation_count = self.observation_count + 1
        self.peak_staged_bytes = peak_staged_bytes
        self.minimum_available_bytes = minimum_available_bytes
        self.observation_count = observation_count
        if staged_bytes > self.budget.max_staged_bytes:
            raise OSError(
                f"Flow Field COG batch staging budget exceeded during {stage}: "
                f"{staged_bytes} > {self.budget.max_staged_bytes}"
            )
        if available_bytes < self.budget.minimum_free_bytes:
            raise OSError(
                f"Flow Field COG batch free-space reserve was crossed during {stage}: "
                f"{available_bytes} < {self.budget.minimum_free_bytes}"
            )
        return CogBatchStagingObservation(
            stage=stage,
            registered_root_count=len(self._roots),
            staged_bytes=staged_bytes,
            available_bytes=available_bytes,
            peak_staged_bytes=peak_staged_bytes,
            minimum_available_bytes=minimum_available_bytes,
            observation_count=observation_count,
        )


def _filesystem_device(path: Path) -> int:
    return path.stat(follow_symlinks=False).st_dev


def _regular_file_bytes(root: Path) -> int:
    total = 0
    pending = [root]
    while pending:
        directory = pending.pop()
        if directory.is_symlink():
            raise ValueError(
                f"batch staging roots cannot contain symbolic links: {directory}"
            )
        directory_stat = directory.stat(follow_symlinks=False)
        if not stat.S_ISDIR(directory_stat.st_mode):
            raise ValueError(f"batch staging path is not a directory: {directory}")
        with os.scandir(directory) as entries:
            for entry in entries:
                if entry.is_symlink():
                    raise ValueError(
                        f"batch staging roots cannot contain symbolic links: {entry.path}"
                    )
                entry_stat = entry.stat(follow_symlinks=False)
                if stat.S_ISREG(entry_stat.st_mode):
                    total += entry_stat.st_size
                elif stat.S_ISDIR(entry_stat.st_mode):
                    pending.append(Path(entry.path))
                else:
                    raise ValueError(
                        f"batch staging roots can contain only regular files and "
                        f"directories: {entry.path}"
                    )
    return total
