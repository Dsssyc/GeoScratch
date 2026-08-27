from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal, TypeAlias


DuplicatePolicy: TypeAlias = Literal["error", "first", "mean"]


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
        if self.maximum_edge_ratio is not None and self.maximum_edge_ratio <= 1.0:
            raise ValueError("maximum_edge_ratio must be greater than one or None")
        if (
            self.maximum_edge_length_meters is not None
            and self.maximum_edge_length_meters <= 0.0
        ):
            raise ValueError("maximum_edge_length_meters must be positive or None")

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
    """Interpolates U and V with the same non-negative barycentric weights."""

    kind: Literal["triangle-linear"] = field(default="triangle-linear", init=False)

    def manifest(self) -> dict[str, str]:
        return {"kind": self.kind}


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
    return TriangleLinearInterpolation()
