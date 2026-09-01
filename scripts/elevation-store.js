import { createHash } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { open, readFile, rename, unlink } from 'node:fs/promises';
import { parseMapData } from '../shared/mapdata.js';
import {
  CHECKPOINT_FILE_NAME,
  LEGACY_FILE_NAME,
  ROADS_FILE_NAME,
  gridDescriptor,
  legacyToCheckpoint,
  validateCheckpoint,
  validateLegacySource
} from '../shared/elevation.js';

export async function sha256Hex(data) {
  return createHash('sha256').update(data).digest('hex');
}

export async function sha256File(filePath) {
  return sha256Hex(await readFile(filePath));
}

export async function writeAtomic(filePath, content) {
  const tmpPath = join(dirname(filePath), '.' + basename(filePath) + '.tmp');
  const handle = await open(tmpPath, 'w');
  try {
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
  } catch (error) {
    await handle.close().catch(() => {});
    await unlink(tmpPath).catch(() => {});
    throw error;
  }
  await rename(tmpPath, filePath);
}

export async function readJsonFile(filePath) {
  try {
    const raw = await readFile(filePath, 'utf8');
    return { present: true, raw, data: JSON.parse(raw) };
  } catch (error) {
    if (error.code === 'ENOENT') return { present: false, raw: null, data: null };
    throw error;
  }
}

export async function roadsDescriptor(dataRoot) {
  const raw = await readFile(join(dataRoot, ROADS_FILE_NAME), 'utf8');
  const map = parseMapData(JSON.parse(raw));
  return {
    descriptor: gridDescriptor(map.bbox),
    roadsSha256: await sha256Hex(raw)
  };
}

export async function convertLegacyCheckpoint(dataRoot) {
  const roadsPath = join(dataRoot, ROADS_FILE_NAME);
  const legacyPath = join(dataRoot, LEGACY_FILE_NAME);
  const checkpointPath = join(dataRoot, CHECKPOINT_FILE_NAME);
  let roadsRaw;
  try {
    roadsRaw = await readFile(roadsPath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { ok: false, reason: 'roads.json not found in dataRoot' };
    throw error;
  }
  let legacyRaw;
  try {
    legacyRaw = await readFile(legacyPath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { ok: false, reason: 'legacy partial not found in dataRoot' };
    throw error;
  }
  const roadsSha256 = await sha256Hex(roadsRaw);
  const partialSha256 = await sha256Hex(legacyRaw);
  let values;
  try {
    values = JSON.parse(legacyRaw);
  } catch {
    return { ok: false, reason: 'legacy partial is not valid JSON' };
  }
  const gate = validateLegacySource(roadsSha256, partialSha256, values);
  if (!gate.ok) return { ok: false, reason: gate.reason };
  const { descriptor } = await roadsDescriptor(dataRoot);
  const built = legacyToCheckpoint(values, descriptor, roadsSha256);
  if (!built.ok) return { ok: false, reason: built.reason };
  const selfCheck = validateCheckpoint(built.checkpoint, descriptor, roadsSha256);
  if (!selfCheck.ok) return { ok: false, reason: selfCheck.reason };
  await writeAtomic(checkpointPath, JSON.stringify(built.checkpoint));
  return { ok: true, reason: null, checkpoint: built.checkpoint, checkpointPath };
}
