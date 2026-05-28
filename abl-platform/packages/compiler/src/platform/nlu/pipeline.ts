/**
 * NLU Task Pipeline
 *
 * Generic pipeline that encodes the 5-step NLU fallback pattern:
 *   1. Plugin pre-process (short-circuit)
 *   2. Cache check
 *   3. Walk through ordered steps (embedding → fast LLM → balanced LLM → regex fallback)
 *   4. Plugin post-process
 *   5. Record metric + audit
 *
 * Each task module (intent, entity, category, etc.) creates its own
 * PipelineStep[] and plugs them into this generic executor.
 */

import type { NLUContext, NLUTask, NLULayer, NLUMetricsCollector } from './types.js';
import type { NLUPluginPipeline } from './plugins.js';
import { createLogger } from '../logger.js';

const log = createLogger('nlu-pipeline');

// =============================================================================
// PIPELINE STEP
// =============================================================================

/**
 * A single processing step in the NLU pipeline.
 * Steps are tried in order; the first to return a confident result wins.
 */
export interface PipelineStep<TResult> {
  name: string;
  layer: string;
  execute(ctx: NLUContext, input: unknown): Promise<TResult | null>;
}

// =============================================================================
// PIPELINE HOOKS
// =============================================================================

/**
 * Hooks for enterprise integration (PII, caching, circuit breaker, audit).
 * All hooks are optional — without them the pipeline runs at full speed.
 */
export interface PipelineHooks {
  /** Runs before pipeline execution (e.g., PII redaction) */
  beforeExecute?(ctx: NLUContext, task: NLUTask): Promise<NLUContext>;
  /** Runs after pipeline execution (e.g., audit logging) */
  afterExecute?(ctx: NLUContext, task: NLUTask, result: unknown, latencyMs: number): Promise<void>;
  /** Wraps each LLM call (e.g., circuit breaker) */
  wrapLLMCall?<T>(layerName: string, fn: () => Promise<T>): Promise<T | null>;
  /** Check for a cached result */
  checkCache?(ctx: NLUContext, task: NLUTask): Promise<unknown | null>;
  /** Store a result in the cache */
  storeCache?(ctx: NLUContext, task: NLUTask, result: unknown): Promise<void>;
}

// =============================================================================
// NLU TASK PIPELINE
// =============================================================================

export class NLUTaskPipeline<TResult> {
  private task: NLUTask;
  private steps: PipelineStep<TResult>[];
  private defaultResult: TResult;
  private plugins: NLUPluginPipeline;
  private metrics?: NLUMetricsCollector;
  private hooks?: PipelineHooks;
  private confidenceThreshold: number;

  constructor(
    task: NLUTask,
    steps: PipelineStep<TResult>[],
    defaultResult: TResult,
    plugins: NLUPluginPipeline,
    confidenceThreshold: number = 0.7,
    metrics?: NLUMetricsCollector,
    hooks?: PipelineHooks,
  ) {
    this.task = task;
    this.steps = steps;
    this.defaultResult = defaultResult;
    this.plugins = plugins;
    this.confidenceThreshold = confidenceThreshold;
    this.metrics = metrics;
    this.hooks = hooks;
  }

  async execute(ctx: NLUContext, input: unknown): Promise<TResult> {
    const startTime = Date.now();

    // 1. beforeExecute hook (PII redaction, context enrichment)
    let processedCtx = ctx;
    if (this.hooks?.beforeExecute) {
      processedCtx = await this.hooks.beforeExecute(ctx, this.task);
    }

    // 2. Cache check
    if (this.hooks?.checkCache) {
      const cached = await this.hooks.checkCache(processedCtx, this.task);
      if (cached !== null) {
        return cached as TResult;
      }
    }

    // 3. Plugin pre-process (short-circuit)
    const pluginResult = await this.plugins.preProcess(processedCtx, this.task);
    if (pluginResult) {
      const result = this.adaptPluginResult(pluginResult);
      if (result !== null) {
        await this.finalize(processedCtx, result, startTime);
        return result;
      }
    }

    // 4. Walk through pipeline steps
    for (const step of this.steps) {
      try {
        let result: TResult | null;

        if (this.hooks?.wrapLLMCall && (step.layer === 'fast' || step.layer === 'balanced')) {
          result = await this.hooks.wrapLLMCall<TResult>(
            step.layer,
            () => step.execute(processedCtx, input) as Promise<TResult>,
          );
        } else {
          result = await step.execute(processedCtx, input);
        }

        if (result !== null && this.isConfident(result)) {
          // Post-process via plugins
          const postProcessed = (await this.plugins.postProcess(
            processedCtx,
            this.task,
            result,
          )) as TResult;
          await this.finalize(processedCtx, postProcessed, startTime, step.layer);
          return postProcessed;
        }
      } catch (error) {
        log.warn(`Pipeline step "${step.name}" failed, continuing to next`, {
          step: step.name,
          layer: step.layer,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // 5. No step produced a confident result → return default
    const postProcessed = (await this.plugins.postProcess(
      processedCtx,
      this.task,
      this.defaultResult,
    )) as TResult;
    await this.finalize(processedCtx, postProcessed, startTime, 'fallback');
    return postProcessed;
  }

  /**
   * Adapt a plugin result to the task-specific result type.
   * Subclasses/callers can override via the adaptPluginResult provided to constructor.
   */
  private adaptPluginResult(pluginResult: unknown): TResult | null {
    if (pluginResult === null || pluginResult === undefined) return null;
    // If it's already the right shape (has expected result fields), use it directly
    if (typeof pluginResult === 'object') {
      return pluginResult as TResult;
    }
    return null;
  }

  private isConfident(result: TResult): boolean {
    const r = result as Record<string, unknown>;
    if ('confidence' in r && typeof r.confidence === 'number') {
      return r.confidence >= this.confidenceThreshold;
    }
    // For entity results, always return true (they don't have a single confidence)
    if ('values' in r) return true;
    // For correction results, check detected flag
    if ('detected' in r) return true;
    return false;
  }

  private async finalize(
    ctx: NLUContext,
    result: TResult,
    startTime: number,
    layer?: string,
  ): Promise<void> {
    const latencyMs = Date.now() - startTime;

    // Record metric
    if (this.metrics) {
      const r = result as Record<string, unknown>;
      this.metrics.recordPrediction({
        sessionId: ((ctx as unknown as Record<string, unknown>).sessionId as string) ?? '',
        timestamp: new Date(),
        task: this.task,
        input: ctx.userMessage,
        language: ctx.detectedLanguage || ctx.sessionLanguage || 'en',
        modelUsed: layer || 'unknown',
        layerUsed: (layer || 'fallback') as NLULayer,
        prediction: result,
        confidence: typeof r.confidence === 'number' ? r.confidence : 0,
        latencyMs,
      });
    }

    // Store in cache
    if (this.hooks?.storeCache) {
      await this.hooks.storeCache(ctx, this.task, result);
    }

    // afterExecute hook (audit logging)
    if (this.hooks?.afterExecute) {
      // Fire-and-forget to avoid blocking the response
      this.hooks.afterExecute(ctx, this.task, result, latencyMs).catch((err) => {
        log.error('afterExecute hook failed — audit record may be missing', {
          task: this.task,
          sessionId: ((ctx as unknown as Record<string, unknown>).sessionId as string) ?? 'unknown',
          latencyMs,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
  }
}
