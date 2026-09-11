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
    FixedResolutionSelection,
    FixedWebMercatorResolution,
    ResolutionSelection,
    StationSpacingResolution,
    UnsupportedResolutionError,
)
from .source import (
    SourceAuthority,
    SourceDescriptor,
    source_descriptor_hash,
    source_snapshot_hash,
)


__version__ = PACKAGE_VERSION

__all__ = [
    "DelaunayTopology",
    "FixedResolutionSelection",
    "FixedWebMercatorResolution",
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
    "source_snapshot_hash",
]
