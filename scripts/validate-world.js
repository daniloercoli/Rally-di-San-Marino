import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ROAD_CLASSES, parseMapData } from '../shared/mapdata.js';
import { RoadIndex } from '../shared/geometry.js';
import {
  countRoadBuildingOverlaps,
  fitBuildingFootprintsToRoads,
  projectBuildingFootprints
} from '../shared/buildings.js';
import { RoadGraph, pickRoute } from '../shared/route.js';
import {
  CHECKPOINT_FILE_NAME,
  LEGACY_FILE_NAME,
  RUNTIME_FILE_NAME,
  gridDescriptor,
  validateCheckpoint,
  validateLegacySource,
  validateRuntimeAsset
} from '../shared/elevation.js';
import { sha256Hex } from './elevation-store.js';

const DEFAULT_DATA_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'data');

export class WorldValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'WorldValidationError';
  }
}

function fail(label, message) {
  throw new WorldValidationError(label + ': ' + message);
}

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(label, 'root must be a JSON object');
  }
}

function validateGeometry(geometry, label, minimumPoints = 1) {
  if (!Array.isArray(geometry)) fail(label, 'geometry must be an array');
  if (geometry.length < minimumPoints) {
    fail(label, 'geometry must contain at least ' + minimumPoints + ' points');
  }
  for (let i = 0; i < geometry.length; i++) {
    const point = geometry[i];
    if (!point || typeof point !== 'object' ||
        typeof point.lon !== 'number' || !Number.isFinite(point.lon) ||
        typeof point.lat !== 'number' || !Number.isFinite(point.lat)) {
      fail(label, 'geometry point ' + i + ' must contain finite lon/lat numbers');
    }
  }
  return geometry.length;
}

function finiteMapResult(map) {
  const bboxKeys = ['minX', 'maxX', 'minZ', 'maxZ'];
  const projectionKeys = ['centerLon', 'centerLat', 'kLon'];
  return bboxKeys.every((key) => Number.isFinite(map?.bbox?.[key])) &&
    projectionKeys.every((key) => Number.isFinite(map?.proj?.[key])) &&
    map.bbox.maxX > map.bbox.minX && map.bbox.maxZ > map.bbox.minZ &&
    map.proj.kLon > 0;
}

export function validateRoadsData(raw) {
  requireObject(raw, 'roads.json');
  if (!Array.isArray(raw.elements)) fail('roads.json', 'elements must be an array');

  let sourceGeometryCount = 0;
  let sourceCoordinateCount = 0;
  for (let i = 0; i < raw.elements.length; i++) {
    const element = raw.elements[i];
    if (!element || typeof element !== 'object' || Array.isArray(element)) {
      fail('roads.json', 'element ' + i + ' must be an object');
    }
    if (element.geometry !== undefined) {
      sourceCoordinateCount += validateGeometry(element.geometry, 'roads.json element ' + i);
      sourceGeometryCount++;
    }
    const playable = element.type === 'way' && ROAD_CLASSES[element.tags?.highway];
    if (playable && !Array.isArray(element.geometry)) {
      fail('roads.json element ' + i, 'playable road is missing geometry');
    }
    const namedPlace = element.type === 'node' && element.tags?.name && element.tags?.place;
    if (namedPlace && (!Number.isFinite(element.lon) || !Number.isFinite(element.lat))) {
      fail('roads.json element ' + i, 'named place must contain finite lon/lat numbers');
    }
  }

  let map;
  try {
    map = parseMapData(raw);
  } catch (error) {
    fail('roads.json', 'map parsing failed (' + error.message + ')');
  }
  if (!finiteMapResult(map)) fail('roads.json', 'bbox and projection must be finite and non-degenerate');
  if (!Array.isArray(map.roads) || map.roads.length === 0) {
    fail('roads.json', 'must contain at least one playable road');
  }
  for (let i = 0; i < map.roads.length; i++) {
    for (let j = 0; j < map.roads[i].points.length; j++) {
      const point = map.roads[i].points[j];
      if (!Array.isArray(point) || !Number.isFinite(point[0]) || !Number.isFinite(point[1])) {
        fail('roads.json', 'projected road geometry must be finite');
      }
    }
  }

  let route;
  try {
    route = pickRoute(new RoadGraph(map.roads), map);
  } catch (error) {
    fail('roads.json', 'route validation failed (' + error.message + ')');
  }
  if (!Array.isArray(route.checkpoints) || route.checkpoints.length < 2 ||
      route.checkpoints.some((point) => !Array.isArray(point) ||
        !Number.isFinite(point[0]) || !Number.isFinite(point[1]))) {
    fail('roads.json', 'route must contain at least two finite checkpoints');
  }

  return {
    map,
    route,
    roadCount: map.roads.length,
    placeCount: map.places.length,
    checkpointCount: route.checkpoints.length,
    sourceGeometryCount,
    sourceCoordinateCount
  };
}

export function validateBuildingsData(raw) {
  requireObject(raw, 'buildings.json');
  if (!Array.isArray(raw.elements)) fail('buildings.json', 'elements must be an array');

  let buildingCount = 0;
  let footprintCount = 0;
  let geometryCount = 0;
  let coordinateCount = 0;
  for (let i = 0; i < raw.elements.length; i++) {
    const element = raw.elements[i];
    if (!element || typeof element !== 'object' || Array.isArray(element)) {
      fail('buildings.json', 'element ' + i + ' must be an object');
    }
    if (element.geometry !== undefined) {
      coordinateCount += validateGeometry(element.geometry, 'buildings.json element ' + i);
      geometryCount++;
    }
    if (element.type === 'relation' && element.members !== undefined) {
      if (!Array.isArray(element.members)) fail('buildings.json element ' + i, 'members must be an array');
      for (let j = 0; j < element.members.length; j++) {
        const member = element.members[j];
        if (!member || typeof member !== 'object' || Array.isArray(member)) {
          fail('buildings.json element ' + i, 'member ' + j + ' must be an object');
        }
        if (member.geometry !== undefined) {
          coordinateCount += validateGeometry(member.geometry, 'buildings.json element ' + i + ' member ' + j);
          geometryCount++;
        }
      }
    }

    const isBuilding = element.tags?.building && element.tags.building !== 'no';
    if (!isBuilding) continue;
    buildingCount++;
    if (element.type === 'way') {
      validateGeometry(element.geometry, 'buildings.json element ' + i, 3);
      footprintCount++;
    } else if (element.type === 'relation') {
      if (!Array.isArray(element.members)) fail('buildings.json element ' + i, 'building relation must contain members');
      let outerCount = 0;
      for (let j = 0; j < element.members.length; j++) {
        const member = element.members[j];
        if (member?.role !== 'outer') continue;
        validateGeometry(member.geometry, 'buildings.json element ' + i + ' outer member ' + j, 3);
        outerCount++;
      }
      if (outerCount === 0) fail('buildings.json element ' + i, 'building relation must contain an outer geometry');
      footprintCount += outerCount;
    } else {
      fail('buildings.json element ' + i, 'building must be a way or relation');
    }
  }
  if (buildingCount === 0) fail('buildings.json', 'must contain at least one building');
  if (footprintCount === 0 || geometryCount === 0 || coordinateCount === 0) {
    fail('buildings.json', 'building and geometry counts must be non-zero');
  }
  return { buildingCount, footprintCount, geometryCount, coordinateCount };
}

export function validateElevationCoverage(map, asset) {
  if (!asset || !Number.isFinite(asset.originX) || !Number.isFinite(asset.originZ) ||
      !Number.isFinite(asset.cell) || asset.cell <= 0 ||
      !Number.isInteger(asset.cols) || asset.cols < 2 ||
      !Number.isInteger(asset.rows) || asset.rows < 2) {
    fail('elevation.json', 'grid area must have finite origin/cell and at least 2 x 2 points');
  }
  const maxX = asset.originX + (asset.cols - 1) * asset.cell;
  const maxZ = asset.originZ + (asset.rows - 1) * asset.cell;
  const epsilon = 1e-6;
  for (let roadIndex = 0; roadIndex < map.roads.length; roadIndex++) {
    for (let pointIndex = 0; pointIndex < map.roads[roadIndex].points.length; pointIndex++) {
      const [x, z] = map.roads[roadIndex].points[pointIndex];
      if (x < asset.originX - epsilon || x > maxX + epsilon ||
          z < asset.originZ - epsilon || z > maxZ + epsilon) {
        fail('elevation.json', 'grid area does not cover playable road ' + roadIndex + ' point ' + pointIndex);
      }
    }
  }
  return { minX: asset.originX, maxX, minZ: asset.originZ, maxZ };
}

export function validateElevationData(raw, descriptor, roadsSha256, map) {
  const check = validateRuntimeAsset(raw, descriptor, roadsSha256);
  if (!check.ok) fail('elevation.json', check.reason);
  const coverage = validateElevationCoverage(map, raw);
  return {
    status: 'valid',
    cols: raw.cols,
    rows: raw.rows,
    pointCount: raw.heights.length,
    coverage
  };
}

async function readJson(filePath, label, optional = false) {
  let raw;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (error) {
    if (optional && error.code === 'ENOENT') return { present: false, raw: null, data: null };
    if (error.code === 'ENOENT') fail(label, 'file not found');
    fail(label, 'cannot be read (' + error.message + ')');
  }
  try {
    return { present: true, raw, data: JSON.parse(raw) };
  } catch (error) {
    fail(label, 'invalid JSON (' + error.message + ')');
  }
}

export async function validateWorldDirectory(dataRoot = DEFAULT_DATA_ROOT) {
  const resolvedRoot = resolve(dataRoot);
  const roadsFile = await readJson(join(resolvedRoot, 'roads.json'), 'roads.json');
  const roads = validateRoadsData(roadsFile.data);
  const roadsSha256 = await sha256Hex(roadsFile.raw);
  let descriptor;
  try {
    descriptor = gridDescriptor(roads.map.bbox);
  } catch (error) {
    fail('roads.json', 'elevation grid cannot be derived (' + error.message + ')');
  }

  const buildingsFile = await readJson(join(resolvedRoot, 'buildings.json'), 'buildings.json');
  const buildings = validateBuildingsData(buildingsFile.data);
  const projectedFootprints = projectBuildingFootprints(
    buildingsFile.data,
    roads.map.proj,
    roads.map.bbox
  );
  const roadIndex = new RoadIndex(roads.map.roads);
  const buildingFit = fitBuildingFootprintsToRoads(projectedFootprints, roadIndex);
  const roadOverlapCount = countRoadBuildingOverlaps(buildingFit.footprints, roadIndex);
  if (roadOverlapCount > 0) {
    fail('buildings.json', roadOverlapCount + ' fitted footprints still overlap protected road corridors');
  }
  buildings.runtimeFootprintCount = buildingFit.footprints.length;
  buildings.adjustedFootprintCount = buildingFit.adjustedCount;
  buildings.removedFootprintCount = buildingFit.removedCount;
  buildings.roadOverlapCount = roadOverlapCount;

  const elevationFile = await readJson(join(resolvedRoot, RUNTIME_FILE_NAME), RUNTIME_FILE_NAME, true);
  const elevation = elevationFile.present
    ? validateElevationData(elevationFile.data, descriptor, roadsSha256, roads.map)
    : { status: 'absent', optional: true };

  const checkpointFile = await readJson(join(resolvedRoot, CHECKPOINT_FILE_NAME), CHECKPOINT_FILE_NAME, true);
  let checkpoint = { status: 'absent' };
  if (checkpointFile.present) {
    const check = validateCheckpoint(checkpointFile.data, descriptor, roadsSha256);
    if (!check.ok) fail(CHECKPOINT_FILE_NAME, check.reason);
    checkpoint = {
      status: 'checkpoint',
      completed: checkpointFile.data.completed,
      total: checkpointFile.data.total
    };
  }

  const legacyFile = await readJson(join(resolvedRoot, LEGACY_FILE_NAME), LEGACY_FILE_NAME, true);
  let legacy = { status: 'absent' };
  if (legacyFile.present) {
    const partialSha256 = await sha256Hex(legacyFile.raw);
    const check = validateLegacySource(roadsSha256, partialSha256, legacyFile.data);
    if (!check.ok) fail(LEGACY_FILE_NAME, check.reason);
    legacy = {
      status: 'legacy',
      completed: legacyFile.data.length,
      total: descriptor.total
    };
  }

  return {
    dataRoot: resolvedRoot,
    roadsSha256,
    grid: descriptor,
    roads: {
      roadCount: roads.roadCount,
      placeCount: roads.placeCount,
      checkpointCount: roads.checkpointCount,
      start: roads.route.start.name,
      end: roads.route.end.name,
      sourceGeometryCount: roads.sourceGeometryCount,
      sourceCoordinateCount: roads.sourceCoordinateCount
    },
    buildings,
    elevation,
    partial: { checkpoint, legacy }
  };
}

export function formatWorldSummary(summary) {
  const elevation = summary.elevation.status === 'valid'
    ? 'elevation=valid ' + summary.elevation.cols + 'x' + summary.elevation.rows
    : 'elevation=absent (optional)';
  const partialStates = [];
  if (summary.partial.checkpoint.status === 'checkpoint') {
    partialStates.push('checkpoint ' + summary.partial.checkpoint.completed + '/' + summary.partial.checkpoint.total);
  }
  if (summary.partial.legacy.status === 'legacy') {
    partialStates.push('legacy ' + summary.partial.legacy.completed + '/' + summary.partial.legacy.total);
  }
  if (partialStates.length === 0) partialStates.push('absent');
  return 'world valid: roads=' + summary.roads.roadCount +
    '; route=' + summary.roads.start + ' -> ' + summary.roads.end +
    ' (' + summary.roads.checkpointCount + ' checkpoints)' +
    '; buildings=' + summary.buildings.buildingCount +
    ' (' + summary.buildings.runtimeFootprintCount + ' runtime footprints, ' +
    summary.buildings.adjustedFootprintCount + ' adjusted, ' +
    summary.buildings.removedFootprintCount + ' removed)' +
    '; ' + elevation + '; partial=' + partialStates.join(', ');
}

export async function runWorldValidation({
  dataRoot = DEFAULT_DATA_ROOT,
  log = console.log,
  error: errorLog = console.error
} = {}) {
  try {
    const summary = await validateWorldDirectory(dataRoot);
    log(formatWorldSummary(summary));
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    errorLog('world invalid: ' + message);
    return 1;
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) process.exitCode = await runWorldValidation();
