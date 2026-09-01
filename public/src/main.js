import * as THREE from 'three';
import { parseMapData } from 'shared/mapdata.js';
import { fitBuildingFootprintsToRoads, projectBuildingFootprints } from 'shared/buildings.js';
import { RoadIndex } from 'shared/geometry.js';
import { createRoutePaceNotes } from 'shared/route.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  engineTargets,
  localImpactEvent,
  normalizeDrivetrainSnapshot,
  normalizeImpactSnapshot,
  normalizeSurfaceSnapshot,
  selectLocalSnapshot
} from './engine-audio.js';
import { INITIAL_JOIN_STATE, joinView, transitionJoin } from './join-state.js';
import { readDrivingInput, shouldPreventDrivingKey } from './input-state.js';
import { createCarModel } from './car-model.js';
import { createRoadGeometryBatches } from './road-geometry.js';
import {
  buildingGray,
  buildingPlacement,
  createBuildingWindowGeometry
} from './building-style.js';
import { lobbyView, normalizeRouteLobby } from './route-lobby.js';
import {
  createRouteOverlayGeometries,
  routeOverlayKey,
  routeTargetVisibility
} from './route-overlay.js';
import {
  checkpointCoverageLabel,
  localCheckpointEvent,
  normalizeCheckpointCoverage
} from './checkpoint-stats.js';
import {
  createRouteSignGroup,
  normalizeRouteDirections,
  normalizeRoutePath,
  updateRouteSignVisibility
} from './route-signs.js';
import { disposeObject3D } from './scene-resources.js';
import { installQaMetrics } from './qa-metrics.js';
import { randomPlayerIdentity } from './player-identity.js';
import { startSignalAudioEvent, startSignalView } from './start-lights.js';
import { surfaceShake } from './surface-effects.js';
import {
  composeVehicleAttitude,
  smoothVehicleAttitude,
  vehicleTerrainAttitude
} from './vehicle-attitude.js';
import { advanceTurnCue, createTurnCueState } from './turn-cue.js';
import {
  advanceStreetBanner,
  createStreetBannerState,
  selectLocalStreetName
} from './street-name.js';
import {
  CAMERA_SURFACE_CLEARANCE,
  CAR_SURFACE_CLEARANCE,
  RENDER_ELEVATION_SCALE,
  clampHeightAboveTerrain,
  createTerrainPositions,
  mergeWorldGeometries,
  readJsonResponse,
  surfaceHeightWithClearance,
  terrainBackdropHeight,
  terrainMeshHeightAt,
  validateTerrainData
} from './world-data.js';
import { WORLD_HORIZON_COLOR, worldViewForBounds } from './world-view.js';
import { io } from 'socket.io-client';

const $ = (id) => document.getElementById(id);
const app = $('app');
const speedEl = $('speed');
const cpEl = $('cp');
const warnEl = $('warn');
const handbrakeEl = $('handbrake');
const startSignalEl = $('start-signal');
const startLightsEl = $('start-lights');
const startLightEls = [...document.querySelectorAll('.start-light')];
const startGoEl = $('start-go');
const standingsEl = $('standings');
const routeInfoEl = $('route-info');
const joinEl = $('join');
const joinBtn = $('join-btn');
const joinSub = $('join-sub');
const playerSetupEl = $('player-setup');
const identitySetupEl = $('identity-setup');
const playerNameEl = $('player-name');
const playerColorEl = $('player-color');
const routeSelectEl = $('route-select');
const routeHintEl = $('route-hint');
const lobbyControlsEl = $('lobby-controls');
const lobbyPlayersEl = $('lobby-players');
const readyBtn = $('ready-btn');
const startBtn = $('start-btn');
const lobbyStatusEl = $('lobby-status');
const mmEl = $('minimap');
const mmCtx = mmEl.getContext('2d');
const timerEl = $('timer');
const streetNameEl = $('street-name');
const turnCueEl = $('turn-cue');
const turnCuePathEl = $('turn-cue-path');
const turnCueLabelEl = $('turn-cue-label');
const bestEl = $('best');
let mapData = null;
let mmScale = 1, mmOx = 0, mmOy = 0;
let routePath = null;
let routeDashes = null, startRing = null, finishRing = null;
let routePathKey = '';
let routeSigns = null, routeSignsKey = '';
let pbMs = Number(localStorage.getItem('rally-pb')) || null;
let terrainData = null;
let audioCtx = null, engineOsc = null, engineGain = null;
let brakeNoise = null, brakeFilter = null, brakeGainNode = null;
let surfaceNoise = null, surfaceFilter = null, surfaceGainNode = null;
let impactNoiseBuffer = null;

let renderer, scene, camera, cpRing;
let updateQaMetrics = () => {};
const carMeshes = new Map();
const snapshots = new Map();
const keys = new Set();
let me = null;
let routePts = [];
let routeGuidePts = [];
let routeDirections = [];
let routePaceNotes = [];
let totalCp = 0;
let running = false;
let phase = 'waiting';
let round = 0;
let joinState = INITIAL_JOIN_STATE;
let routeLobby = normalizeRouteLobby(null);
let streetBannerState = createStreetBannerState();
let turnCueState = createTurnCueState();
let renderedStartSignal = null;

const initialIdentity = randomPlayerIdentity();
playerNameEl.value = initialIdentity.name;
playerColorEl.value = initialIdentity.color;

function lerpAngle(a, b, t) {
  let d = b - a;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return a + d * t;
}

function fmtTime(ms) {
  if (!ms || ms <= 0) return '';
  const s = ms / 1000;
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return m + ':' + (r < 10 ? '0' : '') + r.toFixed(1);
}

function initAudio() {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return false;
  try {
    if (!audioCtx) {
      audioCtx = new Ctx();
      engineOsc = audioCtx.createOscillator();
      engineGain = audioCtx.createGain();
      const engineFilter = audioCtx.createBiquadFilter();
      engineFilter.type = 'lowpass';
      engineFilter.frequency.value = 120;
      engineOsc.type = 'sawtooth';
      engineOsc.frequency.value = 60;
      engineGain.gain.value = 0;
      engineOsc.connect(engineFilter);
      engineFilter.connect(engineGain);
      engineGain.connect(audioCtx.destination);

      const sampleCount = Math.max(1, Math.floor(audioCtx.sampleRate));
      const noiseBuffer = audioCtx.createBuffer(1, sampleCount, audioCtx.sampleRate);
      const noiseData = noiseBuffer.getChannelData(0);
      for (let i = 0; i < noiseData.length; i++) noiseData[i] = Math.random() * 2 - 1;
      impactNoiseBuffer = noiseBuffer;
      brakeNoise = audioCtx.createBufferSource();
      brakeNoise.buffer = noiseBuffer;
      brakeNoise.loop = true;
      brakeFilter = audioCtx.createBiquadFilter();
      brakeFilter.type = 'bandpass';
      brakeFilter.frequency.value = 900;
      brakeFilter.Q.value = 0.8;
      brakeGainNode = audioCtx.createGain();
      brakeGainNode.gain.value = 0;
      brakeNoise.connect(brakeFilter);
      brakeFilter.connect(brakeGainNode);
      brakeGainNode.connect(audioCtx.destination);

      surfaceNoise = audioCtx.createBufferSource();
      surfaceNoise.buffer = noiseBuffer;
      surfaceNoise.loop = true;
      surfaceFilter = audioCtx.createBiquadFilter();
      surfaceFilter.type = 'bandpass';
      surfaceFilter.frequency.value = 120;
      surfaceFilter.Q.value = 0.7;
      surfaceGainNode = audioCtx.createGain();
      surfaceGainNode.gain.value = 0;
      surfaceNoise.connect(surfaceFilter);
      surfaceFilter.connect(surfaceGainNode);
      surfaceGainNode.connect(audioCtx.destination);

      engineOsc.start();
      brakeNoise.start();
      surfaceNoise.start();
    }
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    return true;
  } catch {
    try { engineOsc?.stop(); } catch {}
    try { brakeNoise?.stop(); } catch {}
    try { surfaceNoise?.stop(); } catch {}
    audioCtx?.close?.().catch?.(() => {});
    audioCtx = null;
    engineOsc = null;
    engineGain = null;
    brakeNoise = null;
    brakeFilter = null;
    brakeGainNode = null;
    surfaceNoise = null;
    surfaceFilter = null;
    surfaceGainNode = null;
    impactNoiseBuffer = null;
    return false;
  }
}

function playImpactSound(level) {
  if (!audioCtx || !impactNoiseBuffer || !Number.isFinite(level) || level <= 0) return;
  const now = audioCtx.currentTime;
  const strength = Math.min(1, Math.max(0, level));
  const noise = audioCtx.createBufferSource();
  const filter = audioCtx.createBiquadFilter();
  const gain = audioCtx.createGain();
  noise.buffer = impactNoiseBuffer;
  filter.type = 'lowpass';
  filter.frequency.setValueAtTime(520 + strength * 620, now);
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.18 + strength * 0.35, now + 0.008);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.22);
  noise.connect(filter);
  filter.connect(gain);
  gain.connect(audioCtx.destination);
  noise.start(now);
  noise.stop(now + 0.23);

  const thud = audioCtx.createOscillator();
  const thudGain = audioCtx.createGain();
  thud.type = 'sine';
  thud.frequency.setValueAtTime(78 + strength * 18, now);
  thud.frequency.exponentialRampToValueAtTime(42, now + 0.16);
  thudGain.gain.setValueAtTime(0.0001, now);
  thudGain.gain.exponentialRampToValueAtTime(0.12 + strength * 0.2, now + 0.006);
  thudGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.18);
  thud.connect(thudGain);
  thudGain.connect(audioCtx.destination);
  thud.start(now);
  thud.stop(now + 0.19);
}

function playRaceTone(kind) {
  if (!audioCtx || (kind !== 'light' && kind !== 'start' && kind !== 'checkpoint')) return;
  const tones = kind === 'light'
    ? [{ frequency: 440, offset: 0, duration: 0.11, gain: 0.2 }]
    : kind === 'start'
      ? [
          { frequency: 660, offset: 0, duration: 0.2, gain: 0.24 },
          { frequency: 990, offset: 0.08, duration: 0.28, gain: 0.2 }
        ]
      : [
          { frequency: 880, offset: 0, duration: 0.1, gain: 0.14 },
          { frequency: 1174, offset: 0.08, duration: 0.18, gain: 0.12 }
        ];
  const now = audioCtx.currentTime;
  for (const tone of tones) {
    const oscillator = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    const start = now + tone.offset;
    const end = start + tone.duration;
    oscillator.type = kind === 'light' ? 'square' : 'sine';
    oscillator.frequency.setValueAtTime(tone.frequency, start);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(tone.gain, start + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, end);
    oscillator.connect(gain);
    gain.connect(audioCtx.destination);
    oscillator.start(start);
    oscillator.stop(end + 0.01);
  }
}

function updateEngine(snapshot) {
  if (!audioCtx || !engineOsc || !engineGain) return;
  const targets = engineTargets(snapshot);
  engineOsc.frequency.setTargetAtTime(targets.frequency, audioCtx.currentTime, 0.1);
  engineGain.gain.setTargetAtTime(targets.gain, audioCtx.currentTime, 0.1);
  brakeFilter?.frequency.setTargetAtTime(targets.brakeFrequency, audioCtx.currentTime, 0.05);
  brakeGainNode?.gain.setTargetAtTime(targets.brakeGain, audioCtx.currentTime, 0.04);
  surfaceFilter?.frequency.setTargetAtTime(targets.surfaceFrequency, audioCtx.currentTime, 0.06);
  surfaceFilter?.Q.setTargetAtTime(targets.surfaceQ, audioCtx.currentTime, 0.06);
  surfaceGainNode?.gain.setTargetAtTime(targets.surfaceGain, audioCtx.currentTime, 0.05);
}

const mmX = (x) => x * mmScale + mmOx;
const mmZ = (z) => z * mmScale + mmOy;
const socket = io();

function renderJoinState() {
  const view = joinView(joinState);
  const lobby = lobbyView(routeLobby, me);
  joinEl.style.display = view.visible || lobby.visible ? 'flex' : 'none';
  playerSetupEl.style.display = view.setup || lobby.visible ? 'block' : 'none';
  identitySetupEl.style.display = lobby.visible ? 'none' : 'block';
  lobbyControlsEl.style.display = lobby.visible ? 'block' : 'none';
  joinBtn.style.display = lobby.visible ? 'none' : 'inline-block';
  joinBtn.disabled = view.disabled;
  joinBtn.textContent = view.label;
  if (!lobby.visible) joinSub.textContent = view.message;

  const canChooseRoute = lobby.canChangeRoute && routeLobby.options.length >= 2;
  routeSelectEl.disabled = !canChooseRoute;
  if (routeLobby.hostId === null) {
    routeHintEl.textContent = 'Il primo giocatore collegato sarà l’host e sceglierà il tracciato.';
  } else if (lobby.isHost && routeLobby.phase === 'waiting') {
    routeHintEl.textContent = 'Sei l’host: puoi cambiare tracciato finché non avvii la gara.';
  } else if (routeLobby.locked) {
    routeHintEl.textContent = 'Tracciato bloccato per la manche in corso.';
  } else {
    routeHintEl.textContent = 'Tracciato scelto dall’host.';
  }

  const playersFragment = document.createDocumentFragment();
  for (const player of routeLobby.players) {
    const row = document.createElement('div');
    row.className = 'player';
    const identity = document.createElement('span');
    identity.className = 'identity';
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.backgroundColor = player.color;
    const suffix = player.id === routeLobby.hostId ? ' ★ host' : '';
    identity.append(dot, document.createTextNode(player.name + suffix));
    const state = document.createElement('span');
    state.className = player.ready ? 'state ready' : 'state';
    state.textContent = player.ready ? 'Pronto' : 'In attesa';
    row.append(identity, state);
    playersFragment.append(row);
  }
  lobbyPlayersEl.replaceChildren(playersFragment);
  readyBtn.textContent = lobby.ready ? 'Non sono pronto' : 'Sono pronto';
  readyBtn.disabled = !lobby.visible;
  startBtn.style.display = lobby.isHost ? 'inline-block' : 'none';
  startBtn.disabled = !lobby.canStart;
  if (lobby.visible) {
    const readyCount = routeLobby.players.filter((player) => player.ready).length;
    joinSub.textContent = `${routeLobby.players.length}/${routeLobby.capacity} piloti nella lobby`;
    lobbyStatusEl.textContent = lobby.isHost
      ? lobby.allReady
        ? 'Tutti pronti: puoi avviare la gara.'
        : `In attesa dei piloti (${readyCount}/${routeLobby.players.length} pronti).`
      : lobby.ready
        ? 'Sei pronto. Attendi che l’host avvii la gara.'
        : 'Conferma quando sei pronto a partire.';
  } else {
    lobbyStatusEl.textContent = '';
  }
}

function updateJoinState(event) {
  const transition = transitionJoin(joinState, event);
  joinState = transition.state;
  renderJoinState();
  return transition.emitJoin;
}

function resetStreetBanner() {
  streetBannerState = createStreetBannerState();
  streetNameEl.textContent = '';
  streetNameEl.style.display = 'none';
}

function updateStreetBanner(value, nowMs = performance.now()) {
  const view = advanceStreetBanner(streetBannerState, value, nowMs);
  streetBannerState = view.state;
  streetNameEl.textContent = view.text;
  streetNameEl.style.display = view.visible ? 'block' : 'none';
}

function resetTurnCue() {
  turnCueState = createTurnCueState();
  turnCueEl.style.display = 'none';
  turnCueEl.removeAttribute('data-turn');
  turnCueEl.removeAttribute('data-severity');
  turnCuePathEl.setAttribute('d', '');
  turnCueLabelEl.textContent = '';
}

function updateTurnCue(car, nowMs = performance.now()) {
  const result = advanceTurnCue(turnCueState, routePaceNotes, car, nowMs);
  turnCueState = result.state;
  turnCueEl.style.display = result.view.visible ? 'block' : 'none';
  if (!result.view.visible) return;
  turnCueEl.dataset.turn = result.view.turn;
  turnCueEl.dataset.severity = result.view.severity;
  turnCuePathEl.setAttribute('d', result.view.path);
  turnCueLabelEl.textContent = result.view.label;
}

socket.on('connect', () => updateJoinState({ type: 'connected' }));

socket.on('lobby', (payload) => {
  const previousChoice = routeSelectEl.value;
  routeLobby = normalizeRouteLobby(payload);
  const fragment = document.createDocumentFragment();
  for (const option of routeLobby.options) {
    const element = document.createElement('option');
    element.value = option.id;
    element.textContent = `${option.start} → ${option.end} · ${option.lengthKm.toFixed(1)} km`;
    fragment.append(element);
  }
  routeSelectEl.replaceChildren(fragment);
  const preferred = !routeLobby.locked && routeLobby.options.some((option) => option.id === previousChoice)
    ? previousChoice
    : routeLobby.selectedRouteId;
  if (preferred) routeSelectEl.value = preferred;
  renderJoinState();
});

socket.on('connect_error', () => {
  updateJoinState({ type: 'error' });
});

socket.on('disconnect', () => {
  me = null;
  resetStreetBanner();
  resetTurnCue();
  updateEngine(null);
  updateJoinState({ type: 'error' });
});

socket.on('init', (d) => {
  me = d.you;
  updateJoinState({ type: 'init' });
  routePts = normalizeRoutePath(d.route);
  routeGuidePts = normalizeRoutePath(d.routePath);
  if (routeGuidePts.length < 2) routeGuidePts = routePts;
  totalCp = routePts.length;
  routeDirections = normalizeRouteDirections(d.routeDirections, totalCp);
  routePaceNotes = createRoutePaceNotes(routeGuidePts);
  resetTurnCue();
  routeInfoEl.textContent = d.start.name + ' → ' + d.end.name + ' · ' + totalCp + ' checkpoint';
  running = d.running;
  phase = d.phase || (d.running ? 'running' : 'countdown');
  round = d.round || 0;
  if (typeof d.routeId === 'string' && routeLobby.options.some((option) => option.id === d.routeId)) {
    routeSelectEl.value = d.routeId;
  }
  renderJoinState();
  renderStartSignal(d);
  buildRouteOverlay();
  buildRouteSigns();
});

socket.on('full', () => {
  updateJoinState({ type: 'full' });
});

socket.on('race_started', () => updateJoinState({ type: 'race_started' }));

socket.on('state', (s) => {
  running = s.running;
  phase = s.phase || (s.running ? 'running' : 'countdown');
  if (typeof s.round === 'number' && s.round !== round) {
    round = s.round;
    snapshots.clear();
    resetStreetBanner();
    resetTurnCue();
  }
  totalCp = s.totalCp;
  updateJoinState({ type: 'availability', phase: s.phase, hasSeat: s.cars.length < 4 });
  for (const c of s.cars) {
    const prev = snapshots.get(c.id);
    const impact = normalizeImpactSnapshot(c);
    const checkpointStats = normalizeCheckpointCoverage(c, s.totalCp);
    const impactEvent = localImpactEvent(prev, c, me);
    const checkpointEvent = localCheckpointEvent(prev, c, me);
    const impactChanged = Number.isSafeInteger(prev?.impactSeq) && Number.isSafeInteger(impact.impactSeq) &&
      impact.impactSeq > prev.impactSeq;
    if (impactEvent) playImpactSound(impactEvent.level);
    if (checkpointEvent) playRaceTone('checkpoint');
    const snap = {
      id: c.id, x: c.x, z: c.z, yaw: c.yaw,
      speed: c.speed, onRoad: c.onRoad, cp: c.cp, rank: c.rank,
      ...normalizeDrivetrainSnapshot(c),
      ...normalizeSurfaceSnapshot(c),
      ...impact,
      ...(checkpointStats || {}),
      finished: c.finished, name: c.name, color: c.color,
      streetName: typeof c.streetName === 'string' ? c.streetName : null,
      timeMs: c.timeMs, first: !prev || impactChanged
    };
    snapshots.set(c.id, snap);
    upsertCarMesh(c.id, c.color);
  }
  for (const id of [...snapshots.keys()]) {
    if (!s.cars.some((c) => c.id === id)) {
      snapshots.delete(id);
      const g = carMeshes.get(id);
      if (g) {
        disposeObject3D(g);
        carMeshes.delete(id);
      }
    }
  }
  updateStreetBanner(selectLocalStreetName(snapshots, me));
  updateHUD(s);
});

function setupMinimap() {
  if (!mapData) return;
  const bbox = mapData.bbox;
  const mapW = bbox.maxX - bbox.minX;
  const mapH = bbox.maxZ - bbox.minZ;
  const mmW = mmEl.width;
  const mmH = mmEl.height;
  mmScale = Math.min((mmW - 20) / mapW, (mmH - 20) / mapH);
  mmOx = (mmW - mapW * mmScale) / 2 - bbox.minX * mmScale;
  mmOy = (mmH - mapH * mmScale) / 2 - bbox.minZ * mmScale;
}

function initThree() {
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  app.appendChild(renderer.domElement);
  scene = new THREE.Scene();
  const initialView = worldViewForBounds(null);
  scene.background = new THREE.Color(WORLD_HORIZON_COLOR);
  scene.fog = new THREE.Fog(WORLD_HORIZON_COLOR, initialView.fogNear, initialView.fogFar);
  camera = new THREE.PerspectiveCamera(
    62,
    window.innerWidth / window.innerHeight,
    0.1,
    initialView.cameraFar
  );
  camera.position.set(0, 8, -20);
  scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x2a3a2a, 1.0));
  const dl = new THREE.DirectionalLight(0xffffff, 1.4);
  dl.position.set(200, 400, -100);
  scene.add(dl);
  updateQaMetrics = installQaMetrics(document, renderer, scene);
  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });
}

function makeAsphaltTexture() {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 128;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 128, 128);
  for (let i = 0; i < 1100; i++) {
    const v = 190 + Math.floor(Math.random() * 65);
    ctx.fillStyle = 'rgba(' + v + ',' + v + ',' + v + ',' + (0.25 + Math.random() * 0.3) + ')';
    const s = 1 + Math.random() * 2;
    ctx.fillRect(Math.random() * 128, Math.random() * 128, s, s);
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  return t;
}

function makeLabel(pl) {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  ctx.font = 'bold 58px Segoe UI, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const w = Math.min(500, ctx.measureText(pl.name).width + 40);
  const x0 = 256 - w / 2;
  ctx.fillStyle = 'rgba(10,14,20,.6)';
  ctx.fillRect(x0, 24, w, 80);
  ctx.fillStyle = '#dfe7ee';
  ctx.fillText(pl.name, 256, 66);
  const tex = new THREE.CanvasTexture(canvas);
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false }));
  sp.position.set(pl.x, terrainHeight(pl.x, pl.z) + 14, pl.z);
  sp.scale.set(46, 11.5, 1);
  return sp;
}
async function loadMap() {
  const res = await fetch('/data/roads.json');
  const { data: raw } = await readJsonResponse(res, 'roads.json');
  const map = parseMapData(raw);
  mapData = map;
  const view = worldViewForBounds(map.bbox);
  scene.fog.near = view.fogNear;
  scene.fog.far = view.fogFar;
  camera.far = view.cameraFar;
  camera.updateProjectionMatrix();
  console.log('[world] horizon fog ' + view.fogNear + '-' + view.fogFar +
    ' m, camera ' + view.cameraFar + ' m');
  const cx = (map.bbox.minX + map.bbox.maxX) / 2;
  const cz = (map.bbox.minZ + map.bbox.maxZ) / 2;
  const w = map.bbox.maxX - map.bbox.minX;
  const h = map.bbox.maxZ - map.bbox.minZ;
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(w * 2.2, h * 2.2),
    new THREE.MeshLambertMaterial({ color: 0x0d1511 })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(cx, terrainBackdropHeight(terrainData), cz);
  scene.add(ground);
  const asphalt = makeAsphaltTexture();
  const roadBatches = createRoadGeometryBatches(map.roads, {
    heightAt: terrainHeight,
    verticalScale: RENDER_ELEVATION_SCALE
  });
  if (roadBatches.shoulderGeometry) {
    scene.add(new THREE.Mesh(roadBatches.shoulderGeometry, new THREE.MeshBasicMaterial({
      vertexColors: true,
      side: THREE.DoubleSide
    })));
  }
  if (roadBatches.roadGeometry) {
    scene.add(new THREE.Mesh(roadBatches.roadGeometry, new THREE.MeshBasicMaterial({
      map: asphalt,
      vertexColors: true,
      side: THREE.DoubleSide
    })));
  }
  if (roadBatches.dashGeometry) {
    scene.add(new THREE.Mesh(roadBatches.dashGeometry, new THREE.MeshBasicMaterial({
      vertexColors: true,
      side: THREE.DoubleSide
    })));
  }
  const roadBatchCount = Number(!!roadBatches.shoulderGeometry) +
    Number(!!roadBatches.roadGeometry) + Number(!!roadBatches.dashGeometry);
  console.log('[world] road batches ' + roadBatchCount + ' from ' + roadBatches.roadSources +
    ' roads (' + roadBatches.shoulderSources + ' shoulders, ' +
    roadBatches.dashedSources + ' dashed, ' + roadBatches.junctionSources + ' junctions)');
  for (const pl of map.places) scene.add(makeLabel(pl));
  cpRing = new THREE.Mesh(new THREE.TorusGeometry(4, 0.4, 8, 40), new THREE.MeshBasicMaterial({ color: 0xffa53b }));
  cpRing.rotation.x = Math.PI / 2;
  cpRing.position.y = 0.5;
  cpRing.visible = false;
  scene.add(cpRing);
  setupMinimap();
  if (routePts.length) buildRouteOverlay();
  if (routeDirections.length) buildRouteSigns();
}

// ===== world (terrain + buildings) =====
function terrainHeight(x, z) {
  return terrainMeshHeightAt(terrainData, x, z);
}
function buildTerrain(td) {
  const cols = td.cols, rows = td.rows, cell = td.cell;
  const pos = createTerrainPositions(td);
  const idx = [];
  for (let j = 0; j < rows - 1; j++) {
    for (let i = 0; i < cols - 1; i++) {
      const a = j * cols + i;
      idx.push(a, a + cols, a + 1, a + 1, a + cols, a + cols + 1);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setIndex(idx);
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const col = new Float32Array(cols * rows * 3);
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const k = (j * cols + i) * 3;
      const hgt = td.heights[j * cols + i];
      const rgt = i < cols - 1 ? td.heights[j * cols + i + 1] : i > 0 ? td.heights[j * cols + i - 1] : hgt;
      const dwn = j < rows - 1 ? td.heights[(j + 1) * cols + i] : j > 0 ? td.heights[(j - 1) * cols + i] : hgt;
      const slope = Math.hypot(rgt - hgt, dwn - hgt) / cell;
      const t = Math.min(1, Math.max(0, (hgt + 6) / 240));
      let r, g, bl;
      if (t < 0.45) {
        const u = t / 0.45;
        r = 0.09 + 0.1 * u; g = 0.15 + 0.05 * u; bl = 0.08 + 0.03 * u;
      } else {
        const u = (t - 0.45) / 0.55;
        r = 0.19 + 0.14 * u; g = 0.2 + 0.14 * u; bl = 0.11 + 0.24 * u;
      }
      const rock = Math.min(1, Math.max(0, (slope - 0.4) / 0.3)) * 0.6;
      r += (0.33 - r) * rock; g += (0.34 - g) * rock; bl += (0.35 - bl) * rock;
      col[k] = r; col[k + 1] = g; col[k + 2] = bl;
    }
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.computeVertexNormals();
  scene.add(new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true })));
  console.log('[world] terrain ' + cols + 'x' + rows);
}
function buildBuildings(data) {
  const geos = [];
  const projectedFootprints = projectBuildingFootprints(data, mapData.proj, mapData.bbox);
  const buildingFit = fitBuildingFootprintsToRoads(projectedFootprints, new RoadIndex(mapData.roads));
  const footprints = buildingFit.footprints;
  for (const footprint of footprints) {
    const placement = buildingPlacement(footprint, terrainHeight);
    if (!placement) continue;
    const h = placement.height;
    const c = buildingGray(footprint);
    const shape = new THREE.Shape();
    shape.moveTo(footprint.outer[0][0], -footprint.outer[0][1]);
    for (let i = 1; i < footprint.outer.length; i++) {
      shape.lineTo(footprint.outer[i][0], -footprint.outer[i][1]);
    }
    for (const inner of footprint.holes) {
      const hole = new THREE.Path();
      hole.moveTo(inner[0][0], -inner[0][1]);
      for (let i = 1; i < inner.length; i++) hole.lineTo(inner[i][0], -inner[i][1]);
      shape.holes.push(hole);
    }
    const geo = new THREE.ExtrudeGeometry(shape, { depth: h, bevelEnabled: false });
    geo.rotateX(-Math.PI / 2);
    geo.translate(0, placement.baseY, 0);
    const pos = geo.getAttribute('position');
    const cols = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      cols[i * 3] = c.r;
      cols[i * 3 + 1] = c.g;
      cols[i * 3 + 2] = c.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(cols, 3));
    geos.push(geo);
  }
  const merged = mergeWorldGeometries(geos, mergeGeometries);
  if (!merged) {
    console.info('[world] edifici: nessuna geometria valida');
    return;
  }
  scene.add(new THREE.Mesh(merged, new THREE.MeshLambertMaterial({ vertexColors: true })));
  const windowGeometry = createBuildingWindowGeometry(footprints, { heightAt: terrainHeight });
  if (windowGeometry) {
    scene.add(new THREE.Mesh(windowGeometry, new THREE.MeshBasicMaterial({
      vertexColors: true,
      side: THREE.DoubleSide
    })));
  }
  console.log('[world] buildings ' + footprints.length + ' (' + buildingFit.adjustedCount +
    ' ridotti, ' + buildingFit.removedCount + ' rimossi dalla carreggiata, ' +
    (windowGeometry?.userData.panelCount || 0) + ' finestre)');
}

async function loadTerrain() {
  terrainData = null;
  try {
    const r = await fetch('/data/elevation.json');
    const elevation = await readJsonResponse(r, 'elevation.json', { optional404: true });
    if (elevation.status === 'absent') {
      console.info('[world] elevation assente: fallback piano attivo');
    } else {
      const validatedTerrain = validateTerrainData(elevation.data);
      buildTerrain(validatedTerrain);
      terrainData = validatedTerrain;
    }
  } catch (e) {
    terrainData = null;
    console.error('[world] errore elevation; fallback piano attivo:', e.message);
  }
}

async function loadBuildings() {
  try {
    const r = await fetch('/data/buildings.json');
    const { data } = await readJsonResponse(r, 'buildings.json');
    buildBuildings(data);
  } catch (e) {
    console.warn('[world] edifici non disponibili:', e.message);
  }
}

async function loadWorld() {
  await loadTerrain();
  await loadMap();
  await loadBuildings();
}

function buildRouteOverlay() {
  if (!mapData) return;
  const sourcePoints = routeGuidePts.length >= 2 ? routeGuidePts : routePts;
  const nextKey = routeOverlayKey(sourcePoints);
  if (routePath && routePathKey === nextKey) return;
  for (const object of [routePath, routeDashes, startRing, finishRing]) {
    if (object) disposeObject3D(object);
  }
  routePath = null;
  routeDashes = null;
  startRing = null;
  finishRing = null;
  routePathKey = nextKey;
  const geometries = createRouteOverlayGeometries(sourcePoints, { heightAt: terrainHeight });
  if (!geometries) return;
  const { points: pts, ribbonGeometry, dashGeometry } = geometries;
  routePath = new THREE.Mesh(ribbonGeometry, new THREE.MeshBasicMaterial({
    color: 0xffa11a,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.92,
    depthWrite: false
  }));
  routePath.renderOrder = 3;
  scene.add(routePath);
  routeDashes = new THREE.LineSegments(dashGeometry, new THREE.LineBasicMaterial({ color: 0xffd37a }));
  routeDashes.renderOrder = 4;
  scene.add(routeDashes);
  const mkRing = (r, col) => new THREE.Mesh(new THREE.RingGeometry(r - 0.7, r, 40), new THREE.MeshBasicMaterial({ color: col, side: THREE.DoubleSide }));
  startRing = mkRing(4, 0x42ff6e);
  startRing.rotation.x = -Math.PI / 2;
  startRing.position.set(pts[0].x, terrainHeight(pts[0].x, pts[0].z) + 0.12, pts[0].z);
  scene.add(startRing);
  finishRing = mkRing(5, 0xff5555);
  finishRing.rotation.x = -Math.PI / 2;
  finishRing.position.set(
    pts[pts.length - 1].x,
    terrainHeight(pts[pts.length - 1].x, pts[pts.length - 1].z) + 0.12,
    pts[pts.length - 1].z
  );
  finishRing.visible = false;
  scene.add(finishRing);
}

function buildRouteSigns(force = false) {
  if (!mapData) return;
  const key = JSON.stringify(routeDirections);
  if (!force && routeSigns && routeSignsKey === key) return;
  if (routeSigns) {
    disposeObject3D(routeSigns);
    routeSigns = null;
  }
  routeSignsKey = key;
  if (!routeDirections.length) return;
  routeSigns = createRouteSignGroup(THREE, routeDirections, terrainHeight);
  scene.add(routeSigns);
  console.log('[route] cartelli ' + routeSigns.children.length);
}

function upsertCarMesh(id, color) {
  let g = carMeshes.get(id);
  if (!g) {
    g = createCarModel(color);
    scene.add(g);
    carMeshes.set(id, g);
  }
  g.visible = true;
}
window.addEventListener('keydown', (e) => {
  keys.add(e.code);
  if (shouldPreventDrivingKey(e.code)) e.preventDefault();
});
window.addEventListener('keyup', (e) => keys.delete(e.code));

function readInput() {
  return readDrivingInput(keys);
}

function updateHUD(s) {
  const meCar = s.cars.find((c) => c.id === me);
  if (meCar) {
    speedEl.innerHTML = Math.round(Math.abs(meCar.speed) * 3.6) + ' <small>km/h</small>';
    warnEl.style.display = normalizeSurfaceSnapshot(meCar).surface === 'grass' ? 'block' : 'none';
    handbrakeEl.style.display = meCar.handbrake ? 'block' : 'none';
    const localCoverage = normalizeCheckpointCoverage(meCar, totalCp);
    const localCoverageLabel = checkpointCoverageLabel(localCoverage);
    cpEl.textContent = meCar.finished
      ? 'Arrivato!' + (localCoverageLabel ? ' · ' + localCoverageLabel : '')
      : 'Checkpoint ' + Math.min(meCar.cp + 1, totalCp) + ' / ' + totalCp;
    if (meCar.finished && meCar.timeMs > 0 && (pbMs === null || meCar.timeMs < pbMs)) {
      pbMs = meCar.timeMs;
      localStorage.setItem('rally-pb', String(pbMs));
    }
    if (phase === 'results') {
      const finalTime = meCar.finished ? fmtTime(meCar.timeMs) : '';
      timerEl.textContent = 'RISULTATI' + (finalTime ? ' · ' + finalTime : '') + ' · ' + Math.ceil(s.resultsRemaining || 0);
    } else if (running) {
      timerEl.textContent = fmtTime(meCar.timeMs);
      if (meCar.finished) {
        timerEl.textContent = fmtTime(meCar.timeMs) + '  FINITO!';
      }
    } else {
      timerEl.textContent = '';
    }
    if (pbMs !== null) bestEl.textContent = 'PB: ' + fmtTime(pbMs);
  }
  const rows = s.cars.slice().sort((a, b) => a.rank - b.rank);
  const fragment = document.createDocumentFragment();
  for (const c of rows) {
    const coverageLabel = checkpointCoverageLabel(normalizeCheckpointCoverage(c, totalCp));
    const finalTime = fmtTime(c.timeMs) || 'FIN';
    const val = c.finished
      ? finalTime + (coverageLabel ? ' · ' + coverageLabel : '')
      : (c.cp + 1) + '/' + totalCp;
    const row = document.createElement('div');
    row.className = c.id === me ? 'row me' : 'row';
    const player = document.createElement('span');
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.backgroundColor = c.color;
    player.append(dot, document.createTextNode(c.name));
    const progress = document.createElement('span');
    progress.textContent = val;
    row.append(player, progress);
    fragment.append(row);
  }
  standingsEl.replaceChildren(fragment);
  renderStartSignal(s);
}

function renderStartSignal(payload) {
  const view = startSignalView(payload, phase);
  const audioEvent = startSignalAudioEvent(renderedStartSignal, view);
  renderedStartSignal = view;
  if (audioEvent) playRaceTone(audioEvent);
  startSignalEl.style.display = view.visible ? 'flex' : 'none';
  startLightsEl.style.display = view.green ? 'none' : 'flex';
  for (let i = 0; i < startLightEls.length; i++) {
    startLightEls[i].classList.toggle('red', !view.green && i < view.lights);
  }
  startGoEl.style.display = view.green ? 'block' : 'none';
  startSignalEl.setAttribute('aria-label', view.green
    ? 'Start'
    : `Semaforo di partenza: ${view.lights} luci rosse su 5`);
}
const clock = new THREE.Clock();

function updateCamera(dt) {
  if (!me) return;
  const g = carMeshes.get(me);
  if (!g) return;
  const ry = -g.rotation.y;
  const fx = Math.sin(ry);
  const fz = -Math.cos(ry);
  const tx = g.position.x - fx * 11;
  const tz = g.position.z - fz * 11;
  const t = 1 - Math.exp(-6 * dt);
  camera.position.x += (tx - camera.position.x) * t;
  camera.position.y += (g.position.y + 6 - camera.position.y) * t;
  camera.position.z += (tz - camera.position.z) * t;
  camera.position.y = clampHeightAboveTerrain(
    terrainData,
    camera.position.x,
    camera.position.z,
    camera.position.y,
    CAMERA_SURFACE_CLEARANCE
  );
  camera.lookAt(g.position.x, g.position.y + 1, g.position.z);
}

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.1);
  socket.emit('input', readInput());
  const k = 1 - Math.exp(-14 * dt);
  for (const c of snapshots.values()) {
    const g = carMeshes.get(c.id);
    if (!g) continue;
    const firstFrame = c.first;
    const groundY = surfaceHeightWithClearance(
      terrainData,
      c.x,
      c.z,
      CAR_SURFACE_CLEARANCE
    );
    const shake = surfaceShake(c.surface, c.speed, performance.now() / 1000, c.id);
    const targetY = groundY + shake.y;
    if (firstFrame) {
      g.position.set(c.x, targetY, c.z);
      g.rotation.y = -c.yaw;
      c.first = false;
    } else {
      g.position.x += (c.x - g.position.x) * k;
      g.position.y += (targetY - g.position.y) * k;
      g.position.z += (c.z - g.position.z) * k;
      g.rotation.y = lerpAngle(g.rotation.y, -c.yaw, k);
    }
    const targetAttitude = vehicleTerrainAttitude(terrainHeight, {
      x: g.position.x,
      z: g.position.z,
      yaw: -g.rotation.y
    });
    const terrainAttitude = firstFrame
      ? targetAttitude
      : smoothVehicleAttitude(g.userData.terrainAttitude, targetAttitude, dt);
    g.userData.terrainAttitude = terrainAttitude;
    const renderedAttitude = composeVehicleAttitude(terrainAttitude, shake);
    g.rotation.x = renderedAttitude.pitch;
    g.rotation.z = renderedAttitude.roll;
  }
  const meSnap = me ? snapshots.get(me) : null;
  if (performance.now() >= streetBannerState.visibleUntilMs) streetNameEl.style.display = 'none';
  updateTurnCue(meSnap);
  updateEngine(meSnap?.finished ? null : selectLocalSnapshot(snapshots, me));
  updateRouteSignVisibility(routeSigns, meSnap?.cp, !meSnap || meSnap.finished);
  if (cpRing) {
    if (meSnap && !meSnap.finished && routePts.length) {
      const idx = Math.min(meSnap.cp + 1, routePts.length - 1);
      const c = routePts[idx];
      const targets = routeTargetVisibility(meSnap.cp, routePts.length, meSnap.finished);
      cpRing.position.set(c[0], terrainHeight(c[0], c[1]) + 0.5, c[1]);
      cpRing.visible = targets.checkpoint;
      if (finishRing) finishRing.visible = targets.finish;
      cpRing.rotation.z += dt * 2;
    } else {
      cpRing.visible = false;
      if (finishRing) finishRing.visible = false;
    }
  }
  drawMinimap();
  updateCamera(dt);
  renderer.render(scene, camera);
  updateQaMetrics();
}

function drawMinimap() {
  if (!mapData) return;
  const W = mmEl.width;
  const H = mmEl.height;
  mmCtx.clearRect(0, 0, W, H);
  mmCtx.strokeStyle = '#4a5058';
  mmCtx.lineWidth = 1;
  for (const road of mapData.roads) {
    if (road.isTrack) continue;
    mmCtx.beginPath();
    for (let i = 0; i < road.points.length; i++) {
      const x = mmX(road.points[i][0]);
      const z = mmZ(road.points[i][1]);
      if (i === 0) mmCtx.moveTo(x, z);
      else mmCtx.lineTo(x, z);
    }
    mmCtx.stroke();
  }
  const minimapRoute = routeGuidePts.length >= 2 ? routeGuidePts : routePts;
  if (minimapRoute.length) {
    mmCtx.strokeStyle = '#ffa53b';
    mmCtx.lineWidth = 2.5;
    mmCtx.beginPath();
    for (let i = 0; i < minimapRoute.length; i++) {
      const x = mmX(minimapRoute[i][0]);
      const z = mmZ(minimapRoute[i][1]);
      if (i === 0) mmCtx.moveTo(x, z);
      else mmCtx.lineTo(x, z);
    }
    mmCtx.stroke();
  }
  for (const p of mapData.places) {
    mmCtx.fillStyle = '#6e7681';
    mmCtx.beginPath();
    mmCtx.arc(mmX(p.x), mmZ(p.z), 1.5, 0, Math.PI * 2);
    mmCtx.fill();
  }
  for (const c of snapshots.values()) {
    mmCtx.fillStyle = c.color;
    mmCtx.beginPath();
    mmCtx.arc(mmX(c.x), mmZ(c.z), c.id === me ? 4 : 3, 0, Math.PI * 2);
    mmCtx.fill();
    if (c.id === me) {
      mmCtx.strokeStyle = '#ffffff';
      mmCtx.lineWidth = 1.5;
      mmCtx.stroke();
    }
  }
}

joinBtn.addEventListener('click', () => {
  initAudio();
  if (updateJoinState({ type: 'click' })) {
    const name = playerNameEl.value.trim() || null;
    const color = playerColorEl.value;
    socket.emit('join', { name, color, routeId: routeSelectEl.value });
  }
});
routeSelectEl.addEventListener('change', () => {
  if (lobbyView(routeLobby, me).canChangeRoute) {
    socket.emit('lobby:route', { routeId: routeSelectEl.value });
  }
});
readyBtn.addEventListener('click', () => {
  const lobby = lobbyView(routeLobby, me);
  if (lobby.visible) socket.emit('lobby:ready', { ready: !lobby.ready });
});
startBtn.addEventListener('click', () => {
  if (lobbyView(routeLobby, me).canStart) socket.emit('lobby:start');
});
renderJoinState();
initThree();
loadWorld()
  .catch((e) => {
    joinSub.textContent = 'Errore caricamento mappa: ' + e.message;
  });
animate();
