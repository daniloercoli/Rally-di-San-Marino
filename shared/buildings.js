import {
  CAR_FOOTPRINT,
  sweptVehicleHull,
  vehicleObb
} from './vehicle.js';

export const BUILDING_INDEX_CELL_SIZE = 50;
export const BUILDING_RING_MIN_DISTANCE = 2;
export const BUILDING_MIN_AREA = 8;
export const BUILDING_ROAD_CLEARANCE = CAR_FOOTPRINT.halfWidth + 1;
export const BUILDING_MIN_ROAD_SCALE = 0.35;

const GEOMETRY_EPSILON = 1e-9;

function finitePoint(point) {
  return Array.isArray(point) && Number.isFinite(point[0]) && Number.isFinite(point[1]);
}

function validRing(ring) {
  return Array.isArray(ring) && ring.length >= 3 && ring.every(finitePoint);
}

function ringArea(ring) {
  let area = 0;
  for (let i = 0; i < ring.length; i++) {
    const next = ring[(i + 1) % ring.length];
    area += ring[i][0] * next[1] - next[0] * ring[i][1];
  }
  return area / 2;
}

function ringBounds(ring) {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const point of ring) {
    minX = Math.min(minX, point[0]);
    maxX = Math.max(maxX, point[0]);
    minZ = Math.min(minZ, point[1]);
    maxZ = Math.max(maxZ, point[1]);
  }
  return { minX, maxX, minZ, maxZ };
}

function pointOnSegment(point, a, b) {
  const abx = b[0] - a[0];
  const abz = b[1] - a[1];
  const apx = point[0] - a[0];
  const apz = point[1] - a[1];
  const scale = Math.max(1, Math.abs(abx), Math.abs(abz), Math.abs(apx), Math.abs(apz));
  if (Math.abs(abx * apz - abz * apx) > GEOMETRY_EPSILON * scale * scale) return false;
  return point[0] >= Math.min(a[0], b[0]) - GEOMETRY_EPSILON &&
    point[0] <= Math.max(a[0], b[0]) + GEOMETRY_EPSILON &&
    point[1] >= Math.min(a[1], b[1]) - GEOMETRY_EPSILON &&
    point[1] <= Math.max(a[1], b[1]) + GEOMETRY_EPSILON;
}

function pointInRingInterior(point, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if ((a[1] > point[1]) !== (b[1] > point[1]) &&
      point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]) {
      inside = !inside;
    }
  }
  return inside;
}

export function pointInRing(point, ring) {
  if (!finitePoint(point) || !validRing(ring)) return false;
  for (let i = 0; i < ring.length; i++) {
    if (pointOnSegment(point, ring[i], ring[(i + 1) % ring.length])) return true;
  }
  return pointInRingInterior(point, ring);
}

function projectRing(geometry, projection, minimumDistance) {
  if (!Array.isArray(geometry) || geometry.length < 3 || typeof projection?.toLocal !== 'function') return null;
  const projected = [];
  for (const source of geometry) {
    if (!source || !Number.isFinite(source.lon) || !Number.isFinite(source.lat)) return null;
    let point;
    try {
      point = projection.toLocal(source.lon, source.lat);
    } catch {
      return null;
    }
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.z)) return null;
    projected.push([point.x, point.z]);
  }

  const last = projected[projected.length - 1];
  if (projected.length > 2 && projected[0][0] === last[0] && projected[0][1] === last[1]) {
    projected.pop();
  }
  if (projected.length < 3) return null;

  const minimumDistanceSquared = minimumDistance * minimumDistance;
  const decimated = [projected[0]];
  for (let i = 1; i < projected.length; i++) {
    const previous = decimated[decimated.length - 1];
    const dx = projected[i][0] - previous[0];
    const dz = projected[i][1] - previous[1];
    if (dx * dx + dz * dz >= minimumDistanceSquared) decimated.push(projected[i]);
  }
  return decimated.length >= 3 ? decimated : null;
}

function finiteBbox(bbox) {
  return !!bbox && Number.isFinite(bbox.minX) && Number.isFinite(bbox.maxX) &&
    Number.isFinite(bbox.minZ) && Number.isFinite(bbox.maxZ) &&
    bbox.maxX >= bbox.minX && bbox.maxZ >= bbox.minZ;
}

function ringCenter(ring) {
  let x = 0;
  let z = 0;
  for (const point of ring) {
    x += point[0];
    z += point[1];
  }
  return { x: x / ring.length, z: z / ring.length };
}

function outerContainsHole(outer, hole) {
  for (const point of hole) {
    if (pointInRing(point, outer)) return true;
  }
  const center = ringCenter(hole);
  return pointInRing([center.x, center.z], outer);
}

export function projectBuildingFootprints(raw, projection, bbox, {
  minimumDistance = BUILDING_RING_MIN_DISTANCE,
  minimumArea = BUILDING_MIN_AREA
} = {}) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.elements) ||
    typeof projection?.toLocal !== 'function') return [];
  const safeMinimumDistance = Number.isFinite(minimumDistance) && minimumDistance >= 0
    ? minimumDistance
    : BUILDING_RING_MIN_DISTANCE;
  const safeMinimumArea = Number.isFinite(minimumArea) && minimumArea >= 0
    ? minimumArea
    : BUILDING_MIN_AREA;
  const hasBbox = finiteBbox(bbox);
  const footprints = [];

  for (let elementIndex = 0; elementIndex < raw.elements.length; elementIndex++) {
    const element = raw.elements[elementIndex];
    if (!element || typeof element !== 'object' || !element.tags?.building ||
      element.tags.building === 'no') continue;

    let members;
    if (element.type === 'way' && Array.isArray(element.geometry)) {
      members = [{ role: 'outer', geometry: element.geometry }];
    } else if (element.type === 'relation' && Array.isArray(element.members)) {
      members = element.members.filter((member) => member &&
        (member.role === 'outer' || member.role === 'inner') && Array.isArray(member.geometry));
    } else {
      continue;
    }

    const outers = [];
    const inners = [];
    for (let memberIndex = 0; memberIndex < members.length; memberIndex++) {
      const member = members[memberIndex];
      const ring = projectRing(member.geometry, projection, safeMinimumDistance);
      if (!ring) continue;
      if (member.role === 'outer') {
        if (Math.abs(ringArea(ring)) < safeMinimumArea) continue;
        const center = ringCenter(ring);
        if (hasBbox && (center.x < bbox.minX || center.x > bbox.maxX ||
          center.z < bbox.minZ || center.z > bbox.maxZ)) continue;
        outers.push({ ring, memberIndex });
      } else {
        inners.push(ring);
      }
    }

    const holes = outers.map(() => []);
    for (const inner of inners) {
      const owner = outers.findIndex((outer) => outerContainsHole(outer.ring, inner));
      if (owner !== -1) holes[owner].push(inner);
    }

    for (let outerIndex = 0; outerIndex < outers.length; outerIndex++) {
      const outer = outers[outerIndex];
      footprints.push({
        id: elementIndex + ':' + outer.memberIndex,
        sourceId: element.id ?? null,
        sourceType: element.type,
        tags: element.tags,
        outer: outer.ring,
        holes: holes[outerIndex],
        bounds: ringBounds(outer.ring)
      });
    }
  }
  return footprints;
}

function squaredDistanceToSegment(point, a, b) {
  const abx = b[0] - a[0];
  const abz = b[1] - a[1];
  const len2 = abx * abx + abz * abz;
  const t = len2 > 0
    ? Math.max(0, Math.min(1, ((point[0] - a[0]) * abx + (point[1] - a[1]) * abz) / len2))
    : 0;
  const dx = point[0] - (a[0] + abx * t);
  const dz = point[1] - (a[1] + abz * t);
  return dx * dx + dz * dz;
}

function ringWithinRadius(point, radiusSquared, ring) {
  for (let i = 0; i < ring.length; i++) {
    if (squaredDistanceToSegment(point, ring[i], ring[(i + 1) % ring.length]) <=
      radiusSquared + GEOMETRY_EPSILON) return true;
  }
  return false;
}

export function pointInBuildingFootprint(point, footprint) {
  if (!finitePoint(point) || !footprint || !validRing(footprint.outer)) return false;
  for (let i = 0; i < footprint.outer.length; i++) {
    if (pointOnSegment(point, footprint.outer[i], footprint.outer[(i + 1) % footprint.outer.length])) {
      return true;
    }
  }
  if (!pointInRingInterior(point, footprint.outer)) return false;
  for (const hole of (footprint.holes || []).filter(validRing)) {
    for (let i = 0; i < hole.length; i++) {
      if (pointOnSegment(point, hole[i], hole[(i + 1) % hole.length])) return true;
    }
    if (pointInRingInterior(point, hole)) return false;
  }
  return true;
}

export function circleIntersectsBuildingFootprint(x, z, radius, footprint) {
  if (!Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(radius) || radius < 0 ||
    !footprint || !validRing(footprint.outer)) return false;
  const point = [x, z];
  if (pointInBuildingFootprint(point, footprint)) return true;
  const radiusSquared = radius * radius;
  if (ringWithinRadius(point, radiusSquared, footprint.outer)) return true;
  return (footprint.holes || []).filter(validRing)
    .some((hole) => ringWithinRadius(point, radiusSquared, hole));
}

function orientation(a, b, c) {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function segmentsIntersect(a, b, c, d) {
  const abC = orientation(a, b, c);
  const abD = orientation(a, b, d);
  const cdA = orientation(c, d, a);
  const cdB = orientation(c, d, b);
  if (((abC > GEOMETRY_EPSILON && abD < -GEOMETRY_EPSILON) ||
      (abC < -GEOMETRY_EPSILON && abD > GEOMETRY_EPSILON)) &&
    ((cdA > GEOMETRY_EPSILON && cdB < -GEOMETRY_EPSILON) ||
      (cdA < -GEOMETRY_EPSILON && cdB > GEOMETRY_EPSILON))) return true;
  return (Math.abs(abC) <= GEOMETRY_EPSILON && pointOnSegment(c, a, b)) ||
    (Math.abs(abD) <= GEOMETRY_EPSILON && pointOnSegment(d, a, b)) ||
    (Math.abs(cdA) <= GEOMETRY_EPSILON && pointOnSegment(a, c, d)) ||
    (Math.abs(cdB) <= GEOMETRY_EPSILON && pointOnSegment(b, c, d));
}

function ringsIntersect(a, b) {
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) {
      if (segmentsIntersect(a[i], a[(i + 1) % a.length], b[j], b[(j + 1) % b.length])) {
        return true;
      }
    }
  }
  return false;
}

export function polygonIntersectsBuildingFootprint(polygon, footprint) {
  if (!validRing(polygon) || !footprint || !validRing(footprint.outer)) return false;
  if (polygon.some((point) => pointInBuildingFootprint(point, footprint))) return true;
  if (ringsIntersect(polygon, footprint.outer)) return true;
  for (const hole of (footprint.holes || []).filter(validRing)) {
    if (ringsIntersect(polygon, hole)) return true;
  }
  return footprint.outer.some((point) => pointInRing(point, polygon));
}

function roadCorridorPolygon(segment, clearance) {
  const dx = segment.bx - segment.ax;
  const dz = segment.bz - segment.az;
  const length = Math.hypot(dx, dz);
  const ux = length > GEOMETRY_EPSILON ? dx / length : 1;
  const uz = length > GEOMETRY_EPSILON ? dz / length : 0;
  const nx = uz;
  const nz = -ux;
  const radius = Math.max(0, segment.halfW + clearance);
  const ax = segment.ax - ux * radius;
  const az = segment.az - uz * radius;
  const bx = segment.bx + ux * radius;
  const bz = segment.bz + uz * radius;
  return [
    [ax + nx * radius, az + nz * radius],
    [ax - nx * radius, az - nz * radius],
    [bx - nx * radius, bz - nz * radius],
    [bx + nx * radius, bz + nz * radius]
  ];
}

export function buildingIntersectsRoad(footprint, roadIndex, clearance = BUILDING_ROAD_CLEARANCE) {
  if (!footprint || !validRing(footprint.outer) ||
    typeof roadIndex?.segmentsInBounds !== 'function') return false;
  const safeClearance = Number.isFinite(clearance) && clearance >= 0
    ? clearance
    : BUILDING_ROAD_CLEARANCE;
  const bounds = ringBounds(footprint.outer);
  return roadIndex.segmentsInBounds(bounds, safeClearance).some((segment) =>
    polygonIntersectsBuildingFootprint(roadCorridorPolygon(segment, safeClearance), footprint));
}

function scaleRing(ring, center, scale) {
  return ring.map((point) => [
    center.x + (point[0] - center.x) * scale,
    center.z + (point[1] - center.z) * scale
  ]);
}

function scaledFootprint(footprint, scale) {
  const center = ringCenter(footprint.outer);
  const outer = scaleRing(footprint.outer, center, scale);
  return {
    ...footprint,
    outer,
    holes: (footprint.holes || []).filter(validRing)
      .map((hole) => scaleRing(hole, center, scale)),
    bounds: ringBounds(outer),
    roadScale: scale
  };
}

export function fitBuildingFootprintsToRoads(footprints, roadIndex, {
  clearance = BUILDING_ROAD_CLEARANCE,
  minimumArea = BUILDING_MIN_AREA,
  minimumScale = BUILDING_MIN_ROAD_SCALE,
  scaleStep = 0.05
} = {}) {
  if (!Array.isArray(footprints)) return { footprints: [], adjustedCount: 0, removedCount: 0 };
  const safeMinimumArea = Number.isFinite(minimumArea) && minimumArea >= 0
    ? minimumArea
    : BUILDING_MIN_AREA;
  const safeMinimumScale = Number.isFinite(minimumScale) && minimumScale > 0 && minimumScale < 1
    ? minimumScale
    : BUILDING_MIN_ROAD_SCALE;
  const safeScaleStep = Number.isFinite(scaleStep) && scaleStep > 0 && scaleStep < 1
    ? scaleStep
    : 0.05;
  const fitted = [];
  let adjustedCount = 0;
  let removedCount = 0;

  for (const footprint of footprints) {
    if (!footprint || !validRing(footprint.outer)) continue;
    if (!buildingIntersectsRoad(footprint, roadIndex, clearance)) {
      fitted.push(footprint);
      continue;
    }
    let replacement = null;
    for (let scale = 1 - safeScaleStep; scale >= safeMinimumScale - GEOMETRY_EPSILON; scale -= safeScaleStep) {
      const candidate = scaledFootprint(footprint, Math.max(safeMinimumScale, scale));
      if (Math.abs(ringArea(candidate.outer)) < safeMinimumArea) break;
      if (!buildingIntersectsRoad(candidate, roadIndex, clearance)) {
        replacement = candidate;
        break;
      }
    }
    if (replacement) {
      fitted.push(replacement);
      adjustedCount++;
    } else {
      removedCount++;
    }
  }

  return { footprints: fitted, adjustedCount, removedCount };
}

export function countRoadBuildingOverlaps(footprints, roadIndex, clearance = BUILDING_ROAD_CLEARANCE) {
  if (!Array.isArray(footprints)) return 0;
  return footprints.reduce((count, footprint) =>
    count + Number(buildingIntersectsRoad(footprint, roadIndex, clearance)), 0);
}

function polygonBounds(polygon) {
  return ringBounds(polygon);
}

function boundsOverlap(a, b) {
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minZ <= b.maxZ && a.maxZ >= b.minZ;
}

export class BuildingIndex {
  constructor(footprints = [], cellSize = BUILDING_INDEX_CELL_SIZE) {
    this.cellSize = Number.isFinite(cellSize) && cellSize > 0 ? cellSize : BUILDING_INDEX_CELL_SIZE;
    this.footprints = [];
    this.cells = new Map();
    if (!Array.isArray(footprints)) return;

    for (const footprint of footprints) {
      if (!footprint || !validRing(footprint.outer)) continue;
      const bounds = ringBounds(footprint.outer);
      const holes = Array.isArray(footprint.holes) ? footprint.holes.filter(validRing) : [];
      const index = this.footprints.length;
      this.footprints.push({ ...footprint, holes, bounds });
      const minCellX = Math.floor(bounds.minX / this.cellSize);
      const maxCellX = Math.floor(bounds.maxX / this.cellSize);
      const minCellZ = Math.floor(bounds.minZ / this.cellSize);
      const maxCellZ = Math.floor(bounds.maxZ / this.cellSize);
      for (let cellX = minCellX; cellX <= maxCellX; cellX++) {
        for (let cellZ = minCellZ; cellZ <= maxCellZ; cellZ++) {
          const key = cellX + ',' + cellZ;
          let cell = this.cells.get(key);
          if (!cell) {
            cell = [];
            this.cells.set(key, cell);
          }
          cell.push(index);
        }
      }
    }
  }

  get size() {
    return this.footprints.length;
  }

  candidates(bounds) {
    if (!finiteBbox(bounds)) return [];
    const indices = new Set();
    const minCellX = Math.floor(bounds.minX / this.cellSize);
    const maxCellX = Math.floor(bounds.maxX / this.cellSize);
    const minCellZ = Math.floor(bounds.minZ / this.cellSize);
    const maxCellZ = Math.floor(bounds.maxZ / this.cellSize);
    for (let cellX = minCellX; cellX <= maxCellX; cellX++) {
      for (let cellZ = minCellZ; cellZ <= maxCellZ; cellZ++) {
        const cell = this.cells.get(cellX + ',' + cellZ);
        if (!cell) continue;
        for (const index of cell) indices.add(index);
      }
    }
    return [...indices].sort((a, b) => a - b).map((index) => this.footprints[index]);
  }

  findCircleCollision(x, z, radius = 0) {
    if (!Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(radius) || radius < 0) return null;
    const bounds = { minX: x - radius, maxX: x + radius, minZ: z - radius, maxZ: z + radius };
    for (const footprint of this.candidates(bounds)) {
      if (!boundsOverlap(bounds, footprint.bounds)) continue;
      if (circleIntersectsBuildingFootprint(x, z, radius, footprint)) return footprint;
    }
    return null;
  }

  intersectsCircle(x, z, radius = 0) {
    return this.findCircleCollision(x, z, radius) !== null;
  }

  findObbCollision(pose, footprint = CAR_FOOTPRINT) {
    const polygon = vehicleObb(pose, footprint);
    if (!polygon) return null;
    const bounds = polygonBounds(polygon);
    for (const building of this.candidates(bounds)) {
      if (!boundsOverlap(bounds, building.bounds)) continue;
      if (polygonIntersectsBuildingFootprint(polygon, building)) return building;
    }
    return null;
  }

  intersectsObb(pose, footprint = CAR_FOOTPRINT) {
    return this.findObbCollision(pose, footprint) !== null;
  }

  findSweptObbCollision(previousPose, nextPose, footprint = CAR_FOOTPRINT) {
    const polygon = sweptVehicleHull(previousPose, nextPose, footprint);
    if (!polygon) return null;
    const bounds = polygonBounds(polygon);
    for (const building of this.candidates(bounds)) {
      if (!boundsOverlap(bounds, building.bounds)) continue;
      if (polygonIntersectsBuildingFootprint(polygon, building)) return building;
    }
    return null;
  }

  sweepObb(previousPose, nextPose, footprint = CAR_FOOTPRINT) {
    return this.findSweptObbCollision(previousPose, nextPose, footprint) !== null;
  }
}
