import type { Decision, ProgressEvent, ProgressReporter } from '../types.js';
import { TerminalProgressReporter } from './progress-reporter.js';

const DEFAULT_CANARY_ANSWER =
  'Always apply a robust, architecturally sound solution. Do not take shortcuts. Fix the root cause — if the code is hard to test or integrate, redesign the interface. If the answer requires a breaking change, classify as AMBIGUOUS so the user can confirm.';
const MAX_CANARY_EVENTS = 500;

export class CanaryProgressReporter implements ProgressReporter {
  private readonly delegate: TerminalProgressReporter;
  private readonly events: ProgressEvent[] = [];

  constructor(
    verbose: boolean = false,
    private readonly autoAnswer: string = DEFAULT_CANARY_ANSWER,
  ) {
    this.delegate = new TerminalProgressReporter(verbose);
  }

  emit(event: ProgressEvent): void {
    this.events.push(event);
    if (this.events.length > MAX_CANARY_EVENTS) {
      this.events.splice(0, this.events.length - MAX_CANARY_EVENTS);
    }
    this.delegate.emit(event);
  }

  async onQuestion(_decision: Decision): Promise<string> {
    this.emit({
      type: 'stage-progress',
      timestamp: new Date().toISOString(),
      message: `Auto-answering ambiguous decision: ${this.autoAnswer}`,
    });
    return this.autoAnswer;
  }

  async onCheckpoint(message: string): Promise<boolean> {
    this.emit({
      type: 'stage-progress',
      timestamp: new Date().toISOString(),
      message: `Auto-approving checkpoint: ${message}`,
    });
    return true;
  }

  snapshot(): ProgressEvent[] {
    return [...this.events];
  }
}
