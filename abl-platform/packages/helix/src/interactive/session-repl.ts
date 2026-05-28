import {
  clearLine,
  createInterface,
  cursorTo,
  type Interface as ReadlineInterface,
} from 'node:readline';
import { readFile } from 'node:fs/promises';

import { writeFileAtomic } from '../io/atomic-file.js';
import { InputClassifier, type InputClassifierOptions } from './input-classifier.js';
import type { InteractiveReporter, InteractiveTerminalDelegate } from './interactive-reporter.js';
import type { PipelineEngine } from '../pipeline/pipeline-engine.js';
import type { ProgressEvent } from '../types.js';
import type {
  ClassifiedInput,
  PipelineControlCommand,
  PipelinePauseResult,
  PipelineResumeResult,
  PipelineStatus,
} from './types.js';

const BASE_PROMPT = '\x1b[36mhelix\x1b[0m';
const HISTORY_LIMIT = 200;
const SPINNER_FRAMES = ['-', '\\', '|', '/'];
const TOP_LEVEL_COMPLETIONS = [
  'help',
  'status',
  'pause',
  'resume',
  'abort',
  'context: ',
  'focus on ',
  'skip ',
  'prioritize ',
];

type ReadlineFactory = (options: Parameters<typeof createInterface>[0]) => ManagedReadline;

interface ManagedReadline extends ReadlineInterface {
  history: string[];
  line: string;
  cursor: number;
}

export interface SessionReplOptions extends InputClassifierOptions {
  reporter?: InteractiveReporter;
  historyFilePath?: string;
  readlineFactory?: ReadlineFactory;
}

/**
 * Interactive Session REPL for HELIX.
 *
 * Runs alongside the pipeline, accepting user input and dispatching
 * commands to the PipelineEngine's control API. Uses the InputClassifier
 * to resolve natural language into structured intents.
 *
 * Lifecycle:
 *   1. `start()` — starts the readline loop
 *   2. User types → classify → dispatch → feedback
 *   3. `stop()` — cleanup on pipeline completion or abort
 */
export class SessionRepl implements InteractiveTerminalDelegate {
  private rl: ManagedReadline | null = null;
  private readonly classifier: InputClassifier;
  private readonly reporter: InteractiveReporter | null;
  private readonly historyFilePath: string | null;
  private readonly readlineFactory: ReadlineFactory;
  private running = false;
  private promptSuspended = false;
  private questionActive = false;
  private pausePending = false;
  private latestStatus: PipelineStatus | null = null;
  private latestCostUsd = 0;
  private spinnerFrameIndex = 0;
  private spinnerTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly engine: PipelineEngine,
    options: SessionReplOptions = {},
  ) {
    this.classifier = new InputClassifier({ llmClassify: options.llmClassify });
    this.reporter = options.reporter ?? null;
    this.historyFilePath = options.historyFilePath ?? null;
    this.readlineFactory =
      options.readlineFactory ??
      ((readlineOptions) => createInterface(readlineOptions) as ManagedReadline);
  }

  /**
   * Start the interactive REPL.
   */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.latestStatus = this.engine.getStatus();

    this.rl = this.readlineFactory({
      input: process.stdin,
      output: process.stdout,
      prompt: this.buildPrompt(),
      terminal: process.stdin.isTTY ?? false,
      historySize: HISTORY_LIMIT,
      removeHistoryDuplicates: true,
      completer: (line: string) => this.completeInput(line),
    });

    this.reporter?.attachTerminal(this);
    await this.loadHistory();

    this.rl.on('line', (line: string) => {
      if (line.trim()) {
        void this.persistCurrentHistory();
      }

      this.handleInput(line).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        write(`\x1b[31m  Error: ${message}\x1b[0m\n`);
        this.reprompt();
      });
    });

    this.rl.on('close', () => {
      this.running = false;
      this.promptSuspended = false;
      this.questionActive = false;
      this.stopSpinner();
      this.reporter?.detachTerminal(this);
    });

    write('\n\x1b[36m  Interactive mode active. Type "help" for commands.\x1b[0m\n');
    write('\x1b[2m  Tab completion and persistent history are enabled.\x1b[0m\n\n');
    this.startSpinner();
    this.redrawPrompt();
  }

  /**
   * Stop the REPL and clean up.
   */
  stop(): void {
    this.running = false;
    this.stopSpinner();

    if (!this.rl) {
      this.reporter?.detachTerminal(this);
      return;
    }

    const historySnapshot = [...this.rl.history];
    void this.persistHistory(historySnapshot);
    this.reporter?.detachTerminal(this);

    const rl = this.rl;
    this.rl = null;
    rl.close();
  }

  /**
   * Whether the REPL is currently active.
   */
  get isRunning(): boolean {
    return this.running;
  }

  /**
   * Called by the InteractiveReporter on pipeline events.
   * Updates the live prompt state so users can see stage, finding,
   * and cost changes without typing `status`.
   */
  onPipelineEvent(event: ProgressEvent): void {
    this.latestStatus = this.engine.getStatus();
    this.updatePromptState(event);
  }

  suspendPrompt(): void {
    if (!this.rl || !this.running || this.questionActive || this.promptSuspended) {
      return;
    }

    if (process.stdout.isTTY !== false) {
      clearLine(process.stdout, 0);
      cursorTo(process.stdout, 0);
    }

    this.promptSuspended = true;
  }

  resumePrompt(): void {
    if (!this.running) {
      return;
    }

    this.promptSuspended = false;
    this.redrawPrompt();
  }

  async requestInput(prompt: string): Promise<string> {
    if (!this.rl || !this.running) {
      throw new Error('Interactive terminal is not running');
    }

    this.questionActive = true;
    this.stopSpinner();

    return new Promise((resolve) => {
      this.rl!.question(prompt, (answer) => {
        this.questionActive = false;
        this.startSpinner();
        resolve(answer.trim());
      });
    });
  }

  /**
   * Process a single line of user input.
   * Exported for testing.
   */
  async handleInput(rawInput: string): Promise<ClassifiedInput> {
    const trimmed = rawInput.trim();
    if (!trimmed) {
      this.reprompt();
      return { intent: 'unknown', confidence: 0, rawInput: trimmed, params: {} };
    }

    const classified = await this.classifier.classify(trimmed);
    const controlCommand = this.toControlCommand(classified, trimmed);

    if (controlCommand) {
      await this.dispatchControlCommand(controlCommand);
      this.reprompt();
      return classified;
    }

    switch (classified.intent) {
      case 'help':
        this.printHelp();
        break;

      case 'status': {
        const status = this.engine.getStatus();
        if (status) {
          this.printStatus(status);
        } else {
          write('  No active pipeline.\n');
        }
        break;
      }

      case 'unknown':
        if (classified.confidence < 0.3) {
          write(
            '\x1b[33m  Unknown command. Type "help" for available commands, or prefix with "context:" to inject guidance.\x1b[0m\n',
          );
        } else {
          write(
            `\x1b[33m  Didn't understand that (confidence: ${(classified.confidence * 100).toFixed(0)}%). Try "help".\x1b[0m\n`,
          );
        }
        break;
    }

    this.reprompt();
    return classified;
  }

  private async dispatchControlCommand(command: PipelineControlCommand): Promise<void> {
    switch (command.type) {
      case 'inject-context':
        await this.engine.injectContext(command.content);
        write('\x1b[32m  Context queued for the next stage.\x1b[0m\n');
        return;

      case 'skip-stage': {
        const found = this.engine.skipStage(command.stageName);
        if (found) {
          write(`\x1b[33m  Stage "${command.stageName}" will be skipped.\x1b[0m\n`);
        } else {
          write(`\x1b[31m  No stage matching "${command.stageName}" found.\x1b[0m\n`);
        }
        return;
      }

      case 'pause':
        this.printPauseResult(this.engine.pause());
        return;

      case 'resume':
        this.printResumeResult(this.engine.unpause());
        return;

      case 'abort':
        this.engine.abort();
        this.pausePending = false;
        write('\x1b[31m  Pipeline abort requested.\x1b[0m\n');
        return;

      case 'prioritize-finding': {
        const found = this.engine.prioritizeFinding(command.findingId);
        if (found) {
          write(`\x1b[32m  Finding ${command.findingId} escalated to critical.\x1b[0m\n`);
        } else {
          write(`\x1b[31m  Finding "${command.findingId}" not found.\x1b[0m\n`);
        }
      }
    }
  }

  private toControlCommand(
    classified: ClassifiedInput,
    trimmedInput: string,
  ): PipelineControlCommand | null {
    switch (classified.intent) {
      case 'inject-context':
        return {
          type: 'inject-context',
          content: classified.params['content'] ?? trimmedInput,
        };

      case 'skip-stage': {
        const stageName = classified.params['stageName'];
        if (!stageName) {
          write('  Usage: skip <stage-name>\n');
          return null;
        }
        return { type: 'skip-stage', stageName };
      }

      case 'pause':
        return { type: 'pause' };

      case 'resume':
        return { type: 'resume' };

      case 'abort':
        return { type: 'abort' };

      case 'prioritize': {
        const findingId = classified.params['findingId'];
        if (!findingId) {
          write('  Usage: prioritize <finding-id>\n');
          return null;
        }
        return { type: 'prioritize-finding', findingId };
      }

      case 'help':
      case 'status':
      case 'unknown':
        return null;
    }
  }

  private printPauseResult(result: PipelinePauseResult): void {
    if (result === 'already-paused') {
      write('\x1b[33m  Pause is already pending or the pipeline is already paused.\x1b[0m\n');
      return;
    }

    this.pausePending = true;
    write('\x1b[33m  Pipeline will pause after the current stage completes.\x1b[0m\n');
  }

  private printResumeResult(result: PipelineResumeResult): void {
    switch (result) {
      case 'resumed':
        this.pausePending = false;
        write('\x1b[32m  Pipeline resumed.\x1b[0m\n');
        return;

      case 'cancelled-pending-pause':
        this.pausePending = false;
        write(
          '\x1b[32m  Pending pause cleared. The pipeline will continue after the current stage.\x1b[0m\n',
        );
        return;

      case 'not-paused':
        write('\x1b[33m  Pipeline is already running. Nothing to resume.\x1b[0m\n');
        return;
    }
  }

  private reprompt(): void {
    this.redrawPrompt();
  }

  private printHelp(): void {
    write(`
\x1b[1m  HELIX Interactive Commands\x1b[0m

  \x1b[36mstatus\x1b[0m                  Show current pipeline status
  \x1b[36mcontext: <guidance>\x1b[0m     Inject context into the next stage
  \x1b[36mfocus on <topic>\x1b[0m        Inject context (natural language)
  \x1b[36mskip <stage>\x1b[0m            Skip a pipeline stage
  \x1b[36mprioritize <finding-id>\x1b[0m Escalate a finding to critical
  \x1b[36mpause\x1b[0m                   Pause after current stage
  \x1b[36mresume\x1b[0m                  Resume a paused pipeline
  \x1b[36mabort\x1b[0m                   Abort the pipeline
  \x1b[36mhelp\x1b[0m                    Show this help

  \x1b[2mUse Tab for command completion and Up/Down for persistent history.\x1b[0m
`);
  }

  private printStatus(status: PipelineStatus): void {
    const elapsed = formatElapsed(status.elapsedMs);
    const sliceLabel =
      status.totalSlices > 0 ? `${status.currentSlice + 1}/${status.totalSlices}` : '—';
    const stateLabel =
      this.pausePending && status.state !== 'paused'
        ? `${status.state} (pause requested)`
        : status.state;

    write(`
\x1b[1m  Pipeline Status\x1b[0m
  Session:   ${status.sessionId}
  State:     ${stateLabel}
  Stage:     ${status.currentStage} (${status.currentStageIndex + 1}/${status.totalStages})
  Slice:     ${sliceLabel}
  Findings:  ${status.findingsTotal} total (${status.findingsOpen} open, ${status.findingsFixed} fixed)
  Commits:   ${status.commits}
  Elapsed:   ${elapsed}
  Pending:   ${status.pendingContextEntries} context entr${status.pendingContextEntries === 1 ? 'y' : 'ies'}
`);
  }

  private completeInput(line: string): [string[], string] {
    const trimmed = line.trimStart();
    if (!trimmed) {
      return [TOP_LEVEL_COMPLETIONS, line];
    }

    if (/^(?:skip|skip stage)\s+/i.test(trimmed)) {
      const completions = this.engine
        .listStageNames()
        .map((stageName) => `skip ${stageName}`)
        .filter((completion) => completion.toLowerCase().startsWith(trimmed.toLowerCase()));
      return [completions, line];
    }

    if (/^(?:prioritize|bump|escalate)(?:\s+finding)?\s+/i.test(trimmed)) {
      const completions = this.engine
        .listOpenFindingIds()
        .map((findingId) => `prioritize ${findingId}`)
        .filter((completion) => completion.toLowerCase().startsWith(trimmed.toLowerCase()));
      return [completions, line];
    }

    const completions = TOP_LEVEL_COMPLETIONS.filter((completion) =>
      completion.toLowerCase().startsWith(trimmed.toLowerCase()),
    );
    return [completions.length > 0 ? completions : TOP_LEVEL_COMPLETIONS, line];
  }

  private updatePromptState(event: ProgressEvent): void {
    const details = event.details ?? {};
    const stageCost = details['costUsd'];
    const totalCost = details['totalCostUsd'];

    if (typeof totalCost === 'number' && totalCost > 0) {
      this.latestCostUsd = totalCost;
    } else if (typeof stageCost === 'number' && stageCost > 0) {
      this.latestCostUsd = stageCost;
    }

    if (
      event.type === 'stage-progress' &&
      event.stage === 'interactive' &&
      event.message.startsWith('Pipeline paused')
    ) {
      this.pausePending = false;
    }

    if (event.type === 'session-complete') {
      this.pausePending = false;
    }

    if (this.latestStatus?.state === 'paused') {
      this.pausePending = false;
    }
  }

  private startSpinner(): void {
    if (this.spinnerTimer || process.stdout.isTTY === false) {
      return;
    }

    this.spinnerTimer = setInterval(() => {
      if (!this.shouldSpin()) {
        return;
      }

      this.spinnerFrameIndex = (this.spinnerFrameIndex + 1) % SPINNER_FRAMES.length;
      this.redrawPrompt();
    }, 120);
  }

  private stopSpinner(): void {
    if (!this.spinnerTimer) {
      return;
    }

    clearInterval(this.spinnerTimer);
    this.spinnerTimer = null;
  }

  private shouldSpin(): boolean {
    const state = this.latestStatus?.state;
    return (
      this.running &&
      !this.questionActive &&
      !this.promptSuspended &&
      state != null &&
      state !== 'paused' &&
      state !== 'completed' &&
      state !== 'failed'
    );
  }

  private redrawPrompt(): void {
    if (!this.rl || !this.running || this.questionActive || this.promptSuspended) {
      return;
    }

    this.rl.setPrompt(this.buildPrompt());

    if (process.stdout.isTTY !== false) {
      clearLine(process.stdout, 0);
      cursorTo(process.stdout, 0);
    }

    this.rl.prompt(true);
  }

  private buildPrompt(): string {
    if (!this.latestStatus) {
      return `${BASE_PROMPT}> `;
    }

    const parts: string[] = [];
    if (this.latestStatus.state === 'paused') {
      parts.push('paused');
    } else if (this.pausePending) {
      parts.push('pause pending');
    } else if (this.latestStatus.state === 'completed') {
      parts.push('complete');
    } else if (this.latestStatus.state === 'failed') {
      parts.push('failed');
    } else {
      parts.push(SPINNER_FRAMES[this.spinnerFrameIndex] ?? '-');
    }

    parts.push(
      `${truncate(this.latestStatus.currentStage, 24)} ${this.latestStatus.currentStageIndex + 1}/${this.latestStatus.totalStages}`,
    );

    if (this.latestStatus.totalSlices > 0) {
      parts.push(`slice ${this.latestStatus.currentSlice + 1}/${this.latestStatus.totalSlices}`);
    }

    parts.push(`${this.latestStatus.findingsOpen} open`);

    if (this.latestStatus.pendingContextEntries > 0) {
      parts.push(`${this.latestStatus.pendingContextEntries} ctx`);
    }

    if (this.latestCostUsd > 0) {
      parts.push(`$${this.latestCostUsd.toFixed(2)}`);
    }

    return `${BASE_PROMPT}[${parts.join(' | ')}]> `;
  }

  private async loadHistory(): Promise<void> {
    if (!this.historyFilePath || !this.rl) {
      return;
    }

    try {
      const raw = await readFile(this.historyFilePath, 'utf-8');
      const entries = raw
        .split('\n')
        .map((entry) => entry.trim())
        .filter(Boolean)
        .slice(-HISTORY_LIMIT);
      this.rl.history = [...entries].reverse();
    } catch {
      // No existing history yet.
    }
  }

  private async persistCurrentHistory(): Promise<void> {
    if (!this.rl) {
      return;
    }

    await this.persistHistory([...this.rl.history]);
  }

  private async persistHistory(history: string[]): Promise<void> {
    if (!this.historyFilePath) {
      return;
    }

    const normalized = [...history]
      .filter((entry) => entry.trim().length > 0)
      .reverse()
      .slice(-HISTORY_LIMIT);

    try {
      await writeFileAtomic(
        this.historyFilePath,
        normalized.length > 0 ? `${normalized.join('\n')}\n` : '',
      );
    } catch {
      // Best-effort persistence only.
    }
  }
}

function write(msg: string): void {
  process.stdout.write(msg);
}

function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remainingSeconds}s`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${remainingMinutes}m`;
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}
