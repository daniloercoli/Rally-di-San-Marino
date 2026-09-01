import assert from 'node:assert';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ROAD_CLASSES,
  ROAD_SURFACE_COLORS,
  TRACK_SURFACE_FALLBACK_COLOR,
  UNPAVED_ROAD_COLOR,
  parseMapData
} from '../shared/mapdata.js';
import { ROAD_SHOULDER_WIDTH, RoadIndex } from '../shared/geometry.js';
import {
  BuildingIndex,
  countRoadBuildingOverlaps,
  fitBuildingFootprintsToRoads,
  projectBuildingFootprints
} from '../shared/buildings.js';
import {
  CAR_FOOTPRINT,
  sweptVehicleHull,
  vehicleObb
} from '../shared/vehicle.js';
import {
  CHECKPOINT_FILE_NAME,
  ELEVATION_SCHEMA_VERSION,
  RUNTIME_FILE_NAME,
  gridDescriptor
} from '../shared/elevation.js';
import { sha256Hex } from './elevation-store.js';
import {
  CAMERA_SURFACE_CLEARANCE,
  CAR_SURFACE_CLEARANCE,
  RENDER_ELEVATION_SCALE,
  WorldDataError,
  clampHeightAboveTerrain,
  createTerrainPositions,
  mergeWorldGeometries,
  readJsonResponse,
  surfaceHeightWithClearance,
  terrainBackdropHeight,
  terrainHeightAt,
  terrainMeshHeightAt,
  validateTerrainData
} from '../public/src/world-data.js';
import { collectBrowserPerformance, collectQaMetrics } from '../public/src/qa-metrics.js';
import { createRoadGeometryBatches, resolveRoadJunctions } from '../public/src/road-geometry.js';
import {
  buildingGray,
  buildingHeight,
  buildingPlacement,
  createBuildingWindowGeometry
} from '../public/src/building-style.js';
import { DEFAULT_WORLD_VIEW, worldViewForBounds } from '../public/src/world-view.js';
import {
  MAX_VEHICLE_TILT_RAD,
  composeVehicleAttitude,
  smoothVehicleAttitude,
  vehicleTerrainAttitude
} from '../public/src/vehicle-attitude.js';
import {
  WorldValidationError,
  runWorldValidation,
  validateElevationCoverage,
  validateRoadsData,
  validateWorldDirectory
} from './validate-world.js';

const tinyTerrainFixture = JSON.parse(await readFile(new URL('./fixtures/elevation-2x2.json', import.meta.url), 'utf8'));

let passed = 0;
function ok(condition, message) {
  assert.ok(condition, message);
  passed++;
  console.log('  ok -', message);
}

function countTerrainPenetrations(geometry, heightAt, epsilon = 1e-5) {
  const positions = geometry.getAttribute('position');
  let penetrations = 0;
  for (let index = 0; index < positions.count; index += 3) {
    const x = (positions.getX(index) + positions.getX(index + 1) + positions.getX(index + 2)) / 3;
    const y = (positions.getY(index) + positions.getY(index + 1) + positions.getY(index + 2)) / 3;
    const z = (positions.getZ(index) + positions.getZ(index + 1) + positions.getZ(index + 2)) / 3;
    if (y + epsilon < heightAt(x, z)) penetrations++;
  }
  return penetrations;
}

const tempDirs = [];
let failure = null;
let networkCalls = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => {
  networkCalls++;
  throw new Error('network access is forbidden in world validation tests');
};

function makeRoads() {
  return {
    elements: [
      {
        type: 'way',
        tags: { highway: 'residential' },
        geometry: [
          { lon: 12.44, lat: 43.94 },
          { lon: 12.445, lat: 43.94 },
          { lon: 12.45, lat: 43.94 }
        ]
      },
      { type: 'node', lon: 12.44, lat: 43.94, tags: { name: 'Alpha', place: 'village' } },
      { type: 'node', lon: 12.45, lat: 43.94, tags: { name: 'Beta', place: 'village' } }
    ]
  };
}

function makeBuildings() {
  return {
    elements: [{
      type: 'way',
      tags: { building: 'yes' },
      geometry: [
        { lon: 12.444, lat: 43.9398 },
        { lon: 12.4442, lat: 43.9398 },
        { lon: 12.4442, lat: 43.94 },
        { lon: 12.444, lat: 43.94 },
        { lon: 12.444, lat: 43.9398 }
      ]
    }]
  };
}

function makeRuntimeAsset(descriptor, roadsSha256, height = 12) {
  return {
    schemaVersion: ELEVATION_SCHEMA_VERSION,
    roadsSha256,
    originX: descriptor.originX,
    originZ: descriptor.originZ,
    cell: descriptor.cell,
    cols: descriptor.cols,
    rows: descriptor.rows,
    heights: new Array(descriptor.total).fill(height)
  };
}

function makeCheckpoint(descriptor, roadsSha256) {
  return {
    schemaVersion: ELEVATION_SCHEMA_VERSION,
    roadsSha256,
    originX: descriptor.originX,
    originZ: descriptor.originZ,
    cell: descriptor.cell,
    cols: descriptor.cols,
    rows: descriptor.rows,
    total: descriptor.total,
    completed: 2,
    elevations: [100, 101]
  };
}

function makeTinyTerrain() {
  return structuredClone(tinyTerrainFixture);
}

async function makeFixture() {
  const dataRoot = await mkdtemp(join(tmpdir(), 'test-world-'));
  tempDirs.push(dataRoot);
  const roads = makeRoads();
  const roadsRaw = JSON.stringify(roads);
  const buildings = makeBuildings();
  await writeFile(join(dataRoot, 'roads.json'), roadsRaw);
  await writeFile(join(dataRoot, 'buildings.json'), JSON.stringify(buildings));
  const map = parseMapData(roads);
  const descriptor = gridDescriptor(map.bbox);
  const roadsSha256 = await sha256Hex(roadsRaw);
  return { dataRoot, roads, buildings, map, descriptor, roadsSha256 };
}

async function expectWorldFailure(action, pattern, message) {
  let caught = null;
  try {
    await action();
  } catch (error) {
    caught = error;
  }
  ok(caught instanceof WorldValidationError && pattern.test(caught.message), message);
}

try {
  console.log('== world validator: real checkout (read-only) ==');
  const realRoot = join(process.cwd(), 'public', 'data');
  const realNamesBefore = (await readdir(realRoot)).sort();
  const realRoadsBefore = await readFile(join(realRoot, 'roads.json'), 'utf8');
  const realBuildingsBefore = await readFile(join(realRoot, 'buildings.json'), 'utf8');
  const realElevationBefore = await readFile(join(realRoot, RUNTIME_FILE_NAME), 'utf8');
  const real = await validateWorldDirectory(realRoot);
  ok(real.roads.roadCount > 0 && real.roads.checkpointCount >= 2, 'current roads and route are valid');
  ok(real.buildings.buildingCount > 0 && real.buildings.footprintCount > 0, 'current buildings have non-zero counts');
  ok(real.buildings.runtimeFootprintCount === 7451 &&
    real.buildings.adjustedFootprintCount === 2051 &&
    real.buildings.removedFootprintCount === 457 &&
    real.buildings.roadOverlapCount === 0,
  'real runtime footprints shrink away from protected roads with zero residual overlaps');
  ok(real.elevation.status === 'valid' && real.elevation.cols === 152 && real.elevation.rows === 133 &&
    real.elevation.pointCount === 20216, 'current runtime elevation is a complete 152 x 133 grid');
  ok(real.partial.checkpoint.status === 'absent' && real.partial.legacy.status === 'absent',
    'completed runtime elevation has no resume artifacts');
  ok(JSON.stringify((await readdir(realRoot)).sort()) === JSON.stringify(realNamesBefore) &&
    await readFile(join(realRoot, 'roads.json'), 'utf8') === realRoadsBefore &&
    await readFile(join(realRoot, 'buildings.json'), 'utf8') === realBuildingsBefore &&
    await readFile(join(realRoot, RUNTIME_FILE_NAME), 'utf8') === realElevationBefore,
  'validation does not modify the real data directory');
  const realMap = parseMapData(JSON.parse(realRoadsBefore));
  const realWorldView = worldViewForBounds(realMap.bbox);
  ok(realWorldView.fogNear === 2100 && realWorldView.fogFar === 10600 &&
    realWorldView.cameraFar === 14100,
  'real map bounds extend the readable fog horizon to 10.6 km and the camera to 14.1 km');
  const realUnpaved = realMap.roads.filter((road) => road.isUnpaved);
  const realTracks = realMap.roads.filter((road) => road.cls === 'track');
  const realUnclassified = realMap.roads.filter((road) => road.cls === 'unclassified');
  const realTrackSurfaceCounts = realTracks.reduce((counts, road) => {
    const surface = road.surface || '(assente)';
    counts[surface] = (counts[surface] || 0) + 1;
    return counts;
  }, {});
  ok(realUnpaved.length === 490 &&
    realUnpaved.filter((road) => road.cls === 'track').length === 486 &&
    realUnpaved.filter((road) => road.cls === 'residential').length === 2 &&
    realUnpaved.filter((road) => road.cls === 'unclassified').length === 2 &&
    realMap.roads.filter((road) => !road.isTrack && road.cls !== 'unclassified')
      .every((road) => (road.color === UNPAVED_ROAD_COLOR) === road.isUnpaved),
  'real surface tags classify exactly 490 unpaved roads without changing unrelated road classes');
  ok(realTracks.length === 489 &&
    realTrackSurfaceCounts['(assente)'] === 441 &&
    realTrackSurfaceCounts.asphalt === 3 &&
    realTrackSurfaceCounts.gravel === 20 &&
    realTrackSurfaceCounts.ground === 6 &&
    realTrackSurfaceCounts.unpaved === 12 &&
    realTrackSurfaceCounts.mud === 4 &&
    realTrackSurfaceCounts.grass_paver === 2 &&
    realTrackSurfaceCounts.ford === 1 &&
    realTracks.every((road) => road.color === (road.surface
      ? ROAD_SURFACE_COLORS[road.surface]
      : TRACK_SURFACE_FALLBACK_COLOR)),
  'all 489 real tracks use the colour selected by their surface tag or the neutral fallback');
  const realUnclassifiedSurfaceCounts = realUnclassified.reduce((counts, road) => {
    const surface = road.surface || '(assente)';
    counts[surface] = (counts[surface] || 0) + 1;
    return counts;
  }, {});
  ok(realUnclassified.length === 444 &&
    realUnclassifiedSurfaceCounts.asphalt === 313 &&
    realUnclassifiedSurfaceCounts.compacted === 2 &&
    realUnclassifiedSurfaceCounts['(assente)'] === 129 &&
    realUnclassified.every((road) => road.color === (road.surface
      ? ROAD_SURFACE_COLORS[road.surface]
      : ROAD_CLASSES.unclassified.color)),
  'all 444 unclassified roads use their surface colour and missing tags remain standard grey');
  const realTerrain = validateTerrainData(JSON.parse(realElevationBefore));
  const realTerrainHeight = (x, z) => terrainMeshHeightAt(realTerrain, x, z);
  const realRoadBatches = createRoadGeometryBatches(realMap.roads, {
    heightAt: realTerrainHeight,
    verticalScale: RENDER_ELEVATION_SCALE
  });
  ok(realRoadBatches.roadSources === 2411 && realRoadBatches.shoulderSources === 1918 &&
    realRoadBatches.junctionSources === 2277 && realRoadBatches.junctionPatches > 0 &&
    realRoadBatches.shoulderJunctionSources > 0 &&
    realRoadBatches.shoulderGeometry && realRoadBatches.roadGeometry &&
    realRoadBatches.dashGeometry && realRoadBatches.dashedSources > 0,
  '2,411 real roads, paved shoulders, 2,277 junctions and markings collapse into exactly three render geometries');
  ok(realRoadBatches.shoulderGeometry.getAttribute('position').count > 0 &&
    realRoadBatches.shoulderGeometry.getAttribute('position').array.every(Number.isFinite) &&
    realRoadBatches.roadGeometry.getAttribute('position').count > 0 &&
    realRoadBatches.roadGeometry.getAttribute('color').count === realRoadBatches.roadGeometry.getAttribute('position').count &&
    realRoadBatches.roadGeometry.getAttribute('uv').count === realRoadBatches.roadGeometry.getAttribute('position').count &&
    realRoadBatches.roadGeometry.getAttribute('position').array.every(Number.isFinite) &&
    realRoadBatches.dashGeometry.getAttribute('position').array.every(Number.isFinite),
  'merged road batch preserves finite positions, per-vertex colours and asphalt UVs');
  const realRoadTriangles = realRoadBatches.roadGeometry.getAttribute('position').count / 3;
  const realShoulderTriangles = realRoadBatches.shoulderGeometry.getAttribute('position').count / 3;
  const realDashTriangles = realRoadBatches.dashGeometry.getAttribute('position').count / 3;
  ok(countTerrainPenetrations(realRoadBatches.roadGeometry, realTerrainHeight) === 0 &&
    countTerrainPenetrations(realRoadBatches.shoulderGeometry, realTerrainHeight) === 0 &&
    countTerrainPenetrations(realRoadBatches.dashGeometry, realTerrainHeight) === 0,
  'every real road, shoulder and marking triangle centroid stays above the 1.2x terrain mesh');
  ok(realRoadTriangles + realShoulderTriangles + realDashTriangles <= 250000,
    'adaptive road draping remains bounded below 250,000 triangles');
  realRoadBatches.shoulderGeometry.dispose();
  realRoadBatches.roadGeometry.dispose();
  realRoadBatches.dashGeometry.dispose();
  const realFootprints = projectBuildingFootprints(JSON.parse(realBuildingsBefore), realMap.proj, realMap.bbox);
  const realFootprintPoints = realFootprints.reduce((total, footprint) =>
    total + footprint.outer.length + footprint.holes.reduce((sum, hole) => sum + hole.length, 0), 0);
  ok(realFootprints.length === 7908 && realFootprintPoints === 51416,
    'shared building projection matches 7,908 rendered footprints and 51,416 decimated vertices');
  const realRoadIndex = new RoadIndex(realMap.roads);
  const realFit = fitBuildingFootprintsToRoads(realFootprints, realRoadIndex);
  ok(realFit.footprints.length === 7451 && countRoadBuildingOverlaps(realFit.footprints, realRoadIndex) === 0,
    'shared fitting reproduces the validated road-safe real footprint set');
  const realBuildingIndex = new BuildingIndex(realFit.footprints);
  const maximumCellCandidates = Math.max(...[...realBuildingIndex.cells.values()].map((cell) => cell.length));
  ok(realBuildingIndex.cellSize === 50 && realBuildingIndex.size === 7451 && maximumCellCandidates <= 15,
    'default 50 metre building index keeps the real broad phase bounded');

  console.log('== shared building footprints and collision index ==');
  const identityProjection = {
    toLocal(lon, lat) {
      return { x: lon, z: lat };
    }
  };
  const buildingFixture = {
    elements: [
      {
        type: 'way', id: 1, tags: { building: 'house' },
        geometry: [
          { lon: -5, lat: -5 }, { lon: 5, lat: -5 }, { lon: 5, lat: 5 },
          { lon: -5, lat: 5 }, { lon: -5, lat: -5 }
        ]
      },
      {
        type: 'relation', id: 2, tags: { building: 'yes', type: 'multipolygon' },
        members: [
          { role: 'outer', geometry: [
            { lon: 10, lat: -10 }, { lon: 30, lat: -10 }, { lon: 30, lat: 10 },
            { lon: 10, lat: 10 }, { lon: 10, lat: -10 }
          ] },
          { role: 'inner', geometry: [
            { lon: 16, lat: -6 }, { lon: 24, lat: -6 }, { lon: 24, lat: 6 },
            { lon: 16, lat: 6 }, { lon: 16, lat: -6 }
          ] },
          { role: 'outer', geometry: [
            { lon: 40, lat: -5 }, { lon: 50, lat: -5 }, { lon: 50, lat: 5 },
            { lon: 40, lat: 5 }, { lon: 40, lat: -5 }
          ] }
        ]
      },
      { type: 'way', id: 3, tags: { building: 'yes' }, geometry: [{ lon: null, lat: 0 }] },
      { type: 'way', id: 4, tags: { building: 'yes' }, geometry: [
        { lon: 60, lat: 0 }, { lon: 61, lat: 0 }, { lon: 61, lat: 1 }, { lon: 60, lat: 0 }
      ] }
    ]
  };
  const projected = projectBuildingFootprints(buildingFixture, identityProjection, {
    minX: -100, maxX: 100, minZ: -100, maxZ: 100
  });
  ok(projected.length === 3 && projected.filter((footprint) => footprint.sourceId === 2).length === 2,
    'way and multipolygon outers become separate valid footprints while malformed/tiny rings are skipped');
  ok(projectBuildingFootprints(null, identityProjection).length === 0 &&
    new BuildingIndex([{ outer: [[0, 0]], holes: [null] }]).size === 0,
  'malformed or absent building containers produce an empty safe index');
  const courtyard = projected.find((footprint) => footprint.sourceId === 2 && footprint.holes.length === 1);
  ok(courtyard && courtyard.holes.length === 1,
    'multipolygon inner ring is associated only with the outer that contains it');
  const buildingIndex = new BuildingIndex(projected, 10);
  ok(CAR_FOOTPRINT.width === 1.8 && CAR_FOOTPRINT.length === 3.4 &&
    CAR_FOOTPRINT.halfWidth === 0.9 && CAR_FOOTPRINT.halfLength === 1.7,
  'shared car footprint is exactly 1.80 x 3.40 metres');
  const forwardObb = vehicleObb({ x: 0, z: 0, yaw: 0 });
  ok(forwardObb.length === 4 && Math.max(...forwardObb.map((point) => point[0])) === 0.9 &&
    Math.min(...forwardObb.map((point) => point[1])) === -1.7,
  'vehicle OBB follows the authoritative yaw convention towards -z');
  ok(vehicleObb({ x: Number.NaN, z: 0, yaw: 0 }) === null,
    'invalid vehicle poses cannot emit non-finite OBB vertices');
  ok(!buildingIndex.intersectsObb({ x: 20, z: 0, yaw: 0 }),
    'car OBB wholly inside a courtyard does not collide');
  ok(buildingIndex.intersectsObb({ x: 12, z: 0, yaw: 0 }) &&
    buildingIndex.intersectsObb({ x: 10, z: 0, yaw: 0 }),
  'car OBB collides with solid interior and exact building boundary');
  ok(!buildingIndex.intersectsObb({ x: 6.7, z: 0, yaw: 0 }) &&
    buildingIndex.intersectsCircle(6.7, 0, 1.88),
  'oriented footprint avoids the conservative circle false positive beside a facade');
  ok(!buildingIndex.intersectsCircle(20, 0, 1) && buildingIndex.intersectsCircle(20, 0, 5),
    'point-radius queries preserve courtyard space and detect its wall');

  const thinWall = projectBuildingFootprints({ elements: [{
    type: 'way', id: 5, tags: { building: 'yes' }, geometry: [
      { lon: -1.1, lat: -6 }, { lon: 1.1, lat: -6 }, { lon: 1.1, lat: 6 },
      { lon: -1.1, lat: 6 }, { lon: -1.1, lat: -6 }
    ]
  }] }, identityProjection, { minX: -20, maxX: 20, minZ: -20, maxZ: 20 });
  const thinWallIndex = new BuildingIndex(thinWall, 5);
  const sweptHull = sweptVehicleHull(
    { x: -8, z: 0, yaw: Math.PI / 2 },
    { x: 8, z: 0, yaw: Math.PI / 2 }
  );
  ok(sweptHull.length >= 4 && sweptHull.every((point) => point.every(Number.isFinite)),
    'swept car hull contains only finite vertices');
  ok(!thinWallIndex.intersectsObb({ x: -8, z: 0, yaw: Math.PI / 2 }) &&
    !thinWallIndex.intersectsObb({ x: 8, z: 0, yaw: Math.PI / 2 }) &&
    thinWallIndex.sweepObb(
      { x: -8, z: 0, yaw: Math.PI / 2 },
      { x: 8, z: 0, yaw: Math.PI / 2 }
    ), 'swept OBB catches a thin building wall missed by both endpoint samples');
  ok(!new BuildingIndex([]).sweepObb(
    { x: 0, z: 0, yaw: 0 },
    { x: 100, z: 100, yaw: 1 }
  ), 'absence of buildings is a finite no-collision fallback');

  console.log('== road-safe building fitting and style ==');
  const fittingRoadIndex = new RoadIndex([{
    cls: 'residential', width: 4, isTrack: false, points: [[0, -30], [0, 30]]
  }], 10);
  const fittingFixtures = [
    {
      id: 'shrink', sourceId: 10, tags: { building: 'house' },
      outer: [[3, -5], [13, -5], [13, 5], [3, 5]], holes: []
    },
    {
      id: 'remove', sourceId: 11, tags: { building: 'yes' },
      outer: [[-5, -5], [5, -5], [5, 5], [-5, 5]], holes: []
    },
    {
      id: 'safe', sourceId: 12, tags: { building: 'apartments', 'building:levels': '4' },
      outer: [[20, -5], [30, -5], [30, 5], [20, 5]], holes: []
    }
  ];
  const fittingBefore = JSON.stringify(fittingFixtures);
  const fittedFixtures = fitBuildingFootprintsToRoads(fittingFixtures, fittingRoadIndex, {
    minimumArea: 8,
    minimumScale: 0.35
  });
  ok(fittedFixtures.adjustedCount === 1 && fittedFixtures.removedCount === 1 &&
    fittedFixtures.footprints.length === 2 && JSON.stringify(fittingFixtures) === fittingBefore,
  'road fitting shrinks a recoverable footprint, removes an irreducible one and does not mutate input');
  ok(countRoadBuildingOverlaps(fittedFixtures.footprints, fittingRoadIndex) === 0 &&
    !new BuildingIndex(fittedFixtures.footprints).intersectsObb({ x: 0, z: 0, yaw: 0 }),
  'fitted collision footprints leave a protected centreline passage for the full car body');
  const grayA = buildingGray(fittedFixtures.footprints[0]);
  const grayB = buildingGray(fittedFixtures.footprints[1]);
  ok(JSON.stringify(grayA) !== JSON.stringify(grayB) && [grayA, grayB].every((color) =>
    Object.values(color).every(Number.isFinite) &&
    Math.max(color.r, color.g, color.b) - Math.min(color.r, color.g, color.b) <= 0.08),
  'building palette is deterministic, varied and remains visibly grey');
  ok(buildingHeight({ height: '14.5' }) === 14.5 &&
    buildingHeight({ 'building:levels': '4' }) === 12 && buildingHeight({}) === 9,
  'building height keeps valid OSM height/levels and a bounded fallback');
  const buildingPlacementFixture = buildingPlacement({
    tags: { height: '14.5' },
    outer: [[0, 0], [10, 0], [10, 10], [0, 10]]
  }, () => 24);
  ok(buildingPlacementFixture.baseY === 23.5 && buildingPlacementFixture.height === 14.5 &&
    buildingPlacementFixture.baseY + buildingPlacementFixture.height === 38,
  'a building base follows the rendered terrain while its OSM height remains unscaled');
  const windowGeometry = createBuildingWindowGeometry(fittedFixtures.footprints, {
    heightAt: (x, z) => x + z
  });
  ok(windowGeometry?.userData.panelCount > 0 &&
    windowGeometry.getAttribute('position').array.every(Number.isFinite) &&
    windowGeometry.getAttribute('color').count === windowGeometry.getAttribute('position').count,
  'window simulation produces one finite batched geometry with per-vertex colour');
  windowGeometry.dispose();

  console.log('== world validator: valid fixtures ==');
  const basic = await makeFixture();
  const basicResult = await validateWorldDirectory(basic.dataRoot);
  ok(basicResult.roads.roadCount === 1 && basicResult.roads.checkpointCount >= 2, 'minimal playable roads fixture passes');
  ok(basicResult.buildings.buildingCount === 1 && basicResult.buildings.footprintCount === 1 &&
    basicResult.buildings.roadOverlapCount === 0,
  'minimal buildings fixture passes after deterministic road fitting');
  ok(basicResult.elevation.status === 'absent' && basicResult.partial.checkpoint.status === 'absent', 'optional world assets may be absent');

  const complete = await makeFixture();
  await writeFile(join(complete.dataRoot, RUNTIME_FILE_NAME), JSON.stringify(makeRuntimeAsset(complete.descriptor, complete.roadsSha256)));
  await writeFile(join(complete.dataRoot, CHECKPOINT_FILE_NAME), JSON.stringify(makeCheckpoint(complete.descriptor, complete.roadsSha256)));
  const completeResult = await validateWorldDirectory(complete.dataRoot);
  ok(completeResult.elevation.status === 'valid' && completeResult.elevation.pointCount === complete.descriptor.total, 'compatible runtime elevation passes');
  ok(completeResult.partial.checkpoint.status === 'checkpoint' && completeResult.partial.checkpoint.completed === 2, 'compatible checkpoint passes');

  console.log('== world validator: negative fixtures ==');
  const corrupt = await makeFixture();
  await writeFile(join(corrupt.dataRoot, 'roads.json'), '{broken json');
  await expectWorldFailure(() => validateWorldDirectory(corrupt.dataRoot), /^roads\.json: invalid JSON/, 'corrupted JSON fails with file context');

  const shortElevation = await makeFixture();
  const shortAsset = makeRuntimeAsset(shortElevation.descriptor, shortElevation.roadsSha256);
  shortAsset.heights.pop();
  await writeFile(join(shortElevation.dataRoot, RUNTIME_FILE_NAME), JSON.stringify(shortAsset));
  await expectWorldFailure(() => validateWorldDirectory(shortElevation.dataRoot), /heights length must equal cols \* rows/, 'wrong elevation length fails');

  const nullElevation = await makeFixture();
  const nullAsset = makeRuntimeAsset(nullElevation.descriptor, nullElevation.roadsSha256);
  nullAsset.heights[0] = null;
  await writeFile(join(nullElevation.dataRoot, RUNTIME_FILE_NAME), JSON.stringify(nullAsset));
  await expectWorldFailure(() => validateWorldDirectory(nullElevation.dataRoot), /heights must contain only finite numbers/, 'null elevation fails');

  const foreignElevation = await makeFixture();
  const foreignAsset = makeRuntimeAsset(foreignElevation.descriptor, 'a'.repeat(64));
  await writeFile(join(foreignElevation.dataRoot, RUNTIME_FILE_NAME), JSON.stringify(foreignAsset));
  await expectWorldFailure(() => validateWorldDirectory(foreignElevation.dataRoot), /roads hash does not match/, 'incompatible roads hash fails');

  const badBuildings = await makeFixture();
  const brokenBuildings = makeBuildings();
  brokenBuildings.elements[0].geometry[1].lat = null;
  await writeFile(join(badBuildings.dataRoot, 'buildings.json'), JSON.stringify(brokenBuildings));
  await expectWorldFailure(() => validateWorldDirectory(badBuildings.dataRoot), /buildings\.json.*finite lon\/lat/, 'non-finite building geometry fails');

  const badRoads = makeRoads();
  badRoads.elements[0].geometry[0].lon = Infinity;
  let roadGeometryError = null;
  try {
    validateRoadsData(badRoads);
  } catch (error) {
    roadGeometryError = error;
  }
  ok(roadGeometryError instanceof WorldValidationError && /finite lon\/lat/.test(roadGeometryError.message), 'non-finite road geometry fails in the pure validator');

  const uncoveredMap = parseMapData(makeRoads());
  let coverageError = null;
  try {
    validateElevationCoverage(uncoveredMap, { originX: 0, originZ: 0, cell: 1, cols: 2, rows: 2 });
  } catch (error) {
    coverageError = error;
  }
  ok(coverageError instanceof WorldValidationError && /does not cover playable road/.test(coverageError.message), 'elevation area must cover every playable road');

  console.log('== browser world helpers: 2x2 terrain ==');
  const tinyTerrain = makeTinyTerrain();
  ok(RENDER_ELEVATION_SCALE === 1.2, 'render elevation uses the requested exact 1.2x scale');
  ok(validateTerrainData(tinyTerrain) === tinyTerrain, 'valid 2x2 terrain passes client validation');
  ok(terrainHeightAt(tinyTerrain, 5, 5) === 15, 'terrain interpolation returns the bilinear center');
  ok(terrainHeightAt(tinyTerrain, 0, 0) === 0 && terrainHeightAt(tinyTerrain, 10, 10) === 30,
    'terrain interpolation preserves opposite corners');
  ok(terrainHeightAt(tinyTerrain, 10, 5) === 20 && terrainHeightAt(tinyTerrain, 5, 10) === 25,
    'terrain interpolation handles the last row and column');
  const saddleTerrain = makeTinyTerrain();
  saddleTerrain.heights = [0, 10, 20, 100];
  ok(terrainHeightAt(saddleTerrain, 5, 5) === 32.5 &&
    terrainMeshHeightAt(saddleTerrain, 5, 5) === 18,
  'render height scales the terrain triangle by 1.2x while raw bilinear data remains available');
  ok(terrainMeshHeightAt(saddleTerrain, 7.5, 7.5) === 69,
    'render height preserves the 1.2x elevation on the second triangle inside a terrain cell');
  ok(surfaceHeightWithClearance(saddleTerrain, 5, 5, CAR_SURFACE_CLEARANCE) ===
    18 + CAR_SURFACE_CLEARANCE,
  'car surface clearance is added above the rendered terrain triangle');
  ok(clampHeightAboveTerrain(saddleTerrain, 7.5, 7.5, 10, CAMERA_SURFACE_CLEARANCE) ===
    69 + CAMERA_SURFACE_CLEARANCE &&
    clampHeightAboveTerrain(saddleTerrain, 7.5, 7.5, 80, CAMERA_SURFACE_CLEARANCE) === 80,
  'camera height is raised above steep terrain but an already safe height is preserved');
  ok(surfaceHeightWithClearance(saddleTerrain, Number.NaN, 0, 0.1, 4) === 4.1 &&
    clampHeightAboveTerrain(saddleTerrain, 0, Number.POSITIVE_INFINITY, Number.NaN, 2, 3) === 5,
  'non-finite terrain coordinates and heights use finite clearance fallbacks');
  ok(terrainHeightAt(tinyTerrain, -100, 5) === 10 && terrainHeightAt(tinyTerrain, 100, 100) === 30,
    'terrain interpolation clamps coordinates outside the grid');
  ok(terrainHeightAt(null, 5, 5) === 0, 'missing elevation uses the flat-world fallback');

  const terrainPositions = createTerrainPositions(tinyTerrain, -0.3);
  ok(terrainPositions.length === 12 && Array.from(terrainPositions).every(Number.isFinite) &&
    Math.abs(terrainPositions[4] - (10 * RENDER_ELEVATION_SCALE - 0.3)) < 1e-5 &&
    Math.abs(terrainPositions[10] - (30 * RENDER_ELEVATION_SCALE - 0.3)) < 1e-5,
  'terrain vertices apply 1.2x before the independent vertical offset');
  const negativeTerrain = makeTinyTerrain();
  negativeTerrain.heights = [-10, 0, 10, 20];
  ok(terrainBackdropHeight(negativeTerrain) === -18 && terrainBackdropHeight(null) === -6,
    'the backdrop stays six metres below the scaled terrain minimum and preserves flat fallback');

  const compactWorldView = worldViewForBounds({ minX: 0, maxX: 6000, minZ: 0, maxZ: 8000 });
  ok(compactWorldView.fogNear === 1200 && compactWorldView.fogFar === 6000 &&
    compactWorldView.cameraFar === 8000,
  'world horizon derives deterministic finite distances from map bounds');
  ok(JSON.stringify(worldViewForBounds(null)) === JSON.stringify(DEFAULT_WORLD_VIEW),
    'missing or malformed map bounds use a deterministic extended horizon fallback');

  const flatAttitude = vehicleTerrainAttitude(() => 12, { x: 0, z: 0, yaw: 0 });
  const uphillAttitude = vehicleTerrainAttitude((x, z) => -z * 0.25, {
    x: 0, z: 0, yaw: 0
  });
  const downhillAttitude = vehicleTerrainAttitude((x, z) => z * 0.25, {
    x: 0, z: 0, yaw: 0
  });
  const crossSlopeAttitude = vehicleTerrainAttitude((x) => x * 0.2, {
    x: 0, z: 0, yaw: 0
  });
  ok(flatAttitude.pitch === 0 && flatAttitude.roll === 0 &&
    Math.abs(uphillAttitude.pitch - Math.atan(0.25)) < 1e-12 &&
    uphillAttitude.roll === 0 &&
    Math.abs(downhillAttitude.pitch + Math.atan(0.25)) < 1e-12 &&
    Math.abs(crossSlopeAttitude.roll - Math.atan(0.2)) < 1e-12,
  'vehicle attitude follows flat, uphill, downhill and transverse terrain planes');

  const rotatedAttitude = vehicleTerrainAttitude((x, z) => x * 0.25 + z * 0.2, {
    x: 4, z: -3, yaw: Math.PI / 2
  });
  ok(Math.abs(rotatedAttitude.pitch - Math.atan(0.25)) < 1e-12 &&
    Math.abs(rotatedAttitude.roll - Math.atan(0.2)) < 1e-12,
  'a ninety-degree yaw rotates both longitudinal and transverse terrain samples with the car');

  const clampedAttitude = vehicleTerrainAttitude((x, z) => -z * 100, {
    x: 0, z: 0, yaw: 0
  });
  const malformedAttitudes = [
    vehicleTerrainAttitude(null, { x: 0, z: 0, yaw: 0 }),
    vehicleTerrainAttitude(() => Number.NaN, { x: 0, z: 0, yaw: 0 }),
    vehicleTerrainAttitude(() => { throw new Error('bad terrain'); }, { x: 0, z: 0, yaw: 0 }),
    vehicleTerrainAttitude(() => 0, { x: Number.NaN, z: 0, yaw: 0 })
  ];
  ok(clampedAttitude.pitch === MAX_VEHICLE_TILT_RAD &&
    malformedAttitudes.every((attitude) => attitude.pitch === 0 && attitude.roll === 0),
  'extreme slopes are bounded and malformed terrain inputs return a finite level attitude');

  const smoothingAmount = 1 - Math.exp(-1);
  const smoothedAttitude = smoothVehicleAttitude(
    { pitch: 0, roll: 0 },
    { pitch: 0.2, roll: -0.1 },
    0.1
  );
  const unchangedAttitude = smoothVehicleAttitude(
    { pitch: 0.1, roll: -0.2 },
    { pitch: 0.5, roll: 0.4 },
    Number.NaN
  );
  ok(Math.abs(smoothedAttitude.pitch - 0.2 * smoothingAmount) < 1e-12 &&
    Math.abs(smoothedAttitude.roll + 0.1 * smoothingAmount) < 1e-12 &&
    unchangedAttitude.pitch === 0.1 && unchangedAttitude.roll === -0.2,
  'vehicle attitude smoothing is frame-rate based and invalid dt preserves the current pose');

  const composedAttitude = composeVehicleAttitude(
    { pitch: 0.2, roll: -0.1 },
    { pitch: 0.03, roll: Number.NaN }
  );
  ok(Math.abs(composedAttitude.pitch - 0.23) < 1e-12 && composedAttitude.roll === -0.1 &&
    Object.values(composeVehicleAttitude(null, null)).every((value) => value === 0),
  'surface shake adds to terrain attitude without propagating malformed values');

  const shoulderFixture = createRoadGeometryBatches([{
    cls: 'residential',
    width: 10,
    y: 0.1,
    color: 0x555555,
    isTrack: false,
    points: [[0, 0], [10, 0]]
  }]);
  const shoulderPositions = shoulderFixture.shoulderGeometry.getAttribute('position');
  const roadPositions = shoulderFixture.roadGeometry.getAttribute('position');
  const shoulderColors = shoulderFixture.shoulderGeometry.getAttribute('color');
  const roadColors = shoulderFixture.roadGeometry.getAttribute('color');
  ok(Math.abs(Math.abs(shoulderPositions.getZ(0)) - (5 + ROAD_SHOULDER_WIDTH)) < 1e-6 &&
    Math.abs(Math.abs(roadPositions.getZ(0)) - 5) < 1e-6,
  'rendered paved shoulder extends exactly 1.5 metres beyond each carriageway edge');
  ok(shoulderColors.getX(0) < roadColors.getX(0) &&
    shoulderColors.getY(0) < roadColors.getY(0) &&
    shoulderColors.getZ(0) < roadColors.getZ(0),
  'the paved shoulder derives every colour channel from a darker version of its asphalt');
  shoulderFixture.shoulderGeometry.dispose();
  shoulderFixture.roadGeometry.dispose();

  const unpavedFixture = createRoadGeometryBatches([{
    cls: 'residential',
    width: 10,
    y: ROAD_CLASSES.residential.y,
    color: UNPAVED_ROAD_COLOR,
    isTrack: false,
    isUnpaved: true,
    points: [[0, 0], [10, 0]]
  }]);
  ok(unpavedFixture.shoulderGeometry === null &&
    unpavedFixture.roadGeometry.getAttribute('position').count > 0,
  'an explicitly unpaved non-track road stays brown and does not receive an asphalt shoulder');
  unpavedFixture.roadGeometry.dispose();

  const primaryJunctionRoad = {
    cls: 'primary',
    width: ROAD_CLASSES.primary.width,
    y: ROAD_CLASSES.primary.y,
    color: ROAD_CLASSES.primary.color,
    isTrack: false,
    isUnpaved: false,
    points: [[-10, 0], [0, 0], [10, 0]]
  };
  const residentialJunctionRoad = {
    cls: 'residential',
    width: ROAD_CLASSES.residential.width,
    y: ROAD_CLASSES.residential.y,
    color: ROAD_CLASSES.residential.color,
    isTrack: false,
    isUnpaved: false,
    points: [[0, -10], [0, 0], [0, 10]]
  };
  const resolvedJunctions = resolveRoadJunctions([
    residentialJunctionRoad,
    primaryJunctionRoad
  ]);
  ok(resolvedJunctions.length === 1 && resolvedJunctions[0].road === primaryJunctionRoad &&
    resolveRoadJunctions([primaryJunctionRoad]).length === 0,
  'a shared node selects the major road while a bend inside one way does not create a junction patch');
  const widerResidential = { ...residentialJunctionRoad, width: 15 };
  const narrowResidential = {
    ...residentialJunctionRoad,
    width: 11,
    points: [[-10, -10], [0, 0], [10, 10]]
  };
  ok(resolveRoadJunctions([narrowResidential, widerResidential])[0].road === widerResidential,
    'equal road classes use the wider carriageway as the deterministic junction winner');
  const junctionFixture = createRoadGeometryBatches([
    residentialJunctionRoad,
    primaryJunctionRoad
  ]);
  const junctionPositions = junctionFixture.roadGeometry.getAttribute('position');
  const junctionShoulderPositions = junctionFixture.shoulderGeometry.getAttribute('position');
  let minorRoadDistance = Infinity;
  let minorShoulderDistance = Infinity;
  let majorCoversSharedNode = false;
  for (let index = 0; index < junctionPositions.count; index++) {
    if (Math.abs(junctionPositions.getY(index) - ROAD_CLASSES.residential.y) < 1e-6) {
      minorRoadDistance = Math.min(minorRoadDistance, Math.abs(junctionPositions.getZ(index)));
    }
    if (Math.abs(junctionPositions.getY(index) - ROAD_CLASSES.primary.y) < 1e-6 &&
      Math.abs(junctionPositions.getX(index)) < 1e-6 &&
      Math.abs(Math.abs(junctionPositions.getZ(index)) - ROAD_CLASSES.primary.width / 2) < 1e-6) {
      majorCoversSharedNode = true;
    }
  }
  for (let index = 0; index < junctionShoulderPositions.count; index++) {
    if (Math.abs(junctionShoulderPositions.getY(index) -
      (ROAD_CLASSES.residential.y - 0.006)) < 1e-6) {
      minorShoulderDistance = Math.min(
        minorShoulderDistance,
        Math.abs(junctionShoulderPositions.getZ(index))
      );
    }
  }
  ok(junctionFixture.junctionSources === 1 && junctionFixture.junctionPatches === 0 &&
    junctionFixture.shoulderJunctionSources === 0 && majorCoversSharedNode &&
    minorRoadDistance >= ROAD_CLASSES.primary.width / 2 - 0.081 &&
    minorShoulderDistance >= ROAD_CLASSES.primary.width / 2 + ROAD_SHOULDER_WIDTH - 0.081,
  'the continuous major road covers the shared node while the lower class is clipped at its edge');
  junctionFixture.shoulderGeometry.dispose();
  junctionFixture.roadGeometry.dispose();

  const endpointJunctionFixture = createRoadGeometryBatches([
    residentialJunctionRoad,
    { ...primaryJunctionRoad, points: [[-10, 0], [0, 0]] }
  ]);
  const endpointPositions = endpointJunctionFixture.roadGeometry.getAttribute('position');
  const endpointCapStart = endpointPositions.count - 10 * 3;
  let endpointCapRadius = 0;
  let endpointCapUsesMajorLift = true;
  for (let index = endpointCapStart; index < endpointPositions.count; index++) {
    endpointCapRadius = Math.max(endpointCapRadius, Math.hypot(
      endpointPositions.getX(index),
      endpointPositions.getZ(index)
    ));
    endpointCapUsesMajorLift = endpointCapUsesMajorLift &&
      Math.abs(endpointPositions.getY(index) - (ROAD_CLASSES.primary.y + 0.004)) < 1e-6;
  }
  ok(endpointJunctionFixture.junctionPatches === 1 &&
    endpointJunctionFixture.shoulderJunctionSources === 1 && endpointCapUsesMajorLift &&
    endpointCapRadius > ROAD_CLASSES.primary.width / 2 &&
    endpointCapRadius < ROAD_CLASSES.primary.width / 2 + 0.1,
  'a winning endpoint uses one rounded major-road cap instead of a rectangular overlapping sheet');
  endpointJunctionFixture.shoulderGeometry.dispose();
  endpointJunctionFixture.roadGeometry.dispose();

  const ridgeHeight = (x) => Math.max(0, 20 - Math.abs(x - 50) * 0.4);
  const ridgeRoad = createRoadGeometryBatches([{
    cls: 'residential',
    width: 10,
    y: 0.05,
    color: 0x555555,
    isTrack: false,
    points: [[0, 0], [100, 0]]
  }], { heightAt: ridgeHeight });
  ok(ridgeRoad.roadGeometry.getAttribute('position').count > 6 &&
    countTerrainPenetrations(ridgeRoad.roadGeometry, ridgeHeight) === 0,
  'a long road is subdivided to remain continuously above a sharp terrain ridge');
  ridgeRoad.shoulderGeometry.dispose();
  ridgeRoad.roadGeometry.dispose();

  const invalidTerrain = makeTinyTerrain();
  invalidTerrain.heights[1] = null;
  let invalidTerrainError = null;
  try {
    validateTerrainData(invalidTerrain);
  } catch (error) {
    invalidTerrainError = error;
  }
  ok(invalidTerrainError instanceof WorldDataError && /finite numbers/.test(invalidTerrainError.message),
    'client terrain validation rejects non-finite heights');

  const shortTerrain = makeTinyTerrain();
  shortTerrain.heights.pop();
  let shortTerrainError = null;
  try {
    validateTerrainData(shortTerrain);
  } catch (error) {
    shortTerrainError = error;
  }
  ok(shortTerrainError instanceof WorldDataError && /cols \* rows/.test(shortTerrainError.message),
    'client terrain validation rejects a truncated grid');

  let coordinateError = null;
  try {
    terrainHeightAt(tinyTerrain, Number.NaN, 0);
  } catch (error) {
    coordinateError = error;
  }
  ok(coordinateError instanceof WorldDataError && /finite coordinates/.test(coordinateError.message),
    'terrain interpolation rejects non-finite coordinates');

  console.log('== browser world helpers: responses and geometry merge ==');
  const optionalMissing = await readJsonResponse({ ok: false, status: 404 }, 'elevation.json', { optional404: true });
  ok(optionalMissing.status === 'absent' && optionalMissing.data === null,
    'optional elevation 404 is an explicit absence');

  let httpError = null;
  try {
    await readJsonResponse({ ok: false, status: 503 }, 'elevation.json', { optional404: true });
  } catch (error) {
    httpError = error;
  }
  ok(httpError instanceof WorldDataError && /HTTP 503/.test(httpError.message),
    'non-404 elevation HTTP errors are diagnostic failures');

  let jsonError = null;
  try {
    await readJsonResponse({
      ok: true,
      status: 200,
      json: async () => { throw new SyntaxError('broken'); }
    }, 'elevation.json');
  } catch (error) {
    jsonError = error;
  }
  ok(jsonError instanceof WorldDataError && /invalid JSON/.test(jsonError.message),
    'malformed JSON is distinguished from an absent optional asset');

  const loadedJson = await readJsonResponse({ ok: true, status: 200, json: async () => ({ value: 1 }) }, 'roads.json');
  ok(loadedJson.status === 'loaded' && loadedJson.data.value === 1, 'successful JSON responses return parsed data');
  ok(mergeWorldGeometries([], () => { throw new Error('must not run'); }) === null,
    'an empty geometry set is handled without calling the merge utility');

  let mergeError = null;
  try {
    mergeWorldGeometries([{}], () => null);
  } catch (error) {
    mergeError = error;
  }
  ok(mergeError instanceof WorldDataError && /merge returned null/.test(mergeError.message),
    'a null geometry merge fails with an explicit diagnostic');

  const metricObjects = [
    {
      position: { x: 0, y: 1, z: 2 },
      rotation: { x: 0, y: 0, z: 0 },
      scale: { x: 1, y: 1, z: 1 },
      userData: { terrainAttitude: { pitch: 0.2, roll: -0.1 } }
    },
    { position: { x: Number.NaN, y: 0, z: 0 } }
  ];
  const qaMetrics = collectQaMetrics({
    info: { render: { frame: 90, calls: 12, triangles: 345 }, memory: { geometries: 7, textures: 2 } }
  }, {
    traverse(visitor) {
      metricObjects.forEach(visitor);
    }
  });
  ok(qaMetrics.frame === 90 && qaMetrics.drawCalls === 12 && qaMetrics.triangles === 345 && qaMetrics.sceneObjects === 2 &&
    qaMetrics.nonFiniteTransforms === 1 && qaMetrics.maxVehiclePitchDegrees === 11.46 &&
    qaMetrics.maxVehicleRollDegrees === 5.73,
  'QA metrics expose renderer counters, vehicle attitude and non-finite scene transforms');
  const browserPerformance = collectBrowserPerformance({
    memory: { usedJSHeapSize: 123456 },
    getEntriesByType(type) {
      return type === 'resource'
        ? [{ transferSize: 120, decodedBodySize: 300 }, { transferSize: 80, decodedBodySize: 200 }]
        : [];
    }
  }, { count: 2, durationMs: 91.234 });
  ok(browserPerformance.resourceCount === 2 && browserPerformance.transferBytes === 200 &&
    browserPerformance.decodedBytes === 500 && browserPerformance.usedJsHeapBytes === 123456 &&
    browserPerformance.longTasks === 2 && browserPerformance.longTaskMs === 91.23,
  'QA metrics expose resource bytes, JavaScript heap and accumulated long tasks');

  const firstError = await makeFixture();
  await writeFile(join(firstError.dataRoot, 'roads.json'), '{bad');
  await writeFile(join(firstError.dataRoot, 'buildings.json'), '{also bad');
  const output = [];
  const errors = [];
  const exitCode = await runWorldValidation({ dataRoot: firstError.dataRoot, log: (line) => output.push(line), error: (line) => errors.push(line) });
  ok(exitCode === 1 && output.length === 0 && errors.length === 1 && /^world invalid: roads\.json:/.test(errors[0]), 'CLI reports the first error clearly and exits non-zero');

  ok(networkCalls === 0, 'all world validation tests run with zero network access');
  console.log(passed + ' tests passed');
} catch (error) {
  failure = error;
  console.error('FAILED:', error.message);
} finally {
  globalThis.fetch = originalFetch;
  for (const dataRoot of tempDirs) {
    await rm(dataRoot, { recursive: true, force: true });
  }
}

if (failure) throw failure;
