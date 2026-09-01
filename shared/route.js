import { RoadIndex, projectToSegment } from './geometry.js';

export const ROUTE_CHECKPOINT_COUNT = 10;
export const CHECKPOINT_CAPTURE_RADIUS_M = 18;

class MinHeap {
  constructor() {
    this.items = [];
  }
  get size() {
    return this.items.length;
  }
  push(item) {
    const it = this.items;
    it.push(item);
    let i = it.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (it[p][0] <= it[i][0]) break;
      const t = it[p];
      it[p] = it[i];
      it[i] = t;
      i = p;
    }
  }
  pop() {
    const it = this.items;
    const top = it[0];
    const last = it.pop();
    if (it.length > 0) {
      it[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = 2 * i + 2;
        let s = i;
        if (l < it.length && it[l][0] < it[s][0]) s = l;
        if (r < it.length && it[r][0] < it[s][0]) s = r;
        if (s === i) break;
        const t = it[s];
        it[s] = it[i];
        it[i] = t;
        i = s;
      }
    }
    return top;
  }
}

const KEY_EPS = 0.1;

export class RoadGraph {
  constructor(roads) {
    this.nodes = [];
    this.byKey = new Map();
    this.adj = [];
    this.roadIndex = new RoadIndex(roads);
    for (const road of roads) {
      const pts = road.points;
      for (let i = 0; i < pts.length - 1; i++) {
        const ai = this.nodeFor(pts[i][0], pts[i][1]);
        const bi = this.nodeFor(pts[i + 1][0], pts[i + 1][1]);
        if (ai === bi) continue;
        const w = Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
        this.adj[ai].push([bi, w]);
        this.adj[bi].push([ai, w]);
      }
    }
  }

  nodeFor(x, z) {
    const key = Math.round(x / KEY_EPS) + ',' + Math.round(z / KEY_EPS);
    let idx = this.byKey.get(key);
    if (idx === undefined) {
      idx = this.nodes.length;
      this.nodes.push({ x, z });
      this.byKey.set(key, idx);
      this.adj.push([]);
    }
    return idx;
  }

  nearestNode(x, z) {
    let best = -1;
    let bd = Infinity;
    for (let i = 0; i < this.nodes.length; i++) {
      const n = this.nodes[i];
      const d = Math.hypot(n.x - x, n.z - z);
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    return best;
  }
  aStar(start, goal) {
    const n = this.nodes.length;
    if (start < 0 || goal < 0 || start >= n || goal >= n) return null;
    const open = new MinHeap();
    const g = new Float64Array(n).fill(Infinity);
    const prev = new Int32Array(n).fill(-1);
    const closed = new Uint8Array(n);
    const gn = this.nodes[goal];
    g[start] = 0;
    open.push([0, start]);
    while (open.size > 0) {
      const [, u] = open.pop();
      if (closed[u]) continue;
      closed[u] = 1;
      if (u === goal) {
        const path = [];
        let c = u;
        while (c !== -1) {
          path.push(c);
          c = prev[c];
        }
        return path.reverse();
      }
      for (const [v, w] of this.adj[u]) {
        if (closed[v]) continue;
        const ng = g[u] + w;
        if (ng < g[v]) {
          g[v] = ng;
          prev[v] = u;
          const vn = this.nodes[v];
          const h = Math.hypot(vn.x - gn.x, vn.z - gn.z);
          open.push([ng + h, v]);
        }
      }
    }
    return null;
  }
}

export function aStarPath(graph, sx, sz, ex, ez) {
  const s = graph.nearestNode(sx, sz);
  const e = graph.nearestNode(ex, ez);
  const path = graph.aStar(s, e);
  if (!path) return null;
  return path.map((i) => {
    const n = graph.nodes[i];
    return [n.x, n.z];
  });
}

function firstFinitePathYaw(points) {
  if (!Array.isArray(points)) return null;
  let origin = null;
  for (const point of points) {
    if (!Array.isArray(point) || !Number.isFinite(point[0]) || !Number.isFinite(point[1])) continue;
    if (!origin) {
      origin = point;
      continue;
    }
    const dx = point[0] - origin[0];
    const dz = point[1] - origin[1];
    if (Math.hypot(dx, dz) > Number.EPSILON) return Math.atan2(dx, -dz);
  }
  return null;
}

export function pathStartYaw(path, fallbackPath, fallbackYaw = 0) {
  const pathYaw = firstFinitePathYaw(path);
  if (pathYaw !== null) return pathYaw;
  const fallbackPathYaw = firstFinitePathYaw(fallbackPath);
  if (fallbackPathYaw !== null) return fallbackPathYaw;
  return Number.isFinite(fallbackYaw) ? fallbackYaw : 0;
}

export function resample(points, spacing) {
  if (points.length < 2) return points.slice();
  const out = [[points[0][0], points[0][1]]];
  let last = points[0];
  let acc = 0;
  for (let i = 1; i < points.length; i++) {
    const p = points[i];
    let d = Math.hypot(p[0] - last[0], p[1] - last[1]);
    while (d > 0 && acc + d >= spacing) {
      const t = (spacing - acc) / d;
      const nx = last[0] + (p[0] - last[0]) * t;
      const nz = last[1] + (p[1] - last[1]) * t;
      out.push([nx, nz]);
      d -= spacing - acc;
      last = [nx, nz];
      acc = 0;
    }
    acc += d;
    last = p;
  }
  const tail = out[out.length - 1];
  const endPt = points[points.length - 1];
  if (Math.hypot(endPt[0] - tail[0], endPt[1] - tail[1]) > 1) out.push([endPt[0], endPt[1]]);
  return out;
}

export function resampleByCount(points, count) {
  if (!Array.isArray(points) || points.length < 2 || !Number.isInteger(count) || count < 2 ||
    points.some((point) => !Array.isArray(point) || point.length < 2 ||
      !Number.isFinite(point[0]) || !Number.isFinite(point[1]))) return [];
  const cumulative = new Float64Array(points.length);
  for (let index = 1; index < points.length; index++) {
    cumulative[index] = cumulative[index - 1] + Math.hypot(
      points[index][0] - points[index - 1][0],
      points[index][1] - points[index - 1][1]
    );
  }
  const totalDistance = cumulative[cumulative.length - 1];
  if (!Number.isFinite(totalDistance) || totalDistance <= 0) return [];
  return Array.from({ length: count }, (_, index) =>
    pointAtRouteDistance(points, cumulative, totalDistance * index / (count - 1)));
}

export function advanceCheckpointProgress(checkpoints, currentCheckpoint, previousPose, currentPose, radius) {
  if (!Array.isArray(checkpoints) || checkpoints.length < 2 ||
    !Number.isInteger(currentCheckpoint) || currentCheckpoint < 0 || currentCheckpoint >= checkpoints.length ||
    !previousPose || !currentPose ||
    !Number.isFinite(previousPose.x) || !Number.isFinite(previousPose.z) ||
    !Number.isFinite(currentPose.x) || !Number.isFinite(currentPose.z) ||
    !Number.isFinite(radius) || radius <= 0) return 0;

  let checkpoint = currentCheckpoint;
  let lastT = 0;
  while (checkpoint + 1 < checkpoints.length) {
    const target = checkpoints[checkpoint + 1];
    if (!Array.isArray(target) || !Number.isFinite(target[0]) || !Number.isFinite(target[1])) break;
    const crossing = projectToSegment(
      target[0],
      target[1],
      previousPose.x,
      previousPose.z,
      currentPose.x,
      currentPose.z
    );
    if (crossing.distance > radius || crossing.t + 1e-9 < lastT) break;
    checkpoint++;
    lastT = crossing.t;
  }
  return checkpoint;
}

export function crossedCheckpointIndices(checkpoints, previousPose, currentPose, radius) {
  if (!Array.isArray(checkpoints) || checkpoints.length < 2 ||
    !previousPose || !currentPose ||
    !Number.isFinite(previousPose.x) || !Number.isFinite(previousPose.z) ||
    !Number.isFinite(currentPose.x) || !Number.isFinite(currentPose.z) ||
    !Number.isFinite(radius) || radius <= 0 ||
    checkpoints.some((checkpoint) => !Array.isArray(checkpoint) ||
      !Number.isFinite(checkpoint[0]) || !Number.isFinite(checkpoint[1]))) return [];

  const crossed = [];
  for (let index = 1; index < checkpoints.length; index++) {
    const target = checkpoints[index];
    const crossing = projectToSegment(
      target[0],
      target[1],
      previousPose.x,
      previousPose.z,
      currentPose.x,
      currentPose.z
    );
    if (crossing.distance <= radius) crossed.push({ index, t: crossing.t });
  }
  crossed.sort((a, b) => a.t - b.t || a.index - b.index);
  return crossed.map((crossing) => crossing.index);
}

function roundedPercent(value) {
  return Math.round(value * 10) / 10;
}

export function checkpointCoverage(checkpointHits, totalCheckpoints) {
  if (!(checkpointHits instanceof Set) && !Array.isArray(checkpointHits)) return null;
  if (!Number.isInteger(totalCheckpoints) || totalCheckpoints < 2) return null;

  const uniqueHits = new Set();
  for (const index of checkpointHits) {
    if (!Number.isInteger(index) || index < 0 || index >= totalCheckpoints) return null;
    uniqueHits.add(index);
  }
  const checkpointsHit = uniqueHits.size;
  const checkpointsMissed = totalCheckpoints - checkpointsHit;
  const checkpointsHitPercent = roundedPercent(checkpointsHit / totalCheckpoints * 100);
  return {
    checkpointsHit,
    checkpointsMissed,
    checkpointsTotal: totalCheckpoints,
    checkpointsHitPercent,
    checkpointsMissedPercent: roundedPercent(100 - checkpointsHitPercent)
  };
}

function uniqueDegree(graph, nodeId) {
  return new Set((graph.adj[nodeId] || []).map(([neighbor]) => neighbor)).size;
}

function pointAtRouteDistance(points, cumulative, distance) {
  const target = Math.max(0, Math.min(distance, cumulative[cumulative.length - 1]));
  let hi = 1;
  while (hi < cumulative.length && cumulative[hi] < target) hi++;
  if (hi >= cumulative.length) return points[points.length - 1].slice();
  const lo = hi - 1;
  const span = cumulative[hi] - cumulative[lo];
  const t = span > 0 ? (target - cumulative[lo]) / span : 0;
  return [
    points[lo][0] + (points[hi][0] - points[lo][0]) * t,
    points[lo][1] + (points[hi][1] - points[lo][1]) * t
  ];
}

const PACE_NOTE_SEVERITIES = Object.freeze([
  Object.freeze({ minimumAngle: 130, severity: 'hairpin' }),
  Object.freeze({ minimumAngle: 85, severity: 'tight' }),
  Object.freeze({ minimumAngle: 55, severity: 'medium' }),
  Object.freeze({ minimumAngle: 0, severity: 'open' })
]);

function paceNoteSeverity(angleDegrees) {
  return PACE_NOTE_SEVERITIES.find((entry) => angleDegrees >= entry.minimumAngle).severity;
}

export function createRoutePaceNotes(points, options = {}) {
  if (!Array.isArray(points) || points.length < 3 || points.length > 4096 ||
    points.some((point) => !Array.isArray(point) || point.length < 2 ||
      !Number.isFinite(point[0]) || !Number.isFinite(point[1]))) return [];

  const sampleDistance = Number.isFinite(options.sampleDistance)
    ? Math.max(5, Math.min(options.sampleDistance, 100))
    : 18;
  const mergeDistance = Number.isFinite(options.mergeDistance)
    ? Math.max(0, Math.min(options.mergeDistance, 200))
    : 30;
  const minimumAngle = (Number.isFinite(options.minimumAngleDegrees)
    ? Math.max(10, Math.min(options.minimumAngleDegrees, 90))
    : 32) * Math.PI / 180;

  const cumulative = new Float64Array(points.length);
  for (let index = 1; index < points.length; index++) {
    cumulative[index] = cumulative[index - 1] + Math.hypot(
      points[index][0] - points[index - 1][0],
      points[index][1] - points[index - 1][1]
    );
  }
  const totalDistance = cumulative[cumulative.length - 1];
  if (!Number.isFinite(totalDistance) || totalDistance < sampleDistance * 2) return [];
  const checkpointSpacing = Number.isFinite(options.checkpointSpacing) && options.checkpointSpacing > 0
    ? options.checkpointSpacing
    : totalDistance / (ROUTE_CHECKPOINT_COUNT - 1);

  const candidates = [];
  for (let index = 1; index < points.length - 1; index++) {
    const distance = cumulative[index];
    if (distance < sampleDistance || totalDistance - distance < sampleDistance) continue;
    const before = pointAtRouteDistance(points, cumulative, distance - sampleDistance);
    const center = pointAtRouteDistance(points, cumulative, distance);
    const after = pointAtRouteDistance(points, cumulative, distance + sampleDistance);
    let inX = center[0] - before[0];
    let inZ = center[1] - before[1];
    let outX = after[0] - center[0];
    let outZ = after[1] - center[1];
    const inLength = Math.hypot(inX, inZ);
    const outLength = Math.hypot(outX, outZ);
    if (inLength <= Number.EPSILON || outLength <= Number.EPSILON) continue;
    inX /= inLength;
    inZ /= inLength;
    outX /= outLength;
    outZ /= outLength;
    const angle = Math.atan2(inX * outZ - inZ * outX, inX * outX + inZ * outZ);
    if (!Number.isFinite(angle) || Math.abs(angle) < minimumAngle) continue;
    candidates.push({
      x: center[0],
      z: center[1],
      distance,
      checkpoint: Math.max(0, Math.floor(distance / checkpointSpacing)),
      turn: angle > 0 ? 'right' : 'left',
      angleDegrees: Math.abs(angle) * 180 / Math.PI
    });
  }

  const groups = [];
  for (const candidate of candidates) {
    const group = groups[groups.length - 1];
    const previous = group?.[group.length - 1];
    if (!group || previous.turn !== candidate.turn ||
      candidate.distance - previous.distance > mergeDistance) {
      groups.push([candidate]);
    } else {
      group.push(candidate);
    }
  }

  return groups.slice(0, 512).map((group, index) => {
    const first = group[0];
    const last = group[group.length - 1];
    const strongest = group.reduce((best, candidate) =>
      candidate.angleDegrees > best.angleDegrees ? candidate : best);
    const before = pointAtRouteDistance(points, cumulative, first.distance - sampleDistance);
    const entry = pointAtRouteDistance(points, cumulative, first.distance);
    const exit = pointAtRouteDistance(points, cumulative, last.distance);
    const after = pointAtRouteDistance(points, cumulative, last.distance + sampleDistance);
    const inX = entry[0] - before[0];
    const inZ = entry[1] - before[1];
    const outX = after[0] - exit[0];
    const outZ = after[1] - exit[1];
    const aggregateAngle = Math.abs(Math.atan2(
      inX * outZ - inZ * outX,
      inX * outX + inZ * outZ
    )) * 180 / Math.PI;
    const rawAngleDegrees = Number.isFinite(aggregateAngle) && aggregateAngle > 0
      ? aggregateAngle
      : strongest.angleDegrees;
    const angleDegrees = Math.round(rawAngleDegrees * 10) / 10;
    return {
      ...first,
      id: index,
      angleDegrees,
      severity: paceNoteSeverity(angleDegrees)
    };
  });
}

export function createRouteDirections(graph, nodePath, options = {}) {
  if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.adj) ||
    !Array.isArray(nodePath) || nodePath.length < 3) return [];
  const path = [];
  for (const nodeId of nodePath) {
    if (!Number.isInteger(nodeId) || nodeId < 0 || nodeId >= graph.nodes.length) return [];
    const node = graph.nodes[nodeId];
    if (!Number.isFinite(node?.x) || !Number.isFinite(node?.z)) return [];
    path.push([node.x, node.z]);
  }

  const intersectionMergeDistance = Number.isFinite(options.intersectionMergeDistance)
    ? Math.max(0, options.intersectionMergeDistance)
    : 20;
  const tangentDistance = Number.isFinite(options.tangentDistance)
    ? Math.max(1, options.tangentDistance)
    : 15;
  const signDistance = Number.isFinite(options.signDistance)
    ? Math.max(0, options.signDistance)
    : 12;
  const sideOffset = Number.isFinite(options.sideOffset) ? Math.max(0, options.sideOffset) : 6;
  const maxSideOffset = Number.isFinite(options.maxSideOffset)
    ? Math.max(sideOffset, options.maxSideOffset)
    : Math.max(sideOffset, 24);
  const minimumRoadClearance = Number.isFinite(options.minimumRoadClearance)
    ? options.minimumRoadClearance
    : 1.1;
  const isPositionBlocked = typeof options.isPositionBlocked === 'function'
    ? options.isPositionBlocked
    : () => false;
  const turnThreshold = (Number.isFinite(options.turnThresholdDegrees)
    ? Math.max(0, Math.min(options.turnThresholdDegrees, 90))
    : 25) * Math.PI / 180;

  const cumulative = new Float64Array(path.length);
  for (let i = 1; i < path.length; i++) {
    cumulative[i] = cumulative[i - 1] + Math.hypot(
      path[i][0] - path[i - 1][0],
      path[i][1] - path[i - 1][1]
    );
  }
  const totalDistance = cumulative[cumulative.length - 1];
  const checkpointSpacing = Number.isFinite(options.checkpointSpacing) && options.checkpointSpacing > 0
    ? options.checkpointSpacing
    : totalDistance / (ROUTE_CHECKPOINT_COUNT - 1);
  const candidates = [];
  for (let i = 1; i < nodePath.length - 1; i++) {
    if (uniqueDegree(graph, nodePath[i]) >= 3) candidates.push(i);
  }
  if (candidates.length === 0) return [];

  const groups = [];
  for (const index of candidates) {
    const group = groups[groups.length - 1];
    if (!group || cumulative[index] - cumulative[group[0]] > intersectionMergeDistance) {
      groups.push([index]);
    } else {
      group.push(index);
    }
  }

  const directions = [];
  for (const group of groups) {
    const first = group[0];
    const last = group[group.length - 1];
    const entryDistance = cumulative[first];
    const exitDistance = cumulative[last];
    const before = pointAtRouteDistance(path, cumulative, entryDistance - tangentDistance);
    const entry = pointAtRouteDistance(path, cumulative, entryDistance);
    const exit = pointAtRouteDistance(path, cumulative, exitDistance);
    const after = pointAtRouteDistance(path, cumulative, exitDistance + tangentDistance);
    let inX = entry[0] - before[0];
    let inZ = entry[1] - before[1];
    let outX = after[0] - exit[0];
    let outZ = after[1] - exit[1];
    const inLength = Math.hypot(inX, inZ);
    const outLength = Math.hypot(outX, outZ);
    if (inLength <= Number.EPSILON || outLength <= Number.EPSILON) continue;
    inX /= inLength;
    inZ /= inLength;
    outX /= outLength;
    outZ /= outLength;
    const angle = Math.atan2(inX * outZ - inZ * outX, inX * outX + inZ * outZ);
    const turn = angle > turnThreshold ? 'right' : angle < -turnThreshold ? 'left' : 'straight';
    const signPoint = pointAtRouteDistance(path, cumulative, entryDistance - signDistance);
    const rightX = -inZ;
    const rightZ = inX;
    let signX = signPoint[0] + rightX * sideOffset;
    let signZ = signPoint[1] + rightZ * sideOffset;
    let bestClearance = graph.roadIndex?.query(signX, signZ).clearance ?? Infinity;
    let placed = bestClearance >= minimumRoadClearance && !isPositionBlocked(signX, signZ);
    for (let offset = sideOffset; !placed && offset <= maxSideOffset + 1e-9; offset += 1) {
      for (const side of [1, -1]) {
        const candidateX = signPoint[0] + rightX * offset * side;
        const candidateZ = signPoint[1] + rightZ * offset * side;
        const clearance = graph.roadIndex?.query(candidateX, candidateZ).clearance ?? Infinity;
        const blocked = isPositionBlocked(candidateX, candidateZ);
        if (!blocked && clearance > bestClearance) {
          signX = candidateX;
          signZ = candidateZ;
          bestClearance = clearance;
        }
        if (!blocked && clearance >= minimumRoadClearance) {
          signX = candidateX;
          signZ = candidateZ;
          placed = true;
          break;
        }
      }
    }
    if (!placed) continue;
    directions.push({
      x: signX,
      z: signZ,
      yaw: Math.atan2(inX, -inZ),
      turn,
      checkpoint: Math.max(0, Math.floor(entryDistance / checkpointSpacing))
    });
  }
  return directions;
}

export function computeComponents(graph) {
  const n = graph.nodes.length;
  const component = new Int32Array(n).fill(-1);
  let compId = 0;
  for (let i = 0; i < n; i++) {
    if (component[i] !== -1) continue;
    const stack = [i];
    while (stack.length > 0) {
      const u = stack.pop();
      if (component[u] !== -1) continue;
      component[u] = compId;
      for (const [v] of graph.adj[u]) {
        if (component[v] === -1) stack.push(v);
      }
    }
    compId++;
  }
  return { component, compCount: compId };
}

function routeCandidates(graph, map) {
  const places = map.places;
  const { component } = computeComponents(graph);
  const placeNodes = places.map((place) => graph.nearestNode(place.x, place.z));
  const candidates = [];
  for (let i = 0; i < places.length; i++) {
    for (let j = i + 1; j < places.length; j++) {
      const ni = placeNodes[i];
      const nj = placeNodes[j];
      if (ni === nj || component[ni] !== component[nj]) continue;
      const d = Math.hypot(places[i].x - places[j].x, places[i].z - places[j].z);
      const nameA = places[i].name;
      const nameB = places[j].name;
      const key = nameA <= nameB ? nameA + '|' + nameB : nameB + '|' + nameA;
      candidates.push({
        startIndex: nameA <= nameB ? i : j,
        endIndex: nameA <= nameB ? j : i,
        startNode: nameA <= nameB ? ni : nj,
        endNode: nameA <= nameB ? nj : ni,
        distance: d,
        key
      });
    }
  }
  candidates.sort((a, b) => {
    if (Math.abs(a.distance - b.distance) >= 1e-6) return b.distance - a.distance;
    if (a.key < b.key) return -1;
    if (a.key > b.key) return 1;
    return a.startNode - b.startNode || a.endNode - b.endNode;
  });
  return candidates;
}

function routeFromCandidate(graph, map, candidate, id, options) {
  const startPlace = map.places[candidate.startIndex];
  const endPlace = map.places[candidate.endIndex];
  const startNode = candidate.startNode;
  const endNode = candidate.endNode;
  const nodePath = graph.aStar(startNode, endNode);
  if (!nodePath || nodePath.length < 2) return null;
  const pts = nodePath.map((nodeId) => {
    const node = graph.nodes[nodeId];
    return [node.x, node.z];
  });
  let lengthM = 0;
  for (let i = 1; i < pts.length; i++) {
    lengthM += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  }
  const checkpointCount = Number.isInteger(options.checkpointCount) && options.checkpointCount >= 2
    ? options.checkpointCount
    : ROUTE_CHECKPOINT_COUNT;
  const checkpointSpacing = lengthM / (checkpointCount - 1);
  return {
    id,
    lengthM,
    checkpoints: resampleByCount(pts, checkpointCount),
    path: pts,
    directions: createRouteDirections(graph, nodePath, {
      ...(options.directionOptions || {}),
      checkpointSpacing
    }),
    start: { name: startPlace.name, x: graph.nodes[startNode].x, z: graph.nodes[startNode].z },
    end: { name: endPlace.name, x: graph.nodes[endNode].x, z: graph.nodes[endNode].z }
  };
}

export function createRouteCatalog(graph, map, options = {}) {
  const limit = Number.isInteger(options.maxRoutes)
    ? Math.max(1, Math.min(options.maxRoutes, 32))
    : 8;
  const candidates = routeCandidates(graph, map);
  if (candidates.length === 0) {
    throw new Error('Nessuna coppia di luoghi validi nella stessa componente');
  }
  const catalog = [];
  for (const candidate of candidates) {
    const route = routeFromCandidate(graph, map, candidate, `route-${catalog.length + 1}`, options);
    if (route) catalog.push(route);
    if (catalog.length >= limit) break;
  }
  if (catalog.length === 0) throw new Error('A* non ha trovato percorsi validi tra i luoghi nominati');
  return catalog;
}

export function pickRoute(graph, map, options = {}) {
  return createRouteCatalog(graph, map, { ...options, maxRoutes: 1 })[0];
}
