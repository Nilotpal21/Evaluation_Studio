import type { CheckpointOptions, Decision, ProgressEvent } from '../types.js';
import { TerminalProgressReporter } from '../ui/progress-reporter.js';

export interface InteractiveTerminalDelegate {
  suspendPrompt(): void;
  resumePrompt(): void;
  requestInput(prompt: string): Promise<string>;
}

/**
 * Interactive-aware progress reporter.
 *
 * Extends the base terminal reporter with:
 * - A callback hook so the REPL can react to pipeline events
 * - A terminal delegate so prompts and approval questions share one readline
 */
export class InteractiveReporter extends TerminalProgressReporter {
  private readonly onEvent: ((event: ProgressEvent) => void) | undefined;
  private terminalDelegate: InteractiveTerminalDelegate | null = null;

  constructor(verbose: boolean, autoApprove: boolean, onEvent?: (event: ProgressEvent) => void) {
    super(verbose, autoApprove);
    this.onEvent = onEvent;
  }

  attachTerminal(delegate: InteractiveTerminalDelegate): void {
    this.terminalDelegate = delegate;
  }

  detachTerminal(delegate?: InteractiveTerminalDelegate): void {
    if (delegate && this.terminalDelegate !== delegate) {
      return;
    }
    this.terminalDelegate = null;
  }

  emit(event: ProgressEvent): void {
    this.terminalDelegate?.suspendPrompt();
    try {
      super.emit(event);
      this.onEvent?.(event);
    } finally {
      this.terminalDelegate?.resumePrompt();
    }
  }

  override async onQuestion(decision: Decision): Promise<string> {
    this.terminalDelegate?.suspendPrompt();
    try {
      return await super.onQuestion(decision);
    } finally {
      this.terminalDelegate?.resumePrompt();
    }
  }

  override async onCheckpoint(
    message: string,
    data?: unknown,
    options?: CheckpointOptions,
  ): Promise<boolean> {
    this.terminalDelegate?.suspendPrompt();
    try {
      return await super.onCheckpoint(message, data, options);
    } finally {
      this.terminalDelegate?.resumePrompt();
    }
  }

  protected override promptUser(prompt: string): Promise<string> {
    if (this.terminalDelegate) {
      return this.terminalDelegate.requestInput(prompt);
    }
    return super.promptUser(prompt);
  }
}
