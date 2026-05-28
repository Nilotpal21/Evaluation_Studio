import { createEmptyPipelineResult, isTerminalAction } from '@abl/compiler';
import type { GuardrailPipelineImpl } from '@abl/compiler';
import { createGuardrailPipeline } from './pipeline-factory.js';
import type {
  Guardrail,
  PipelinePolicy,
  GuardrailActionType,
  GuardrailContext,
} from '@abl/compiler';
import type { GuardrailPipelineResult } from '@abl/compiler';
import { createLogger } from '@abl/compiler/platform';

const log = createLogger('streaming-guardrail');

export interface StreamingEvalConfig {
  /** How to buffer: 'sentence' checks at sentence boundaries, 'chunk' checks every N chars */
  interval: 'token' | 'sentence' | 'chunk';
  /** Chunk size in chars (only used when interval='chunk') */
  chunkSize?: number;
  /** Force evaluation when unevaluated text has been buffered for this long */
  maxLatencyMs?: number;
  /** Whether to terminate stream on violation */
  earlyTermination?: boolean;
}

export interface StreamingEvalEvent {
  type: 'pass' | 'violation' | 'terminate' | 'retract';
  /** Content that was evaluated */
  evaluatedContent?: string;
  /** Violation details if type is 'violation' or 'terminate' */
  violation?: {
    guardrailName: string;
    action: GuardrailActionType;
    message: string;
  };
  /** Content to retract from already-streamed output */
  retractContent?: string;
}

/** Default chunk size in characters for chunk-based evaluation */
const DEFAULT_CHUNK_SIZE = 200;

/** Regex for detecting sentence boundaries in unevaluated content */
const SENTENCE_BOUNDARY_REGEX = /[.!?]\s/;

/**
 * Streaming guardrail evaluator -- checks content mid-stream at sentence boundaries.
 *
 * Buffers streaming tokens and evaluates guardrails when a sentence boundary
 * is detected (sentence mode) or when accumulated unevaluated content exceeds
 * a configurable chunk size (chunk mode).
 *
 * On terminal violations (block/escalate), the evaluator terminates the stream
 * and returns a 'terminate' event. Non-terminal violations (warn) produce a
 * 'violation' event without terminating. All pipeline errors fail-open.
 *
 * Usage:
 *   const evaluator = new StreamingGuardrailEvaluator(guardrails, config);
 *
 *   for await (const chunk of llmStream) {
 *     const event = await evaluator.evaluateChunk(chunk);
 *     if (event.type === 'terminate') { break; }
 *     if (event.type === 'retract') { sendSSE('retract', event.retractContent); }
 *   }
 *
 *   const finalResult = await evaluator.evaluateFinal();
 */
export class StreamingGuardrailEvaluator {
  private buffer: string = '';
  private evaluatedUpTo: number = 0;
  private config: StreamingEvalConfig;
  private guardrails: Guardrail[];
  private pipeline: GuardrailPipelineImpl;
  private terminated: boolean = false;
  private violationCount: number = 0;
  private policy?: PipelinePolicy;
  private context: GuardrailContext;
  private lastEvaluationAt: number = Date.now();

  constructor(
    guardrails: Guardrail[],
    config?: Partial<StreamingEvalConfig>,
    pipeline?: GuardrailPipelineImpl,
    policy?: PipelinePolicy,
    context?: GuardrailContext,
  ) {
    this.guardrails = guardrails;
    this.config = {
      interval: 'sentence',
      chunkSize: DEFAULT_CHUNK_SIZE,
      earlyTermination: true,
      ...config,
    };
    this.pipeline = pipeline ?? createGuardrailPipeline();
    this.policy = policy;
    this.context = context ?? {};
  }

  /**
   * Feed a chunk of streaming content. Returns an event if evaluation was triggered.
   */
  async evaluateChunk(chunk: string): Promise<StreamingEvalEvent> {
    if (this.terminated) {
      return { type: 'terminate' };
    }

    this.buffer += chunk;

    // Check if we should evaluate based on interval
    const shouldEvaluate = this.shouldEvaluateNow();
    if (!shouldEvaluate) {
      return { type: 'pass' };
    }

    // Evaluate only new content since last evaluation
    const contentToEvaluate = this.buffer.slice(this.evaluatedUpTo);
    try {
      const result = await this.pipeline.execute(
        this.guardrails,
        contentToEvaluate,
        'output',
        this.context,
        undefined,
        this.policy,
      );

      this.evaluatedUpTo = this.buffer.length;
      this.lastEvaluationAt = Date.now();

      if (!result.passed) {
        this.violationCount++;
        const violation = result.primaryViolation;

        if (this.config.earlyTermination && violation && isTerminalAction(violation.action)) {
          this.terminated = true;
          return {
            type: 'terminate',
            evaluatedContent: contentToEvaluate,
            violation: violation
              ? {
                  guardrailName: violation.name,
                  action: violation.action,
                  message: violation.message,
                }
              : undefined,
          };
        }

        // Non-terminal violation -- emit violation event
        return {
          type: 'violation',
          evaluatedContent: contentToEvaluate,
          violation: violation
            ? {
                guardrailName: violation.name,
                action: violation.action,
                message: violation.message,
              }
            : undefined,
        };
      }

      return { type: 'pass', evaluatedContent: contentToEvaluate };
    } catch (err) {
      // Fail-open: streaming guardrail errors don't block the stream
      log.warn('Streaming guardrail evaluation failed', {
        error: err instanceof Error ? err.message : String(err),
        bufferLength: this.buffer.length,
      });
      return { type: 'pass' };
    }
  }

  /**
   * Evaluate the complete accumulated content after streaming ends.
   * Runs the full pipeline on the entire response.
   */
  async evaluateFinal(): Promise<GuardrailPipelineResult> {
    if (this.terminated) {
      // Already terminated mid-stream -- run pipeline on accumulated buffer
      // to produce a proper result object
      try {
        const result = await this.pipeline.execute(
          this.guardrails,
          this.buffer,
          'output',
          this.context,
          undefined,
          this.policy,
        );
        return result;
      } catch (err) {
        log.warn('Final streaming guardrail evaluation failed (terminated path)', {
          error: err instanceof Error ? err.message : String(err),
        });
        return createEmptyPipelineResult();
      }
    }

    try {
      return await this.pipeline.execute(
        this.guardrails,
        this.buffer,
        'output',
        this.context,
        undefined,
        this.policy,
      );
    } catch (err) {
      log.warn('Final streaming guardrail evaluation failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      // Return a pass result on error (fail-open)
      return createEmptyPipelineResult();
    }
  }

  /** Get the current buffer content */
  getBuffer(): string {
    return this.buffer;
  }

  /** Get whether the evaluator has terminated the stream */
  isTerminated(): boolean {
    return this.terminated;
  }

  /** Get how many violations were detected */
  getViolationCount(): number {
    return this.violationCount;
  }

  /**
   * Determine if we should evaluate now based on the configured interval.
   */
  private shouldEvaluateNow(): boolean {
    const unevaluatedLength = this.buffer.length - this.evaluatedUpTo;
    if (unevaluatedLength <= 0) {
      return false;
    }

    if (this.config.interval === 'token') {
      return true;
    }

    if (this.config.interval === 'chunk') {
      return unevaluatedLength >= (this.config.chunkSize ?? DEFAULT_CHUNK_SIZE);
    }

    // Sentence mode: check if there's a sentence boundary in unevaluated content
    const unevaluated = this.buffer.slice(this.evaluatedUpTo);
    if (SENTENCE_BOUNDARY_REGEX.test(unevaluated)) {
      return true;
    }

    if (
      typeof this.config.maxLatencyMs === 'number' &&
      Number.isFinite(this.config.maxLatencyMs) &&
      this.config.maxLatencyMs > 0
    ) {
      return Date.now() - this.lastEvaluationAt >= this.config.maxLatencyMs;
    }

    return false;
  }
}
