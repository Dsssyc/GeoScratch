"""Bounded, opt-in UV-only policy experiment; not imported by production builds.

The base variants compare ordinary linear TIN samples and existing all-moving TIN
support at the same pixel centers. Neither adds 3x3 erosion. An overview is nonzero only if all four
stored child vectors are nonzero and their Float32 vector mean is nonzero. Thus a
zero *represented in the base grid* never acquires a nonzero ancestor. This cannot
certify geometric dry barriers which the base pixel centers never sampled, or a
downstream bilinear filter which mixes zero support with neighboring active values.
"""
from __future__ import annotations

import numpy as np


def candidate_policy_manifest() -> dict[str, object]:
    """Return a distinct proof identity, never an existing snapshot-v2 identity."""
    return {
        "artifactType": "flow-field-local-uv-support-proof",
        "schemaVersion": 1,
        "candidateOnly": True,
        "candidateConstructionPolicyVersion": 3,
        "basePolicies": ["triangle-center-linear-no-erosion-v1",
                         "triangle-center-all-moving-no-erosion-v1"],
        "overviewPolicy": "recursive-zero-preserving-vector-box-v2",
        "baseSampling": "pixel-center-no-neighborhood-erosion",
        "childFootprint": "2x2-nw-ne-sw-se",
        "childSupport": "all-four-finite-and-not-both-exact-zero",
        "componentReduction": "fixed-row-major-float64-mean-cast-float32-once",
        "roundedZero": "non-advectable-never-resurrected",
        "outsideExtent": "non-advectable",
        "supportGuarantee": "stored-parent-nonzero-implies-all-base-descendants-nonzero",
        "geometryLimit": "sub-base-pixel-unsampled-dry-barriers-not-certified",
        "frontendLimit": "unrestricted-bilinear-support-expansion-not-certified",
        "candidateFrontendGate": "nearest-texel-zero-footprint-then-bilinear-v1",
    }


def reduce_nonexpanding_uv(child: np.ndarray) -> np.ndarray:
    """Reduce one UV grid without eroding any neighboring parent footprint."""
    values = np.asarray(child, dtype="<f4")
    if values.ndim != 3 or values.shape[2] != 2 or min(values.shape[:2]) < 1:
        raise ValueError("UV proof input must have nonempty shape (height, width, 2)")
    if not np.isfinite(values).all():
        raise ValueError("UV proof input must contain finite U/V values")
    height, width = values.shape[:2]
    rows, columns = (height + 1) // 2, (width + 1) // 2
    padded = np.zeros((rows * 2, columns * 2, 2), dtype=np.float64)
    padded[:height, :width] = values
    children = padded.reshape(rows, 2, columns, 2, 2)
    averaged = ((children[:, 0, :, 0] + children[:, 0, :, 1]) +
                (children[:, 1, :, 0] + children[:, 1, :, 1])) * 0.25
    result = averaged.astype("<f4")
    supported = np.any(children != 0.0, axis=4).all(axis=(1, 3))
    supported &= np.any(result != 0.0, axis=2)
    result[~supported] = 0.0
    result[result == 0.0] = 0.0
    return result


def sample_tin_centers(stencil, unique_field: np.ndarray, *, all_moving: bool) -> np.ndarray:
    """Compare base semantics without changing the supplied accepted topology."""
    values = np.asarray(unique_field, dtype=np.float64)
    if values.ndim != 2 or values.shape[1] != 2 or not np.isfinite(values).all():
        raise ValueError("TIN proof requires finite U/V pairs")
    result = np.zeros((stencil.target_count, 2), dtype="<f4")
    vertices = values[stencil.vertex_indices]
    interpolated = np.einsum("ki,kic->kc", stencil.weights, vertices, optimize=True).astype("<f4")
    selected = (np.all(np.linalg.norm(vertices, axis=2) > stencil.interpolation.stationary_epsilon, axis=1)
                if all_moving else np.ones(len(stencil.target_indices), dtype=bool))
    result[stencil.target_indices[selected]] = interpolated[selected]
    result[result == 0.0] = 0.0
    return result


def sample_zero_gated_bilinear(values: np.ndarray, positions: np.ndarray) -> np.ndarray:
    """Reference only: center-indexed XY samples, zero outside nearest texel support.

    Integer XY identifies a texel center; each texel owns [i-.5, i+.5). The gate
    constrains support, not vector interpolation weights or velocity magnitude.
    """
    pixels = np.asarray(values, dtype="<f4")
    xy = np.asarray(positions, dtype=np.float64)
    if pixels.ndim != 3 or pixels.shape[2] != 2 or min(pixels.shape[:2]) < 1:
        raise ValueError("UV gate requires nonempty shape (height, width, 2)")
    if xy.ndim != 2 or xy.shape[1] != 2:
        raise ValueError("UV gate positions require shape (count, 2)")
    if not np.isfinite(pixels).all() or not np.isfinite(xy).all():
        raise ValueError("UV gate requires finite inputs")
    height, width = pixels.shape[:2]
    result = np.zeros((len(xy), 2), dtype="<f4")
    inside = (xy[:, 0] >= -.5) & (xy[:, 0] < width - .5)
    inside &= (xy[:, 1] >= -.5) & (xy[:, 1] < height - .5)
    targets = np.flatnonzero(inside)
    if not len(targets):
        return result
    points = xy[targets]
    nearest = np.floor(points + .5).astype(np.int64)
    support = np.any(pixels[nearest[:, 1], nearest[:, 0]] != 0.0, axis=1)
    targets, points = targets[support], points[support]
    lower = np.floor(points).astype(np.int64)
    fraction = points - lower
    lower_x = np.clip(lower[:, 0], 0, width - 1)
    lower_y = np.clip(lower[:, 1], 0, height - 1)
    upper_x = np.clip(lower[:, 0] + 1, 0, width - 1)
    upper_y = np.clip(lower[:, 1] + 1, 0, height - 1)
    fx, fy = fraction[:, 0, None], fraction[:, 1, None]
    top = pixels[lower_y, lower_x] * (1 - fx) + pixels[lower_y, upper_x] * fx
    bottom = pixels[upper_y, lower_x] * (1 - fx) + pixels[upper_y, upper_x] * fx
    result[targets] = (top * (1 - fy) + bottom * fy).astype("<f4")
    return result
