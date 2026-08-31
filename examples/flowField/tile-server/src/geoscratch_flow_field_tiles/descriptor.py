from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import tempfile
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from .contracts import DelaunayTopology, TriangleLinearInterpolation
from .source import (
    DEFAULT_DATA_DIRECTORY,
    SourceAuthority,
    SourceDescriptor,
    read_source_descriptor,
    source_descriptor_hash,
)


UV_FILENAME_PATTERN = re.compile(r"^uv_(\d+)\.bin$")


@dataclass(frozen=True, slots=True)
class PairFileFacts:
    filename: str
    pair_count: int
    sha256: str


@dataclass(frozen=True, slots=True)
class SourceDescriptorGenerationResult:
    output_path: Path
    descriptor: SourceDescriptor
    descriptor_sha256: str
    source_hash: str


def _inspect_pair_file(
    path: Path,
    label: str,
    *,
    expected_count: int | None = None,
) -> PairFileFacts:
    if not path.is_file():
        raise FileNotFoundError(f"{label} source does not exist: {path}")
    payload = path.read_bytes()
    pair_byte_length = 2 * np.dtype("<f4").itemsize
    if not payload or len(payload) % pair_byte_length:
        raise ValueError(
            f"{label} source byte length must contain complete float32 pairs"
        )
    pair_count = len(payload) // pair_byte_length
    if expected_count is not None and pair_count != expected_count:
        raise ValueError(
            f"{label} source pair count mismatch: expected {expected_count}, "
            f"received {pair_count}"
        )
    values = np.frombuffer(payload, dtype="<f4")
    if not np.isfinite(values).all():
        raise ValueError(f"{label} source must contain finite float32 pairs")
    return PairFileFacts(
        filename=path.name,
        pair_count=pair_count,
        sha256=hashlib.sha256(payload).hexdigest(),
    )


def _velocity_files(source_directory: Path) -> tuple[tuple[int, Path], ...]:
    candidates = sorted(
        (
            path
            for path in source_directory.iterdir()
            if path.name.startswith("uv_") and path.suffix == ".bin"
        ),
        key=lambda path: path.name,
    )
    if not candidates:
        raise ValueError("Flow Field source directory contains no uv_N.bin files")
    indexed: list[tuple[int, Path]] = []
    seen_indices: set[int] = set()
    for path in candidates:
        match = UV_FILENAME_PATTERN.fullmatch(path.name)
        if match is None:
            raise ValueError(
                f"Flow Field velocity filename must match uv_N.bin: {path.name}"
            )
        numeric_index = int(match.group(1))
        if numeric_index in seen_indices:
            raise ValueError(
                f"Flow Field velocity filenames repeat numeric index {numeric_index}"
            )
        seen_indices.add(numeric_index)
        indexed.append((numeric_index, path))
    indexed.sort(key=lambda item: item[0])
    return tuple(indexed)


def _model_times(
    velocity_files: tuple[tuple[int, Path], ...],
    requested: Sequence[int | float] | None,
) -> tuple[int | float, ...]:
    values: tuple[int | float, ...]
    if requested is None:
        values = tuple(numeric_index for numeric_index, _path in velocity_files)
    else:
        values = tuple(requested)
        if len(values) != len(velocity_files):
            raise ValueError("model_times length must equal the number of velocity files")
    previous: int | float | None = None
    for index, value in enumerate(values):
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValueError(f"model_times[{index}] must be a finite number")
        if isinstance(value, float) and not math.isfinite(value):
            raise ValueError(f"model_times[{index}] must be a finite number")
        if previous is not None and value <= previous:
            raise ValueError("model_times must be strictly increasing")
        previous = value
    return values


def _write_descriptor_atomically(
    output: Path,
    payload: bytes,
    *,
    overwrite: bool,
) -> None:
    if output.is_symlink():
        raise ValueError("source descriptor output cannot be a symbolic link")
    if output.exists() and not overwrite:
        raise FileExistsError(f"source descriptor output already exists: {output}")
    if not output.parent.is_dir():
        raise FileNotFoundError(
            f"source descriptor output parent does not exist: {output.parent}"
        )
    handle, temporary_name = tempfile.mkstemp(
        prefix=f".{output.name}.write-",
        dir=output.parent,
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(handle, "wb") as target:
            target.write(payload)
            target.flush()
            os.fsync(target.fileno())
        # Validate the exact serialized descriptor before publishing it.
        read_source_descriptor(temporary)
        os.replace(temporary, output)
    finally:
        if temporary.exists():
            temporary.unlink()


def _reject_source_output_alias(output: Path, sources: Sequence[Path]) -> None:
    if not output.parent.is_dir():
        raise FileNotFoundError(
            f"source descriptor output parent does not exist: {output.parent}"
        )
    canonical_output = output.parent.resolve(strict=True) / output.name
    output_exists = os.path.lexists(output)
    for source in sources:
        canonical_source = source.resolve(strict=True)
        same_file = False
        if output_exists:
            try:
                same_file = os.path.samefile(output, source)
            except OSError:
                same_file = False
        if canonical_output == canonical_source or same_file:
            raise ValueError(
                "source descriptor output cannot replace station or velocity input"
            )


def generate_source_descriptor(
    data_directory: str | Path,
    output_path: str | Path,
    *,
    dataset_id: str,
    source_revision: str,
    model_times: Sequence[int | float] | None = None,
    unit: str = "unspecified",
    basis: str = "unspecified",
    time_unit: str = "unspecified",
    phase: str = "unspecified",
    authority: SourceAuthority = SourceAuthority(),
    station_filename: str = "station.bin",
    topology: DelaunayTopology = DelaunayTopology(),
    interpolation: TriangleLinearInterpolation = TriangleLinearInterpolation(),
    overwrite: bool = False,
) -> SourceDescriptorGenerationResult:
    """Generate one strict schema-v3 descriptor from station and velocity pair files."""
    if not isinstance(authority, SourceAuthority):
        raise TypeError("authority must be a SourceAuthority")
    if authority.topology != "inferred":
        raise ValueError("Delaunay topology authority must be inferred")
    if not isinstance(topology, DelaunayTopology):
        raise TypeError("topology must be a DelaunayTopology")
    if not isinstance(interpolation, TriangleLinearInterpolation):
        raise TypeError("interpolation must be a TriangleLinearInterpolation")
    if Path(station_filename).name != station_filename or not station_filename:
        raise ValueError("station_filename must be a source-directory filename")

    source_directory = Path(data_directory).resolve()
    if not source_directory.is_dir():
        raise FileNotFoundError(
            f"Flow Field source directory does not exist: {source_directory}"
        )
    output = Path(os.path.abspath(os.fspath(output_path)))
    station = _inspect_pair_file(
        source_directory / station_filename,
        "station",
    )
    if station.pair_count < 3:
        raise ValueError("station source must contain at least three coordinate pairs")
    velocity_files = _velocity_files(source_directory)
    _reject_source_output_alias(
        output,
        (
            source_directory / station_filename,
            *(path for _time_index, path in velocity_files),
        ),
    )
    times = _model_times(velocity_files, model_times)
    fields = []
    for time_index, ((numeric_index, path), model_time) in enumerate(
        zip(velocity_files, times, strict=True)
    ):
        facts = _inspect_pair_file(
            path,
            f"velocity {numeric_index}",
            expected_count=station.pair_count,
        )
        fields.append({
            "timeIndex": time_index,
            "modelTime": model_time,
            "file": facts.filename,
            "sha256": facts.sha256,
        })
    raw = {
        "schemaVersion": 3,
        "datasetId": dataset_id,
        "sourceRevision": source_revision,
        "stationCount": station.pair_count,
        "fieldCount": len(fields),
        "unit": unit,
        "basis": basis,
        "timeUnit": time_unit,
        "phase": phase,
        "authority": authority.manifest(),
        "station": {
            "file": station.filename,
            "sha256": station.sha256,
        },
        "fields": fields,
        "topology": topology.manifest(),
        "interpolation": interpolation.manifest(),
    }
    payload = (json.dumps(
        raw,
        allow_nan=False,
        ensure_ascii=False,
        indent=2,
        sort_keys=True,
    ) + "\n").encode("utf-8")
    _write_descriptor_atomically(output, payload, overwrite=overwrite)
    descriptor = read_source_descriptor(output)
    return SourceDescriptorGenerationResult(
        output_path=output,
        descriptor=descriptor,
        descriptor_sha256=hashlib.sha256(payload).hexdigest(),
        source_hash=source_descriptor_hash(descriptor),
    )


def _parse_model_times(value: str) -> tuple[int | float, ...]:
    if not value:
        raise argparse.ArgumentTypeError("model times cannot be empty")
    values: list[int | float] = []
    for token in value.split(","):
        if not token or token.strip() != token:
            raise argparse.ArgumentTypeError(
                "model times must be comma-separated numbers without whitespace"
            )
        try:
            parsed: int | float = (
                int(token)
                if re.fullmatch(r"[+-]?\d+", token)
                else float(token)
            )
        except ValueError as error:
            raise argparse.ArgumentTypeError(
                f"invalid model time: {token}"
            ) from error
        if not math.isfinite(parsed):
            raise argparse.ArgumentTypeError(f"model time must be finite: {token}")
        values.append(parsed)
    return tuple(values)


def main(argv: Sequence[str] | None = None) -> None:
    parser = argparse.ArgumentParser(
        description="Generate a strict Flow Field source descriptor from station/UV binaries"
    )
    parser.add_argument("--source", type=Path, default=DEFAULT_DATA_DIRECTORY)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--dataset-id", required=True)
    parser.add_argument("--source-revision", required=True)
    parser.add_argument("--station-file", default="station.bin")
    parser.add_argument("--model-times", type=_parse_model_times)
    parser.add_argument("--unit", default="unspecified")
    parser.add_argument("--basis", default="unspecified")
    parser.add_argument("--time-unit", default="unspecified")
    parser.add_argument("--phase", default="unspecified")
    for name in ("unit", "basis", "time", "phase"):
        parser.add_argument(
            f"--{name}-authority",
            choices=("authoritative", "unconfirmed"),
            default="unconfirmed",
        )
    parser.add_argument(
        "--topology-authority",
        choices=("inferred",),
        default="inferred",
        help="Delaunay is inferred in the current implementation",
    )
    parser.add_argument(
        "--duplicate-policy",
        choices=("error", "first", "mean"),
        default="error",
    )
    parser.add_argument("--local-spacing-neighbors", type=int, default=8)
    parser.add_argument("--maximum-edge-ratio", type=float, default=16.0)
    parser.add_argument("--maximum-edge-length-meters", type=float)
    parser.add_argument("--stationary-epsilon", type=float, default=0.0)
    parser.add_argument("--overwrite", action="store_true")
    arguments = parser.parse_args(argv)
    result = generate_source_descriptor(
        arguments.source,
        arguments.output,
        dataset_id=arguments.dataset_id,
        source_revision=arguments.source_revision,
        model_times=arguments.model_times,
        unit=arguments.unit,
        basis=arguments.basis,
        time_unit=arguments.time_unit,
        phase=arguments.phase,
        authority=SourceAuthority(
            unit=arguments.unit_authority,
            basis=arguments.basis_authority,
            time=arguments.time_authority,
            phase=arguments.phase_authority,
            topology=arguments.topology_authority,
        ),
        station_filename=arguments.station_file,
        topology=DelaunayTopology(
            duplicate_policy=arguments.duplicate_policy,
            local_spacing_neighbors=arguments.local_spacing_neighbors,
            maximum_edge_ratio=arguments.maximum_edge_ratio,
            maximum_edge_length_meters=arguments.maximum_edge_length_meters,
        ),
        interpolation=TriangleLinearInterpolation(
            stationary_epsilon=arguments.stationary_epsilon,
        ),
        overwrite=arguments.overwrite,
    )
    print(json.dumps({
        "descriptor": str(result.output_path),
        "descriptorSha256": result.descriptor_sha256,
        "fieldCount": result.descriptor.field_count,
        "sourceHash": result.source_hash,
        "stationCount": result.descriptor.station_count,
    }, sort_keys=True))


if __name__ == "__main__":
    main()
