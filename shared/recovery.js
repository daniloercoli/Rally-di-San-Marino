import { CAR_FOOTPRINT } from './vehicle.js';

function finitePose(pose) {
  return pose && Number.isFinite(pose.x) && Number.isFinite(pose.z) && Number.isFinite(pose.yaw);
}

function wrapAngle(value) {
  let angle = value;
  while (angle > Math.PI) angle -= Math.PI * 2;
  while (angle < -Math.PI) angle += Math.PI * 2;
  return angle;
}

function closestRoadYaw(yaw, preferredYaw) {
  const reverse = wrapAngle(yaw + Math.PI);
  return Math.abs(wrapAngle(yaw - preferredYaw)) <= Math.abs(wrapAngle(reverse - preferredYaw))
    ? wrapAngle(yaw)
    : reverse;
}

function projectPointToEdge(x, z, a, b) {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const lengthSquared = dx * dx + dz * dz;
  if (!(lengthSquared > Number.EPSILON)) return null;
  const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / lengthSquared));
  const pointX = a[0] + dx * t;
  const pointZ = a[1] + dz * t;
  return {
    pointX,
    pointZ,
    distance: Math.hypot(x - pointX, z - pointZ),
    tx: dx / Math.sqrt(lengthSquared),
    tz: dz / Math.sqrt(lengthSquared)
  };
}

function buildingEdges(building, x, z) {
  const rings = [building?.outer, ...(Array.isArray(building?.holes) ? building.holes : [])];
  const edges = [];
  for (const ring of rings) {
    if (!Array.isArray(ring) || ring.length < 3) continue;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      const edge = projectPointToEdge(x, z, a, b);
      if (edge) edges.push({ ...edge, a, b });
    }
  }
  return edges.sort((a, b) => a.distance - b.distance || a.pointX - b.pointX || a.pointZ - b.pointZ);
}

function tangentVehicleYaw(tx, tz, speed) {
  const travelYaw = Math.atan2(tx, -tz);
  return wrapAngle(speed < 0 ? travelYaw + Math.PI : travelYaw);
}

export function isSafeRoadPose(roadIndex, buildingIndex, pose, padding = 0.35) {
  if (!finitePose(pose) || !roadIndex?.query) return false;
  if (!roadIndex.query(pose.x, pose.z).onRoad) return false;
  const paddedFootprint = {
    halfWidth: CAR_FOOTPRINT.halfWidth + Math.max(0, padding),
    halfLength: CAR_FOOTPRINT.halfLength + Math.max(0, padding)
  };
  return !buildingIndex?.intersectsObb?.(pose, paddedFootprint);
}

export function findBuildingGlance(
  roadIndex,
  buildingIndex,
  building,
  previousPose,
  attemptedPose,
  options = {}
) {
  if (!finitePose(previousPose) || !finitePose(attemptedPose) || !roadIndex?.query ||
    !buildingIndex?.intersectsObb || !Array.isArray(building?.outer)) return null;
  const moveX = attemptedPose.x - previousPose.x;
  const moveZ = attemptedPose.z - previousPose.z;
  const moveLength = Math.hypot(moveX, moveZ);
  if (!(moveLength > 0.01)) return null;

  const speed = Number.isFinite(attemptedPose.speed)
    ? attemptedPose.speed
    : Number.isFinite(previousPose.speed) ? previousPose.speed : 0;
  if (Math.abs(speed) < 0.5) return null;
  const minimumTangentRatio = Number.isFinite(options.minimumTangentRatio)
    ? Math.max(0, Math.min(1, options.minimumTangentRatio))
    : 0.55;
  const padding = Number.isFinite(options.padding) ? Math.max(0, options.padding) : 0.05;
  const edges = buildingEdges(building, attemptedPose.x, attemptedPose.z);
  if (edges.length === 0) return null;
  const maximumEdgeDistance = edges[0].distance + 0.9;

  for (const edge of edges) {
    if (edge.distance > maximumEdgeDistance) break;
    const tangentMotion = moveX * edge.tx + moveZ * edge.tz;
    const tangentRatio = Math.abs(tangentMotion) / moveLength;
    if (tangentRatio < minimumTangentRatio) continue;

    const direction = tangentMotion < 0 ? -1 : 1;
    const tx = edge.tx * direction;
    const tz = edge.tz * direction;
    const previousEdge = projectPointToEdge(
      previousPose.x,
      previousPose.z,
      edge.a,
      edge.b
    );
    let outwardX = previousPose.x - (previousEdge?.pointX ?? edge.pointX);
    let outwardZ = previousPose.z - (previousEdge?.pointZ ?? edge.pointZ);
    const outwardLength = Math.hypot(outwardX, outwardZ);
    if (outwardLength > Number.EPSILON) {
      outwardX /= outwardLength;
      outwardZ /= outwardLength;
    } else {
      outwardX = -tz;
      outwardZ = tx;
    }

    const normalMotion = Math.sqrt(Math.max(0, moveLength * moveLength - tangentMotion * tangentMotion));
    const slideDistance = Math.abs(tangentMotion) + normalMotion * 0.3;
    const yaw = tangentVehicleYaw(tx, tz, speed);
    const retainedSpeed = speed * (0.55 + tangentRatio * 0.3);
    for (const fraction of [1, 0.75, 0.5, 0.25]) {
      for (const outward of [0, 0.12, 0.3, 0.6]) {
        const candidate = {
          x: previousPose.x + tx * slideDistance * fraction + outwardX * outward,
          z: previousPose.z + tz * slideDistance * fraction + outwardZ * outward,
          yaw,
          speed: retainedSpeed
        };
        if (isSafeRoadPose(roadIndex, buildingIndex, candidate, padding)) return candidate;
      }
    }
  }
  return null;
}

export function findRoadRecovery(roadIndex, buildingIndex, origin, lastSafePose, options = {}) {
  if (!finitePose(origin) || !roadIndex?.nearestPoints) return null;
  const padding = Number.isFinite(options.padding) ? Math.max(0, options.padding) : 0.35;
  const segmentLimit = Number.isInteger(options.segmentLimit) && options.segmentLimit > 0
    ? options.segmentLimit
    : 32;
  const alongOffsets = Array.isArray(options.alongOffsets)
    ? options.alongOffsets.filter(Number.isFinite)
    : [0, -3, 3, -6, 6, -10, 10, -16, 16, -24, 24, -36, 36];
  const seen = new Set();
  const testCandidate = (pose) => {
    if (!finitePose(pose)) return null;
    const key = `${Math.round(pose.x * 100)},${Math.round(pose.z * 100)},${Math.round(pose.yaw * 1000)}`;
    if (seen.has(key)) return null;
    seen.add(key);
    return isSafeRoadPose(roadIndex, buildingIndex, pose, padding) ? pose : null;
  };

  const direct = testCandidate({ x: origin.x, z: origin.z, yaw: origin.yaw });
  if (direct) return direct;

  if (finitePose(lastSafePose)) {
    const lastSafe = testCandidate({
      x: lastSafePose.x,
      z: lastSafePose.z,
      yaw: lastSafePose.yaw
    });
    if (lastSafe) return lastSafe;
  }

  for (const segment of roadIndex.nearestPoints(origin.x, origin.z, segmentLimit)) {
    const dx = segment.bx - segment.ax;
    const dz = segment.bz - segment.az;
    const length = Math.hypot(dx, dz);
    if (!(length > Number.EPSILON)) continue;
    const tx = dx / length;
    const tz = dz / length;
    const nx = -tz;
    const nz = tx;
    const yaw = closestRoadYaw(segment.yaw, origin.yaw);
    const lateralRoom = Math.max(0, segment.halfW - CAR_FOOTPRINT.halfWidth - padding);
    const lateral = Math.min(1.25, lateralRoom);
    const lateralOffsets = lateral > 0.01 ? [0, lateral, -lateral] : [0];
    for (const along of alongOffsets) {
      const routeT = Math.min(1, Math.max(0, segment.t + along / length));
      const baseX = segment.ax + dx * routeT;
      const baseZ = segment.az + dz * routeT;
      for (const side of lateralOffsets) {
        const candidate = testCandidate({
          x: baseX + nx * side,
          z: baseZ + nz * side,
          yaw
        });
        if (candidate) return candidate;
      }
    }
  }

  return null;
}
