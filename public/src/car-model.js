import * as THREE from 'three';
import { CAR_FOOTPRINT } from '../../shared/vehicle.js';

export const CAR_VISUAL = Object.freeze({
  bodyWidth: 1.6,
  bodyHeight: 0.5,
  bodyLength: CAR_FOOTPRINT.length,
  cabinWidth: 1.3,
  cabinHeight: 0.46,
  cabinLength: 1.7,
  wheelWidth: 0.3,
  wheelHeight: 0.42,
  wheelLength: 0.72,
  wheelX: 0.75,
  wheelZ: 1.08,
  outerWidth: CAR_FOOTPRINT.width
});

export function createCarModel(color) {
  const group = new THREE.Group();
  group.rotation.order = 'YXZ';
  const bodyMaterial = new THREE.MeshLambertMaterial({ color });
  const body = new THREE.Mesh(new THREE.BoxGeometry(
    CAR_VISUAL.bodyWidth,
    CAR_VISUAL.bodyHeight,
    CAR_VISUAL.bodyLength
  ), bodyMaterial);
  body.position.y = 0.5;
  group.add(body);

  const cabin = new THREE.Mesh(new THREE.BoxGeometry(
    CAR_VISUAL.cabinWidth,
    CAR_VISUAL.cabinHeight,
    CAR_VISUAL.cabinLength
  ), new THREE.MeshLambertMaterial({ color: 0x1b2430 }));
  cabin.position.set(0, 0.98, -0.18);
  group.add(cabin);

  const wheelGeometry = new THREE.BoxGeometry(
    CAR_VISUAL.wheelWidth,
    CAR_VISUAL.wheelHeight,
    CAR_VISUAL.wheelLength
  );
  const wheelMaterial = new THREE.MeshLambertMaterial({ color: 0x111418 });
  for (const wheelX of [-CAR_VISUAL.wheelX, CAR_VISUAL.wheelX]) {
    for (const wheelZ of [-CAR_VISUAL.wheelZ, CAR_VISUAL.wheelZ]) {
      const wheel = new THREE.Mesh(wheelGeometry, wheelMaterial);
      wheel.position.set(wheelX, 0.25, wheelZ);
      group.add(wheel);
    }
  }
  return group;
}
