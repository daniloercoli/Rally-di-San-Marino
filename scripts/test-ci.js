import assert from 'node:assert';
import { readFile } from 'node:fs/promises';

let passed = 0;
function ok(condition, message) {
  assert.ok(condition, message);
  passed++;
  console.log('  ok -', message);
}

const root = new URL('../', import.meta.url);
const readRootFile = (path) => readFile(new URL(path, root), 'utf8');

try {
  console.log('== CI contract ==');
  const packageJson = JSON.parse(await readRootFile('package.json'));
  const packageLock = JSON.parse(await readRootFile('package-lock.json'));
  const nvmrc = (await readRootFile('.nvmrc')).trim();
  const workflow = await readRootFile('.github/workflows/ci.yml');

  ok(nvmrc === '24', '.nvmrc selects Node 24');
  ok(packageJson.engines?.node === '>=20', 'package.json documents the supported Node baseline');
  ok(packageLock.packages?.['']?.engines?.node === packageJson.engines.node, 'lockfile root metadata matches package engines');
  ok(packageJson.scripts?.['check:syntax'] === 'node scripts/check-syntax.js', 'package exposes the syntax gate');

  const testScript = packageJson.scripts?.test || '';
  const buildPosition = testScript.indexOf('npm run build');
  const productionPosition = testScript.indexOf('npm run test:production');
  ok(testScript.includes('npm run test:server') && testScript.includes('npm run test:elevation') &&
    testScript.includes('npm run test:world') && productionPosition >= 0,
  'npm test includes every offline suite and the production smoke');
  ok(buildPosition >= 0 && buildPosition < productionPosition, 'npm test builds before the production smoke');

  const checkoutActionMajor = Number(workflow.match(/uses:\s*actions\/checkout@v(\d+)/)?.[1]);
  const setupNodeActionMajor = Number(workflow.match(/uses:\s*actions\/setup-node@v(\d+)/)?.[1]);
  ok(checkoutActionMajor >= 5 && setupNodeActionMajor >= 5 &&
    /node-version-file:\s*\.nvmrc/.test(workflow) && /cache:\s*npm/.test(workflow),
  'workflow uses Node 24-native actions and installs Node from .nvmrc with npm caching');
  ok(/run:\s*npm ci/.test(workflow) && /run:\s*npm run check:syntax/.test(workflow) &&
    /run:\s*npm test/.test(workflow) && /run:\s*npm run validate:world/.test(workflow) &&
    /run:\s*npm run build/.test(workflow),
  'workflow runs install, syntax, tests, world validation and build gates');
  ok(/timeout-minutes:\s*\d+/.test(workflow), 'workflow bounds execution time');
  ok(!/npm run fetch-(?:map|buildings|elevation|world)/.test(workflow) &&
    !/secrets\./.test(workflow) && !/upload-artifact/.test(workflow),
  'workflow uses no geographic provider, credential or generated-data artifact');

  console.log(passed + ' tests passed');
} catch (error) {
  console.error('FAILED:', error.message);
  throw error;
}
