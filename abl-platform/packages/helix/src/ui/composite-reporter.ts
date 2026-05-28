import type { CheckpointOptions, Decision, ProgressEvent, ProgressReporter } from '../types.js';

/**
 * Multiplexes progress events to multiple reporters.
 *
 * The first reporter is the "primary" — it handles interactive methods
 * (onQuestion, onCheckpoint). Additional reporters receive emit() calls
 * only and their interactive responses are ignored.
 */
export class CompositeReporter implements ProgressReporter {
  private readonly primary: ProgressReporter;
  private readonly secondaries: ProgressReporter[];

  constructor(primary: ProgressReporter, ...secondaries: ProgressReporter[]) {
    this.primary = primary;
    this.secondaries = secondaries;
  }

  emit(event: ProgressEvent): void {
    this.primary.emit(event);
    for (const r of this.secondaries) {
      r.emit(event);
    }
  }

  async onQuestion(decision: Decision): Promise<string> {
    this.fanOutInteractiveCall((reporter) => reporter.onQuestion(decision));
    return this.primary.onQuestion(decision);
  }

  async onCheckpoint(
    message: string,
    data?: unknown,
    options?: CheckpointOptions,
  ): Promise<boolean> {
    this.fanOutInteractiveCall((reporter) => reporter.onCheckpoint(message, data, options));
    return this.primary.onCheckpoint(message, data, options);
  }

  private fanOutInteractiveCall(invoke: (reporter: ProgressReporter) => Promise<unknown>): void {
    for (const reporter of this.secondaries) {
      void invoke(reporter).catch(() => {
        // Secondary reporters are best-effort. Never let logging side-effects
        // break the primary interactive flow.
      });
    }
  }
}
