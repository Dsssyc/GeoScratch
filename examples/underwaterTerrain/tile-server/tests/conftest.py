from pathlib import Path

import pytest

from geoscratch_dem_tiles.build import build_dem_cog


TILE_SERVER_ROOT = Path(__file__).resolve().parents[1]
DEM_SOURCE = TILE_SERVER_ROOT.parent / "assets" / "dem.png"


@pytest.fixture(scope="session")
def dem_source() -> Path:
    return DEM_SOURCE


@pytest.fixture(scope="session")
def built_dem(tmp_path_factory: pytest.TempPathFactory):
    output_directory = tmp_path_factory.mktemp("dem-cog")
    return build_dem_cog(DEM_SOURCE, output_directory)
