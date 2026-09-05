import { ELEVATION_SCHEMA_VERSION } from '../../shared/elevation.js';

const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const validatedTerrains = new WeakSet();

export const CAR_SURFACE_CLEARANCE = 0.1;
export const CAMERA_SURFACE_CLEARANCE = 2.5;
export const RENDER_ELEVATION_SCALE = 1;

export class WorldDataError extends Error {
  constructor(message) {
    super(message);
    this.name = 'WorldDataError';
  }
}

function fail(message) {
  throw new WorldDataError(message);
}

function requireFinite(value, field) {
  if (!Number.isFinite(value)) fail(`elevation.json: ${field} must be finite`);
}

export function validateTerrainData(terrain) {
  if (!terrain || typeof terrain !== 'object' || Array.isArray(terrain)) {
    fail('elevation.json: expected an object');
  }
  if (terrain.schemaVersion !== ELEVATION_SCHEMA_VERSION) {
    fail(`elevation.json: unsupported schemaVersion ${String(terrain.schemaVersion)}`);
  }
  if (typeof terrain.roadsSha256 !== 'string' || !SHA256_PATTERN.test(terrain.roadsSha256)) {
    fail('elevation.json: roadsSha256 must be a SHA-256 hex digest');
  }

  requireFinite(terrain.originX, 'originX');
  requireFinite(terrain.originZ, 'originZ');
  requireFinite(terrain.cell, 'cell');
  if (terrain.cell <= 0) fail('elevation.json: cell must be greater than zero');
  if (!Number.isInteger(terrain.cols) || terrain.cols < 2) {
    fail('elevation.json: cols must be an integer greater than or equal to 2');
  }
  if (!Number.isInteger(terrain.rows) || terrain.rows < 2) {
    fail('elevation.json: rows must be an integer greater than or equal to 2');
  }

  const total = terrain.cols * terrain.rows;
  if (!Number.isSafeInteger(total)) fail('elevation.json: cols * rows is too large');
  if (!Array.isArray(terrain.heights) || terrain.heights.length !== total) {
    fail('elevation.json: heights length must equal cols * rows');
  }
  if (!terrain.heights.every(Number.isFinite)) {
    fail('elevation.json: heights must contain only finite numbers');
  }

  validatedTerrains.add(terrain);
  return terrain;
}

function ensureTerrainValidated(terrain) {
  if (!validatedTerrains.has(terrain)) validateTerrainData(terrain);
}

function terrainCellAt(terrain, x, z) {
  if (terrain == null) return 0;
  if (!Number.isFinite(x) || !Number.isFinite(z)) {
    fail('terrain interpolation requires finite coordinates');
  }
  ensureTerrainValidated(terrain);

  const fx = Math.min(terrain.cols - 1, Math.max(0, (x - terrain.originX) / terrain.cell));
  const fz = Math.min(terrain.rows - 1, Math.max(0, (z - terrain.originZ) / terrain.cell));
  const x0 = Math.min(terrain.cols - 2, Math.floor(fx));
  const z0 = Math.min(terrain.rows - 2, Math.floor(fz));
  const tx = fx - x0;
  const tz = fz - z0;
  const row0 = z0 * terrain.cols;
  const row1 = (z0 + 1) * terrain.cols;
  const h00 = terrain.heights[row0 + x0];
  const h10 = terrain.heights[row0 + x0 + 1];
  const h01 = terrain.heights[row1 + x0];
  const h11 = terrain.heights[row1 + x0 + 1];
  return { tx, tz, h00, h10, h01, h11 };
}

export function terrainHeightAt(terrain, x, z) {
  if (terrain == null) return 0;
  const { tx, tz, h00, h10, h01, h11 } = terrainCellAt(terrain, x, z);
  const top = h00 * (1 - tx) + h10 * tx;
  const bottom = h01 * (1 - tx) + h11 * tx;
  return top * (1 - tz) + bottom * tz;
}

export function terrainMeshHeightAt(terrain, x, z) {
  if (terrain == null) return 0;
  const { tx, tz, h00, h10, h01, h11 } = terrainCellAt(terrain, x, z);
  if (tx + tz <= 1) {
    return h00 + tx * (h10 - h00) + tz * (h01 - h00);
  }
  return h11 + (1 - tx) * (h01 - h11) + (1 - tz) * (h10 - h11);
}

export function surfaceHeightWithClearance(terrain, x, z, clearance = 0, fallbackHeight = 0) {
  const safeClearance = Number.isFinite(clearance) && clearance >= 0 ? clearance : 0;
  const safeFallback = Number.isFinite(fallbackHeight) ? fallbackHeight : 0;
  let ground = safeFallback;
  try {
    const sampled = terrainMeshHeightAt(terrain, x, z);
    if (Number.isFinite(sampled)) ground = sampled;
  } catch {
    ground = safeFallback;
  }
  return ground + safeClearance;
}

export function clampHeightAboveTerrain(
  terrain,
  x,
  z,
  height,
  clearance = 0,
  fallbackHeight = 0
) {
  const minimum = surfaceHeightWithClearance(terrain, x, z, clearance, fallbackHeight);
  return Math.max(Number.isFinite(height) ? height : minimum, minimum);
}

export function createTerrainPositions(terrain, verticalOffset = 0) {
  validateTerrainData(terrain);
  if (!Number.isFinite(verticalOffset)) fail('terrain vertical offset must be finite');

  const positions = new Float32Array(terrain.cols * terrain.rows * 3);
  let offset = 0;
  for (let row = 0; row < terrain.rows; row++) {
    for (let col = 0; col < terrain.cols; col++) {
      const x = terrain.originX + col * terrain.cell;
      const y = terrain.heights[row * terrain.cols + col] + verticalOffset;
      const z = terrain.originZ + row * terrain.cell;
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
        fail('elevation.json: terrain vertex positions must be finite');
      }
      positions[offset++] = x;
      positions[offset++] = y;
      positions[offset++] = z;
    }
  }
  return positions;
}

export function terrainBackdropHeight(terrain, margin = 6) {
  const safeMargin = Number.isFinite(margin) && margin >= 0 ? margin : 6;
  if (terrain == null) return -safeMargin;
  ensureTerrainValidated(terrain);
  let minimum = Infinity;
  for (const height of terrain.heights) minimum = Math.min(minimum, height);
  return minimum - safeMargin;
}

export async function readJsonResponse(response, label, { optional404 = false } = {}) {
  if (!response || typeof response !== 'object') fail(`${label}: invalid response`);
  if (optional404 && response.status === 404) return { status: 'absent', data: null };
  if (!response.ok) fail(`${label}: HTTP ${String(response.status)}`);

  let data;
  try {
    data = await response.json();
  } catch (error) {
    fail(`${label}: invalid JSON (${error instanceof Error ? error.message : String(error)})`);
  }
  return { status: 'loaded', data };
}

export function mergeWorldGeometries(geometries, merge) {
  if (!Array.isArray(geometries)) fail('geometry merge requires an array');
  if (geometries.length === 0) return null;
  if (typeof merge !== 'function') fail('geometry merge requires a merge function');

  let merged;
  try {
    merged = merge(geometries, false);
  } catch (error) {
    fail(`geometry merge failed (${error instanceof Error ? error.message : String(error)})`);
  }
  if (!merged) fail('geometry merge returned null');
  return merged;
}
