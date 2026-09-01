export const RETRY_DEFAULTS = Object.freeze({
  batch: 25,
  pauseMs: 5000,
  requestTimeoutMs: 30000,
  maxPrimaryAttempts: 5,
  maxFallbackAttempts: 3,
  backoffScheduleMs: Object.freeze([5000, 10000, 20000, 30000, 60000]),
  jitter: 0.1
});

export class ProviderError extends Error {
  constructor(kind, message, { status = null, retryAfterSeconds = null, cause = null } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'ProviderError';
    this.kind = kind;
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class BatchExhaustedError extends Error {
  constructor({ start, end, lastError = null }) {
    super('all retry attempts exhausted for elevation batch ' + start + '..' + end);
    this.name = 'BatchExhaustedError';
    this.start = start;
    this.end = end;
    this.lastError = lastError;
  }
}

export function classifyProviderError(error) {
  if (error instanceof ProviderError) return error.kind;
  if (error instanceof Error) {
    if (error.name === 'TimeoutError') return 'timeout';
    if (error.name === 'AbortError') return 'aborted';
  }
  return 'network';
}

export function validateProviderBatch(values, expectedLength) {
  if (!Array.isArray(values)) return { ok: false, reason: 'payload is not an array' };
  if (values.length !== expectedLength) {
    return { ok: false, reason: 'payload has ' + values.length + ' values, expected ' + expectedLength };
  }
  for (let k = 0; k < values.length; k++) {
    if (typeof values[k] !== 'number' || !Number.isFinite(values[k])) {
      return { ok: false, reason: 'value at index ' + k + ' is not a finite number' };
    }
  }
  return { ok: true, reason: null };
}

export function parseRetryAfterSeconds(value, { nowMs = Date.now() } = {}) {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? value : null;
  }
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;
  if (/^\d+(\.\d+)?$/.test(text)) {
    const seconds = Number(text);
    return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
  }
  const dateMs = Date.parse(text);
  if (!Number.isFinite(dateMs)) return null;
  const deltaSeconds = (dateMs - nowMs) / 1000;
  return deltaSeconds > 0 ? Math.ceil(deltaSeconds) : null;
}

export function backoffDelayMs(attemptIndex = 0, { schedule = RETRY_DEFAULTS.backoffScheduleMs, jitter = RETRY_DEFAULTS.jitter, random = Math.random } = {}) {
  const clampedIndex = Number.isInteger(attemptIndex) && attemptIndex >= 0 ? Math.min(attemptIndex, schedule.length - 1) : 0;
  const base = schedule[clampedIndex];
  const clampedJitter = Number.isFinite(jitter) ? Math.max(0, Math.min(jitter, 1)) : 0;
  const factor = 1 + (random() * 2 - 1) * clampedJitter;
  return Math.max(0, Math.round(base * factor));
}

export function resolveDelayMs({ kind, retryAfterSeconds = null, attemptIndex = 0, schedule, jitter, random }) {
  if (kind === 'rate-limit' && Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
    return Math.round(retryAfterSeconds * 1000);
  }
  return backoffDelayMs(attemptIndex, { schedule, jitter, random });
}

function describeProviderError(error) {
  if (error instanceof ProviderError) return error.kind + ': ' + error.message;
  if (error && error.message) return String(error.message);
  return String(error);
}

function formatLogContext(context) {
  const parts = [];
  if (context && Number.isInteger(context.completed) && Number.isInteger(context.total) && context.total > 0) {
    parts.push(context.completed + '/' + context.total + ' (' + Math.floor((100 * context.completed) / context.total) + '%)');
  }
  if (context && Number.isInteger(context.start) && Number.isInteger(context.end)) {
    parts.push('batch ' + context.start + '..' + context.end);
  }
  return parts.join(' ');
}

function abortReason(signal) {
  return signal && signal.reason instanceof Error ? signal.reason : new Error('aborted');
}

const defaultSleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

export async function fetchBatchWithRetry({ start, end, primary, fallback = null, signal = null, sleep = defaultSleep, random = Math.random, log = () => {}, logContext = null, options = null }) {
  const config = options ?? {};
  const maxPrimaryAttempts = config.maxPrimaryAttempts ?? RETRY_DEFAULTS.maxPrimaryAttempts;
  const maxFallbackAttempts = config.maxFallbackAttempts ?? RETRY_DEFAULTS.maxFallbackAttempts;
  const schedule = config.backoffScheduleMs ?? RETRY_DEFAULTS.backoffScheduleMs;
  const jitter = config.jitter ?? RETRY_DEFAULTS.jitter;
  const expectedLength = end - start;
  const phases = [];
  if (primary) phases.push({ name: 'primary', fn: primary, maxAttempts: maxPrimaryAttempts });
  if (fallback) phases.push({ name: 'fallback', fn: fallback, maxAttempts: maxFallbackAttempts });
  if (phases.length === 0) throw new TypeError('fetchBatchWithRetry needs a primary provider');
  const contextText = formatLogContext(logContext);
  let failures = 0;
  let lastError = null;
  for (const phase of phases) {
    for (let attempt = 1; attempt <= phase.maxAttempts; attempt++) {
      if (signal && signal.aborted) throw abortReason(signal);
      let error = null;
      try {
        const values = await phase.fn(start, end, signal);
        const check = validateProviderBatch(values, expectedLength);
        if (!check.ok) {
          error = new ProviderError('invalid-payload', check.reason);
        } else {
          return { values, provider: phase.name };
        }
      } catch (err) {
        error = err;
      }
      if (signal && signal.aborted) throw abortReason(signal);
      const kind = classifyProviderError(error);
      lastError = error;
      const prefix = 'elevation' + (contextText ? ' ' + contextText : '') + ': ' + phase.name + ' attempt ' + attempt + '/' + phase.maxAttempts + ' failed (' + describeProviderError(error) + ')';
      if (kind === 'aborted') throw error;
      if (kind === 'client-error') {
        log(prefix + '; stopping ' + phase.name + ' retries');
        break;
      }
      if (attempt >= phase.maxAttempts) {
        log(prefix);
        break;
      }
      const retryAfterSeconds = error instanceof ProviderError && Number.isFinite(error.retryAfterSeconds) && error.retryAfterSeconds > 0 ? error.retryAfterSeconds : null;
      const delayMs = resolveDelayMs({ kind, retryAfterSeconds, attemptIndex: failures, schedule, jitter, random });
      failures += 1;
      log(prefix + '; next retry in ' + Math.ceil(delayMs / 1000) + 's');
      await sleep(delayMs, signal);
    }
  }
  throw new BatchExhaustedError({ start, end, lastError });
}
