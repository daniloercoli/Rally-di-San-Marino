import { SURFACE, clamp } from './geometry.js';

export { SURFACE } from './geometry.js';

export const PHYSICS = {
  onRoad: {
    maxSpeed: 250 / 3.6,
    reverseMax: 6,
    accel: 13,
    brake: 24,
    handbrake: 9,
    handbrakeSteer: 1.75,
    coast: 0.15,
    overspeedDecel: 18,
    steer: 1.65
  },
  shoulder: {
    maxSpeed: 250 / 3.6,
    reverseMax: 6,
    accel: 13,
    brake: 24,
    handbrake: 9,
    handbrakeSteer: 1.75,
    coast: 0.15,
    overspeedDecel: 18,
    steer: 1.452
  },
  track: {
    maxSpeed: 110 / 3.6,
    reverseMax: 4,
    accel: 7,
    brake: 19,
    handbrake: 7,
    handbrakeSteer: 1.6,
    coast: 0.18,
    overspeedDecel: 9,
    steer: 1.25
  },
  offRoad: {
    maxSpeed: 50 / 3.6,
    reverseMax: 3,
    accel: 4,
    brake: 15,
    handbrake: 6,
    handbrakeSteer: 1.45,
    coast: 0.2,
    overspeedDecel: 7,
    steer: 1.05
  }
};

export const DRIVETRAIN = Object.freeze({
  idleRpm: 900,
  redlineRpm: 7600,
  reverseSpeedRange: 7,
  gearRanges: Object.freeze([
    Object.freeze({ min: 0, max: 20 }),
    Object.freeze({ min: 11, max: 34 }),
    Object.freeze({ min: 23, max: 48 }),
    Object.freeze({ min: 35, max: 60 }),
    Object.freeze({ min: 46, max: 72 })
  ])
});

function finiteInput(value) {
  return typeof value === 'number' && Number.isFinite(value) ? clamp(value, -1, 1) : 0;
}

function moveToward(value, target, maxDelta) {
  if (value < target) return Math.min(value + maxDelta, target);
  if (value > target) return Math.max(value - maxDelta, target);
  return target;
}

function releaseDelta(speed, physics, step) {
  if (speed > physics.maxSpeed || speed < -physics.reverseMax) {
    return physics.overspeedDecel * step;
  }
  return Math.abs(speed) * (1 - Math.exp(-physics.coast * step));
}

export function directionLockForTick(speed, driveInput) {
  const velocity = typeof speed === 'number' && Number.isFinite(speed) ? speed : 0;
  const input = finiteInput(driveInput);
  if (velocity > 0 && input < 0) return 1;
  if (velocity < 0 && input > 0) return -1;
  return 0;
}

export function automaticGear(speed, previousGear = 1, driveInput = 0) {
  const velocity = Number.isFinite(speed) ? speed : 0;
  const input = finiteInput(driveInput);
  if (velocity < 0) return -1;
  if (velocity === 0 && input < 0) return -1;
  if (velocity === 0 && input === 0 && previousGear === -1) return -1;

  let gear = Number.isInteger(previousGear) && previousGear >= 1 && previousGear <= 5
    ? previousGear
    : 1;
  while (gear < DRIVETRAIN.gearRanges.length && velocity > DRIVETRAIN.gearRanges[gear - 1].max) gear++;
  while (gear > 1 && velocity < DRIVETRAIN.gearRanges[gear - 1].min) gear--;
  return gear;
}

export function rpmForSpeed(speed, gear) {
  const velocity = Number.isFinite(speed) ? Math.abs(speed) : 0;
  let fraction = 0;
  if (gear === -1) {
    fraction = velocity / DRIVETRAIN.reverseSpeedRange;
  } else {
    const safeGear = Number.isInteger(gear) && gear >= 1 && gear <= DRIVETRAIN.gearRanges.length ? gear : 1;
    const range = DRIVETRAIN.gearRanges[safeGear - 1];
    fraction = (velocity - range.min) / (range.max - range.min);
  }
  const rpm = DRIVETRAIN.idleRpm + clamp(fraction, 0, 1) * (DRIVETRAIN.redlineRpm - DRIVETRAIN.idleRpm);
  return clamp(rpm, DRIVETRAIN.idleRpm, DRIVETRAIN.redlineRpm);
}

export function driveForceMultiplier(rpm) {
  const normalized = clamp(
    ((Number.isFinite(rpm) ? rpm : DRIVETRAIN.idleRpm) - DRIVETRAIN.idleRpm) /
      (DRIVETRAIN.redlineRpm - DRIVETRAIN.idleRpm),
    0,
    1
  );
  return 0.72 + Math.sin(normalized * Math.PI) * 0.38;
}

export function syncDrivetrain(car, driveInput = 0) {
  car.surface = car.surface === SURFACE.SHOULDER || car.surface === SURFACE.TRACK ||
    car.surface === SURFACE.GRASS
    ? car.surface
    : car.onRoad === false ? SURFACE.GRASS : SURFACE.ASPHALT;
  car.gear = automaticGear(car.speed, car.gear, driveInput);
  car.rpm = rpmForSpeed(car.speed, car.gear);
  car.brakeLevel = clamp(Number.isFinite(car.brakeLevel) ? car.brakeLevel : 0, 0, 1);
  car.handbrake = car.handbrake === true;
  return car;
}

export function createCar(id, x, z, yaw, color, name) {
  return {
    id,
    name,
    color,
    x,
    z,
    yaw,
    speed: 0,
    gear: 1,
    rpm: DRIVETRAIN.idleRpm,
    brakeLevel: 0,
    handbrake: false,
    surface: SURFACE.ASPHALT,
    impactSeq: 0,
    impactLevel: 0,
    onRoad: true,
    clearance: 0,
    cp: 0,
    score: 0,
    rank: 0
  };
}

// input: { u: throttle/brake [-1..1], a: steer [-1..1 (left)..1..(right)], h: handbrake boolean }
// roadIndex: RoadIndex (shared/geometry.js)
// directionLock: initial motion sign while braking across server substeps (-1, 0, 1)
export function stepCar(car, input, roadIndex, dt, directionLock = 0) {
  const surface = car.surface === SURFACE.SHOULDER || car.surface === SURFACE.TRACK ||
    car.surface === SURFACE.GRASS
    ? car.surface
    : car.onRoad === false ? SURFACE.GRASS : SURFACE.ASPHALT;
  const p = surface === SURFACE.TRACK
    ? PHYSICS.track
    : surface === SURFACE.GRASS
      ? PHYSICS.offRoad
      : surface === SURFACE.SHOULDER ? PHYSICS.shoulder : PHYSICS.onRoad;
  const pavedSurface = surface === SURFACE.ASPHALT || surface === SURFACE.SHOULDER;
  const u = finiteInput(input?.u);
  const a = finiteInput(input?.a);
  const handbrake = input?.h === true;
  const driveInput = handbrake ? 0 : u;
  const step = typeof dt === 'number' && Number.isFinite(dt) && dt > 0 ? dt : 0;
  const lock = directionLock === -1 || directionLock === 1 ? directionLock : 0;
  const speedBefore = car.speed;
  let brakingHold = false;
  car.brakeLevel = 0;
  car.handbrake = handbrake;

  if (driveInput > 0) {
    if (lock === -1 && car.speed >= 0) {
      car.brakeLevel = driveInput;
      brakingHold = true;
    } else if (car.speed < 0) {
      const brakingDelta = Math.max(
        p.brake * driveInput * step,
        releaseDelta(car.speed, p, step)
      );
      car.speed = moveToward(car.speed, 0, brakingDelta);
      car.brakeLevel = driveInput;
    } else if (car.speed > p.maxSpeed) {
      car.speed = moveToward(car.speed, p.maxSpeed, p.overspeedDecel * step);
    } else {
      car.gear = automaticGear(car.speed, car.gear, driveInput);
      car.rpm = rpmForSpeed(car.speed, car.gear);
      const highSpeedProgress = pavedSurface
        ? clamp((car.speed - 200 / 3.6) / (p.maxSpeed - 200 / 3.6), 0, 1)
        : 0;
      const highSpeedTaper = 1 - highSpeedProgress * 0.96;
      const responseMaxSpeed = pavedSurface ? 225 / 3.6 : p.maxSpeed;
      const speedFactor = Math.max(0.12, 1 - Math.pow(car.speed / responseMaxSpeed, 2)) * highSpeedTaper;
      car.speed = Math.min(
        p.maxSpeed,
        car.speed + p.accel * driveForceMultiplier(car.rpm) * speedFactor * driveInput * step
      );
    }
  } else if (driveInput < 0) {
    if (lock === 1 && car.speed <= 0) {
      car.brakeLevel = -driveInput;
      brakingHold = true;
    } else if (car.speed > 0) {
      const brakingDelta = Math.max(
        p.brake * -driveInput * step,
        releaseDelta(car.speed, p, step)
      );
      car.speed = moveToward(car.speed, 0, brakingDelta);
      car.brakeLevel = -driveInput;
    } else if (car.speed < -p.reverseMax) {
      car.speed = moveToward(car.speed, -p.reverseMax, p.overspeedDecel * step);
    } else {
      car.gear = -1;
      car.rpm = rpmForSpeed(car.speed, car.gear);
      const speedFactor = Math.max(0.15, 1 - Math.pow(car.speed / p.reverseMax, 2));
      car.speed = Math.max(
        -p.reverseMax,
        car.speed - p.accel * 0.55 * driveForceMultiplier(car.rpm) * speedFactor * -driveInput * step
      );
    }
  } else {
    if (car.speed > p.maxSpeed) {
      car.speed = moveToward(car.speed, p.maxSpeed, p.overspeedDecel * step);
    } else if (car.speed < -p.reverseMax) {
      car.speed = moveToward(car.speed, -p.reverseMax, p.overspeedDecel * step);
    } else {
      car.speed *= Math.exp(-p.coast * step);
    }
    if (Math.abs(car.speed) < 0.05) car.speed = 0;
  }
  if (handbrake && car.speed !== 0) {
    car.speed = moveToward(car.speed, 0, p.handbrake * step);
    car.brakeLevel = 1;
  }
  car.speed = clamp(car.speed, -PHYSICS.onRoad.reverseMax, PHYSICS.onRoad.maxSpeed);

  const speedRatio = clamp(Math.abs(car.speed) / p.maxSpeed, 0, 1);
  const lowSpeedResponse = clamp(Math.abs(car.speed) / 4, 0, 1);
  const highSpeedResponse = 1 - 0.55 * Math.pow(speedRatio, 1.5);
  const handbrakeResponse = handbrake && Math.abs(car.speed) >= 2 ? p.handbrakeSteer : 1;
  const direction = car.speed >= 0 ? 1 : -1;
  car.yaw += a * p.steer * lowSpeedResponse * highSpeedResponse * handbrakeResponse * direction * step;

  car.x += Math.sin(car.yaw) * car.speed * step;
  car.z -= Math.cos(car.yaw) * car.speed * step;

  const q = roadIndex.query(car.x, car.z);
  car.onRoad = q.onRoad;
  car.clearance = q.clearance;
  car.surface = q.surface;
  const stoppedByBraking = car.brakeLevel > 0 &&
    (brakingHold || (speedBefore !== 0 && car.speed === 0));
  syncDrivetrain(car, stoppedByBraking || handbrake ? 0 : driveInput);
  return car;
}

export const CAR_RADIUS = 1.88;
const RESTITUTION = 0.4;
const COLLISION_EPSILON = 1e-9;

export function simulationSubsteps(dt) {
  const safeDt = typeof dt === 'number' && Number.isFinite(dt) && dt > 0 ? dt : 0;
  return Math.max(1, Math.ceil(PHYSICS.onRoad.maxSpeed * safeDt / CAR_RADIUS));
}

function sweptCircleContact(A, B, previousPositions, minD) {
  const previousA = previousPositions?.get?.(A.id);
  const previousB = previousPositions?.get?.(B.id);
  if (!previousA || !previousB ||
    !Number.isFinite(previousA.x) || !Number.isFinite(previousA.z) ||
    !Number.isFinite(previousB.x) || !Number.isFinite(previousB.z)) return null;

  const startDx = previousB.x - previousA.x;
  const startDz = previousB.z - previousA.z;
  const endDx = B.x - A.x;
  const endDz = B.z - A.z;
  const travelDx = endDx - startDx;
  const travelDz = endDz - startDz;
  const qa = travelDx * travelDx + travelDz * travelDz;
  if (qa <= Number.EPSILON) return null;
  const qb = 2 * (startDx * travelDx + startDz * travelDz);
  const qc = startDx * startDx + startDz * startDz - minD * minD;
  const discriminant = qb * qb - 4 * qa * qc;
  if (discriminant < 0) return null;
  const discriminantScale = Math.max(1, qb * qb, Math.abs(4 * qa * qc));
  if (discriminant <= COLLISION_EPSILON * discriminantScale) return null;
  const t = (-qb - Math.sqrt(discriminant)) / (2 * qa);
  if (t < 0 || t > 1) return null;

  const contactDx = startDx + travelDx * t;
  const contactDz = startDz + travelDz * t;
  const contactD = Math.hypot(contactDx, contactDz);
  const approach = contactDx * travelDx + contactDz * travelDz;
  const approachEpsilon = COLLISION_EPSILON * Math.max(1, contactD * Math.sqrt(qa));
  if (contactD <= Number.EPSILON || approach >= -approachEpsilon) return null;
  return {
    ax: previousA.x + (A.x - previousA.x) * t,
    az: previousA.z + (A.z - previousA.z) * t,
    bx: previousB.x + (B.x - previousB.x) * t,
    bz: previousB.z + (B.z - previousB.z) * t,
    nx: contactDx / contactD,
    nz: contactDz / contactD
  };
}

// circle collision between cars (arcade): separate + impulse on the normal,
// then re-project velocity onto each car's heading
export function collide(cars, inputs, previousPositions) {
  for (let i = 0; i < cars.length; i++) {
    for (let j = i + 1; j < cars.length; j++) {
      const A = cars[i];
      const B = cars[j];
      const dx = B.x - A.x;
      const dz = B.z - A.z;
      const d2 = dx * dx + dz * dz;
      const minD = CAR_RADIUS * 2;
      const swept = sweptCircleContact(A, B, previousPositions, minD);
      let nx;
      let nz;
      if (swept) {
        A.x = swept.ax;
        A.z = swept.az;
        B.x = swept.bx;
        B.z = swept.bz;
        nx = swept.nx;
        nz = swept.nz;
      } else if (d2 < minD * minD) {
        const d = Math.sqrt(d2);
        if (d > Number.EPSILON) {
          nx = dx / d;
          nz = dz / d;
        } else {
          const previousA = previousPositions?.get?.(A.id);
          const previousB = previousPositions?.get?.(B.id);
          const previousDx = previousB?.x - previousA?.x;
          const previousDz = previousB?.z - previousA?.z;
          const previousD = Math.hypot(previousDx, previousDz);
          nx = previousD > Number.EPSILON ? previousDx / previousD : 1;
          nz = previousD > Number.EPSILON ? previousDz / previousD : 0;
        }
        const push = (minD - d) / 2;
        A.x -= nx * push;
        A.z -= nz * push;
        B.x += nx * push;
        B.z += nz * push;
      } else {
        continue;
      }
      const fax = Math.sin(A.yaw);
      const faz = -Math.cos(A.yaw);
      const fbx = Math.sin(B.yaw);
      const fbz = -Math.cos(B.yaw);
      let vax = fax * A.speed;
      let vaz = faz * A.speed;
      let vbx = fbx * B.speed;
      let vbz = fbz * B.speed;
      const vrel = (vbx - vax) * nx + (vbz - vaz) * nz;
      const headingAOnNormal = fax * nx + faz * nz;
      const headingBOnNormal = fbx * nx + fbz * nz;
      const impulseDenominator = headingAOnNormal * headingAOnNormal +
        headingBOnNormal * headingBOnNormal;
      if (vrel < 0 && impulseDenominator > Number.EPSILON) {
        const imp = -(1 + RESTITUTION) * vrel / impulseDenominator;
        vax -= imp * nx;
        vaz -= imp * nz;
        vbx += imp * nx;
        vbz += imp * nz;
        A.speed = vax * fax + vaz * faz;
        B.speed = vbx * fbx + vbz * fbz;
      }
      if (vrel < 0) {
        A.speed = clamp(A.speed, -PHYSICS.onRoad.reverseMax, PHYSICS.onRoad.maxSpeed);
        B.speed = clamp(B.speed, -PHYSICS.onRoad.reverseMax, PHYSICS.onRoad.maxSpeed);
        const postClampVrel = B.speed * headingBOnNormal - A.speed * headingAOnNormal;
        if (postClampVrel < -COLLISION_EPSILON) {
          A.speed = 0;
          B.speed = 0;
        }
      }
    }
  }
  for (const car of cars) {
    car.speed = clamp(car.speed, -PHYSICS.onRoad.reverseMax, PHYSICS.onRoad.maxSpeed);
    const storedInput = inputs?.get?.(car.id);
    const driveInput = finiteInput(storedInput?.u);
    car.handbrake = storedInput?.h === true;
    const stoppedByBraking = car.speed === 0 && car.brakeLevel > 0;
    if (!stoppedByBraking) {
      const brakingForward = car.speed > 0 && driveInput < 0;
      const brakingReverse = car.speed < 0 && driveInput > 0;
      car.brakeLevel = Math.max(
        brakingForward || brakingReverse ? Math.abs(driveInput) : 0,
        car.handbrake && car.speed !== 0 ? 1 : 0
      );
    }
    syncDrivetrain(car, stoppedByBraking || car.handbrake ? 0 : driveInput);
  }
}

export function forwardX(yaw) {
  return Math.sin(yaw);
}

export function forwardZ(yaw) {
  return -Math.cos(yaw);
}
