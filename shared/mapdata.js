export const ROAD_CLASSES = {
  // Minimum playable widths. Valid OSM width/lanes tags can widen a road but never make
  // the arcade carriageway narrower than these class defaults. The rendering lift and
  // priority deliberately put major roads above minor roads at shared junctions.
  primary: { width: 14, y: 0.19, color: 0x363a41, priority: 8 },
  primary_link: { width: 14, y: 0.17, color: 0x363a41, priority: 7 },
  secondary: { width: 13, y: 0.15, color: 0x40454d, priority: 6 },
  tertiary: { width: 12, y: 0.13, color: 0x4a5058, priority: 5 },
  tertiary_link: { width: 12, y: 0.11, color: 0x4a5058, priority: 4 },
  unclassified: { width: 11, y: 0.09, color: 0x545b64, priority: 3 },
  residential: { width: 11, y: 0.07, color: 0x545b64, priority: 2 },
  track: { width: 8, y: 0.05, color: 0x545b64, priority: 1, isTrack: true }
};

export const UNPAVED_ROAD_COLOR = 0x6b5d4f;
export const TRACK_SURFACE_FALLBACK_COLOR = 0x80796d;

export const ROAD_SURFACE_COLORS = Object.freeze({
  asphalt: ROAD_CLASSES.track.color,
  chipseal: 0x646970,
  paved: 0x5d636b,
  concrete: 0xaaa89f,
  'concrete:lanes': 0xaaa89f,
  'concrete:plates': 0xaaa89f,
  cobblestone: 0x85857f,
  paving_stones: 0x8f9089,
  sett: 0x7d7e79,
  metal: 0x777d82,
  wood: 0x7d6953,
  gravel: 0xc7c0aa,
  fine_gravel: 0xd1cbb9,
  pebblestone: 0xb7b09c,
  compacted: 0xaa9a7e,
  ground: 0x8b6d4f,
  dirt: 0x79573f,
  earth: 0x76543e,
  clay: 0xa56e4f,
  unpaved: 0x9a8060,
  mud: 0x3c2b24,
  grass: 0x68765e,
  grass_paver: 0x77806c,
  sand: 0xc9bc8c,
  ford: 0x586b70
});

const PAVED_SURFACES = new Set([
  'asphalt',
  'chipseal',
  'cobblestone',
  'concrete',
  'concrete:lanes',
  'concrete:plates',
  'metal',
  'paved',
  'paving_stones',
  'sett',
  'wood'
]);

const UNPAVED_SURFACES = new Set([
  'clay',
  'compacted',
  'dirt',
  'earth',
  'fine_gravel',
  'grass',
  'grass_paver',
  'gravel',
  'ground',
  'mud',
  'pebblestone',
  'sand',
  'unpaved'
]);

export function normalizeRoadSurface(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return normalized && normalized.length <= 40 ? normalized : null;
}

export function roadIsUnpaved(tags) {
  const surface = normalizeRoadSurface(tags?.surface);
  if (PAVED_SURFACES.has(surface)) return false;
  if (UNPAVED_SURFACES.has(surface)) return true;
  return tags?.highway === 'track';
}

export function roadColorFromTags(tags, classColor = ROAD_CLASSES[tags?.highway]?.color) {
  const baseColor = Number.isInteger(classColor) ? classColor : ROAD_CLASSES.track.color;
  if (tags?.highway === 'track' || tags?.highway === 'unclassified') {
    const surface = normalizeRoadSurface(tags.surface);
    if (!surface) return tags.highway === 'track' ? TRACK_SURFACE_FALLBACK_COLOR : baseColor;
    return ROAD_SURFACE_COLORS[surface] ?? TRACK_SURFACE_FALLBACK_COLOR;
  }
  return roadIsUnpaved(tags) ? UNPAVED_ROAD_COLOR : baseColor;
}

const MAX_PLAYABLE_ROAD_WIDTH = 24;
export const ROAD_NAME_MAX_LENGTH = 80;

export function normalizeRoadName(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().replace(/\s+/g, ' ');
  if (!normalized || normalized.length > ROAD_NAME_MAX_LENGTH || /[\u0000-\u001f\u007f]/.test(normalized)) {
    return null;
  }
  return normalized;
}

export function parseOsmWidth(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const normalized = String(value).trim().replace(',', '.');
  const metric = normalized.match(/^(\d+(?:\.\d+)?)\s*(?:m|metres?|meters?)?$/i);
  let width = metric ? Number(metric[1]) : Number.NaN;
  if (!metric) {
    const feet = normalized.match(/^(\d+(?:\.\d+)?)\s*(?:ft|feet|')$/i);
    if (feet) width = Number(feet[1]) * 0.3048;
  }
  return Number.isFinite(width) && width >= 1 && width <= MAX_PLAYABLE_ROAD_WIDTH
    ? width
    : null;
}

export function parseOsmLanes(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const normalized = String(value).trim();
  if (!/^\d+$/.test(normalized)) return null;
  const lanes = Number(normalized);
  return Number.isInteger(lanes) && lanes >= 1 && lanes <= 6 ? lanes : null;
}

export function roadWidthFromTags(tags, classWidth) {
  const minimum = Number.isFinite(classWidth) && classWidth > 0 ? classWidth : 8;
  const explicitWidth = parseOsmWidth(tags?.width);
  const lanes = parseOsmLanes(tags?.lanes);
  const lanesWidth = lanes === null ? null : lanes * 3.5 + 4;
  const candidates = [
    { width: minimum, source: 'class' },
    { width: explicitWidth, source: 'width' },
    { width: lanesWidth, source: 'lanes' }
  ].filter((candidate) => Number.isFinite(candidate.width));
  candidates.sort((a, b) => b.width - a.width);
  return {
    width: Math.min(candidates[0].width, MAX_PLAYABLE_ROAD_WIDTH),
    source: candidates[0].source,
    explicitWidth,
    lanes
  };
}

function decimate(pts, minDist) {
  if (pts.length < 3) return pts;
  const out = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const prev = out[out.length - 1];
    const dx = pts[i][0] - prev[0];
    const dz = pts[i][1] - prev[1];
    if (dx * dx + dz * dz >= minDist * minDist) out.push(pts[i]);
  }
  const last = pts[pts.length - 1];
  const tail = out[out.length - 1];
  if (tail[0] !== last[0] || tail[1] !== last[1]) out.push(last);
  return out;
}

export function parseMapData(json) {
  let minLon = 180, maxLon = -180, minLat = 90, maxLat = -90;
  for (const el of json.elements) {
    if (el.type !== 'way' || !el.geometry) continue;
    for (const p of el.geometry) {
      if (p.lon < minLon) minLon = p.lon;
      if (p.lon > maxLon) maxLon = p.lon;
      if (p.lat < minLat) minLat = p.lat;
      if (p.lat > maxLat) maxLat = p.lat;
    }
  }
  const centerLon = (minLon + maxLon) / 2;
  const centerLat = (minLat + maxLat) / 2;
  const kLon = 111320 * Math.cos((centerLat * Math.PI) / 180);
  const toLocal = (lon, lat) => [
    (lon - centerLon) * kLon,
    (centerLat - lat) * 110574
  ];

  const roads = [];
  const places = [];
  for (const el of json.elements) {
    if (el.type === 'way' && el.tags && el.tags.highway) {
      const cls = ROAD_CLASSES[el.tags.highway];
      if (!cls) continue;
      const measuredWidth = roadWidthFromTags(el.tags, cls.width);
      const surface = normalizeRoadSurface(el.tags.surface);
      const isUnpaved = roadIsUnpaved(el.tags);
      const pts = decimate(el.geometry.map((g) => toLocal(g.lon, g.lat)), 2);
      if (pts.length < 2) continue;
      roads.push({
        cls: el.tags.highway,
        name: normalizeRoadName(el.tags.name),
        width: measuredWidth.width,
        widthSource: measuredWidth.source,
        osmWidth: measuredWidth.explicitWidth,
        lanes: measuredWidth.lanes,
        y: cls.y,
        color: roadColorFromTags(el.tags, cls.color),
        priority: cls.priority,
        isTrack: !!cls.isTrack,
        isUnpaved,
        surface,
        points: pts
      });
    } else if (el.type === 'node' && el.tags && el.tags.name && el.tags.place) {
      const [x, z] = toLocal(el.lon, el.lat);
      places.push({ name: el.tags.name, x, z, place: el.tags.place });
    }
  }

  const proj = {
    centerLon,
    centerLat,
    kLon,
    toLocal(lon, lat) {
      return { x: (lon - centerLon) * kLon, z: (centerLat - lat) * 110574 };
    },
    toLonLat(x, z) {
      return { lon: centerLon + x / kLon, lat: centerLat - z / 110574 };
    }
  };

  const margin = 1000;
  const bbox = {
    minX: -((maxLon - minLon) * kLon) / 2 - margin,
    maxX: ((maxLon - minLon) * kLon) / 2 + margin,
    minZ: -((maxLat - minLat) * 110574) / 2 - margin,
    maxZ: ((maxLat - minLat) * 110574) / 2 + margin
  };

  return { roads, places, proj, bbox, center: { x: 0, z: 0 } };
}
