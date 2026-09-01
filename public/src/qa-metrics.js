function finiteTransform(object) {
  const values = [
    object?.position?.x, object?.position?.y, object?.position?.z,
    object?.rotation?.x, object?.rotation?.y, object?.rotation?.z,
    object?.scale?.x, object?.scale?.y, object?.scale?.z
  ];
  return values.every((value) => value === undefined || Number.isFinite(value));
}

export function collectQaMetrics(renderer, scene) {
  let sceneObjects = 0;
  let nonFiniteTransforms = 0;
  let maxVehiclePitchDegrees = 0;
  let maxVehicleRollDegrees = 0;
  scene?.traverse?.((object) => {
    sceneObjects++;
    if (!finiteTransform(object)) nonFiniteTransforms++;
    const attitude = object?.userData?.terrainAttitude;
    if (Number.isFinite(attitude?.pitch)) {
      maxVehiclePitchDegrees = Math.max(
        maxVehiclePitchDegrees,
        Math.abs(attitude.pitch * 180 / Math.PI)
      );
    }
    if (Number.isFinite(attitude?.roll)) {
      maxVehicleRollDegrees = Math.max(
        maxVehicleRollDegrees,
        Math.abs(attitude.roll * 180 / Math.PI)
      );
    }
  });
  const render = renderer?.info?.render || {};
  const memory = renderer?.info?.memory || {};
  return {
    frame: Number.isFinite(render.frame) ? render.frame : 0,
    drawCalls: Number.isFinite(render.calls) ? render.calls : 0,
    triangles: Number.isFinite(render.triangles) ? render.triangles : 0,
    geometries: Number.isFinite(memory.geometries) ? memory.geometries : 0,
    textures: Number.isFinite(memory.textures) ? memory.textures : 0,
    sceneObjects,
    nonFiniteTransforms,
    maxVehiclePitchDegrees: Math.round(maxVehiclePitchDegrees * 100) / 100,
    maxVehicleRollDegrees: Math.round(maxVehicleRollDegrees * 100) / 100
  };
}

export function collectBrowserPerformance(performanceRef, longTaskState = {}) {
  const resources = performanceRef?.getEntriesByType?.('resource') || [];
  let transferBytes = 0;
  let decodedBytes = 0;
  for (const resource of resources) {
    if (Number.isFinite(resource.transferSize)) transferBytes += resource.transferSize;
    if (Number.isFinite(resource.decodedBodySize)) decodedBytes += resource.decodedBodySize;
  }
  const usedJsHeapBytes = performanceRef?.memory?.usedJSHeapSize;
  return {
    resourceCount: resources.length,
    transferBytes,
    decodedBytes,
    usedJsHeapBytes: Number.isFinite(usedJsHeapBytes) ? usedJsHeapBytes : null,
    longTasks: Number.isSafeInteger(longTaskState.count) ? longTaskState.count : 0,
    longTaskMs: Number.isFinite(longTaskState.durationMs)
      ? Math.round(longTaskState.durationMs * 100) / 100
      : 0
  };
}

export function installQaMetrics(documentRef, renderer, scene) {
  const output = documentRef.createElement('output');
  output.id = 'qa-metrics';
  output.hidden = true;
  documentRef.body.appendChild(output);
  const windowRef = documentRef.defaultView;
  const longTaskState = { count: 0, durationMs: 0 };
  try {
    if (windowRef?.PerformanceObserver?.supportedEntryTypes?.includes('longtask')) {
      const observer = new windowRef.PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          longTaskState.count++;
          if (Number.isFinite(entry.duration)) longTaskState.durationMs += entry.duration;
        }
      });
      observer.observe({ type: 'longtask', buffered: true });
    }
  } catch {
    // Le metriche restano disponibili anche dove Long Tasks non è supportato.
  }
  let sampleFrame = 0;
  return () => {
    sampleFrame++;
    if (sampleFrame % 30 !== 0) return;
    output.textContent = JSON.stringify({
      ...collectQaMetrics(renderer, scene),
      ...collectBrowserPerformance(windowRef?.performance, longTaskState),
      viewport: [windowRef?.innerWidth ?? 0, windowRef?.innerHeight ?? 0],
      devicePixelRatio: windowRef?.devicePixelRatio ?? 1,
      userAgent: windowRef?.navigator?.userAgent ?? 'unknown'
    });
  };
}
