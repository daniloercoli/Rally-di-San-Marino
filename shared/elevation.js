export const ELEVATION_SCHEMA_VERSION = 1;
export const ELEVATION_CELL_M = 100;
export const ROADS_FILE_NAME = 'roads.json';
export const LEGACY_FILE_NAME = '.elevation-part.json';
export const CHECKPOINT_FILE_NAME = '.elevation-checkpoint.json';
export const RUNTIME_FILE_NAME = 'elevation.json';

export const LEGACY_BASELINE = {
  roadsSha256: '829919268ff16f6e15390780dd4f83ad0cf8f6f7c9b60d9695fd93686bf83100',
  partialSha256: '15a5982741406ab5dc84a6bb87637e1b7c04673bc0acd7b4d16335f55d863e1c',
  completed: 6100
};

const SHA256_RE = /^[0-9a-f]{64}$/;

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function fail(reason) {
  return { ok: false, reason };
}

// Decisione grid v1 (ELEV-01): si conserva la formula legacy
// `floor(span / cell) + 1` in modo che i 6.100 campioni row-major restino
// validi. Il grid copre le strade giocabili ma non necessariamente il margine
// estremo della bbox; un futuro grid v2 (ceil + 1) richiederà un nuovo
// dataset, non una migrazione implicita.
export function gridDescriptor(bbox, cell = ELEVATION_CELL_M) {
  if (!bbox || !isFiniteNumber(bbox.minX) || !isFiniteNumber(bbox.maxX) ||
      !isFiniteNumber(bbox.minZ) || !isFiniteNumber(bbox.maxZ)) {
    throw new Error('grid descriptor: bbox must contain finite coordinates');
  }
  if (bbox.maxX <= bbox.minX || bbox.maxZ <= bbox.minZ) {
    throw new Error('grid descriptor: bbox is degenerate');
  }
  if (!Number.isInteger(cell) || cell <= 0) {
    throw new Error('grid descriptor: cell must be a positive integer');
  }
  const cols = Math.floor((bbox.maxX - bbox.minX) / cell) + 1;
  const rows = Math.floor((bbox.maxZ - bbox.minZ) / cell) + 1;
  return {
    originX: Number(bbox.minX.toFixed(2)),
    originZ: Number(bbox.minZ.toFixed(2)),
    cell,
    cols,
    rows,
    total: cols * rows
  };
}

export function validateGridDescriptor(descriptor) {
  if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor)) {
    return fail('descriptor must be an object');
  }
  if (!isFiniteNumber(descriptor.originX) || !isFiniteNumber(descriptor.originZ)) {
    return fail('origin must be finite numbers');
  }
  if (!Number.isInteger(descriptor.cell) || descriptor.cell <= 0) {
    return fail('cell must be a positive integer');
  }
  if (!Number.isInteger(descriptor.cols) || descriptor.cols < 1) {
    return fail('cols must be a positive integer');
  }
  if (!Number.isInteger(descriptor.rows) || descriptor.rows < 1) {
    return fail('rows must be a positive integer');
  }
  if (!Number.isInteger(descriptor.total) || descriptor.total !== descriptor.cols * descriptor.rows) {
    return fail('total must equal cols * rows');
  }
  return { ok: true, reason: null };
}

function checkGrid(stored, descriptor, expectTotal) {
  if (stored.originX !== descriptor.originX || stored.originZ !== descriptor.originZ) {
    return 'origin mismatch with the current roads dataset';
  }
  if (stored.cell !== descriptor.cell || stored.cols !== descriptor.cols ||
      stored.rows !== descriptor.rows) {
    return 'grid mismatch with the current roads dataset';
  }
  if (expectTotal !== null && stored.total !== expectTotal) {
    return 'grid mismatch with the current roads dataset';
  }
  return null;
}

export function validateCheckpoint(raw, descriptor, expectedRoadsSha256 = null) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return fail('checkpoint must be a JSON object');
  }
  if (raw.schemaVersion !== ELEVATION_SCHEMA_VERSION) {
    return fail('unsupported schemaVersion ' + JSON.stringify(raw.schemaVersion));
  }
  if (typeof raw.roadsSha256 !== 'string' || !SHA256_RE.test(raw.roadsSha256)) {
    return fail('roadsSha256 must be a 64-character lowercase hex string');
  }
  if (expectedRoadsSha256 && raw.roadsSha256 !== expectedRoadsSha256) {
    return fail('roads hash does not match the current dataset');
  }
  if (!isFiniteNumber(raw.originX) || !isFiniteNumber(raw.originZ)) {
    return fail('origin must be finite numbers');
  }
  const gridMismatch = checkGrid(raw, descriptor, descriptor.total);
  if (gridMismatch) return fail(gridMismatch);
  if (!Number.isInteger(raw.completed) || raw.completed < 0) {
    return fail('completed must be a non-negative integer');
  }
  if (raw.completed > raw.total) {
    return fail('completed exceeds the grid total');
  }
  if (!Array.isArray(raw.elevations)) {
    return fail('elevations must be an array');
  }
  if (raw.elevations.length !== raw.completed) {
    return fail('elevations length must equal completed');
  }
  for (const value of raw.elevations) {
    if (!isFiniteNumber(value)) {
      return fail('elevations must contain only finite numbers');
    }
  }
  return { ok: true, reason: null };
}

export function validateRuntimeAsset(raw, descriptor, expectedRoadsSha256 = null) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return fail('elevation asset must be a JSON object');
  }
  if (raw.schemaVersion !== ELEVATION_SCHEMA_VERSION) {
    return fail('unsupported schemaVersion ' + JSON.stringify(raw.schemaVersion));
  }
  if (typeof raw.roadsSha256 !== 'string' || !SHA256_RE.test(raw.roadsSha256)) {
    return fail('roadsSha256 must be a 64-character lowercase hex string');
  }
  if (expectedRoadsSha256 && raw.roadsSha256 !== expectedRoadsSha256) {
    return fail('roads hash does not match the current dataset');
  }
  if (!isFiniteNumber(raw.originX) || !isFiniteNumber(raw.originZ)) {
    return fail('origin must be finite numbers');
  }
  const gridMismatch = checkGrid(raw, descriptor, null);
  if (gridMismatch) return fail(gridMismatch);
  if (!Array.isArray(raw.heights)) {
    return fail('heights must be an array');
  }
  if (raw.heights.length !== descriptor.total) {
    return fail('heights length must equal cols * rows');
  }
  for (const value of raw.heights) {
    if (!isFiniteNumber(value)) {
      return fail('heights must contain only finite numbers');
    }
  }
  return { ok: true, reason: null };
}

export function validateLegacySource(roadsSha256, partialSha256, values) {
  if (roadsSha256 !== LEGACY_BASELINE.roadsSha256) {
    return fail('roads.json hash does not match the baseline legacy gate');
  }
  if (partialSha256 !== LEGACY_BASELINE.partialSha256) {
    return fail('partial file hash does not match the baseline legacy gate');
  }
  if (!Array.isArray(values)) {
    return fail('legacy partial must be a JSON array');
  }
  if (values.length !== LEGACY_BASELINE.completed) {
    return fail('legacy partial must contain exactly ' + LEGACY_BASELINE.completed + ' values');
  }
  for (const value of values) {
    if (!isFiniteNumber(value)) {
      return fail('legacy partial must contain only finite numbers');
    }
  }
  return { ok: true, reason: null };
}

export function legacyToCheckpoint(values, descriptor, roadsSha256) {
  if (!Array.isArray(values)) {
    return fail('legacy values must be an array');
  }
  if (values.length > descriptor.total) {
    return fail('legacy values exceed the grid total');
  }
  for (const value of values) {
    if (!isFiniteNumber(value)) {
      return fail('legacy values must be finite numbers');
    }
  }
  return {
    ok: true,
    reason: null,
    checkpoint: {
      schemaVersion: ELEVATION_SCHEMA_VERSION,
      roadsSha256,
      originX: descriptor.originX,
      originZ: descriptor.originZ,
      cell: descriptor.cell,
      cols: descriptor.cols,
      rows: descriptor.rows,
      total: descriptor.total,
      completed: values.length,
      elevations: values.slice()
    }
  };
}

export function gridSamplePoints(map, descriptor) {
  const lats = [];
  const lons = [];
  for (let j = 0; j < descriptor.rows; j++) {
    for (let i = 0; i < descriptor.cols; i++) {
      const p = map.proj.toLonLat(descriptor.originX + i * descriptor.cell, descriptor.originZ + j * descriptor.cell);
      lats.push(p.lat.toFixed(5));
      lons.push(p.lon.toFixed(5));
    }
  }
  return { lats, lons };
}

function boxBlur(grid, cols, rows, radius) {
  const tmp = new Float64Array(grid.length);
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      let sum = 0, count = 0;
      for (let k = -radius; k <= radius; k++) {
        const i2 = i + k;
        if (i2 >= 0 && i2 < cols) { sum += grid[j * cols + i2]; count++; }
      }
      tmp[j * cols + i] = sum / count;
    }
  }
  const out = new Float64Array(grid.length);
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      let sum = 0, count = 0;
      for (let k = -radius; k <= radius; k++) {
        const j2 = j + k;
        if (j2 >= 0 && j2 < rows) { sum += tmp[j2 * cols + i]; count++; }
      }
      out[j * cols + i] = sum / count;
    }
  }
  return out;
}

export function buildFinalAsset({ elev, map, descriptor, roadsSha256 }) {
  const { cell, cols, rows, total } = descriptor;
  if (!elev || elev.length !== total) {
    throw new Error('buildFinalAsset: raw elevations must have length cols * rows');
  }
  const b = map.bbox;
  const w = b.maxX - b.minX;
  const h = b.maxZ - b.minZ;
  const base = boxBlur(boxBlur(elev, cols, rows, 2), cols, rows, 2);
  const dc = 10;
  const gw = Math.floor(w / dc) + 2;
  const gh = Math.floor(h / dc) + 2;
  const dist = new Float32Array(gw * gh).fill(1e9);
  for (const road of map.roads) {
    for (const p of road.points) {
      const i = Math.min(gw - 1, Math.max(0, Math.floor((p[0] - b.minX) / dc)));
      const j = Math.min(gh - 1, Math.max(0, Math.floor((p[1] - b.minZ) / dc)));
      const idx = j * gw + i;
      if (dist[idx] > 0) dist[idx] = 0;
    }
  }
  for (let pass = 0; pass < 2; pass++) {
    const fwd = pass === 0;
    for (let j = 0; j < gh; j++) {
      for (let i = 0; i < gw; i++) {
        const ii = fwd ? i : gw - 1 - i;
        const jj = fwd ? j : gh - 1 - j;
        const idx = jj * gw + ii;
        let d = dist[idx];
        if (jj > 0) { if (dist[idx - gw] + 1 < d) d = dist[idx - gw] + 1; }
        if (jj < gh - 1) { if (dist[idx + gw] + 1 < d) d = dist[idx + gw] + 1; }
        if (ii > 0) { if (dist[idx - 1] + 1 < d) d = dist[idx - 1] + 1; }
        if (ii < gw - 1) { if (dist[idx + 1] + 1 < d) d = dist[idx + 1] + 1; }
        if (jj > 0 && ii > 0 && dist[idx - gw - 1] + 1.414 < d) d = dist[idx - gw - 1] + 1.414;
        if (jj > 0 && ii < gw - 1 && dist[idx - gw + 1] + 1.414 < d) d = dist[idx - gw + 1] + 1.414;
        if (jj < gh - 1 && ii > 0 && dist[idx + gw - 1] + 1.414 < d) d = dist[idx + gw - 1] + 1.414;
        if (jj < gh - 1 && ii < gw - 1 && dist[idx + gw + 1] + 1.414 < d) d = dist[idx + gw + 1] + 1.414;
        dist[idx] = d;
      }
    }
  }
  const smooth = (a, bb, x) => {
    const t = Math.min(1, Math.max(0, (x - a) / (bb - a)));
    return t * t * (3 - 2 * t);
  };
  const heights = [];
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const x = b.minX + i * cell;
      const z = b.minZ + j * cell;
      const di = Math.min(gw - 1, Math.floor((x - b.minX) / dc));
      const dj = Math.min(gh - 1, Math.floor((z - b.minZ) / dc));
      const d = dist[dj * gw + di] * dc;
      const f = smooth(15, 70, d);
      const rv = elev[j * cols + i];
      const bv = base[j * cols + i];
      const rel = Number.isFinite(rv) && Number.isFinite(bv) ? rv - bv : 0;
      let hh = rel * f;
      if (hh < -12) hh = -12;
      if (hh > 500) hh = 500;
      heights.push(+((hh - 0.3).toFixed(2)));
    }
  }
  return {
    schemaVersion: ELEVATION_SCHEMA_VERSION,
    roadsSha256,
    originX: descriptor.originX,
    originZ: descriptor.originZ,
    cell: descriptor.cell,
    cols: descriptor.cols,
    rows: descriptor.rows,
    heights
  };
}
