from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any, Literal, TypeAlias


DuplicatePolicy: TypeAlias = Literal["error", "first", "mean"]


@dataclass(frozen=True, slots=True)
class BuildBudget:
    """Bounds page count, raw output bytes, and the disk reserve for one build."""

    max_spatial_pages: int = 4_096
    max_raw_page_bytes: int = 8 * 1024 * 1024 * 1024
    minimum_free_bytes: int = 64 * 1024 * 1024

    def __post_init__(self) -> None:
        for name, value in (
            ("max_spatial_pages", self.max_spatial_pages),
            ("max_raw_page_bytes", self.max_raw_page_bytes),
            ("minimum_free_bytes", self.minimum_free_bytes),
        ):
            if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
                raise ValueError(f"{name} must be a positive integer")


class UnsupportedTopologyError(ValueError):
    """Raised when a build requests a topology strategy this version cannot prepare."""

    code = "UNSUPPORTED_TOPOLOGY"


class UnsupportedInterpolationError(ValueError):
    """Raised when a build requests an interpolation strategy this version cannot apply."""

    code = "UNSUPPORTED_INTERPOLATION"


@dataclass(frozen=True, slots=True)
class DelaunayTopology:
    """Infers one reusable triangular topology from otherwise topology-free stations."""

    kind: Literal["delaunay"] = field(default="delaunay", init=False)
    duplicate_policy: DuplicatePolicy = "error"
    local_spacing_neighbors: int = 8
    maximum_edge_ratio: float | None = 16.0
    maximum_edge_length_meters: float | None = None

    def __post_init__(self) -> None:
        if self.duplicate_policy not in {"error", "first", "mean"}:
            raise ValueError("duplicate_policy must be error, first, or mean")
        if isinstance(self.local_spacing_neighbors, bool) or not isinstance(
            self.local_spacing_neighbors, int
        ) or self.local_spacing_neighbors < 2:
            raise ValueError("local_spacing_neighbors must be an integer greater than one")
        if self.maximum_edge_ratio is not None and (
            isinstance(self.maximum_edge_ratio, bool)
            or not isinstance(self.maximum_edge_ratio, (int, float))
            or not math.isfinite(self.maximum_edge_ratio)
            or self.maximum_edge_ratio <= 1.0
        ):
            raise ValueError("maximum_edge_ratio must be a finite number greater than one or None")
        if (
            self.maximum_edge_length_meters is not None
            and (
                isinstance(self.maximum_edge_length_meters, bool)
                or not isinstance(self.maximum_edge_length_meters, (int, float))
                or not math.isfinite(self.maximum_edge_length_meters)
                or self.maximum_edge_length_meters <= 0.0
            )
        ):
            raise ValueError(
                "maximum_edge_length_meters must be a finite positive number or None"
            )

    def manifest(self) -> dict[str, Any]:
        return {
            "kind": self.kind,
            "duplicatePolicy": self.duplicate_policy,
            "localSpacingNeighbors": self.local_spacing_neighbors,
            "maximumEdgeRatio": self.maximum_edge_ratio,
            "maximumEdgeLengthMeters": self.maximum_edge_length_meters,
        }


@dataclass(frozen=True, slots=True)
class TriangleLinearInterpolation:
    """Interpolates U/V only where every triangle vertex can advect a particle."""

    kind: Literal["triangle-linear"] = field(default="triangle-linear", init=False)
    stationary_policy: Literal["require-all-moving"] = "require-all-moving"
    stationary_epsilon: float = 0.0

    def __post_init__(self) -> None:
        if self.stationary_policy != "require-all-moving":
            raise ValueError("stationary_policy must be require-all-moving")
        if (
            isinstance(self.stationary_epsilon, bool)
            or not isinstance(self.stationary_epsilon, (int, float))
            or not math.isfinite(self.stationary_epsilon)
            or self.stationary_epsilon < 0.0
        ):
            raise ValueError("stationary_epsilon must be a finite non-negative number")

    def manifest(self) -> dict[str, str | float]:
        return {
            "kind": self.kind,
            "stationaryPolicy": self.stationary_policy,
            "stationaryEpsilon": self.stationary_epsilon,
        }


TopologySpec: TypeAlias = DelaunayTopology
InterpolationSpec: TypeAlias = TriangleLinearInterpolation


def resolve_topology(value: object | None) -> DelaunayTopology:
    if value is None:
        return DelaunayTopology()
    if isinstance(value, DelaunayTopology):
        return value
    raise UnsupportedTopologyError(
        f"unsupported Flow Field topology specification: {type(value).__name__}"
    )


def resolve_interpolation(value: object | None) -> TriangleLinearInterpolation:
    if value is None:
        return TriangleLinearInterpolation()
    if isinstance(value, TriangleLinearInterpolation):
        return value
    raise UnsupportedInterpolationError(
        f"unsupported Flow Field interpolation specification: {type(value).__name__}"
    )


def read_topology_spec(value: Any) -> DelaunayTopology:
    if not isinstance(value, dict) or value.get("kind") != "delaunay":
        raise UnsupportedTopologyError("Flow Field source topology must be delaunay")
    allowed = {
        "kind",
        "duplicatePolicy",
        "localSpacingNeighbors",
        "maximumEdgeRatio",
        "maximumEdgeLengthMeters",
    }
    unknown = set(value) - allowed
    if unknown:
        raise ValueError(
            f"Flow Field Delaunay topology contains unknown keys: {sorted(unknown)}"
        )
    return DelaunayTopology(
        duplicate_policy=value.get("duplicatePolicy", "error"),
        local_spacing_neighbors=value.get("localSpacingNeighbors", 8),
        maximum_edge_ratio=value.get("maximumEdgeRatio", 16.0),
        maximum_edge_length_meters=value.get("maximumEdgeLengthMeters"),
    )


def read_interpolation_spec(value: Any) -> TriangleLinearInterpolation:
    if not isinstance(value, dict) or value.get("kind") != "triangle-linear":
        raise UnsupportedInterpolationError(
            "Flow Field source interpolation must be triangle-linear"
        )
    allowed = {"kind", "stationaryPolicy", "stationaryEpsilon"}
    unknown = set(value) - allowed
    if unknown:
        raise ValueError(
            "Flow Field triangle-linear interpolation contains unknown keys: "
            f"{sorted(unknown)}"
        )
    return TriangleLinearInterpolation(
        stationary_policy=value.get("stationaryPolicy", "require-all-moving"),
        stationary_epsilon=value.get("stationaryEpsilon", 0.0),
    )
