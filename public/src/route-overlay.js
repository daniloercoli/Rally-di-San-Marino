import * as THREE from 'three';

const MAX_DRAPED_SEGMENT_LENGTH = 25;
const MAX_DRAPE_DEPTH = 12;
const MAX_HEIGHT_ERROR = 0.04;
const ROUTE_RAIL_COUNT = 11;

function validRoutePoints(routePoints) {
  return Array.isArray(routePoints) && routePoints.length >= 2 && routePoints.every((point) =>
    Array.isArray(point) && point.length >= 2 &&
    Number.isFinite(point[0]) && Number.isFinite(point[1]));
}

export function routeOverlayKey(routePoints) {
  if (!validRoutePoints(routePoints)) return '';
  return JSON.stringify(routePoints);
}

export function routeTargetVisibility(checkpoint, totalCheckpoints, finished = false) {
  if (finished === true || !Number.isInteger(checkpoint) || checkpoint < 0 ||
    !Number.isInteger(totalCheckpoints) || totalCheckpoints < 2 || checkpoint >= totalCheckpoints) {
    return { checkpoint: false, finish: false };
  }
  const next = Math.min(checkpoint + 1, totalCheckpoints - 1);
  return {
    checkpoint: next < totalCheckpoints - 1,
    finish: true
  };
}

function sampledPoint(x, z, heightAt, y) {
  const groundY = heightAt(x, z);
  return {
    x,
    y: (Number.isFinite(groundY) ? groundY : 0) + y,
    z
  };
}

function interpolatePoint(start, end, t, heightAt, y) {
  return sampledPoint(
    start.x + (end.x - start.x) * t,
    start.z + (end.z - start.z) * t,
    heightAt,
    y
  );
}

function interpolateSection(start, end, t, heightAt, y) {
  return {
    rails: start.rails.map((rail, index) =>
      interpolatePoint(rail, end.rails[index], t, heightAt, y))
  };
}

function heightError(start, end, sample, t) {
  return Math.abs(sample.y - (start.y + (end.y - start.y) * t));
}

function refineSections(start, end, heightAt, y, depth, output, knownMiddle = null) {
  const samples = [
    { t: 0.25, section: interpolateSection(start, end, 0.25, heightAt, y) },
    { t: 0.5, section: knownMiddle || interpolateSection(start, end, 0.5, heightAt, y) },
    { t: 0.75, section: interpolateSection(start, end, 0.75, heightAt, y) }
  ];
  let error = 0;
  for (const sample of samples) {
    for (let rail = 0; rail < ROUTE_RAIL_COUNT; rail++) {
      error = Math.max(error, heightError(
        start.rails[rail],
        end.rails[rail],
        sample.section.rails[rail],
        sample.t
      ));
    }
  }
  const middleRail = Math.floor(ROUTE_RAIL_COUNT / 2);
  const length = Math.hypot(
    end.rails[middleRail].x - start.rails[middleRail].x,
    end.rails[middleRail].z - start.rails[middleRail].z
  );
  if (depth < MAX_DRAPE_DEPTH &&
    (length > MAX_DRAPED_SEGMENT_LENGTH || error > MAX_HEIGHT_ERROR)) {
    const middle = samples[1].section;
    refineSections(start, middle, heightAt, y, depth + 1, output, samples[0].section);
    refineSections(middle, end, heightAt, y, depth + 1, output, samples[2].section);
    return;
  }
  output.push(end);
}

function routeSections(routePoints, halfWidth, heightAt, y) {
  const base = routePoints.map((point, index) => {
    const previous = routePoints[Math.max(0, index - 1)];
    const next = routePoints[Math.min(routePoints.length - 1, index + 1)];
    let dx = next[0] - previous[0];
    let dz = next[1] - previous[1];
    const length = Math.hypot(dx, dz);
    if (length > 0) {
      dx /= length;
      dz /= length;
    } else {
      dx = 1;
      dz = 0;
    }
    const nx = dz;
    const nz = -dx;
    return {
      rails: Array.from({ length: ROUTE_RAIL_COUNT }, (_, rail) => {
        const offset = halfWidth * (1 - 2 * rail / (ROUTE_RAIL_COUNT - 1));
        return sampledPoint(point[0] + nx * offset, point[1] + nz * offset, heightAt, y);
      })
    };
  });
  const sections = [base[0]];
  for (let index = 0; index < base.length - 1; index++) {
    refineSections(base[index], base[index + 1], heightAt, y, 0, sections);
  }
  return sections;
}

function refineLine(start, end, heightAt, y, depth, output, knownMiddle = null) {
  const samples = [
    { t: 0.25, point: interpolatePoint(start, end, 0.25, heightAt, y) },
    { t: 0.5, point: knownMiddle || interpolatePoint(start, end, 0.5, heightAt, y) },
    { t: 0.75, point: interpolatePoint(start, end, 0.75, heightAt, y) }
  ];
  let error = 0;
  for (const sample of samples) {
    error = Math.max(error, heightError(start, end, sample.point, sample.t));
  }
  const length = Math.hypot(end.x - start.x, end.z - start.z);
  if (depth < MAX_DRAPE_DEPTH &&
    (length > MAX_DRAPED_SEGMENT_LENGTH || error > MAX_HEIGHT_ERROR)) {
    const middle = samples[1].point;
    refineLine(start, middle, heightAt, y, depth + 1, output, samples[0].point);
    refineLine(middle, end, heightAt, y, depth + 1, output, samples[2].point);
    return;
  }
  output.push(end);
}

function appendDrapedDash(dashPoints, start, end, heightAt, y) {
  const points = [start];
  refineLine(start, end, heightAt, y, 0, points);
  for (let index = 0; index < points.length - 1; index++) {
    const a = points[index];
    const b = points[index + 1];
    dashPoints.push(
      new THREE.Vector3(a.x, a.y, a.z),
      new THREE.Vector3(b.x, b.y, b.z)
    );
  }
}

export function createRouteOverlayGeometries(routePoints, {
  y = 0.25,
  width = 1.4,
  period = 24,
  dashRatio = 0.55,
  heightAt = () => 0
} = {}) {
  if (!validRoutePoints(routePoints)) return null;

  const safeY = Number.isFinite(y) ? y : 0.25;
  const points = routePoints.map((point) => {
    const sampled = sampledPoint(point[0], point[1], heightAt, safeY);
    return new THREE.Vector3(sampled.x, sampled.y, sampled.z);
  });
  const safeWidth = Number.isFinite(width) && width > 0 ? width : 1.4;
  const halfWidth = safeWidth / 2;
  const ribbonPositions = [];
  const sections = routeSections(routePoints, halfWidth, heightAt, safeY);
  const vertex = (point) => [point.x, point.y, point.z];
  const appendRibbon = (startA, startB, endA, endB) => ribbonPositions.push(
    ...vertex(startA), ...vertex(startB), ...vertex(endA),
    ...vertex(startB), ...vertex(endB), ...vertex(endA)
  );
  for (let i = 0; i < sections.length - 1; i++) {
    for (let rail = 0; rail < ROUTE_RAIL_COUNT - 1; rail++) {
      appendRibbon(
        sections[i].rails[rail],
        sections[i].rails[rail + 1],
        sections[i + 1].rails[rail],
        sections[i + 1].rails[rail + 1]
      );
    }
  }
  const ribbonGeometry = new THREE.BufferGeometry();
  ribbonGeometry.setAttribute('position', new THREE.Float32BufferAttribute(ribbonPositions, 3));
  ribbonGeometry.computeBoundingBox();
  ribbonGeometry.computeBoundingSphere();
  const dashPoints = [];
  const safePeriod = Number.isFinite(period) && period > 0 ? period : 24;
  const safeDashRatio = Number.isFinite(dashRatio) && dashRatio > 0 && dashRatio <= 1
    ? dashRatio
    : 0.55;

  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const length = a.distanceTo(b);
    const count = Math.max(1, Math.floor(length / safePeriod));
    for (let j = 0; j < count; j++) {
      const start = j / count;
      const end = Math.min(1, (j + safeDashRatio) / count);
      const dashStart = interpolatePoint(
        { x: a.x, z: a.z },
        { x: b.x, z: b.z },
        start,
        heightAt,
        safeY
      );
      const dashEnd = interpolatePoint(
        { x: a.x, z: a.z },
        { x: b.x, z: b.z },
        end,
        heightAt,
        safeY
      );
      appendDrapedDash(dashPoints, dashStart, dashEnd, heightAt, safeY);
    }
  }

  const dashGeometry = new THREE.BufferGeometry().setFromPoints(dashPoints);
  return { points, width: safeWidth, ribbonGeometry, dashGeometry };
}
