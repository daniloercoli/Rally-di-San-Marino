import { ROAD_SHOULDER_WIDTH, projectToSegment } from '../../shared/geometry.js';

export const ROAD_PROFILE_MAX_GRADE = 0.2;
export const ROAD_PROFILE_SAMPLE_M = 10;
export const ROAD_TERRAIN_BLEND_M = 12;

const PROFILE_CELL_M = 40;
const PROFILE_OVERLAP_CELL_M = 30;
const PROFILE_RING_SAMPLES = 12;
const ROUTE_PROFILE_QUERY_RADIUS_M = 30;

function finiteHeight(heightAt, x, z) {
  try {
    const height = heightAt(x, z);
    return Number.isFinite(height) ? height : 0;
  } catch {
    return 0;
  }
}

function smoothstep(value) {
  const t = Math.max(0, Math.min(1, value));
  return t * t * (3 - 2 * t);
}

class MaxHeap {
  constructor() {
    this.items = [];
  }

  push(item) {
    const items = this.items;
    items.push(item);
    let index = items.length - 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (items[parent][0] >= item[0]) break;
      items[index] = items[parent];
      index = parent;
    }
    items[index] = item;
  }

  pop() {
    const items = this.items;
    const top = items[0];
    const last = items.pop();
    if (items.length === 0) return top;
    let index = 0;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      if (left >= items.length) break;
      const child = right < items.length && items[right][0] > items[left][0] ? right : left;
      if (items[child][0] <= last[0]) break;
      items[index] = items[child];
      index = child;
    }
    items[index] = last;
    return top;
  }

  get size() {
    return this.items.length;
  }
}

function profileKey(x, z) {
  return x.toFixed(3) + ',' + z.toFixed(3);
}

function pairKey(a, b) {
  return a < b ? a + ',' + b : b + ',' + a;
}

function topologyNodeKey(nodeIds, pointCount, roadId, pointIndex, x, z) {
  const hasTopology = Array.isArray(nodeIds) && nodeIds.length === pointCount;
  const nodeId = hasTopology ? nodeIds[pointIndex] : null;
  if (Number.isSafeInteger(nodeId) && nodeId >= 0) return 'osm:' + nodeId;
  return (hasTopology ? 'road:' + roadId + ':' : 'legacy:') + profileKey(x, z);
}

function envelopeHeight(heightAt, x, z, radius) {
  let height = finiteHeight(heightAt, x, z);
  for (let sample = 0; sample < PROFILE_RING_SAMPLES; sample++) {
    const angle = sample * Math.PI * 2 / PROFILE_RING_SAMPLES;
    height = Math.max(height, finiteHeight(
      heightAt,
      x + Math.cos(angle) * radius,
      z + Math.sin(angle) * radius
    ));
  }
  return height;
}

function buildProfile(roads, heightAt, sampleSpacing, maxGrade) {
  const nodes = [];
  const nodesByKey = new Map();
  const edges = [];
  const segments = [];
  const segmentsByRoad = new Map();
  const pointsByRoad = new Map();

  const longitudinalPairs = new Set();

  function nodeFor(key, x, z, radius, roadId, roadOffset) {
    let id = nodesByKey.get(key);
    const sourceHeight = envelopeHeight(heightAt, x, z, radius);
    if (id === undefined) {
      id = nodes.length;
      nodesByKey.set(key, id);
      nodes.push({
        x,
        z,
        radius,
        sourceHeight,
        height: sourceHeight,
        edges: [],
        roadIds: new Set(),
        roadOffsets: new Map()
      });
    } else {
      nodes[id].sourceHeight = Math.max(nodes[id].sourceHeight, sourceHeight);
      nodes[id].height = nodes[id].sourceHeight;
      nodes[id].radius = Math.max(nodes[id].radius, radius);
    }
    nodes[id].roadIds.add(roadId);
    let offsets = nodes[id].roadOffsets.get(roadId);
    if (!offsets) {
      offsets = [];
      nodes[id].roadOffsets.set(roadId, offsets);
    }
    if (!offsets.some((offset) => Math.abs(offset - roadOffset) < 0.001)) offsets.push(roadOffset);
    return id;
  }

  for (let roadId = 0; roadId < roads.length; roadId++) {
    const road = roads[roadId];
    const sourcePoints = Array.isArray(road?.profilePoints) && road.profilePoints.length >= 2
      ? road.profilePoints
      : road?.points;
    const sourceNodeIds = sourcePoints === road?.profilePoints ? road.profileNodeIds : road?.nodeIds;
    if (!road || !Array.isArray(sourcePoints) || sourcePoints.length < 2) continue;
    const halfWidth = Number.isFinite(road.width) && road.width > 0 ? road.width / 2 : 4;
    const flatRadius = halfWidth + (road.isTrack || road.isUnpaved ? 0 : ROAD_SHOULDER_WIDTH);
    const priority = Number.isFinite(road.priority) ? road.priority : 0;
    let roadPoints = pointsByRoad.get(road);
    if (!roadPoints) {
      roadPoints = [];
      pointsByRoad.set(road, roadPoints);
    }
    let roadDistance = 0;
    for (let pointIndex = 0; pointIndex < sourcePoints.length - 1; pointIndex++) {
      const start = sourcePoints[pointIndex];
      const end = sourcePoints[pointIndex + 1];
      if (!Array.isArray(start) || !Array.isArray(end) ||
          !Number.isFinite(start[0]) || !Number.isFinite(start[1]) ||
          !Number.isFinite(end[0]) || !Number.isFinite(end[1])) continue;
      const length = Math.hypot(end[0] - start[0], end[1] - start[1]);
      if (!(length > 0)) continue;
      const sectionCount = Math.max(1, Math.ceil(length / sampleSpacing));
      let previousId = null;
      for (let section = 0; section <= sectionCount; section++) {
        const t = section / sectionCount;
        const x = start[0] + (end[0] - start[0]) * t;
        const z = start[1] + (end[1] - start[1]) * t;
        const endpointIndex = section === 0
          ? pointIndex
          : section === sectionCount ? pointIndex + 1 : null;
        const key = endpointIndex === null
          ? 'road:' + roadId + ':' + profileKey(x, z)
          : topologyNodeKey(sourceNodeIds, sourcePoints.length, roadId, endpointIndex, x, z);
        const id = nodeFor(key, x, z, flatRadius, roadId, roadDistance + length * t);
        const lastPoint = roadPoints[roadPoints.length - 1];
        if (!lastPoint || Math.hypot(lastPoint[0] - x, lastPoint[1] - z) > 0.001) {
          roadPoints.push([x, z]);
        }
        if (previousId !== null && previousId !== id) {
          const a = nodes[previousId];
          const b = nodes[id];
          const edgeLength = Math.hypot(b.x - a.x, b.z - a.z);
          const edge = { a: previousId, b: id, length: edgeLength, radius: flatRadius, roadId };
          const edgeId = edges.length;
          edges.push(edge);
          a.edges.push(edgeId);
          b.edges.push(edgeId);
          longitudinalPairs.add(pairKey(previousId, id));
          segments.push({
            ax: a.x,
            az: a.z,
            bx: b.x,
            bz: b.z,
            a: previousId,
            b: id,
            halfWidth,
            flatRadius,
            priority,
            road
          });
          let roadSegments = segmentsByRoad.get(road);
          if (!roadSegments) {
            roadSegments = [];
            segmentsByRoad.set(road, roadSegments);
          }
          roadSegments.push(segments[segments.length - 1]);
        }
        previousId = id;
      }
      roadDistance += length;
    }
  }

  // Catch terrain ridges that fall between the regular ten-metre samples. Raising
  // both ends keeps the cross-section above the source before grade propagation.
  for (const edge of edges) {
    const a = nodes[edge.a];
    const b = nodes[edge.b];
    let betweenHeight = -Infinity;
    for (const t of [0.25, 0.5, 0.75]) {
      betweenHeight = Math.max(betweenHeight, envelopeHeight(
        heightAt,
        a.x + (b.x - a.x) * t,
        a.z + (b.z - a.z) * t,
        edge.radius
      ));
    }
    if (betweenHeight > a.sourceHeight) a.sourceHeight = betweenHeight;
    if (betweenHeight > b.sourceHeight) b.sourceHeight = betweenHeight;
  }
  for (const node of nodes) node.height = node.sourceHeight;

  const roadConnections = new Map();
  for (const node of nodes) {
    const roadIds = [...node.roadIds];
    for (let first = 0; first < roadIds.length - 1; first++) {
      for (let second = first + 1; second < roadIds.length; second++) {
        const key = pairKey(roadIds[first], roadIds[second]);
        let connections = roadConnections.get(key);
        if (!connections) {
          connections = [];
          roadConnections.set(key, connections);
        }
        connections.push({ x: node.x, z: node.z });
      }
    }
  }

  // A zero-length constraint is safe only where topology proves that the
  // carriageways belong to the same local junction, or where one road folds
  // back over itself. Geometric crossings without a shared OSM node remain
  // independent, so bridges and tunnels do not collapse onto the road below.
  function nonLocalRoadOverlap(a, b, distance) {
    for (const roadId of a.roadIds) {
      const aOffsets = a.roadOffsets.get(roadId);
      const bOffsets = b.roadOffsets.get(roadId);
      if (bOffsets && aOffsets.some((aOffset) => bOffsets.some((bOffset) =>
        Math.abs(aOffset - bOffset) > distance + a.radius + b.radius + 0.001))) {
        return true;
      }
    }
    for (const aRoadId of a.roadIds) {
      for (const bRoadId of b.roadIds) {
        if (aRoadId === bRoadId) continue;
        const connections = roadConnections.get(pairKey(aRoadId, bRoadId));
        if (connections?.some((connection) =>
          Math.hypot(a.x - connection.x, a.z - connection.z) <=
            a.radius + b.radius + sampleSpacing &&
          Math.hypot(b.x - connection.x, b.z - connection.z) <=
            a.radius + b.radius + sampleSpacing)) {
          return true;
        }
      }
    }
    return false;
  }

  function longitudinalJunctionOverlap(aId, bId) {
    for (const edgeId of nodes[aId].edges) {
      const edge = edges[edgeId];
      if (!edge || !Number.isInteger(edge.roadId) ||
        !((edge.a === aId && edge.b === bId) || (edge.a === bId && edge.b === aId))) continue;
      for (const sharedId of [aId, bId]) {
        const shared = nodes[sharedId];
        if (shared.roadIds.size < 2) continue;
        const otherId = sharedId === edge.a ? edge.b : edge.a;
        const other = nodes[otherId];
        const dx = other.x - shared.x;
        const dz = other.z - shared.z;
        const length = Math.hypot(dx, dz);
        if (!(length > Number.EPSILON)) continue;
        for (const branchEdgeId of shared.edges) {
          const branch = edges[branchEdgeId];
          if (!branch || branch.roadId === edge.roadId) continue;
          const branchOtherId = branch.a === sharedId
            ? branch.b
            : branch.b === sharedId ? branch.a : null;
          if (branchOtherId === null) continue;
          const branchOther = nodes[branchOtherId];
          const branchDx = branchOther.x - shared.x;
          const branchDz = branchOther.z - shared.z;
          const branchLength = Math.hypot(branchDx, branchDz);
          if (!(branchLength > Number.EPSILON)) continue;
          const dot = (dx * branchDx + dz * branchDz) / (length * branchLength);
          if (dot > -0.985) return true;
        }
      }
    }
    return false;
  }

  const overlapCells = new Map();
  for (let nodeId = 0; nodeId < nodes.length; nodeId++) {
    const node = nodes[nodeId];
    const key = Math.floor(node.x / PROFILE_OVERLAP_CELL_M) + ',' +
      Math.floor(node.z / PROFILE_OVERLAP_CELL_M);
    let cell = overlapCells.get(key);
    if (!cell) {
      cell = [];
      overlapCells.set(key, cell);
    }
    cell.push(nodeId);
  }
  let overlapConstraintCount = 0;
  for (let nodeId = 0; nodeId < nodes.length; nodeId++) {
    const node = nodes[nodeId];
    const cellX = Math.floor(node.x / PROFILE_OVERLAP_CELL_M);
    const cellZ = Math.floor(node.z / PROFILE_OVERLAP_CELL_M);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const candidates = overlapCells.get((cellX + dx) + ',' + (cellZ + dz));
        if (!candidates) continue;
        for (const otherId of candidates) {
          if (otherId <= nodeId) continue;
          const isLongitudinal = longitudinalPairs.has(pairKey(nodeId, otherId));
          if (isLongitudinal && !longitudinalJunctionOverlap(nodeId, otherId)) continue;
          const other = nodes[otherId];
          const distance = Math.hypot(other.x - node.x, other.z - node.z);
          if (distance >= node.radius + other.radius - 0.001 ||
              !nonLocalRoadOverlap(node, other, distance)) continue;
          const edgeId = edges.length;
          edges.push({ a: nodeId, b: otherId, length: 0, radius: 0, overlap: true });
          node.edges.push(edgeId);
          other.edges.push(edgeId);
          overlapConstraintCount++;
        }
      }
    }
  }

  // Minimal upper envelope on the road graph. Heights can only rise above the
  // terrain sampled across the carriageway; steep source ridges are spread just
  // far enough along connected roads to satisfy the grade constraint.
  const heap = new MaxHeap();
  for (let id = 0; id < nodes.length; id++) heap.push([nodes[id].height, id]);
  while (heap.size > 0) {
    const [height, id] = heap.pop();
    const node = nodes[id];
    if (height < node.height - 1e-9) continue;
    for (const edgeId of node.edges) {
      const edge = edges[edgeId];
      const otherId = edge.a === id ? edge.b : edge.a;
      const other = nodes[otherId];
      const required = node.height - maxGrade * edge.length;
      if (required <= other.height + 1e-9) continue;
      other.height = required;
      heap.push([other.height, otherId]);
    }
  }

  for (const segment of segments) {
    segment.ay = nodes[segment.a].height;
    segment.by = nodes[segment.b].height;
  }
  for (const [road, roadSegments] of segmentsByRoad) {
    const profiledPoints = [];
    for (const segment of roadSegments) {
      if (profiledPoints.length === 0) profiledPoints.push([segment.ax, segment.az, segment.ay]);
      profiledPoints.push([segment.bx, segment.bz, segment.by]);
    }
    pointsByRoad.set(road, profiledPoints);
  }
  return { nodes, edges, segments, segmentsByRoad, pointsByRoad, overlapConstraintCount };
}

function buildSegmentIndex(segments, blendDistance) {
  const cells = new Map();
  for (const segment of segments) {
    const radius = segment.flatRadius + blendDistance;
    const minX = Math.floor((Math.min(segment.ax, segment.bx) - radius) / PROFILE_CELL_M);
    const maxX = Math.floor((Math.max(segment.ax, segment.bx) + radius) / PROFILE_CELL_M);
    const minZ = Math.floor((Math.min(segment.az, segment.bz) - radius) / PROFILE_CELL_M);
    const maxZ = Math.floor((Math.max(segment.az, segment.bz) + radius) / PROFILE_CELL_M);
    for (let x = minX; x <= maxX; x++) {
      for (let z = minZ; z <= maxZ; z++) {
        const key = x + ',' + z;
        let cell = cells.get(key);
        if (!cell) {
          cell = [];
          cells.set(key, cell);
        }
        cell.push(segment);
      }
    }
  }
  return cells;
}

export function createRoadSurface(roads, terrainHeightAt, {
  maxGrade = ROAD_PROFILE_MAX_GRADE,
  sampleSpacing = ROAD_PROFILE_SAMPLE_M,
  blendDistance = ROAD_TERRAIN_BLEND_M,
  includeDiagnostics = false
} = {}) {
  if (!Array.isArray(roads)) throw new TypeError('roads must be an array');
  if (typeof terrainHeightAt !== 'function') throw new TypeError('terrainHeightAt must be a function');
  if (!Number.isFinite(maxGrade) || maxGrade <= 0 || maxGrade > 1) {
    throw new TypeError('maxGrade must be between zero and one');
  }
  if (!Number.isFinite(sampleSpacing) || sampleSpacing <= 0 ||
      !Number.isFinite(blendDistance) || blendDistance < 0) {
    throw new TypeError('sampleSpacing and blendDistance must be finite valid values');
  }

  const profile = buildProfile(roads, terrainHeightAt, sampleSpacing, maxGrade);
  const cells = buildSegmentIndex(profile.segments, blendDistance);
  const cellsByRoad = new Map();
  for (const [road, segments] of profile.segmentsByRoad) {
    cellsByRoad.set(road, buildSegmentIndex(segments, 0));
  }
  function selectSegment(x, z, candidates, yaw = null) {
    if (!Number.isFinite(x) || !Number.isFinite(z) || !candidates) return null;
    const fx = Number.isFinite(yaw) ? Math.sin(yaw) : 0;
    const fz = Number.isFinite(yaw) ? -Math.cos(yaw) : 0;
    let best = null;
    for (const segment of candidates) {
      const projected = projectToSegment(x, z, segment.ax, segment.az, segment.bx, segment.bz);
      const clearance = projected.distance - segment.halfWidth;
      const length = Math.hypot(segment.bx - segment.ax, segment.bz - segment.az) || 1;
      const alignment = Number.isFinite(yaw)
        ? Math.abs((segment.bx - segment.ax) * fx + (segment.bz - segment.az) * fz) / length
        : 0;
      const primary = Number.isFinite(yaw) ? projected.distance : clearance;
      const bestPrimary = best
        ? Number.isFinite(yaw) ? best.projected.distance : best.clearance
        : Infinity;
      if (!best || primary < bestPrimary - 1e-9 ||
          (Math.abs(primary - bestPrimary) <= 1e-9 && alignment > best.alignment + 1e-9) ||
          (Math.abs(primary - bestPrimary) <= 1e-9 && Math.abs(alignment - best.alignment) <= 1e-9 &&
            segment.priority > best.segment.priority)) {
        best = { projected, clearance, alignment, segment };
      }
    }
    return best;
  }

  function segmentHeight(selected, x, z) {
    const projected = projectToSegment(
      x, z,
      selected.ax, selected.az,
      selected.bx, selected.bz
    );
    return selected.ay + (selected.by - selected.ay) * projected.t;
  }

  function heightAt(x, z) {
    const terrainHeight = finiteHeight(terrainHeightAt, x, z);
    if (!Number.isFinite(x) || !Number.isFinite(z)) return terrainHeight;
    const candidates = cells.get(Math.floor(x / PROFILE_CELL_M) + ',' + Math.floor(z / PROFILE_CELL_M));
    if (!candidates) return terrainHeight;
    const best = selectSegment(x, z, candidates);
    if (!best || best.projected.distance > best.segment.flatRadius + blendDistance) return terrainHeight;
    const { projected, segment } = best;
    const roadHeight = segmentHeight(segment, x, z);
    if (projected.distance <= segment.flatRadius || blendDistance === 0) return roadHeight;
    const mix = smoothstep((projected.distance - segment.flatRadius) / blendDistance);
    return roadHeight * (1 - mix) + terrainHeight * mix;
  }

  function heightAtForRoad(road) {
    const roadSegments = profile.segmentsByRoad.get(road);
    if (!roadSegments || roadSegments.length === 0) return heightAt;
    return (x, z) => {
      const roadCells = cellsByRoad.get(road);
      const candidates = roadCells.get(
        Math.floor(x / PROFILE_CELL_M) + ',' + Math.floor(z / PROFILE_CELL_M)
      ) || roadSegments;
      const best = selectSegment(x, z, candidates);
      return best ? segmentHeight(best.segment, x, z) : finiteHeight(terrainHeightAt, x, z);
    };
  }

  function pointsForRoad(road) {
    return profile.pointsByRoad.get(road) || road?.points || [];
  }

  function heightAtForPose(pose) {
    if (!Number.isFinite(pose?.x) || !Number.isFinite(pose?.z)) return heightAt;
    const candidates = cells.get(
      Math.floor(pose.x / PROFILE_CELL_M) + ',' + Math.floor(pose.z / PROFILE_CELL_M)
    );
    const best = selectSegment(pose.x, pose.z, candidates, pose.yaw);
    if (!best || best.projected.distance > best.segment.flatRadius) return heightAt;
    return (x, z) => segmentHeight(best.segment, x, z);
  }

  function heightAtForRoadPose(road, pose) {
    const roadSegments = profile.segmentsByRoad.get(road);
    if (!roadSegments || !Number.isFinite(pose?.x) || !Number.isFinite(pose?.z)) return heightAt;
    const best = selectSegment(pose.x, pose.z, roadSegments, pose.yaw);
    return best ? (x, z) => segmentHeight(best.segment, x, z) : heightAt;
  }

  function profilePath(routePoints) {
    if (!Array.isArray(routePoints) || routePoints.length < 2 || routePoints.length > 4096 ||
      routePoints.some((point) => !Array.isArray(point) || point.length < 2 ||
        !Number.isFinite(point[0]) || !Number.isFinite(point[1]))) return null;

    // Resolve the travelled plane once along the route direction. The guide
    // then consumes these 3D center points directly instead of asking the
    // global nearest-road selector independently for each ribbon edge.
    const points = [];
    const selectedRoadSegments = new Set();
    for (let pointIndex = 0; pointIndex < routePoints.length - 1; pointIndex++) {
      const start = routePoints[pointIndex];
      const end = routePoints[pointIndex + 1];
      const dx = end[0] - start[0];
      const dz = end[1] - start[1];
      const length = Math.hypot(dx, dz);
      if (!(length > Number.EPSILON)) continue;
      const yaw = Math.atan2(dx, -dz);
      const sectionCount = Math.max(1, Math.ceil(length / sampleSpacing));
      const firstSection = points.length === 0 ? 0 : 1;
      for (let section = firstSection; section <= sectionCount; section++) {
        const t = section / sectionCount;
        const x = start[0] + dx * t;
        const z = start[1] + dz * t;
        const candidates = cells.get(
          Math.floor(x / PROFILE_CELL_M) + ',' + Math.floor(z / PROFILE_CELL_M)
        );
        const selected = selectSegment(x, z, candidates, yaw);
        const usesRoad = selected &&
          selected.projected.distance <= selected.segment.flatRadius + blendDistance;
        const y = usesRoad ? segmentHeight(selected.segment, x, z) : heightAt(x, z);
        if (usesRoad) selectedRoadSegments.add(selected.segment);
        points.push([x, z, Number.isFinite(y) ? y : 0]);
      }
    }
    if (points.length < 2) return null;

    const routeSegments = [];
    let maximumGrade = 0;
    for (let index = 0; index < points.length - 1; index++) {
      const start = points[index];
      const end = points[index + 1];
      const length = Math.hypot(end[0] - start[0], end[1] - start[1]);
      if (!(length > Number.EPSILON)) continue;
      maximumGrade = Math.max(maximumGrade, Math.abs(end[2] - start[2]) / length);
      routeSegments.push({
        ax: start[0],
        az: start[1],
        ay: start[2],
        bx: end[0],
        bz: end[1],
        by: end[2],
        halfWidth: 0,
        flatRadius: ROUTE_PROFILE_QUERY_RADIUS_M,
        priority: 0
      });
    }
    if (routeSegments.length === 0) return null;
    const routeCells = buildSegmentIndex(routeSegments, 0);

    function routeHeightAt(x, z, yaw = null) {
      if (!Number.isFinite(x) || !Number.isFinite(z)) return heightAt(x, z);
      const candidates = routeCells.get(
        Math.floor(x / PROFILE_CELL_M) + ',' + Math.floor(z / PROFILE_CELL_M)
      );
      const selected = selectSegment(x, z, candidates, yaw);
      if (!selected || selected.projected.distance > ROUTE_PROFILE_QUERY_RADIUS_M) {
        return heightAt(x, z);
      }
      return segmentHeight(selected.segment, x, z);
    }

    return {
      points,
      heightAt: routeHeightAt,
      profile: {
        pointCount: points.length,
        segmentCount: routeSegments.length,
        selectedRoadSegmentCount: selectedRoadSegments.size,
        maxGrade: maximumGrade,
        sampleSpacing
      }
    };
  }

  function releaseGeometryData() {
    cellsByRoad.clear();
    profile.segmentsByRoad.clear();
    profile.pointsByRoad.clear();
  }

  const diagnostics = {
    nodeCount: profile.nodes.length,
    segmentCount: profile.segments.length,
    overlapConstraintCount: profile.overlapConstraintCount,
    maxGrade,
    sampleSpacing,
    blendDistance
  };
  if (includeDiagnostics) {
    diagnostics.nodes = profile.nodes;
    diagnostics.segments = profile.segments;
  } else {
    for (const node of profile.nodes) node.edges.length = 0;
    profile.nodes.length = 0;
    profile.edges.length = 0;
  }

  return {
    heightAt,
    heightAtForPose,
    heightAtForRoadPose,
    heightAtForRoad,
    pointsForRoad,
    profilePath,
    releaseGeometryData,
    profile: diagnostics
  };
}
