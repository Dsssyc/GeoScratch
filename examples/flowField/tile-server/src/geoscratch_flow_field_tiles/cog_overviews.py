from __future__ import annotations

import math
import hashlib
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from xml.etree import ElementTree

import numpy as np
import rasterio
from rasterio.enums import MaskFlags
from rasterio.shutil import copy as rasterio_copy
from rasterio.transform import Affine
from rasterio.windows import Window


SEMANTIC_OVERVIEW_POLICY = "recursive-conservative-vector-box-v1"


@dataclass(frozen=True, slots=True)
class SemanticOverviewLevel:
    index: int
    nominal_factor: int
    width: int
    height: int
    transform: tuple[float, float, float, float, float, float]
    effective_decimation_x: float
    effective_decimation_y: float

    @property
    def raw_bytes(self) -> int:
        return self.width * self.height * 2 * np.dtype("<f4").itemsize

    def block_count(self, block_size: int) -> int:
        _require_positive_integer(block_size, "block_size")
        return (
            math.ceil(self.width / block_size)
            * math.ceil(self.height / block_size)
        )

    def manifest(self) -> dict[str, object]:
        return {
            "index": self.index,
            "nominalFactor": self.nominal_factor,
            "width": self.width,
            "height": self.height,
            "transform": list(self.transform),
            "effectiveDecimationX": self.effective_decimation_x,
            "effectiveDecimationY": self.effective_decimation_y,
            "rawBytes": self.raw_bytes,
        }


@dataclass(frozen=True, slots=True)
class SemanticOverviewBlock:
    values: np.ndarray
    candidate_valid_count: int
    bilinear_safe_count: int
    cancellation_to_zero_count: int


@dataclass(frozen=True, slots=True)
class SemanticOverviewArtifact:
    level: SemanticOverviewLevel
    path: Path
    pixel_sha256: str
    candidate_valid_count: int
    bilinear_safe_count: int
    cancellation_to_zero_count: int
    size_bytes: int

    def manifest(self) -> dict[str, object]:
        return {
            **self.level.manifest(),
            "pixelSha256": self.pixel_sha256,
            "candidateValidPixelCount": self.candidate_valid_count,
            "bilinearSafePixelCount": self.bilinear_safe_count,
            "cancellationToZeroPixelCount": self.cancellation_to_zero_count,
            "intermediateSizeBytes": self.size_bytes,
        }


def plan_semantic_overview_levels(
    width: int,
    height: int,
    transform: tuple[float, float, float, float, float, float],
    *,
    block_size: int,
) -> tuple[SemanticOverviewLevel, ...]:
    _require_positive_integer(width, "width")
    _require_positive_integer(height, "height")
    _require_positive_integer(block_size, "block_size")
    affine = Affine(*transform)
    if (
        not all(math.isfinite(value) for value in affine[:6])
        or affine.a <= 0.0
        or affine.e >= 0.0
        or affine.b != 0.0
        or affine.d != 0.0
    ):
        raise ValueError("overview transform must be finite north-up with no rotation")

    base_width = width
    base_height = height
    extent_width = (affine.c + affine.a * base_width) - affine.c
    extent_height = affine.f - (affine.f + affine.e * base_height)
    levels: list[SemanticOverviewLevel] = []
    factor = 1
    while width > block_size or height > block_size:
        width = (width + 1) // 2
        height = (height + 1) // 2
        factor *= 2
        level_transform = Affine(
            extent_width / width,
            0.0,
            affine.c,
            0.0,
            -extent_height / height,
            affine.f,
        )
        levels.append(SemanticOverviewLevel(
            index=len(levels),
            nominal_factor=factor,
            width=width,
            height=height,
            transform=tuple(level_transform)[:6],
            effective_decimation_x=base_width / width,
            effective_decimation_y=base_height / height,
        ))
    return tuple(levels)


def reduce_semantic_overview(child_values: np.ndarray) -> SemanticOverviewBlock:
    values = _require_velocity_values(child_values)
    child_height, child_width, _components = values.shape
    parent_height = (child_height + 1) // 2
    parent_width = (child_width + 1) // 2
    padded = np.zeros(
        (2 * (parent_height + 2), 2 * (parent_width + 2), 2),
        dtype="<f4",
    )
    padded[2:2 + child_height, 2:2 + child_width] = values
    return reduce_semantic_overview_block(
        padded,
        output_height=parent_height,
        output_width=parent_width,
    )


def reduce_semantic_overview_block(
    child_values_with_parent_halo: np.ndarray,
    *,
    output_height: int,
    output_width: int,
) -> SemanticOverviewBlock:
    _require_positive_integer(output_height, "output_height")
    _require_positive_integer(output_width, "output_width")
    values = _require_velocity_values(child_values_with_parent_halo)
    expected_shape = (2 * (output_height + 2), 2 * (output_width + 2), 2)
    if values.shape != expected_shape:
        raise ValueError(
            "semantic overview block requires two child samples for every "
            "output pixel and one parent-pixel halo"
        )

    candidate_values, candidate_valid, cancellation = _reduce_candidates(values)
    bilinear_safe = _erode_3x3(candidate_valid)
    central_values = candidate_values[1:-1, 1:-1].copy()
    central_candidates = candidate_valid[1:-1, 1:-1]
    central_cancellation = cancellation[1:-1, 1:-1]
    central_values[~bilinear_safe] = 0.0
    central_values[central_values == 0.0] = 0.0
    return SemanticOverviewBlock(
        values=central_values.astype("<f4", copy=False),
        candidate_valid_count=int(np.count_nonzero(central_candidates)),
        bilinear_safe_count=int(np.count_nonzero(bilinear_safe)),
        cancellation_to_zero_count=int(np.count_nonzero(central_cancellation)),
    )


def write_semantic_overviews(
    base_path: str | Path,
    output_directory: str | Path,
    levels: tuple[SemanticOverviewLevel, ...],
    *,
    block_size: int,
    temporary_compression_level: int = 1,
    staging_observer: Callable[[str], None] | None = None,
) -> tuple[SemanticOverviewArtifact, ...]:
    _require_positive_integer(block_size, "block_size")
    if (
        isinstance(temporary_compression_level, bool)
        or not isinstance(temporary_compression_level, int)
        or not 1 <= temporary_compression_level <= 9
    ):
        raise ValueError("temporary_compression_level must be an integer in [1, 9]")
    source_path = Path(base_path).resolve()
    output = Path(output_directory).resolve()
    if not source_path.is_file():
        raise FileNotFoundError(f"base COG source does not exist: {source_path}")
    if not output.is_dir():
        raise FileNotFoundError(f"overview output directory does not exist: {output}")

    artifacts: list[SemanticOverviewArtifact] = []
    previous_path = source_path
    previous_width: int | None = None
    previous_height: int | None = None
    previous_bounds: tuple[float, float, float, float] | None = None
    previous_crs = None
    for expected_index, level in enumerate(levels):
        if level.index != expected_index:
            raise ValueError("semantic overview indices must be contiguous from zero")
        with rasterio.open(previous_path, NUM_THREADS="ALL_CPUS") as source:
            _validate_velocity_dataset(source, "semantic overview source")
            if previous_width is not None and (
                source.width != previous_width or source.height != previous_height
            ):
                raise ValueError("semantic overview source dimensions changed")
            expected_width = (source.width + 1) // 2
            expected_height = (source.height + 1) // 2
            if level.width != expected_width or level.height != expected_height:
                raise ValueError("semantic overview level dimensions are not recursive halves")
            bounds = tuple(source.bounds)
            crs = source.crs
            if previous_bounds is not None and bounds != previous_bounds:
                raise ValueError("semantic overview source bounds changed")
            if previous_crs is not None and crs != previous_crs:
                raise ValueError("semantic overview source CRS changed")
            expected_transform = Affine(
                (bounds[2] - bounds[0]) / level.width,
                0.0,
                bounds[0],
                0.0,
                -(bounds[3] - bounds[1]) / level.height,
                bounds[3],
            )
            if Affine(*level.transform) != expected_transform:
                raise ValueError("semantic overview level transform is invalid")

            destination = output / (
                f"overview-{level.index:02d}-f{level.nominal_factor}.tif"
            )
            profile = {
                "driver": "GTiff",
                "width": level.width,
                "height": level.height,
                "count": 2,
                "dtype": "float32",
                "crs": crs,
                "transform": expected_transform,
                "nodata": None,
                "tiled": True,
                "blockxsize": block_size,
                "blockysize": block_size,
                "compress": "DEFLATE",
                "predictor": 3,
                "zlevel": temporary_compression_level,
                "interleave": "pixel",
                "BIGTIFF": "IF_SAFER",
                "NUM_THREADS": "ALL_CPUS",
            }
            digest = hashlib.sha256()
            candidate_count = 0
            bilinear_safe_count = 0
            cancellation_count = 0
            with rasterio.open(destination, "w", **profile) as target:
                target.set_band_description(1, "U")
                target.set_band_description(2, "V")
                target.update_tags(
                    AREA_OR_POINT="Point",
                    GEOSCRATCH_OVERVIEW_POLICY=SEMANTIC_OVERVIEW_POLICY,
                    GEOSCRATCH_OVERVIEW_FACTOR=str(level.nominal_factor),
                )
                target.update_tags(1, GEOSCRATCH_COMPONENT="u")
                target.update_tags(2, GEOSCRATCH_COMPONENT="v")
                for block_index, (_block, window) in enumerate(
                    target.block_windows(1)
                ):
                    child_window = Window(
                        (int(window.col_off) - 1) * 2,
                        (int(window.row_off) - 1) * 2,
                        (int(window.width) + 2) * 2,
                        (int(window.height) + 2) * 2,
                    )
                    child = source.read(
                        (1, 2),
                        window=child_window,
                        boundless=True,
                        fill_value=0.0,
                        out_dtype="float32",
                    )
                    reduced = reduce_semantic_overview_block(
                        np.moveaxis(child, 0, 2),
                        output_height=int(window.height),
                        output_width=int(window.width),
                    )
                    band_first = np.moveaxis(reduced.values, 2, 0)
                    target.write(band_first, window=window)
                    digest.update(band_first.tobytes(order="C"))
                    candidate_count += reduced.candidate_valid_count
                    bilinear_safe_count += reduced.bilinear_safe_count
                    cancellation_count += reduced.cancellation_to_zero_count
                    if staging_observer is not None and block_index % 64 == 63:
                        staging_observer(
                            f"overview-{level.index}-block-{block_index}"
                        )

            if staging_observer is not None:
                staging_observer(f"overview-{level.index}-complete")

        artifacts.append(SemanticOverviewArtifact(
            level=level,
            path=destination,
            pixel_sha256=digest.hexdigest(),
            candidate_valid_count=candidate_count,
            bilinear_safe_count=bilinear_safe_count,
            cancellation_to_zero_count=cancellation_count,
            size_bytes=destination.stat().st_size,
        ))
        previous_path = destination
        previous_width = level.width
        previous_height = level.height
        previous_bounds = bounds
        previous_crs = crs
    return tuple(artifacts)


def write_explicit_overview_vrt(
    path: str | Path,
    base_path: str | Path,
    overviews: tuple[SemanticOverviewArtifact, ...],
) -> Path:
    destination = Path(path).resolve()
    source_path = Path(base_path).resolve()
    if destination.parent != source_path.parent:
        raise ValueError("VRT and base source must share one owned staging directory")
    if not source_path.is_file():
        raise FileNotFoundError(f"base VRT source does not exist: {source_path}")
    for artifact in overviews:
        if artifact.path.resolve().parent != destination.parent:
            raise ValueError("VRT overview sources must share the staging directory")
        if not artifact.path.is_file():
            raise FileNotFoundError(
                f"VRT overview source does not exist: {artifact.path}"
            )

    with rasterio.open(source_path) as source:
        _validate_velocity_dataset(source, "VRT base source")
        root = ElementTree.Element(
            "VRTDataset",
            rasterXSize=str(source.width),
            rasterYSize=str(source.height),
        )
        srs = ElementTree.SubElement(root, "SRS")
        srs.text = source.crs.to_wkt()
        geotransform = ElementTree.SubElement(root, "GeoTransform")
        geotransform.text = ", ".join(
            format(value, ".17g") for value in source.transform.to_gdal()
        )
        root_tags = source.tags()
        root_tags.update({
            "GEOSCRATCH_OVERVIEW_POLICY": SEMANTIC_OVERVIEW_POLICY,
            "GEOSCRATCH_OVERVIEW_COUNT": str(len(overviews)),
            "GEOSCRATCH_OVERVIEW_FACTORS": ",".join(
                str(artifact.level.nominal_factor) for artifact in overviews
            ),
        })
        _append_metadata(root, root_tags)
        for band_index in (1, 2):
            band = ElementTree.SubElement(
                root,
                "VRTRasterBand",
                dataType="Float32",
                band=str(band_index),
                blockXSize=str(source.block_shapes[band_index - 1][1]),
                blockYSize=str(source.block_shapes[band_index - 1][0]),
            )
            description = ElementTree.SubElement(band, "Description")
            description.text = source.descriptions[band_index - 1]
            _append_metadata(band, source.tags(band_index))
            simple = ElementTree.SubElement(band, "SimpleSource")
            filename = ElementTree.SubElement(
                simple,
                "SourceFilename",
                relativeToVRT="1",
            )
            filename.text = source_path.name
            ElementTree.SubElement(simple, "SourceBand").text = str(band_index)
            ElementTree.SubElement(
                simple,
                "SrcRect",
                xOff="0",
                yOff="0",
                xSize=str(source.width),
                ySize=str(source.height),
            )
            ElementTree.SubElement(
                simple,
                "DstRect",
                xOff="0",
                yOff="0",
                xSize=str(source.width),
                ySize=str(source.height),
            )
            for artifact in overviews:
                overview = ElementTree.SubElement(band, "Overview")
                overview_filename = ElementTree.SubElement(
                    overview,
                    "SourceFilename",
                    relativeToVRT="1",
                )
                overview_filename.text = artifact.path.name
                ElementTree.SubElement(overview, "SourceBand").text = str(
                    band_index
                )
    ElementTree.ElementTree(root).write(
        destination,
        encoding="utf-8",
        xml_declaration=True,
    )
    with rasterio.open(destination) as vrt:
        if len(vrt.overviews(1)) != len(overviews):
            raise RuntimeError("explicit overview VRT did not expose every source level")
    return destination


def assemble_semantic_overview_cog(
    vrt_path: str | Path,
    destination: str | Path,
    *,
    block_size: int,
    compression_level: int,
    big_tiff: str,
) -> None:
    _require_positive_integer(block_size, "block_size")
    if (
        isinstance(compression_level, bool)
        or not isinstance(compression_level, int)
        or not 1 <= compression_level <= 9
    ):
        raise ValueError("compression_level must be an integer in [1, 9]")
    if big_tiff != "IF_SAFER":
        raise ValueError("big_tiff must be IF_SAFER")
    source = Path(vrt_path).resolve()
    target = Path(destination).resolve()
    if not source.is_file():
        raise FileNotFoundError(f"explicit overview VRT does not exist: {source}")
    if source.parent != target.parent:
        raise ValueError("VRT and COG destination must share the staging directory")
    with rasterio.Env(
        GDAL_CACHEMAX=256 * 1024 * 1024,
        GDAL_NUM_THREADS="ALL_CPUS",
    ):
        rasterio_copy(
            source,
            target,
            driver="COG",
            strict=True,
            blocksize=block_size,
            compress="DEFLATE",
            predictor="FLOATING_POINT",
            level=compression_level,
            overview_compress="DEFLATE",
            overview_predictor="FLOATING_POINT",
            overviews="FORCE_USE_EXISTING",
            bigtiff=big_tiff,
            interleave="PIXEL",
            num_threads="ALL_CPUS",
        )


def _append_metadata(parent: ElementTree.Element, tags: dict[str, str]) -> None:
    if not tags:
        return
    metadata = ElementTree.SubElement(parent, "Metadata")
    for key, value in sorted(tags.items()):
        item = ElementTree.SubElement(metadata, "MDI", key=key)
        item.text = value


def _validate_velocity_dataset(dataset, label: str) -> None:
    if (
        dataset.count != 2
        or dataset.dtypes != ("float32", "float32")
        or dataset.nodata is not None
        or dataset.crs is None
        or dataset.transform.b != 0.0
        or dataset.transform.d != 0.0
        or dataset.transform.a <= 0.0
        or dataset.transform.e >= 0.0
        or any(flags != [MaskFlags.all_valid] for flags in dataset.mask_flag_enums)
    ):
        raise ValueError(f"{label} must be a finite two-band Float32 north-up raster")


def _reduce_candidates(
    child_values: np.ndarray,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    height, width, _components = child_values.shape
    if height % 2 or width % 2:
        raise ValueError("candidate reduction requires even child dimensions")
    rows = height // 2
    columns = width // 2
    values = np.asarray(child_values, dtype=np.float64).reshape(
        rows,
        2,
        columns,
        2,
        2,
    )
    first_row = values[:, 0]
    second_row = values[:, 1]
    averaged = (
        (first_row[:, :, 0] + first_row[:, :, 1])
        + (second_row[:, :, 0] + second_row[:, :, 1])
    ) * 0.25
    child_valid = np.any(values != 0.0, axis=4)
    all_children_valid = child_valid.all(axis=(1, 3))
    mean_is_nonzero = np.any(averaged != 0.0, axis=2)
    cancellation = all_children_valid & ~mean_is_nonzero
    candidate_valid = all_children_valid & mean_is_nonzero
    averaged[~candidate_valid] = 0.0
    averaged[averaged == 0.0] = 0.0
    return averaged.astype("<f4"), candidate_valid, cancellation


def _erode_3x3(values: np.ndarray) -> np.ndarray:
    height = values.shape[0] - 2
    width = values.shape[1] - 2
    result = np.ones((height, width), dtype=bool)
    for row_offset in range(3):
        for column_offset in range(3):
            result &= values[
                row_offset:row_offset + height,
                column_offset:column_offset + width,
            ]
    return result


def _require_velocity_values(value: np.ndarray) -> np.ndarray:
    values = np.asarray(value, dtype="<f4")
    if values.ndim != 3 or values.shape[2] != 2:
        raise ValueError("semantic overview input must have shape (height, width, 2)")
    if not np.isfinite(values).all():
        raise ValueError("semantic overview input must contain finite U/V values")
    return values


def _require_positive_integer(value: object, name: str) -> None:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise ValueError(f"{name} must be a positive integer")
