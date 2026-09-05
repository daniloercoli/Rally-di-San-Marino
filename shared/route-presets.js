// Named anchors from the versioned roads.json; no geocoding or network fetch at runtime.
// OSM way 26806906, a point inside Piazzale Lo Stradone (not the generic city place).
export const STRADONE_FINISH = Object.freeze({
  name: 'Piazzale Lo Stradone',
  lon: 12.4473032,
  lat: 43.934599
});

export const CURATED_ROUTE_PRESETS = Object.freeze([
  Object.freeze({ id: 'sprint-borgo-stradone', label: 'Sprint', start: 'Borgo Maggiore' }),
  Object.freeze({ id: 'sprint-murata-stradone', label: 'Sprint', start: 'Murata' }),
  Object.freeze({ id: 'sprint-fiorentino-stradone', label: 'Sprint', start: 'Fiorentino' }),
  Object.freeze({
    id: 'dogana-stradone-superstrada', label: 'Superstrada', start: 'Dogana', corridor: 'superstrada'
  })
]);

export const SUPERSTRADA_ROAD_NAMES = Object.freeze([
  'Via Tre Settembre',
  'Via Quattro Giugno',
  'Via Cinque Febbraio',
  'Via Venticinque Marzo',
  'Via Ventotto Luglio'
]);

const SUPERSTRADA_CORRIDOR = new Set([
  ...SUPERSTRADA_ROAD_NAMES,
  'Via Oddone Scarito',
  'Via Piana',
  'Via Giovanni Beluzzi',
  STRADONE_FINISH.name
]);

export function isSuperstradaRoad(road) {
  return !road.isUnpaved && (SUPERSTRADA_CORRIDOR.has(road.name) ||
    (!road.name && (road.cls === 'primary' || road.cls === 'primary_link')));
}
