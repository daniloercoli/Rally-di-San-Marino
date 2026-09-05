export const M_PER_DEG_LAT = 110574;
export const M_PER_DEG_LON = 111320;
export const SURFACE = Object.freeze({
  ASPHALT: 'asphalt',
  SHOULDER: 'shoulder',
  TRACK: 'track',
  GRAVEL: 'gravel',
  MUD: 'mud',
  GRASS: 'grass'
});

export const ROAD_DRIVE_TOLERANCE = 1;
export const ROAD_SHOULDER_WIDTH = 1.5;

export function createProjection(centerLon, centerLat) {
  const kLon = M_PER_DEG_LON * Math.cos((centerLat * Math.PI) / 180);
  return {
    centerLon,
    centerLat,
    kLon,
    toLocal(lon, lat) {
      return {
        x: (lon - centerLon) * kLon,
        z: (centerLat - lat) * M_PER_DEG_LAT
      };
    },
    toLonLat(x, z) {
      return {
        lon: centerLon + x / kLon,
        lat: centerLat - z / M_PER_DEG_LAT
      }
    }
  };
}

export function clamp(v, min, max) {
  return v < min ? min : v > max ? max : v;
}

export function pointToSegment(px, pz, ax, az, bx, bz) {
  return projectToSegment(px, pz, ax, az, bx, bz).distance;
}

export function projectToSegment(px, pz, ax, az, bx, bz) {
  const abx = bx - ax;
  const abz = bz - az;
  const apx = px - ax;
  const apz = pz - az;
  const len2 = abx * abx + abz * abz;
  let t = len2 > 0 ? (apx * abx + apz * abz) / len2 : 0;
  t = clamp(t, 0, 1);
  const cx = ax + abx * t;
  const cz = az + abz * t;
  return { x: cx, z: cz, t, distance: Math.hypot(px - cx, pz - cz) };
}

export class RoadIndex {
  constructor(roads, cellSize = 30) {
    this.cellSize = cellSize;
    this.cells = new Map();
    this.segments = [];
    this.maxHalfWidth = 0;
    for (const road of roads) {
      const pts = road.points;
      for (let i = 0; i < pts.length - 1; i++) {
        const ax = pts[i][0];
        const az = pts[i][1];
        const bx = pts[i + 1][0];
        const bz = pts[i + 1][1];
        const c0x = Math.floor(Math.min(ax, bx) / cellSize);
        const c1x = Math.floor(Math.max(ax, bx) / cellSize);
        const c0z = Math.floor(Math.min(az, bz) / cellSize);
        const c1z = Math.floor(Math.max(az, bz) / cellSize);
        const seg = {
          ax,
          az,
          bx,
          bz,
          halfW: road.width / 2,
          isTrack: road.isTrack,
          driveSurface: road.driveSurface === SURFACE.ASPHALT ||
            road.driveSurface === SURFACE.TRACK ||
            road.driveSurface === SURFACE.GRAVEL ||
            road.driveSurface === SURFACE.MUD
            ? road.driveSurface
            : road.isTrack || road.isUnpaved ? SURFACE.TRACK : SURFACE.ASPHALT,
          streetName: typeof road.name === 'string' ? road.name : null
        };
        this.maxHalfWidth = Math.max(this.maxHalfWidth, seg.halfW);
        this.segments.push(seg);
        for (let cx = c0x; cx <= c1x; cx++) {
          for (let cz = c0z; cz <= c1z; cz++) {
            const key = cx + ',' + cz;
            let cell = this.cells.get(key);
            if (!cell) {
              cell = [];
              this.cells.set(key, cell);
            }
            cell.push(seg);
          }
        }
      }
    }
  }

  query(x, z) {
    const cx = Math.floor(x / this.cellSize);
    const cz = Math.floor(z / this.cellSize);
    let best = Infinity;
    let bestIsTrack = false;
    let bestDriveSurface = SURFACE.ASPHALT;
    let bestNamedDistance = Infinity;
    let streetName = null;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const cell = this.cells.get(cx + dx + ',' + (cz + dz));
        if (!cell) continue;
        for (const seg of cell) {
          const centerDistance = pointToSegment(x, z, seg.ax, seg.az, seg.bx, seg.bz);
          const d = centerDistance - seg.halfW;
          if (d < best) {
            best = d;
            bestIsTrack = seg.isTrack;
            bestDriveSurface = seg.driveSurface;
          }
          if (seg.streetName && d <= 1.0 && centerDistance < bestNamedDistance) {
            bestNamedDistance = centerDistance;
            streetName = seg.streetName;
          }
        }
      }
    }
    const onRoad = best <= ROAD_DRIVE_TOLERANCE;
    let surface = SURFACE.GRASS;
    if (best <= 0 || (bestIsTrack && onRoad)) {
      surface = bestDriveSurface;
    } else if (!bestIsTrack && best <= ROAD_SHOULDER_WIDTH) {
      surface = SURFACE.SHOULDER;
    }
    return {
      onRoad,
      clearance: best,
      isTrack: bestIsTrack,
      surface,
      streetName: onRoad ? streetName : null
    };
  }

  segmentsInBounds(bounds, margin = 0) {
    if (!bounds || !Number.isFinite(bounds.minX) || !Number.isFinite(bounds.maxX) ||
      !Number.isFinite(bounds.minZ) || !Number.isFinite(bounds.maxZ) ||
      bounds.minX > bounds.maxX || bounds.minZ > bounds.maxZ) return [];
    const safeMargin = Number.isFinite(margin) && margin >= 0 ? margin : 0;
    const searchMargin = this.maxHalfWidth + safeMargin;
    const minCellX = Math.floor((bounds.minX - searchMargin) / this.cellSize);
    const maxCellX = Math.floor((bounds.maxX + searchMargin) / this.cellSize);
    const minCellZ = Math.floor((bounds.minZ - searchMargin) / this.cellSize);
    const maxCellZ = Math.floor((bounds.maxZ + searchMargin) / this.cellSize);
    const candidates = new Set();
    for (let cellX = minCellX; cellX <= maxCellX; cellX++) {
      for (let cellZ = minCellZ; cellZ <= maxCellZ; cellZ++) {
        const cell = this.cells.get(cellX + ',' + cellZ);
        if (!cell) continue;
        for (const segment of cell) candidates.add(segment);
      }
    }
    return [...candidates].filter((segment) => {
      const padding = segment.halfW + safeMargin;
      return Math.min(segment.ax, segment.bx) - padding <= bounds.maxX &&
        Math.max(segment.ax, segment.bx) + padding >= bounds.minX &&
        Math.min(segment.az, segment.bz) - padding <= bounds.maxZ &&
        Math.max(segment.az, segment.bz) + padding >= bounds.minZ;
    });
  }

  nearestPoints(x, z, limit = 24) {
    if (!Number.isFinite(x) || !Number.isFinite(z) || !Number.isInteger(limit) || limit <= 0) return [];
    return this.segments
      .map((seg) => {
        const projected = projectToSegment(x, z, seg.ax, seg.az, seg.bx, seg.bz);
        return {
          ...seg,
          ...projected,
          yaw: Math.atan2(seg.bx - seg.ax, -(seg.bz - seg.az))
        };
      })
      .sort((a, b) => a.distance - b.distance || a.ax - b.ax || a.az - b.az || a.bx - b.bx || a.bz - b.bz)
      .slice(0, limit);
  }
}
