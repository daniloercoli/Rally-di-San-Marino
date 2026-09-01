import * as THREE from 'three';

const TYPE_GREYS = Object.freeze({
  house: [0.62, 0.64, 0.66],
  residential: [0.58, 0.60, 0.62],
  apartment: [0.52, 0.54, 0.57],
  apartments: [0.52, 0.54, 0.57],
  detached: [0.64, 0.65, 0.66],
  semi_detached: [0.59, 0.61, 0.63],
  terraced_house: [0.56, 0.58, 0.60],
  farmyard: [0.48, 0.49, 0.50],
  farm: [0.48, 0.49, 0.50],
  commercial: [0.47, 0.50, 0.53],
  office: [0.50, 0.53, 0.56],
  school: [0.66, 0.67, 0.68],
  public: [0.63, 0.64, 0.65],
  church: [0.70, 0.70, 0.68],
  cathedral: [0.72, 0.72, 0.70],
  place_of_worship: [0.70, 0.70, 0.68],
  industrial: [0.42, 0.44, 0.46],
  warehouse: [0.40, 0.42, 0.44],
  yes: [0.57, 0.59, 0.61]
});

export const BUILDING_GROUND_EMBED_M = 0.5;

function stableHash(value) {
  const text = String(value ?? 'building');
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
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

function ringArea(ring) {
  let area = 0;
  for (let i = 0; i < ring.length; i++) {
    const next = ring[(i + 1) % ring.length];
    area += ring[i][0] * next[1] - next[0] * ring[i][1];
  }
  return area / 2;
}

export function buildingHeight(tags = {}) {
  let height = Number.parseFloat(tags.height);
  if (!Number.isFinite(height) || height <= 0) {
    const levels = Number.parseFloat(tags['building:levels']);
    height = Number.isFinite(levels) && levels > 0 ? levels * 3 : 9;
  }
  return Math.max(3, Math.min(height, 80));
}

export function buildingGray(footprint) {
  const type = footprint?.tags?.building;
  const base = TYPE_GREYS[type] || TYPE_GREYS.yes;
  const hash = stableHash(footprint?.sourceId ?? footprint?.id);
  const variation = ((hash % 17) - 8) / 200;
  return {
    r: Math.max(0.32, Math.min(0.78, base[0] + variation)),
    g: Math.max(0.32, Math.min(0.78, base[1] + variation)),
    b: Math.max(0.32, Math.min(0.78, base[2] + variation))
  };
}

export function buildingPlacement(footprint, heightAt = () => 0) {
  const ring = footprint?.outer;
  if (!Array.isArray(ring) || ring.length < 3 || typeof heightAt !== 'function') return null;
  const center = ringCenter(ring);
  const sampledHeight = heightAt(center.x, center.z);
  const terrainY = Number.isFinite(sampledHeight) ? sampledHeight : 0;
  return {
    x: center.x,
    z: center.z,
    baseY: terrainY - BUILDING_GROUND_EMBED_M,
    height: buildingHeight(footprint.tags)
  };
}

export function createBuildingWindowGeometry(footprints, {
  heightAt = () => 0,
  maxFacades = 2,
  maxFloors = 3
} = {}) {
  if (!Array.isArray(footprints) || typeof heightAt !== 'function') return null;
  const positions = [];
  const colors = [];
  let panelCount = 0;

  for (const footprint of footprints) {
    const ring = footprint?.outer;
    if (!Array.isArray(ring) || ring.length < 3) continue;
    const type = footprint.tags?.building;
    const hash = stableHash(footprint.sourceId ?? footprint.id);
    if ((type === 'warehouse' || type === 'industrial') && hash % 3 === 0) continue;
    const placement = buildingPlacement(footprint, heightAt);
    if (!placement) continue;
    const { baseY, height } = placement;
    const floors = Math.min(maxFloors, Math.max(1, Math.floor((height - 1.2) / 2.8)));
    const orientation = ringArea(ring) >= 0 ? 1 : -1;
    const edges = [];
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (length >= 4) edges.push({ a, b, length, index: i });
    }
    edges.sort((a, b) => b.length - a.length || a.index - b.index);

    for (const edge of edges.slice(0, maxFacades)) {
      const ux = (edge.b[0] - edge.a[0]) / edge.length;
      const uz = (edge.b[1] - edge.a[1]) / edge.length;
      const nx = orientation * uz;
      const nz = orientation * -ux;
      const across = Math.min(3, Math.max(1, Math.floor(edge.length / 6)));
      const panelWidth = Math.min(1.5, edge.length / (across * 2 + 1));
      for (let floor = 0; floor < floors; floor++) {
        const y0 = baseY + 1.45 + floor * 2.65;
        const y1 = Math.min(baseY + height - 0.45, y0 + 0.9);
        if (y1 <= y0) continue;
        for (let panel = 0; panel < across; panel++) {
          const t = (panel + 1) / (across + 1);
          const cx = edge.a[0] + (edge.b[0] - edge.a[0]) * t + nx * 0.045;
          const cz = edge.a[1] + (edge.b[1] - edge.a[1]) * t + nz * 0.045;
          const hx = ux * panelWidth / 2;
          const hz = uz * panelWidth / 2;
          positions.push(
            cx - hx, y0, cz - hz,
            cx + hx, y0, cz + hz,
            cx - hx, y1, cz - hz,
            cx + hx, y0, cz + hz,
            cx + hx, y1, cz + hz,
            cx - hx, y1, cz - hz
          );
          const tint = ((hash + floor * 7 + panel * 11) % 13) / 100;
          for (let vertex = 0; vertex < 6; vertex++) {
            colors.push(0.19 + tint, 0.27 + tint, 0.31 + tint);
          }
          panelCount++;
        }
      }
    }
  }

  if (positions.length === 0) return null;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  geometry.userData.panelCount = panelCount;
  return geometry;
}
