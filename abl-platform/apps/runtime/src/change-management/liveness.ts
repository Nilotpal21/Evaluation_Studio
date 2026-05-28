import type { RequestHandler } from 'express';

export interface RuntimeLivenessDependencies {
  isShuttingDown(): boolean;
  getHeapUsedMb(): number;
  getHeapLimitMb(): number;
}

/**
 * Kubernetes liveness probe handler.
 *
 * Zero I/O — only checks in-process signals (shutdown flag, heap pressure).
 * Returns 200 when the process is alive and healthy, 503 when it should be
 * restarted by the kubelet.
 */
export function createRuntimeLivenessHandler(
  dependencies: RuntimeLivenessDependencies,
): RequestHandler {
  return (_req, res) => {
    if (dependencies.isShuttingDown()) {
      return res.status(503).json({ status: 'not_live', reason: 'shutting_down' });
    }

    const heapUsedMB = dependencies.getHeapUsedMb();
    const heapLimitMB = dependencies.getHeapLimitMb();
    if (heapUsedMB > heapLimitMB) {
      return res.status(503).json({
        status: 'not_live',
        reason: 'memory_pressure',
        heapUsedMB: Math.round(heapUsedMB),
        heapLimitMB,
      });
    }

    return res.json({ status: 'live' });
  };
}
