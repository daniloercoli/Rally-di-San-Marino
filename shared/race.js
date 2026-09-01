export const RACE_PHASE = Object.freeze({
  WAITING: 'waiting',
  COUNTDOWN: 'countdown',
  RUNNING: 'running',
  RESULTS: 'results'
});

export const RESULTS_DURATION_MS = 5000;
export const START_LIGHT_LEAD_IN_MS = 1000;
export const START_LIGHT_INTERVAL_MS = 700;
export const START_LIGHT_COUNT = 5;
export const START_DELAY_MIN_MS = 4500;
export const START_DELAY_MAX_MS = 6800;
export const START_GREEN_DURATION_MS = 1000;

export function randomStartDelayMs(random = Math.random) {
  const raw = typeof random === 'function' ? random() : random;
  const sample = typeof raw === 'number' && Number.isFinite(raw)
    ? Math.min(1, Math.max(0, raw))
    : 0;
  return Math.round(START_DELAY_MIN_MS + sample * (START_DELAY_MAX_MS - START_DELAY_MIN_MS));
}

function validCountdownMs(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function waitingState(state, nowMs) {
  return {
    phase: RACE_PHASE.WAITING,
    countdownMs: state.countdownMs,
    countdownStartedAtMs: null,
    raceStartT: null,
    greenStartedAtMs: null,
    resultsStartedAtMs: null,
    round: state.round || 0,
    updatedAtMs: nowMs
  };
}

export function createRaceState(countdownSeconds, nowMs) {
  const seconds = typeof countdownSeconds === 'number' && Number.isFinite(countdownSeconds)
    ? Math.max(0, countdownSeconds)
    : 0;
  return waitingState({ countdownMs: seconds * 1000, round: 0 }, nowMs);
}

export function startRace(state, nowMs, countdownMs = state.countdownMs) {
  if (state.phase !== RACE_PHASE.WAITING) return { ...state, updatedAtMs: nowMs };
  return {
    ...state,
    phase: RACE_PHASE.COUNTDOWN,
    countdownMs: validCountdownMs(countdownMs, state.countdownMs),
    countdownStartedAtMs: nowMs,
    raceStartT: null,
    greenStartedAtMs: null,
    resultsStartedAtMs: null,
    updatedAtMs: nowMs
  };
}

export function advanceRace(state, playerCount, nowMs, allFinished = false) {
  if (playerCount <= 0) return waitingState(state, nowMs);

  if (state.phase === RACE_PHASE.RUNNING && allFinished) {
    return {
      ...state,
      phase: RACE_PHASE.RESULTS,
      greenStartedAtMs: null,
      resultsStartedAtMs: nowMs,
      updatedAtMs: nowMs
    };
  }

  if (state.phase === RACE_PHASE.RESULTS) {
    const resultsEndMs = state.resultsStartedAtMs + RESULTS_DURATION_MS;
    if (nowMs < resultsEndMs) return { ...state, updatedAtMs: nowMs };
    return waitingState({ ...state, round: state.round + 1 }, nowMs);
  }

  if (state.phase !== RACE_PHASE.COUNTDOWN) return { ...state, updatedAtMs: nowMs };

  const elapsedMs = Math.max(0, nowMs - state.countdownStartedAtMs);
  if (elapsedMs < state.countdownMs) return { ...state, updatedAtMs: nowMs };
  return {
    ...state,
    phase: RACE_PHASE.RUNNING,
    raceStartT: state.countdownStartedAtMs + state.countdownMs,
    greenStartedAtMs: nowMs,
    updatedAtMs: nowMs
  };
}

export function leaveRace(state, playerCount, nowMs) {
  return playerCount <= 0 ? waitingState(state, nowMs) : { ...state, updatedAtMs: nowMs };
}

export function publicRaceState(state, nowMs) {
  let countdownMs = state.countdownMs;
  let resultsRemainingMs = 0;
  let startLights = 0;
  let startSignal = 'off';
  if (state.phase === RACE_PHASE.COUNTDOWN) {
    const elapsedMs = Math.max(0, nowMs - state.countdownStartedAtMs);
    countdownMs = Math.max(0, state.countdownMs - elapsedMs);
    if (elapsedMs >= START_LIGHT_LEAD_IN_MS) {
      startLights = Math.min(
        START_LIGHT_COUNT,
        1 + Math.floor((elapsedMs - START_LIGHT_LEAD_IN_MS) / START_LIGHT_INTERVAL_MS)
      );
    }
    startSignal = startLights > 0 ? 'red' : 'off';
  } else if (state.phase === RACE_PHASE.RUNNING || state.phase === RACE_PHASE.RESULTS) {
    countdownMs = 0;
  }
  const greenStartedAtMs = Number.isFinite(state.greenStartedAtMs)
    ? state.greenStartedAtMs
    : state.raceStartT;
  if (state.phase === RACE_PHASE.RUNNING && greenStartedAtMs !== null &&
    nowMs >= greenStartedAtMs && nowMs < greenStartedAtMs + START_GREEN_DURATION_MS) {
    startSignal = 'green';
  }
  if (state.phase === RACE_PHASE.RESULTS) {
    resultsRemainingMs = Math.max(0, state.resultsStartedAtMs + RESULTS_DURATION_MS - nowMs);
  }
  return {
    phase: state.phase,
    running: state.phase === RACE_PHASE.RUNNING,
    countdown: countdownMs / 1000,
    resultsRemaining: resultsRemainingMs / 1000,
    startLights,
    startSignal,
    round: state.round
  };
}

export function raceElapsedMs(state, nowMs) {
  if (state.phase !== RACE_PHASE.RUNNING || state.raceStartT === null) return 0;
  return Math.max(0, nowMs - state.raceStartT);
}

export function rankRaceCars(cars) {
  return [...cars].sort((a, b) => {
    if (a.finished !== b.finished) return a.finished ? -1 : 1;
    if (a.finished) return a.finishMs - b.finishMs || a.id - b.id;
    return (b.score || 0) - (a.score || 0) || a.id - b.id;
  });
}
