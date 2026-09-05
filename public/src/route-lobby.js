import { WEATHER_PRESETS } from '../../shared/weather.js';

const ROUTE_ID_RE = /^[a-z0-9-]{1,64}$/;
const COLOR_RE = /^#[0-9a-f]{6}$/;
const PHASES = new Set(['waiting', 'countdown', 'running', 'results']);
const WEATHER_IDS = new Set(WEATHER_PRESETS.map((preset) => preset.id));

function boundedText(value) {
  return typeof value === 'string' ? value.trim().slice(0, 80) : '';
}

export function normalizeRouteLobby(payload) {
  const source = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  const options = [];
  const seen = new Set();
  for (const candidate of Array.isArray(source.routeOptions) ? source.routeOptions.slice(0, 32) : []) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
    const id = typeof candidate.id === 'string' && ROUTE_ID_RE.test(candidate.id) ? candidate.id : '';
    const start = boundedText(candidate.start);
    const end = boundedText(candidate.end);
    const label = boundedText(candidate.label);
    const lengthKm = typeof candidate.lengthKm === 'number' && Number.isFinite(candidate.lengthKm)
      ? Math.max(0, Math.min(candidate.lengthKm, 1000))
      : 0;
    const checkpoints = Number.isInteger(candidate.checkpoints)
      ? Math.max(2, Math.min(candidate.checkpoints, 10000))
      : 2;
    if (!id || !start || !end || seen.has(id)) continue;
    seen.add(id);
    options.push({ id, label, start, end, lengthKm, checkpoints });
  }
  const selectedRouteId = typeof source.selectedRouteId === 'string' && seen.has(source.selectedRouteId)
    ? source.selectedRouteId
    : options[0]?.id || '';
  const weatherOptions = [];
  const seenWeather = new Set();
  for (const candidate of Array.isArray(source.weatherOptions) ? source.weatherOptions.slice(0, 8) : []) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
    const id = typeof candidate.id === 'string' && WEATHER_IDS.has(candidate.id) ? candidate.id : '';
    const label = boundedText(candidate.label);
    if (!id || !label || seenWeather.has(id)) continue;
    seenWeather.add(id);
    weatherOptions.push({ id, label });
  }
  const selectedWeatherId = typeof source.selectedWeatherId === 'string' &&
    seenWeather.has(source.selectedWeatherId)
    ? source.selectedWeatherId
    : weatherOptions[0]?.id || '';
  const players = [];
  const playerIds = new Set();
  for (const candidate of Array.isArray(source.players) ? source.players.slice(0, 4) : []) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
    const id = Number.isInteger(candidate.id) && candidate.id >= 1 && candidate.id <= 4
      ? candidate.id
      : null;
    const name = boundedText(candidate.name).slice(0, 12);
    const color = typeof candidate.color === 'string' && COLOR_RE.test(candidate.color)
      ? candidate.color
      : '#8b949e';
    if (id === null || !name || playerIds.has(id)) continue;
    playerIds.add(id);
    players.push({ id, name, color, ready: candidate.ready === true });
  }
  players.sort((a, b) => a.id - b.id);
  const hostId = Number.isInteger(source.hostId) && playerIds.has(source.hostId)
    ? source.hostId
    : null;
  const phase = PHASES.has(source.phase) ? source.phase : 'waiting';
  const capacity = Number.isInteger(source.capacity)
    ? Math.max(1, Math.min(source.capacity, 4))
    : 4;
  return {
    options,
    selectedRouteId,
    weatherOptions,
    selectedWeatherId,
    locked: source.locked === true,
    phase,
    capacity,
    hostId,
    players
  };
}

export function lobbyView(lobby, playerId) {
  const players = Array.isArray(lobby?.players) ? lobby.players : [];
  const participant = players.find((player) => player.id === playerId) || null;
  const waiting = lobby?.phase === 'waiting';
  const isHost = participant !== null && lobby?.hostId === playerId;
  const allReady = players.length > 0 && players.every((player) => player.ready);
  return {
    visible: participant !== null && waiting,
    isHost,
    ready: participant?.ready === true,
    allReady,
    canChangeRoute: waiting && (lobby?.hostId === null || isHost) && lobby?.locked !== true,
    canChangeWeather: waiting && (lobby?.hostId === null || isHost) && lobby?.locked !== true,
    canStart: waiting && isHost && allReady
  };
}
