from __future__ import annotations

import hashlib
import json
import math
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

import morecantile

from .cog_tiles import TILE_BYTE_LENGTH, CogVelocityTileReader
from .source import SourceDescriptor, source_descriptor_hash


RUNTIME_MATRICES = tuple(range(4, 10))
RUNTIME_ADAPTER_VERSION = "flow-cog-wmq-rg32f-v1"
WEB_MERCATOR_QUAD_URI = (
    "http://www.opengis.net/def/tilematrixset/OGC/1.0/WebMercatorQuad"
)
WEB_MERCATOR_CRS_URI = "http://www.opengis.net/def/crs/EPSG/0/3857"
WEB_MERCATOR_RADIUS = 6_378_137.0
WEB_MERCATOR_LATITUDE_LIMIT = 85.0511287798066
WEB_MERCATOR_QUAD = morecantile.tms.get("WebMercatorQuad")


@dataclass(frozen=True, slots=True)
class CogRuntimePageIndex:
    descriptor_sha256: str
    source_bounds: tuple[float, float, float, float]
    time_indices: tuple[int, ...]
    matrices: tuple[int, ...]
    limits: tuple[dict[str, int | str], ...]
    pages: tuple[dict[str, Any], ...]
    page_set_sha256: str
    time_maximum_speeds: tuple[dict[str, int | float], ...]
    maximum_speed: float

    def manifest(self) -> dict[str, Any]:
        return {
            "descriptorSha256": self.descriptor_sha256,
            "sourceBounds": list(self.source_bounds),
            "timeIndices": list(self.time_indices),
            "matrices": [str(matrix) for matrix in self.matrices],
            "limits": [dict(limit) for limit in self.limits],
            "pages": [dict(page) for page in self.pages],
            "pageSetSha256": self.page_set_sha256,
            "timeMaximumSpeeds": [
                dict(record) for record in self.time_maximum_speeds
            ],
            "maximumSpeed": self.maximum_speed,
        }


def build_cog_runtime_page_index(
    descriptor: SourceDescriptor,
    readers: Mapping[int, CogVelocityTileReader],
    source_bounds: Sequence[int | float],
    matrices: Sequence[int] = RUNTIME_MATRICES,
) -> CogRuntimePageIndex:
    """Materialize deterministic RG32F page identities without a runtime revision."""
    if not isinstance(descriptor, SourceDescriptor):
        raise TypeError("descriptor must be a SourceDescriptor")
    bounds = _source_bounds(source_bounds)
    selected_matrices = _matrices(matrices)
    selected_times = _reader_time_indices(readers, descriptor.field_count)

    limits: tuple[dict[str, int | str], ...] | None = None
    pages: list[dict[str, Any]] = []
    time_maximum_speeds: list[dict[str, int | float]] = []
    for time_index in selected_times:
        reader = readers[time_index]
        field = descriptor.fields[time_index]
        if (
            not isinstance(reader, CogVelocityTileReader)
            or reader.time_index != time_index
            or field.time_index != time_index
            or tuple(reader.source_bounds) != bounds
            or any(matrix not in reader.supported_matrices for matrix in selected_matrices)
        ):
            raise ValueError(
                f"Flow Field COG reader t{time_index:02d} does not match its descriptor selection"
            )
        reader_limits = tuple(
            _limit_record(matrix, reader.tile_limits(matrix))
            for matrix in selected_matrices
        )
        if limits is None:
            limits = reader_limits
        elif reader_limits != limits:
            raise ValueError("Flow Field COG readers do not share one runtime coverage")

        time_maximum = 0.0
        for limit in reader_limits:
            matrix = int(limit["matrixId"])
            for tile_row in range(
                int(limit["minTileRow"]),
                int(limit["maxTileRow"]) + 1,
            ):
                for tile_col in range(
                    int(limit["minTileCol"]),
                    int(limit["maxTileCol"]) + 1,
                ):
                    tile = reader.read_tile(matrix, tile_row, tile_col)
                    path = (
                        f"tiles/WebMercatorQuad/t{time_index:02d}/{matrix}/"
                        f"{tile_row}/{tile_col}.rg32f"
                    )
                    record = {
                        "timeIndex": time_index,
                        "matrixId": str(matrix),
                        "tileRow": tile_row,
                        "tileCol": tile_col,
                        "path": path,
                        "byteLength": TILE_BYTE_LENGTH,
                        "sha256": tile.sha256,
                        "maximumSpeed": tile.maximum_speed,
                    }
                    pages.append(record)
                    time_maximum = max(time_maximum, tile.maximum_speed)
        time_maximum_speeds.append({
            "timeIndex": time_index,
            "pageMaximumSpeed": time_maximum,
        })

    if limits is None:
        raise RuntimeError("Flow Field COG page indexing produced no limits")
    page_set_sha256 = _page_set_sha256(pages)
    return CogRuntimePageIndex(
        descriptor_sha256=source_descriptor_hash(descriptor),
        source_bounds=bounds,
        time_indices=selected_times,
        matrices=selected_matrices,
        limits=limits,
        pages=tuple(pages),
        page_set_sha256=page_set_sha256,
        time_maximum_speeds=tuple(time_maximum_speeds),
        maximum_speed=max(
            (float(record["pageMaximumSpeed"]) for record in time_maximum_speeds),
            default=0.0,
        ),
    )


def build_cog_runtime_manifest(
    descriptor: SourceDescriptor,
    collection_content_version: str,
    page_index: CogRuntimePageIndex,
    quality: Mapping[str, Any],
) -> dict[str, Any]:
    """Bind one precomputed page index to a temporal collection revision."""
    if not isinstance(descriptor, SourceDescriptor):
        raise TypeError("descriptor must be a SourceDescriptor")
    if not isinstance(collection_content_version, str) or not collection_content_version:
        raise ValueError("collection_content_version must be a non-empty string")
    if not isinstance(page_index, CogRuntimePageIndex):
        raise TypeError("page_index must be a CogRuntimePageIndex")
    if page_index.descriptor_sha256 != source_descriptor_hash(descriptor):
        raise ValueError("Flow Field runtime page index belongs to another descriptor")
    quality_snapshot = _quality(quality)
    matrices = page_index.matrices
    spatial_page_count = sum(
        (int(limit["maxTileRow"]) - int(limit["minTileRow"]) + 1)
        * (int(limit["maxTileCol"]) - int(limit["minTileCol"]) + 1)
        for limit in page_index.limits
    )
    manifest = {
        "schemaVersion": 1,
        "artifactType": "flow-field-cog-runtime",
        "datasetId": descriptor.dataset_id,
        "sourceRevision": descriptor.source_revision,
        "sourceHash": page_index.descriptor_sha256,
        "contentVersion": collection_content_version,
        "stationCount": descriptor.station_count,
        "source": {
            "crs": "EPSG:4326",
            "geographicBounds": list(page_index.source_bounds),
        },
        "projectedBounds": {
            "crs": WEB_MERCATOR_CRS_URI,
            "bounds": list(_projected_bounds(page_index.source_bounds)),
        },
        "times": [
            {
                "timeIndex": field.time_index,
                "modelTime": field.model_time,
                "unit": descriptor.time_unit or "ordinal",
                "phase": descriptor.phase,
                "sourceHash": field.sha256,
            }
            for field in (
                descriptor.fields[time_index]
                for time_index in page_index.time_indices
            )
        ],
        "tileMatrixSet": {
            "id": "WebMercatorQuad",
            "uri": WEB_MERCATOR_QUAD_URI,
            "crs": WEB_MERCATOR_CRS_URI,
            "cornerOfOrigin": "topLeft",
            "tileRowDirection": "south",
            "tileColDirection": "east",
            "tileWidth": 256,
            "tileHeight": 256,
            "minTileMatrix": str(matrices[0]),
            "maxTileMatrix": str(matrices[-1]),
            "tileMatrixIds": [str(matrix) for matrix in matrices],
            "limits": [dict(limit) for limit in page_index.limits],
        },
        "encoding": {
            "channels": 2,
            "componentOrder": ["u", "v"],
            "sampleType": "float32-le",
            "layout": "rg-interleaved",
            "tileWidth": 256,
            "tileHeight": 256,
        },
        "unit": descriptor.unit,
        "basis": descriptor.basis,
        "temporalInterpolation": "component-wise-linear",
        "maximumSpeed": page_index.maximum_speed,
        "timeMaximumSpeeds": [
            dict(record) for record in page_index.time_maximum_speeds
        ],
        "pages": [dict(page) for page in page_index.pages],
        "budgets": {
            "spatialPageCount": spatial_page_count,
            "timePageCount": len(page_index.pages),
            "pageByteLength": TILE_BYTE_LENGTH,
            "totalRawPageBytes": len(page_index.pages) * TILE_BYTE_LENGTH,
        },
        "construction": {
            "algorithmVersion": RUNTIME_ADAPTER_VERSION,
            "adapterVersion": RUNTIME_ADAPTER_VERSION,
            "collectionContentVersion": collection_content_version,
            "pageSetSha256": page_index.page_set_sha256,
            "sampleRegistration": "pixel-center",
            "levelConstruction": "cog-physical-or-global-semantic-recursive",
            "supportFilter": "recursive-conservative-vector-box-v1",
            "unsupportedVelocity": [0.0, 0.0],
            "quality": quality_snapshot,
        },
    }
    validate_cog_runtime_manifest(manifest)
    return manifest


def validate_cog_runtime_manifest(manifest: object) -> None:
    """Validate runtime structure and page identity without reopening any COG."""
    if not isinstance(manifest, dict) or manifest.get("schemaVersion") != 1:
        raise ValueError("Flow Field COG runtime manifest schema is invalid")
    source = manifest.get("source")
    projected = manifest.get("projectedBounds")
    times = manifest.get("times")
    matrix_set = manifest.get("tileMatrixSet")
    encoding = manifest.get("encoding")
    pages = manifest.get("pages")
    budgets = manifest.get("budgets")
    construction = manifest.get("construction")
    time_maximum_speeds = manifest.get("timeMaximumSpeeds")
    if (
        manifest.get("artifactType") != "flow-field-cog-runtime"
        or not _nonempty_string(manifest.get("datasetId"))
        or not _nonempty_string(manifest.get("sourceRevision"))
        or not _sha256(manifest.get("sourceHash"))
        or not _nonempty_string(manifest.get("contentVersion"))
        or not _positive_integer(manifest.get("stationCount"))
        or not _nonempty_string(manifest.get("unit"))
        or not _nonempty_string(manifest.get("basis"))
        or manifest.get("temporalInterpolation") != "component-wise-linear"
        or not isinstance(source, dict)
        or not isinstance(projected, dict)
        or not isinstance(times, list)
        or not times
        or not isinstance(matrix_set, dict)
        or not isinstance(encoding, dict)
        or not isinstance(pages, list)
        or not pages
        or not isinstance(budgets, dict)
        or not isinstance(construction, dict)
        or not isinstance(time_maximum_speeds, list)
    ):
        raise ValueError("Flow Field COG runtime manifest structure is invalid")
    bounds = _source_bounds(source.get("geographicBounds"))
    if source.get("crs") != "EPSG:4326" or projected != {
        "crs": WEB_MERCATOR_CRS_URI,
        "bounds": list(_projected_bounds(bounds)),
    }:
        raise ValueError("Flow Field COG runtime source bounds are invalid")
    time_indices: list[int] = []
    if any(
        not isinstance(field, dict)
        or isinstance(field.get("timeIndex"), bool)
        or not isinstance(field.get("timeIndex"), int)
        or field["timeIndex"] < 0
        or not _finite_number(field.get("modelTime"))
        or not _nonempty_string(field.get("unit"))
        or not _nonempty_string(field.get("phase"))
        or not _sha256(field.get("sourceHash"))
        for field in times
    ):
        raise ValueError("Flow Field COG runtime times are invalid")
    previous_time_index = -1
    previous_model_time: int | float | None = None
    time_unit: str | None = None
    phase: str | None = None
    for field in times:
        time_index = field["timeIndex"]
        if time_index <= previous_time_index:
            raise ValueError("Flow Field COG runtime times are invalid")
        model_time = field["modelTime"]
        if previous_model_time is not None and model_time <= previous_model_time:
            raise ValueError("Flow Field COG runtime model times are invalid")
        if time_unit is not None and field["unit"] != time_unit:
            raise ValueError("Flow Field COG runtime time units are inconsistent")
        if phase is not None and field["phase"] != phase:
            raise ValueError("Flow Field COG runtime phases are inconsistent")
        time_indices.append(time_index)
        previous_time_index = time_index
        previous_model_time = model_time
        time_unit = field["unit"]
        phase = field["phase"]
    if matrix_set.get("tileMatrixIds") != [str(matrix) for matrix in RUNTIME_MATRICES]:
        raise ValueError("Flow Field COG runtime matrices are invalid")
    expected_matrix_set = {
        "id": "WebMercatorQuad",
        "uri": WEB_MERCATOR_QUAD_URI,
        "crs": WEB_MERCATOR_CRS_URI,
        "cornerOfOrigin": "topLeft",
        "tileRowDirection": "south",
        "tileColDirection": "east",
        "tileWidth": 256,
        "tileHeight": 256,
        "minTileMatrix": "4",
        "maxTileMatrix": "9",
        "tileMatrixIds": [str(matrix) for matrix in RUNTIME_MATRICES],
        "limits": matrix_set.get("limits"),
    }
    if matrix_set != expected_matrix_set:
        raise ValueError("Flow Field COG runtime tile matrix set is invalid")
    limits = _limits(matrix_set.get("limits"), bounds)
    if encoding != {
        "channels": 2,
        "componentOrder": ["u", "v"],
        "sampleType": "float32-le",
        "layout": "rg-interleaved",
        "tileWidth": 256,
        "tileHeight": 256,
    }:
        raise ValueError("Flow Field COG runtime encoding is invalid")

    expected_page_count = len(times) * sum(
        (limit[1] - limit[0] + 1) * (limit[3] - limit[2] + 1)
        for limit in limits.values()
    )
    if len(pages) != expected_page_count:
        raise ValueError("Flow Field COG runtime page count is invalid")
    page_index = 0
    observed_time_maximum = {time_index: 0.0 for time_index in time_indices}
    for time_index in time_indices:
        for matrix in RUNTIME_MATRICES:
            min_row, max_row, min_col, max_col = limits[matrix]
            for tile_row in range(min_row, max_row + 1):
                for tile_col in range(min_col, max_col + 1):
                    page = pages[page_index]
                    expected_path = (
                        f"tiles/WebMercatorQuad/t{time_index:02d}/{matrix}/"
                        f"{tile_row}/{tile_col}.rg32f"
                    )
                    if (
                        not isinstance(page, dict)
                        or page.get("timeIndex") != time_index
                        or page.get("matrixId") != str(matrix)
                        or page.get("tileRow") != tile_row
                        or page.get("tileCol") != tile_col
                        or page.get("path") != expected_path
                        or page.get("byteLength") != TILE_BYTE_LENGTH
                        or not _sha256(page.get("sha256"))
                        or not _nonnegative_number(page.get("maximumSpeed"))
                    ):
                        raise ValueError("Flow Field COG runtime page structure is invalid")
                    observed_time_maximum[time_index] = max(
                        observed_time_maximum[time_index],
                        float(page["maximumSpeed"]),
                    )
                    page_index += 1
    if construction.get("pageSetSha256") != _page_set_sha256(pages):
        raise ValueError("Flow Field COG runtime page-set identity is invalid")
    expected_time_maximum = [
        {
            "timeIndex": time_index,
            "pageMaximumSpeed": observed_time_maximum[time_index],
        }
        for time_index in time_indices
    ]
    if time_maximum_speeds != expected_time_maximum:
        raise ValueError("Flow Field COG runtime time maxima are invalid")
    maximum_speed = max(observed_time_maximum.values(), default=0.0)
    if manifest.get("maximumSpeed") != maximum_speed:
        raise ValueError("Flow Field COG runtime maximum speed is invalid")
    spatial_page_count = expected_page_count // len(times)
    if budgets != {
        "spatialPageCount": spatial_page_count,
        "timePageCount": expected_page_count,
        "pageByteLength": TILE_BYTE_LENGTH,
        "totalRawPageBytes": expected_page_count * TILE_BYTE_LENGTH,
    }:
        raise ValueError("Flow Field COG runtime page budgets are invalid")
    if (
        construction.get("algorithmVersion") != RUNTIME_ADAPTER_VERSION
        or construction.get("adapterVersion") != RUNTIME_ADAPTER_VERSION
        or construction.get("collectionContentVersion") != manifest.get("contentVersion")
        or construction.get("sampleRegistration") != "pixel-center"
        or construction.get("levelConstruction")
        != "cog-physical-or-global-semantic-recursive"
        or construction.get("supportFilter")
        != "recursive-conservative-vector-box-v1"
        or construction.get("unsupportedVelocity") != [0.0, 0.0]
        or _quality(construction.get("quality")) != construction.get("quality")
    ):
        raise ValueError("Flow Field COG runtime construction is invalid")


def _limit_record(
    matrix: int,
    limits: tuple[int, int, int, int],
) -> dict[str, int | str]:
    return {
        "matrixId": str(matrix),
        "minTileRow": limits[0],
        "maxTileRow": limits[1],
        "minTileCol": limits[2],
        "maxTileCol": limits[3],
    }


def _limits(
    value: object,
    bounds: tuple[float, float, float, float],
) -> dict[int, tuple[int, int, int, int]]:
    if not isinstance(value, list) or len(value) != len(RUNTIME_MATRICES):
        raise ValueError("Flow Field COG runtime limits are invalid")
    result: dict[int, tuple[int, int, int, int]] = {}
    for matrix, record in zip(RUNTIME_MATRICES, value, strict=True):
        if not isinstance(record, dict) or record.get("matrixId") != str(matrix):
            raise ValueError("Flow Field COG runtime limits are invalid")
        entries = tuple(record.get(name) for name in (
            "minTileRow", "maxTileRow", "minTileCol", "maxTileCol"
        ))
        if any(isinstance(entry, bool) or not isinstance(entry, int) for entry in entries):
            raise ValueError("Flow Field COG runtime limits are invalid")
        minimum_row, maximum_row, minimum_col, maximum_col = entries
        if minimum_row < 0 or minimum_col < 0 or minimum_row > maximum_row or minimum_col > maximum_col:
            raise ValueError("Flow Field COG runtime limits are invalid")
        result[matrix] = (
            minimum_row,
            maximum_row,
            minimum_col,
            maximum_col,
        )
        west, south, east, north = bounds
        northwest = WEB_MERCATOR_QUAD.tile(west, north, matrix)
        southeast = WEB_MERCATOR_QUAD.tile(east, south, matrix)
        if result[matrix] != (
            northwest.y,
            southeast.y,
            northwest.x,
            southeast.x,
        ):
            raise ValueError("Flow Field COG runtime limits do not match source bounds")
    return result


def _page_set_sha256(pages: Sequence[Mapping[str, Any]]) -> str:
    digest = hashlib.sha256()
    for page in pages:
        record = (
            page["timeIndex"],
            page["matrixId"],
            page["tileRow"],
            page["tileCol"],
            page["path"],
            page["byteLength"],
            page["sha256"],
            page["maximumSpeed"],
        )
        digest.update(
            json.dumps(record, separators=(",", ":")).encode("utf-8") + b"\n"
        )
    return digest.hexdigest()


def _projected_bounds(
    bounds: tuple[float, float, float, float],
) -> tuple[float, float, float, float]:
    west, south, east, north = bounds

    def projected_y(latitude: float) -> float:
        clamped = min(
            WEB_MERCATOR_LATITUDE_LIMIT,
            max(-WEB_MERCATOR_LATITUDE_LIMIT, latitude),
        )
        return WEB_MERCATOR_RADIUS * math.asinh(math.tan(math.radians(clamped)))

    return (
        WEB_MERCATOR_RADIUS * math.radians(west),
        projected_y(south),
        WEB_MERCATOR_RADIUS * math.radians(east),
        projected_y(north),
    )


def _matrices(value: Sequence[int]) -> tuple[int, ...]:
    result = tuple(value)
    if result != RUNTIME_MATRICES:
        raise ValueError("Flow Field browser runtime matrices must be exactly z4 through z9")
    return result


def _reader_time_indices(
    readers: object,
    field_count: int,
) -> tuple[int, ...]:
    if not isinstance(readers, Mapping) or not readers:
        raise ValueError("Flow Field COG reader selection cannot be empty")
    values = tuple(readers)
    if any(
        isinstance(value, bool)
        or not isinstance(value, int)
        or value < 0
        or value >= field_count
        for value in values
    ):
        raise ValueError("Flow Field COG reader selection is outside the descriptor")
    return tuple(sorted(values))


def _source_bounds(value: object) -> tuple[float, float, float, float]:
    if (
        not isinstance(value, (list, tuple))
        or len(value) != 4
        or not all(_finite_number(entry) for entry in value)
    ):
        raise ValueError("Flow Field runtime source bounds are invalid")
    bounds = tuple(float(entry) for entry in value)
    if not bounds[0] < bounds[2] or not bounds[1] < bounds[3]:
        raise ValueError("Flow Field runtime source bounds are invalid")
    return bounds


def _quality(value: object) -> dict[str, Any]:
    if not isinstance(value, Mapping):
        raise ValueError("Flow Field runtime quality must be an object")
    try:
        snapshot = json.loads(json.dumps(
            dict(value),
            allow_nan=False,
            sort_keys=True,
            separators=(",", ":"),
        ))
    except (TypeError, ValueError) as error:
        raise ValueError("Flow Field runtime quality must be finite JSON") from error
    if (
        not _nonempty_string(snapshot.get("particleSimulation"))
        or not _nonempty_string(snapshot.get("approvalReason"))
    ):
        raise ValueError(
            "Flow Field runtime quality requires particleSimulation and approvalReason"
        )
    return snapshot


def _sha256(value: object) -> bool:
    return isinstance(value, str) and len(value) == 64 and all(
        character in "0123456789abcdef" for character in value
    )


def _positive_integer(value: object) -> bool:
    return not isinstance(value, bool) and isinstance(value, int) and value > 0


def _finite_number(value: object) -> bool:
    return (
        not isinstance(value, bool)
        and isinstance(value, (int, float))
        and math.isfinite(value)
    )


def _nonnegative_number(value: object) -> bool:
    return _finite_number(value) and float(value) >= 0.0


def _nonempty_string(value: object) -> bool:
    return isinstance(value, str) and bool(value)
