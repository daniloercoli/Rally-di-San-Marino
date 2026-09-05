import { normalizeWeatherId } from '../../shared/weather.js';

const FALLBACK_WORLD_VIEW = Object.freeze({
  fogNear: 3200,
  fogFar: 18000,
  cameraFar: 20000
});

const WEATHER_VISUALS = Object.freeze({
  clear: Object.freeze({
    skyColor: 0x9ed7f2,
    hemisphereSkyColor: 0xe1f3ff,
    hemisphereGroundColor: 0x6f875d,
    hemisphereIntensity: 1.35,
    directionalColor: 0xfff1cf,
    directionalIntensity: 1.75
  }),
  cloudy: Object.freeze({
    skyColor: 0x8b99a6,
    hemisphereSkyColor: 0xc7d1da,
    hemisphereGroundColor: 0x566052,
    hemisphereIntensity: 1,
    directionalColor: 0xe5e9ec,
    directionalIntensity: 0.8
  }),
  fog: Object.freeze({
    skyColor: 0xb6bec0,
    hemisphereSkyColor: 0xd8dfe0,
    hemisphereGroundColor: 0x6c7169,
    hemisphereIntensity: 0.9,
    directionalColor: 0xe6e8e5,
    directionalIntensity: 0.5
  })
});

function finiteWorldView(source) {
  const candidate = source && typeof source === 'object' ? source : {};
  const cameraFar = Number.isFinite(candidate.cameraFar) && candidate.cameraFar >= 1000
    ? candidate.cameraFar
    : FALLBACK_WORLD_VIEW.cameraFar;
  const fogNear = Number.isFinite(candidate.fogNear) && candidate.fogNear > 0 &&
    candidate.fogNear < cameraFar
    ? candidate.fogNear
    : Math.min(FALLBACK_WORLD_VIEW.fogNear, cameraFar * 0.4);
  const fogFar = Number.isFinite(candidate.fogFar) && candidate.fogFar > fogNear &&
    candidate.fogFar < cameraFar
    ? candidate.fogFar
    : Math.max(fogNear + 1, Math.min(FALLBACK_WORLD_VIEW.fogFar, cameraFar - 1));
  return { fogNear, fogFar, cameraFar };
}

export function weatherViewForWorld(value, worldView) {
  const id = normalizeWeatherId(value);
  const base = finiteWorldView(worldView);
  let fogNear = base.fogNear;
  let fogFar = base.fogFar;
  if (id === 'clear') {
    fogNear = Math.min(base.cameraFar - 2, Math.max(base.fogNear * 1.5, base.fogNear + 500));
    fogFar = Math.min(base.cameraFar - 1, Math.max(fogNear + 1, base.fogFar * 1.08));
  } else if (id === 'fog') {
    fogNear = Math.max(120, Math.min(1000, base.fogNear * 0.22));
    fogFar = Math.min(base.cameraFar - 1, Math.max(fogNear + 500, base.fogFar * 0.38));
  }
  return {
    id,
    fogNear,
    fogFar,
    cameraFar: base.cameraFar,
    ...WEATHER_VISUALS[id]
  };
}
