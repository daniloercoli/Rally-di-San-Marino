const TURN_TYPES = new Set(['left', 'straight', 'right']);
const MAX_DIRECTIONS = 512;
const MAX_WORLD_COORDINATE = 1_000_000;

export function normalizeRoutePath(value) {
  if (!Array.isArray(value) || value.length < 4 || value.length % 2 !== 0 || value.length > 8192) return [];
  const points = [];
  for (let i = 0; i < value.length; i += 2) {
    const x = value[i];
    const z = value[i + 1];
    if (typeof x !== 'number' || !Number.isFinite(x) || typeof z !== 'number' || !Number.isFinite(z) ||
      Math.abs(x) > MAX_WORLD_COORDINATE || Math.abs(z) > MAX_WORLD_COORDINATE) return [];
    points.push([x, z]);
  }
  return points;
}

export function normalizeRouteDirections(value, totalCheckpoints) {
  if (!Array.isArray(value) || !Number.isInteger(totalCheckpoints) || totalCheckpoints < 2) return [];
  const normalized = [];
  for (const marker of value.slice(0, MAX_DIRECTIONS)) {
    if (!marker || typeof marker !== 'object' || Array.isArray(marker)) continue;
    const { x, z, yaw, turn, checkpoint } = marker;
    if (![x, z, yaw].every((number) => typeof number === 'number' && Number.isFinite(number))) continue;
    if (Math.abs(x) > MAX_WORLD_COORDINATE || Math.abs(z) > MAX_WORLD_COORDINATE || Math.abs(yaw) > Math.PI * 2) continue;
    if (!TURN_TYPES.has(turn) || !Number.isInteger(checkpoint) || checkpoint < 0 || checkpoint >= totalCheckpoints) continue;
    normalized.push({ x, z, yaw, turn, checkpoint });
  }
  return normalized.sort((a, b) => a.checkpoint - b.checkpoint || a.x - b.x || a.z - b.z);
}

function createArrowGeometry(THREE) {
  const arrow = new THREE.Shape();
  arrow.moveTo(-0.13, -0.45);
  arrow.lineTo(0.13, -0.45);
  arrow.lineTo(0.13, 0.08);
  arrow.lineTo(0.36, 0.08);
  arrow.lineTo(0, 0.48);
  arrow.lineTo(-0.36, 0.08);
  arrow.lineTo(-0.13, 0.08);
  arrow.closePath();
  return new THREE.ShapeGeometry(arrow);
}

export function createRouteSignGroup(THREE, directions, heightAt = () => 0) {
  const root = new THREE.Group();
  root.name = 'route-signs';
  const poleGeometry = new THREE.CylinderGeometry(0.07, 0.09, 1.8, 8);
  const panelGeometry = new THREE.BoxGeometry(1.65, 1.35, 0.12);
  const arrowGeometry = createArrowGeometry(THREE);
  const poleMaterial = new THREE.MeshLambertMaterial({ color: 0xa8b0b8 });
  const panelMaterial = new THREE.MeshLambertMaterial({ color: 0x1769aa });
  const arrowMaterial = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    side: THREE.DoubleSide,
    depthTest: true
  });

  for (const direction of directions) {
    const sign = new THREE.Group();
    sign.name = 'route-sign-' + direction.turn;
    sign.userData.routeDirection = direction;
    const groundY = heightAt(direction.x, direction.z);
    sign.position.set(direction.x, Number.isFinite(groundY) ? groundY : 0, direction.z);
    sign.rotation.y = -direction.yaw;
    sign.visible = false;

    const pole = new THREE.Mesh(poleGeometry, poleMaterial);
    pole.position.y = 0.9;
    sign.add(pole);

    const panel = new THREE.Mesh(panelGeometry, panelMaterial);
    panel.position.y = 2.15;
    sign.add(panel);

    const arrow = new THREE.Mesh(arrowGeometry, arrowMaterial);
    arrow.name = 'route-arrow-' + direction.turn;
    arrow.position.set(0, 2.15, 0.071);
    if (direction.turn === 'left') arrow.rotation.z = Math.PI / 2;
    else if (direction.turn === 'right') arrow.rotation.z = -Math.PI / 2;
    sign.add(arrow);
    root.add(sign);
  }
  return root;
}

export function updateRouteSignVisibility(root, checkpoint, finished = false) {
  if (!root) return 0;
  for (const sign of root.children) sign.visible = false;
  if (finished || !Number.isInteger(checkpoint) || checkpoint < 0) return 0;
  const upcoming = root.children
    .filter((sign) => sign.userData.routeDirection?.checkpoint >= checkpoint - 1)
    .slice(0, 2);
  for (const sign of upcoming) sign.visible = true;
  return upcoming.length;
}
