"""Local COG source adapter for the GeoScratch DEM example."""

from .build import BuildResult, build_dem_cog
from .service import create_app

__all__ = ["BuildResult", "build_dem_cog", "create_app"]
