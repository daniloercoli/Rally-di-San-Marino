import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CHECKPOINT_FILE_NAME,
  ELEVATION_CELL_M,
  ELEVATION_SCHEMA_VERSION,
  LEGACY_BASELINE,
  LEGACY_FILE_NAME,
  ROADS_FILE_NAME,
  RUNTIME_FILE_NAME,
  buildFinalAsset,
  gridDescriptor,
  legacyToCheckpoint,
  validateCheckpoint,
  validateGridDescriptor,
  validateLegacySource,
  validateRuntimeAsset
} from '../shared/elevation.js';
import {
  convertLegacyCheckpoint,
  readJsonFile,
  roadsDescriptor,
  sha256File,
  sha256Hex,
  writeAtomic
} from './elevation-store.js';
import {
  BATCH,
  createOpenElevationProvider,
  runDownloader,
  sleepAbortable
} from './fetch-elevation.js';
import {
  BatchExhaustedError,
  ProviderError,
  RETRY_DEFAULTS,
  backoffDelayMs,
  classifyProviderError,
  fetchBatchWithRetry,
  parseRetryAfterSeconds,
  resolveDelayMs,
  validateProviderBatch
} from './elevation-retry.js';

let passed = 0;
const RUNTIME_BASELINE_SHA256 = '20dba1cf12d5bd28552e2f8bf32c96c3cd37942ec5d9b0f0989396b192c64229';
const LEGACY_FIXTURE_URL = new URL('./fixtures/elevation-legacy-6100.json', import.meta.url);

function ok(cond, msg) {
  assert.ok(cond, msg);
  passed++;
  console.log('  ok -', msg);
}

const tempDirs = [];
let failure = null;

function trackTemp(dir) {
  tempDirs.push(dir);
  return dir;
}

async function makeTempDataRoot() {
  const dir = trackTemp(await mkdtemp(join(tmpdir(), 'test-elevation-')));
  const realRoot = join(process.cwd(), 'public', 'data');
  await cp(join(realRoot, ROADS_FILE_NAME), join(dir, ROADS_FILE_NAME));
  const legacyFixture = JSON.parse(await readFile(LEGACY_FIXTURE_URL, 'utf8'));
  await writeFile(join(dir, LEGACY_FILE_NAME), JSON.stringify(legacyFixture));
  return dir;
}

function makeTinyRoads() {
  const elements = [];
  for (let k = 0; k < 6; k++) {
    const lat = 43.94 + k * 0.001;
    elements.push({
      type: 'way',
      tags: { highway: 'residential' },
      geometry: [
        { lon: 12.44, lat },
        { lon: 12.4425, lat },
        { lon: 12.445, lat },
        { lon: 12.4475, lat },
        { lon: 12.45, lat }
      ]
    });
  }
  return { elements };
}

async function makeTinyDataRoot() {
  const dir = trackTemp(await mkdtemp(join(tmpdir(), 'test-elevation-dl-')));
  await writeFile(join(dir, ROADS_FILE_NAME), JSON.stringify(makeTinyRoads()));
  return dir;
}

const valueAt = (i) => 100 + ((i * 7) % 499);

function makeFakeProvider({ throwAtBatch = -1, parkAtBatch = -1 } = {}) {
  const calls = [];
  let batch = 0;
  const provider = async (start, end, signal) => {
    calls.push(start);
    if (throwAtBatch === batch) throw new Error('synthetic provider crash at batch ' + batch);
    if (parkAtBatch === batch) {
      await new Promise((resolvePromise, rejectPromise) => {
        const onAbort = () => {
          signal.removeEventListener('abort', onAbort);
          rejectPromise(new Error('aborted by signal'));
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort);
      });
    }
    if (signal && signal.aborted) return null;
    batch++;
    const out = [];
    for (let i = start; i < end; i++) out.push(valueAt(i));
    return out;
  };
  return { provider, calls };
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const noopSleep = () => Promise.resolve();

try {
  console.log('== elevation grid descriptor (unit) ==');
  const synthDesc = gridDescriptor({ minX: -500, maxX: 500, minZ: -300, maxZ: 700 });
  ok(synthDesc.cols === 11 && synthDesc.rows === 11 && synthDesc.total === 121, 'floor+1 formula on a synthetic bbox');
  const marginDesc = gridDescriptor({ minX: 0, maxX: 1501, minZ: 0, maxZ: 1501 });
  ok(marginDesc.cols === 16 && marginDesc.rows === 16, 'grid keeps the legacy floor+1 spacing');
  ok((marginDesc.cols - 1) * ELEVATION_CELL_M < 1501, 'v1 grid does not have to reach the extreme bbox margin');
  ok(validateGridDescriptor(synthDesc).ok, 'grid descriptor passes its own validation');
  ok(!validateGridDescriptor({ originX: 0, originZ: 0, cell: 100, cols: 2, rows: 3, total: 5 }).ok, 'inconsistent grid descriptor is rejected');
  try {
    gridDescriptor({ minX: 0, maxX: 0, minZ: 0, maxZ: 100 });
    ok(false, 'degenerate bbox should throw');
  } catch (error) {
    ok(error.message.includes('degenerate'), 'degenerate bbox is rejected');
  }
  try {
    gridDescriptor({ minX: NaN, maxX: 10, minZ: 0, maxZ: 10 });
    ok(false, 'non-finite bbox should throw');
  } catch (error) {
    ok(error.message.includes('finite'), 'non-finite bbox is rejected');
  }
  try {
    gridDescriptor({ minX: 0, maxX: 100, minZ: 0, maxZ: 100 }, 100.5);
    ok(false, 'non-integer cell should throw');
  } catch (error) {
    ok(error.message.includes('positive integer'), 'non-integer cell is rejected');
  }

  console.log('== elevation baseline (real data, read-only) ==');
  const realRoot = join(process.cwd(), 'public', 'data');
  const realRoadsHash = await sha256File(join(realRoot, ROADS_FILE_NAME));
  ok(realRoadsHash === LEGACY_BASELINE.roadsSha256, 'roads.json matches the baseline hash');
  const realInfo = await roadsDescriptor(realRoot);
  const desc = realInfo.descriptor;
  const rHash = realInfo.roadsSha256;
  ok(desc.cols === 152 && desc.rows === 133 && desc.total === 20216 && desc.cell === ELEVATION_CELL_M, 'real grid is 152 x 133 @ 100 m (20.216 points)');
  ok(rHash === LEGACY_BASELINE.roadsSha256, 'descriptor derives from the current dataset');
  const realRuntimePath = join(realRoot, RUNTIME_FILE_NAME);
  const realRuntimeHash = await sha256File(realRuntimePath);
  const realRuntime = JSON.parse(await readFile(realRuntimePath, 'utf8'));
  ok(realRuntimeHash === RUNTIME_BASELINE_SHA256, 'elevation.json matches the completed download hash');
  ok(validateRuntimeAsset(realRuntime, desc, rHash).ok && realRuntime.heights.length === desc.total,
    'elevation.json is compatible and contains 20.216 finite heights');
  ok(!existsSync(join(realRoot, CHECKPOINT_FILE_NAME)) && !existsSync(join(realRoot, LEGACY_FILE_NAME)),
    'completed elevation has no checkpoint or legacy partial');

  console.log('== legacy baseline fixture (offline) ==');
  const legacyValues = JSON.parse(await readFile(LEGACY_FIXTURE_URL, 'utf8'));
  const legacyFixtureHash = await sha256Hex(JSON.stringify(legacyValues));
  ok(legacyFixtureHash === LEGACY_BASELINE.partialSha256, 'legacy fixture canonical content matches the migration baseline hash');
  ok(Array.isArray(legacyValues) && legacyValues.length === LEGACY_BASELINE.completed, 'legacy fixture holds 6.100 values');

  console.log('== legacy conversion (temp copy, no network) ==');
  const dataRoot = await makeTempDataRoot();
  const conversion = await convertLegacyCheckpoint(dataRoot);
  ok(conversion.ok, 'legacy conversion succeeds on the temp copy');
  const cp = conversion.checkpoint;
  ok(cp.schemaVersion === ELEVATION_SCHEMA_VERSION && cp.completed === 6100, 'checkpoint keeps completed = 6.100');
  ok(cp.total === 20216 && cp.cols === 152 && cp.rows === 133, 'checkpoint records the v1 grid');
  ok(JSON.stringify(cp.elevations) === JSON.stringify(legacyValues), '6.100 legacy values preserved in original order');
  const savedCp = await readJsonFile(conversion.checkpointPath);
  ok(savedCp.present && validateCheckpoint(savedCp.data, desc, rHash).ok, 'written checkpoint re-reads and validates');
  const rootEntries = await readdir(dataRoot);
  ok(!rootEntries.some((name) => name.endsWith('.tmp')), 'atomic write leaves no temp file behind');
  const secondConversion = await convertLegacyCheckpoint(dataRoot);
  ok(secondConversion.ok && JSON.stringify(secondConversion.checkpoint) === JSON.stringify(cp), 'conversion is deterministic on rerun');

  console.log('== legacy rejection (temp copies) ==');
  const staleRoot = await makeTempDataRoot();
  const staleFile = join(staleRoot, LEGACY_FILE_NAME);
  const staleValues = JSON.parse(await readFile(staleFile, 'utf8'));
  staleValues[0] = staleValues[0] + 1;
  await writeFile(staleFile, JSON.stringify(staleValues));
  const staleResult = await convertLegacyCheckpoint(staleRoot);
  ok(!staleResult.ok && staleResult.reason.includes('partial file hash'), 'tampered partial is rejected before any write');
  ok(!(await readJsonFile(join(staleRoot, CHECKPOINT_FILE_NAME))).present, 'rejected conversion writes no checkpoint');
  const foreignRoot = await makeTempDataRoot();
  await writeFile(join(foreignRoot, ROADS_FILE_NAME), JSON.stringify({ elements: [{ type: 'way', tags: { highway: 'residential' }, geometry: [{ lon: 0, lat: 0 }, { lon: 0.001, lat: 0.001 }] }] }));
  const foreignResult = await convertLegacyCheckpoint(foreignRoot);
  ok(!foreignResult.ok && foreignResult.reason.includes('roads.json hash'), 'partial of another map is rejected');

  console.log('== legacy source validation (unit) ==');
  ok(validateLegacySource(LEGACY_BASELINE.roadsSha256, LEGACY_BASELINE.partialSha256, legacyValues).ok, 'baseline legacy source is accepted');
  ok(!validateLegacySource('a'.repeat(64), LEGACY_BASELINE.partialSha256, legacyValues).ok, 'different roads hash is rejected');
  ok(!validateLegacySource(LEGACY_BASELINE.roadsSha256, 'b'.repeat(64), legacyValues).ok, 'different partial hash is rejected');
  ok(!validateLegacySource(LEGACY_BASELINE.roadsSha256, LEGACY_BASELINE.partialSha256, legacyValues.slice(0, 6000)).ok, 'truncated legacy values are rejected');
  ok(!validateLegacySource(LEGACY_BASELINE.roadsSha256, LEGACY_BASELINE.partialSha256, legacyValues.concat([120])).ok, 'oversized legacy values are rejected');
  ok(!validateLegacySource(LEGACY_BASELINE.roadsSha256, LEGACY_BASELINE.partialSha256, legacyValues.map((v, i) => (i === 0 ? null : v))).ok, 'null in legacy values is rejected');
  ok(!validateLegacySource(LEGACY_BASELINE.roadsSha256, LEGACY_BASELINE.partialSha256, 'not an array').ok, 'non-array legacy values are rejected');
  const tiny = legacyToCheckpoint([1, 2, 3], desc, rHash);
  ok(tiny.ok && tiny.checkpoint.completed === 3 && tiny.checkpoint.elevations.length === 3, 'legacyToCheckpoint builds a prefix checkpoint');
  ok(validateCheckpoint(tiny.checkpoint, desc, rHash).ok, 'built prefix checkpoint validates');
  const smallDesc = gridDescriptor({ minX: 0, maxX: 100, minZ: 0, maxZ: 100 });
  const tooBig = legacyToCheckpoint(legacyValues, smallDesc, rHash);
  ok(!tooBig.ok && tooBig.reason.includes('exceed'), 'values longer than a smaller grid are rejected');
  const dirtyInput = [4, 5, 6];
  const fromDirty = legacyToCheckpoint(dirtyInput, desc, rHash);
  dirtyInput[0] = 999;
  ok(fromDirty.ok && fromDirty.checkpoint.elevations[0] === 4, 'legacyToCheckpoint copies the input array');

  console.log('== checkpoint validation (unit) ==');
  const mut = (patch) => Object.assign({}, cp, patch);
  ok(validateCheckpoint(cp, desc, rHash).ok, 'valid checkpoint is accepted');
  ok(validateCheckpoint(cp, desc).ok, 'validation without expected hash skips the map check');
  ok(!validateCheckpoint(mut({ schemaVersion: 2 }), desc, rHash).ok, 'wrong schemaVersion is rejected');
  ok(!validateCheckpoint(mut({ schemaVersion: '1' }), desc, rHash).ok, 'string schemaVersion is rejected');
  ok(!validateCheckpoint(mut({ roadsSha256: 'a'.repeat(64) }), desc, rHash).ok, 'different roads hash is rejected');
  ok(!validateCheckpoint(mut({ roadsSha256: 'nope' }), desc, rHash).ok, 'malformed roads hash is rejected');
  ok(!validateCheckpoint(mut({ cols: 151 }), desc, rHash).ok, 'different grid is rejected');
  ok(!validateCheckpoint(mut({ cell: 120 }), desc, rHash).ok, 'different cell is rejected');
  ok(!validateCheckpoint(mut({ originX: cp.originX + 1 }), desc, rHash).ok, 'shifted origin is rejected');
  ok(!validateCheckpoint(mut({ completed: cp.total + 1 }), desc, rHash).ok, 'oversized completed is rejected');
  ok(!validateCheckpoint(mut({ completed: -1 }), desc, rHash).ok, 'negative completed is rejected');
  ok(!validateCheckpoint(mut({ completed: 2.5 }), desc, rHash).ok, 'non-integer completed is rejected');
  ok(!validateCheckpoint(mut({ completed: 100, elevations: cp.elevations.slice(0, 99) }), desc, rHash).ok, 'truncated elevations are rejected');
  ok(!validateCheckpoint(mut({ elevations: cp.elevations.concat([120]) }), desc, rHash).ok, 'elevations longer than completed are rejected');
  ok(!validateCheckpoint(mut({ elevations: cp.elevations.map((v, i) => (i === 0 ? null : v)) }), desc, rHash).ok, 'null elevation is rejected');
  ok(!validateCheckpoint(mut({ elevations: cp.elevations.map((v, i) => (i === 0 ? 1e999 : v)) }), desc, rHash).ok, 'non-finite elevation is rejected');
  ok(!validateCheckpoint(mut({ elevations: cp.elevations.map((v, i) => (i === 0 ? '120' : v)) }), desc, rHash).ok, 'string elevation is rejected');
  ok(!validateCheckpoint(mut({ elevations: 'nope' }), desc, rHash).ok, 'non-array elevations are rejected');
  ok(!validateCheckpoint([], desc, rHash).ok, 'legacy array shape is rejected');
  ok(!validateCheckpoint(null, desc, rHash).ok, 'null checkpoint is rejected');
  ok(validateCheckpoint(Object.assign({}, cp, { completed: 0, elevations: [] }), desc, rHash).ok, 'empty progress checkpoint is accepted');

  console.log('== runtime asset validation (unit) ==');
  const fullHeights = new Array(20216).fill(12);
  const asset = {
    schemaVersion: ELEVATION_SCHEMA_VERSION,
    roadsSha256: rHash,
    originX: desc.originX,
    originZ: desc.originZ,
    cell: desc.cell,
    cols: desc.cols,
    rows: desc.rows,
    heights: fullHeights
  };
  ok(validateRuntimeAsset(asset, desc, rHash).ok, 'valid runtime asset is accepted');
  ok(!validateRuntimeAsset(Object.assign({}, asset, { heights: fullHeights.slice(0, -1) }), desc, rHash).ok, 'short heights are rejected');
  ok(!validateRuntimeAsset(Object.assign({}, asset, { heights: fullHeights.map((v, i) => (i === 0 ? null : v)) }), desc, rHash).ok, 'null height is rejected');
  ok(!validateRuntimeAsset(Object.assign({}, asset, { roadsSha256: 'b'.repeat(64) }), desc, rHash).ok, 'incompatible roads hash is rejected');
  ok(!validateRuntimeAsset(Object.assign({}, asset, { schemaVersion: 0 }), desc, rHash).ok, 'legacy runtime asset is rejected');
  ok(!validateRuntimeAsset(Object.assign({}, asset, { heights: undefined }), desc, rHash).ok, 'missing heights are rejected');
  ok(!validateRuntimeAsset(Object.assign({}, asset, { heights: fullHeights.map((v, i) => (i === 0 ? Infinity : v)) }), desc, rHash).ok, 'non-finite height is rejected');
  ok(!validateRuntimeAsset(Object.assign({}, asset, { cols: 151 }), desc, rHash).ok, 'runtime asset with different grid is rejected');

  console.log('== atomic write (unit) ==');
  const atomicRoot = trackTemp(await mkdtemp(join(tmpdir(), 'test-elevation-atomic-')));
  const target = join(atomicRoot, 'out.json');
  await writeAtomic(target, 'v1');
  ok(await readFile(target, 'utf8') === 'v1', 'atomic write creates the target');
  await writeFile(join(atomicRoot, '.out.json.tmp'), 'corrupted');
  await writeAtomic(target, 'v2');
  ok(await readFile(target, 'utf8') === 'v2', 'atomic write replaces the target on rename');
  ok(!existsSync(join(atomicRoot, '.out.json.tmp')), 'stale temp file is cleaned up');
  await writeFile(join(atomicRoot, '.out.json.tmp'), 'corrupted');
  ok(await readFile(target, 'utf8') === 'v2', 'an interrupted write leaves the last valid copy');
  console.log('== downloader: first run (tiny fixture, fake provider) ==');
  const tinyRoot = await makeTinyDataRoot();
  const tinyInfo = await roadsDescriptor(tinyRoot);
  const tDesc = tinyInfo.descriptor;
  const tHash = tinyInfo.roadsSha256;
  const tBatches = Math.ceil(tDesc.total / BATCH);
  const fA = makeFakeProvider();
  const rA = await runDownloader({ dataRoot: tinyRoot, provider: fA.provider, sleep: noopSleep });
  ok(rA.code === 0, 'first run exits 0');
  const aA = await readJsonFile(join(tinyRoot, RUNTIME_FILE_NAME));
  ok(aA.present && validateRuntimeAsset(aA.data, tDesc, tHash).ok, 'first run writes a valid runtime asset');
  ok(aA.data.heights.length === tDesc.total, 'asset holds one height per grid point');
  ok(!aA.raw.includes('null'), 'no null in the saved asset');
  ok(!(await readJsonFile(join(tinyRoot, CHECKPOINT_FILE_NAME))).present, 'checkpoint removed after success');
  ok(fA.calls[0] === 0 && fA.calls.length === tBatches, 'provider covered the grid exactly once from index 0');

  console.log('== downloader: mid-batch crash + resume ==');
  const crashRoot = await makeTinyDataRoot();
  const fB = makeFakeProvider({ throwAtBatch: 4 });
  const rB = await runDownloader({ dataRoot: crashRoot, provider: fB.provider, sleep: noopSleep });
  ok(rB.code === 1, 'crashed job exits non-zero');
  const cB = await readJsonFile(join(crashRoot, CHECKPOINT_FILE_NAME));
  ok(cB.present && validateCheckpoint(cB.data, tDesc, tHash).ok, 'crashed job left a valid checkpoint');
  ok(cB.data.completed === 4 * BATCH, 'checkpoint stops at the last fully validated batch');
  ok(cB.data.elevations.length === 4 * BATCH, 'saved elevations match the saved completed count');
  ok(cB.data.elevations.every(Number.isFinite), 'no null in the saved checkpoint');
  const fB2 = makeFakeProvider();
  const rB2 = await runDownloader({ dataRoot: crashRoot, provider: fB2.provider, sleep: noopSleep });
  ok(rB2.code === 0, 'resumed job exits 0');
  ok(fB2.calls.length === Math.ceil((tDesc.total - 4 * BATCH) / BATCH), 'resume requests exactly the remaining batches');
  ok(fB2.calls.every((s) => s >= 4 * BATCH), 'resume never requests saved indices');
  const aB = await readJsonFile(join(crashRoot, RUNTIME_FILE_NAME));
  ok(validateRuntimeAsset(aB.data, tDesc, tHash).ok, 'resumed run writes a valid asset');
  ok(!(await readJsonFile(join(crashRoot, CHECKPOINT_FILE_NAME))).present, 'checkpoint removed after the resumed success');
  const baseRoot = await makeTinyDataRoot();
  await runDownloader({ dataRoot: baseRoot, provider: makeFakeProvider().provider, sleep: noopSleep });
  const aBase = await readJsonFile(join(baseRoot, RUNTIME_FILE_NAME));
  const sameDescriptor = ['schemaVersion', 'roadsSha256', 'originX', 'originZ', 'cell', 'cols', 'rows'].every((key) => aB.data[key] === aBase.data[key]);
  ok(sameDescriptor, 'descriptor identical between interrupted+resumed and single run');
  ok(JSON.stringify(aB.data.heights) === JSON.stringify(aBase.data.heights), 'resumed values deeply equal to the single-run job');

  console.log('== downloader: SIGINT ==');
  const sigRoot = await makeTinyDataRoot();
  const sigSource = new EventEmitter();
  const fC = makeFakeProvider({ parkAtBatch: 5 });
  let forcedExit = null;
  const rCPromise = runDownloader({
    dataRoot: sigRoot,
    provider: fC.provider,
    signalSource: sigSource,
    sleep: noopSleep,
    forceExit: (code) => {
      forcedExit = code;
    }
  });
  await delay(100);
  sigSource.emit('SIGINT');
  sigSource.emit('SIGINT');
  const rC = await rCPromise;
  ok(rC.code === 130, 'SIGINT exits non-zero after saving the checkpoint');
  ok(forcedExit === 1, 'a second SIGINT forces immediate exit');
  const cC = await readJsonFile(join(sigRoot, CHECKPOINT_FILE_NAME));
  ok(cC.present && validateCheckpoint(cC.data, tDesc, tHash).ok, 'SIGINT left a valid checkpoint');
  ok(cC.data.completed === 5 * BATCH, 'SIGINT checkpoint holds the last validated progress');
  const fC2 = makeFakeProvider();
  const rC2 = await runDownloader({ dataRoot: sigRoot, provider: fC2.provider, sleep: noopSleep });
  ok(rC2.code === 0, 'run resumes after SIGINT');
  ok(fC2.calls.every((s) => s >= 5 * BATCH), 'post-SIGINT resume starts from the saved prefix');

  console.log('== downloader: write error keeps the previous checkpoint ==');
  const wRoot = await makeTinyDataRoot();
  await runDownloader({ dataRoot: wRoot, provider: makeFakeProvider({ throwAtBatch: 4 }).provider, sleep: noopSleep });
  const wBefore = await readJsonFile(join(wRoot, CHECKPOINT_FILE_NAME));
  const failingWrite = async () => {
    throw new Error('disk full (simulated)');
  };
  const rD = await runDownloader({ dataRoot: wRoot, provider: makeFakeProvider().provider, writeAtomic: failingWrite, saveEveryBatches: 1, sleep: noopSleep });
  ok(rD.code === 1, 'write failure exits non-zero');
  const wAfter = await readJsonFile(join(wRoot, CHECKPOINT_FILE_NAME));
  ok(wAfter.present && JSON.stringify(wAfter.data) === JSON.stringify(wBefore.data), 'a failed save leaves the previous valid checkpoint intact');

  console.log('== downloader: invalid final output ==');
  const invRoot = await makeTinyDataRoot();
  const rE = await runDownloader({
    dataRoot: invRoot,
    provider: makeFakeProvider().provider,
    buildAsset: async (args) => {
      const asset = buildFinalAsset(args);
      asset.heights[0] = null;
      return asset;
    },
    sleep: noopSleep
  });
  ok(rE.code === 1, 'invalid final output exits non-zero');
  ok(rE.reason.includes('validation'), 'failure reported as validation');
  ok(!(await readJsonFile(join(invRoot, RUNTIME_FILE_NAME))).present, 'no runtime asset written when validation fails');
  const cE = await readJsonFile(join(invRoot, CHECKPOINT_FILE_NAME));
  ok(cE.present && validateCheckpoint(cE.data, tDesc, tHash).ok, 'checkpoint preserved when the final write is refused');

  console.log('== downloader: already-valid output ==');
  const okRoot = await makeTinyDataRoot();
  await runDownloader({ dataRoot: okRoot, provider: makeFakeProvider().provider, sleep: noopSleep });
  const okHashBefore = await sha256File(join(okRoot, RUNTIME_FILE_NAME));
  const fF = makeFakeProvider();
  const rF = await runDownloader({ dataRoot: okRoot, provider: fF.provider, sleep: noopSleep });
  ok(rF.code === 0, 'compatible output exits 0');
  ok(fF.calls.length === 0, 'zero provider requests when the output is already valid');
  ok(await sha256File(join(okRoot, RUNTIME_FILE_NAME)) === okHashBefore, 'existing output left untouched');

  console.log('== downloader: incompatible output ==');
  const badRoot = await makeTinyDataRoot();
  await writeFile(join(badRoot, RUNTIME_FILE_NAME), JSON.stringify({ originX: 0, originZ: 0, cell: 100, cols: 2, rows: 2, heights: [1, 2, 3, 4] }));
  const badHash = await sha256File(join(badRoot, RUNTIME_FILE_NAME));
  const fG = makeFakeProvider();
  const rG = await runDownloader({ dataRoot: badRoot, provider: fG.provider, sleep: noopSleep });
  ok(rG.code === 1, 'incompatible output exits non-zero without --force');
  ok(fG.calls.length === 0, 'no provider requests before the compatibility gate');
  ok(await sha256File(join(badRoot, RUNTIME_FILE_NAME)) === badHash, 'incompatible output left untouched');
  const corruptRoot = await makeTinyDataRoot();
  await writeFile(join(corruptRoot, RUNTIME_FILE_NAME), '{not json');
  const rG2 = await runDownloader({ dataRoot: corruptRoot, provider: makeFakeProvider().provider, sleep: noopSleep });
  ok(rG2.code === 1, 'corrupted output exits non-zero without --force');

  console.log('== downloader: --force ==');
  const forceRoot = await makeTinyDataRoot();
  await writeFile(join(forceRoot, RUNTIME_FILE_NAME), JSON.stringify({ legacy: true }));
  const staleHash = await sha256File(join(forceRoot, RUNTIME_FILE_NAME));
  const seenHashes = [];
  const forceProvider = async (start, end) => {
    seenHashes.push(await sha256File(join(forceRoot, RUNTIME_FILE_NAME)));
    const out = [];
    for (let i = start; i < end; i++) out.push(valueAt(i));
    return out;
  };
  const rH = await runDownloader({ dataRoot: forceRoot, provider: forceProvider, force: true, sleep: noopSleep });
  ok(rH.code === 0, '--force regenerates over an incompatible output');
  ok(seenHashes.length > 0 && seenHashes.every((h) => h === staleHash), 'old output stays intact until the atomic rename');
  const aH = await readJsonFile(join(forceRoot, RUNTIME_FILE_NAME));
  ok(validateRuntimeAsset(aH.data, tDesc, tHash).ok, 'forced output is valid');

  console.log('== downloader: legacy prefix (real data, offline) ==');
  const legacyRoot = await makeTempDataRoot();
  const fI = makeFakeProvider();
  const rI = await runDownloader({ dataRoot: legacyRoot, provider: fI.provider, sleep: noopSleep });
  ok(rI.code === 0, 'legacy partial converted and completed offline');
  ok(fI.calls.length > 0 && fI.calls[0] === 6100, 'fetch starts exactly at the legacy completed count');
  ok(fI.calls.every((s) => s >= 6100), 'legacy prefix never re-requested');
  const aI = await readJsonFile(join(legacyRoot, RUNTIME_FILE_NAME));
  ok(validateRuntimeAsset(aI.data, desc, rHash).ok, 'legacy run writes a valid asset on the real grid');
  ok(!(await readJsonFile(join(legacyRoot, CHECKPOINT_FILE_NAME))).present, 'checkpoint removed after the legacy run');

  console.log('== downloader: corrupted checkpoint ==');
  const ckRoot = await makeTinyDataRoot();
  const badCheckpoint = {
    schemaVersion: ELEVATION_SCHEMA_VERSION,
    roadsSha256: tHash,
    originX: tDesc.originX,
    originZ: tDesc.originZ,
    cell: tDesc.cell,
    cols: tDesc.cols,
    rows: tDesc.rows,
    total: tDesc.total,
    completed: BATCH,
    elevations: [null].concat(new Array(BATCH - 1).fill(1))
  };
  await writeFile(join(ckRoot, CHECKPOINT_FILE_NAME), JSON.stringify(badCheckpoint));
  const fJ = makeFakeProvider();
  const rJ = await runDownloader({ dataRoot: ckRoot, provider: fJ.provider, sleep: noopSleep });
  ok(rJ.code === 1, 'corrupted checkpoint blocks the run');
  ok(rJ.reason.includes('checkpoint'), 'failure reported as checkpoint problem');
  ok(fJ.calls.length === 0, 'no provider requests with a corrupted checkpoint');
  ok(await readFile(join(ckRoot, CHECKPOINT_FILE_NAME), 'utf8') === JSON.stringify(badCheckpoint), 'corrupted checkpoint left untouched');

  console.log('== downloader: invalid batch values ==');
  const nvRoot = await makeTinyDataRoot();
  const badBatchProvider = async (start, end) => {
    if (start === 0) return new Array(end).fill(55);
    return [NaN];
  };
  const rK = await runDownloader({ dataRoot: nvRoot, provider: badBatchProvider, sleep: noopSleep });
  ok(rK.code === 1, 'unvalidated batch exits non-zero');
  const cK = await readJsonFile(join(nvRoot, CHECKPOINT_FILE_NAME));
  ok(cK.present && cK.data.completed === BATCH, 'completed advances only after batch validation');

  console.log('== downloader: configurable save interval ==');
  const svRoot = await makeTinyDataRoot();
  let saveWrites = 0;
  const countingWrite = async (filePath, content) => {
    saveWrites++;
    await writeAtomic(filePath, content);
  };
  const rL = await runDownloader({ dataRoot: svRoot, provider: makeFakeProvider().provider, saveEveryBatches: 4, writeAtomic: countingWrite, sleep: noopSleep });
  ok(rL.code === 0, 'explicit save interval run exits 0');
  ok(saveWrites === Math.floor(tBatches / 4) + 1, 'saves happen at the configured batch interval plus the final asset write');
  console.log('== retry defaults (unit) ==');
  ok(RETRY_DEFAULTS.batch === 25 && RETRY_DEFAULTS.pauseMs === 5000 && RETRY_DEFAULTS.requestTimeoutMs === 30000, 'defaults fix batch 25, pause 5000 ms and timeout 30000 ms');
  ok(RETRY_DEFAULTS.maxPrimaryAttempts === 5 && RETRY_DEFAULTS.maxFallbackAttempts === 3, 'defaults fix 5 primary and 3 fallback attempts');
  ok(RETRY_DEFAULTS.backoffScheduleMs.join(',') === '5000,10000,20000,30000,60000', 'default backoff is 5/10/20/30/60 seconds');
  ok(RETRY_DEFAULTS.jitter === 0.1 && BATCH === RETRY_DEFAULTS.batch, 'default jitter is 0.1 and BATCH follows the default');

  console.log('== provider error classification (unit) ==');
  ok(classifyProviderError(new ProviderError('rate-limit', 'HTTP 429')) === 'rate-limit', 'ProviderError keeps its kind');
  ok(classifyProviderError(new Error('socket hang up')) === 'network', 'plain errors classify as network');
  const timeoutError = new Error('aborted due to timeout');
  timeoutError.name = 'TimeoutError';
  ok(classifyProviderError(timeoutError) === 'timeout', 'TimeoutError classifies as timeout');
  const abortError = new Error('aborted');
  abortError.name = 'AbortError';
  ok(classifyProviderError(abortError) === 'aborted', 'AbortError classifies as aborted');

  console.log('== provider payload validation (unit) ==');
  ok(validateProviderBatch([1, 2, 3], 3).ok, 'exact-length finite payload is valid');
  ok(!validateProviderBatch([1, 2], 3).ok, 'short payload is invalid');
  ok(!validateProviderBatch([1, 2, 3, 4], 3).ok, 'long payload is invalid');
  ok(!validateProviderBatch([1, NaN, 3], 3).ok, 'non-finite payload value is invalid');
  ok(!validateProviderBatch([1, Infinity, 3], 3).ok, 'infinite payload value is invalid');
  ok(!validateProviderBatch('nope', 3).ok, 'non-array payload is invalid');

  console.log('== provider adapters (unit, mocked HTTP) ==');
  const providerLats = ['1.00000', '2.00000'];
  const providerLons = ['10.00000', '20.00000'];
  const featureAt = (index, elevation) => ({
    geometry: { coordinates: [Number(providerLons[index]), Number(providerLats[index])] },
    properties: { elevation }
  });
  const responseWithFeatures = (features) => async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => ({ features })
  });
  const orderedProvider = createOpenElevationProvider({
    lats: providerLats,
    lons: providerLons,
    fetchImpl: responseWithFeatures([featureAt(0, 100), featureAt(1, 200)]),
    timeoutMs: 1000
  });
  const orderedValues = await orderedProvider(0, 2, null);
  ok(orderedValues.join(',') === '100,200', 'fallback adapter accepts features in requested coordinate order');
  const reversedProvider = createOpenElevationProvider({
    lats: providerLats,
    lons: providerLons,
    fetchImpl: responseWithFeatures([featureAt(1, 200), featureAt(0, 100)]),
    timeoutMs: 1000
  });
  let reversedOrderError = null;
  try {
    await reversedProvider(0, 2, null);
  } catch (error) {
    reversedOrderError = error;
  }
  ok(reversedOrderError instanceof ProviderError && reversedOrderError.kind === 'invalid-payload', 'fallback adapter rejects features returned in a different coordinate order');

  console.log('== Retry-After parsing (unit) ==');
  ok(parseRetryAfterSeconds(5) === 5, 'numeric seconds are honored');
  ok(parseRetryAfterSeconds('12') === 12, 'numeric string seconds are honored');
  ok(parseRetryAfterSeconds(0) === null, 'zero seconds are rejected');
  ok(parseRetryAfterSeconds(-3) === null, 'negative seconds are rejected');
  ok(parseRetryAfterSeconds('garbage') === null, 'invalid string is rejected');
  ok(parseRetryAfterSeconds(null) === null, 'null is rejected');
  const nowMs = Date.parse('2026-01-01T00:00:00Z');
  const futureHttpDate = 'Fri, 01 Jan 2026 00:10:00 GMT';
  ok(parseRetryAfterSeconds(futureHttpDate, { nowMs }) === 600, 'a future HTTP date yields positive seconds');
  ok(parseRetryAfterSeconds('Thu, 31 Dec 2025 23:59:00 GMT', { nowMs }) === null, 'a past HTTP date is rejected');

  console.log('== backoff with jitter (unit) ==');
  ok(backoffDelayMs(0, { random: () => 0.5 }) === 5000, 'midpoint jitter keeps the base delay');
  ok(backoffDelayMs(0, { random: () => 1 }) === 5500, 'max jitter adds 10%');
  ok(backoffDelayMs(0, { random: () => 0 }) === 4500, 'min jitter removes 10%');
  ok(backoffDelayMs(4, { random: () => 0.5 }) === 60000, 'the last schedule entry caps the delay');
  ok(backoffDelayMs(12, { random: () => 0.5 }) === 60000, 'attempts beyond the schedule clamp to the last entry');
  ok(resolveDelayMs({ kind: 'rate-limit', retryAfterSeconds: 9 }) === 9000, 'a valid Retry-After overrides the backoff');
  ok(resolveDelayMs({ kind: 'server-error', retryAfterSeconds: 9, attemptIndex: 1, random: () => 0.5 }) === 10000, 'other kinds ignore Retry-After and use the schedule');
  ok(resolveDelayMs({ kind: 'rate-limit', retryAfterSeconds: null, attemptIndex: 2, random: () => 0.5 }) === 20000, 'a missing Retry-After falls back to the schedule');

  console.log('== fetchBatchWithRetry (deterministic) ==');
  const batchValues = (start, end) => {
    const out = [];
    for (let i = start; i < end; i++) out.push(valueAt(i));
    return out;
  };
  const fixedRandom = () => 0.5;
  {
    const result = await fetchBatchWithRetry({ start: 0, end: 12, primary: async (s, e) => batchValues(s, e), sleep: noopSleep, random: fixedRandom });
    ok(result.provider === 'primary' && result.values[5] === valueAt(5), 'a valid payload succeeds on the first attempt');
  }
  {
    const sleepsSeen = [];
    const trackingSleep = (ms) => { sleepsSeen.push(ms); return Promise.resolve(); };
    let attempts = 0;
    const flaky = async (start, end) => {
      attempts++;
      if (attempts < 3) throw new ProviderError('server-error', 'HTTP 500', { status: 500 });
      return batchValues(start, end);
    };
    const result = await fetchBatchWithRetry({ start: 0, end: 12, primary: flaky, sleep: trackingSleep, random: fixedRandom });
    ok(attempts === 3 && result.values[0] === valueAt(0), 'transient 5xx is retried until success');
    ok(sleepsSeen.join(',') === '5000,10000', 'retries follow the exponential backoff schedule');
  }
  {
    let primaryAttempts = 0;
    let fallbackAttempts = 0;
    const badPrimary = async () => {
      primaryAttempts++;
      throw new ProviderError('server-error', 'HTTP 503', { status: 503 });
    };
    const goodFallback = async (start, end) => {
      fallbackAttempts++;
      return batchValues(start, end);
    };
    const logs = [];
    const result = await fetchBatchWithRetry({
      start: 0,
      end: 12,
      primary: badPrimary,
      fallback: goodFallback,
      sleep: noopSleep,
      random: fixedRandom,
      log: (line) => logs.push(line),
      logContext: { completed: 10, total: 100, start: 0, end: 12 }
    });
    ok(result.provider === 'fallback' && result.values[0] === valueAt(0), 'fallback completes the batch after the primary is exhausted');
    ok(primaryAttempts === RETRY_DEFAULTS.maxPrimaryAttempts && fallbackAttempts === 1, 'primary attempts are exhausted before the fallback is used');
    ok(logs.some((line) => line.includes('10/100 (10%)') && line.includes('primary')), 'logs include provider and completed/total percentage');
    ok(logs.some((line) => line.includes('next retry in')), 'logs include the next retry delay');
  }
  {
    let primaryAttempts = 0;
    let fallbackAttempts = 0;
    const clientErrorPrimary = async () => {
      primaryAttempts++;
      throw new ProviderError('client-error', 'HTTP 400', { status: 400 });
    };
    const clientErrorFallback = async () => {
      fallbackAttempts++;
      throw new ProviderError('client-error', 'HTTP 404', { status: 404 });
    };
    let batchError = null;
    try {
      await fetchBatchWithRetry({ start: 0, end: 12, primary: clientErrorPrimary, fallback: clientErrorFallback, sleep: noopSleep, random: fixedRandom });
    } catch (error) {
      batchError = error;
    }
    ok(batchError instanceof BatchExhaustedError, 'a 4xx other than 429 is not retried');
    ok(primaryAttempts === 1 && fallbackAttempts === 1, 'client errors stop each provider after one attempt');
  }
  {
    const sleepsSeen = [];
    const trackingSleep = (ms) => { sleepsSeen.push(ms); return Promise.resolve(); };
    const rateLimited = async () => {
      throw new ProviderError('rate-limit', 'HTTP 429', { status: 429, retryAfterSeconds: 9 });
    };
    let batchError = null;
    try {
      await fetchBatchWithRetry({ start: 0, end: 12, primary: rateLimited, fallback: rateLimited, sleep: trackingSleep, random: fixedRandom });
    } catch (error) {
      batchError = error;
    }
    ok(batchError instanceof BatchExhaustedError, '429 consumes the attempts of both providers');
    ok(sleepsSeen.length === 6 && sleepsSeen.every((ms) => ms === 9000), 'a valid Retry-After is honored on every retry');
  }
  {
    const timeouts = async () => {
      const err = new Error('aborted due to timeout');
      err.name = 'TimeoutError';
      throw err;
    };
    let batchError = null;
    try {
      await fetchBatchWithRetry({ start: 0, end: 12, primary: timeouts, sleep: noopSleep, random: fixedRandom, options: { maxPrimaryAttempts: 2 } });
    } catch (error) {
      batchError = error;
    }
    ok(batchError instanceof BatchExhaustedError && batchError.lastError.name === 'TimeoutError', 'timeouts are retried then exhaust the batch');
  }
  {
    let primaryAttempts = 0;
    let fallbackAttempts = 0;
    const badPayload = async () => {
      primaryAttempts++;
      return [1, 2];
    };
    const goodFallback = async (start, end) => {
      fallbackAttempts++;
      return batchValues(start, end);
    };
    const result = await fetchBatchWithRetry({ start: 0, end: 3, primary: badPayload, fallback: goodFallback, sleep: noopSleep, random: fixedRandom });
    ok(result.provider === 'fallback' && result.values.length === 3, 'fallback serves the batch after repeated short primary payloads');
    ok(primaryAttempts === RETRY_DEFAULTS.maxPrimaryAttempts && fallbackAttempts === 1, 'invalid primary payload consumes all configured attempts before fallback');
  }
  {
    const controller = new AbortController();
    let attempts = 0;
    const flaky = async () => {
      attempts++;
      if (attempts === 2) controller.abort(new Error('user interrupt'));
      throw new ProviderError('network', 'socket hang up');
    };
    let abortError = null;
    try {
      await fetchBatchWithRetry({ start: 0, end: 12, primary: flaky, signal: controller.signal, sleep: noopSleep, random: fixedRandom });
    } catch (error) {
      abortError = error;
    }
    ok(abortError instanceof Error && abortError.message === 'user interrupt' && attempts === 2, 'an abort during retries stops the batch and propagates the reason');
  }
  console.log('== downloader: transient 429 recovers (deterministic) ==');
  {
    const rRoot = await makeTinyDataRoot();
    const rInfo = await roadsDescriptor(rRoot);
    const rDesc = rInfo.descriptor;
    const rHash = rInfo.roadsSha256;
    const rBatches = Math.ceil(rDesc.total / BATCH);
    let calls = 0;
    let saw429 = false;
    const flakyProvider = async (start, end) => {
      calls++;
      if (!saw429 && start === 0) {
        saw429 = true;
        throw new ProviderError('rate-limit', 'HTTP 429', { status: 429, retryAfterSeconds: 1 });
      }
      return batchValues(start, end);
    };
    const sleepsSeen = [];
    const rT = await runDownloader({
      dataRoot: rRoot,
      provider: flakyProvider,
      pauseMs: 0,
      sleep: (ms) => { sleepsSeen.push(ms); return Promise.resolve(); },
      random: fixedRandom
    });
    ok(rT.code === 0, 'a single 429 is retried and the run still completes');
    ok(calls === rBatches + 1, 'the retried batch adds exactly one extra call');
    ok(sleepsSeen.length === 1 && sleepsSeen[0] === 1000, 'Retry-After is honored for the single retry');
    const aT = await readJsonFile(join(rRoot, RUNTIME_FILE_NAME));
    ok(aT.present && validateRuntimeAsset(aT.data, rDesc, rHash).ok, 'the recovered run writes a valid asset');
  }

  console.log('== downloader: 429 without Retry-After uses backoff (deterministic) ==');
  {
    const bRoot = await makeTinyDataRoot();
    let calls = 0;
    const noRetryAfter = async (start, end) => {
      calls++;
      if (calls <= 2) throw new ProviderError('rate-limit', 'HTTP 429', { status: 429 });
      return batchValues(start, end);
    };
    const sleepsSeen = [];
    const trackingSleep = (ms) => { sleepsSeen.push(ms); return Promise.resolve(); };
    const rU = await runDownloader({
      dataRoot: bRoot,
      provider: noRetryAfter,
      pauseMs: 0,
      sleep: trackingSleep,
      random: fixedRandom
    });
    ok(rU.code === 0, 'a 429 without Retry-After is still retried to success');
    ok(sleepsSeen.length === 2 && sleepsSeen[0] === 5000 && sleepsSeen[1] === 10000, 'missing Retry-After falls back to the exponential schedule');
  }
  console.log('== downloader: total exhaustion keeps the validated prefix ==');
  {
    const exRoot = await makeTinyDataRoot();
    let calls = 0;
    const failingProvider = async () => {
      calls++;
      throw new ProviderError('server-error', 'HTTP 500', { status: 500 });
    };
    const logs = [];
    const rX = await runDownloader({
      dataRoot: exRoot,
      provider: failingProvider,
      fallback: failingProvider,
      pauseMs: 0,
      sleep: noopSleep,
      random: fixedRandom,
      log: (line) => logs.push(line)
    });
    ok(rX.code === 1, 'total exhaustion exits non-zero');
    ok(rX.completed === 0, 'no unvalidated batch is marked as completed');
    ok(calls === RETRY_DEFAULTS.maxPrimaryAttempts + RETRY_DEFAULTS.maxFallbackAttempts, 'primary and fallback attempts are both consumed');
    ok(logs.some((line) => line.includes('0/' + tDesc.total + ' (0%)')), 'logs include the completed/total progress');
    const cX = await readJsonFile(join(exRoot, CHECKPOINT_FILE_NAME));
    ok(cX.present && cX.data.completed === 0, 'an empty prefix checkpoint is saved for the resume');
  }

  console.log('== downloader: fallback completes the whole grid ==');
  {
    const fbRoot = await makeTinyDataRoot();
    const failingPrimary = async () => {
      throw new ProviderError('server-error', 'HTTP 502', { status: 502 });
    };
    const rY = await runDownloader({
      dataRoot: fbRoot,
      provider: failingPrimary,
      fallback: async (start, end) => batchValues(start, end),
      pauseMs: 0,
      sleep: noopSleep,
      random: fixedRandom
    });
    ok(rY.code === 0, 'the fallback provider can complete the whole grid');
    const aY = await readJsonFile(join(fbRoot, RUNTIME_FILE_NAME));
    ok(validateRuntimeAsset(aY.data, tDesc, tHash).ok, 'fallback values produce a valid asset');
    ok(JSON.stringify(aY.data.heights) === JSON.stringify(aBase.data.heights), 'fallback run matches the single-provider baseline');
  }
  console.log('== downloader: pause between batches ==');
  {
    const pauseRoot = await makeTinyDataRoot();
    const pausesSeen = [];
    const rZ = await runDownloader({
      dataRoot: pauseRoot,
      provider: makeFakeProvider().provider,
      pauseMs: 33,
      sleep: (ms) => { pausesSeen.push(ms); return Promise.resolve(); },
      random: fixedRandom
    });
    ok(rZ.code === 0, 'a run with a pause exits 0');
    ok(pausesSeen.length === tBatches - 1 && pausesSeen.every((ms) => ms === 33), 'the pause happens between batches but not after the last one');
  }

  console.log('== downloader: SIGINT during the pause ==');
  {
    const pauseSigRoot = await makeTinyDataRoot();
    const sigSource2 = new EventEmitter();
    const rPS = runDownloader({
      dataRoot: pauseSigRoot,
      provider: makeFakeProvider().provider,
      signalSource: sigSource2,
      pauseMs: 60000,
      sleep: (ms, signal) => sleepAbortable(ms, signal)
    });
    await delay(100);
    sigSource2.emit('SIGINT');
    const rP = await rPS;
    ok(rP.code === 130, 'SIGINT during the pause exits non-zero');
    ok(rP.completed === BATCH, 'the pause does not advance the checkpoint');
    const cP = await readJsonFile(join(pauseSigRoot, CHECKPOINT_FILE_NAME));
    ok(cP.present && cP.data.completed === BATCH, 'the pause is interruptible and saves progress');
  }

  console.log('== downloader: second SIGINT during the pause ==');
  {
    const pauseSig2Root = await makeTinyDataRoot();
    const sigSource3 = new EventEmitter();
    let forcedExit = null;
    const rQS = runDownloader({
      dataRoot: pauseSig2Root,
      provider: makeFakeProvider().provider,
      signalSource: sigSource3,
      pauseMs: 60000,
      sleep: (ms, signal) => sleepAbortable(ms, signal),
      forceExit: (code) => { forcedExit = code; }
    });
    await delay(100);
    sigSource3.emit('SIGINT');
    sigSource3.emit('SIGINT');
    ok(forcedExit === 1, 'the second SIGINT forces exit while paused');
    const rQ = await rQS;
    ok(rQ.code === 130, 'the paused run still settles after the forced exit');
  }
  console.log(passed + ' tests passed');
} catch (error) {
  failure = error;
  console.error('FAILED:', error.message);
} finally {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true });
  }
}

if (failure) throw failure;
