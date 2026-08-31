from __future__ import annotations

import os
import shutil
import stat
import tempfile
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

from .cog import (
    CogBuildBudget,
    CogBuildPlan,
    CogBuildResult,
    CogEncoding,
    CogStagingGuard,
    _CogBaseWriteItem,
    _assess_cog_budget,
    _finalize_velocity_cog_snapshot,
    _safe_cog_output,
    _write_intermediate_tiff_batch,
    plan_velocity_cog_snapshot,
)
from .contracts import (
    InterpolationSpec,
    TopologySpec,
    resolve_interpolation,
    resolve_topology,
)
from .job_control import ProgressEmitter, ProgressSink
from .resolution import ResolutionSpec
from .source import (
    DEFAULT_DATA_DIRECTORY,
    DEFAULT_DESCRIPTOR_PATH,
    SourceSnapshot,
    load_source_snapshots,
)
from .topology import DuplicateStatistics, prepare_topology


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
    explicit_job_ids = tuple(
        item.job_id for item in selected if item.job_id is not None
    )
    if len(set(explicit_job_ids)) != len(explicit_job_ids):
        raise ValueError("snapshot batch explicit job IDs must be unique")
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

    def unregister(self, root: str | Path) -> None:
        requested = Path(os.path.abspath(os.fspath(root)))
        canonical = requested.parent.resolve(strict=True) / requested.name
        if canonical not in self._roots:
            raise ValueError("batch staging root is not registered")
        self._roots.remove(canonical)

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

    def require_additional_capacity(
        self,
        additional_bytes: int,
        stage: str,
    ) -> CogBatchStagingObservation:
        if (
            isinstance(additional_bytes, bool)
            or not isinstance(additional_bytes, int)
            or additional_bytes <= 0
        ):
            raise ValueError("additional_bytes must be a positive integer")
        observation = self.observe(stage)
        projected_staged_bytes = observation.staged_bytes + additional_bytes
        if projected_staged_bytes > self.budget.max_staged_bytes:
            raise OSError(
                f"Flow Field COG batch staging budget cannot hold the final copy "
                f"during {stage}: {projected_staged_bytes} > "
                f"{self.budget.max_staged_bytes}"
            )
        required_available_bytes = additional_bytes + self.budget.minimum_free_bytes
        if observation.available_bytes < required_available_bytes:
            raise OSError(
                f"Flow Field COG batch does not have enough free space for the final "
                f"copy during {stage}: {required_available_bytes} > "
                f"{observation.available_bytes}"
            )
        return observation


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


class _BatchSnapshotStagingGuard(CogStagingGuard):
    def __init__(
        self,
        *,
        root: Path,
        budget: CogBuildBudget,
        time_index: int,
        aggregate_guard: CogBatchStagingGuard | None = None,
    ) -> None:
        super().__init__(
            root=root,
            budget=budget,
            initial_available_bytes=shutil.disk_usage(root).free,
        )
        self.time_index = time_index
        self.aggregate_guard = aggregate_guard

    def observe(self, stage: str) -> None:
        super().observe(stage)
        if self.aggregate_guard is not None:
            self.aggregate_guard.observe(f"t{self.time_index:02d}:{stage}")

    def require_copy_capacity(self) -> None:
        super().require_copy_capacity()
        if self.aggregate_guard is not None:
            self.aggregate_guard.require_additional_capacity(
                self.copy_capacity_bytes,
                f"t{self.time_index:02d}:before-cog-copy",
            )


@dataclass(slots=True)
class _PreparedBatchSnapshot:
    item: CogSnapshotBatchItem
    snapshot: SourceSnapshot
    output: Path
    plan: CogBuildPlan
    unique_field: np.ndarray
    duplicate_statistics: DuplicateStatistics
    emitter: ProgressEmitter
    staged: Path | None = None
    staging_guard: _BatchSnapshotStagingGuard | None = None
    source_tiff: Path | None = None
    support: dict[str, Any] | None = None


def build_velocity_cog_snapshot_batch(
    data_directory: str | Path = DEFAULT_DATA_DIRECTORY,
    *,
    items: tuple[CogSnapshotBatchItem, ...],
    descriptor_path: str | Path = DEFAULT_DESCRIPTOR_PATH,
    topology: TopologySpec | None = None,
    interpolation: InterpolationSpec | None = None,
    resolution: ResolutionSpec | None = None,
    encoding: CogEncoding = CogEncoding(),
    budget: CogBuildBudget = CogBuildBudget(),
    execution_budget: CogSnapshotBatchExecutionBudget = (
        CogSnapshotBatchExecutionBudget()
    ),
    progress: ProgressSink | None = None,
) -> tuple[CogBuildResult, ...]:
    """Build at most two byte-equivalent snapshots through one shared base pass."""
    selected = validate_snapshot_batch_items(items, execution_budget)
    if not isinstance(encoding, CogEncoding):
        raise TypeError("encoding must be a CogEncoding")
    if not isinstance(budget, CogBuildBudget):
        raise TypeError("budget must be a CogBuildBudget")
    outputs = tuple(_safe_cog_output(item.output_directory) for item in selected)
    emitters = tuple(
        ProgressEmitter(
            item.job_id or f"flow-cog-{uuid.uuid4().hex}",
            item.time_index,
            progress,
        )
        for item in selected
    )
    for emitter in emitters:
        emitter.emit("stage.started", stage="source")
    snapshots_by_time = {
        snapshot.field_descriptor.time_index: snapshot
        for snapshot in load_source_snapshots(
            data_directory,
            time_indices=tuple(item.time_index for item in selected),
            descriptor_path=descriptor_path,
        )
    }
    snapshots = tuple(snapshots_by_time[item.time_index] for item in selected)
    for emitter in emitters:
        emitter.emit(
            "stage.progress",
            stage="source",
            completed=2,
            total=2,
            unit="files",
        )
        emitter.emit("stage.completed", stage="source")
        emitter.emit("stage.started", stage="planning")

    first_plan = plan_velocity_cog_snapshot(
        snapshots[0].stations,
        snapshots[0].geographic_bounds,
        outputs[0].parent,
        resolution=resolution,
        budget=budget,
    )
    plans = [first_plan]
    for output in outputs[1:]:
        assessment = _assess_cog_budget(
            first_plan.grid,
            first_plan.overview_levels,
            budget,
            shutil.disk_usage(output.parent).free,
        )
        plans.append(CogBuildPlan(
            selection=first_plan.selection,
            grid=first_plan.grid,
            budget=assessment,
            overview_levels=first_plan.overview_levels,
        ))
    for emitter, plan in zip(emitters, plans, strict=True):
        plan.require_output_approved()
        emitter.emit(
            "stage.progress",
            stage="planning",
            completed=1,
            total=1,
            unit="plans",
        )
        emitter.emit("stage.completed", stage="planning")
        emitter.emit("stage.started", stage="topology")

    topology_spec = resolve_topology(
        snapshots[0].descriptor.topology if topology is None else topology
    )
    interpolation_spec = resolve_interpolation(
        snapshots[0].descriptor.interpolation
        if interpolation is None
        else interpolation
    )
    prepared_topology = prepare_topology(snapshots[0].stations, topology_spec)
    prepared = tuple(
        _PreparedBatchSnapshot(
            item=item,
            snapshot=snapshot,
            output=output,
            plan=plan,
            unique_field=prepared_topology.aggregate_field(snapshot.field),
            duplicate_statistics=prepared_topology.duplicate_statistics((snapshot.field,)),
            emitter=emitter,
        )
        for item, snapshot, output, plan, emitter in zip(
            selected,
            snapshots,
            outputs,
            plans,
            emitters,
            strict=True,
        )
    )
    for value in prepared:
        value.emitter.emit(
            "stage.progress",
            stage="topology",
            completed=1,
            total=1,
            unit="topologies",
        )
        value.emitter.emit("stage.completed", stage="topology")

    aggregate_guard = CogBatchStagingGuard(selected, execution_budget)
    active_staging: set[Path] = set()
    try:
        for value in prepared:
            staged = Path(tempfile.mkdtemp(
                prefix=f".{value.output.name}.build-",
                dir=value.output.parent,
            ))
            active_staging.add(staged)
            aggregate_guard.register(staged)
            value.staged = staged
            value.source_tiff = staged / "base.tif"
        for index, value in enumerate(prepared):
            value.staging_guard = _BatchSnapshotStagingGuard(
                root=value.staged,
                budget=budget,
                time_index=value.item.time_index,
                aggregate_guard=aggregate_guard if index == 0 else None,
            )
            value.staging_guard.observe("staging-created")
            value.emitter.emit("stage.started", stage="base")

        aggregate_guard.observe("batch-staging-created")
        base_items = tuple(
            _CogBaseWriteItem(
                path=value.source_tiff,
                snapshot=value.snapshot,
                unique_field=value.unique_field,
                staging_guard=value.staging_guard,
                progress_callback=(
                    lambda completed, total, emitter=value.emitter: emitter.emit(
                        "stage.progress",
                        stage="base",
                        completed=completed,
                        total=total,
                        unit="blocks",
                    )
                ),
            )
            for value in prepared
        )
        supports = _write_intermediate_tiff_batch(
            base_items,
            first_plan,
            prepared_topology,
            interpolation_spec,
            encoding,
        )
        aggregate_guard.observe("base-complete")
        for value, support in zip(prepared, supports, strict=True):
            value.support = support
            value.emitter.emit("stage.completed", stage="base")

        results: list[CogBuildResult] = []
        for value in prepared:
            for other in prepared:
                other.staging_guard.aggregate_guard = None
            value.staging_guard.aggregate_guard = aggregate_guard
            result = _finalize_velocity_cog_snapshot(
                snapshot=value.snapshot,
                plan=value.plan,
                prepared_topology=prepared_topology,
                duplicate_statistics=value.duplicate_statistics,
                interpolation=interpolation_spec,
                encoding=encoding,
                staging_guard=value.staging_guard,
                staged=value.staged,
                output=value.output,
                source_tiff=value.source_tiff,
                support=value.support,
                emitter=value.emitter,
            )
            active_staging.remove(value.staged)
            aggregate_guard.unregister(value.staged)
            results.append(result)
        return tuple(results)
    finally:
        for staged in active_staging:
            if staged.exists():
                shutil.rmtree(staged)
