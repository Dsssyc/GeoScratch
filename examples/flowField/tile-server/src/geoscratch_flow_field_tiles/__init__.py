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
from .source import SourceAuthority, SourceDescriptor, source_descriptor_hash


__version__ = "0.4.0"

__all__ = [
    "DelaunayTopology",
    "ResolutionSelection",
    "SourceAuthority",
    "SourceDescriptor",
    "StationSpacingResolution",
    "BuildBudget",
    "TriangleLinearInterpolation",
    "UnsupportedInterpolationError",
    "UnsupportedResolutionError",
    "UnsupportedTopologyError",
    "source_descriptor_hash",
]
