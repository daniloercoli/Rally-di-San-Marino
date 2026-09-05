import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildFinalAsset, RUNTIME_FILE_NAME, validateCheckpoint, validateRuntimeAsset } from '../shared/elevation.js';
import { roadsDescriptor, sha256Hex, writeAtomic } from './elevation-store.js';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export async function rebuildElevation({ sourcePath, dataRoot }) {
  const { descriptor, roadsSha256 } = await roadsDescriptor(dataRoot);
  const sourceRaw = await readFile(sourcePath, 'utf8');
  const source = JSON.parse(sourceRaw);
  const check = validateCheckpoint(source, descriptor, roadsSha256);
  if (!check.ok) throw new Error('Sorgente elevation non valida: ' + check.reason);
  if (source.completed !== descriptor.total) {
    throw new Error(`Sorgente elevation incompleta: ${source.completed}/${descriptor.total}`);
  }
  const asset = {
    ...buildFinalAsset({ elev: source.elevations, descriptor, roadsSha256 }),
    sourceSha256: await sha256Hex(sourceRaw)
  };
  const assetCheck = validateRuntimeAsset(asset, descriptor, roadsSha256);
  if (!assetCheck.ok) throw new Error('Asset elevation non valido: ' + assetCheck.reason);
  const serialized = JSON.stringify(asset);
  const outputPath = join(dataRoot, RUNTIME_FILE_NAME);
  await writeAtomic(outputPath, serialized);
  return { outputPath, points: asset.heights.length, sha256: await sha256Hex(serialized) };
}

async function main() {
  const options = {
    sourcePath: join(repositoryRoot, 'data-sources/elevation-raw.json'),
    dataRoot: join(repositoryRoot, 'public/data')
  };
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 2) {
    if (!['--source', '--data-root'].includes(args[i]) || !args[i + 1] || args[i + 1].startsWith('--')) {
      throw new Error('Uso: node scripts/rebuild-elevation.js [--source <file>] [--data-root <directory>]');
    }
    options[args[i] === '--source' ? 'sourcePath' : 'dataRoot'] = resolve(args[i + 1]);
  }
  console.log(JSON.stringify(await rebuildElevation(options)));
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
