import assert from 'node:assert';
import http from 'node:http';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { io } from 'socket.io-client';
import { startServer } from '../server.js';

let passed = 0;
function ok(cond, msg) {
  assert.ok(cond, msg);
  passed++;
  console.log('  ok -', msg);
}

const trackedServers = new Set();
const trackedSockets = new Set();
let failure = null;

async function httpGet(url, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => resolve({ statusCode: res.statusCode, data }));
    });
    req.on('error', reject);
    req.setTimeout(timeout, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function waitForSocket(socket, event, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('timeout waiting for Socket.IO ' + event));
    }, timeout);
    function cleanup() {
      clearTimeout(timer);
      socket.off(event, onEvent);
      socket.off('connect_error', onError);
    }
    function onEvent(data) {
      cleanup();
      resolve(data);
    }
    function onError(error) {
      cleanup();
      reject(error);
    }
    socket.once(event, onEvent);
    socket.once('connect_error', onError);
  });
}

try {
  console.log('== production smoke test ==');

  const distRoot = join(process.cwd(), 'dist');
  const dataRoot = join(process.cwd(), 'public', 'data');

  ok(existsSync(distRoot), 'dist/ directory exists');
  ok(existsSync(join(distRoot, 'index.html')), 'dist/index.html exists');
  ok(existsSync(join(dataRoot, 'roads.json')), 'roads.json exists');
  ok(existsSync(join(dataRoot, 'buildings.json')), 'buildings.json exists');

  const s = startServer({ devMode: false });
  trackedServers.add(s);
  const port = await new Promise((resolve) => {
    s.server.listen(0, () => resolve(s.server.address().port));
  });
  const baseUrl = 'http://localhost:' + port;

  const indexRes = await httpGet(baseUrl + '/');
  ok(indexRes.statusCode === 200, 'index.html returns 200');
  ok(indexRes.data.includes('<title>Rally San Marino</title>'), 'index.html contains title');
  ok(!indexRes.data.includes('/socket.io/socket.io.js'), 'HTML does not require the classic Socket.IO client asset');

  const iconTag = indexRes.data.match(/<link\s+[^>]*rel="icon"[^>]*>/)?.[0];
  ok(iconTag, 'HTML references a browser icon');
  ok(iconTag.includes('type="image/png"') && iconTag.includes('sizes="64x64"'),
    'browser icon declares its PNG type and dimensions');
  const iconHref = iconTag.match(/href="([^"]+)"/)?.[1];
  ok(iconHref, 'browser icon exposes a valid asset URL');
  const iconRes = await httpGet(new URL(iconHref, baseUrl).href);
  ok(iconRes.statusCode === 200 && iconRes.data.length > 0,
    'browser icon returns a non-empty 200 response');

  const jsMatch = indexRes.data.match(/type="module"[^>]+src="(\/[^"]+)"/);
  ok(jsMatch, 'HTML references a JS module');
  const jsUrl = baseUrl + jsMatch[1];
  const jsRes = await httpGet(jsUrl);
  ok(jsRes.statusCode === 200, 'JS module returns 200');
  ok(!jsRes.data.includes('shared/'), 'JS bundle does not expose bare imports');

  const roadsRes = await httpGet(baseUrl + '/data/roads.json');
  ok(roadsRes.statusCode === 200, '/data/roads.json returns 200');
  const roads = JSON.parse(roadsRes.data);
  ok(Array.isArray(roads.elements), 'roads.json has elements array');

  const buildingsRes = await httpGet(baseUrl + '/data/buildings.json');
  ok(buildingsRes.statusCode === 200, '/data/buildings.json returns 200');

  const elevationRes = await httpGet(baseUrl + '/data/elevation.json');
  const expectedElevationStatus = existsSync(join(dataRoot, 'elevation.json')) ? 200 : 404;
  ok(elevationRes.statusCode === expectedElevationStatus, 'optional /data/elevation.json presence is served accurately');

  const partialRes = await httpGet(baseUrl + '/data/.elevation-part.json');
  ok(partialRes.statusCode === 404, '/data/.elevation-part.json returns 404');

  const traversalRes = await httpGet(baseUrl + '/data/../server.js');
  ok(traversalRes.statusCode === 404, 'path traversal returns 404');

  const unknownRes = await httpGet(baseUrl + '/data/unknown.json');
  ok(unknownRes.statusCode === 404, 'unknown data file returns 404');

  const socket = io(baseUrl, {
    transports: ['websocket'],
    reconnection: false,
    forceNew: true
  });
  trackedSockets.add(socket);
  await waitForSocket(socket, 'connect');
  ok(socket.connected, 'Socket.IO handshake succeeds from the production origin');
  const initPromise = waitForSocket(socket, 'init');
  socket.emit('join', { name: 'Smoke' });
  const init = await initPromise;
  ok(init.you === 1 && Array.isArray(init.route) && init.route.length > 2, 'same-origin production client can join and receive init');

  console.log(passed + ' tests passed');
} catch (error) {
  failure = error;
  console.error('FAILED:', error.message);
} finally {
  for (const socket of trackedSockets) {
    socket.removeAllListeners();
    socket.disconnect();
    socket.io.removeAllListeners();
    socket.io.disconnect();
    socket.io.engine?.close();
  }
  for (const activeServer of trackedServers) {
    try {
      activeServer.io.disconnectSockets(true);
      activeServer.close();
      activeServer.server.closeAllConnections?.();
    } catch (e) {}
  }
}

if (failure) throw failure;
