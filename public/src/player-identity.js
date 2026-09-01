const DRIVER_NAMES = Object.freeze([
  'Falco',
  'Lupo',
  'Volpe',
  'Tasso',
  'Cobra',
  'Drago',
  'Rombo',
  'Tuono',
  'Saetta'
]);

const DRIVER_TRAITS = Object.freeze([
  'Rosso',
  'Blu',
  'Nero',
  'Oro',
  'Lampo',
  'Turbo'
]);

export const PLAYER_COLORS = Object.freeze([
  '#e33b3b',
  '#3b6fe2',
  '#e2c23b',
  '#3be26f',
  '#e26f3b',
  '#a855f7',
  '#22b8cf',
  '#f06595'
]);

function randomIndex(length, random) {
  const draw = typeof random === 'function' ? random() : Math.random();
  const normalized = Number.isFinite(draw) ? Math.min(Math.max(draw, 0), 0.999999999999) : 0;
  return Math.floor(normalized * length);
}

export function randomPlayerIdentity(random = Math.random) {
  const name = DRIVER_NAMES[randomIndex(DRIVER_NAMES.length, random)] + ' ' +
    DRIVER_TRAITS[randomIndex(DRIVER_TRAITS.length, random)];
  const color = PLAYER_COLORS[randomIndex(PLAYER_COLORS.length, random)];
  return { name: name.slice(0, 12), color };
}
