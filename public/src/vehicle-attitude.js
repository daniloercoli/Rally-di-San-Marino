import { CAR_FOOTPRINT } from '../../shared/vehicle.js';

export const MAX_VEHICLE_TILT_RAD = Math.PI / 4;
export const VEHICLE_ATTITUDE_RESPONSE = 10;

const ZERO_ATTITUDE = Object.freeze({ pitch: 0, roll: 0 });

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function finiteAttitude(attitude) {
  return {
    pitch: Number.isFinite(attitude?.pitch) ? attitude.pitch : 0,
    roll: Number.isFinite(attitude?.roll) ? attitude.roll : 0
  };
}

function halfExtent(footprint, halfField, fullField) {
  const half = footprint?.[halfField];
  if (Number.isFinite(half) && half > 0) return half;
  const full = footprint?.[fullField];
  return Number.isFinite(full) && full > 0 ? full / 2 : null;
}

export function vehicleTerrainAttitude(heightAt, pose, footprint = CAR_FOOTPRINT) {
  if (typeof heightAt !== 'function' || !Number.isFinite(pose?.x) ||
    !Number.isFinite(pose?.z) || !Number.isFinite(pose?.yaw)) {
    return { ...ZERO_ATTITUDE };
  }
  const halfLength = halfExtent(footprint, 'halfLength', 'length');
  const halfWidth = halfExtent(footprint, 'halfWidth', 'width');
  if (halfLength === null || halfWidth === null) return { ...ZERO_ATTITUDE };

  const sin = Math.sin(pose.yaw);
  const cos = Math.cos(pose.yaw);
  const fx = sin;
  const fz = -cos;
  const rx = cos;
  const rz = sin;
  let front;
  let rear;
  let right;
  let left;
  try {
    front = heightAt(pose.x + fx * halfLength, pose.z + fz * halfLength);
    rear = heightAt(pose.x - fx * halfLength, pose.z - fz * halfLength);
    right = heightAt(pose.x + rx * halfWidth, pose.z + rz * halfWidth);
    left = heightAt(pose.x - rx * halfWidth, pose.z - rz * halfWidth);
  } catch {
    return { ...ZERO_ATTITUDE };
  }
  if (![front, rear, right, left].every(Number.isFinite)) return { ...ZERO_ATTITUDE };

  return {
    pitch: clamp(
      Math.atan2(front - rear, halfLength * 2),
      -MAX_VEHICLE_TILT_RAD,
      MAX_VEHICLE_TILT_RAD
    ),
    roll: clamp(
      Math.atan2(right - left, halfWidth * 2),
      -MAX_VEHICLE_TILT_RAD,
      MAX_VEHICLE_TILT_RAD
    )
  };
}

export function smoothVehicleAttitude(
  current,
  target,
  dt,
  response = VEHICLE_ATTITUDE_RESPONSE
) {
  const from = finiteAttitude(current);
  const to = finiteAttitude(target);
  const safeDt = Number.isFinite(dt) && dt > 0 ? Math.min(dt, 0.1) : 0;
  const safeResponse = Number.isFinite(response) && response > 0 ? response : 0;
  const amount = 1 - Math.exp(-safeResponse * safeDt);
  return {
    pitch: from.pitch + (to.pitch - from.pitch) * amount,
    roll: from.roll + (to.roll - from.roll) * amount
  };
}

export function composeVehicleAttitude(terrainAttitude, surfaceAttitude) {
  const terrain = finiteAttitude(terrainAttitude);
  const surface = finiteAttitude(surfaceAttitude);
  return {
    pitch: clamp(
      terrain.pitch + surface.pitch,
      -MAX_VEHICLE_TILT_RAD,
      MAX_VEHICLE_TILT_RAD
    ),
    roll: clamp(
      terrain.roll + surface.roll,
      -MAX_VEHICLE_TILT_RAD,
      MAX_VEHICLE_TILT_RAD
    )
  };
}
