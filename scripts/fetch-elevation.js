import { readFile, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseMapData } from '../shared/mapdata.js';
import {
  CHECKPOINT_FILE_NAME,
  ELEVATION_SCHEMA_VERSION,
  ROADS_FILE_NAME,
  RUNTIME_FILE_NAME,
  buildFinalAsset,
  gridDescriptor,
  gridSamplePoints,
  validateCheckpoint,
  validateRuntimeAsset
} from '../shared/elevation.js';
import {
  convertLegacyCheckpoint,
  readJsonFile,
  sha256Hex,
  writeAtomic
} from './elevation-store.js';
import {
  BatchExhaustedError,
  ProviderError,
  RETRY_DEFAULTS,
  classifyProviderError,
  fetchBatchWithRetry,
  parseRetryAfterSeconds
} from './elevation-retry.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const BATCH = RETRY_DEFAULTS.batch;
const DEFAULT_SAVE_EVERY_BATCHES = 40;

function combineSignals(signals) {
  const controller = new AbortController();
  for (const signal of signals) {
    if (!signal) continue;
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}

export function sleepAbortable(ms, signal) {
  if (!Number.isFinite(ms) || ms <= 0) return Promise.resolve();
  if (!signal) return new Promise((resolve) => { setTimeout(resolve, ms); });
  if (signal.aborted) return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function readExisting(filePath) {
  try {
    return await readJsonFile(filePath);
  } catch (error) {
    if (error instanceof SyntaxError) return { present: true, raw: null, data: null, parseError: true };
    throw error;
  }
}

function createHttpElevationProvider({ name, lats, lons, fetchImpl, timeoutMs, buildUrl, extractValues }) {
  return async function httpProvider(start, end, signal) {
    const combined = combineSignals([signal, AbortSignal.timeout(timeoutMs)]);
    let res;
    try {
      res = await fetchImpl(buildUrl(start, end), { signal: combined });
    } catch (error) {
      if (signal && signal.aborted) throw error;
      const kind = classifyProviderError(error);
      throw new ProviderError(kind, name + ' ' + kind + ' failure: ' + error.message, { cause: error });
    }
    if (!res.ok) {
      if (res.status === 429) {
        throw new ProviderError('rate-limit', name + ' HTTP 429 (rate limited)', {
          status: 429,
          retryAfterSeconds: parseRetryAfterSeconds(res.headers.get('Retry-After'))
        });
      }
      if (res.status >= 400 && res.status < 500) {
        throw new ProviderError('client-error', name + ' HTTP ' + res.status, { status: res.status });
      }
      throw new ProviderError('server-error', name + ' HTTP ' + res.status, { status: res.status });
    }
    let json;
    try {
      json = await res.json();
    } catch (error) {
      throw new ProviderError('invalid-payload', name + ' response is not valid JSON', { cause: error });
    }
    return extractValues(json, start, end);
  };
}

export function createOpenMeteoProvider({ lats, lons, fetchImpl = fetch, timeoutMs = RETRY_DEFAULTS.requestTimeoutMs }) {
  return createHttpElevationProvider({
    name: 'open-meteo',
    lats,
    lons,
    fetchImpl,
    timeoutMs,
    buildUrl: (start, end) =>
      'https://api.open-meteo.com/v1/elevation?latitude=' + lats.slice(start, end).join(',') +
      '&longitude=' + lons.slice(start, end).join(','),
    extractValues: (json) => {
      if (!json || !Array.isArray(json.elevation)) {
        throw new ProviderError('invalid-payload', 'open-meteo response is missing the elevation array');
      }
      return json.elevation;
    }
  });
}

export function createOpenElevationProvider({ lats, lons, fetchImpl = fetch, timeoutMs = RETRY_DEFAULTS.requestTimeoutMs }) {
  return createHttpElevationProvider({
    name: 'openelevation',
    lats,
    lons,
    fetchImpl,
    timeoutMs,
    buildUrl: (start, end) => {
      const locs = [];
      for (let k = start; k < end; k++) locs.push(lats[k] + ',' + lons[k]);
      return 'https://api.openelevation.net/point?locations=' + locs.join('|');
    },
    extractValues: (json, start) => {
      if (!json || !Array.isArray(json.features)) {
        throw new ProviderError('invalid-payload', 'openelevation response is missing the features array');
      }
      const out = new Array(json.features.length);
      for (let k = 0; k < json.features.length; k++) {
        const feature = json.features[k];
        const coordinates = feature?.geometry?.coordinates;
        const expectedLat = Number(lats[start + k]);
        const expectedLon = Number(lons[start + k]);
        const lon = Array.isArray(coordinates) ? coordinates[0] : NaN;
        const lat = Array.isArray(coordinates) ? coordinates[1] : NaN;
        if (!Number.isFinite(lon) || !Number.isFinite(lat) ||
            Math.abs(lon - expectedLon) > 1e-5 || Math.abs(lat - expectedLat) > 1e-5) {
          throw new ProviderError('invalid-payload', 'openelevation feature ' + k + ' does not match the requested coordinate order');
        }
        out[k] = feature && feature.properties && Number.isFinite(feature.properties.elevation)
          ? feature.properties.elevation
          : NaN;
      }
      return out;
    }
  });
}

export async function runDownloader(options) {
  const dataRoot = resolve(options.dataRoot);
  const force = !!options.force;
  const batch = options.batch ?? RETRY_DEFAULTS.batch;
  const saveEveryBatches = options.saveEveryBatches ?? DEFAULT_SAVE_EVERY_BATCHES;
  const pauseMs = options.pauseMs ?? RETRY_DEFAULTS.pauseMs;
  const writeAtomicFn = options.writeAtomic ?? writeAtomic;
  const buildAsset = options.buildAsset ?? buildFinalAsset;
  const signalSource = options.signalSource ?? process;
  const log = options.log ?? console.log;
  const forceExit = options.forceExit ?? ((code) => process.exit(code));
  const sleep = options.sleep ?? sleepAbortable;
  const random = options.random ?? Math.random;
  const retryOptions = options.retryOptions ?? {};
  const checkpointPath = join(dataRoot, CHECKPOINT_FILE_NAME);
  const runtimePath = join(dataRoot, RUNTIME_FILE_NAME);

  if (!Number.isInteger(batch) || batch < 1) throw new Error('batch must be a positive integer');
  if (!Number.isInteger(saveEveryBatches) || saveEveryBatches < 1) throw new Error('saveEveryBatches must be a positive integer');
  if (!Number.isFinite(pauseMs) || pauseMs < 0) throw new Error('pauseMs must be a non-negative number');

  let rawRoads;
  try {
    rawRoads = await readFile(join(dataRoot, ROADS_FILE_NAME), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { code: 1, reason: 'roads.json not found in dataRoot', completed: null, total: null };
    throw error;
  }
  const map = parseMapData(JSON.parse(rawRoads));
  const descriptor = gridDescriptor(map.bbox);
  const roadsSha256 = await sha256Hex(rawRoads);
  const total = descriptor.total;

  const existing = await readExisting(runtimePath);
  if (existing.present) {
    const check = existing.parseError
      ? { ok: false, reason: 'file is not valid JSON' }
      : validateRuntimeAsset(existing.data, descriptor, roadsSha256);
    if (check.ok && !force) {
      return { code: 0, reason: 'existing elevation.json is compatible; nothing to do', completed: total, total };
    }
    if (!force) {
      return { code: 1, reason: 'existing elevation.json is incompatible (' + check.reason + '); use --force to regenerate', completed: null, total };
    }
  }

  const elev = new Float64Array(total).fill(NaN);
  let completed = 0;
  const saved = await readExisting(checkpointPath);

  if (saved.present) {
    const check = saved.parseError
      ? { ok: false, reason: 'file is not valid JSON' }
      : validateCheckpoint(saved.data, descriptor, roadsSha256);
    if (!check.ok) {
      return { code: 1, reason: 'existing checkpoint is invalid (' + check.reason + '); fix or remove it before resuming', completed: 0, total };
    }
    completed = saved.data.completed;
    elev.set(saved.data.elevations);
  } else {
    const legacy = await convertLegacyCheckpoint(dataRoot);
    if (legacy.ok) {
      completed = legacy.checkpoint.completed;
      elev.set(legacy.checkpoint.elevations);
      log('resuming from converted legacy checkpoint: ' + completed + '/' + total);
    } else if (legacy.reason !== 'legacy partial not found in dataRoot') {
      return { code: 1, reason: 'legacy checkpoint conversion refused: ' + legacy.reason, completed: 0, total };
    }
  }

  let primary = options.primary ?? options.provider;
  let fallback = options.fallback ?? null;
  if (!primary) {
    const points = gridSamplePoints(map, descriptor);
    const fetchImpl = options.fetchImpl ?? fetch;
    const timeoutMs = options.requestTimeoutMs ?? RETRY_DEFAULTS.requestTimeoutMs;
    primary = createOpenMeteoProvider({ lats: points.lats, lons: points.lons, fetchImpl, timeoutMs });
    fallback = createOpenElevationProvider({ lats: points.lats, lons: points.lons, fetchImpl, timeoutMs });
  }

  let interrupted = null;
  let currentAbort = null;
  function onSignal(name) {
    if (interrupted) {
      forceExit(1);
      return;
    }
    interrupted = name;
    if (currentAbort) currentAbort.abort();
  }
  const onSigint = () => onSignal('SIGINT');
  const onSigterm = () => onSignal('SIGTERM');
  signalSource.on('SIGINT', onSigint);
  signalSource.on('SIGTERM', onSigterm);

  async function saveCheckpoint() {
    const snapshot = {
      schemaVersion: ELEVATION_SCHEMA_VERSION,
      roadsSha256,
      originX: descriptor.originX,
      originZ: descriptor.originZ,
      cell: descriptor.cell,
      cols: descriptor.cols,
      rows: descriptor.rows,
      total: descriptor.total,
      completed,
      elevations: Array.from(elev.subarray(0, completed))
    };
    const check = validateCheckpoint(snapshot, descriptor, roadsSha256);
    if (!check.ok) throw new Error('checkpoint self-validation failed: ' + check.reason);
    await writeAtomicFn(checkpointPath, JSON.stringify(snapshot));
  }

  let outcome = null;
  try {
    if (completed < total) {
      log('grid ' + descriptor.cols + 'x' + descriptor.rows + ' @ ' + descriptor.cell + ' m (' + total + ' points), completed ' + completed + '/' + total);
      let batchesSinceSave = 0;
      for (let start = completed; start < total; start += batch) {
        if (interrupted) {
          outcome = { code: 130, reason: 'interrupted by ' + interrupted + ' at ' + completed + '/' + total };
          break;
        }
        const end = Math.min(start + batch, total);
        currentAbort = new AbortController();
        try {
          const result = await fetchBatchWithRetry({
            start,
            end,
            primary,
            fallback,
            signal: currentAbort.signal,
            sleep,
            random,
            log,
            logContext: { completed, total, start, end },
            options: retryOptions
          });
          for (let k = 0; k < result.values.length; k++) elev[start + k] = result.values[k];
          completed = end;
          batchesSinceSave++;
          if (batchesSinceSave >= saveEveryBatches) {
            batchesSinceSave = 0;
            try {
              await saveCheckpoint();
            } catch (error) {
              outcome = { code: 1, reason: 'checkpoint save failed: ' + error.message };
              break;
            }
            log('progress ' + completed + '/' + total + ' (' + Math.floor((100 * completed) / total) + '%)');
          }
        } catch (error) {
          if (interrupted) {
            outcome = { code: 130, reason: 'interrupted by ' + interrupted + ' at ' + start + '/' + total + ': ' + error.message };
          } else if (error instanceof BatchExhaustedError) {
            outcome = { code: 1, reason: 'retry attempts exhausted for batch ' + start + '/' + total + (error.lastError && error.lastError.message ? ' (' + error.lastError.message + ')' : '') };
          } else {
            outcome = { code: 1, reason: 'provider error at ' + start + '/' + total + ': ' + error.message };
          }
          break;
        }
        if (end < total && pauseMs > 0 && !interrupted) {
          try {
            await sleep(pauseMs, currentAbort.signal);
          } catch (error) {
            if (!interrupted) outcome = { code: 1, reason: 'pause between batches interrupted: ' + error.message };
            break;
          }
        }
      }
      if (!outcome && interrupted) {
        outcome = { code: 130, reason: 'interrupted by ' + interrupted + ' at ' + completed + '/' + total };
      }
    }

    if (!outcome) {
      let asset;
      try {
        asset = await buildAsset({ elev, map, descriptor, roadsSha256 });
      } catch (error) {
        outcome = { code: 1, reason: 'final asset build failed: ' + error.message };
      }
      if (!outcome) {
        const check = validateRuntimeAsset(asset, descriptor, roadsSha256);
        if (!check.ok) outcome = { code: 1, reason: 'final output failed validation: ' + check.reason };
      }
      if (!outcome) {
        try {
          await writeAtomicFn(runtimePath, JSON.stringify(asset));
        } catch (error) {
          outcome = { code: 1, reason: 'final write failed: ' + error.message };
        }
      }
    }
    if (!outcome) {
      try {
        await unlink(checkpointPath);
      } catch (error) {
        if (error.code !== 'ENOENT') outcome = { code: 1, reason: 'checkpoint cleanup failed' };
      }
    }
    if (!outcome) {
      outcome = { code: 0, reason: 'done' };
      log('elevation grid saved: ' + total + ' points -> ' + runtimePath);
    }
  } finally {
    signalSource.off('SIGINT', onSigint);
    signalSource.off('SIGTERM', onSigterm);
  }
  if (outcome.code !== 0) {
    await saveCheckpoint().catch((error) => {
      console.error('final checkpoint save failed: ' + error.message);
    });
  }
  return { code: outcome.code, reason: outcome.reason, completed, total };
}

function parseArgs(argv) {
  const args = {
    force: false,
    dataRoot: null,
    saveEvery: DEFAULT_SAVE_EVERY_BATCHES,
    batch: RETRY_DEFAULTS.batch,
    pauseMs: RETRY_DEFAULTS.pauseMs
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--force') {
      args.force = true;
    } else if (arg === '--data-root') {
      args.dataRoot = argv[++i];
    } else if (arg === '--save-every') {
      args.saveEvery = Number(argv[++i]);
    } else if (arg === '--batch') {
      args.batch = Number(argv[++i]);
    } else if (arg === '--pause-ms') {
      args.pauseMs = Number(argv[++i]);
    } else {
      throw new Error('unknown option ' + arg + ' (expected --force, --data-root <path>, --save-every <batches>, --batch <n>, --pause-ms <ms>)');
    }
  }
  args.dataRoot = args.dataRoot ? resolve(args.dataRoot) : join(__dirname, '..', 'public', 'data');
  if (!Number.isInteger(args.saveEvery) || args.saveEvery < 1) {
    throw new Error('--save-every must be a positive integer number of batches');
  }
  if (!Number.isInteger(args.batch) || args.batch < 1) {
    throw new Error('--batch must be a positive integer number of points');
  }
  if (!Number.isFinite(args.pauseMs) || args.pauseMs < 0) {
    throw new Error('--pause-ms must be a non-negative number of milliseconds');
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await runDownloader({
    dataRoot: args.dataRoot,
    force: args.force,
    saveEveryBatches: args.saveEvery,
    batch: args.batch,
    pauseMs: args.pauseMs
  });
  if (result.code === 0) {
    console.log('elevation download finished');
  } else {
    console.error('elevation download stopped: ' + result.reason);
  }
  return result.code;
}

const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
