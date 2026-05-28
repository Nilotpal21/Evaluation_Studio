export interface ArchRequestTiming {
  requestId: string;
  requestStartedAt: number;
}

interface LogArchTimelineArgs {
  timing?: ArchRequestTiming;
  log: (message: string, meta?: Record<string, unknown>) => void;
  step: string;
  data?: Record<string, unknown>;
}

export function logArchTimeline({ timing, log, step, data }: LogArchTimelineArgs): void {
  if (!timing) {
    return;
  }

  log('arch_ai.timeline', {
    requestId: timing.requestId,
    step,
    elapsedMs: Date.now() - timing.requestStartedAt,
    ...(data ?? {}),
  });
}
