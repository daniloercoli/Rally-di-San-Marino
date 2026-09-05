import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

export const CAR_VISUAL = Object.freeze({
  bodyWidth: 1.56,
  bodyHeight: 0.45,
  bodyLength: 3.04,
  cabinWidth: 1.34,
  cabinHeight: 0.46,
  cabinLength: 1.5,
  wheelWidth: 0.2,
  wheelDiameter: 0.54,
  wheelX: 0.75,
  wheelZ: 1.02,
  outerWidth: 1.7,
  outerLength: 3.2
});

function taperedPrism({
  bottomY,
  topY,
  frontZ,
  rearZ,
  topFrontZ,
  topRearZ,
  bottomFrontHalfWidth,
  bottomRearHalfWidth,
  topFrontHalfWidth,
  topRearHalfWidth
}) {
  const positions = new Float32Array([
    -bottomFrontHalfWidth, bottomY, frontZ,
    bottomFrontHalfWidth, bottomY, frontZ,
    bottomRearHalfWidth, bottomY, rearZ,
    -bottomRearHalfWidth, bottomY, rearZ,
    -topFrontHalfWidth, topY, topFrontZ,
    topFrontHalfWidth, topY, topFrontZ,
    topRearHalfWidth, topY, topRearZ,
    -topRearHalfWidth, topY, topRearZ
  ]);
  const indices = [
    0, 1, 2, 0, 2, 3,
    4, 6, 5, 4, 7, 6,
    0, 4, 5, 0, 5, 1,
    1, 5, 6, 1, 6, 2,
    2, 6, 7, 2, 7, 3,
    3, 7, 4, 3, 4, 0
  ];
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function boxGeometry(width, height, length, x = 0, y = 0, z = 0) {
  const geometry = new THREE.BoxGeometry(width, height, length);
  geometry.deleteAttribute('uv');
  geometry.translate(x, y, z);
  return geometry;
}

function mergeOwned(geometries) {
  const merged = mergeGeometries(geometries, false);
  for (const geometry of geometries) geometry.dispose();
  if (!merged) throw new Error('Impossibile creare la geometria della vettura');
  return merged;
}

function pairedLightsGeometry(width, height, depth) {
  return mergeOwned([
    boxGeometry(width, height, depth, -0.45, 0, 0),
    boxGeometry(width, height, depth, 0.45, 0, 0)
  ]);
}

export function createCarModel(color) {
  const group = new THREE.Group();
  group.rotation.order = 'YXZ';
  const bodyMaterial = new THREE.MeshLambertMaterial({ color });
  const bodyGeometry = mergeOwned([
    taperedPrism({
      bottomY: 0.25,
      topY: 0.7,
      frontZ: -1.52,
      rearZ: 1.52,
      topFrontZ: -1.42,
      topRearZ: 1.44,
      bottomFrontHalfWidth: 0.66,
      bottomRearHalfWidth: 0.78,
      topFrontHalfWidth: 0.72,
      topRearHalfWidth: 0.74
    }),
    boxGeometry(1.04, 0.05, 0.82, 0, 1.115, 0.08),
    boxGeometry(1.34, 0.06, 0.18, 0, 0.83, 1.38),
    boxGeometry(0.08, 0.16, 0.1, -0.48, 0.74, 1.38),
    boxGeometry(0.08, 0.16, 0.1, 0.48, 0.74, 1.38)
  ]);
  const body = new THREE.Mesh(bodyGeometry, bodyMaterial);
  body.name = 'body-shell';
  group.add(body);

  const cabin = new THREE.Mesh(taperedPrism({
    bottomY: 0.63,
    topY: 1.09,
    frontZ: -0.72,
    rearZ: 0.78,
    topFrontZ: -0.38,
    topRearZ: 0.55,
    bottomFrontHalfWidth: 0.65,
    bottomRearHalfWidth: 0.67,
    topFrontHalfWidth: 0.51,
    topRearHalfWidth: 0.54
  }), new THREE.MeshLambertMaterial({ color: 0x182633 }));
  cabin.name = 'cabin';
  group.add(cabin);

  const wheelGeometries = [];
  for (const wheelX of [-CAR_VISUAL.wheelX, CAR_VISUAL.wheelX]) {
    for (const wheelZ of [-CAR_VISUAL.wheelZ, CAR_VISUAL.wheelZ]) {
      const wheel = new THREE.CylinderGeometry(
        CAR_VISUAL.wheelDiameter / 2,
        CAR_VISUAL.wheelDiameter / 2,
        CAR_VISUAL.wheelWidth,
        12
      );
      wheel.rotateZ(Math.PI / 2);
      wheel.translate(wheelX, 0.29, wheelZ);
      wheelGeometries.push(wheel);
    }
  }
  const wheels = new THREE.Mesh(
    mergeOwned(wheelGeometries),
    new THREE.MeshLambertMaterial({ color: 0x101317 })
  );
  wheels.name = 'wheels';
  wheels.userData.shape = 'cylinder';
  wheels.userData.count = 4;
  group.add(wheels);

  const headlights = new THREE.Mesh(
    pairedLightsGeometry(0.36, 0.13, 0.03),
    new THREE.MeshLambertMaterial({ color: 0xffefad, emissive: 0x443300 })
  );
  headlights.name = 'headlights';
  headlights.position.set(0, 0.52, -1.585);
  group.add(headlights);

  const tailLights = new THREE.Mesh(
    pairedLightsGeometry(0.32, 0.13, 0.03),
    new THREE.MeshLambertMaterial({ color: 0xd72d2d, emissive: 0x380000 })
  );
  tailLights.name = 'tail-lights';
  tailLights.position.set(0, 0.54, 1.585);
  group.add(tailLights);
  return group;
}
