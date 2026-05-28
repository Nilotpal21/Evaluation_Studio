/**
 * Pipeline Execution Service
 *
 * Core orchestration engine that reads a pipeline definition, selects the
 * matching flow, and executes stages sequentially using registered providers.
 *
 * This replaces the hardcoded worker chain with configurable, provider-based
 * execution driven by the pipeline definition stored in MongoDB.
 *
 * Flow:
 * 1. Load pipeline definition for knowledge base
 * 2. Select matching flow via FlowSelectionService
 * 3. For each stage in the flow:
 *    a. Evaluate executionCondition (skip if false)
 *    b. Resolve provider from ProviderRegistry
 *    c. Execute provider with config (circuit breaker protected)
 *    d. On error: try fallback provider or apply onError strategy
 * 4. Return aggregated results
 *
 * Reference: docs/searchai/pipelines/RFC-004-FLOW-BASED-ARCHITECTURE.md
 */

import type {
  ISearchPipelineDefinition,
  ISearchPipelineFlow,
  ISearchPipelineStage,
} from '@agent-platform/database';
import { ProviderRegistry } from '../provider-registry/provider-registry.js';
import { ProviderNotFoundError, ProviderExecutionError } from '../provider-registry/types.js';
import { FlowSelectionService } from '../flow-selection/flow-selection.service.js';
import { createLogger } from '@abl/compiler/platform';

const logger = createLogger('pipeline-execution');

// ─── Types ──────────────────────────────────────────────────────────────

export interface PipelineExecutionContext {
  tenantId: string;
  indexId: string;
  documentId: string;
  sourceId: string;
  /** Document metadata for flow selection */
  document: {
    name: string;
    extension: string;
    mimeType: string;
    size: number;
  };
  /** Source metadata for flow selection */
  source: {
    connector: string;
  };
}

export interface StageInput {
  documentId: string;
  content: string;
  contentType?: string;
  metadata?: Record<string, unknown>;
  /** Chunks from a chunking stage */
  chunks?: string[];
}

export interface StageResult {
  stageId: string;
  stageName: string;
  stageType: string;
  providerId: string;
  success: boolean;
  skipped: boolean;
  usedFallback: boolean;
  durationMs: number;
  error?: string;
  output?: unknown;
}

export interface PipelineExecutionResult {
  success: boolean;
  flowId: string;
  flowName: string;
  stageResults: StageResult[];
  totalDurationMs: number;
  error?: string;
}

// ─── CEL Evaluation ─────────────────────────────────────────────────────

/**
 * Evaluate a CEL execution condition.
 *
 * @param condition - CEL expression string
 * @param context - Execution context with document/source metadata
 * @returns true if condition passes (stage should execute), false to skip
 */
async function evaluateExecutionCondition(
  condition: string,
  context: PipelineExecutionContext,
): Promise<boolean> {
  if (!condition || condition.trim().length === 0) {
    return true; // No condition = always execute
  }

  try {
    const { Environment } = await import('@marcbachmann/cel-js');
    const env = new Environment({ unlistedVariablesAreDyn: true });

    const celContext = {
      document: context.document,
      source: context.source,
    };

    const result = env.evaluate(condition, celContext as unknown as Record<string, unknown>);

    if (typeof result !== 'boolean') {
      logger.warn('Execution condition returned non-boolean, treating as true', {
        condition,
        resultType: typeof result,
      });
      return true;
    }

    return result;
  } catch (error) {
    logger.error('Execution condition evaluation failed, treating as true (fail-open)', {
      condition,
      error: error instanceof Error ? error.message : String(error),
    });
    // Fail-open: if condition can't be evaluated, execute the stage
    return true;
  }
}

// ─── Pipeline Execution Service ─────────────────────────────────────────

export class PipelineExecutionService {
  private readonly providerRegistry: ProviderRegistry;
  private readonly flowSelection: FlowSelectionService;

  constructor() {
    this.providerRegistry = ProviderRegistry.getInstance();
    this.flowSelection = new FlowSelectionService();
  }

  /**
   * Execute a pipeline for a document.
   *
   * @param pipeline - Pipeline definition from MongoDB
   * @param context - Execution context (document metadata, tenant, etc.)
   * @param initialInput - Initial input data (extracted content)
   * @returns Execution result with per-stage results
   */
  async execute(
    pipeline: ISearchPipelineDefinition,
    context: PipelineExecutionContext,
    initialInput: StageInput,
  ): Promise<PipelineExecutionResult> {
    const startTime = Date.now();

    logger.info('Starting pipeline execution', {
      pipelineId: pipeline._id,
      pipelineVersion: pipeline.version,
      documentId: context.documentId,
      tenantId: context.tenantId,
    });

    // Step 1: Select flow
    const flowResult = await this.flowSelection.selectFlow(pipeline.flows, {
      document: context.document,
      source: context.source,
    });

    if (!flowResult.success || !flowResult.flow) {
      const totalDurationMs = Date.now() - startTime;
      return {
        success: false,
        flowId: '',
        flowName: '',
        stageResults: [],
        totalDurationMs,
        error: flowResult.error ?? 'No matching flow found',
      };
    }

    const flow = flowResult.flow;

    logger.info('Flow selected', {
      flowId: flow.id,
      flowName: flow.name,
      stageCount: flow.stages.length,
    });

    // Step 2: Execute stages sequentially
    // Track skip-until state: when a custom stage (webhook/script) has
    // mode='replacement' + entryPoint, stages between it and the entry point are skipped.
    const stageResults: StageResult[] = [];
    let currentInput = initialInput;
    let skipUntilType: string | null = null;

    for (const stage of flow.stages) {
      // Check if this stage should be skipped due to a previous custom stage's entryPoint
      if (skipUntilType && stage.type !== skipUntilType) {
        stageResults.push({
          stageId: stage.id,
          stageName: stage.name,
          stageType: stage.type,
          providerId: stage.provider,
          success: true,
          skipped: true,
          usedFallback: false,
          durationMs: 0,
        });
        logger.info('Stage auto-skipped (custom API entryPoint routing)', {
          stageId: stage.id,
          stageName: stage.name,
          skipUntilType,
        });
        continue;
      }
      if (skipUntilType && stage.type === skipUntilType) {
        skipUntilType = null; // Reached the entry point, stop skipping
      }

      const stageResult = await this.executeStage(stage, context, currentInput);
      stageResults.push(stageResult);

      // After a custom stage executes, check if it sets skip routing
      if (!stageResult.skipped && stageResult.success) {
        const config = stage.providerConfig as Record<string, unknown>;
        const isCustomProvider = stage.provider === 'http-webhook';
        const mode = config?.mode as string | undefined;
        const entryPoint = config?.entryPoint as string | undefined;

        if (isCustomProvider && mode === 'replacement' && entryPoint) {
          const entryTypeMap: Record<string, string> = {
            'after-extraction': 'chunking',
            'after-chunking': 'content-intelligence',
            'after-enrichment': 'embedding',
          };
          const target = entryTypeMap[entryPoint];
          if (target) {
            skipUntilType = target;
            logger.info('Custom stage sets skip routing', {
              stageId: stage.id,
              entryPoint,
              skipUntilType: target,
            });
          }
        }

        // Handle merge-chunks-to-text for source mode + chunks output + before-extraction entry
        if (
          isCustomProvider &&
          mode === 'source' &&
          config?.outputType === 'chunks' &&
          entryPoint === 'before-extraction'
        ) {
          const output = stageResult.output as Record<string, unknown> | undefined;
          if (output?.chunks && Array.isArray(output.chunks)) {
            const mergedText = (output.chunks as Array<{ content?: string }>)
              .map((c) => (typeof c === 'string' ? c : (c.content ?? '')))
              .join('\n\n');
            currentInput = { ...currentInput, content: mergedText };
            logger.info('Merged chunks to text for re-extraction', {
              stageId: stage.id,
              chunkCount: (output.chunks as unknown[]).length,
              mergedLength: mergedText.length,
            });
            continue; // Skip the normal output handling below
          }
        }
      }

      if (!stageResult.success && !stageResult.skipped) {
        // Stage failed — check onError strategy
        if (stage.onError === 'continue') {
          logger.warn('Stage failed but onError=continue, proceeding', {
            stageId: stage.id,
            stageName: stage.name,
            error: stageResult.error,
          });
          continue;
        }

        // onError=fail (default) — stop pipeline
        const totalDurationMs = Date.now() - startTime;
        logger.error('Pipeline execution failed at stage', {
          stageId: stage.id,
          stageName: stage.name,
          error: stageResult.error,
        });

        return {
          success: false,
          flowId: flow.id,
          flowName: flow.name,
          stageResults,
          totalDurationMs,
          error: `Stage '${stage.name}' failed: ${stageResult.error}`,
        };
      }

      // Pass stage output as input to next stage (if output exists)
      if (stageResult.output && !stageResult.skipped) {
        const output = stageResult.output as Record<string, unknown>;
        if (output.content && typeof output.content === 'string') {
          currentInput = { ...currentInput, content: output.content };
        }
        if (output.chunks && Array.isArray(output.chunks)) {
          currentInput = { ...currentInput, chunks: output.chunks as string[] };
        }
        if (output.metadata && typeof output.metadata === 'object') {
          currentInput = {
            ...currentInput,
            metadata: { ...currentInput.metadata, ...(output.metadata as Record<string, unknown>) },
          };
        }
      }
    }

    const totalDurationMs = Date.now() - startTime;

    logger.info('Pipeline execution completed', {
      pipelineId: pipeline._id,
      flowId: flow.id,
      flowName: flow.name,
      totalStages: flow.stages.length,
      executedStages: stageResults.filter((r) => !r.skipped).length,
      skippedStages: stageResults.filter((r) => r.skipped).length,
      failedStages: stageResults.filter((r) => !r.success && !r.skipped).length,
      totalDurationMs,
    });

    return {
      success: true,
      flowId: flow.id,
      flowName: flow.name,
      stageResults,
      totalDurationMs,
    };
  }

  /**
   * Execute a single pipeline stage.
   */
  private async executeStage(
    stage: ISearchPipelineStage,
    context: PipelineExecutionContext,
    input: StageInput,
  ): Promise<StageResult> {
    const startTime = Date.now();

    // Step 1: Evaluate execution condition
    if (stage.executionCondition) {
      const shouldExecute = await evaluateExecutionCondition(stage.executionCondition, context);

      if (!shouldExecute) {
        logger.info('Stage skipped (execution condition false)', {
          stageId: stage.id,
          stageName: stage.name,
          condition: stage.executionCondition,
        });

        return {
          stageId: stage.id,
          stageName: stage.name,
          stageType: stage.type,
          providerId: stage.provider,
          success: true,
          skipped: true,
          usedFallback: false,
          durationMs: Date.now() - startTime,
        };
      }
    }

    // Step 2: Resolve and execute provider
    const providersToTry = [stage.provider];
    if (stage.fallbackProvider) {
      providersToTry.push(stage.fallbackProvider);
    }

    for (let i = 0; i < providersToTry.length; i++) {
      const providerId = providersToTry[i];
      const isUsingFallback = i > 0;
      const config = isUsingFallback
        ? (stage.fallbackConfig ?? stage.providerConfig)
        : stage.providerConfig;

      try {
        const provider = this.providerRegistry.get(stage.type, providerId);

        logger.info('Executing stage provider', {
          stageId: stage.id,
          stageName: stage.name,
          providerId,
          isUsingFallback,
        });

        const output = await provider.execute(input, config);

        return {
          stageId: stage.id,
          stageName: stage.name,
          stageType: stage.type,
          providerId,
          success: true,
          skipped: false,
          usedFallback: isUsingFallback,
          durationMs: Date.now() - startTime,
          output,
        };
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);

        if (i < providersToTry.length - 1) {
          logger.warn('Provider failed, trying fallback', {
            stageId: stage.id,
            providerId,
            fallbackProviderId: providersToTry[i + 1],
            error: errMsg,
          });
          continue;
        }

        // All providers failed
        return {
          stageId: stage.id,
          stageName: stage.name,
          stageType: stage.type,
          providerId,
          success: false,
          skipped: false,
          usedFallback: isUsingFallback,
          durationMs: Date.now() - startTime,
          error: errMsg,
        };
      }
    }

    // Should not reach here
    return {
      stageId: stage.id,
      stageName: stage.name,
      stageType: stage.type,
      providerId: stage.provider,
      success: false,
      skipped: false,
      usedFallback: false,
      durationMs: Date.now() - startTime,
      error: 'No providers available',
    };
  }
}
