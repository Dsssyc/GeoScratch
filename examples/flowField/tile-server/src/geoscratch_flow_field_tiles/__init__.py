"""Deterministic velocity-only artifacts for the GeoScratch Flow Field example."""

from ._version import PACKAGE_VERSION
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


__version__ = PACKAGE_VERSION

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
