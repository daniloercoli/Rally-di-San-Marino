import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { ROAD_SHOULDER_WIDTH } from '../../shared/geometry.js';
import { ROAD_CLASSES } from '../../shared/mapdata.js';

const DASHED_CLASSES = new Set([
  'primary',
  'primary_link',
  'secondary',
  'tertiary',
  'tertiary_link'
]);

const MAX_DRAPED_SEGMENT_LENGTH = 25;
const MAX_DRAPE_DEPTH = 12;
const JUNCTION_OVERLAP = 0.08;
const JUNCTION_CAP_SEGMENTS = 10;
const JUNCTION_SURFACE_LIFT = 0.004;

export const PAVED_ROAD_RENDER_COLOR = ROAD_CLASSES.residential.color;

export function roadRenderColor(road) {
  if (road?.isUnpaved && Number.isInteger(road.color)) return road.color;
  return PAVED_ROAD_RENDER_COLOR;
}

function roadPriority(road) {
  if (Number.isFinite(road.priority)) return road.priority;
  return ROAD_CLASSES[road.cls]?.priority || 0;
}

function roadHasShoulder(road) {
  return !road.isTrack && !road.isUnpaved;
}

function roadShoulderY(road) {
  return Math.max(0.005, road.y - 0.006);
}

function roadDirection(points, index) {
  const previous = points[Math.max(0, index - 1)];
  const next = points[Math.min(points.length - 1, index + 1)];
  let dx = next[0] - previous[0];
  let dz = next[1] - previous[1];
  const length = Math.hypot(dx, dz);
  if (!(length > 0)) return { dx: 1, dz: 0 };
  dx /= length;
  dz /= length;
  return { dx, dz };
}

function junctionPointKey(point) {
  return point[0].toFixed(3) + ',' + point[1].toFixed(3);
}

function roadDistances(points) {
  const distances = [0];
  for (let index = 1; index < points.length; index++) {
    distances.push(distances[index - 1] + Math.hypot(
      points[index][0] - points[index - 1][0],
      points[index][1] - points[index - 1][1]
    ));
  }
  return distances;
}

export function resolveRoadJunctions(roads) {
  const nodes = new Map();
  for (let roadIndex = 0; roadIndex < roads.length; roadIndex++) {
    const road = roads[roadIndex];
    const distances = roadDistances(road.points);
    for (let pointIndex = 0; pointIndex < road.points.length; pointIndex++) {
      const point = road.points[pointIndex];
      const key = junctionPointKey(point);
      let node = nodes.get(key);
      if (!node) {
        node = { point, incidents: new Map() };
        nodes.set(key, node);
      }
      if (!node.incidents.has(roadIndex)) {
        node.incidents.set(roadIndex, {
          road,
          roadIndex,
          distance: distances[pointIndex],
          isEndpoint: pointIndex === 0 || pointIndex === road.points.length - 1,
          direction: roadDirection(road.points, pointIndex)
        });
      }
    }
  }

  const junctions = [];
  for (const node of nodes.values()) {
    if (node.incidents.size < 2) continue;
    const incidents = [...node.incidents.values()].sort((a, b) =>
      roadPriority(b.road) - roadPriority(a.road) ||
      b.road.width - a.road.width ||
      a.roadIndex - b.roadIndex
    );
    junctions.push({
      point: node.point,
      road: incidents[0].road,
      direction: incidents[0].direction,
      roadCount: incidents.length,
      incidents
    });
  }
  junctions.sort((a, b) => a.point[0] - b.point[0] || a.point[1] - b.point[1]);
  return junctions;
}

function junctionExclusions(junctions, halfWidthFor) {
  const byRoad = new Map();
  for (const junction of junctions) {
    const winner = junction.incidents[0];
    if (winner.isEndpoint) continue;
    for (let index = 1; index < junction.incidents.length; index++) {
      const incident = junction.incidents[index];
      const crossing = Math.abs(
        winner.direction.dx * incident.direction.dz -
        winner.direction.dz * incident.direction.dx
      );
      if (crossing < 0.15) continue;
      const winningHalfWidth = halfWidthFor(winner.road);
      const hiddenDistance = Math.max(
        0,
        Math.min(winningHalfWidth / crossing, winningHalfWidth * 4) - JUNCTION_OVERLAP
      );
      let exclusions = byRoad.get(incident.roadIndex);
      if (!exclusions) {
        exclusions = [];
        byRoad.set(incident.roadIndex, exclusions);
      }
      exclusions.push({
        start: incident.distance - hiddenDistance,
        end: incident.distance + hiddenDistance
      });
    }
  }
  return byRoad;
}

function pointAtDistance(points, distances, distance) {
  if (distance <= 0) return points[0];
  const total = distances[distances.length - 1];
  if (distance >= total) return points[points.length - 1];
  let index = 0;
  while (index < distances.length - 2 && distances[index + 1] < distance) index++;
  const segmentLength = distances[index + 1] - distances[index] || 1;
  const t = (distance - distances[index]) / segmentLength;
  const point = [
    points[index][0] + (points[index + 1][0] - points[index][0]) * t,
    points[index][1] + (points[index + 1][1] - points[index][1]) * t
  ];
  if (Number.isFinite(points[index][2]) && Number.isFinite(points[index + 1][2])) {
    point.push(points[index][2] + (points[index + 1][2] - points[index][2]) * t);
  }
  return point;
}

function roadRun(points, distances, start, end) {
  if (end - start <= 0.01) return null;
  const run = [pointAtDistance(points, distances, start)];
  for (let index = 1; index < points.length - 1; index++) {
    if (distances[index] > start + 1e-6 && distances[index] < end - 1e-6) {
      run.push(points[index]);
    }
  }
  const last = pointAtDistance(points, distances, end);
  const previous = run[run.length - 1];
  if (Math.hypot(last[0] - previous[0], last[1] - previous[1]) > 0.01) run.push(last);
  return run.length >= 2 ? run : null;
}

function visibleRoadRuns(road, exclusions = []) {
  if (exclusions.length === 0) return [road.points];
  const distances = roadDistances(road.points);
  const total = distances[distances.length - 1];
  const merged = exclusions
    .map(({ start, end }) => ({
      start: Math.max(0, Math.min(total, start)),
      end: Math.max(0, Math.min(total, end))
    }))
    .filter(({ start, end }) => end > start)
    .sort((a, b) => a.start - b.start || a.end - b.end)
    .reduce((result, interval) => {
      const previous = result[result.length - 1];
      if (previous && interval.start <= previous.end) {
        previous.end = Math.max(previous.end, interval.end);
      } else {
        result.push(interval);
      }
      return result;
    }, []);
  const runs = [];
  let cursor = 0;
  for (const interval of merged) {
    const run = roadRun(road.points, distances, cursor, interval.start);
    if (run) runs.push(run);
    cursor = Math.max(cursor, interval.end);
  }
  const tail = roadRun(road.points, distances, cursor, total);
  if (tail) runs.push(tail);
  return runs;
}

function finiteHeight(heightAt, x, z) {
  const height = heightAt(x, z);
  if (!Number.isFinite(height)) throw new TypeError('heightAt must return finite values');
  return height;
}

function interpolateRail(start, end, t, heightAt, y) {
  const x = start.x + (end.x - start.x) * t;
  const z = start.z + (end.z - start.z) * t;
  return { x, y: finiteHeight(heightAt, x, z) + y, z };
}

function interpolateSection(start, end, t, heightAt, y) {
  return {
    left: interpolateRail(start.left, end.left, t, heightAt, y),
    center: interpolateRail(start.center, end.center, t, heightAt, y),
    right: interpolateRail(start.right, end.right, t, heightAt, y)
  };
}

function railHeightError(start, end, sample, t) {
  return Math.abs(sample.y - (start.y + (end.y - start.y) * t));
}

function refineSections(start, end, heightAt, y, tolerance, depth, output, knownMiddle = null) {
  const samples = [
    { t: 0.25, section: interpolateSection(start, end, 0.25, heightAt, y) },
    { t: 0.5, section: knownMiddle || interpolateSection(start, end, 0.5, heightAt, y) },
    { t: 0.75, section: interpolateSection(start, end, 0.75, heightAt, y) }
  ];
  let error = 0;
  for (const sample of samples) {
    for (const rail of ['left', 'center', 'right']) {
      error = Math.max(error, railHeightError(
        start[rail],
        end[rail],
        sample.section[rail],
        sample.t
      ));
    }
  }
  const length = Math.hypot(end.center.x - start.center.x, end.center.z - start.center.z);
  if (depth < MAX_DRAPE_DEPTH && (length > MAX_DRAPED_SEGMENT_LENGTH || error > tolerance)) {
    const middle = samples[1].section;
    refineSections(start, middle, heightAt, y, tolerance, depth + 1, output, samples[0].section);
    refineSections(middle, end, heightAt, y, tolerance, depth + 1, output, samples[2].section);
    return;
  }
  output.push(end);
}

function drapedSections(points, halfWidth, y, heightAt, verticalScale) {
  const hasProfileHeights = points.every((point) => Number.isFinite(point[2]));
  const base = [];
  for (let index = 0; index < points.length; index++) {
    const point = points[index];
    const previous = points[Math.max(0, index - 1)];
    const next = points[Math.min(points.length - 1, index + 1)];
    let dx = next[0] - previous[0];
    let dz = next[1] - previous[1];
    const length = Math.hypot(dx, dz) || 1;
    dx /= length;
    dz /= length;
    const nx = dz;
    const nz = -dx;
    const leftX = point[0] + nx * halfWidth;
    const leftZ = point[1] + nz * halfWidth;
    const rightX = point[0] - nx * halfWidth;
    const rightZ = point[1] - nz * halfWidth;
    const centerHeight = hasProfileHeights ? point[2] : finiteHeight(heightAt, point[0], point[1]);
    base.push({
      left: { x: leftX, y: hasProfileHeights ? centerHeight + y : finiteHeight(heightAt, leftX, leftZ) + y, z: leftZ },
      center: { x: point[0], y: centerHeight + y, z: point[1] },
      right: { x: rightX, y: hasProfileHeights ? centerHeight + y : finiteHeight(heightAt, rightX, rightZ) + y, z: rightZ }
    });
  }

  if (hasProfileHeights) return base;

  const sections = [base[0]];
  const tolerance = Math.max(0.002, Math.min(0.04, Math.max(0.001, y) * 0.8)) *
    verticalScale;
  for (let index = 0; index < base.length - 1; index++) {
    refineSections(base[index], base[index + 1], heightAt, y, tolerance, 0, sections);
  }
  return sections;
}

function appendRibbonQuad(positions, uvs, startA, startB, endA, endB, u0, u1, v0, v1) {
  positions.push(
    startA.x, startA.y, startA.z,
    startB.x, startB.y, startB.z,
    endA.x, endA.y, endA.z,
    startB.x, startB.y, startB.z,
    endB.x, endB.y, endB.z,
    endA.x, endA.y, endA.z
  );
  uvs.push(u0, v0, u0, v1, u1, v0, u0, v1, u1, v1, u1, v0);
}

function requiredTriangleLift(vertices, heightAt) {
  const x = vertices.reduce((sum, vertex) => sum + vertex.x, 0) / 3;
  const y = vertices.reduce((sum, vertex) => sum + vertex.y, 0) / 3;
  const z = vertices.reduce((sum, vertex) => sum + vertex.z, 0) / 3;
  return Math.max(0, finiteHeight(heightAt, x, z) + 0.001 - y);
}

function liftRibbonSections(sections, heightAt) {
  const lifts = new Float64Array(sections.length);
  for (let index = 0; index < sections.length - 1; index++) {
    const start = sections[index];
    const end = sections[index + 1];
    const lift = Math.max(
      requiredTriangleLift([start.left, start.right, end.left], heightAt),
      requiredTriangleLift([start.right, end.right, end.left], heightAt)
    );
    lifts[index] = Math.max(lifts[index], lift);
    lifts[index + 1] = Math.max(lifts[index + 1], lift);
  }
  for (let index = 0; index < sections.length; index++) {
    sections[index].left.y += lifts[index];
    sections[index].right.y += lifts[index];
  }
}

function ribbonGeometry(points, halfWidth, y, color, heightAt, verticalScale) {
  const positions = [];
  const colors = [];
  const uvs = [];
  const vertexColor = new THREE.Color(color);
  const sections = drapedSections(points, halfWidth, y, heightAt, verticalScale);
  liftRibbonSections(sections, heightAt);
  const cumulative = [0];
  for (let i = 1; i < sections.length; i++) {
    cumulative.push(cumulative[i - 1] + Math.hypot(
      sections[i].center.x - sections[i - 1].center.x,
      sections[i].center.z - sections[i - 1].center.z
    ));
  }
  const vSpan = (halfWidth * 2) / 8;
  for (let i = 0; i < sections.length - 1; i++) {
    const start = sections[i];
    const end = sections[i + 1];
    const u0 = cumulative[i] / 8;
    const u1 = cumulative[i + 1] / 8;
    appendRibbonQuad(
      positions, uvs,
      start.left, start.right, end.left, end.right,
      u0, u1, 0, vSpan
    );
    for (let k = 0; k < 6; k++) colors.push(vertexColor.r, vertexColor.g, vertexColor.b);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  return geometry;
}

function junctionCapGeometry(
  junctions,
  selectIncident,
  radiusFor,
  yFor,
  colorFor,
  heightAt,
  heightAtForRoad
) {
  const positions = [];
  const colors = [];
  const uvs = [];
  let capCount = 0;
  for (const junction of junctions) {
    const incident = selectIncident(junction);
    if (!incident) continue;
    const { road } = incident;
    const roadHeightAt = heightAtForRoad(road);
    const radius = radiusFor(road) + JUNCTION_OVERLAP;
    const cx = junction.point[0];
    const cz = junction.point[1];
    const y = yFor(road);
    const capHeight = finiteHeight(roadHeightAt, cx, cz) + y;
    const center = { x: cx, y: capHeight, z: cz };
    const ring = [];
    for (let index = 0; index < JUNCTION_CAP_SEGMENTS; index++) {
      const angle = (index / JUNCTION_CAP_SEGMENTS) * Math.PI * 2;
      const x = cx + Math.cos(angle) * radius;
      const z = cz + Math.sin(angle) * radius;
      ring.push({ x, y: capHeight, z });
    }
    let lift = 0;
    for (let index = 0; index < JUNCTION_CAP_SEGMENTS; index++) {
      lift = Math.max(lift, requiredTriangleLift([
        center,
        ring[index],
        ring[(index + 1) % JUNCTION_CAP_SEGMENTS]
      ], roadHeightAt));
    }
    const vertexColor = new THREE.Color(colorFor(road));
    for (let index = 0; index < JUNCTION_CAP_SEGMENTS; index++) {
      const next = (index + 1) % JUNCTION_CAP_SEGMENTS;
      for (const vertex of [center, ring[index], ring[next]]) {
        positions.push(vertex.x, vertex.y + lift, vertex.z);
        colors.push(vertexColor.r, vertexColor.g, vertexColor.b);
        uvs.push(vertex.x / 8, vertex.z / 8);
      }
    }
    capCount++;
  }
  if (capCount === 0) return { geometry: null, capCount };
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  return { geometry, capCount };
}

function dashGeometry(points, y, width, color, dashLength, gap, heightAt) {
  const period = dashLength + gap;
  const positions = [];
  const colors = [];
  const vertexColor = new THREE.Color(color);
  const cumulative = [0];
  for (let i = 1; i < points.length; i++) {
    cumulative.push(cumulative[i - 1] + Math.hypot(
      points[i][0] - points[i - 1][0],
      points[i][1] - points[i - 1][1]
    ));
  }
  const total = cumulative[cumulative.length - 1];
  if (total < dashLength) return null;

  const at = (distance) => {
    let index = 0;
    while (index < points.length - 2 && cumulative[index + 1] < distance) index++;
    const length = cumulative[index + 1] - cumulative[index] || 1;
    const t = (distance - cumulative[index]) / length;
    const a = points[index];
    const b = points[index + 1];
    return {
      x: a[0] + (b[0] - a[0]) * t,
      z: a[1] + (b[1] - a[1]) * t,
      roadHeight: Number.isFinite(a[2]) && Number.isFinite(b[2])
        ? a[2] + (b[2] - a[2]) * t
        : null,
      dx: (b[0] - a[0]) / length,
      dz: (b[1] - a[1]) / length
    };
  };

  for (let start = 0; start < total; start += period) {
    const end = Math.min(start + dashLength, total);
    if (end - start < 0.5) continue;
    const point1 = at(start);
    const point2 = at(end);
    const nx = (point2.dz * width) / 2;
    const nz = (-point2.dx * width) / 2;
    const quad = [
      [point1.x + nx, point1.z + nz],
      [point1.x - nx, point1.z - nz],
      [point2.x + nx, point2.z + nz],
      [point2.x - nx, point2.z - nz]
    ];
    const heights = point1.roadHeight !== null && point2.roadHeight !== null
      ? [point1.roadHeight + y, point1.roadHeight + y, point2.roadHeight + y, point2.roadHeight + y]
      : quad.map(([x, z]) => finiteHeight(heightAt, x, z) + y);
    let lift = 0;
    for (const triangle of [[0, 1, 2], [1, 3, 2]]) {
      const x = triangle.reduce((sum, index) => sum + quad[index][0], 0) / 3;
      const z = triangle.reduce((sum, index) => sum + quad[index][1], 0) / 3;
      const planeHeight = triangle.reduce((sum, index) => sum + heights[index], 0) / 3;
      lift = Math.max(lift, finiteHeight(heightAt, x, z) + 0.001 - planeHeight);
    }
    positions.push(
      quad[0][0], heights[0] + lift, quad[0][1],
      quad[1][0], heights[1] + lift, quad[1][1],
      quad[2][0], heights[2] + lift, quad[2][1],
      quad[1][0], heights[1] + lift, quad[1][1],
      quad[3][0], heights[3] + lift, quad[3][1],
      quad[2][0], heights[2] + lift, quad[2][1]
    );
    for (let k = 0; k < 6; k++) colors.push(vertexColor.r, vertexColor.g, vertexColor.b);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  return geometry;
}

function mergeBatch(geometries, merge) {
  if (geometries.length === 0) return null;
  if (geometries.length === 1) return geometries[0];
  let merged;
  try {
    merged = merge(geometries, false);
  } finally {
    for (const geometry of geometries) geometry.dispose();
  }
  if (!merged) throw new Error('road geometry merge returned null');
  merged.computeBoundingBox();
  merged.computeBoundingSphere();
  return merged;
}

export function createRoadGeometryBatches(roads, {
  heightAt = () => 0,
  heightAtForRoad = () => heightAt,
  pointsForRoad = (road) => road.points,
  verticalScale = 1,
  merge = mergeGeometries
} = {}) {
  if (!Array.isArray(roads)) throw new TypeError('roads must be an array');
  if (typeof heightAt !== 'function') throw new TypeError('heightAt must be a function');
  if (typeof heightAtForRoad !== 'function') throw new TypeError('heightAtForRoad must be a function');
  if (typeof pointsForRoad !== 'function') throw new TypeError('pointsForRoad must be a function');
  if (!Number.isFinite(verticalScale) || verticalScale <= 0) {
    throw new TypeError('verticalScale must be a finite positive number');
  }
  if (typeof merge !== 'function') throw new TypeError('merge must be a function');

  const roadGeometries = [];
  const shoulderGeometries = [];
  const dashGeometries = [];
  const junctions = resolveRoadJunctions(roads);
  const roadExclusions = junctionExclusions(junctions, (road) => road.width / 2);
  const shoulderExclusions = junctionExclusions(junctions, (road) =>
    road.width / 2 + (roadHasShoulder(road) ? ROAD_SHOULDER_WIDTH : 0)
  );
  let shoulderSources = 0;
  let dashedSources = 0;
  for (let roadIndex = 0; roadIndex < roads.length; roadIndex++) {
    const road = roads[roadIndex];
    const roadHeightAt = heightAtForRoad(road);
    if (typeof roadHeightAt !== 'function') throw new TypeError('heightAtForRoad must return a function');
    const profilePoints = pointsForRoad(road);
    if (!Array.isArray(profilePoints) || profilePoints.length < 2) continue;
    const profiledRoad = { ...road, points: profilePoints };
    const roadRuns = visibleRoadRuns(profiledRoad, roadExclusions.get(roadIndex));
    if (roadHasShoulder(road)) {
      const shoulderRuns = visibleRoadRuns(profiledRoad, shoulderExclusions.get(roadIndex));
      for (const points of shoulderRuns) {
        shoulderGeometries.push(ribbonGeometry(
          points,
          road.width / 2 + ROAD_SHOULDER_WIDTH,
          roadShoulderY(road),
          roadRenderColor(road),
          roadHeightAt,
          verticalScale
        ));
      }
      shoulderSources++;
    }
    for (const points of roadRuns) {
      roadGeometries.push(ribbonGeometry(
        points,
        road.width / 2,
        road.y,
        roadRenderColor(road),
        roadHeightAt,
        verticalScale
      ));
    }
    if (!DASHED_CLASSES.has(road.cls)) continue;
    let roadHasDashes = false;
    for (const points of roadRuns) {
      const dashed = dashGeometry(points, road.y + 0.01, 0.16, 0xd9d9d9, 3.5, 9, roadHeightAt);
      if (dashed) {
        dashGeometries.push(dashed);
        roadHasDashes = true;
      }
    }
    if (roadHasDashes) dashedSources++;
  }

  const shoulderCaps = junctionCapGeometry(
    junctions,
    (junction) => junction.incidents[0].isEndpoint && roadHasShoulder(junction.incidents[0].road)
      ? junction.incidents[0]
      : null,
    (road) => road.width / 2 + ROAD_SHOULDER_WIDTH,
    (road) => roadShoulderY(road) + JUNCTION_SURFACE_LIFT,
    roadRenderColor,
    heightAt,
    heightAtForRoad
  );
  if (shoulderCaps.geometry) shoulderGeometries.push(shoulderCaps.geometry);
  const roadCaps = junctionCapGeometry(
    junctions,
    (junction) => junction.incidents[0].isEndpoint ? junction.incidents[0] : null,
    (road) => road.width / 2,
    (road) => road.y + JUNCTION_SURFACE_LIFT,
    roadRenderColor,
    heightAt,
    heightAtForRoad
  );
  if (roadCaps.geometry) roadGeometries.push(roadCaps.geometry);

  return {
    shoulderGeometry: mergeBatch(shoulderGeometries, merge),
    roadGeometry: mergeBatch(roadGeometries, merge),
    dashGeometry: mergeBatch(dashGeometries, merge),
    roadSources: roads.length,
    shoulderSources,
    dashedSources,
    junctionSources: junctions.length,
    junctionPatches: roadCaps.capCount,
    shoulderJunctionSources: shoulderCaps.capCount
  };
}
