export const CAR_FOOTPRINT = Object.freeze({
  width: 1.8,
  length: 3.4,
  halfWidth: 0.9,
  halfLength: 1.7
});

const HULL_EPSILON = 1e-9;

function finitePositive(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function footprintHalfExtents(footprint) {
  const halfWidth = finitePositive(footprint?.halfWidth)
    ? footprint.halfWidth
    : finitePositive(footprint?.width) ? footprint.width / 2 : Number.NaN;
  const halfLength = finitePositive(footprint?.halfLength)
    ? footprint.halfLength
    : finitePositive(footprint?.length) ? footprint.length / 2 : Number.NaN;
  return finitePositive(halfWidth) && finitePositive(halfLength)
    ? { halfWidth, halfLength }
    : null;
}

export function isFiniteVehiclePose(pose) {
  return !!pose && typeof pose === 'object' &&
    Number.isFinite(pose.x) && Number.isFinite(pose.z) && Number.isFinite(pose.yaw);
}

// yaw=0 points towards -z; the returned ring uses the same x/z coordinates as physics.
export function vehicleObb(pose, footprint = CAR_FOOTPRINT) {
  if (!isFiniteVehiclePose(pose)) return null;
  const extents = footprintHalfExtents(footprint);
  if (!extents) return null;

  const sin = Math.sin(pose.yaw);
  const cos = Math.cos(pose.yaw);
  const fx = sin;
  const fz = -cos;
  const rx = cos;
  const rz = sin;
  const flx = fx * extents.halfLength;
  const flz = fz * extents.halfLength;
  const rwx = rx * extents.halfWidth;
  const rwz = rz * extents.halfWidth;
  return [
    [pose.x + flx + rwx, pose.z + flz + rwz],
    [pose.x - flx + rwx, pose.z - flz + rwz],
    [pose.x - flx - rwx, pose.z - flz - rwz],
    [pose.x + flx - rwx, pose.z + flz - rwz]
  ];
}

function cross(origin, a, b) {
  return (a[0] - origin[0]) * (b[1] - origin[1]) -
    (a[1] - origin[1]) * (b[0] - origin[0]);
}

function convexHull(points) {
  const sorted = points
    .filter((point) => Array.isArray(point) && Number.isFinite(point[0]) && Number.isFinite(point[1]))
    .map((point) => [point[0], point[1]])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (sorted.length < 3) return null;

  const unique = [];
  for (const point of sorted) {
    const previous = unique[unique.length - 1];
    if (!previous || Math.abs(point[0] - previous[0]) > HULL_EPSILON ||
      Math.abs(point[1] - previous[1]) > HULL_EPSILON) {
      unique.push(point);
    }
  }
  if (unique.length < 3) return null;

  const lower = [];
  for (const point of unique) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], point) <= HULL_EPSILON) {
      lower.pop();
    }
    lower.push(point);
  }
  const upper = [];
  for (let i = unique.length - 1; i >= 0; i--) {
    const point = unique[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], point) <= HULL_EPSILON) {
      upper.pop();
    }
    upper.push(point);
  }
  lower.pop();
  upper.pop();
  const hull = lower.concat(upper);
  return hull.length >= 3 ? hull : null;
}

// The hull is a conservative continuous footprint. Server substeps keep yaw changes small,
// while the hull also prevents tunnelling when both endpoint OBBs are clear.
export function sweptVehicleHull(previousPose, nextPose, footprint = CAR_FOOTPRINT) {
  const previous = vehicleObb(previousPose, footprint);
  const next = vehicleObb(nextPose, footprint);
  if (!previous || !next) return null;
  return convexHull(previous.concat(next));
}
