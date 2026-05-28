/**
 * Evaluation Dispatcher
 *
 * Core orchestrator for the async evaluation pipeline:
 * 1. Subscribes to session.ended events from the event store
 * 2. Looks up project evaluation configuration
 * 3. Applies sampling to determine which evaluators to run
 * 4. Fans out to registered evaluators concurrently
 * 5. Emits evaluation results as platform events
 *
 * The dispatcher is backend-agnostic — it accepts interface providers for
 * configuration, conversation data, and event emission.
 *
 * IMPORTANT: In poll mode, the dispatcher queries events per tenant+project
 * pair provided by pollTargetProvider. It never performs cross-tenant wildcard
 * queries. This ensures strict tenant isolation.
 */

import { createLogger } from '@agent-platform/shared-observability';
import type { IEventEmitter } from '../interfaces/event-emitter.js';
import type { IEventReader } from '../interfaces/event-store.js';
import type { PlatformEvent } from '../schema/platform-event.js';
import type {
  IEvaluator,
  IEvaluationDispatcher,
  IEvaluationConfigProvider,
  IConversationProvider,
  EvaluationInput,
  DispatcherStats,
  EvaluatorConfig,
  SamplingConfig,
} from './interfaces.js';

const log = createLogger('eventstore:evaluation-dispatcher');

// =============================================================================
// CONSTANTS
// =============================================================================

/** Maximum number of registered evaluators to prevent unbounded memory growth */
const MAX_EVALUATORS = 100;

// =============================================================================
// CONFIGURATION
// =============================================================================

/**
 * Provides the set of tenant+project pairs to poll for session.ended events.
 * Required when pollIntervalMs > 0 to ensure tenant-scoped queries.
 */
export interface IPollTargetProvider {
  /** Returns the tenant+project pairs that have active evaluation configs */
  getActiveTargets(): Promise<Array<{ tenantId: string; projectId: string }>>;
}

export interface EvaluationDispatcherConfig {
  /** Event emitter for writing evaluation results */
  emitter: IEventEmitter;
  /** Event reader for fetching session trace events */
  reader: IEventReader;
  /** Provider for project evaluation configs */
  configProvider: IEvaluationConfigProvider;
  /** Provider for conversation messages */
  conversationProvider: IConversationProvider;
  /** Maximum concurrent evaluations per dispatch cycle */
  maxConcurrency?: number;
  /** Poll interval in ms for checking new events (0 = manual trigger only) */
  pollIntervalMs?: number;
  /**
   * Provider that returns tenant+project pairs to poll.
   * REQUIRED when pollIntervalMs > 0. Ensures tenant-scoped queries
   * instead of cross-tenant wildcard access.
   */
  pollTargetProvider?: IPollTargetProvider;
}

// =============================================================================
// IMPLEMENTATION
// =============================================================================

export class EvaluationDispatcher implements IEvaluationDispatcher {
  private evaluators = new Map<string, IEvaluator>();
  private stats: DispatcherStats = {
    evaluationsStarted: 0,
    evaluationsCompleted: 0,
    evaluationsFailed: 0,
    evaluationsSkipped: 0,
  };
  private running = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private readonly maxConcurrency: number;
  private readonly pollIntervalMs: number;

  constructor(private readonly config: EvaluationDispatcherConfig) {
    this.maxConcurrency = config.maxConcurrency ?? 5;
    this.pollIntervalMs = config.pollIntervalMs ?? 0;

    // Validate: poll mode requires a tenant-scoped target provider
    if (this.pollIntervalMs > 0 && !config.pollTargetProvider) {
      throw new Error(
        'EvaluationDispatcher: pollTargetProvider is required when pollIntervalMs > 0. ' +
          'Cross-tenant wildcard queries are not allowed.',
      );
    }
  }

  registerEvaluator(evaluator: IEvaluator): void {
    if (this.evaluators.size >= MAX_EVALUATORS && !this.evaluators.has(evaluator.name)) {
      log.warn('Evaluator registration rejected: max capacity reached', {
        evaluatorName: evaluator.name,
        maxEvaluators: MAX_EVALUATORS,
        currentSize: this.evaluators.size,
      });
      return;
    }
    this.evaluators.set(evaluator.name, evaluator);
  }

  async start(): Promise<void> {
    this.running = true;

    if (this.pollIntervalMs > 0) {
      this.pollTimer = setInterval(() => {
        this.pollAndProcess().catch((error: unknown) => {
          log.error('Poll cycle failed, will retry on next interval', {
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }, this.pollIntervalMs);
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  getStats(): DispatcherStats {
    return { ...this.stats };
  }

  /**
   * Process a single session.ended event.
   * Called by the poll loop or externally by an event handler.
   */
  async processSessionEnded(event: PlatformEvent): Promise<void> {
    if (!this.running) return;

    const { tenant_id: tenantId, project_id: projectId, session_id: sessionId } = event;
    if (!tenantId || !projectId || !sessionId) return;

    // 1. Load project evaluation config
    const projectConfig = await this.config.configProvider.getConfig(tenantId, projectId);
    if (!projectConfig || projectConfig.evaluators.length === 0) return;

    // 2. Apply global sampling
    if (projectConfig.globalSampling && !shouldSample(projectConfig.globalSampling)) {
      this.stats.evaluationsSkipped++;
      return;
    }

    // 3. Determine which evaluators to run
    const evaluatorsToRun = projectConfig.evaluators
      .filter((ec) => ec.enabled)
      .filter((ec) => this.evaluators.has(ec.evaluatorName))
      .filter((ec) => {
        const triggers = ec.triggerEvents ?? ['session.ended'];
        return triggers.includes(event.event_type);
      })
      .filter((ec) => {
        if (!ec.sampling) return true;
        return shouldSample(ec.sampling);
      });

    if (evaluatorsToRun.length === 0) {
      this.stats.evaluationsSkipped++;
      return;
    }

    // 4. Build evaluation input
    const input = await this.buildEvaluationInput(event);
    if (!input) return;

    // 5. Fan out to evaluators with concurrency limit
    const batchId = `batch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    let succeeded = 0;
    let failed = 0;
    let skipped = 0;
    const batchStart = Date.now();

    // Process in chunks of maxConcurrency
    for (let i = 0; i < evaluatorsToRun.length; i += this.maxConcurrency) {
      const chunk = evaluatorsToRun.slice(i, i + this.maxConcurrency);
      const results = await Promise.allSettled(
        chunk.map((ec) => this.runEvaluator(ec, input, tenantId, projectId)),
      );

      for (const result of results) {
        if (result.status === 'fulfilled') {
          if (result.value) succeeded++;
          else skipped++;
        } else {
          failed++;
        }
      }
    }

    // 6. Emit batch completion event
    this.config.emitter.emit({
      event_type: 'evaluation.batch.completed',
      tenant_id: tenantId,
      project_id: projectId,
      session_id: sessionId,
      known_source: input.knownSource ?? 'production',
      timestamp: new Date(),
      data: {
        batch_id: batchId,
        total_evaluations: evaluatorsToRun.length,
        succeeded,
        failed,
        skipped,
        total_duration_ms: Date.now() - batchStart,
        evaluator_names: evaluatorsToRun.map((e) => e.evaluatorName),
      },
    } as unknown);
  }

  // ─── Private helpers ────────────────────────────────────────────────────

  private async pollAndProcess(): Promise<void> {
    // Poll mode queries events per tenant+project pair — never cross-tenant.
    // The pollTargetProvider supplies the list of active evaluation targets.
    const provider = this.config.pollTargetProvider;
    if (!provider) {
      // Defensive: constructor validates this, but guard at runtime too
      log.error('Poll mode active but no pollTargetProvider configured — skipping cycle');
      return;
    }

    const now = new Date();
    const from = new Date(now.getTime() - this.pollIntervalMs * 2);

    let targets: Array<{ tenantId: string; projectId: string }>;
    try {
      targets = await provider.getActiveTargets();
    } catch (error: unknown) {
      log.error('Failed to fetch poll targets', {
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    for (const { tenantId, projectId } of targets) {
      try {
        const result = await this.config.reader.query({
          tenantId,
          projectId,
          timeRange: { from, to: now },
          eventTypes: ['session.ended'],
          limit: 50,
        });

        for (const event of result.events) {
          await this.processSessionEnded(event as PlatformEvent);
        }
      } catch (error: unknown) {
        log.error('Poll query failed for tenant+project pair, continuing with next', {
          tenantId,
          projectId,
          error: error instanceof Error ? error.message : String(error),
        });
        // Continue processing other targets — don't let one failure block all
      }
    }
  }

  private async buildEvaluationInput(event: PlatformEvent): Promise<EvaluationInput | null> {
    const { tenant_id: tenantId, project_id: projectId, session_id: sessionId } = event;
    if (!sessionId) return null;

    try {
      // Fetch conversation messages
      const messages = await this.config.conversationProvider.getMessages(tenantId, sessionId);

      // Fetch trace events for this session
      const now = new Date();
      const traceResult = await this.config.reader.query({
        tenantId,
        projectId,
        timeRange: { from: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000), to: now },
        sessionId,
        limit: 1000,
      });

      const sessionData = event.data as Record<string, unknown>;

      return {
        sessionId,
        tenantId,
        projectId,
        knownSource: event.known_source,
        agentName: event.agent_name,
        messages,
        traceEvents: traceResult.events as PlatformEvent[],
        sessionMetadata: {
          totalDurationMs: (sessionData.total_duration_ms as number) ?? 0,
          totalTurns: (sessionData.total_turns as number) ?? 0,
          totalLLMCalls: (sessionData.total_llm_calls as number) ?? 0,
          totalToolCalls: (sessionData.total_tool_calls as number) ?? 0,
          totalTokens: sessionData.total_tokens as number | undefined,
          estimatedCost: sessionData.estimated_cost as number | undefined,
          endReason: (sessionData.reason as string) ?? 'unknown',
        },
      };
    } catch (error: unknown) {
      log.error('Failed to build evaluation input', {
        sessionId,
        tenantId,
        projectId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private async runEvaluator(
    ec: EvaluatorConfig,
    input: EvaluationInput,
    tenantId: string,
    projectId: string,
  ): Promise<boolean> {
    const evaluator = this.evaluators.get(ec.evaluatorName);
    if (!evaluator) return false;

    const evaluationId = `eval-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    // Emit started event
    this.config.emitter.emit({
      event_type: 'evaluation.started',
      tenant_id: tenantId,
      project_id: projectId,
      session_id: input.sessionId,
      known_source: input.knownSource ?? 'production',
      timestamp: new Date(),
      data: {
        evaluation_id: evaluationId,
        evaluator_type: evaluator.type,
        evaluator_name: evaluator.name,
        target_session_id: input.sessionId,
      },
    } as unknown);

    this.stats.evaluationsStarted++;
    const start = Date.now();

    try {
      const output = await evaluator.evaluate(input);

      // Emit completed event
      this.config.emitter.emit({
        event_type: 'evaluation.completed',
        tenant_id: tenantId,
        project_id: projectId,
        session_id: input.sessionId,
        known_source: input.knownSource ?? 'production',
        timestamp: new Date(),
        duration_ms: output.latencyMs,
        data: {
          evaluation_id: evaluationId,
          evaluator_type: output.evaluatorType,
          evaluator_name: output.evaluatorName,
          target_session_id: input.sessionId,
          scores: Object.fromEntries(output.scores.map((s) => [s.name, s.value])),
          composite_score: output.compositeScore,
          reasoning: output.scores.find((s) => s.reasoning)?.reasoning,
          confidence: output.scores.find((s) => s.confidence !== undefined)?.confidence,
          latency_ms: output.latencyMs,
          model_used: output.modelUsed,
          tokens_used: output.tokensUsed,
          estimated_cost: output.estimatedCost,
        },
      } as unknown);

      this.stats.evaluationsCompleted++;
      return true;
    } catch (error) {
      // Emit failed event
      this.config.emitter.emit({
        event_type: 'evaluation.failed',
        tenant_id: tenantId,
        project_id: projectId,
        session_id: input.sessionId,
        known_source: input.knownSource ?? 'production',
        timestamp: new Date(),
        has_error: true,
        error_message: error instanceof Error ? error.message : String(error),
        data: {
          evaluation_id: evaluationId,
          evaluator_type: evaluator.type,
          evaluator_name: evaluator.name,
          target_session_id: input.sessionId,
          error_type: error instanceof Error ? error.constructor.name : 'UnknownError',
          error_message: error instanceof Error ? error.message : String(error),
          latency_ms: Date.now() - start,
        },
      } as unknown);

      this.stats.evaluationsFailed++;
      return false;
    }
  }
}

// =============================================================================
// SAMPLING HELPERS
// =============================================================================

function shouldSample(config: SamplingConfig): boolean {
  if (config.strategy === 'all' || config.rate >= 1) return true;
  if (config.rate <= 0) return false;
  return Math.random() < config.rate;
}
