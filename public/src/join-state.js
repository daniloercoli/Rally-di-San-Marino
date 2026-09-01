export const JOIN_PHASE = Object.freeze({
  INTRO: 'intro',
  CUSTOMIZE: 'customize',
  SUBMITTING: 'submitting',
  ENTERED: 'entered',
  FULL: 'full',
  ERROR: 'error',
  RACE_STARTED: 'race_started'
});

export const INITIAL_JOIN_STATE = Object.freeze({ phase: JOIN_PHASE.INTRO });

export function transitionJoin(state, event) {
  const phase = state?.phase || JOIN_PHASE.INTRO;
  const type = event?.type;

  if (type === 'init') return { state: { phase: JOIN_PHASE.ENTERED }, emitJoin: false };
  if (type === 'full') return { state: { phase: JOIN_PHASE.FULL }, emitJoin: false };
  if (type === 'error') return { state: { phase: JOIN_PHASE.ERROR }, emitJoin: false };
  if (type === 'race_started') return { state: { phase: JOIN_PHASE.RACE_STARTED }, emitJoin: false };

  if (type === 'connected' && phase === JOIN_PHASE.ERROR) {
    return { state: { phase: JOIN_PHASE.INTRO }, emitJoin: false };
  }

  if (type === 'availability') {
    const raceAvailable = phase === JOIN_PHASE.RACE_STARTED && event.phase === 'waiting';
    const seatAvailable = phase === JOIN_PHASE.FULL && event.hasSeat && event.phase === 'waiting';
    if (raceAvailable || seatAvailable) {
      return { state: { phase: JOIN_PHASE.CUSTOMIZE }, emitJoin: false };
    }
  }

  if (type === 'click') {
    if (phase === JOIN_PHASE.INTRO) {
      return { state: { phase: JOIN_PHASE.CUSTOMIZE }, emitJoin: false };
    }
    if (phase === JOIN_PHASE.CUSTOMIZE) {
      return { state: { phase: JOIN_PHASE.SUBMITTING }, emitJoin: true };
    }
  }

  return { state: { phase }, emitJoin: false };
}

export function joinView(state) {
  switch (state?.phase) {
    case JOIN_PHASE.CUSTOMIZE:
      return { visible: true, setup: true, disabled: false, label: 'Entra nella lobby', message: 'Personalizza la tua auto' };
    case JOIN_PHASE.SUBMITTING:
      return { visible: true, setup: true, disabled: true, label: 'Ingresso…', message: 'Connessione alla gara…' };
    case JOIN_PHASE.ENTERED:
      return { visible: false, setup: false, disabled: true, label: 'In gara', message: '' };
    case JOIN_PHASE.FULL:
      return { visible: true, setup: true, disabled: true, label: 'Gara piena', message: 'Gara piena (4/4)' };
    case JOIN_PHASE.ERROR:
      return { visible: true, setup: false, disabled: true, label: 'Server non disponibile', message: 'Server non raggiungibile, riavvia: npm run dev' };
    case JOIN_PHASE.RACE_STARTED:
      return { visible: true, setup: true, disabled: true, label: 'Gara in corso', message: 'Gara già iniziata: attendi la prossima lobby' };
    default:
      return { visible: true, setup: false, disabled: false, label: 'Entra nella lobby', message: '4 giocatori · strade reali OpenStreetMap' };
  }
}
