const TURN_TYPES = new Set(['left', 'right']);
const SEVERITY_CONFIG = Object.freeze({
  open: Object.freeze({
    label: 'aperta',
    path: 'M64 94 C64 62 51 34 20 16'
  }),
  medium: Object.freeze({
    label: 'media',
    path: 'M68 94 L68 60 Q68 30 38 30 L18 30'
  }),
  tight: Object.freeze({
    label: 'stretta',
    path: 'M72 94 L72 48 Q72 25 49 25 L18 25'
  }),
  hairpin: Object.freeze({
    label: 'tornante',
    path: 'M78 94 L78 48 Q78 18 48 18 L39 18 Q20 18 20 37 L20 50'
  })
});

export const TURN_CUE_DURATION_MS = 1000;

function finiteCar(car) {
  return car && typeof car === 'object' && !Array.isArray(car) &&
    [car.x, car.z, car.yaw, car.speed].every(Number.isFinite) &&
    Number.isInteger(car.cp) && car.cp >= 0;
}

function normalizedNote(note) {
  if (!note || typeof note !== 'object' || Array.isArray(note) ||
    !TURN_TYPES.has(note.turn) || !Object.hasOwn(SEVERITY_CONFIG, note.severity) ||
    ![note.x, note.z, note.distance, note.angleDegrees].every(Number.isFinite) ||
    note.distance < 0 || note.angleDegrees < 0 || note.angleDegrees > 180 ||
    !Number.isInteger(note.checkpoint) || note.checkpoint < 0 ||
    !Number.isInteger(note.id) || note.id < 0) return null;
  return note;
}

export function createTurnCueState() {
  return {
    shownIds: new Set(),
    active: null,
    visibleUntilMs: 0
  };
}

export function turnCueView(note) {
  const value = normalizedNote(note);
  if (!value) return { visible: false, turn: null, severity: null, label: '', path: '' };
  const config = SEVERITY_CONFIG[value.severity];
  const direction = value.turn === 'left' ? 'Sinistra' : 'Destra';
  return {
    visible: true,
    turn: value.turn,
    severity: value.severity,
    label: direction + ' ' + config.label,
    path: config.path
  };
}

export function advanceTurnCue(state, notes, car, nowMs) {
  const current = state && state.shownIds instanceof Set ? state : createTurnCueState();
  const now = Number.isFinite(nowMs) ? nowMs : 0;
  if (current.active && now < current.visibleUntilMs && finiteCar(car) &&
    car.finished !== true && car.speed >= 3) {
    return { state: current, view: turnCueView(current.active) };
  }
  current.active = null;
  current.visibleUntilMs = 0;
  if (!Array.isArray(notes) || !finiteCar(car) || car.finished === true || car.speed < 3) {
    return { state: current, view: turnCueView(null) };
  }

  const forwardX = Math.sin(car.yaw);
  const forwardZ = -Math.cos(car.yaw);
  const triggerDistance = Math.min(72, Math.max(12, car.speed));
  let next = null;
  let nextDistance = Infinity;
  for (const rawNote of notes) {
    const note = normalizedNote(rawNote);
    if (!note || current.shownIds.has(note.id) || note.checkpoint < car.cp ||
      note.checkpoint > car.cp + 3) continue;
    const dx = note.x - car.x;
    const dz = note.z - car.z;
    const distance = Math.hypot(dx, dz);
    if (distance > triggerDistance || distance <= Number.EPSILON) continue;
    const forwardDot = (forwardX * dx + forwardZ * dz) / distance;
    if (forwardDot <= 0.1) continue;
    if (!next || note.checkpoint < next.checkpoint ||
      (note.checkpoint === next.checkpoint && distance < nextDistance)) {
      next = note;
      nextDistance = distance;
    }
  }
  if (!next) return { state: current, view: turnCueView(null) };

  current.shownIds.add(next.id);
  current.active = next;
  current.visibleUntilMs = now + TURN_CUE_DURATION_MS;
  return { state: current, view: turnCueView(next) };
}
