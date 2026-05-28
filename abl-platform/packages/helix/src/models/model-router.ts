import type {
  ClaudeSettingSource,
  ExecutorResult,
  HelixMcpServerDefinition,
  ModelAssignment,
  ModelEngine,
  ModelExecutor,
  ModelSpec,
  StageOutputSchemaConfig,
  StreamEvent,
  WorkspaceExecutionContext,
} from '../types.js';
import { buildStageOutputInstructions } from '../pipeline/stage-output-schema.js';
import { AnthropicApiExecutor } from './anthropic-api-executor.js';
import { ClaudeSdkExecutor } from './claude-sdk-executor.js';
import { CodexCliExecutor } from './codex-cli-executor.js';
import { OpenAiApiExecutor } from './openai-api-executor.js';

export interface ModelRouterOptions {
  allowFallbacks?: boolean;
  claudeSettingSources?: ClaudeSettingSource[];
  mcpServers?: Record<string, HelixMcpServerDefinition>;
  workspaceContext?: WorkspaceExecutionContext;
}

/**
 * Routes stage execution to the appropriate model executor.
 *
 * Supports:
 * - Primary + fallback model selection
 * - Layered execution: primary produces, layered models refine
 * - Engine availability detection
 *
 * Design principle: Codex for deep code reading/implementation,
 * Claude for architecture/review/orchestration.
 */
export class ModelRouter {
  private readonly executors: Map<ModelEngine, ModelExecutor>;
  private readonly activeExecutionControllers = new Set<AbortController>();
  private readonly allowFallbacks: boolean;
  private workspaceContext?: WorkspaceExecutionContext;

  constructor(
    codexPath: string = 'codex',
    workDir: string = process.cwd(),
    options: ModelRouterOptions = {},
  ) {
    this.allowFallbacks = options.allowFallbacks ?? true;
    this.workspaceContext = options.workspaceContext;
    this.executors = new Map<ModelEngine, ModelExecutor>([
      [
        'claude-code',
        new ClaudeSdkExecutor(
          workDir,
          options.claudeSettingSources ?? [],
          options.mcpServers ?? {},
          options.workspaceContext,
        ),
      ],
      [
        'codex-cli',
        new CodexCliExecutor(
          codexPath,
          workDir,
          options.mcpServers ?? {},
          options.workspaceContext,
        ),
      ],
      ['claude-api', new AnthropicApiExecutor(workDir)],
      ['openai-api', new OpenAiApiExecutor(workDir)],
    ]);
  }

  setWorkspaceContext(workspaceContext?: WorkspaceExecutionContext): void {
    this.workspaceContext = workspaceContext;
    for (const executor of this.executors.values()) {
      executor.setWorkspaceContext?.(workspaceContext);
    }
  }

  /**
   * Execute a prompt using the model assignment strategy.
   *
   * 1. Try primary model
   * 2. If primary fails, try fallback
   * 3. If layered models exist, pass primary output through each layer
   */
  async execute(
    prompt: string,
    assignment: ModelAssignment,
    tools?: string[],
    onStream?: (event: StreamEvent) => void,
    outputSchema?: StageOutputSchemaConfig,
    timeoutMs?: number,
  ): Promise<ExecutorResult> {
    const deadlineAt = resolveDeadlineAt(timeoutMs);
    const abortController = new AbortController();
    this.activeExecutionControllers.add(abortController);

    try {
      // Step 1: Execute primary
      let result = await this.executeSpec(
        prompt,
        assignment.primary,
        tools,
        onStream,
        outputSchema,
        getRemainingTimeoutMs(deadlineAt),
        abortController.signal,
      );

      // Step 2: Fallback if primary failed
      if (result.error && assignment.fallback && this.allowFallbacks) {
        const remainingTimeoutMs = getRemainingTimeoutMs(deadlineAt);
        if (remainingTimeoutMs != null && remainingTimeoutMs <= 0) {
          return makeTimeoutResult(assignment.fallback, timeoutMs);
        }

        onStream?.({
          type: 'progress',
          timestamp: new Date().toISOString(),
          message: `Primary model failed, falling back to ${assignment.fallback.engine}/${assignment.fallback.model}`,
        });
        result = await this.executeSpec(
          prompt,
          assignment.fallback,
          tools,
          onStream,
          outputSchema,
          remainingTimeoutMs,
          abortController.signal,
        );
      }

      // Step 3: Layer additional models on top
      if (!result.error && assignment.layered && assignment.layered.length > 0) {
        for (const layerSpec of assignment.layered) {
          const remainingTimeoutMs = getRemainingTimeoutMs(deadlineAt);
          if (remainingTimeoutMs != null && remainingTimeoutMs <= 0) {
            return makeTimeoutResult(layerSpec, timeoutMs);
          }

          const layerPrompt = buildLayerPrompt(prompt, result.output, outputSchema);
          const layerResult = await this.executeSpec(
            layerPrompt,
            layerSpec,
            [],
            onStream,
            outputSchema,
            remainingTimeoutMs,
            abortController.signal,
          );

          if (!layerResult.error) {
            // Layer's output becomes the new result
            result = {
              ...layerResult,
              // Accumulate total cost and duration
              durationMs: result.durationMs + layerResult.durationMs,
              turnsUsed: result.turnsUsed + layerResult.turnsUsed,
              costUsd: (result.costUsd ?? 0) + (layerResult.costUsd ?? 0) || undefined,
            };
          } else {
            onStream?.({
              type: 'progress',
              timestamp: new Date().toISOString(),
              message: `Layer model ${layerSpec.engine}/${layerSpec.model} failed, using previous result`,
            });
          }
        }
      }

      return result;
    } finally {
      this.activeExecutionControllers.delete(abortController);
    }
  }

  abortActiveExecutions(): number {
    let aborted = 0;

    for (const controller of this.activeExecutionControllers) {
      if (controller.signal.aborted) {
        continue;
      }

      controller.abort();
      aborted += 1;
    }

    return aborted;
  }

  /**
   * Execute a single model spec.
   */
  private async executeSpec(
    prompt: string,
    spec: ModelSpec,
    tools?: string[],
    onStream?: (event: StreamEvent) => void,
    outputSchema?: StageOutputSchemaConfig,
    timeoutMs?: number,
    abortSignal?: AbortSignal,
  ): Promise<ExecutorResult> {
    const executor = this.executors.get(spec.engine);
    if (!executor) {
      return {
        output: '',
        model: spec.model ?? 'unknown',
        engine: spec.engine,
        turnsUsed: 0,
        durationMs: 0,
        error: `No executor registered for engine: ${spec.engine}`,
      };
    }

    const available = await executor.isAvailable();
    if (!available) {
      return {
        output: '',
        model: spec.model ?? 'unknown',
        engine: spec.engine,
        turnsUsed: 0,
        durationMs: 0,
        error: `Engine ${spec.engine} is not available. Is the CLI/SDK installed?`,
      };
    }

    return executor.execute(prompt, spec, tools, onStream, outputSchema, timeoutMs, abortSignal);
  }

  /**
   * Check which model engines are available.
   */
  async getAvailableEngines(): Promise<ModelEngine[]> {
    const available: ModelEngine[] = [];
    for (const [engine, executor] of this.executors) {
      if (await executor.isAvailable()) {
        available.push(engine);
      }
    }
    return available;
  }

  /**
   * Register an additional executor (e.g., for Claude API or OpenAI API).
   */
  registerExecutor(executor: ModelExecutor): void {
    executor.setWorkspaceContext?.(this.workspaceContext);
    this.executors.set(executor.engine, executor);
  }
}

function resolveDeadlineAt(timeoutMs?: number): number | undefined {
  if (timeoutMs == null || timeoutMs <= 0) {
    return undefined;
  }
  return Date.now() + timeoutMs;
}

function getRemainingTimeoutMs(deadlineAt?: number): number | undefined {
  if (deadlineAt == null) {
    return undefined;
  }
  return Math.max(deadlineAt - Date.now(), 0);
}

function makeTimeoutResult(spec: ModelSpec, timeoutMs?: number): ExecutorResult {
  const seconds =
    timeoutMs != null && timeoutMs > 0 ? `${Math.ceil(timeoutMs / 1000)}s` : 'its deadline';

  return {
    output: '',
    model: spec.model ?? 'unknown',
    engine: spec.engine,
    turnsUsed: 0,
    durationMs: 0,
    error: `Execution timed out after ${seconds}`,
  };
}

function buildLayerPrompt(
  originalPrompt: string,
  previousOutput: string,
  outputSchema?: StageOutputSchemaConfig,
): string {
  const parts = [
    'You are reviewing and refining the output of another AI model.',
    'This is a synthesis-only continuation pass. Do not use tools or restart discovery.',
    '',
    '## Original Task',
    originalPrompt,
    '',
    '## Previous Model Output',
    previousOutput,
    '',
    '## Your Task',
    'Review the output above for:',
    '1. Correctness — are there factual errors or wrong assumptions?',
    '2. Completeness — is anything missing?',
    '3. Consistency — does it align with the codebase and platform principles?',
    '4. Quality — can the code/plan be improved?',
    '',
    'Choose the lightest valid continuation:',
    '- Keep it as-is if it is already strong.',
    '- Tighten it by removing unnecessary exploration or scope drift.',
    '- Correct any factual or structural mistakes.',
    '- If some work should wait, keep only the immediate or next-step work in scope and defer the rest.',
    '',
    'Provide your refined version of the output, incorporating any improvements.',
    'Do not restart repo exploration. Work only from the task and the previous model output.',
  ];

  if (outputSchema) {
    parts.push('', buildStageOutputInstructions(outputSchema));
  }

  return parts.join('\n');
}
