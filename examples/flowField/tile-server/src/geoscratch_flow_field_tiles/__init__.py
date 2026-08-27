"""Deterministic velocity-only artifacts for the GeoScratch Flow Field example."""

from .contracts import (
    BuildBudget,
    DelaunayTopology,
    TriangleLinearInterpolation,
    UnsupportedInterpolationError,
    UnsupportedTopologyError,
)


__version__ = "0.2.0"

__all__ = [
    "DelaunayTopology",
    "BuildBudget",
    "TriangleLinearInterpolation",
    "UnsupportedInterpolationError",
    "UnsupportedTopologyError",
]
