export function shouldPreventDrivingKey(code) {
  return typeof code === 'string' && (code.startsWith('Arrow') || code === 'Space');
}

export function readDrivingInput(keys) {
  const pressed = (code) => keys?.has?.(code) === true;
  const up = pressed('KeyW') || pressed('ArrowUp');
  const down = pressed('KeyS') || pressed('ArrowDown');
  const left = pressed('KeyA') || pressed('ArrowLeft');
  const right = pressed('KeyD') || pressed('ArrowRight');
  return {
    u: (up ? 1 : 0) - (down ? 1 : 0),
    a: (right ? 1 : 0) - (left ? 1 : 0),
    h: pressed('Space')
  };
}
