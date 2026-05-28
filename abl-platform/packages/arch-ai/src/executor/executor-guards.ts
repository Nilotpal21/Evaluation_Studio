import { createLogger } from '@agent-platform/shared-observability';
import { LoopDetector } from '../coordinator/loop-detection.js';

const log = createLogger('arch-ai:executor-guards');

export interface ExecutorGuardConfig {
  /** Max time to wait for first token from LLM (ms). Default: 10000 */
  ttftTimeoutMs: number;
  /** Max time with no output before declaring stall (ms). Default: 15000 */
  stallTimeoutMs: number;
  /** Max total time for one specialist turn (ms). Default: 120000 */
  turnTimeoutMs: number;
  /** Max LLM re-invocations per turn. Default: 200 */
  maxTurns: number;
  /** Max time for a single tool execution (ms). Default: 30000 */
  toolTimeoutMs: number;
}

export const DEFAULT_GUARD_CONFIG: ExecutorGuardConfig = {
  ttftTimeoutMs: 60_000,
  stallTimeoutMs: 20_000,
  turnTimeoutMs: 300_000,
  maxTurns: 300,
  toolTimeoutMs: 45_000,
};

export class ExecutorGuards {
  private turnStart = 0;
  private lastActivity = 0;
  private firstTokenReceived = false;
  private turnCount = 0;
  private readonly loopDetector: LoopDetector;
  private readonly config: ExecutorGuardConfig;

  constructor(config: Partial<ExecutorGuardConfig> = {}) {
    this.config = { ...DEFAULT_GUARD_CONFIG, ...config };
    this.loopDetector = new LoopDetector();

    // Validate timeout ordering — misconfigurations can cause guards to misbehave
    if (this.config.ttftTimeoutMs > this.config.stallTimeoutMs) {
      log.warn('TTFT timeout exceeds stall timeout — guards may not behave as expected', {
        ttft: this.config.ttftTimeoutMs,
        stall: this.config.stallTimeoutMs,
      });
    }
    if (this.config.stallTimeoutMs > this.config.turnTimeoutMs) {
      log.warn('Stall timeout exceeds turn timeout — guards may not behave as expected', {
        stall: this.config.stallTimeoutMs,
        turn: this.config.turnTimeoutMs,
      });
    }
  }

  startTurn(): void {
    this.turnStart = Date.now();
    this.lastActivity = Date.now();
    this.firstTokenReceived = false;
    this.turnCount = 0;
    this.loopDetector.reset();
  }

  onActivity(): void {
    this.lastActivity = Date.now();
    this.firstTokenReceived = true;
  }

  checkReInvocation(): string | null {
    this.turnCount++;
    if (this.turnCount > this.config.maxTurns) {
      return `Max turns exceeded (${this.config.maxTurns}). Stopping to prevent runaway loop.`;
    }
    const elapsed = Date.now() - this.turnStart;
    if (elapsed > this.config.turnTimeoutMs) {
      return `Turn timeout exceeded (${this.config.turnTimeoutMs}ms). Stopping.`;
    }
    return null;
  }

  checkToolCall(
    specialist: string,
    toolName: string,
    input: Record<string, unknown>,
  ): string | null {
    const isLoop = this.loopDetector.check(specialist, toolName, input);
    if (isLoop) {
      return `Loop detected: ${toolName} called 5 times with same input. Stopping.`;
    }
    return null;
  }

  checkTTFT(): string | null {
    if (this.firstTokenReceived) return null;
    const elapsed = Date.now() - this.turnStart;
    if (elapsed >= this.config.ttftTimeoutMs) {
      return `No response from LLM within ${this.config.ttftTimeoutMs}ms (TTFT timeout).`;
    }
    return null;
  }

  checkStall(): string | null {
    if (!this.firstTokenReceived) return null;
    const sinceLast = Date.now() - this.lastActivity;
    if (sinceLast > this.config.stallTimeoutMs) {
      return `No output for ${this.config.stallTimeoutMs}ms (stall detected).`;
    }
    return null;
  }

  async executeWithTimeout<T>(fn: () => Promise<T>, label: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new Error(`Tool execution timeout: ${label} exceeded ${this.config.toolTimeoutMs}ms`),
          ),
        this.config.toolTimeoutMs,
      );
      fn()
        .then((result) => {
          clearTimeout(timer);
          resolve(result);
        })
        .catch((err: unknown) => {
          clearTimeout(timer);
          reject(err);
        });
    });
  }
}
