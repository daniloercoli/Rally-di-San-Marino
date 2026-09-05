export const DEFAULT_WEATHER_ID = 'clear';

export const WEATHER_PRESETS = Object.freeze([
  Object.freeze({ id: 'clear', label: 'Sereno' }),
  Object.freeze({ id: 'cloudy', label: 'Nuvoloso' }),
  Object.freeze({ id: 'fog', label: 'Nebbia' })
]);

const WEATHER_IDS = new Set(WEATHER_PRESETS.map((preset) => preset.id));

export function normalizeWeatherId(value, fallback = DEFAULT_WEATHER_ID) {
  const safeFallback = WEATHER_IDS.has(fallback) ? fallback : DEFAULT_WEATHER_ID;
  return typeof value === 'string' && WEATHER_IDS.has(value) ? value : safeFallback;
}

export function publicWeatherOptions() {
  return WEATHER_PRESETS.map(({ id, label }) => ({ id, label }));
}
