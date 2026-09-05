export const WORLD_HORIZON_COLOR = 0x162235;

export const DEFAULT_WORLD_VIEW = Object.freeze({
  fogNear: 3200,
  fogFar: 18000,
  cameraFar: 20000
});

function roundToHundred(value) {
  return Math.round(value / 100) * 100;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

export function worldViewForBounds(bounds) {
  const width = bounds?.maxX - bounds?.minX;
  const depth = bounds?.maxZ - bounds?.minZ;
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(depth) || depth <= 0) {
    return { ...DEFAULT_WORLD_VIEW };
  }

  const diagonal = Math.hypot(width, depth);
  const cameraFar = clamp(roundToHundred(diagonal * 1.05), 12000, 24000);
  const fogFar = clamp(roundToHundred(cameraFar * 0.9), 9000, cameraFar - 1000);
  const fogNear = clamp(roundToHundred(fogFar * 0.18), 1600, 3500);
  return { fogNear, fogFar, cameraFar };
}
