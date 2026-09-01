import { readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const sourceDirectories = ['public/src', 'scripts', 'shared'];
const sourceFiles = ['server.js', 'vite.config.js'];

function collectJavaScriptFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...collectJavaScriptFiles(path));
    else if (entry.isFile() && entry.name.endsWith('.js')) files.push(path);
  }
  return files;
}

const files = [
  ...sourceFiles.map((path) => join(root, path)),
  ...sourceDirectories.flatMap((path) => collectJavaScriptFiles(join(root, path)))
].sort();

for (const file of files) {
  const displayPath = relative(root, file);
  console.log('[syntax]', displayPath);
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

console.log(`[syntax] ${files.length} JavaScript files passed`);
