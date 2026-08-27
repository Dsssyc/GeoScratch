"""Deterministic velocity-only artifacts for the GeoScratch Flow Field example."""

from .contracts import (
    BuildBudget,
    DelaunayTopology,
    TriangleLinearInterpolation,
    UnsupportedInterpolationError,
    UnsupportedTopologyError,
)
from .resolution import (
    ResolutionSelection,
    StationSpacingResolution,
    UnsupportedResolutionError,
)


__version__ = "0.3.0"

__all__ = [
    "DelaunayTopology",
    "ResolutionSelection",
    "StationSpacingResolution",
    "BuildBudget",
    "TriangleLinearInterpolation",
    "UnsupportedInterpolationError",
    "UnsupportedResolutionError",
    "UnsupportedTopologyError",
]
