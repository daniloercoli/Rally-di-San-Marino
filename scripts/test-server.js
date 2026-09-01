import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir as osTmpdir } from 'node:os';
import { join as pathJoin } from 'node:path';
import * as THREE from 'three';
import {
  ROAD_CLASSES,
  ROAD_NAME_MAX_LENGTH,
  ROAD_SURFACE_COLORS,
  TRACK_SURFACE_FALLBACK_COLOR,
  UNPAVED_ROAD_COLOR,
  normalizeRoadName,
  normalizeRoadSurface,
  parseMapData,
  parseOsmLanes,
  parseOsmWidth,
  roadColorFromTags,
  roadIsUnpaved,
  roadWidthFromTags
} from '../shared/mapdata.js';
import { ROAD_SHOULDER_WIDTH, RoadIndex } from '../shared/geometry.js';
import {
  BuildingIndex,
  fitBuildingFootprintsToRoads,
  projectBuildingFootprints
} from '../shared/buildings.js';
import { findBuildingGlance, findRoadRecovery, isSafeRoadPose } from '../shared/recovery.js';
import { CAR_FOOTPRINT } from '../shared/vehicle.js';
import {
  CAR_RADIUS,
  DRIVETRAIN,
  PHYSICS,
  SURFACE,
  automaticGear,
  collide,
  createCar,
  directionLockForTick,
  forwardX,
  forwardZ,
  rpmForSpeed,
  simulationSubsteps,
  stepCar
} from '../shared/physics.js';
import {
  CHECKPOINT_CAPTURE_RADIUS_M,
  ROUTE_CHECKPOINT_COUNT,
  RoadGraph,
  advanceCheckpointProgress,
  checkpointCoverage,
  computeComponents,
  createRouteCatalog,
  createRouteDirections,
  createRoutePaceNotes,
  crossedCheckpointIndices,
  pathStartYaw,
  pickRoute,
  resample,
  resampleByCount
} from '../shared/route.js';
import {
  RESULTS_DURATION_MS,
  RACE_PHASE,
  START_DELAY_MAX_MS,
  START_DELAY_MIN_MS,
  START_GREEN_DURATION_MS,
  START_LIGHT_COUNT,
  START_LIGHT_INTERVAL_MS,
  START_LIGHT_LEAD_IN_MS,
  advanceRace,
  createRaceState,
  leaveRace,
  publicRaceState,
  raceElapsedMs,
  randomStartDelayMs,
  rankRaceCars,
  startRace
} from '../shared/race.js';
import {
  createRouteOverlayGeometries,
  routeOverlayKey,
  routeTargetVisibility
} from '../public/src/route-overlay.js';
import { lobbyView, normalizeRouteLobby } from '../public/src/route-lobby.js';
import {
  createRouteSignGroup,
  normalizeRouteDirections,
  normalizeRoutePath,
  updateRouteSignVisibility
} from '../public/src/route-signs.js';
import { CAR_VISUAL, createCarModel } from '../public/src/car-model.js';
import {
  engineTargets,
  localImpactEvent,
  normalizeDrivetrainSnapshot,
  normalizeImpactSnapshot,
  normalizeSurfaceSnapshot,
  selectLocalSnapshot
} from '../public/src/engine-audio.js';
import { surfaceShake } from '../public/src/surface-effects.js';
import {
  TURN_CUE_DURATION_MS,
  advanceTurnCue,
  createTurnCueState,
  turnCueView
} from '../public/src/turn-cue.js';
import {
  checkpointCoverageLabel,
  localCheckpointEvent,
  normalizeCheckpointCoverage
} from '../public/src/checkpoint-stats.js';
import { INITIAL_JOIN_STATE, JOIN_PHASE, joinView, transitionJoin } from '../public/src/join-state.js';
import { readDrivingInput, shouldPreventDrivingKey } from '../public/src/input-state.js';
import { disposeObject3D } from '../public/src/scene-resources.js';
import { startSignalAudioEvent, startSignalView } from '../public/src/start-lights.js';
import {
  advanceStreetBanner,
  createStreetBannerState,
  selectLocalStreetName
} from '../public/src/street-name.js';
import { PLAYER_COLORS, randomPlayerIdentity } from '../public/src/player-identity.js';
import { terrainMeshHeightAt, validateTerrainData } from '../public/src/world-data.js';
import {
  normalizeHandbrakeInput,
  normalizeInputValue,
  normalizePlayerColor,
  parseCliArgs,
  startServer,
  validateProductionPaths
} from '../server.js';
import { io } from 'socket.io-client';

let passed = 0;
function ok(cond, msg) {
  assert.ok(cond, msg);
  passed++;
  console.log('  ok -', msg);
}

function maximumOverlayTerrainError(geometry, heightAt, clearance = 0.25) {
  const positions = geometry?.getAttribute('position');
  if (!positions || positions.count % 3 !== 0) return Infinity;
  const sampleWeights = [
    [1 / 3, 1 / 3, 1 / 3],
    [0.6, 0.2, 0.2],
    [0.2, 0.6, 0.2],
    [0.2, 0.2, 0.6]
  ];
  let maximum = 0;
  for (let index = 0; index < positions.count; index += 3) {
    for (const weights of sampleWeights) {
      let x = 0;
      let y = 0;
      let z = 0;
      for (let vertex = 0; vertex < 3; vertex++) {
        x += positions.getX(index + vertex) * weights[vertex];
        y += positions.getY(index + vertex) * weights[vertex];
        z += positions.getZ(index + vertex) * weights[vertex];
      }
      maximum = Math.max(maximum, Math.abs(y - heightAt(x, z) - clearance));
    }
  }
  return maximum;
}

const trackedSockets = new Set();
const trackedServers = new Set();
const trackedTempDirs = new Set();
let failure = null;

try {
  console.log('== player identity (unit) ==');
  const firstIdentity = randomPlayerIdentity(() => 0);
  const lastIdentity = randomPlayerIdentity(() => 0.999999);
  ok(firstIdentity.name === 'Falco Rosso' && firstIdentity.color === PLAYER_COLORS[0],
    'random identity is deterministic at the lower RNG boundary');
  ok(lastIdentity.name === 'Saetta Turbo' && lastIdentity.color === PLAYER_COLORS.at(-1),
    'random identity is deterministic at the upper RNG boundary');
  let identityDraw = 0;
  const sampledIdentity = randomPlayerIdentity(() => [0.45, 0.7, 0.55][identityDraw++]);
  ok(sampledIdentity.name.length > 0 && sampledIdentity.name.length <= 12 &&
    /^#[0-9a-f]{6}$/.test(sampledIdentity.color),
  'random identity always respects server name and colour syntax');

  console.log('== physics (unit) ==');
  const raw = JSON.parse(readFileSync(new URL('../public/data/roads.json', import.meta.url), 'utf8'));
  const map = parseMapData(raw);
  const index = new RoadIndex(map.roads);
  const road = map.roads[0];
  const rp = road.points[Math.floor(road.points.length / 2)];
  ok(index.query(rp[0], rp[1]).onRoad, 'real map: road point detected on road');
  const surfaceIndex = new RoadIndex([
    { cls: 'primary', width: 10, isTrack: false, points: [[0, -5000], [0, 5000]] },
    { cls: 'track', width: 8, isTrack: true, points: [[30, -5000], [30, 5000]] }
  ]);
  ok(surfaceIndex.query(0, 0).surface === SURFACE.ASPHALT &&
    surfaceIndex.query(5 + ROAD_SHOULDER_WIDTH - 0.01, 0).surface === SURFACE.SHOULDER &&
    surfaceIndex.query(5 + ROAD_SHOULDER_WIDTH + 0.01, 0).surface === SURFACE.GRASS &&
    surfaceIndex.query(30, 0).surface === SURFACE.TRACK &&
    surfaceIndex.query(100, 0).surface === SURFACE.GRASS,
  'RoadIndex classifies asphalt, paved shoulder, OSM track and grass with one authoritative value');
  const namedRoads = map.roads.filter((candidate) => candidate.name);
  ok(namedRoads.length === 1721 && new Set(namedRoads.map((candidate) => candidate.name)).size === 718,
    'real map preserves 1,721 named roads with 718 distinct OSM names');

  const synth = new RoadIndex([{ cls: 'primary', width: 10, isTrack: false, points: [[0, -5000], [0, 5000]] }]);
  const car = createCar(1, 0, 0, 0, '#fff', 'T');
  ok(car.gear === 1 && car.rpm === DRIVETRAIN.idleRpm && car.brakeLevel === 0 && !car.handbrake &&
    car.surface === SURFACE.ASPHALT &&
    car.impactSeq === 0 && car.impactLevel === 0,
  'new car starts on asphalt in first gear at idle with no braking, handbrake or fabricated impact');
  ok(automaticGear(20.1, 1, 1) === 2 && automaticGear(19.8, 2, 1) === 2,
    'automatic gearbox upshifts and keeps hysteresis near the threshold');
  ok(automaticGear(10.9, 2, 0) === 1, 'automatic gearbox downshifts below its hysteresis band');
  ok(rpmForSpeed(20, 2) < rpmForSpeed(20, 1), 'an upshift lowers engine RPM at the same speed');

  let previousGear = car.gear;
  let previousRpm = car.rpm;
  let sawCleanUpshift = false;
  const visitedGears = new Set([car.gear]);
  let reached100At = null;
  let reached200At = null;
  let reached240At = null;
  let reached249At = null;
  let reached250At = null;
  for (let i = 0; i < 1200; i++) {
    stepCar(car, { u: 1, a: 0 }, synth, 0.05);
    if (car.gear > previousGear && car.rpm < previousRpm) sawCleanUpshift = true;
    visitedGears.add(car.gear);
    if (reached100At === null && car.speed * 3.6 >= 100) reached100At = (i + 1) * 0.05;
    if (reached200At === null && car.speed * 3.6 >= 200) reached200At = (i + 1) * 0.05;
    if (reached240At === null && car.speed * 3.6 >= 240) reached240At = (i + 1) * 0.05;
    if (reached249At === null && car.speed * 3.6 >= 249) reached249At = (i + 1) * 0.05;
    if (reached250At === null && car.speed * 3.6 >= 250 - 1e-6) reached250At = (i + 1) * 0.05;
    previousGear = car.gear;
    previousRpm = car.rpm;
  }
  ok(Math.abs(PHYSICS.onRoad.maxSpeed * 3.6 - 250) < 1e-9 &&
    Math.abs(car.speed - PHYSICS.onRoad.maxSpeed) < 0.05,
  'accelerates to the 250 km/h road limit without exceeding it (speed=' +
    (car.speed * 3.6).toFixed(1) + ' km/h)');
  ok(reached100At >= 2.2 && reached100At <= 2.6 && reached200At >= 6.5 && reached200At <= 7.6,
    'moderate arcade acceleration reaches 100/200 km/h in the target windows (' +
      reached100At + 's/' + reached200At + 's)');
  ok(reached240At >= 13 && reached240At <= 22 && reached249At >= 22 && reached249At <= 40 &&
    reached249At - reached200At >= 15 && reached249At - reached240At >= 7,
  'high-speed taper makes 200-249 km/h substantially slower (' +
    reached200At + 's/' + reached240At + 's/' + reached249At + 's)');
  ok(reached250At !== null && reached250At > reached249At && reached250At <= 55,
    'the final kilometre per hour remains reachable only after the long acceleration tail (' +
      reached250At + 's)');
  ok(sawCleanUpshift && visitedGears.size === 5 && car.gear === 5,
    'acceleration uses all five gears with clean automatic upshifts');
  ok(Number.isFinite(car.rpm) && car.rpm >= DRIVETRAIN.idleRpm && car.rpm <= DRIVETRAIN.redlineRpm,
    'engine RPM remains finite and within drivetrain limits');
  ok(car.onRoad, 'stays on straight road');
  function timeToRoadSpeed(targetKmh, dt) {
    const sample = createCar(49, 0, 0, 0, '#fff', 'acceleration dt');
    for (let elapsed = 0; elapsed < 60 - 1e-9; elapsed += dt) {
      stepCar(sample, { u: 1, a: 0 }, synth, dt);
      if (sample.speed * 3.6 >= targetKmh) return elapsed + dt;
    }
    return Infinity;
  }
  const time249At50Ms = timeToRoadSpeed(249, 0.05);
  ok(Math.abs(timeToRoadSpeed(249, 0.025) - time249At50Ms) <= 0.2 &&
    Math.abs(timeToRoadSpeed(249, 0.1) - time249At50Ms) <= 0.2,
  'high-speed acceleration tail remains stable across simulation step sizes');
  const offcar = createCar(2, 500, 0, 0, '#fff', 'T');
  for (let i = 0; i < 300; i++) stepCar(offcar, { u: 1, a: 0 }, synth, 0.05);
  ok(!offcar.onRoad, 'off-road detected');
  ok(Math.abs(PHYSICS.offRoad.maxSpeed * 3.6 - 50) < 1e-9 &&
    Math.abs(offcar.speed - PHYSICS.offRoad.maxSpeed) < 0.05 && offcar.surface === SURFACE.GRASS,
  'grass converges to its 50 km/h limit (speed=' + (offcar.speed * 3.6).toFixed(1) + ' km/h)');
  const trackCar = createCar(46, 30, 0, 0, '#fff', 'track');
  trackCar.surface = SURFACE.TRACK;
  for (let i = 0; i < 600; i++) stepCar(trackCar, { u: 1, a: 0 }, surfaceIndex, 0.05);
  ok(Math.abs(PHYSICS.track.maxSpeed * 3.6 - 110) < 1e-9 &&
    Math.abs(trackCar.speed - PHYSICS.track.maxSpeed) < 0.05 && trackCar.surface === SURFACE.TRACK,
  'dirt track converges to its lower 110 km/h limit (speed=' +
    (trackCar.speed * 3.6).toFixed(1) + ' km/h)');

  const asphaltParityCar = createCar(50, 0, 0, 0, '#fff', 'asphalt parity');
  const shoulderParityCar = createCar(51, 6.2, 0, 0, '#fff', 'shoulder parity');
  shoulderParityCar.surface = SURFACE.SHOULDER;
  shoulderParityCar.onRoad = false;
  asphaltParityCar.speed = 30;
  shoulderParityCar.speed = 30;
  for (let i = 0; i < 20; i++) {
    stepCar(asphaltParityCar, { u: 1, a: 0 }, synth, 0.05);
    stepCar(shoulderParityCar, { u: 1, a: 0 }, synth, 0.05);
  }
  ok(shoulderParityCar.surface === SURFACE.SHOULDER &&
    Math.abs(shoulderParityCar.speed - asphaltParityCar.speed) < 1e-12 &&
    ['maxSpeed', 'reverseMax', 'accel', 'brake', 'handbrake', 'coast', 'overspeedDecel']
      .every((key) => PHYSICS.shoulder[key] === PHYSICS.onRoad[key]),
  'paved shoulder preserves every longitudinal asphalt parameter and resulting speed');
  const asphaltSteerCar = createCar(52, 0, 0, 0, '#fff', 'asphalt steer');
  const shoulderSteerCar = createCar(53, 6.2, 0, 0, '#fff', 'shoulder steer');
  shoulderSteerCar.surface = SURFACE.SHOULDER;
  shoulderSteerCar.onRoad = false;
  asphaltSteerCar.speed = 20;
  shoulderSteerCar.speed = 20;
  stepCar(asphaltSteerCar, { u: 0, a: 1 }, synth, 0.05);
  stepCar(shoulderSteerCar, { u: 0, a: 1 }, synth, 0.05);
  ok(Math.abs(shoulderSteerCar.yaw / asphaltSteerCar.yaw - 0.88) < 1e-12,
    'paved shoulder reduces steering response by exactly twelve percent');

  const offRoadEntry = createCar(20, 500, 0, 0, '#fff', 'Off-road entry');
  offRoadEntry.onRoad = false;
  offRoadEntry.speed = PHYSICS.onRoad.maxSpeed;
  const entrySpeed = offRoadEntry.speed;
  stepCar(offRoadEntry, { u: 1, a: 0 }, synth, 0.05);
  ok(offRoadEntry.speed < entrySpeed && entrySpeed - offRoadEntry.speed < 1 &&
    offRoadEntry.speed > PHYSICS.offRoad.maxSpeed,
  'leaving the road applies a progressive first-tick slowdown instead of an instant cap');
  let previousOffRoadSpeed = offRoadEntry.speed;
  let progressiveOffRoad = true;
  for (let i = 0; i < 300; i++) {
    stepCar(offRoadEntry, { u: 1, a: 0 }, synth, 0.05);
    if (offRoadEntry.speed > previousOffRoadSpeed + 1e-9) progressiveOffRoad = false;
    previousOffRoadSpeed = offRoadEntry.speed;
  }
  ok(progressiveOffRoad && Math.abs(offRoadEntry.speed - PHYSICS.offRoad.maxSpeed) < 0.05,
    'off-road overspeed converges monotonically to the sustainable surface limit');

  function speedAfterOffRoadSecond(dt) {
    const sample = createCar(21, 500, 0, 0, '#fff', 'dt');
    sample.onRoad = false;
    sample.speed = PHYSICS.onRoad.maxSpeed;
    for (let elapsed = 0; elapsed < 1 - 1e-9; elapsed += dt) {
      stepCar(sample, { u: 1, a: 0 }, synth, dt);
    }
    return sample.speed;
  }
  ok(Math.abs(speedAfterOffRoadSecond(0.05) - speedAfterOffRoadSecond(0.1)) < 0.1,
    'progressive off-road slowdown remains stable across simulation dt values');
  function speedAfterTrackSecond(dt) {
    const sample = createCar(47, 30, 0, 0, '#fff', 'track dt');
    sample.surface = SURFACE.TRACK;
    sample.speed = PHYSICS.onRoad.maxSpeed;
    for (let elapsed = 0; elapsed < 1 - 1e-9; elapsed += dt) {
      stepCar(sample, { u: 1, a: 0 }, surfaceIndex, dt);
    }
    return sample.speed;
  }
  const trackEntry = createCar(48, 30, 0, 0, '#fff', 'track entry');
  trackEntry.surface = SURFACE.TRACK;
  trackEntry.speed = PHYSICS.onRoad.maxSpeed;
  const trackEntrySpeed = trackEntry.speed;
  stepCar(trackEntry, { u: 1, a: 0 }, surfaceIndex, 0.05);
  ok(trackEntry.speed < trackEntrySpeed && trackEntrySpeed - trackEntry.speed < 1 &&
    trackEntry.speed > PHYSICS.track.maxSpeed,
  'entering dirt applies progressive slowdown instead of an instant speed cap');
  ok(Math.abs(speedAfterTrackSecond(0.025) - speedAfterTrackSecond(0.1)) < 0.1,
    'progressive dirt slowdown remains stable across simulation dt values');
  ok(CAR_RADIUS * 2 < ROAD_CLASSES.track.width,
    'car collision footprint is narrower than the narrowest road class');

  function coastSpeedAfterSecond(dt) {
    const sample = createCar(37, 0, 0, 0, '#fff', 'coast');
    sample.speed = 200 / 3.6;
    for (let elapsed = 0; elapsed < 1 - 1e-9; elapsed += dt) {
      stepCar(sample, { u: 0, a: 0 }, synth, dt);
    }
    return sample.speed * 3.6;
  }
  const coastAt50Ms = coastSpeedAfterSecond(0.05);
  ok(coastAt50Ms >= 171 && coastAt50Ms <= 173,
    'stronger engine braking leaves about 172 km/h after one second from 200 km/h');
  ok(Math.abs(coastSpeedAfterSecond(0.025) - coastAt50Ms) < 0.1 &&
    Math.abs(coastSpeedAfterSecond(0.1) - coastAt50Ms) < 0.1,
  'engine braking remains stable across simulation step sizes');

  const widthFixture = parseMapData({
    elements: Object.keys(ROAD_CLASSES).map((highway, i) => ({
      type: 'way',
      tags: { highway },
      geometry: [
        { lon: 12.4 + i * 0.001, lat: 43.9 },
        { lon: 12.4005 + i * 0.001, lat: 43.9 }
      ]
    }))
  });
  const expectedWidths = {
    primary: 14,
    primary_link: 14,
    secondary: 13,
    tertiary: 12,
    tertiary_link: 12,
    unclassified: 11,
    residential: 11,
    track: 8
  };
  ok(widthFixture.roads.every((sample) => sample.width === expectedWidths[sample.cls]),
    'every playable OSM highway class uses the extra-wide minimum arcade profile');
  const visualHierarchy = [
    'primary',
    'primary_link',
    'secondary',
    'tertiary',
    'tertiary_link',
    'unclassified',
    'residential',
    'track'
  ];
  ok(visualHierarchy.every((cls, index) => index === visualHierarchy.length - 1 ||
    ROAD_CLASSES[cls].priority > ROAD_CLASSES[visualHierarchy[index + 1]].priority &&
    ROAD_CLASSES[cls].y > ROAD_CLASSES[visualHierarchy[index + 1]].y),
  'road class priority and rendering lift keep major roads above minor roads');
  const trackSurfaceCases = [
    ['asphalt', ROAD_SURFACE_COLORS.asphalt],
    ['gravel', ROAD_SURFACE_COLORS.gravel],
    ['ground', ROAD_SURFACE_COLORS.ground],
    ['unpaved', ROAD_SURFACE_COLORS.unpaved],
    ['mud', ROAD_SURFACE_COLORS.mud],
    ['grass_paver', ROAD_SURFACE_COLORS.grass_paver],
    ['ford', ROAD_SURFACE_COLORS.ford],
    [null, TRACK_SURFACE_FALLBACK_COLOR]
  ];
  const surfaceFixture = parseMapData({ elements: [
    ...trackSurfaceCases.map(([surface], index) => ({
      type: 'way',
      tags: { highway: 'track', ...(surface ? { surface } : {}) },
      geometry: [
        { lon: 12.40, lat: 43.90 + index * 0.001 },
        { lon: 12.401, lat: 43.90 + index * 0.001 }
      ]
    })),
    {
      type: 'way', tags: { highway: 'unclassified', surface: 'compacted' }, geometry: [
        { lon: 12.40, lat: 43.91 }, { lon: 12.401, lat: 43.91 }
      ]
    },
    {
      type: 'way', tags: { highway: 'unclassified' }, geometry: [
        { lon: 12.40, lat: 43.911 }, { lon: 12.401, lat: 43.911 }
      ]
    },
    {
      type: 'way', tags: { highway: 'residential', surface: 'gravel' }, geometry: [
        { lon: 12.40, lat: 43.912 }, { lon: 12.401, lat: 43.912 }
      ]
    },
    {
      type: 'way', tags: { highway: 'residential' }, geometry: [
        { lon: 12.40, lat: 43.913 }, { lon: 12.401, lat: 43.913 }
      ]
    }
  ] });
  ok(trackSurfaceCases.every(([surface, color], index) =>
    surfaceFixture.roads[index].surface === surface &&
    surfaceFixture.roads[index].color === color) &&
    surfaceFixture.roads[0].color === ROAD_CLASSES.track.color,
  'each track surface in the real dataset receives its dedicated visual colour');
  ok(surfaceFixture.roads[1].color === 0xc7c0aa && surfaceFixture.roads[4].color === 0x3c2b24 &&
    surfaceFixture.roads[1].color !== surfaceFixture.roads[4].color &&
    surfaceFixture.roads[7].color !== UNPAVED_ROAD_COLOR,
  'gravel is dirty white, mud is dark brown and a missing track surface uses a neutral fallback');
  ok(surfaceFixture.roads[8].isUnpaved &&
    surfaceFixture.roads[8].color === ROAD_SURFACE_COLORS.compacted &&
    !surfaceFixture.roads[9].isUnpaved &&
    surfaceFixture.roads[9].color === ROAD_CLASSES.unclassified.color,
  'unclassified roads use the surface palette but remain standard grey when the tag is absent');
  ok(surfaceFixture.roads[10].isUnpaved && surfaceFixture.roads[10].color === UNPAVED_ROAD_COLOR &&
    !surfaceFixture.roads[11].isUnpaved && surfaceFixture.roads[11].color === ROAD_CLASSES.residential.color,
  'explicitly unpaved non-track roads retain the generic unpaved palette');
  ok(normalizeRoadSurface(' ASPHALT ') === 'asphalt' && normalizeRoadSurface(42) === null &&
    !roadIsUnpaved({ highway: 'track', surface: 'paved' }) &&
    roadIsUnpaved({ highway: 'unclassified', surface: 'compacted' }) &&
    !roadIsUnpaved({ highway: 'residential' }) &&
    roadColorFromTags({ highway: 'track', surface: 'concrete' }) === ROAD_SURFACE_COLORS.concrete &&
    roadColorFromTags({ highway: 'track', surface: 'unknown' }) === TRACK_SURFACE_FALLBACK_COLOR,
  'surface normalization distinguishes paved, unpaved, common track materials and safe fallbacks');
  ok(parseOsmWidth('10.5 m') === 10.5 && Math.abs(parseOsmWidth("12'") - 3.6576) < 1e-9 &&
    parseOsmWidth('3;4') === null && parseOsmWidth('40') === null,
  'OSM width parser accepts plausible metric/feet values and rejects ambiguous or unsafe values');
  ok(parseOsmLanes('3') === 3 && parseOsmLanes('2;1') === null && parseOsmLanes(9) === null,
    'OSM lanes parser accepts only bounded integer lane counts');
  const explicitRoadWidth = roadWidthFromTags({ width: '20', lanes: '2' }, ROAD_CLASSES.track.width);
  const laneRoadWidth = roadWidthFromTags({ lanes: '4' }, ROAD_CLASSES.residential.width);
  const narrowExactWidth = roadWidthFromTags({ width: '4' }, ROAD_CLASSES.residential.width);
  ok(explicitRoadWidth.width === 20 && explicitRoadWidth.source === 'width' &&
    laneRoadWidth.width === 18 && laneRoadWidth.source === 'lanes' &&
    narrowExactWidth.width === ROAD_CLASSES.residential.width && narrowExactWidth.source === 'class',
  'valid exact and lane widths can widen roads but never undercut the class minimum');
  const widthIndex = new RoadIndex([{
    cls: 'track',
    width: ROAD_CLASSES.track.width,
    isTrack: true,
    points: [[0, -20], [0, 20]]
  }]);
  ok(widthIndex.query(ROAD_CLASSES.track.width / 2 + 0.99, 0).onRoad &&
    !widthIndex.query(ROAD_CLASSES.track.width / 2 + 1.01, 0).onRoad,
  'RoadIndex applies the same class width plus its documented one-metre tolerance');
  ok(normalizeRoadName('  Via   del Test  ') === 'Via del Test' &&
    normalizeRoadName('x'.repeat(ROAD_NAME_MAX_LENGTH + 1)) === null &&
    normalizeRoadName(42) === null,
  'OSM street names are whitespace-normalized and bounded before entering the road index');
  const namedRoadIndex = new RoadIndex([
    { name: 'Via Uno', width: 10, isTrack: false, points: [[0, -20], [0, 20]] },
    { name: 'Via Due', width: 10, isTrack: false, points: [[30, -20], [30, 20]] },
    { width: 10, isTrack: false, points: [[60, -20], [60, 20]] }
  ]);
  ok(namedRoadIndex.query(0, 0).streetName === 'Via Uno' &&
    namedRoadIndex.query(30, 0).streetName === 'Via Due' &&
    namedRoadIndex.query(60, 0).streetName === null &&
    namedRoadIndex.query(90, 0).streetName === null,
  'RoadIndex reports only the nearest on-road named segment and keeps unnamed/off-road positions empty');

  function offRoadSpeedAfterInput(u, speed = PHYSICS.onRoad.maxSpeed) {
    const sample = createCar(22, 500, 0, 0, '#fff', 'brake');
    sample.onRoad = false;
    sample.speed = speed;
    stepCar(sample, { u, a: 0 }, synth, 0.05);
    return sample.speed;
  }
  const releasedOffRoadSpeed = offRoadSpeedAfterInput(0);
  const lightBrakeOffRoadSpeed = offRoadSpeedAfterInput(-0.1);
  const fullBrakeOffRoadSpeed = offRoadSpeedAfterInput(-1);
  ok(lightBrakeOffRoadSpeed <= releasedOffRoadSpeed && fullBrakeOffRoadSpeed < lightBrakeOffRoadSpeed,
    'off-road braking never slows less than release and remains monotonic with pedal input');
  const releasedAtOffRoadLimit = offRoadSpeedAfterInput(0, PHYSICS.offRoad.maxSpeed);
  const lightBrakeAtOffRoadLimit = offRoadSpeedAfterInput(-0.1, PHYSICS.offRoad.maxSpeed);
  ok(lightBrakeAtOffRoadLimit <= releasedAtOffRoadLimit,
    'light braking at the off-road limit never slows less than passive coast');

  const stear = createCar(3, 0, 50, 0, '#fff', 'T');
  for (let i = 0; i < 80; i++) stepCar(stear, { u: 1, a: 0 }, synth, 0.05);
  const y0 = stear.yaw;
  for (let i = 0; i < 40; i++) stepCar(stear, { u: 1, a: 1 }, synth, 0.05);
  ok(stear.yaw - y0 > 0.3, 'steering turns the car (dyaw=' + (stear.yaw - y0).toFixed(2) + ')');

  const brake = createCar(4, 0, 0, 0, '#fff', 'T');
  for (let i = 0; i < 80; i++) stepCar(brake, { u: 1, a: 0 }, synth, 0.05);
  const speedBeforeBrake = brake.speed;
  stepCar(brake, { u: -1, a: 0 }, synth, 0.05);
  ok(brake.speed < speedBeforeBrake && brake.speed > 0 && brake.brakeLevel === 1,
    'braking decelerates a moving car and exposes brake intensity');
  for (let i = 0; i < 200 && brake.speed > 0; i++) stepCar(brake, { u: -1, a: 0 }, synth, 0.05);
  ok(brake.speed === 0 && brake.gear === 1, 'braking reaches zero without crossing into reverse in the same tick');
  stepCar(brake, { u: -1, a: 0 }, synth, 0.05);
  ok(brake.speed < 0 && brake.gear === -1, 'reverse engages on the tick after the stop');
  for (let i = 0; i < 200; i++) stepCar(brake, { u: -1, a: 0 }, synth, 0.05);
  ok(Math.abs(brake.speed + PHYSICS.onRoad.reverseMax) < 0.01, 'reverse speed reaches configured limit (speed=' + brake.speed.toFixed(1) + ')');
  stepCar(brake, { u: 0, a: 0 }, synth, 0.05);
  ok(brake.brakeLevel === 0, 'brake intensity returns to zero when the pedal is released');

  function serviceBrakeStop(startKmh, dt, onRoad = true) {
    const sample = createCar(45, onRoad ? 0 : 500, 0, 0, '#fff', 'service brake');
    sample.onRoad = onRoad;
    sample.speed = startKmh / 3.6;
    let elapsed = 0;
    while (sample.speed > 0 && elapsed < 10) {
      stepCar(sample, { u: -1, a: 0, h: false }, synth, dt,
        directionLockForTick(sample.speed, -1));
      elapsed += dt;
    }
    return {
      time: elapsed,
      distance: Math.hypot(sample.x - (onRoad ? 0 : 500), sample.z),
      speed: sample.speed,
      gear: sample.gear,
      brakeLevel: sample.brakeLevel
    };
  }

  const stop100 = serviceBrakeStop(100, 0.01);
  const stop200 = serviceBrakeStop(200, 0.01);
  ok(stop100.time <= 1.2 && stop100.distance <= 17 &&
    stop100.time < 1.55 * 0.8 && stop100.distance < 21.29 * 0.8,
  'stronger service brake stops from 100 km/h at least 20% before the measured baseline (' +
    stop100.time.toFixed(2) + 's/' + stop100.distance.toFixed(2) + 'm)');
  ok(stop200.time <= 2.4 && stop200.distance <= 66 &&
    stop200.time < 3.09 * 0.8 && stop200.distance < 85.46 * 0.8,
  'stronger service brake stops from 200 km/h at least 20% before the measured baseline (' +
    stop200.time.toFixed(2) + 's/' + stop200.distance.toFixed(2) + 'm)');
  ok(stop100.speed === 0 && stop100.gear === 1 && stop100.brakeLevel === 1 &&
    stop200.speed === 0 && stop200.gear === 1 && stop200.brakeLevel === 1,
  'measured service-brake stops preserve zero crossing, forward gear and authoritative brake level');
  const stop200At25Ms = serviceBrakeStop(200, 0.025);
  const stop200At50Ms = serviceBrakeStop(200, 0.05);
  const stop200At100Ms = serviceBrakeStop(200, 0.1);
  ok(Math.max(stop200At25Ms.time, stop200At50Ms.time, stop200At100Ms.time) -
    Math.min(stop200At25Ms.time, stop200At50Ms.time, stop200At100Ms.time) <= 0.1 &&
    Math.max(stop200At25Ms.distance, stop200At50Ms.distance, stop200At100Ms.distance) -
    Math.min(stop200At25Ms.distance, stop200At50Ms.distance, stop200At100Ms.distance) < 3,
  'service-brake stopping time and distance remain stable across simulation step sizes');
  const offRoadStop = serviceBrakeStop(PHYSICS.offRoad.maxSpeed * 3.6, 0.01, false);
  ok(offRoadStop.time <= 0.95 && offRoadStop.distance <= 6.5 && offRoadStop.speed === 0,
    'stronger off-road service brake stops the sustainable surface speed promptly (' +
      offRoadStop.time.toFixed(2) + 's/' + offRoadStop.distance.toFixed(2) + 'm)');

  const reverseBrake = createCar(5, 0, 0, 0, '#fff', 'T');
  reverseBrake.speed = -0.2;
  reverseBrake.gear = -1;
  stepCar(reverseBrake, { u: 1, a: 0 }, synth, 1);
  ok(reverseBrake.speed === 0 && reverseBrake.gear === -1 && reverseBrake.brakeLevel === 1,
    'forward input brakes reverse motion without crossing zero');
  stepCar(reverseBrake, { u: 1, a: 0 }, synth, 0.05);
  ok(reverseBrake.speed > 0 && reverseBrake.gear === 1,
    'forward gear engages on the tick after reverse motion stops');

  const mediumSteer = createCar(6, 0, 0, 0, '#fff', 'T');
  const highSteer = createCar(7, 0, 0, 0, '#fff', 'T');
  mediumSteer.speed = 8;
  highSteer.speed = 25;
  stepCar(mediumSteer, { u: 0, a: 1 }, synth, 0.05);
  stepCar(highSteer, { u: 0, a: 1 }, synth, 0.05);
  ok(mediumSteer.yaw > highSteer.yaw, 'steering is attenuated at high speed');
  const topSpeedSteer = createCar(8, 0, 0, 0, '#fff', 'T');
  topSpeedSteer.speed = PHYSICS.onRoad.maxSpeed * 0.95;
  stepCar(topSpeedSteer, { u: 0, a: 1 }, synth, 0.05);
  ok(topSpeedSteer.yaw > 0 && topSpeedSteer.yaw < highSteer.yaw,
    'steering remains responsive but further attenuated near top speed');

  const releasedHandbrakeSample = createCar(38, 0, 0, 0, '#fff', 'released');
  const activeHandbrakeSample = createCar(39, 0, 0, 0, '#fff', 'handbrake');
  releasedHandbrakeSample.speed = 30;
  activeHandbrakeSample.speed = 30;
  stepCar(releasedHandbrakeSample, { u: 0, a: 0, h: false }, synth, 0.05);
  stepCar(activeHandbrakeSample, { u: 0, a: 0, h: true }, synth, 0.05);
  ok(activeHandbrakeSample.speed < releasedHandbrakeSample.speed &&
    activeHandbrakeSample.handbrake && activeHandbrakeSample.brakeLevel === 1,
  'handbrake decelerates more than release and exposes authoritative braking state');
  const normalTurn = createCar(40, 0, 0, 0, '#fff', 'normal turn');
  const handbrakeTurn = createCar(41, 0, 0, 0, '#fff', 'handbrake turn');
  const straightHandbrake = createCar(42, 0, 0, 0, '#fff', 'straight handbrake');
  normalTurn.speed = 20;
  handbrakeTurn.speed = 20;
  straightHandbrake.speed = 20;
  stepCar(normalTurn, { u: 0, a: 1, h: false }, synth, 0.1);
  stepCar(handbrakeTurn, { u: 0, a: 1, h: true }, synth, 0.1);
  stepCar(straightHandbrake, { u: 0, a: 0, h: true }, synth, 0.1);
  ok(Number.isFinite(handbrakeTurn.yaw) && handbrakeTurn.yaw > normalTurn.yaw,
    'handbrake increases finite yaw response when steering');
  ok(straightHandbrake.yaw === 0, 'handbrake without steering cannot fabricate rotation');
  const reverseHandbrake = createCar(43, 0, 0, 0, '#fff', 'reverse handbrake');
  reverseHandbrake.speed = -0.2;
  reverseHandbrake.gear = -1;
  stepCar(reverseHandbrake, { u: 1, a: 0, h: true }, synth, 1);
  ok(reverseHandbrake.speed === 0 && reverseHandbrake.gear === -1,
    'handbrake reaches zero without crossing from reverse into forward motion');
  function handbrakeSpeedAfterSecond(dt) {
    const sample = createCar(44, 0, 0, 0, '#fff', 'handbrake dt');
    sample.speed = 30;
    for (let elapsed = 0; elapsed < 1 - 1e-9; elapsed += dt) {
      stepCar(sample, { u: 0, a: 0, h: true }, synth, dt);
    }
    return sample.speed;
  }
  const handbrakeAt50Ms = handbrakeSpeedAfterSecond(0.05);
  ok(Math.abs(handbrakeSpeedAfterSecond(0.025) - handbrakeAt50Ms) < 0.1 &&
    Math.abs(handbrakeSpeedAfterSecond(0.1) - handbrakeAt50Ms) < 0.1,
  'handbrake deceleration remains stable across simulation step sizes');

  const cA = createCar(10, 0, 1, 0, '#fff', 'A');
  const cB = createCar(11, 0, -1, Math.PI, '#fff', 'B');
  cA.speed = 10;
  cA.brakeLevel = 1;
  cB.speed = 10;
  collide([cA, cB], new Map([[10, { u: -1 }], [11, { u: 0 }]]));
  ok(cA.z > 1 && cB.z < -1, 'collide: head-on cars pushed apart (A.z=' + cA.z.toFixed(2) + ', B.z=' + cB.z.toFixed(2) + ')');
  ok(cA.speed < 0 && cA.gear === -1 && cA.brakeLevel === 0,
    'collision resynchronizes gear and braking against authoritative input');
  const cC = createCar(12, 100, 0, 0, '#fff', 'C');
  const cD = createCar(13, -100, 0, 0, '#fff', 'D');
  collide([cC, cD]);
  ok(cC.x === 100 && cD.x === -100, 'collide: distant cars unchanged');

  const thresholdNearA = createCar(14, 0, 0, 0, '#fff', 'near A');
  const thresholdNearB = createCar(15, CAR_RADIUS * 2 - 0.01, 0, 0, '#fff', 'near B');
  collide([thresholdNearA, thresholdNearB]);
  ok(Math.abs(Math.hypot(thresholdNearB.x - thresholdNearA.x, thresholdNearB.z - thresholdNearA.z) -
    CAR_RADIUS * 2) < 1e-9, 'collision separates cars just inside the exact radius threshold');
  const thresholdFarA = createCar(16, 0, 0, 0, '#fff', 'far A');
  const thresholdFarB = createCar(17, CAR_RADIUS * 2 + 0.01, 0, 0, '#fff', 'far B');
  collide([thresholdFarA, thresholdFarB]);
  ok(thresholdFarA.x === 0 && thresholdFarB.x === CAR_RADIUS * 2 + 0.01,
    'collision leaves cars just outside the radius threshold unchanged');

  const angledA = createCar(18, 0, 0, Math.PI / 2, '#fff', 'angled A');
  const angledB = createCar(19, CAR_RADIUS * 2 - 0.1, 0, Math.PI / 6, '#fff', 'angled B');
  angledA.speed = PHYSICS.onRoad.maxSpeed;
  angledB.speed = PHYSICS.onRoad.maxSpeed;
  collide([angledA, angledB]);
  ok([angledA, angledB].every((sample) =>
    sample.speed <= PHYSICS.onRoad.maxSpeed && sample.speed >= -PHYSICS.onRoad.reverseMax),
  'collision impulses cannot publish speed outside authoritative global limits');

  const highSpeedA = createCar(23, 0, 5.4, 0, '#fff', 'high speed A');
  const highSpeedB = createCar(24, 0, -5.4, Math.PI, '#fff', 'high speed B');
  highSpeedA.speed = PHYSICS.onRoad.maxSpeed;
  highSpeedB.speed = PHYSICS.onRoad.maxSpeed;
  const highSpeedInputs = new Map([[23, { u: 1 }], [24, { u: 1 }]]);
  const highSpeedSubsteps = simulationSubsteps(0.05);
  for (let tick = 0; tick < 2; tick++) {
    for (let substep = 0; substep < highSpeedSubsteps; substep++) {
      stepCar(highSpeedA, highSpeedInputs.get(23), synth, 0.05 / highSpeedSubsteps);
      stepCar(highSpeedB, highSpeedInputs.get(24), synth, 0.05 / highSpeedSubsteps);
      collide([highSpeedA, highSpeedB], highSpeedInputs);
    }
  }
  ok(highSpeedSubsteps >= 2 && highSpeedA.z > highSpeedB.z,
    'server-sized physics substeps prevent head-on tunnelling at top speed');

  const overlappingA = createCar(25, 0, 1.725, 0, '#fff', 'overlap A');
  const overlappingB = createCar(26, 0, -1.725, Math.PI, '#fff', 'overlap B');
  overlappingA.speed = PHYSICS.onRoad.maxSpeed;
  overlappingB.speed = PHYSICS.onRoad.maxSpeed;
  const overlappingInputs = new Map([[25, { u: 1 }], [26, { u: 1 }]]);
  ok(Math.hypot(overlappingA.x - overlappingB.x, overlappingA.z - overlappingB.z) < CAR_RADIUS * 2,
    'overlap regression starts with cars inside the collision footprint');
  collide([overlappingA, overlappingB], overlappingInputs);
  for (let substep = 0; substep < highSpeedSubsteps; substep++) {
    stepCar(overlappingA, overlappingInputs.get(25), synth, 0.05 / highSpeedSubsteps);
    stepCar(overlappingB, overlappingInputs.get(26), synth, 0.05 / highSpeedSubsteps);
    collide([overlappingA, overlappingB], overlappingInputs);
  }
  ok(overlappingA.z > overlappingB.z,
    'pre-step collision resolution prevents initially overlapping cars from swapping sides');

  const glancingA = createCar(27, -1.8, 0.868, 0, '#fff', 'glancing A');
  const glancingB = createCar(28, 1.8, -0.868, Math.PI, '#fff', 'glancing B');
  glancingA.speed = PHYSICS.onRoad.maxSpeed;
  glancingB.speed = PHYSICS.onRoad.maxSpeed;
  const glancingInputs = new Map([[27, { u: 1 }], [28, { u: 1 }]]);
  const glancingPrevious = new Map([
    [27, { x: glancingA.x, z: glancingA.z }],
    [28, { x: glancingB.x, z: glancingB.z }]
  ]);
  stepCar(glancingA, glancingInputs.get(27), synth, 0.025);
  stepCar(glancingB, glancingInputs.get(28), synth, 0.025);
  collide([glancingA, glancingB], glancingInputs, glancingPrevious);
  const glancingDx = glancingB.x - glancingA.x;
  const glancingDz = glancingB.z - glancingA.z;
  const glancingDistance = Math.hypot(glancingDx, glancingDz);
  const glancingNx = glancingDx / glancingDistance;
  const glancingNz = glancingDz / glancingDistance;
  const glancingRelativeNormalSpeed =
    (Math.sin(glancingB.yaw) * glancingB.speed - Math.sin(glancingA.yaw) * glancingA.speed) * glancingNx +
    (-Math.cos(glancingB.yaw) * glancingB.speed + Math.cos(glancingA.yaw) * glancingA.speed) * glancingNz;
  ok(glancingA.z > glancingB.z && glancingDistance >= CAR_RADIUS * 2 - 1e-9,
    'swept collision catches a high-speed glancing contact between sampled positions');
  ok(glancingRelativeNormalSpeed >= -1e-9,
    'glancing collision response is separating along the contact normal');
  const glancingSecondPrevious = new Map([
    [27, { x: glancingA.x, z: glancingA.z }],
    [28, { x: glancingB.x, z: glancingB.z }]
  ]);
  stepCar(glancingA, glancingInputs.get(27), synth, 0.025);
  stepCar(glancingB, glancingInputs.get(28), synth, 0.025);
  collide([glancingA, glancingB], glancingInputs, glancingSecondPrevious);
  ok(glancingA.z > glancingB.z,
    'glancing cars remain on their original sides after the next substep');

  const substepBrake = createCar(29, 0, 0, 0, '#fff', 'substep brake');
  substepBrake.speed = 0.1;
  const substepBrakeInput = { u: -1, a: 0 };
  const substepBrakeInputBefore = { ...substepBrakeInput };
  const substepBrakeLock = directionLockForTick(substepBrake.speed, substepBrakeInput.u);
  for (let substep = 0; substep < highSpeedSubsteps; substep++) {
    stepCar(substepBrake, substepBrakeInput, synth, 0.05 / highSpeedSubsteps, substepBrakeLock);
  }
  ok(substepBrake.speed === 0 && substepBrake.gear === 1 && substepBrake.brakeLevel === 1,
    'server substeps cannot cross from forward motion into reverse within one tick');
  assert.deepStrictEqual(substepBrakeInput, substepBrakeInputBefore, 'substeps do not mutate stored input');
  const nextTickLock = directionLockForTick(substepBrake.speed, substepBrakeInput.u);
  stepCar(substepBrake, substepBrakeInput, synth, 0.025, nextTickLock);
  ok(substepBrake.speed < 0 && substepBrake.gear === -1,
    'reverse can engage on the server tick after braking reaches zero');

  const reverseSubstepBrake = createCar(32, 0, 0, 0, '#fff', 'reverse substep brake');
  reverseSubstepBrake.speed = -0.1;
  reverseSubstepBrake.gear = -1;
  const reverseSubstepInput = { u: 1, a: 0 };
  const reverseSubstepLock = directionLockForTick(reverseSubstepBrake.speed, reverseSubstepInput.u);
  for (let substep = 0; substep < highSpeedSubsteps; substep++) {
    stepCar(reverseSubstepBrake, reverseSubstepInput, synth, 0.05 / highSpeedSubsteps, reverseSubstepLock);
  }
  ok(reverseSubstepBrake.speed === 0 && reverseSubstepBrake.gear === -1 &&
    reverseSubstepBrake.brakeLevel === 1,
  'server substeps symmetrically hold reverse braking at zero for the rest of the tick');
  stepCar(reverseSubstepBrake, reverseSubstepInput, synth, 0.025,
    directionLockForTick(reverseSubstepBrake.speed, reverseSubstepInput.u));
  ok(reverseSubstepBrake.speed > 0 && reverseSubstepBrake.gear === 1,
    'forward motion can engage on the tick after reverse braking reaches zero');

  const coincidentA = createCar(30, 0, 0, 0, '#fff', 'coincident A');
  const coincidentB = createCar(31, 0, 0, Math.PI, '#fff', 'coincident B');
  collide([coincidentA, coincidentB]);
  ok([coincidentA.x, coincidentA.z, coincidentB.x, coincidentB.z].every(Number.isFinite) &&
    Math.abs(Math.hypot(coincidentB.x - coincidentA.x, coincidentB.z - coincidentA.z) -
      CAR_RADIUS * 2) < 1e-9,
  'coincident car centers separate deterministically without non-finite coordinates');

  const tangentOffset = PHYSICS.onRoad.maxSpeed * 0.025 / 2;
  const tangentA = createCar(33, -CAR_RADIUS, tangentOffset, 0, '#fff', 'tangent A');
  const tangentB = createCar(34, CAR_RADIUS, -tangentOffset, Math.PI, '#fff', 'tangent B');
  tangentA.speed = PHYSICS.onRoad.maxSpeed;
  tangentB.speed = PHYSICS.onRoad.maxSpeed;
  const tangentPrevious = new Map([
    [33, { x: tangentA.x, z: tangentA.z }],
    [34, { x: tangentB.x, z: tangentB.z }]
  ]);
  stepCar(tangentA, { u: 1, a: 0 }, synth, 0.025);
  stepCar(tangentB, { u: 1, a: 0 }, synth, 0.025);
  const tangentEnd = { az: tangentA.z, bz: tangentB.z, speedA: tangentA.speed, speedB: tangentB.speed };
  collide([tangentA, tangentB], new Map(), tangentPrevious);
  ok(tangentA.z === tangentEnd.az && tangentB.z === tangentEnd.bz &&
    tangentA.speed === tangentEnd.speedA && tangentB.speed === tangentEnd.speedB,
  'an exact swept tangency remains a non-collision like the discrete radius threshold');

  const asymmetricA = createCar(35, 0, 0, Math.PI / 6, '#fff', 'asymmetric A');
  const asymmetricB = createCar(36, CAR_RADIUS * 2 - 0.001, 0, 7 * Math.PI / 6, '#fff', 'asymmetric B');
  asymmetricB.speed = 40;
  collide([asymmetricA, asymmetricB]);
  const asymmetricNormalSpeed = Math.sin(asymmetricB.yaw) * asymmetricB.speed -
    Math.sin(asymmetricA.yaw) * asymmetricA.speed;
  ok(asymmetricNormalSpeed >= -1e-9,
    'post-clamp collision response cannot remain convergent in an asymmetric impact');

  console.log('== building recovery (unit) ==');
  const recoveryRoadIndex = new RoadIndex([{
    cls: 'residential', width: 7, isTrack: false, points: [[0, -50], [0, 50]]
  }]);
  const wallFootprint = {
    id: 'wall',
    outer: [[-6, -1], [6, -1], [6, 1], [-6, 1]],
    holes: [],
    bounds: { minX: -6, maxX: 6, minZ: -1, maxZ: 1 }
  };
  const wallIndex = new BuildingIndex([wallFootprint], 10);
  const recoveredPose = findRoadRecovery(
    recoveryRoadIndex,
    wallIndex,
    { x: 0, z: 0, yaw: 0 },
    { x: 0, z: 8, yaw: 0 }
  );
  ok(recoveredPose && isSafeRoadPose(recoveryRoadIndex, wallIndex, recoveredPose) &&
    recoveryRoadIndex.query(recoveredPose.x, recoveredPose.z).onRoad,
  'building recovery chooses a deterministic road pose outside the footprint');
  const projectedRoad = recoveryRoadIndex.nearestPoints(4, 12, 1)[0];
  ok(projectedRoad.x === 0 && projectedRoad.z === 12 && Number.isFinite(projectedRoad.yaw),
    'RoadIndex exposes a finite nearest centreline projection and tangent for recovery');
  const fallbackRoadIndex = {
    nearestPoints: () => [],
    query: (x) => ({ onRoad: x === 50 })
  };
  const fallbackBuildingIndex = { intersectsObb: (pose) => pose.x !== 50 };
  const fallbackPose = findRoadRecovery(
    fallbackRoadIndex,
    fallbackBuildingIndex,
    { x: 0, z: 0, yaw: 0 },
    { x: 50, z: 5, yaw: 0 }
  );
  ok(fallbackPose?.x === 50 && fallbackPose.z === 5,
    'recovery falls back to the last validated road pose when no local candidate is free');
  const cornerRoadIndex = new RoadIndex([{
    cls: 'residential', width: 20, isTrack: false, points: [[-30, 2], [30, 2]]
  }]);
  const cornerBuilding = {
    id: 'corner',
    outer: [[0, -8], [10, -8], [10, 0], [0, 0]],
    holes: []
  };
  const cornerBuildingIndex = new BuildingIndex([cornerBuilding], 10);
  const buildingGlancePrevious = { x: -2, z: 2, yaw: 1.3, speed: 12 };
  const buildingGlanceAttempt = { x: -0.5, z: 0.4, yaw: 1.3, speed: 12 };
  const glancingBuilding = cornerBuildingIndex.findSweptObbCollision(
    buildingGlancePrevious,
    buildingGlanceAttempt
  );
  const glancingRecovery = findBuildingGlance(
    cornerRoadIndex,
    cornerBuildingIndex,
    glancingBuilding,
    buildingGlancePrevious,
    buildingGlanceAttempt
  );
  ok(glancingBuilding && glancingRecovery?.speed > 0 &&
    glancingRecovery.x > buildingGlancePrevious.x &&
    isSafeRoadPose(cornerRoadIndex, cornerBuildingIndex, glancingRecovery, 0.05),
  'a glancing corner contact becomes a safe tangent pose with retained forward speed');
  const afterGlance = {
    ...glancingRecovery,
    x: glancingRecovery.x + Math.sin(glancingRecovery.yaw) * 0.5,
    z: glancingRecovery.z - Math.cos(glancingRecovery.yaw) * 0.5
  };
  ok(isSafeRoadPose(cornerRoadIndex, cornerBuildingIndex, afterGlance, 0),
    'the tangent response can continue beyond the corner without an immediate collision loop');
  const frontalPrevious = { x: 5, z: 2.2, yaw: 0, speed: 12 };
  const frontalAttempt = { x: 5, z: -0.4, yaw: 0, speed: 12 };
  const frontalBuilding = cornerBuildingIndex.findSweptObbCollision(frontalPrevious, frontalAttempt);
  ok(frontalBuilding && findBuildingGlance(
    cornerRoadIndex,
    cornerBuildingIndex,
    frontalBuilding,
    frontalPrevious,
    frontalAttempt
  ) === null, 'a frontal facade impact is not misclassified as a glancing corner contact');

  console.log('== route (unit) ==');
  const graph = new RoadGraph(map.roads);
  const rawBuildings = JSON.parse(readFileSync(new URL('../public/data/buildings.json', import.meta.url), 'utf8'));
  const projectedBuildingFootprints = projectBuildingFootprints(rawBuildings, map.proj, map.bbox);
  const buildingFootprints = fitBuildingFootprintsToRoads(projectedBuildingFootprints, index).footprints;
  const realBuildingIndex = new BuildingIndex(buildingFootprints);
  const route = pickRoute(graph, map, {
    directionOptions: {
      isPositionBlocked: (x, z) => realBuildingIndex.intersectsCircle(x, z, 1.2)
    }
  });
  ok(ROUTE_CHECKPOINT_COUNT === 10 && route.checkpoints.length === ROUTE_CHECKPOINT_COUNT,
    'real route exposes exactly ten evenly distributed checkpoints');
  ok(CHECKPOINT_CAPTURE_RADIUS_M === 18 && JSON.stringify(crossedCheckpointIndices(
    [[0, 0], [120, 0]],
    { x: 0, z: 15 },
    { x: 120, z: 15 },
    CHECKPOINT_CAPTURE_RADIUS_M
  )) === JSON.stringify([1]),
  'the authoritative 18 m radius captures a car passing near a checkpoint without entering its ring');
  const sweptCheckpoints = [[0, 0], [10, 0], [20, 0]];
  ok(advanceCheckpointProgress([[0, 0], [10, 0], [50, 0]], 0,
    { x: 2, z: 0 }, { x: 18, z: 0 }, 7) === 1,
    'checkpoint progress detects a crossing whose endpoint samples both remain outside the radius');
  ok(advanceCheckpointProgress(sweptCheckpoints, 0, { x: 0, z: 7 }, { x: 20, z: 7 }, 7) === 2,
    'checkpoint progress accepts exact tangency and multiple consecutive targets in travel order');
  ok(advanceCheckpointProgress(sweptCheckpoints, 0, { x: 25, z: 0 }, { x: 5, z: 0 }, 7) === 1,
    'checkpoint progress cannot consume a later target crossed before the required one');
  ok(advanceCheckpointProgress(sweptCheckpoints, 0, { x: Number.NaN, z: 0 }, { x: 10, z: 0 }, 7) === 0 &&
    advanceCheckpointProgress([[0, 0], [Number.NaN, 0]], 0, { x: 0, z: 0 }, { x: 10, z: 0 }, 7) === 0,
  'checkpoint progress rejects non-finite poses and checkpoint coordinates without fabricating progress');
  ok(JSON.stringify(crossedCheckpointIndices([[0, 0], [10, 10], [20, 0]],
    { x: 12, z: 0 }, { x: 28, z: 0 }, 7)) === JSON.stringify([2]),
  'independent checkpoint detection records the finish even when an intermediate target was skipped');
  ok(JSON.stringify(crossedCheckpointIndices(sweptCheckpoints,
    { x: 0, z: 7 }, { x: 20, z: 7 }, 7)) === JSON.stringify([1, 2]),
  'independent checkpoint detection accepts tangency and returns every crossed target once');
  ok(crossedCheckpointIndices([[0, 0], [Number.NaN, 0]],
    { x: 0, z: 0 }, { x: 20, z: 0 }, 7).length === 0 &&
    crossedCheckpointIndices(sweptCheckpoints,
      { x: 0, z: 0 }, { x: Infinity, z: 0 }, 7).length === 0,
  'independent checkpoint detection rejects malformed routes and poses without partial results');
  const skippedCoverage = checkpointCoverage([0, 2, 2], 3);
  ok(JSON.stringify(skippedCoverage) === JSON.stringify({
    checkpointsHit: 2,
    checkpointsMissed: 1,
    checkpointsTotal: 3,
    checkpointsHitPercent: 66.7,
    checkpointsMissedPercent: 33.3
  }), 'checkpoint coverage deduplicates hits and reports complementary hit/missed percentages');
  ok(checkpointCoverage(new Set([0, 3]), 3) === null && checkpointCoverage(null, 3) === null,
    'checkpoint coverage rejects invalid indices and containers instead of inventing a result');
  const normalizedCoverage = normalizeCheckpointCoverage(skippedCoverage, 3);
  ok(normalizedCoverage?.checkpointsHitPercent === 66.7 &&
    normalizedCoverage.checkpointsMissedPercent === 33.3 &&
    checkpointCoverageLabel(normalizedCoverage) === 'CP 66,7% segnati · 33,3% mancati (2/3)',
  'client formats both percentages and absolute checkpoint counts for a participant');
  ok(normalizeCheckpointCoverage({ ...skippedCoverage, checkpointsMissed: 0 }, 3) === null &&
    normalizeCheckpointCoverage({ ...skippedCoverage, checkpointsHitPercent: Infinity }, 3) === null &&
    checkpointCoverageLabel(null) === '',
  'client rejects inconsistent or non-finite checkpoint statistics without fabricating percentages');
  ok(JSON.stringify(routeTargetVisibility(0, 3, false)) === JSON.stringify({ checkpoint: true, finish: true }) &&
    JSON.stringify(routeTargetVisibility(1, 3, false)) === JSON.stringify({ checkpoint: false, finish: true }) &&
    JSON.stringify(routeTargetVisibility(2, 3, true)) === JSON.stringify({ checkpoint: false, finish: false }),
  'the red finish target remains active while intermediate checkpoints are optional');
  const routeCatalog = createRouteCatalog(graph, map, { maxRoutes: 8 });
  ok(routeCatalog.length === 8 && routeCatalog[0].id === 'route-1' &&
    routeCatalog.every((candidate) => candidate.checkpoints.length === ROUTE_CHECKPOINT_COUNT &&
      candidate.lengthM > 0 &&
      candidate.checkpoints[0][0] === candidate.start.x &&
      candidate.checkpoints[0][1] === candidate.start.z &&
      candidate.checkpoints[ROUTE_CHECKPOINT_COUNT - 1][0] === candidate.end.x &&
      candidate.checkpoints[ROUTE_CHECKPOINT_COUNT - 1][1] === candidate.end.z),
  'real map exposes a deterministic catalog whose routes all have exactly ten checkpoints');
  ok(routeCatalog.every((candidate) => {
    const [start, next] = candidate.path;
    const dx = next[0] - start[0];
    const dz = next[1] - start[1];
    const length = Math.hypot(dx, dz);
    const yaw = pathStartYaw(candidate.path, candidate.checkpoints);
    return length > 0 && (forwardX(yaw) * dx + forwardZ(yaw) * dz) / length > 0.999999;
  }), 'every selectable route derives its start yaw from the first movement segment');
  ok(pathStartYaw([[0, 0], [0, 0]], [[0, 0], [10, 0]]) === Math.PI / 2 &&
    pathStartYaw(null, null, Number.NaN) === 0,
  'start yaw uses a deterministic checkpoint and zero fallback for degenerate paths');
  ok(routeCatalog[0].start.name === route.start.name && routeCatalog[0].end.name === route.end.name,
    'the first catalog entry preserves the deterministic default route');
  ok(route.path.length > route.checkpoints.length && route.path.length > 500,
    'route preserves the denser A* path separately from race checkpoints');
  ok(route.directions.length >= 20 && route.directions.length <= 150 &&
    new Set(route.directions.map((marker) => marker.turn)).size === 3,
  'real route emits a plausible ordered mix of left, right and straight junction signs');
  ok(route.directions.every((marker) => index.query(marker.x, marker.z).clearance >= 1.1),
    'every real-route sign center stays outside the rendered and physical carriageway');
  ok(route.directions.every((marker) => !realBuildingIndex.intersectsCircle(marker.x, marker.z, 1.2)),
    'every real-route sign and panel stays outside visible building footprints');
  const checkpointYaw = (checkpoint) => {
    const before = route.checkpoints[Math.max(0, checkpoint - 1)];
    const after = route.checkpoints[Math.min(route.checkpoints.length - 1, checkpoint + 1)];
    return Math.atan2(after[0] - before[0], -(after[1] - before[1]));
  };
  ok(route.checkpoints.every((checkpoint, index) => !realBuildingIndex.intersectsObb({
    x: checkpoint[0],
    z: checkpoint[1],
    yaw: checkpointYaw(index)
  })), 'all ten checkpoint poses remain outside fitted building footprints');
  const finishCheckpoint = route.checkpoints.length - 1;
  const finishPoint = route.checkpoints[finishCheckpoint];
  const finishPose = { x: finishPoint[0], z: finishPoint[1], yaw: checkpointYaw(finishCheckpoint) };
  ok(index.query(finishPose.x, finishPose.z).onRoad && !realBuildingIndex.intersectsObb(finishPose),
    'the real finish is directly reachable on road without a building recovery');
  const rr = resample([[0, 0], [100, 0], [100, 70]], 40);
  ok(rr.length === 6, 'resample spacing correct (' + rr.length + ' pts)');
  const tenSamples = resampleByCount([[0, 0], [90, 0]], ROUTE_CHECKPOINT_COUNT);
  ok(tenSamples.length === ROUTE_CHECKPOINT_COUNT &&
    tenSamples.every((point, index) => point[0] === index * 10 && point[1] === 0),
  'count-based resampling preserves both endpoints and distributes all ten points evenly');
  ok(resampleByCount([[0, 0]], ROUTE_CHECKPOINT_COUNT).length === 0 &&
    resampleByCount([[0, 0], [0, 0]], ROUTE_CHECKPOINT_COUNT).length === 0 &&
    resampleByCount([[0, 0], [Number.NaN, 0]], ROUTE_CHECKPOINT_COUNT).length === 0,
  'count-based resampling rejects short, zero-length and non-finite paths');
  const paceOptions = {
    sampleDistance: 10,
    mergeDistance: 30,
    minimumAngleDegrees: 30,
    checkpointSpacing: 10
  };
  const rightPaceNote = createRoutePaceNotes([[0, 40], [0, 0], [40, 0]], paceOptions)[0];
  const leftPaceNote = createRoutePaceNotes([[0, 40], [0, 0], [-40, 0]], paceOptions)[0];
  ok(rightPaceNote?.turn === 'right' && leftPaceNote?.turn === 'left' &&
    rightPaceNote.angleDegrees === 90 && leftPaceNote.angleDegrees === 90,
  'pace notes preserve the world yaw convention for finite left and right curves');
  const angledPaceNote = (angleDegrees) => {
    const angle = angleDegrees * Math.PI / 180;
    return createRoutePaceNotes([
      [0, 40],
      [0, 0],
      [Math.sin(angle) * 40, -Math.cos(angle) * 40]
    ], paceOptions)[0];
  };
  ok(angledPaceNote(40)?.severity === 'open' && angledPaceNote(65)?.severity === 'medium' &&
    angledPaceNote(100)?.severity === 'tight' && angledPaceNote(145)?.severity === 'hairpin',
  'pace-note severity increases from open to medium, tight and hairpin with curve angle');
  ok(createRoutePaceNotes([[0, 60], [0, 20], [20, 0], [60, 0]], paceOptions).length === 1 &&
    createRoutePaceNotes([[0, 60], [0, 20], [20, 0], [60, 0]], paceOptions)[0].severity === 'tight',
  'nearby same-direction samples aggregate into one note with their complete curve severity');
  ok(createRoutePaceNotes([[0, 40], [0, 0], [5, -39.7]], paceOptions).length === 0 &&
    createRoutePaceNotes([[0, 0], [0, -40], [0, -80]], paceOptions).length === 0 &&
    createRoutePaceNotes([[0, 0], [Number.NaN, -40], [0, -80]], paceOptions).length === 0,
  'straight lines, micro-variations and malformed paths do not fabricate pace notes');
  const realPaceNotes = createRoutePaceNotes(route.path);
  ok(realPaceNotes.length >= 20 && realPaceNotes.length <= 100 &&
    new Set(realPaceNotes.map((note) => note.turn)).size === 2 &&
    new Set(realPaceNotes.map((note) => note.severity)).size === 4 &&
    realPaceNotes.every((note) => [note.x, note.z, note.distance, note.angleDegrees].every(Number.isFinite)),
  'real route produces a bounded finite mix of left/right notes across all four severities');
  console.log('== route components (unit) ==');
  const connectedGraph = new RoadGraph([{ cls: 'primary', width: 9, isTrack: false, points: [[0, 0], [0, 100], [100, 100]] }]);
  const { component: compConnected, compCount: compCountConnected } = computeComponents(connectedGraph);
  ok(compCountConnected === 1, 'connected graph has one component');
  ok(compConnected[0] === compConnected[1] && compConnected[1] === compConnected[2], 'all nodes share the same component');
  const disconnectedGraph = new RoadGraph([
    { cls: 'primary', width: 9, isTrack: false, points: [[0, 0], [0, 100]] },
    { cls: 'primary', width: 9, isTrack: false, points: [[500, 0], [500, 100]] }
  ]);
  const { component: compDisconnected, compCount: compCountDisconnected } = computeComponents(disconnectedGraph);
  ok(compCountDisconnected === 2, 'disconnected graph has two components');
  ok(compDisconnected[0] === compDisconnected[1] && compDisconnected[2] === compDisconnected[3], 'nodes within each segment share component');
  ok(compDisconnected[0] !== compDisconnected[2], 'different segments have different components');
  const disconnectedMap = {
    bbox: { minX: -100, maxX: 600, minZ: -100, maxZ: 200 },
    places: [
      { name: 'Alpha', x: 0, z: 50 },
      { name: 'Gamma', x: 500, z: 50 }
    ]
  };
  try {
    pickRoute(disconnectedGraph, disconnectedMap);
    ok(false, 'pickRoute should throw for disconnected places');
  } catch (e) {
    ok(e.message.includes('Nessuna coppia di luoghi validi'), 'throws when no valid pair exists');
  }
  const connectedMap = {
    bbox: { minX: -100, maxX: 600, minZ: -100, maxZ: 200 },
    places: [
      { name: 'Alpha', x: 0, z: 50 },
      { name: 'Beta', x: 0, z: 100 }
    ]
  };
  const connectedRoute = pickRoute(connectedGraph, connectedMap);
  ok(connectedRoute.start.name === 'Alpha' && connectedRoute.end.name === 'Beta', 'deterministic start/end from place names');
  ok(connectedRoute.checkpoints.length === ROUTE_CHECKPOINT_COUNT,
    'even a short valid named route receives exactly ten checkpoints');

  const junctionGraph = new RoadGraph([
    { width: 8, points: [[0, 20], [0, 0], [0, -20]] },
    { width: 8, points: [[-20, 0], [0, 0], [20, 0]] }
  ]);
  const directionOptions = {
    intersectionMergeDistance: 2,
    tangentDistance: 5,
    signDistance: 8,
    sideOffset: 2,
    checkpointSpacing: 10
  };
  const junctionNode = junctionGraph.nearestNode(0, 0);
  const fromSouth = junctionGraph.nearestNode(0, 20);
  const north = junctionGraph.nearestNode(0, -20);
  const east = junctionGraph.nearestNode(20, 0);
  const west = junctionGraph.nearestNode(-20, 0);
  ok(createRouteDirections(junctionGraph, [fromSouth, junctionNode, east], directionOptions)[0]?.turn === 'right',
    'T-junction classifies a right turn from the raw graph path');
  ok(createRouteDirections(junctionGraph, [fromSouth, junctionNode, west], directionOptions)[0]?.turn === 'left',
    'T-junction classifies a left turn from the raw graph path');
  ok(createRouteDirections(junctionGraph, [fromSouth, junctionNode, north], directionOptions)[0]?.turn === 'straight',
    'T-junction keeps a straight-ahead indication');
  ok(createRouteDirections(junctionGraph, [fromSouth, junctionNode, north], {
    ...directionOptions,
    isPositionBlocked: () => true
  }).length === 0, 'a junction sign is omitted when every safe roadside pose is blocked');

  const curveGraph = new RoadGraph([{ width: 8, points: [[0, 20], [0, 0], [20, 0]] }]);
  ok(createRouteDirections(curveGraph, [0, 1, 2], directionOptions).length === 0,
    'a degree-two bend does not invent an intersection sign');
  const duplicateGraph = new RoadGraph([
    { width: 8, points: [[0, 20], [0, 0], [0, -20]] },
    { width: 8, points: [[0, 20], [0, 0], [0, -20]] }
  ]);
  ok(createRouteDirections(duplicateGraph, [0, 1, 2], directionOptions).length === 0,
    'duplicate arcs on one road count unique neighbours and do not invent a junction');
  const adjacentGraph = new RoadGraph([
    { width: 8, points: [[0, 30], [0, 10], [0, 0], [0, -30]] },
    { width: 8, points: [[0, 10], [20, 10]] },
    { width: 8, points: [[0, 0], [-20, 0]] }
  ]);
  const adjacentPath = [
    adjacentGraph.nearestNode(0, 30),
    adjacentGraph.nearestNode(0, 10),
    adjacentGraph.nearestNode(0, 0),
    adjacentGraph.nearestNode(0, -30)
  ];
  ok(createRouteDirections(adjacentGraph, adjacentPath, {
    ...directionOptions,
    intersectionMergeDistance: 20
  }).length === 1, 'nearby nodes belonging to one complex junction produce one sign');

  const normalizedDirections = normalizeRouteDirections([
    { x: 1, z: 2, yaw: 0.5, turn: 'left', checkpoint: 3 },
    { x: Infinity, z: 2, yaw: 0, turn: 'right', checkpoint: 4 },
    { x: 1, z: 2, yaw: 0, turn: '<script>', checkpoint: 4 },
    null
  ], 10);
  ok(normalizedDirections.length === 1 && normalizedDirections[0].turn === 'left',
    'client accepts only finite, bounded route-direction payloads');
  ok(normalizeRouteDirections(null, 10).length === 0 &&
    normalizeRouteDirections([{ x: 0, z: 0, yaw: 0, turn: 'right', checkpoint: 10 }], 10).length === 0,
  'legacy or malformed direction payloads use an empty deterministic fallback');
  ok(normalizeRoutePath([0, 0, 10, -10]).length === 2 &&
    normalizeRoutePath([0, 0, Infinity, 1]).length === 0 && normalizeRoutePath([0, 0, 1]).length === 0,
  'client validates the additive raw route path and rejects partial or non-finite points');
  const signRoot = createRouteSignGroup(THREE, [
    { x: 0, z: 0, yaw: 0, turn: 'left', checkpoint: 2 },
    { x: 10, z: 0, yaw: Math.PI / 2, turn: 'straight', checkpoint: 4 },
    { x: 20, z: 0, yaw: 0, turn: 'right', checkpoint: 6 }
  ], () => 3);
  ok(signRoot.children.length === 3 && signRoot.children.every((sign) =>
    [sign.position.x, sign.position.y, sign.position.z].every(Number.isFinite)),
  'Three.js creates one finite off-road sign model per normalized direction');
  ok(signRoot.children[1].rotation.y === -Math.PI / 2,
    'sign front faces approaching traffic on east/west road headings');
  updateRouteSignVisibility(signRoot, 3, false);
  ok(signRoot.children.filter((sign) => sign.visible).length === 2,
    'only the next two useful signs remain visible');
  updateRouteSignVisibility(signRoot, 3, true);
  ok(signRoot.children.every((sign) => !sign.visible), 'finish hides every route sign');
  disposeObject3D(signRoot);

  const overlay = createRouteOverlayGeometries([[0, 0], [48, 0], [48, 48]]);
  ok(overlay.ribbonGeometry.isBufferGeometry && overlay.width === 1.4,
    'route overlay uses a visible 1.4 metre ribbon geometry');
  ok(overlay.ribbonGeometry.getAttribute('position').count >= 12 &&
    overlay.ribbonGeometry.getAttribute('position').count % 6 === 0,
    'route ribbon emits complete triangle pairs while preserving every route segment');
  const widthOverlay = createRouteOverlayGeometries([[0, 0], [48, 0]]);
  const widthBounds = widthOverlay.ribbonGeometry.boundingBox;
  ok(Math.abs(widthBounds.max.z - widthBounds.min.z - 1.4) < 1e-6,
    'route ribbon preserves its full physical width');
  ok(overlay.dashGeometry.getAttribute('position').count % 2 === 0, 'route dash geometry contains complete pairs');
  const elevatedOverlay = createRouteOverlayGeometries([[0, 0], [48, 0]], {
    heightAt: (x) => 100 + x / 2
  });
  const elevatedPositions = elevatedOverlay.ribbonGeometry.getAttribute('position');
  ok(elevatedPositions.getY(0) === 100.25 &&
    elevatedPositions.getY(elevatedPositions.count - 1) === 124.25,
    'route ribbon follows terrain height at both ends');
  const curvedHeight = (x) => 4 * Math.sin(Math.PI * x / 48);
  const curvedOverlay = createRouteOverlayGeometries([[0, 0], [48, 0]], {
    heightAt: curvedHeight
  });
  const curvedPositions = curvedOverlay.ribbonGeometry.getAttribute('position');
  const curvedDashes = curvedOverlay.dashGeometry.getAttribute('position');
  ok(curvedPositions.count > 6 &&
    maximumOverlayTerrainError(curvedOverlay.ribbonGeometry, curvedHeight) <= 0.05,
    'route ribbon adaptively follows a non-linear terrain profile between path nodes');
  ok(curvedDashes.count > 2 && Array.from({ length: curvedDashes.count }, (_, index) =>
    Math.abs(curvedDashes.getY(index) - curvedHeight(curvedDashes.getX(index)) - 0.25) <= 1e-5
  ).every(Boolean), 'every route-dash subdivision samples the non-linear terrain directly');
  const realTerrain = validateTerrainData(JSON.parse(
    readFileSync(new URL('../public/data/elevation.json', import.meta.url), 'utf8')
  ));
  const realTerrainHeight = (x, z) => terrainMeshHeightAt(realTerrain, x, z);
  const realRouteOverlays = createRouteCatalog(graph, map).map((candidate) => ({
    route: candidate,
    overlay: createRouteOverlayGeometries(candidate.path, { heightAt: realTerrainHeight })
  }));
  ok(realRouteOverlays.every(({ overlay: candidate }) =>
    maximumOverlayTerrainError(candidate.ribbonGeometry, realTerrainHeight) <= 0.06 &&
    candidate.ribbonGeometry.getAttribute('position').array.every(Number.isFinite) &&
    candidate.dashGeometry.getAttribute('position').array.every(Number.isFinite)),
    'all selectable-route ribbons and dashes remain finite and draped within six centimetres of the DEM');
  ok(realRouteOverlays.every(({ route: candidateRoute, overlay: candidate }) => {
    const count = candidate.ribbonGeometry.getAttribute('position').count;
    return count >= (candidateRoute.path.length - 1) * 6 && count / 3 <= 40000;
  }), 'real route adaptive draping keeps every overlay below 40,000 triangles');
  ok(createRouteOverlayGeometries([[0, 0]]) === null &&
    createRouteOverlayGeometries([[0, 0], [Number.NaN, 1]]) === null,
    'route overlay rejects short or non-finite paths before creating geometry');
  ok(routeOverlayKey([[0, 0], [10, 0]]) === routeOverlayKey([[0, 0], [10, 0]]) &&
    routeOverlayKey([[0, 0], [10, 0]]) !== routeOverlayKey([[0, 0], [0, 10]]),
    'overlay lifecycle can distinguish duplicate init from a changed route');
  overlay.ribbonGeometry.dispose();
  overlay.dashGeometry.dispose();
  widthOverlay.ribbonGeometry.dispose();
  widthOverlay.dashGeometry.dispose();
  elevatedOverlay.ribbonGeometry.dispose();
  elevatedOverlay.dashGeometry.dispose();
  curvedOverlay.ribbonGeometry.dispose();
  curvedOverlay.dashGeometry.dispose();
  for (const { overlay: candidate } of realRouteOverlays) {
    candidate.ribbonGeometry.dispose();
    candidate.dashGeometry.dispose();
  }

  console.log('== turn cue overlay (unit) ==');
  const cueNote = {
    id: 0,
    x: 0,
    z: 0,
    distance: 40,
    checkpoint: 0,
    turn: 'left',
    angleDegrees: 100,
    severity: 'tight'
  };
  const cueCar = { x: 0, z: 30, yaw: 0, speed: 30, cp: 0, finished: false };
  let cueResult = advanceTurnCue(createTurnCueState(), [cueNote], cueCar, 100);
  ok(TURN_CUE_DURATION_MS === 1000 && cueResult.view.visible &&
    cueResult.view.label === 'Sinistra stretta' && cueResult.state.visibleUntilMs === 1100,
  'a curve one second ahead opens one localized cue for exactly 1,000 ms');
  cueResult = advanceTurnCue(cueResult.state, [cueNote], cueCar, 1099);
  ok(cueResult.view.visible, 'active turn cue remains visible until its exact deadline');
  cueResult = advanceTurnCue(cueResult.state, [cueNote], cueCar, 1100);
  ok(!cueResult.view.visible && cueResult.state.shownIds.has(cueNote.id),
    'expired cue stays deduplicated for the rest of the round');
  const farCue = advanceTurnCue(createTurnCueState(), [cueNote], {
    ...cueCar,
    z: 31
  }, 0);
  const stoppedCue = advanceTurnCue(createTurnCueState(), [cueNote], {
    ...cueCar,
    speed: 2
  }, 0);
  const passedCue = advanceTurnCue(createTurnCueState(), [cueNote], {
    ...cueCar,
    z: -5
  }, 0);
  const finishedCue = advanceTurnCue(createTurnCueState(), [cueNote], {
    ...cueCar,
    finished: true
  }, 0);
  ok(!farCue.view.visible && !stoppedCue.view.visible && !passedCue.view.visible &&
    !finishedCue.view.visible,
  'cue stays hidden when farther than one-second lead, stopped, passed or finished');
  const openCueView = turnCueView({ ...cueNote, severity: 'open', angleDegrees: 40 });
  const tightCueView = turnCueView(cueNote);
  const hairpinCueView = turnCueView({ ...cueNote, severity: 'hairpin', angleDegrees: 145 });
  ok(openCueView.path !== tightCueView.path && tightCueView.path !== hairpinCueView.path &&
    hairpinCueView.path !== openCueView.path &&
    hairpinCueView.label === 'Sinistra tornante' &&
    !turnCueView({ ...cueNote, severity: '<bad>' }).visible &&
    !advanceTurnCue(createTurnCueState(), [{ ...cueNote, x: Infinity }], cueCar, 0).view.visible,
  'each severity has a distinct bounded arrow while malformed notes remain hidden');
  const turnCueHtml = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  ok(turnCueHtml.includes('id="turn-cue"') && turnCueHtml.includes('aria-live="polite"') &&
    turnCueHtml.includes('id="turn-cue-path"'),
  'turn cue markup exposes a static SVG and polite live status without generated HTML');

  console.log('== client UI (unit) ==');
  let streetState = createStreetBannerState();
  let streetView = advanceStreetBanner(streetState, 'Via Uno', 1000, {
    settleMs: 250,
    durationMs: 1000
  });
  streetState = streetView.state;
  ok(!streetView.visible, 'a first street sample waits for the anti-flicker stability interval');
  streetView = advanceStreetBanner(streetState, 'Via Uno', 1250, {
    settleMs: 250,
    durationMs: 1000
  });
  streetState = streetView.state;
  ok(streetView.visible && streetView.text === 'Via Uno' && streetState.visibleUntilMs === 2250,
    'a stable new street opens one bounded banner interval');
  streetView = advanceStreetBanner(streetState, 'Via Uno', 2000, {
    settleMs: 250,
    durationMs: 1000
  });
  streetState = streetView.state;
  ok(streetView.visible && streetState.visibleUntilMs === 2250,
    'repeated snapshots of the same street do not extend the banner');
  streetView = advanceStreetBanner(streetState, null, 2250, {
    settleMs: 250,
    durationMs: 1000
  });
  ok(!streetView.visible && streetView.state.currentName === 'Via Uno',
    'the banner expires while an unnamed gap preserves the last confirmed street');
  const streetSnapshots = new Map([
    [1, { streetName: 'Via Locale' }],
    [2, { streetName: 'Via Remota' }]
  ]);
  ok(selectLocalStreetName(streetSnapshots, 1) === 'Via Locale' &&
    selectLocalStreetName(streetSnapshots, 3) === null &&
    selectLocalStreetName(new Map([[1, { streetName: 'x'.repeat(81) }]]), 1) === null,
  'street overlay selects only the local bounded snapshot and rejects absent or oversized payloads');
  let markupState = createStreetBannerState();
  markupState = advanceStreetBanner(markupState, '<img src=x>', 0, { settleMs: 0 }).state;
  const markupView = advanceStreetBanner(markupState, '<img src=x>', 0, { settleMs: 0 });
  ok(markupView.text === '<img src=x>',
    'markup-like street data remains plain text for the client textContent renderer');
  const normalizedLobby = normalizeRouteLobby({
    routeOptions: [
      { id: 'route-1', start: 'A', end: 'B', lengthKm: 12.34, checkpoints: 44 },
      { id: '<bad>', start: 'X', end: 'Y', lengthKm: Infinity, checkpoints: 1 },
      { id: 'route-1', start: 'duplicate', end: 'ignored', lengthKm: 2, checkpoints: 3 }
    ],
    selectedRouteId: 'route-1',
    locked: false,
    phase: 'waiting',
    capacity: 4,
    hostId: 2,
    players: [
      { id: 2, name: 'Host', color: '#aabbcc', ready: true },
      { id: 3, name: '<img src=x>', color: 'red', ready: 'yes' },
      { id: 2, name: 'Duplicate', color: '#ffffff', ready: true }
    ]
  });
  ok(normalizedLobby.options.length === 1 && normalizedLobby.selectedRouteId === 'route-1' &&
    !normalizedLobby.locked && normalizedLobby.options[0].lengthKm === 12.34 &&
    normalizedLobby.players.length === 2 && normalizedLobby.players[1].name === '<img src=x>' &&
    normalizedLobby.players[1].color === '#8b949e' && !normalizedLobby.players[1].ready,
  'client accepts a bounded route catalog and rejects malformed or duplicate options');
  const hostLobbyView = lobbyView(normalizedLobby, 2);
  ok(hostLobbyView.visible && hostLobbyView.isHost && hostLobbyView.ready && !hostLobbyView.canStart &&
    hostLobbyView.canChangeRoute,
  'host lobby view can change route but cannot start until every player is ready');
  const allReadyLobby = normalizeRouteLobby({
    ...normalizedLobby,
    routeOptions: [{ id: 'route-1', start: 'A', end: 'B', lengthKm: 12.34, checkpoints: 44 }],
    players: normalizedLobby.players.map((player) => ({ ...player, ready: true }))
  });
  ok(lobbyView(allReadyLobby, 2).canStart && !lobbyView(allReadyLobby, 3).canStart,
    'only the ready host can start an all-ready lobby');
  const emptyLobby = normalizeRouteLobby(null);
  ok(emptyLobby.options.length === 0 && emptyLobby.selectedRouteId === '' && !emptyLobby.locked &&
    emptyLobby.phase === 'waiting' && emptyLobby.hostId === null && emptyLobby.players.length === 0,
    'malformed lobby payload uses an empty deterministic fallback');
  const keyboardInput = readDrivingInput(new Set(['ArrowUp', 'KeyA', 'Space']));
  ok(keyboardInput.u === 1 && keyboardInput.a === -1 && keyboardInput.h === true,
    'client maps Space to handbrake alongside keyboard driving input');
  ok(shouldPreventDrivingKey('Space') && shouldPreventDrivingKey('ArrowDown') &&
    !shouldPreventDrivingKey('KeyW'),
  'client prevents page scrolling for Space and arrow driving keys');
  let joinTransition = transitionJoin(INITIAL_JOIN_STATE, { type: 'click' });
  ok(joinTransition.state.phase === JOIN_PHASE.CUSTOMIZE && !joinTransition.emitJoin, 'first join click only opens customization');
  joinTransition = transitionJoin(joinTransition.state, { type: 'click' });
  ok(joinTransition.state.phase === JOIN_PHASE.SUBMITTING && joinTransition.emitJoin, 'second join click emits exactly once');
  ok(joinView({ phase: JOIN_PHASE.CUSTOMIZE }).label === 'Entra nella lobby',
    'the join submission gesture explicitly enters the lobby');
  joinTransition = transitionJoin(joinTransition.state, { type: 'click' });
  ok(joinTransition.state.phase === JOIN_PHASE.SUBMITTING && !joinTransition.emitJoin, 'repeated click while submitting is ignored');
  ok(transitionJoin(joinTransition.state, { type: 'init' }).state.phase === JOIN_PHASE.ENTERED, 'init closes the join flow');
  const fullJoinState = transitionJoin(INITIAL_JOIN_STATE, { type: 'full' }).state;
  ok(joinView(fullJoinState).disabled, 'full state disables the join button');
  ok(transitionJoin(fullJoinState, { type: 'availability', phase: 'running', hasSeat: true }).state.phase === JOIN_PHASE.FULL, 'free seat during running does not re-enable a full join');
  ok(transitionJoin(fullJoinState, { type: 'availability', phase: 'countdown', hasSeat: true }).state.phase === JOIN_PHASE.FULL,
    'free seat during countdown stays unavailable until the next lobby');
  const errorState = transitionJoin(INITIAL_JOIN_STATE, { type: 'error' }).state;
  ok(joinView(errorState).message.includes('Server non raggiungibile'), 'connection error has a comprehensible message');
  ok(transitionJoin(errorState, { type: 'connected' }).state.phase === JOIN_PHASE.INTRO, 'reconnection restores the join flow');
  const rejectedState = transitionJoin(INITIAL_JOIN_STATE, { type: 'race_started' }).state;
  ok(transitionJoin(rejectedState, { type: 'availability', phase: 'running', hasSeat: true }).state.phase === JOIN_PHASE.RACE_STARTED, 'running state keeps a rejected join disabled');
  ok(transitionJoin(rejectedState, { type: 'availability', phase: 'waiting', hasSeat: true }).state.phase === JOIN_PHASE.CUSTOMIZE, 'next available race re-enables a rejected join');

  const resourceParent = new THREE.Group();
  const resourceRoot = new THREE.Group();
  const sharedGeometry = new THREE.BoxGeometry(1, 1, 1);
  const sharedTexture = new THREE.Texture();
  const sharedMaterial = new THREE.MeshBasicMaterial({ map: sharedTexture });
  resourceRoot.add(new THREE.Mesh(sharedGeometry, sharedMaterial), new THREE.Mesh(sharedGeometry, sharedMaterial));
  resourceParent.add(resourceRoot);
  let geometryDisposals = 0;
  let materialDisposals = 0;
  let textureDisposals = 0;
  sharedGeometry.addEventListener('dispose', () => geometryDisposals++);
  sharedMaterial.addEventListener('dispose', () => materialDisposals++);
  sharedTexture.addEventListener('dispose', () => textureDisposals++);
  const disposed = disposeObject3D(resourceRoot);
  ok(resourceParent.children.length === 0, 'removed car group leaves the scene graph');
  ok(disposed.geometries === 1 && geometryDisposals === 1, 'shared geometry is disposed exactly once');
  ok(disposed.materials === 1 && materialDisposals === 1, 'shared material is disposed exactly once');
  ok(disposed.textures === 1 && textureDisposals === 1, 'owned texture is disposed exactly once');

  const visualCar = createCarModel('#ffffff');
  const visualCarSize = new THREE.Box3().setFromObject(visualCar).getSize(new THREE.Vector3());
  ok(Math.abs(visualCarSize.x - CAR_VISUAL.outerWidth) < 1e-6 && visualCarSize.x <= 1.800001,
    'rendered car outer width is at most 1.80 metres');
  ok(Math.abs(visualCarSize.z - CAR_VISUAL.bodyLength) < 1e-6 &&
    visualCarSize.z <= CAR_RADIUS * 2 + 1e-6,
  'rendered car length stays aligned with its collision footprint');
  ok(CAR_RADIUS >= Math.hypot(CAR_VISUAL.bodyWidth / 2, CAR_VISUAL.bodyLength / 2),
    'collision radius contains every corner of the rendered body');
  ok(CAR_VISUAL.outerWidth === CAR_FOOTPRINT.width && CAR_VISUAL.bodyLength === CAR_FOOTPRINT.length,
    'rendered car dimensions share the authoritative oriented building footprint');
  ok(visualCar.rotation.order === 'YXZ',
    'rendered car applies local pitch and roll after its authoritative yaw');
  disposeObject3D(visualCar);

  console.log('== production paths (unit) ==');
  const tempDir = await mkdtemp(pathJoin(osTmpdir(), 'test-server-'));
  trackedTempDirs.add(tempDir);
  const fixtureStaticRoot = pathJoin(tempDir, 'static');
  const fixtureDataRoot = pathJoin(tempDir, 'data');
  await mkdir(pathJoin(fixtureStaticRoot, 'data'), { recursive: true });
  await mkdir(fixtureDataRoot, { recursive: true });
  await writeFile(pathJoin(fixtureStaticRoot, 'index.html'), '<html>fixture</html>');
  await writeFile(pathJoin(fixtureStaticRoot, 'data', 'secret.json'), '{"secret":true}');
  await writeFile(pathJoin(fixtureDataRoot, 'roads.json'), JSON.stringify({
    elements: [{
      type: 'way',
      tags: { highway: 'residential' },
      geometry: [{ lon: 12.4, lat: 43.9 }, { lon: 12.401, lat: 43.901 }]
    }]
  }));
  await writeFile(pathJoin(fixtureDataRoot, 'buildings.json'), JSON.stringify({ elements: [] }));
  validateProductionPaths(fixtureStaticRoot, fixtureDataRoot);
  ok(true, 'production paths accept explicit fixture roots');
  let missingAssetError = null;
  try {
    validateProductionPaths(pathJoin(tempDir, 'missing-static'), fixtureDataRoot);
  } catch (error) {
    missingAssetError = error;
  }
  ok(missingAssetError?.message.includes('dist/index.html'), 'missing production index fails before listen');
  ok(parseCliArgs(['node', 'server.js', '--dev']).devMode, 'CLI parser enables explicit dev mode');
  ok(!parseCliArgs(['node', 'server.js']).devMode, 'CLI parser keeps production as the default');
  let invalidStartOptions = 0;
  for (const options of [{ startDelayMs: null }, { countdown: '3' }, { startDelayMs: 3000, countdown: 3 }]) {
    try {
      startServer(options);
    } catch {
      invalidStartOptions++;
    }
  }
  ok(invalidStartOptions === 3, 'server rejects ambiguous or non-numeric start-delay options');

  console.log('== client audio (unit) ==');
  const audioSnapshots = new Map([
    [1, { speed: 8, rpm: 3200, brakeLevel: 0.6, onRoad: true }],
    [2, { speed: 120, rpm: 7600, brakeLevel: 1, onRoad: false }]
  ]);
  const selectedAudioSnapshot = selectLocalSnapshot(audioSnapshots, 1);
  ok(selectedAudioSnapshot === audioSnapshots.get(1), 'audio selects only the local snapshot');
  const localTargets = engineTargets(selectedAudioSnapshot);
  audioSnapshots.set(2, { speed: 0, rpm: 900, brakeLevel: 0, onRoad: true });
  ok(JSON.stringify(engineTargets(selectLocalSnapshot(audioSnapshots, 1))) === JSON.stringify(localTargets), 'remote snapshot changes do not affect local audio targets');
  ok(localTargets.brakeGain > 0, 'effective local braking produces a brake-noise target');
  ok(engineTargets({ speed: 8, rpm: 6000, brakeLevel: 0, onRoad: true }).frequency >
    engineTargets({ speed: 8, rpm: 1800, brakeLevel: 0, onRoad: true }).frequency,
  'engine pitch follows authoritative RPM rather than speed alone');
  const asphaltTargets = engineTargets({ speed: 18, rpm: 4200, brakeLevel: 0, surface: 'asphalt' });
  const shoulderTargets = engineTargets({ speed: 18, rpm: 4200, brakeLevel: 0, surface: 'shoulder' });
  const trackTargets = engineTargets({ speed: 18, rpm: 4200, brakeLevel: 0, surface: 'track' });
  const grassTargets = engineTargets({ speed: 12, rpm: 4200, brakeLevel: 0, surface: 'grass' });
  ok(asphaltTargets.surfaceGain === 0 && shoulderTargets.surfaceGain > 0 &&
    shoulderTargets.surfaceGain < trackTargets.surfaceGain && trackTargets.surfaceGain > 0 &&
    grassTargets.surfaceGain > 0 && shoulderTargets.frequency === asphaltTargets.frequency &&
    shoulderTargets.gain === asphaltTargets.gain &&
    shoulderTargets.surfaceFrequency !== trackTargets.surfaceFrequency &&
    trackTargets.surfaceFrequency !== grassTargets.surfaceFrequency &&
    asphaltTargets.frequency !== trackTargets.frequency && trackTargets.frequency !== grassTargets.frequency,
  'shoulder adds light rolling noise without changing asphalt engine targets');
  ok(normalizeSurfaceSnapshot({ surface: 'shoulder', onRoad: false }).surface === SURFACE.SHOULDER &&
    normalizeSurfaceSnapshot({ surface: 'track', onRoad: true }).surface === SURFACE.TRACK &&
    normalizeSurfaceSnapshot({ surface: '<bad>', onRoad: false }).surface === SURFACE.GRASS &&
    normalizeSurfaceSnapshot({ onRoad: true }).surface === SURFACE.ASPHALT,
  'surface snapshot normalization accepts the bounded protocol and preserves legacy fallbacks');
  const asphaltShake = surfaceShake(SURFACE.ASPHALT, 20, 1.25, 1);
  const shoulderShake = surfaceShake(SURFACE.SHOULDER, 20, 1.25, 1);
  const trackShake = surfaceShake(SURFACE.TRACK, 20, 1.25, 1);
  ok(asphaltShake.y === 0 && asphaltShake.pitch === 0 && asphaltShake.roll === 0 &&
    shoulderShake.y === 0 && shoulderShake.pitch === 0 && shoulderShake.roll === 0 &&
    Object.values(trackShake).every(Number.isFinite) && Math.abs(trackShake.y) <= 0.08 &&
    Math.abs(trackShake.pitch) <= 0.04 && Math.abs(trackShake.roll) <= 0.03 &&
    JSON.stringify(trackShake) === JSON.stringify(surfaceShake(SURFACE.TRACK, 20, 1.25, 1)),
  'dirt shaker is deterministic, finite and bounded while asphalt and shoulder remain stable');
  ok(engineTargets(selectLocalSnapshot(audioSnapshots, 3)).gain === 0 &&
    engineTargets(selectLocalSnapshot(audioSnapshots, 3)).brakeGain === 0,
  'missing local car mutes engine and braking');
  ok(engineTargets(null).gain === 0 && engineTargets(null).brakeGain === 0,
    'disconnected state mutes every car sound');
  const invalidAudioTargets = engineTargets({ speed: Infinity, rpm: Infinity, brakeLevel: Infinity, onRoad: true });
  ok(Object.values(invalidAudioTargets).every(Number.isFinite) && invalidAudioTargets.brakeGain === 0,
    'invalid snapshot values produce finite muted braking targets');
  ok(engineTargets({ speed: 10, rpm: 4000, brakeLevel: 1, onRoad: true, finished: true }).gain === 0 &&
    engineTargets({ speed: 10, rpm: 4000, brakeLevel: 1, onRoad: true, finished: true }).brakeGain === 0 &&
    engineTargets({ speed: 10, rpm: 4000, surface: 'shoulder', finished: true }).surfaceGain === 0,
  'a finished local car is fully muted');
  const legacyDrivetrain = normalizeDrivetrainSnapshot({ speed: 50, onRoad: true });
  ok(legacyDrivetrain.rpm === undefined &&
    engineTargets({ speed: 50, onRoad: true, ...legacyDrivetrain }).frequency > 150,
  'legacy snapshots preserve the speed-based RPM fallback');
  const invalidDrivetrain = normalizeDrivetrainSnapshot({
    gear: 0,
    rpm: 99999,
    brakeLevel: -4,
    handbrake: 'true'
  });
  ok(invalidDrivetrain.gear === 1 && invalidDrivetrain.rpm === DRIVETRAIN.redlineRpm &&
    invalidDrivetrain.brakeLevel === 0 && invalidDrivetrain.handbrake === false,
  'client normalization rejects neutral gear and clamps drivetrain fields');
  const validImpact = normalizeImpactSnapshot({ impactSeq: 4, impactLevel: 0.75 });
  ok(validImpact.impactSeq === 4 && validImpact.impactLevel === 0.75,
    'client preserves a valid authoritative building-impact snapshot');
  const invalidImpactSeq = normalizeImpactSnapshot({ impactSeq: -1, impactLevel: 0.75 });
  const invalidImpactLevel = normalizeImpactSnapshot({ impactSeq: 5, impactLevel: 2 });
  ok(invalidImpactSeq.impactSeq === undefined && invalidImpactSeq.impactLevel === 0.75 &&
    invalidImpactLevel.impactSeq === 5 && invalidImpactLevel.impactLevel === 0,
  'client rejects invalid impact counters and levels with deterministic fallbacks');
  const localImpact = localImpactEvent(
    { id: 1, impactSeq: 4, impactLevel: 0.2 },
    { id: 1, impactSeq: 5, impactLevel: 0.8 },
    1
  );
  ok(localImpact?.seq === 5 && localImpact.level === 0.8,
    'a new authoritative impact emits one event for the local car');
  ok(localImpactEvent(null, { id: 1, impactSeq: 5, impactLevel: 0.8 }, 1) === null &&
    localImpactEvent({ id: 2, impactSeq: 4 }, { id: 2, impactSeq: 5, impactLevel: 0.8 }, 1) === null,
  'initial and remote snapshots never emit impact audio events');
  ok(localImpactEvent(
    { id: 1, impactSeq: 5, impactLevel: 0.8 },
    { id: 1, impactSeq: 5, impactLevel: 0.8 },
    1
  ) === null && localImpactEvent(
    { id: 1, impactSeq: 5, impactLevel: 0.8 },
    { id: 1, impactSeq: 0, impactLevel: 0 },
    1
  ) === null,
  'duplicate and regressed impact counters stay silent');
  const skippedImpacts = localImpactEvent(
    { id: 1, impactSeq: 5, impactLevel: 0.4 },
    { id: 1, impactSeq: 8, impactLevel: 1 },
    1
  );
  ok(skippedImpacts?.seq === 8 && skippedImpacts.level === 1 && !Array.isArray(skippedImpacts),
    'a skipped counter range coalesces into one latest local impact event');
  ok(localImpactEvent(
    { id: 1, impactSeq: 5, impactLevel: 0.8 },
    { id: 1, impactSeq: Infinity, impactLevel: 0.8 },
    1
  ) === null && localImpactEvent(
    { id: 1, impactSeq: 5, impactLevel: 0.8 },
    { id: 1, impactSeq: 6, impactLevel: NaN },
    1
  ) === null,
  'invalid impact payloads cannot trigger local audio');
  const localCheckpoint = localCheckpointEvent(
    { id: 1, checkpointsHit: 3 },
    { id: 1, checkpointsHit: 4 },
    1
  );
  ok(localCheckpoint?.checkpointsHit === 4 && localCheckpoint.gained === 1,
    'a newly captured authoritative checkpoint emits one event for the local car');
  ok(localCheckpointEvent(null, { id: 1, checkpointsHit: 2 }, 1) === null &&
    localCheckpointEvent(
      { id: 2, checkpointsHit: 1 },
      { id: 2, checkpointsHit: 2 },
      1
    ) === null && localCheckpointEvent(
      { id: 1, checkpointsHit: 4 },
      { id: 1, checkpointsHit: 4 },
      1
    ) === null,
  'initial, remote and duplicate checkpoint snapshots stay silent');
  const coalescedCheckpoint = localCheckpointEvent(
    { id: 1, checkpointsHit: 4 },
    { id: 1, checkpointsHit: 7 },
    1
  );
  ok(coalescedCheckpoint?.checkpointsHit === 7 && coalescedCheckpoint.gained === 3 &&
    localCheckpointEvent(
      { id: 1, checkpointsHit: 7 },
      { id: 1, checkpointsHit: Infinity },
      1
    ) === null,
  'skipped state packets coalesce checkpoint audio and invalid counters cannot trigger it');

  console.log('== race lifecycle (unit) ==');
  const bootRace = createRaceState(3, 0);
  const delayedBootRace = advanceRace(bootRace, 0, 10000);
  ok(publicRaceState(delayedBootRace, 10000).phase === RACE_PHASE.WAITING, 'boot remains waiting without players');
  ok(publicRaceState(delayedBootRace, 10000).countdown === 3, 'waiting does not consume countdown time');
  const populatedLobbyRace = advanceRace(delayedBootRace, 2, 10500);
  ok(populatedLobbyRace.phase === RACE_PHASE.WAITING,
    'adding players does not start the race without an explicit host command');
  const countdownRace = startRace(populatedLobbyRace, 10000);
  ok(publicRaceState(countdownRace, 10000).phase === RACE_PHASE.COUNTDOWN,
    'explicit start begins the countdown');
  ok(publicRaceState(countdownRace, 10000).countdown === 3, 'explicit start receives the full countdown');
  const duplicateStartRace = startRace(countdownRace, 10500);
  ok(duplicateStartRace.countdownStartedAtMs === 10000, 'a repeated start cannot restart countdown');
  ok(advanceRace(duplicateStartRace, 2, 12999).phase === RACE_PHASE.COUNTDOWN, 'race stays in countdown until the deadline');
  const runningRace = advanceRace(duplicateStartRace, 2, 13000);
  ok(runningRace.phase === RACE_PHASE.RUNNING && runningRace.raceStartT === 13000, 'countdown transitions once to running at its deadline');
  const advancedRunningRace = advanceRace(runningRace, 2, 18000);
  ok(advancedRunningRace.raceStartT === 13000 && raceElapsedMs(advancedRunningRace, 18000) === 5000, 'running keeps a stable race start timestamp');
  ok(startRace(advancedRunningRace, 18500).phase === RACE_PHASE.RUNNING, 'late pure start cannot restart a running race');
  ok(leaveRace(bootRace, 0, 20000).phase === RACE_PHASE.WAITING, 'total disconnect keeps waiting clean');
  ok(leaveRace(countdownRace, 0, 20000).phase === RACE_PHASE.WAITING, 'total disconnect resets countdown');
  const resetRunningRace = leaveRace(runningRace, 0, 20000);
  ok(resetRunningRace.phase === RACE_PHASE.WAITING && resetRunningRace.raceStartT === null, 'total disconnect resets a running race');
  ok(RESULTS_DURATION_MS === 5000, 'results duration is exactly five seconds');
  const resultsRace = advanceRace(runningRace, 2, 14000, true);
  ok(resultsRace.phase === RACE_PHASE.RESULTS && publicRaceState(resultsRace, 14000).resultsRemaining === 5, 'all finishers enter results with full duration');
  ok(advanceRace(resultsRace, 2, 18999, true).phase === RACE_PHASE.RESULTS, 'results remain active until five seconds elapse');
  const nextRoundRace = advanceRace(resultsRace, 2, 19000, true);
  ok(nextRoundRace.phase === RACE_PHASE.WAITING && nextRoundRace.round === 1,
    'results return to an explicit lobby for the next round');
  ok(publicRaceState(nextRoundRace, 19000).countdown === 3, 'new lobby preserves the configured countdown duration');
  ok(advanceRace(resultsRace, 0, 15000, true).phase === RACE_PHASE.WAITING, 'zero players take precedence over results');

  console.log('== start lights (unit) ==');
  ok(randomStartDelayMs(() => 0) === START_DELAY_MIN_MS && randomStartDelayMs(() => 1) === START_DELAY_MAX_MS,
    'start delay RNG maps its extrema to exactly 4.5 and 6.8 seconds');
  ok(START_LIGHT_INTERVAL_MS > 400,
    'red lights progress more slowly than the previous 400 ms sequence');
  const allRedElapsedMs = START_LIGHT_LEAD_IN_MS +
    (START_LIGHT_COUNT - 1) * START_LIGHT_INTERVAL_MS;
  ok(START_LIGHT_LEAD_IN_MS === 1000 &&
    START_DELAY_MIN_MS - allRedElapsedMs === START_LIGHT_INTERVAL_MS &&
    START_DELAY_MAX_MS - allRedElapsedMs === 3000,
  'the sequence waits one second before red and holds all lights for 0.7 to three seconds');
  const lightRace = startRace(createRaceState(5, 0), 1000, START_DELAY_MIN_MS);
  const initiallyOff = publicRaceState(lightRace, 1000);
  ok(initiallyOff.startLights === 0 && initiallyOff.startSignal === 'off',
    'the countdown first displays the full traffic light switched off');
  ok(publicRaceState(lightRace, 1000 + START_LIGHT_LEAD_IN_MS - 1).startLights === 0,
    'the traffic light stays fully off for the entire lobby-transition lead-in');
  ok(Array.from({ length: START_LIGHT_COUNT }, (_, index) =>
    1000 + START_LIGHT_LEAD_IN_MS + index * START_LIGHT_INTERVAL_MS)
    .map((nowMs) => publicRaceState(lightRace, nowMs).startLights).join(',') === '1,2,3,4,5',
  'five red lights turn on one at a time at 700 ms intervals after the lead-in');
  const unchangedLightRace = startRace(lightRace, 1500, START_DELAY_MAX_MS);
  ok(unchangedLightRace.countdownStartedAtMs === 1000 && unchangedLightRace.countdownMs === START_DELAY_MIN_MS,
    'a second join cannot restart or redraw the light sequence');
  const lightRaceDeadlineMs = 1000 + START_DELAY_MIN_MS;
  ok(advanceRace(lightRace, 2, lightRaceDeadlineMs - 1).phase === RACE_PHASE.COUNTDOWN &&
    publicRaceState(lightRace, lightRaceDeadlineMs - 1).startLights === 5,
  'all red lights remain on until the deadline');
  const greenRace = advanceRace(lightRace, 2, lightRaceDeadlineMs);
  const greenPublic = publicRaceState(greenRace, lightRaceDeadlineMs);
  ok(greenRace.phase === RACE_PHASE.RUNNING && greenRace.raceStartT === lightRaceDeadlineMs &&
    greenPublic.startLights === 0 && greenPublic.startSignal === 'green',
  'red lights switch off and green appears exactly at race start');
  const lateGreenRace = advanceRace(lightRace, 2, lightRaceDeadlineMs + 250);
  ok(lateGreenRace.raceStartT === lightRaceDeadlineMs &&
    raceElapsedMs(lateGreenRace, lightRaceDeadlineMs + 250) === 250,
    'a late server tick preserves the start deadline and elapsed race time');
  const stalledGreenRace = advanceRace(lightRace, 2, lightRaceDeadlineMs + 1250);
  ok(stalledGreenRace.raceStartT === lightRaceDeadlineMs &&
    publicRaceState(stalledGreenRace, lightRaceDeadlineMs + 1250).startSignal === 'green',
  'the first running state still exposes green after a long delayed tick');
  ok(publicRaceState(greenRace, lightRaceDeadlineMs + START_GREEN_DURATION_MS).startSignal === 'off',
    'green signal disappears after its bounded display interval');

  const resultsStartedAtMs = lightRaceDeadlineMs + 600;
  const lightResults = advanceRace(greenRace, 1, resultsStartedAtMs, true);
  const reopenedLobby = advanceRace(lightResults, 1, resultsStartedAtMs + RESULTS_DURATION_MS, true);
  ok(reopenedLobby.phase === RACE_PHASE.WAITING && reopenedLobby.round === 1,
    'a completed round reopens the lobby without drawing a start delay');
  const rematchStartedAtMs = resultsStartedAtMs + RESULTS_DURATION_MS + 1500;
  const redrawnRound = startRace(reopenedLobby, rematchStartedAtMs, START_DELAY_MAX_MS);
  const delayedRoundPublic = publicRaceState(redrawnRound, rematchStartedAtMs);
  ok(delayedRoundPublic.startLights === 0 && delayedRoundPublic.startSignal === 'off' &&
    delayedRoundPublic.countdown === START_DELAY_MAX_MS / 1000,
  'the next explicit start begins with a complete fresh switched-off light sequence');

  const redView = startSignalView({ startLights: 3, startSignal: 'red' }, RACE_PHASE.COUNTDOWN);
  ok(redView.visible && redView.lights === 3 && !redView.green, 'client view accepts normalized red-light state');
  const fallbackView = startSignalView({ startLights: 99, startSignal: '<script>' }, RACE_PHASE.COUNTDOWN);
  ok(fallbackView.visible && fallbackView.lights === 0 && fallbackView.signal === 'off' &&
    !fallbackView.green,
  'client view rejects malformed light payloads with a deterministic switched-off fallback');
  ok(!startSignalView({ startLights: 0, startSignal: 'green' }, RACE_PHASE.COUNTDOWN).green &&
    !startSignalView({ startLights: 3, startSignal: 'red' }, RACE_PHASE.RUNNING).visible,
  'client view rejects start signals that conflict with the authoritative phase');
  const offView = startSignalView({ startLights: 0, startSignal: 'off' }, RACE_PHASE.COUNTDOWN);
  const oneRedView = startSignalView({ startLights: 1, startSignal: 'red' }, RACE_PHASE.COUNTDOWN);
  const greenView = startSignalView({ startLights: 0, startSignal: 'green' }, RACE_PHASE.RUNNING);
  ok(startSignalAudioEvent(offView, oneRedView) === 'light' &&
    startSignalAudioEvent(oneRedView, redView) === 'light' &&
    startSignalAudioEvent(redView, greenView) === 'start',
  'client emits one light tone per red-light increase and a distinct start tone on switch-off');
  ok(startSignalAudioEvent(null, oneRedView) === null &&
    startSignalAudioEvent(redView, redView) === null &&
    startSignalAudioEvent(greenView, greenView) === null,
  'initial and duplicate traffic-light views remain silent');
  const rankedFixture = rankRaceCars([
    { id: 1, finished: true, finishMs: 2200, score: 99, checkpointsHit: 100 },
    { id: 2, finished: true, finishMs: 1800, score: 1, checkpointsHit: 2 },
    { id: 3, finished: false, score: 100 }
  ]);
  ok(rankedFixture.map((car) => car.id).join(',') === '2,1,3',
    'finishers rank by time independently of checkpoint coverage, progress and ID');

  console.log('== socket contract (unit) ==');
  ok(normalizeInputValue(2) === 1 && normalizeInputValue(-2) === -1, 'numeric inputs are clamped');
  ok(['1', null, undefined, NaN, Infinity, -Infinity].every((value) => normalizeInputValue(value) === 0), 'non-finite and non-numeric inputs become zero');
  ok(normalizeHandbrakeInput(true) && !normalizeHandbrakeInput(1) &&
    !normalizeHandbrakeInput('true') && !normalizeHandbrakeInput(null),
  'only the boolean true activates the authoritative handbrake');
  ok(normalizePlayerColor('#AaBbCc', '#000000') === '#aabbcc', 'valid hex color is normalized to lowercase');
  ok(normalizePlayerColor('red', '#123456') === '#123456', 'generic CSS color is rejected');
  ok(normalizePlayerColor('#12345', '#123456') === '#123456', 'malformed hex color is rejected');
  ok(normalizePlayerColor('#1234567890', '#123456') === '#123456', 'overlong color string is rejected');
  ok(normalizePlayerColor('\"><img src=x>', '#123456') === '#123456', 'markup-like color is rejected');
  ok(normalizePlayerColor(123, '#123456') === '#123456', 'non-string color is rejected');

  console.log('== server (integration) ==');
  const fixtureServer = startServer({
    countdown: 5,
    staticRoot: fixtureStaticRoot,
    dataRoot: fixtureDataRoot,
    checkpoints: [[0, 0], [0, -40]]
  });
  trackedServers.add(fixtureServer);
  ok(fixtureServer.getRaceState().countdownMs === 5000,
    'legacy countdown option remains a compatible seconds-based alias');
  await new Promise((res) => fixtureServer.server.listen(0, res));
  const fixtureUrl = 'http://localhost:' + fixtureServer.server.address().port;
  const secretRes = await fetch(fixtureUrl + '/data/secret.json');
  ok(secretRes.status === 404, 'static root cannot bypass the /data allowlist');
  const fixtureRoadsRes = await fetch(fixtureUrl + '/data/roads.json');
  ok(fixtureRoadsRes.status === 200, 'fixture data root serves an allowed dataset');
  const fixtureElevationRes = await fetch(fixtureUrl + '/data/elevation.json');
  ok(fixtureElevationRes.status === 404, 'missing optional elevation asset returns 404');

  const devServer = startServer({
    devMode: true,
    staticRoot: fixtureStaticRoot,
    dataRoot: fixtureDataRoot,
    checkpoints: [[0, 0], [0, -40]]
  });
  trackedServers.add(devServer);
  await new Promise((res) => devServer.server.listen(0, res));
  const devUrl = 'http://localhost:' + devServer.server.address().port;
  const devIndexRes = await fetch(devUrl + '/');
  ok(devIndexRes.status === 404, 'dev mode does not serve the frontend directly');
  const devDataRes = await fetch(devUrl + '/data/roads.json');
  ok(devDataRes.status === 200, 'dev backend keeps the allowlisted data route available');

  const s = startServer({
    startDelayMs: START_DELAY_MAX_MS,
    staticRoot: fixtureStaticRoot
  });
  trackedServers.add(s);
  await new Promise((res) => s.server.listen(0, res));
  const url = 'http://localhost:' + s.server.address().port;

  const mapRes = await fetch(url + '/data/roads.json');
  ok(mapRes.status === 200, 'serves /data/roads.json');
  const buildingsRes = await fetch(url + '/data/buildings.json');
  ok(buildingsRes.status === 200, 'serves /data/buildings.json');
  const htmlRes = await fetch(url + '/');
  ok(htmlRes.status === 200, 'serves index.html');
  const dotfileRes = await fetch(url + '/data/.elevation-part.json');
  ok(dotfileRes.status === 404, 'dotfile /data/.elevation-part.json returns 404');
  const traversalRes1 = await fetch(url + '/data/../public/src/main.js');
  ok(traversalRes1.status === 404, 'path traversal with .. returns 404');
  const traversalRes2 = await fetch(url + '/data/..%2F..%2Fetc%2Fpasswd');
  ok(traversalRes2.status === 404, 'URL-encoded path traversal returns 404');
  const unknownFileRes = await fetch(url + '/data/unknown.json');
  ok(unknownFileRes.status === 404, 'unknown file in /data returns 404');

  function makeClient(target = url) {
    const socket = io(target, { transports: ['websocket'] });
    trackedSockets.add(socket);
    return socket;
  }

  function waitFor(sock, event, pred, ms = 8000) {
    return new Promise((resolve, reject) => {
      const to = setTimeout(() => {
        sock.off(event, h);
        reject(new Error('timeout waiting for ' + event));
      }, ms);
      function h(data) {
        if (!pred || pred(data)) {
          clearTimeout(to);
          sock.off(event, h);
          resolve(data);
        }
      }
      sock.on(event, h);
    });
  }

  function waitUntil(pred, label, ms = 8000) {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const interval = setInterval(() => {
        if (pred()) {
          clearInterval(interval);
          resolve();
        } else if (Date.now() - started >= ms) {
          clearInterval(interval);
          reject(new Error('timeout waiting for ' + label));
        }
      }, 10);
    });
  }

  console.log('== building collision (integration) ==');
  const collisionDataRoot = pathJoin(tempDir, 'collision-data');
  await mkdir(collisionDataRoot, { recursive: true });
  const collisionRoads = {
    elements: [{
      type: 'way',
      tags: { highway: 'residential', width: '20', name: 'Via del Test' },
      geometry: [{ lon: 12.4, lat: 43.899 }, { lon: 12.4, lat: 43.901 }]
    }]
  };
  const collisionMap = parseMapData(collisionRoads);
  const wallLocal = [[12.2, -10], [14.2, -10], [14.2, 10], [12.2, 10], [12.2, -10]];
  const wallGeometry = wallLocal.map(([x, z]) => collisionMap.proj.toLonLat(x, z));
  await writeFile(pathJoin(collisionDataRoot, 'roads.json'), JSON.stringify(collisionRoads));
  await writeFile(pathJoin(collisionDataRoot, 'buildings.json'), JSON.stringify({
    elements: [{ type: 'way', id: 99, tags: { building: 'yes' }, geometry: wallGeometry }]
  }));
  const collisionServer = startServer({
    startDelayMs: START_DELAY_MIN_MS,
    staticRoot: fixtureStaticRoot,
    dataRoot: collisionDataRoot,
    checkpoints: [[0, 0], [0, -40]]
  });
  trackedServers.add(collisionServer);
  await new Promise((resolve) => collisionServer.server.listen(0, resolve));
  const collisionUrl = 'http://localhost:' + collisionServer.server.address().port;
  const collisionSocket = makeClient(collisionUrl);
  await waitFor(collisionSocket, 'connect');
  const collisionInitPromise = waitFor(collisionSocket, 'init');
  collisionSocket.emit('join', { name: 'Crash test', routeId: '<script>' });
  const collisionInit = await collisionInitPromise;
  ok(collisionInit.routeId === 'custom', 'invalid host route ID falls back to the fixture default');
  ok(collisionServer.buildingFootprints.length === 1 && collisionServer.buildingFit.removedCount === 0,
    'off-road collision fixture remains outside the protected carriageway');
  const collisionReadyP = waitFor(collisionSocket, 'lobby', (lobby) => lobby.players[0]?.ready === true);
  collisionSocket.emit('lobby:ready', { ready: true });
  await collisionReadyP;
  collisionSocket.emit('lobby:start');
  await waitFor(collisionSocket, 'state', (state) => state.phase === RACE_PHASE.RUNNING);
  const frontalCar = collisionServer.cars.get(1);
  frontalCar.x = 8.5;
  frontalCar.z = 0;
  frontalCar.yaw = Math.PI / 2;
  frontalCar.speed = 12;
  frontalCar.cp = 0;
  frontalCar.lastSafeRoad = { x: frontalCar.x, z: frontalCar.z, yaw: frontalCar.yaw };
  const impactStatePromise = waitFor(collisionSocket, 'state', (state) =>
    state.cars.find((candidate) => candidate.id === 1)?.impactSeq === 1, 10000);
  collisionSocket.emit('input', { u: 1, a: 0, impactSeq: 999, impactLevel: 1 });
  const impactState = await impactStatePromise;
  collisionSocket.emit('input', { u: 0, a: 0 });
  const impactedSnapshot = impactState.cars.find((candidate) => candidate.id === 1);
  const impactedCar = collisionServer.cars.get(1);
  ok(impactedSnapshot.speed === 0 && impactedSnapshot.cp === 0 &&
    impactedSnapshot.checkpointsHit === 1 && impactedSnapshot.checkpointsMissed === 1 &&
    impactedSnapshot.onRoad &&
    impactedSnapshot.streetName === 'Via del Test' &&
    impactedSnapshot.impactLevel > 0,
  'authoritative building impact stops the car on its named road without retaining a cancelled checkpoint hit');
  ok(impactedCar.impactSeq === 1 &&
    !collisionServer.buildingIndex.intersectsObb(impactedCar),
  'forged impact fields are ignored and recovery leaves the oriented car outside the building');
  const stableImpact = await waitFor(collisionSocket, 'state', (state) =>
    state.t > impactState.t && state.cars.find((candidate) => candidate.id === 1)?.impactSeq === 1);
  ok(stableImpact.cars.find((candidate) => candidate.id === 1).speed === 0,
    'the impact counter increments once and the recovered car stays stable on the next tick');
  collisionSocket.emit('input', { u: -1, a: 0 });
  const restartedAfterImpact = await waitFor(collisionSocket, 'state', (state) => {
    const candidate = state.cars.find((carState) => carState.id === 1);
    return candidate?.impactSeq === 1 && candidate.speed < 0;
  });
  ok(restartedAfterImpact.cars.find((candidate) => candidate.id === 1).cp === 0,
    'the recovered car can restart on the following tick without an impact loop');
  const glancingCar = collisionServer.cars.get(1);
  glancingCar.x = 10.8;
  glancingCar.z = 13.9;
  glancingCar.yaw = 0.15;
  glancingCar.speed = 12;
  glancingCar.cp = 0;
  glancingCar.lastSafeRoad = { x: 10.5, z: glancingCar.z, yaw: 0 };
  const glancingStatePromise = waitFor(collisionSocket, 'state', (state) => {
    const candidate = state.cars.find((carState) => carState.id === 1);
    return candidate?.impactSeq === 2;
  });
  collisionSocket.emit('input', { u: 1, a: 0 });
  const glancingState = await glancingStatePromise;
  const glancingSnapshot = glancingState.cars.find((candidate) => candidate.id === 1);
  ok(glancingSnapshot.speed > 0 && glancingSnapshot.cp === 0 && glancingSnapshot.onRoad &&
    !collisionServer.buildingIndex.intersectsObb(collisionServer.cars.get(1)),
  'authoritative corner impact keeps forward speed on a safe road pose without advancing checkpoints');
  const continuedGlance = await waitFor(collisionSocket, 'state', (state) => {
    const candidate = state.cars.find((carState) => carState.id === 1);
    return state.t > glancingState.t && candidate?.impactSeq === 2 &&
      candidate.speed > 0 && candidate.z < glancingSnapshot.z;
  });
  ok(continuedGlance.cars.find((candidate) => candidate.id === 1).cp === 0,
    'the bevelled car continues along the facade on the next tick without an impact loop');
  collisionSocket.disconnect();

  const sock1 = makeClient();
  const lobby1P = waitFor(sock1, 'lobby');
  await waitFor(sock1, 'connect');
  const lobby1 = await lobby1P;
  ok(lobby1.locked === false && lobby1.routeOptions.length === 8,
    'a connected pre-join client receives eight unlocked real route choices');
  const hostRouteId = lobby1.routeOptions[1].id;
  const pInit1 = waitFor(sock1, 'init');
  const joinedLobby1P = waitFor(sock1, 'lobby', (lobby) => lobby.players?.length === 1);
  sock1.emit('join', { name: '  Alice  ', color: '#AaBbCc', routeId: hostRouteId });
  const [i1, joinedLobby1] = await Promise.all([pInit1, joinedLobby1P]);
  ok(i1.you === 1, 'first player gets seat 1');
  ok(i1.host === true && i1.routeId === hostRouteId && s.route.id === hostRouteId,
    'the first player is host and fixes the selected authoritative route');
  ok(joinedLobby1.phase === 'waiting' && joinedLobby1.hostId === 1 &&
    joinedLobby1.players[0].ready === false,
  'first player enters an explicit unready lobby as host');
  ok(i1.name === 'Alice', 'name is trimmed');
  ok(i1.color === '#aabbcc', 'valid player color is normalized');
  ok(Array.isArray(i1.route) && i1.route.length === ROUTE_CHECKPOINT_COUNT * 2,
    'route delivers exactly ten checkpoints');
  ok(Array.isArray(i1.routePath) && i1.routePath.length > i1.route.length &&
    Array.isArray(i1.routeDirections) && i1.routeDirections.length > 0,
  'init delivers the raw A* path and junction directions separately from checkpoints');

  const st1 = await waitFor(sock1, 'state');
  ok(st1.phase === 'waiting' && st1.running === false, 'first player does not start countdown');
  ok(st1.countdown === START_DELAY_MAX_MS / 1000,
    'waiting lobby preserves the configured start delay');
  const duplicateInitP = waitFor(sock1, 'init');
  sock1.emit('join', { name: 'Changed', color: '#ffffff', routeId: lobby1.routeOptions[0].id });
  const duplicateInit = await duplicateInitP;
  ok(duplicateInit.you === 1 && duplicateInit.name === 'Alice' && duplicateInit.color === '#aabbcc', 'duplicate join re-emits the same player init');
  ok(JSON.stringify(duplicateInit.routeDirections) === JSON.stringify(i1.routeDirections),
    'duplicate join reuses deterministic junction directions');
  ok(duplicateInit.phase === st1.phase && duplicateInit.countdown === st1.countdown,
    'duplicate join reports the current waiting state');
  ok(s.cars.size === 1 && s.inputs.size === 1, 'duplicate join does not create ghost state');

  sock1.emit('input', { u: 2, a: -2, h: true });
  await waitFor(sock1, 'state');
  ok(s.inputs.get(1)?.u === 0 && s.inputs.get(1)?.a === 0 && s.inputs.get(1)?.h === false,
    'input including handbrake remains zero outside running');
  sock1.emit('input', { u: '1', a: Infinity });
  await waitFor(sock1, 'state');
  ok(true, 'numeric strings and non-finite input values become zero');
  sock1.emit('input', null);
  await waitFor(sock1, 'state');
  ok(true, 'null input payload is handled as an empty object');
  sock1.emit('input', []);
  await waitFor(sock1, 'state');
  ok(true, 'array input payload is handled as an empty object');

  const pos1 = st1.cars.find((c) => c.id === 1);
  sock1.emit('input', { u: 1, a: 0 });
  const frozenState = await waitFor(sock1, 'state', (d) => d.phase === 'waiting' && d.cars.some((c) => c.id === 1));
  const frozenCar = frozenState.cars.find((c) => c.id === 1);
  ok(frozenCar.speed === 0 && frozenCar.x === pos1.x && frozenCar.z === pos1.z,
    'input cannot move a car while the lobby is waiting');

  const readyP = waitFor(sock1, 'lobby', (lobby) => lobby.players?.find((player) => player.id === 1)?.ready);
  sock1.emit('lobby:ready', { ready: true });
  const readyLobby = await readyP;
  ok(readyLobby.players[0].ready, 'a valid ready command updates the authoritative lobby');

  const sock2 = makeClient();
  const lobby2P = waitFor(sock2, 'lobby');
  await waitFor(sock2, 'connect');
  const lobby2 = await lobby2P;
  ok(lobby2.locked === false && lobby2.selectedRouteId === hostRouteId && lobby2.hostId === 1,
    'later clients see the host selection while the lobby remains open');
  const pInit2 = waitFor(sock2, 'init');
  const joinedLobby2P = waitFor(sock2, 'lobby', (lobby) => lobby.players?.length === 2);
  sock2.emit('join', { routeId: lobby1.routeOptions[0].id });
  const [i2, joinedLobby2] = await Promise.all([pInit2, joinedLobby2P]);
  ok(i2.you === 2, 'second player gets seat 2');
  ok(i2.host === false && i2.routeId === hostRouteId,
    'a non-host route choice cannot replace the authoritative selection');
  ok(JSON.stringify(i2.routeDirections) === JSON.stringify(i1.routeDirections),
    'two clients receive identical junction directions');
  ok(i2.name === 'P2' && i2.color === '#3b6fe2', 'incomplete join payload uses deterministic defaults');
  ok(joinedLobby2.players.every((player) => !player.ready),
    'a changed player set resets every ready state');

  const readyBeforeRouteP = waitFor(sock1, 'lobby', (lobby) =>
    lobby.players?.length === 2 && lobby.players.every((player) => player.ready));
  sock1.emit('lobby:ready', { ready: true });
  sock2.emit('lobby:ready', { ready: true });
  await readyBeforeRouteP;
  const changedRouteId = lobby1.routeOptions[6].id;
  const changedRouteLobbyP = waitFor(sock1, 'lobby', (lobby) =>
    lobby.selectedRouteId === changedRouteId && lobby.players.every((player) => !player.ready));
  const changedRouteInit1P = waitFor(sock1, 'init', (init) => init.routeId === changedRouteId);
  const changedRouteInit2P = waitFor(sock2, 'init', (init) => init.routeId === changedRouteId);
  sock1.emit('lobby:route', { routeId: changedRouteId });
  const [changedRouteLobby, changedRouteInit1] = await Promise.all([
    changedRouteLobbyP,
    changedRouteInit1P,
    changedRouteInit2P
  ]);
  ok(s.route.id === changedRouteId && changedRouteLobby.players.every((player) => !player.ready),
    'host route change respawns the grid and resets readiness for all players');
  const routeStartDx = changedRouteInit1.routePath[2] - changedRouteInit1.routePath[0];
  const routeStartDz = changedRouteInit1.routePath[3] - changedRouteInit1.routePath[1];
  const routeStartLength = Math.hypot(routeStartDx, routeStartDz);
  const changedRouteCar = s.cars.get(1);
  const routeStartAlignment = (
    forwardX(changedRouteCar.yaw) * routeStartDx +
    forwardZ(changedRouteCar.yaw) * routeStartDz
  ) / routeStartLength;
  ok(routeStartAlignment > 0,
    'a respawned car faces the first movement segment of the selected route');

  const s3 = makeClient();
  const s4 = makeClient();
  await Promise.all([waitFor(s3, 'connect'), waitFor(s4, 'connect')]);
  const p3 = waitFor(s3, 'init');
  s3.emit('join', { name: '123456789012345', color: 'red' });
  const i3 = await p3;
  const p4 = waitFor(s4, 'init');
  s4.emit('join', { color: '\"><img src=x>' });
  const i4 = await p4;
  ok(i3.you === 3 && i4.you === 4, 'seats 3 and 4 assigned');
  ok(i3.name === '123456789012', 'player name is limited to 12 characters');
  ok(i3.color === '#e2c23b' && i4.color === '#3be26f', 'invalid colors use seat defaults');

  const s5 = makeClient();
  await waitFor(s5, 'connect');
  const fullP = waitFor(s5, 'full');
  s5.emit('join', {});
  await fullP;
  ok(true, '5th player rejected with full');

  sock2.disconnect();
  await waitUntil(() => !s.cars.has(2) && !s.inputs.has(2), 'seat 2 cleanup');
  const replacement = makeClient();
  await waitFor(replacement, 'connect');
  const replacementInitP = waitFor(replacement, 'init');
  replacement.emit('join', []);
  const replacementInit = await replacementInitP;
  ok(replacementInit.you === 2, 'disconnected seat is reused');
  ok(replacementInit.name === 'P2' && replacementInit.color === '#3b6fe2', 'array join payload uses deterministic defaults');

  const transferredHostP = waitFor(s3, 'lobby', (lobby) => lobby.hostId === 3);
  sock1.disconnect();
  const transferredHostLobby = await transferredHostP;
  await waitUntil(() => !s.cars.has(1) && !s.inputs.has(1), 'duplicate-join player cleanup');
  ok(s.cars.size === 3 && s.inputs.size === 3 && s.getHostPlayerId() === 3 &&
    transferredHostLobby.players.every((player) => !player.ready),
  'disconnecting the host transfers ownership to the oldest player and resets readiness without ghosts');

  console.log('== timing (integration) ==');
  let serverDelayDraws = 0;
  const s2 = startServer({
    random: () => {
      serverDelayDraws++;
      return 0;
    },
    staticRoot: fixtureStaticRoot,
    dataRoot: fixtureDataRoot,
    checkpoints: [[0, 0], [40, 0], [80, 0]]
  });
  trackedServers.add(s2);
  await new Promise((res) => s2.server.listen(0, res));
  const url2 = 'http://localhost:' + s2.server.address().port;
  const sockA = makeClient(url2);
  const sockB = makeClient(url2);
  await Promise.all([waitFor(sockA, 'connect'), waitFor(sockB, 'connect')]);
  const pA = waitFor(sockA, 'init');
  const pB = waitFor(sockB, 'init');
  sockA.emit('join', { name: 'Fast' });
  sockB.emit('join', { name: 'Waiting' });
  const [iA, iB] = await Promise.all([pA, pB]);
  ok(iA.route.length === 6, 'short route delivered from checkpoints');
  ok(iA.routePath.length === iA.route.length && iA.routeDirections.length === 0,
    'custom checkpoint fixtures retain a legacy path and no fabricated junction signs');
  ok(iA.phase === 'waiting' && iB.phase === 'waiting', 'two players join without starting countdown');
  ok(serverDelayDraws === 0, 'joining the lobby does not draw a start delay');
  sockB.emit('lobby:start');
  await waitFor(sockA, 'state', (state) => state.phase === 'waiting');
  ok(serverDelayDraws === 0, 'a non-host cannot start the race');
  sockA.emit('lobby:ready', { ready: 'true' });
  await waitFor(sockA, 'state', (state) => state.phase === 'waiting');
  ok(!s2.readyById.get(1), 'malformed ready payload is ignored');
  const allReadyP = waitFor(sockA, 'lobby', (lobby) =>
    lobby.players?.length === 2 && lobby.players.every((player) => player.ready));
  sockA.emit('lobby:ready', { ready: true });
  sockB.emit('lobby:ready', { ready: true });
  await allReadyP;
  sockB.emit('lobby:start');
  await waitFor(sockA, 'state', (state) => state.phase === 'waiting');
  ok(serverDelayDraws === 0, 'a ready non-host still cannot start an all-ready lobby');
  sockA.emit('lobby:start');
  const startedCountdown = await waitFor(sockA, 'state', (state) => state.phase === 'countdown');
  ok(startedCountdown.running === false && serverDelayDraws === 1,
    'the ready host starts one authoritative random countdown');
  const [lightsA, lightsB] = await Promise.all([
    waitFor(sockA, 'state', (d) => d.phase === 'countdown' && d.startLights === 3),
    waitFor(sockB, 'state', (d) => d.phase === 'countdown' && d.startLights === 3)
  ]);
  ok(lightsA.startSignal === 'red' && lightsB.startSignal === 'red' && lightsA.startLights === lightsB.startLights,
    'two clients observe the same authoritative red-light sequence');
  const countdownLate = makeClient(url2);
  await waitFor(countdownLate, 'connect');
  const countdownRejectP = waitFor(countdownLate, 'race_started');
  countdownLate.emit('join', { name: 'Too soon' });
  const countdownReject = await countdownRejectP;
  ok(countdownReject.phase === 'countdown' && s2.cars.size === 2,
    'countdown locks the grid and leaves a late player waiting for the next lobby');
  countdownLate.disconnect();
  const st0 = await waitFor(sockA, 'state', (d) => d.phase === 'running');
  ok(st0.bestMs === null, 'no best time before anyone finishes');
  const startA = st0.cars.find((c) => c.id === 1);
  sockA.emit('input', { u: 2, a: -2, h: 'true', rpm: 99999, gear: 5, brakeLevel: 1 });
  await waitUntil(() => s2.inputs.get(1)?.u === 1 && s2.inputs.get(1)?.a === -1 &&
    s2.inputs.get(1)?.h === false, 'running clamped input');
  ok(s2.cars.get(1)?.rpm !== 99999 && s2.cars.get(1)?.gear !== 5 && s2.cars.get(1)?.brakeLevel !== 1,
    'forged drivetrain fields in input cannot alter authoritative state');
  sockA.emit('input', { u: 1, a: 0 });
  const movingA = await waitFor(sockA, 'state', (d) => d.cars.find((c) => c.id === 1)?.speed > 5);
  const movingCarA = movingA.cars.find((c) => c.id === 1);
  ok(Number.isFinite(movingCarA.rpm) && Number.isInteger(movingCarA.gear) &&
    movingCarA.brakeLevel === 0 && movingCarA.handbrake === false &&
    movingCarA.surface === SURFACE.ASPHALT,
  'running snapshots expose finite authoritative drivetrain state');
  ok(Math.hypot(movingCarA.x - startA.x, movingCarA.z - startA.z) > 1, 'car moves after running begins');
  sockA.emit('input', { u: 0, a: 0, h: true });
  const handbrakingA = await waitFor(sockA, 'state', (d) => {
    const current = d.cars.find((c) => c.id === 1);
    return current?.handbrake === true && current.brakeLevel === 1 && current.speed < movingCarA.speed;
  });
  ok(s2.inputs.get(1)?.h === true && handbrakingA.cars.find((c) => c.id === 1).handbrake,
    'boolean handbrake input is stored and published by the authoritative server');
  sockA.emit('input', { u: -1, a: 0 });
  const brakingA = await waitFor(sockA, 'state', (d) => {
    const current = d.cars.find((c) => c.id === 1);
    return current?.brakeLevel > 0 && current.speed < movingCarA.speed;
  });
  ok(brakingA.cars.find((c) => c.id === 1).brakeLevel > 0,
    'server snapshots expose effective braking while speed decreases');
  sockA.emit('input', { u: 1, a: 0 });

  const lateSocket = makeClient(url2);
  await waitFor(lateSocket, 'connect');
  const raceStartedP = waitFor(lateSocket, 'race_started');
  lateSocket.emit('join', { name: 'Late' });
  const raceStarted = await raceStartedP;
  ok(raceStarted.phase === 'running' && s2.cars.size === 2, 'late join is rejected without occupying a seat');
  const runningDuplicateP = waitFor(sockA, 'init');
  sockA.emit('join', { name: 'Changed' });
  const runningDuplicate = await runningDuplicateP;
  ok(runningDuplicate.you === 1 && runningDuplicate.phase === 'running' && s2.cars.size === 2, 'assigned join stays idempotent during running');

  const skippedCar = s2.cars.get(1);
  skippedCar.x = 70;
  skippedCar.z = 0;
  skippedCar.yaw = Math.PI / 2;
  skippedCar.speed = 12;
  skippedCar.cp = 0;
  skippedCar.checkpointHits = new Set([0]);
  skippedCar.lastSafeRoad = { x: skippedCar.x, z: skippedCar.z, yaw: skippedCar.yaw };
  sockA.emit('input', { u: 1, a: 0 });
  const finA = await waitFor(sockA, 'state', (d) => d.cars.find((c) => c.id === 1)?.finished, 25000);
  const carA = finA.cars.find((c) => c.id === 1);
  ok(carA.timeMs > 0, 'finish time recorded (timeMs=' + carA.timeMs + ')');
  ok(carA.cp === 2 && carA.checkpointsHit === 2 && carA.checkpointsMissed === 1 &&
    carA.checkpointsTotal === 3 && carA.checkpointsHitPercent === 66.7 &&
    carA.checkpointsMissedPercent === 33.3,
  'crossing the finish closes the race and reports coverage even when checkpoint 2 was skipped');
  ok(carA.rpm === DRIVETRAIN.idleRpm && carA.brakeLevel === 0 && !carA.handbrake,
    'finisher drivetrain returns to idle without braking or handbrake');
  ok(finA.bestMs === carA.timeMs, 'bestMs set to first finisher');
  const finishedCarRef = s2.cars.get(1);
  const finishPosition = { x: carA.x, z: carA.z };
  sockA.emit('input', { u: -1, a: 1 });
  const afterFinish = await waitFor(sockA, 'state', (d) => d.phase === 'running' && d.t > finA.t);
  const frozenFinisher = afterFinish.cars.find((c) => c.id === 1);
  ok(frozenFinisher.x === finishPosition.x && frozenFinisher.z === finishPosition.z && frozenFinisher.speed === 0, 'input after finish cannot move the car');
  ok(s2.inputs.get(1)?.u === 0 && s2.inputs.get(1)?.a === 0 && s2.inputs.get(1)?.h === false,
    'input after finish is ignored and cleared');
  const stB = await waitFor(sockA, 'state', (d) => (d.cars.find((c) => c.id === 2)?.timeMs ?? 0) > carA.timeMs);
  ok(stB.cars.find((c) => c.id === 2).timeMs > carA.timeMs, 'second car keeps timing after first finish');

  const resultsP = waitFor(sockA, 'state', (d) => d.phase === 'results');
  sockB.disconnect();
  const resultsState = await resultsP;
  ok(resultsState.cars.length === 1 && resultsState.cars[0].finished, 'disconnecting the last non-finisher enters results');
  ok(resultsState.resultsRemaining > 4.8 && resultsState.resultsRemaining <= 5, 'results exposes the five-second remaining time');
  const resultsRejectP = waitFor(lateSocket, 'race_started');
  lateSocket.emit('join', { name: 'StillLate' });
  const resultsReject = await resultsRejectP;
  ok(resultsReject.phase === 'results', 'unassigned socket remains rejected during results');

  const nextRoundLobbyP = waitFor(sockA, 'lobby', (lobby) =>
    lobby.phase === 'waiting' && lobby.players?.length === 1 && !lobby.players[0].ready, 8000);
  const nextRoundStateP = waitFor(sockA, 'state', (d) => d.round === 1 && d.phase === 'waiting', 8000);
  const [nextRoundLobby, nextRoundState] = await Promise.all([nextRoundLobbyP, nextRoundStateP]);
  const resetCar = nextRoundState.cars.find((c) => c.id === 1);
  ok(s2.cars.get(1) !== finishedCarRef, 'new round recreates the car object');
  ok(resetCar.name === 'Fast' && resetCar.color === '#e33b3b', 'new round preserves player name and color');
  ok(!resetCar.finished && resetCar.cp === 0 && resetCar.rank === 0 && resetCar.timeMs === 0 &&
    resetCar.checkpointsHit === 1 && resetCar.checkpointsMissed === 2,
  'new round clears finish, checkpoint, rank and time while resetting checkpoint coverage to the start');
  ok(resetCar.gear === 1 && resetCar.rpm === DRIVETRAIN.idleRpm && resetCar.brakeLevel === 0 &&
    !resetCar.handbrake,
    'new round resets drivetrain state');
  ok([...s2.inputs.values()].every((input) => input.u === 0 && input.a === 0 && input.h === false),
    'all stored inputs including handbrake are zero immediately after reset');
  ok(nextRoundState.bestMs === carA.timeMs, 'session best persists across rounds');
  ok(serverDelayDraws === 1 && !nextRoundLobby.players[0].ready,
    'post-race lobby resets readiness without drawing another delay');
  const rematchReadyP = waitFor(sockA, 'lobby', (lobby) => lobby.players?.[0]?.ready === true);
  sockA.emit('lobby:ready', { ready: true });
  await rematchReadyP;
  sockA.emit('lobby:start');
  await waitFor(sockA, 'state', (d) => d.round === 1 && d.phase === 'countdown');
  ok(serverDelayDraws === 2, 'the host explicitly starts the next round with one fresh delay');

  const waitingAgainP = waitFor(lateSocket, 'state', (d) => d.phase === 'waiting' && d.cars.length === 0);
  const unlockedLobbyP = waitFor(lateSocket, 'lobby', (lobby) => lobby.locked === false);
  sockA.disconnect();
  const [waitingAgain, unlockedLobby] = await Promise.all([waitingAgainP, unlockedLobbyP]);
  ok(waitingAgain.running === false && waitingAgain.countdown === START_DELAY_MIN_MS / 1000,
    'disconnecting all players resets to waiting');
  ok(unlockedLobby.routeOptions.length === 1 && unlockedLobby.selectedRouteId === 'custom',
    'disconnecting all players unlocks route selection for the next host');
  const cleanInitP = waitFor(lateSocket, 'init');
  lateSocket.emit('join', { name: 'Fresh' });
  const cleanInit = await cleanInitP;
  ok(cleanInit.you === 1 && cleanInit.phase === 'waiting' && s2.cars.size === 1,
    'next join opens a clean waiting lobby');
  ok(serverDelayDraws === 2, 'clean lobby join does not consume random delay');
  const freshReadyP = waitFor(lateSocket, 'lobby', (lobby) => lobby.players?.[0]?.ready === true);
  lateSocket.emit('lobby:ready', { ready: true });
  await freshReadyP;
  lateSocket.emit('lobby:start');
  await waitFor(lateSocket, 'state', (state) => state.phase === 'countdown');
  ok(serverDelayDraws === 3, 'clean session draws a fresh delay only on explicit start');
  if (process.env.TEST_FORCE_FAILURE === '1') throw new Error('forced test failure');
  console.log(passed + ' tests passed');
} catch (error) {
  failure = error;
} finally {
  for (const socket of trackedSockets) {
    socket.removeAllListeners();
    socket.disconnect();
    socket.io.removeAllListeners();
    socket.io.disconnect();
    socket.io.engine?.close();
  }
  const cleanupErrors = [];
  for (const activeServer of trackedServers) {
    try {
      activeServer.io.disconnectSockets(true);
      activeServer.close();
      activeServer.server.closeAllConnections?.();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  for (const tempDir of trackedTempDirs) {
    try {
      await rm(tempDir, { recursive: true, force: true });
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  await new Promise((resolve) => setImmediate(resolve));
  if (!failure && cleanupErrors.length) {
    failure = new AggregateError(cleanupErrors, 'test cleanup failed');
  }
}

if (failure) throw failure;
