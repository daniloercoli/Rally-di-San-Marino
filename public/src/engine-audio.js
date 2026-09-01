import { DRIVETRAIN, PHYSICS, SURFACE } from '../../shared/physics.js';

export function selectLocalSnapshot(snapshots, playerId) {
  if (playerId === null || playerId === undefined || typeof snapshots?.get !== 'function') return null;
  return snapshots.get(playerId) || null;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function normalizeDrivetrainSnapshot(snapshot) {
  const value = snapshot && typeof snapshot === 'object' ? snapshot : {};
  const gear = value.gear === -1 || (Number.isInteger(value.gear) && value.gear >= 1 && value.gear <= 5)
    ? value.gear
    : 1;
  const rpm = typeof value.rpm === 'number' && Number.isFinite(value.rpm)
    ? clamp(value.rpm, DRIVETRAIN.idleRpm, DRIVETRAIN.redlineRpm)
    : undefined;
  const brakeLevel = typeof value.brakeLevel === 'number' && Number.isFinite(value.brakeLevel)
    ? clamp(value.brakeLevel, 0, 1)
    : 0;
  return { gear, rpm, brakeLevel, handbrake: value.handbrake === true };
}

export function normalizeSurfaceSnapshot(snapshot) {
  const value = snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot) ? snapshot : {};
  const surface = value.surface === SURFACE.ASPHALT || value.surface === SURFACE.SHOULDER ||
    value.surface === SURFACE.TRACK || value.surface === SURFACE.GRASS
    ? value.surface
    : value.onRoad === false ? SURFACE.GRASS : SURFACE.ASPHALT;
  return { surface };
}

export function normalizeImpactSnapshot(snapshot) {
  const value = snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot) ? snapshot : {};
  const impactSeq = Number.isSafeInteger(value.impactSeq) && value.impactSeq >= 0
    ? value.impactSeq
    : undefined;
  const impactLevel = typeof value.impactLevel === 'number' && Number.isFinite(value.impactLevel) &&
    value.impactLevel >= 0 && value.impactLevel <= 1
    ? value.impactLevel
    : 0;
  return { impactSeq, impactLevel };
}

export function localImpactEvent(previousSnapshot, currentSnapshot, playerId) {
  if (playerId === null || playerId === undefined ||
    !previousSnapshot || !currentSnapshot ||
    previousSnapshot.id !== playerId || currentSnapshot.id !== playerId) return null;

  const previous = normalizeImpactSnapshot(previousSnapshot);
  const current = normalizeImpactSnapshot(currentSnapshot);
  if (previous.impactSeq === undefined || current.impactSeq === undefined ||
    current.impactSeq <= previous.impactSeq || current.impactLevel <= 0) return null;

  return { seq: current.impactSeq, level: current.impactLevel };
}

export function engineTargets(snapshot) {
  if (!snapshot || snapshot.finished === true) {
    return {
      frequency: 55,
      gain: 0,
      brakeGain: 0,
      brakeFrequency: 900,
      surfaceGain: 0,
      surfaceFrequency: 120,
      surfaceQ: 0.7
    };
  }

  const speed = typeof snapshot.speed === 'number' && Number.isFinite(snapshot.speed)
    ? Math.abs(snapshot.speed)
    : 0;
  const fallbackRpm = DRIVETRAIN.idleRpm + clamp(speed / PHYSICS.onRoad.maxSpeed, 0, 1) *
    (DRIVETRAIN.redlineRpm - DRIVETRAIN.idleRpm);
  const rpm = typeof snapshot.rpm === 'number' && Number.isFinite(snapshot.rpm)
    ? clamp(snapshot.rpm, DRIVETRAIN.idleRpm, DRIVETRAIN.redlineRpm)
    : fallbackRpm;
  const rpmRatio = (rpm - DRIVETRAIN.idleRpm) / (DRIVETRAIN.redlineRpm - DRIVETRAIN.idleRpm);
  const { surface } = normalizeSurfaceSnapshot(snapshot);
  const pitchFactor = surface === SURFACE.TRACK ? 0.93 : surface === SURFACE.GRASS ? 0.84 : 1;
  const frequency = clamp((55 + rpmRatio * 225) * pitchFactor, 46, 280);
  const gain = surface === SURFACE.ASPHALT || surface === SURFACE.SHOULDER
    ? 0.1 + rpmRatio * 0.28
    : surface === SURFACE.TRACK ? 0.085 + rpmRatio * 0.22 : 0.065 + rpmRatio * 0.15;
  const brakeLevel = typeof snapshot.brakeLevel === 'number' && Number.isFinite(snapshot.brakeLevel)
    ? clamp(snapshot.brakeLevel, 0, 1)
    : 0;
  const brakeSpeed = clamp((speed - 2) / 15, 0, 1);
  const brakeGain = brakeLevel * brakeSpeed * (
    surface === SURFACE.ASPHALT || surface === SURFACE.SHOULDER
      ? 0.2
      : surface === SURFACE.TRACK ? 0.14 : 0.09
  );
  const brakeFrequency = clamp(900 + speed * 45, 900, 2200);
  const surfaceSpeed = clamp((speed - 0.5) / 12, 0, 1);
  const surfaceGain = surface === SURFACE.SHOULDER
    ? surfaceSpeed * (0.035 + rpmRatio * 0.025)
    : surface === SURFACE.TRACK
      ? surfaceSpeed * (0.08 + rpmRatio * 0.08)
      : surface === SURFACE.GRASS ? surfaceSpeed * (0.06 + rpmRatio * 0.05) : 0;
  const surfaceFrequency = surface === SURFACE.SHOULDER
    ? clamp(420 + speed * 9, 420, 950)
    : surface === SURFACE.TRACK
      ? clamp(180 + speed * 8, 180, 460)
      : surface === SURFACE.GRASS ? clamp(85 + speed * 4, 85, 180) : 120;
  const surfaceQ = surface === SURFACE.SHOULDER
    ? 1.15
    : surface === SURFACE.TRACK ? 0.9 : surface === SURFACE.GRASS ? 0.45 : 0.7;
  return {
    frequency,
    gain,
    brakeGain,
    brakeFrequency,
    surfaceGain,
    surfaceFrequency,
    surfaceQ
  };
}
