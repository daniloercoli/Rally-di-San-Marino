const PERCENT_EPSILON = 1e-9;

function roundedPercent(value) {
  return Math.round(value * 10) / 10;
}

function validCount(value) {
  return Number.isInteger(value) && value >= 0;
}

export function normalizeCheckpointCoverage(payload, expectedTotal) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
    !Number.isInteger(expectedTotal) || expectedTotal < 2 ||
    !validCount(payload.checkpointsHit) || !validCount(payload.checkpointsMissed) ||
    payload.checkpointsTotal !== expectedTotal ||
    payload.checkpointsHit + payload.checkpointsMissed !== expectedTotal) return null;

  const checkpointsHitPercent = roundedPercent(payload.checkpointsHit / expectedTotal * 100);
  const checkpointsMissedPercent = roundedPercent(100 - checkpointsHitPercent);
  if (!Number.isFinite(payload.checkpointsHitPercent) ||
    !Number.isFinite(payload.checkpointsMissedPercent) ||
    Math.abs(payload.checkpointsHitPercent - checkpointsHitPercent) > PERCENT_EPSILON ||
    Math.abs(payload.checkpointsMissedPercent - checkpointsMissedPercent) > PERCENT_EPSILON) return null;

  return {
    checkpointsHit: payload.checkpointsHit,
    checkpointsMissed: payload.checkpointsMissed,
    checkpointsTotal: expectedTotal,
    checkpointsHitPercent,
    checkpointsMissedPercent
  };
}

function localizedPercent(value) {
  return (Number.isInteger(value) ? String(value) : value.toFixed(1)).replace('.', ',');
}

export function checkpointCoverageLabel(coverage) {
  if (!coverage || !Number.isFinite(coverage.checkpointsHitPercent) ||
    !Number.isFinite(coverage.checkpointsMissedPercent) ||
    !validCount(coverage.checkpointsHit) || !validCount(coverage.checkpointsTotal) ||
    coverage.checkpointsHit > coverage.checkpointsTotal) return '';
  return 'CP ' + localizedPercent(coverage.checkpointsHitPercent) + '% segnati · ' +
    localizedPercent(coverage.checkpointsMissedPercent) + '% mancati (' +
    coverage.checkpointsHit + '/' + coverage.checkpointsTotal + ')';
}

export function localCheckpointEvent(previousSnapshot, currentSnapshot, playerId) {
  if (playerId === null || playerId === undefined || !previousSnapshot || !currentSnapshot ||
    previousSnapshot.id !== playerId || currentSnapshot.id !== playerId) return null;
  const previousHits = previousSnapshot.checkpointsHit;
  const currentHits = currentSnapshot.checkpointsHit;
  if (!Number.isSafeInteger(previousHits) || previousHits < 0 ||
    !Number.isSafeInteger(currentHits) || currentHits <= previousHits) return null;
  return { checkpointsHit: currentHits, gained: currentHits - previousHits };
}
