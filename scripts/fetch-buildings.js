import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const query = readFileSync(join(__dirname, 'overpass-buildings.ql'), 'utf8');

const endpoints = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter'
];

let lastErr;
for (const url of endpoints) {
  try {
    console.log(`Trying ${url} ...`);
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'rally-san-marino-prototype/0.1 (contact: local dev)'
      },
      body: 'data=' + encodeURIComponent(query),
      signal: AbortSignal.timeout(300000)
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const ways = json.elements.filter((e) => e.type === 'way').length;
    const rels = json.elements.filter((e) => e.type === 'relation').length;
    const outDir = join(__dirname, '..', 'public', 'data');
    mkdirSync(outDir, { recursive: true });
    const outPath = join(outDir, 'buildings.json');
    writeFileSync(outPath, JSON.stringify(json));
    console.log(`Saved ${ways} ways, ${rels} relations to ${outPath}`);
    process.exit(0);
  } catch (e) {
    lastErr = e;
    console.error(`Failed ${url}: ${e.message}`);
  }
}
console.error('All Overpass endpoints failed:', lastErr && lastErr.message);
process.exit(1);
