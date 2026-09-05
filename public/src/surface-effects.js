import { PHYSICS, isLooseSurface } from '../../shared/physics.js';

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function surfaceShake(surface, speed, timeSeconds, seed = 0) {
  if (!isLooseSurface(surface)) return { y: 0, pitch: 0, roll: 0 };
  const velocity = Number.isFinite(speed) ? Math.abs(speed) : 0;
  const time = Number.isFinite(timeSeconds) ? timeSeconds : 0;
  const phaseSeed = Number.isFinite(seed) ? seed * 0.73 : 0;
  const intensity = clamp((velocity - 2) / Math.max(1, PHYSICS.track.maxSpeed - 2), 0, 1);
  if (intensity === 0) return { y: 0, pitch: 0, roll: 0 };
  const phase = time * (12 + intensity * 14) + phaseSeed;
  return {
    y: (Math.sin(phase) * 0.034 + Math.sin(phase * 2.37) * 0.014) * intensity,
    pitch: Math.sin(phase * 1.31 + 0.6) * 0.026 * intensity,
    roll: Math.sin(phase * 0.91 + 1.7) * 0.019 * intensity
  };
}
