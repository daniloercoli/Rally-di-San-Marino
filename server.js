import express from 'express';
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Server } from 'socket.io';
import { parseMapData } from './shared/mapdata.js';
import { RoadIndex, clamp } from './shared/geometry.js';
import {
  CHECKPOINT_CAPTURE_RADIUS_M,
  RoadGraph,
  checkpointCoverage,
  createRouteCatalog,
  crossedCheckpointIndices,
  pathStartYaw
} from './shared/route.js';
import {
  BuildingIndex,
  fitBuildingFootprintsToRoads,
  projectBuildingFootprints
} from './shared/buildings.js';
import { findBuildingGlance, findRoadRecovery, isSafeRoadPose } from './shared/recovery.js';
import {
  collide,
  createCar,
  directionLockForTick,
  forwardX,
  forwardZ,
  simulationSubsteps,
  stepCar,
  syncDrivetrain
} from './shared/physics.js';
import {
  RACE_PHASE,
  START_DELAY_MAX_MS,
  START_DELAY_MIN_MS,
  advanceRace,
  createRaceState,
  leaveRace,
  publicRaceState,
  raceElapsedMs,
  randomStartDelayMs,
  rankRaceCars,
  startRace
} from './shared/race.js';
import {
  DEFAULT_WEATHER_ID,
  WEATHER_PRESETS,
  normalizeWeatherId,
  publicWeatherOptions
} from './shared/weather.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const COLORS = ['#e33b3b', '#3b6fe2', '#e2c23b', '#3be26f'];
const SEAT_OFFSETS = [-2.5, -1, 1, 2.5];
const TICK_MS = 50;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const ALLOWED_DATA_FILES = new Set(['roads.json', 'buildings.json', 'elevation.json']);

function normalizePayload(data) {
  return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
}

export function normalizeInputValue(value) {
  return typeof value === 'number' && Number.isFinite(value) ? clamp(value, -1, 1) : 0;
}

export function normalizeHandbrakeInput(value) {
  return value === true;
}

export function normalizePlayerColor(value, fallback) {
  return typeof value === 'string' && COLOR_RE.test(value) ? value.toLowerCase() : fallback;
}

export function validateProductionPaths(staticRoot, dataRoot) {
  const missing = [];
  if (!existsSync(join(staticRoot, 'index.html'))) missing.push('dist/index.html');
  if (!existsSync(join(dataRoot, 'roads.json'))) missing.push('roads.json');
  if (!existsSync(join(dataRoot, 'buildings.json'))) missing.push('buildings.json');
  if (missing.length > 0) {
    throw new Error('Missing required production assets: ' + missing.join(', '));
  }
}

export function startServer({
  startDelayMs,
  countdown,
  random = Math.random,
  checkpoints,
  staticRoot,
  dataRoot,
  devMode = false
} = {}) {
  const resolvedStaticRoot = resolve(staticRoot || join(__dirname, 'dist'));
  const resolvedDataRoot = resolve(dataRoot || join(__dirname, 'public', 'data'));

  if (startDelayMs !== undefined && countdown !== undefined) {
    throw new Error('Use either startDelayMs or countdown, not both');
  }
  let configuredStartDelayMs;
  if (startDelayMs !== undefined) configuredStartDelayMs = startDelayMs;
  else if (countdown !== undefined) {
    configuredStartDelayMs = typeof countdown === 'number' ? countdown * 1000 : Number.NaN;
  }
  if (configuredStartDelayMs !== undefined && (!Number.isFinite(configuredStartDelayMs) ||
    configuredStartDelayMs < START_DELAY_MIN_MS || configuredStartDelayMs > START_DELAY_MAX_MS)) {
    throw new Error(`startDelayMs must be between ${START_DELAY_MIN_MS} and ${START_DELAY_MAX_MS}`);
  }
  const fixedStartDelayMs = configuredStartDelayMs === undefined ? null : Math.round(configuredStartDelayMs);
  const nextStartDelayMs = () => fixedStartDelayMs ?? randomStartDelayMs(random);

  if (!devMode) {
    validateProductionPaths(resolvedStaticRoot, resolvedDataRoot);
  }

  const raw = JSON.parse(readFileSync(join(resolvedDataRoot, 'roads.json'), 'utf8'));
  const map = parseMapData(raw);
  const index = new RoadIndex(map.roads);
  const buildingsPath = join(resolvedDataRoot, 'buildings.json');
  const rawBuildings = existsSync(buildingsPath)
    ? JSON.parse(readFileSync(buildingsPath, 'utf8'))
    : { elements: [] };
  const projectedBuildingFootprints = projectBuildingFootprints(rawBuildings, map.proj, map.bbox);
  const buildingFit = fitBuildingFootprintsToRoads(projectedBuildingFootprints, index);
  const buildingFootprints = buildingFit.footprints;
  const buildingIndex = new BuildingIndex(buildingFootprints);
  let routeCatalog;
  if (checkpoints && checkpoints.length > 1) {
    routeCatalog = [{
      id: 'custom',
      lengthM: checkpoints.slice(1).reduce((total, point, index) => total + Math.hypot(
        point[0] - checkpoints[index][0],
        point[1] - checkpoints[index][1]
      ), 0),
      checkpoints,
      path: checkpoints,
      directions: [],
      start: { name: 'Start', x: checkpoints[0][0], z: checkpoints[0][1] },
      end: { name: 'End', x: checkpoints[checkpoints.length - 1][0], z: checkpoints[checkpoints.length - 1][1] }
    }];
  } else {
    routeCatalog = createRouteCatalog(new RoadGraph(map.roads), map, {
      directionOptions: {
        isPositionBlocked: (x, z) => buildingIndex.intersectsCircle(x, z, 1.2)
      }
    });
  }
  let route = routeCatalog[0];
  let cps;
  let yaw0;
  let rx;
  let rz;
  let routeCheckpointSpacing;
  let routeSafePose;

  function applyRoute(nextRoute) {
    route = nextRoute;
    cps = route.checkpoints;
    yaw0 = pathStartYaw(route.path, cps);
    routeCheckpointSpacing = route.lengthM / (cps.length - 1);
    const fx = forwardX(yaw0);
    const fz = forwardZ(yaw0);
    rx = fz;
    rz = -fx;
    routeSafePose = findRoadRecovery(index, buildingIndex, {
      x: cps[0][0],
      z: cps[0][1],
      yaw: yaw0
    }, null);
  }
  applyRoute(route);

  const cars = new Map();
  const inputs = new Map();
  const readyById = new Map();
  const joinOrderById = new Map();
  const seatOwner = [null, null, null, null];
  let nextJoinOrder = 1;
  let hostPlayerId = null;
  let weatherId = DEFAULT_WEATHER_ID;
  let raceState = createRaceState((fixedStartDelayMs ?? START_DELAY_MAX_MS) / 1000, Date.now());
  let sessionBestMs = null;

  function publicRouteOptions() {
    return routeCatalog.map((candidate) => ({
      id: candidate.id,
      label: candidate.label || '',
      start: candidate.start.name,
      end: candidate.end.name,
      lengthKm: +(candidate.lengthM / 1000).toFixed(1),
      checkpoints: candidate.checkpoints.length
    }));
  }

  function buildLobby() {
    return {
      routeOptions: publicRouteOptions(),
      selectedRouteId: route.id,
      weatherOptions: publicWeatherOptions(),
      selectedWeatherId: weatherId,
      locked: raceState.phase !== RACE_PHASE.WAITING,
      phase: raceState.phase,
      capacity: seatOwner.length,
      hostId: hostPlayerId,
      players: [...cars.values()]
        .sort((a, b) => a.id - b.id)
        .map((car) => ({
          id: car.id,
          name: car.name,
          color: car.color,
          ready: readyById.get(car.id) === true
        }))
    };
  }

  function selectHostRoute(routeId) {
    const selected = typeof routeId === 'string'
      ? routeCatalog.find((candidate) => candidate.id === routeId)
      : null;
    const nextRoute = selected || routeCatalog[0];
    if (nextRoute.id !== route.id) sessionBestMs = null;
    applyRoute(nextRoute);
  }

  function selectHostWeather(value) {
    weatherId = normalizeWeatherId(value);
  }

  const app = express();
  app.use('/data', (req, res, next) => {
    const unsafe = req.path.includes('..') || req.path.includes('//');
    if (unsafe) {
      res.status(404).send('Not Found');
      return;
    }
    const fileName = req.path.split('/').filter(Boolean).pop();
    if (!fileName || !ALLOWED_DATA_FILES.has(fileName)) {
      res.status(404).send('Not Found');
      return;
    }
    const filePath = join(resolvedDataRoot, fileName);
    if (!existsSync(filePath)) {
      res.status(404).send('Not Found');
      return;
    }
    next();
  }, express.static(resolvedDataRoot));
  if (!devMode) app.use(express.static(resolvedStaticRoot));
  const server = http.createServer(app);
  const io = new Server(server);

  function spawnCar(id, name, color) {
    const seat = id - 1;
    const off = SEAT_OFFSETS[seat];
    const car = createCar(id, cps[0][0] + rx * off, cps[0][1] + rz * off, yaw0, color, name);
    car.cp = 0;
    car.checkpointHits = new Set([0]);
    car.rank = 0;
    const spawnRecovery = findRoadRecovery(index, buildingIndex, car, null) || routeSafePose;
    if (spawnRecovery) {
      car.x = spawnRecovery.x;
      car.z = spawnRecovery.z;
      car.yaw = spawnRecovery.yaw;
    }
    const road = index.query(car.x, car.z);
    car.onRoad = road.onRoad;
    car.clearance = road.clearance;
    car.surface = road.surface;
    car.streetName = road.streetName;
    car.lastSafeRoad = { x: car.x, z: car.z, yaw: car.yaw };
    return car;
  }

  function resetRoundCars() {
    for (const [id, car] of cars) {
      cars.set(id, spawnCar(id, car.name, car.color));
      inputs.set(id, { u: 0, a: 0, h: false });
    }
  }

  function resetReadyPlayers() {
    for (const id of cars.keys()) readyById.set(id, false);
  }

  function allPlayersReady() {
    return cars.size > 0 && [...cars.keys()].every((id) => readyById.get(id) === true);
  }

  function transferHost() {
    hostPlayerId = [...cars.keys()].sort((a, b) =>
      (joinOrderById.get(a) ?? Infinity) - (joinOrderById.get(b) ?? Infinity))[0] ?? null;
  }

  function allCarsFinished() {
    return cars.size > 0 && [...cars.values()].every((car) => car.finished);
  }

  function advanceServerRace(nowMs) {
    const previousPhase = raceState.phase;
    const previousRound = raceState.round;
    raceState = advanceRace(raceState, cars.size, nowMs, allCarsFinished());
    if (raceState.round !== previousRound) resetRoundCars();
    const lobbyReopened = previousPhase !== RACE_PHASE.WAITING && raceState.phase === RACE_PHASE.WAITING;
    if (lobbyReopened) resetReadyPlayers();
    return lobbyReopened;
  }

  function publicCars(nowMs, racePublic) {
    return [...cars.values()].map((c) => {
      const coverage = checkpointCoverage(c.checkpointHits, cps.length);
      return {
        id: c.id,
        name: c.name,
        color: c.color,
        x: +c.x.toFixed(2),
        z: +c.z.toFixed(2),
        yaw: +c.yaw.toFixed(3),
        speed: +c.speed.toFixed(2),
        gear: c.gear,
        rpm: Math.round(c.rpm),
        brakeLevel: +c.brakeLevel.toFixed(2),
        handbrake: c.handbrake === true,
        impactSeq: c.impactSeq,
        impactLevel: +c.impactLevel.toFixed(2),
        onRoad: c.onRoad,
        surface: c.surface,
        streetName: c.streetName || null,
        cp: c.cp,
        ...coverage,
        rank: c.rank,
        finished: !!c.finished,
        timeMs: c.finished ? c.finishMs : racePublic.running ? raceElapsedMs(raceState, nowMs) : 0
      };
    });
  }

  function buildState(nowMs) {
    const racePublic = publicRaceState(raceState, nowMs);
    return {
      t: nowMs,
      phase: racePublic.phase,
      running: racePublic.running,
      countdown: +racePublic.countdown.toFixed(2),
      resultsRemaining: +racePublic.resultsRemaining.toFixed(2),
      startLights: racePublic.startLights,
      startSignal: racePublic.startSignal,
      round: racePublic.round,
      totalCp: cps.length,
      bestMs: sessionBestMs,
      weatherId,
      cars: publicCars(nowMs, racePublic)
    };
  }

  function buildInit(id, car, nowMs) {
    const racePublic = publicRaceState(raceState, nowMs);
    return {
      you: id,
      name: car.name,
      color: car.color,
      route: cps.flat(),
      routePath: route.path.flat(),
      routeDirections: route.directions,
      routeId: route.id,
      weatherId,
      host: id === hostPlayerId,
      start: route.start,
      end: route.end,
      phase: racePublic.phase,
      running: racePublic.running,
      countdown: racePublic.countdown,
      resultsRemaining: racePublic.resultsRemaining,
      startLights: racePublic.startLights,
      startSignal: racePublic.startSignal,
      round: racePublic.round
    };
  }

  io.on('connection', (socket) => {
    socket.emit('lobby', buildLobby());
    socket.on('join', (rawData) => {
      const nowMs = Date.now();
      advanceServerRace(nowMs);
      const currentId = socket.data.playerId;
      const currentCar = cars.get(currentId);
      if (currentCar) {
        socket.emit('init', buildInit(currentId, currentCar, nowMs));
        return;
      }
      if (raceState.phase !== RACE_PHASE.WAITING) {
        socket.emit('race_started', { phase: raceState.phase });
        return;
      }

      const seat = seatOwner.indexOf(null);
      if (seat === -1) {
        socket.emit('full');
        return;
      }
      const data = normalizePayload(rawData);
      if (cars.size === 0) {
        selectHostRoute(data.routeId);
        selectHostWeather(data.weatherId);
      }
      seatOwner[seat] = socket.id;
      const id = seat + 1;
      const name = (typeof data.name === 'string' && data.name.trim()) ? data.name.trim().slice(0, 12) : 'P' + id;
      const color = normalizePlayerColor(data.color, COLORS[seat]);
      const car = spawnCar(id, name, color);
      cars.set(id, car);
      inputs.set(id, { u: 0, a: 0, h: false });
      readyById.set(id, false);
      joinOrderById.set(id, nextJoinOrder++);
      if (hostPlayerId === null) hostPlayerId = id;
      resetReadyPlayers();
      socket.data.playerId = id;
      socket.emit('init', buildInit(id, car, nowMs));
      io.emit('lobby', buildLobby());
    });

    socket.on('lobby:ready', (rawData) => {
      const id = socket.data.playerId;
      if (!cars.has(id) || raceState.phase !== RACE_PHASE.WAITING) return;
      const data = normalizePayload(rawData);
      if (typeof data.ready !== 'boolean' || readyById.get(id) === data.ready) return;
      readyById.set(id, data.ready);
      io.emit('lobby', buildLobby());
    });

    socket.on('lobby:route', (rawData) => {
      const id = socket.data.playerId;
      if (id !== hostPlayerId || raceState.phase !== RACE_PHASE.WAITING) return;
      const data = normalizePayload(rawData);
      const selected = typeof data.routeId === 'string'
        ? routeCatalog.find((candidate) => candidate.id === data.routeId)
        : null;
      if (!selected || selected.id === route.id) return;
      selectHostRoute(selected.id);
      resetRoundCars();
      resetReadyPlayers();
      const nowMs = Date.now();
      for (let seat = 0; seat < seatOwner.length; seat++) {
        const owner = seatOwner[seat];
        const playerSocket = owner ? io.sockets.sockets.get(owner) : null;
        const car = cars.get(seat + 1);
        if (playerSocket && car) playerSocket.emit('init', buildInit(seat + 1, car, nowMs));
      }
      io.emit('lobby', buildLobby());
    });

    socket.on('lobby:weather', (rawData) => {
      const id = socket.data.playerId;
      if (id !== hostPlayerId || raceState.phase !== RACE_PHASE.WAITING) return;
      const data = normalizePayload(rawData);
      const selected = typeof data.weatherId === 'string'
        ? WEATHER_PRESETS.find((candidate) => candidate.id === data.weatherId)
        : null;
      if (!selected || selected.id === weatherId) return;
      weatherId = selected.id;
      resetReadyPlayers();
      io.emit('lobby', buildLobby());
    });

    socket.on('lobby:start', () => {
      const id = socket.data.playerId;
      if (id !== hostPlayerId || raceState.phase !== RACE_PHASE.WAITING || !allPlayersReady()) return;
      for (const playerId of inputs.keys()) inputs.set(playerId, { u: 0, a: 0, h: false });
      raceState = startRace(raceState, Date.now(), nextStartDelayMs());
      io.emit('lobby', buildLobby());
    });

    socket.on('input', (rawData) => {
      const id = socket.data.playerId;
      const inp = inputs.get(id);
      if (!inp) return;
      const car = cars.get(id);
      if (raceState.phase !== RACE_PHASE.RUNNING || car?.finished) {
        inp.u = 0;
        inp.a = 0;
        inp.h = false;
        return;
      }
      const data = normalizePayload(rawData);
      inp.u = normalizeInputValue(data.u);
      inp.a = normalizeInputValue(data.a);
      inp.h = normalizeHandbrakeInput(data.h);
    });

    socket.on('disconnect', () => {
      const id = socket.data.playerId;
      if (!Number.isInteger(id)) return;
      const seat = id - 1;
      if (seatOwner[seat] === socket.id) seatOwner[seat] = null;
      cars.delete(id);
      inputs.delete(id);
      readyById.delete(id);
      joinOrderById.delete(id);
      socket.data.playerId = null;
      if (hostPlayerId === id) transferHost();
      const nowMs = Date.now();
      raceState = leaveRace(raceState, cars.size, nowMs);
      advanceServerRace(nowMs);
      if (raceState.phase === RACE_PHASE.WAITING) resetReadyPlayers();
      if (cars.size === 0) {
        inputs.clear();
        readyById.clear();
        joinOrderById.clear();
        hostPlayerId = null;
      }
      io.emit('lobby', buildLobby());
    });
  });

  function carPose(car, includeSpeed = false) {
    const pose = { x: car.x, z: car.z, yaw: car.yaw };
    if (includeSpeed) pose.speed = car.speed;
    return pose;
  }

  function rememberSafeRoadPose(car) {
    if (isSafeRoadPose(index, buildingIndex, car)) {
      car.lastSafeRoad = carPose(car);
      return true;
    }
    return false;
  }

  function findBuildingHit(previousPose, car) {
    if (buildingFootprints.length === 0) return null;
    return buildingIndex.findObbCollision(car) ||
      buildingIndex.findSweptObbCollision(previousPose, car);
  }

  function restoreImpactedCar(car, recovery, checkpoint, checkpointHits) {
    car.x = recovery.x;
    car.z = recovery.z;
    car.yaw = recovery.yaw;
    car.speed = Number.isFinite(recovery.speed) ? recovery.speed : 0;
    car.brakeLevel = 0;
    car.handbrake = false;
    car.cp = checkpoint;
    car.checkpointHits = new Set(checkpointHits);
    const road = index.query(car.x, car.z);
    car.onRoad = road.onRoad;
    car.clearance = road.clearance;
    car.surface = road.surface;
    car.streetName = road.streetName;
    syncDrivetrain(car, 0);
  }

  function registerBuildingImpact(
    car,
    previousPose,
    checkpoint,
    checkpointHits,
    building,
    impactedCars,
    recoveries
  ) {
    if (impactedCars.has(car.id)) return;
    let recovery = findBuildingGlance(index, buildingIndex, building, previousPose, car);
    if (!recovery) {
      recovery = findRoadRecovery(
        index,
        buildingIndex,
        previousPose,
        car.lastSafeRoad || routeSafePose
      );
    }
    if (!recovery) {
      recovery = [previousPose, car.lastSafeRoad, routeSafePose]
        .find((pose) => isSafeRoadPose(index, buildingIndex, pose, 0));
    }
    if (!recovery) return;
    const impactSpeed = Math.max(Math.abs(previousPose.speed || 0), Math.abs(car.speed || 0));
    car.impactSeq = Number.isSafeInteger(car.impactSeq) ? car.impactSeq + 1 : 1;
    car.impactLevel = clamp(impactSpeed / 22, 0.2, 1);
    impactedCars.add(car.id);
    recoveries.set(car.id, recovery);
    restoreImpactedCar(car, recovery, checkpoint, checkpointHits);
    car.lastSafeRoad = carPose(car);
  }

  const timer = setInterval(() => {
    const nowMs = Date.now();
    if (advanceServerRace(nowMs)) io.emit('lobby', buildLobby());
    const racePublic = publicRaceState(raceState, nowMs);
    const dt = TICK_MS / 1000;
    if (racePublic.running) {
      const substeps = simulationSubsteps(dt);
      const activeCars = [...cars.values()].filter((car) => !car.finished);
      const tickCheckpoints = new Map(activeCars.map((car) => [car.id, car.cp]));
      const tickCheckpointHits = new Map(activeCars.map((car) => [
        car.id,
        new Set(car.checkpointHits)
      ]));
      const impactedCars = new Set();
      const impactRecoveries = new Map();
      for (const car of activeCars) rememberSafeRoadPose(car);
      const beforeInitialCollision = new Map(activeCars.map((car) => [car.id, carPose(car, true)]));
      collide(activeCars, inputs);
      for (const car of activeCars) {
        const previous = beforeInitialCollision.get(car.id);
        const building = findBuildingHit(previous, car);
        if (building) {
          registerBuildingImpact(
            car,
            previous,
            tickCheckpoints.get(car.id),
            tickCheckpointHits.get(car.id),
            building,
            impactedCars,
            impactRecoveries
          );
        }
      }
      const directionLocks = new Map(activeCars.map((car) => [
        car.id,
        directionLockForTick(car.speed, inputs.get(car.id)?.u)
      ]));
      for (let substep = 0; substep < substeps; substep++) {
        const previousPositions = new Map(activeCars.map((car) => [
          car.id,
          carPose(car, true)
        ]));
        for (const car of cars.values()) {
          if (car.finished || impactedCars.has(car.id)) continue;
          const inp = inputs.get(car.id) || { u: 0, a: 0, h: false };
          stepCar(car, inp, index, dt / substeps, directionLocks.get(car.id));
          car.x = clamp(car.x, map.bbox.minX, map.bbox.maxX);
          car.z = clamp(car.z, map.bbox.minZ, map.bbox.maxZ);
        }
        collide(activeCars, inputs, previousPositions);
        for (const car of activeCars) {
          car.x = clamp(car.x, map.bbox.minX, map.bbox.maxX);
          car.z = clamp(car.z, map.bbox.minZ, map.bbox.maxZ);
          const previous = previousPositions.get(car.id);
          const building = !impactedCars.has(car.id) ? findBuildingHit(previous, car) : null;
          if (building) {
            registerBuildingImpact(
              car,
              previous,
              tickCheckpoints.get(car.id),
              tickCheckpointHits.get(car.id),
              building,
              impactedCars,
              impactRecoveries
            );
          }
          if (impactedCars.has(car.id)) {
            restoreImpactedCar(
              car,
              impactRecoveries.get(car.id),
              tickCheckpoints.get(car.id),
              tickCheckpointHits.get(car.id)
            );
            continue;
          }
          const road = index.query(car.x, car.z);
          car.onRoad = road.onRoad;
          car.clearance = road.clearance;
          car.surface = road.surface;
          car.streetName = road.streetName;
          for (const checkpoint of crossedCheckpointIndices(
            cps,
            previous,
            car,
            CHECKPOINT_CAPTURE_RADIUS_M
          )) {
            car.checkpointHits.add(checkpoint);
            car.cp = Math.max(car.cp, checkpoint);
          }
          rememberSafeRoadPose(car);
        }
      }
      for (const car of cars.values()) {
        if (!car.finished && car.checkpointHits.has(cps.length - 1)) {
          car.finished = true;
          car.finishMs = raceElapsedMs(raceState, nowMs);
          car.speed = 0;
          car.gear = 1;
          car.brakeLevel = 0;
          car.handbrake = false;
          syncDrivetrain(car);
          inputs.set(car.id, { u: 0, a: 0, h: false });
          if (sessionBestMs === null || car.finishMs < sessionBestMs) sessionBestMs = car.finishMs;
        }
      }
      for (const car of cars.values()) {
        const next = car.cp + 1 < cps.length ? cps[car.cp + 1] : null;
        const frac = next && Number.isFinite(routeCheckpointSpacing) && routeCheckpointSpacing > 0
          ? clamp(1 - Math.hypot(car.x - next[0], car.z - next[1]) /
            routeCheckpointSpacing, 0, 1)
          : 0;
        car.score = car.cp + frac;
      }
      const ranked = rankRaceCars(cars.values());
      ranked.forEach((c, i) => (c.rank = i + 1));
      advanceServerRace(nowMs);
    }
    io.emit('state', buildState(nowMs));
  }, TICK_MS);
  return {
    server,
    io,
    app,
    map,
    get route() {
      return route;
    },
    routeCatalog,
    buildingFootprints,
    buildingFit,
    buildingIndex,
    cars,
    inputs,
    readyById,
    getHostPlayerId: () => hostPlayerId,
    getWeatherId: () => weatherId,
    getRaceState: () => raceState,
    close() {
      clearInterval(timer);
      io.close();
      server.close();
    }
  };
}

export function parseCliArgs(argv) {
  const args = argv.slice(2);
  let devMode = false;
  for (const arg of args) {
    if (arg === '--dev') devMode = true;
  }
  return { devMode };
}

function main() {
  const { devMode } = parseCliArgs(process.argv);
  const port = Number(process.env.PORT) || 3100;
  const s = startServer({ devMode });
  s.server.listen(port, () => {
    const cps = s.route.checkpoints;
    const len = s.route.lengthM;
    const modeLabel = devMode ? '[dev]' : '[prod]';
    console.log(`${modeLabel} Rally server: http://localhost:${port}`);
    console.log(`Route: ${s.route.start.name} -> ${s.route.end.name} (${cps.length} checkpoint, ${(len / 1000).toFixed(1)} km)`);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
