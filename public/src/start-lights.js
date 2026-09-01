export function startSignalView(payload, phase) {
  if (phase === 'countdown') {
    const rawLights = payload?.startLights;
    const lights = Number.isInteger(rawLights) && rawLights >= 0 && rawLights <= 5
      ? rawLights
      : 0;
    return { visible: true, lights, green: false, signal: lights > 0 ? 'red' : 'off' };
  }
  const green = phase === 'running' && payload?.startSignal === 'green';
  return {
    visible: green,
    lights: 0,
    green,
    signal: green ? 'green' : 'off'
  };
}

export function startSignalAudioEvent(previousView, currentView) {
  if (!previousView || !currentView || typeof previousView !== 'object' ||
    typeof currentView !== 'object') return null;
  if (currentView.green === true && previousView.green !== true) return 'start';
  const previousLights = Number.isInteger(previousView.lights) ? previousView.lights : 0;
  const currentLights = Number.isInteger(currentView.lights) ? currentView.lights : 0;
  return currentView.visible === true && currentView.green !== true &&
    currentLights > previousLights ? 'light' : null;
}
