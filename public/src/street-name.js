import { normalizeRoadName } from '../../shared/mapdata.js';

export const STREET_BANNER_DURATION_MS = 3200;
export const STREET_NAME_SETTLE_MS = 250;

export function createStreetBannerState() {
  return {
    currentName: null,
    pendingName: null,
    pendingSinceMs: 0,
    text: '',
    visibleUntilMs: 0
  };
}

export function selectLocalStreetName(snapshots, localId) {
  return normalizeRoadName(snapshots?.get?.(localId)?.streetName);
}

export function advanceStreetBanner(state, value, nowMs, options = {}) {
  const previous = state && typeof state === 'object' ? state : createStreetBannerState();
  const now = Number.isFinite(nowMs) ? nowMs : 0;
  const durationMs = Number.isFinite(options.durationMs) && options.durationMs >= 0
    ? options.durationMs
    : STREET_BANNER_DURATION_MS;
  const settleMs = Number.isFinite(options.settleMs) && options.settleMs >= 0
    ? options.settleMs
    : STREET_NAME_SETTLE_MS;
  const name = normalizeRoadName(value);
  const next = {
    currentName: normalizeRoadName(previous.currentName),
    pendingName: normalizeRoadName(previous.pendingName),
    pendingSinceMs: Number.isFinite(previous.pendingSinceMs) ? previous.pendingSinceMs : now,
    text: normalizeRoadName(previous.text) || '',
    visibleUntilMs: Number.isFinite(previous.visibleUntilMs) ? previous.visibleUntilMs : 0
  };

  if (!name || name === next.currentName) {
    next.pendingName = null;
    next.pendingSinceMs = now;
  } else if (name !== next.pendingName) {
    next.pendingName = name;
    next.pendingSinceMs = now;
  } else if (now - next.pendingSinceMs >= settleMs) {
    next.currentName = name;
    next.pendingName = null;
    next.pendingSinceMs = now;
    next.text = name;
    next.visibleUntilMs = now + durationMs;
  }

  return {
    state: next,
    text: next.text,
    visible: !!next.text && now < next.visibleUntilMs
  };
}
