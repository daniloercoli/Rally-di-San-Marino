import { readFileSync } from 'node:fs';

const data = JSON.parse(readFileSync(new URL('../public/data/roads.json', import.meta.url), 'utf8'));

const ways = data.elements.filter((e) => e.type === 'way');
const nodes = data.elements.filter((e) => e.type === 'node');
const relations = data.elements.filter((e) => e.type === 'relation');

const byClass = {};
let totalLength = 0;
const R = 6371000;
function distMeters(lon1, lat1, lon2, lat2) {
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

for (const w of ways) {
  const cls = w.tags.highway || 'unknown';
  byClass[cls] = (byClass[cls] || 0) + 1;
  const geom = w.geometry;
  for (let i = 0; i < geom.length - 1; i++) {
    totalLength += distMeters(geom[i].lon, geom[i].lat, geom[i + 1].lon, geom[i + 1].lat);
  }
}

let minLon = 180, maxLon = -180, minLat = 90, maxLat = -90;
for (const w of ways) {
  for (const p of w.geometry || []) {
    minLon = Math.min(minLon, p.lon); maxLon = Math.max(maxLon, p.lon);
    minLat = Math.min(minLat, p.lat); maxLat = Math.max(maxLat, p.lat);
  }
}

console.log('ways:', ways.length);
console.log('highway classes:', JSON.stringify(byClass, null, 2));
console.log('total road length km:', (totalLength / 1000).toFixed(1));
console.log('bbox:', { minLon: minLon.toFixed(5), maxLon: maxLon.toFixed(5), minLat: minLat.toFixed(5), maxLat: maxLat.toFixed(5) });
console.log('bbox size km:', {
  ew: ((maxLon - minLon) * 111320 * Math.cos((minLat * Math.PI) / 180) / 1000).toFixed(2),
  ns: ((maxLat - minLat) * 110574 / 1000).toFixed(2)
});
console.log('places:');
for (const n of nodes) {
  console.log(`  ${n.tags.name} (place=${n.tags.place}) ${n.lon.toFixed(5)},${n.lat.toFixed(5)}`);
}
console.log('relations:', relations.length);
for (const r of relations) console.log('  ', r.tags.name, r.tags.admin_level);
