/**
 * Shared test fixtures for cross-provider quorum convergence tests.
 *
 * Phase 1: makeFakeOpenAiClient + COST_ATTRIBUTION_FIXTURE.
 * Phase 2 (Commit 2.C): PLAN_A/B/C_FIXTURE, DIVERGENCE_NOTES_FIXTURE,
 *   makeFakeClaudeSdk, makeFakeCodexSpawner.
 */

import type { OpenAiClientLike, OpenAiStreamChunkLike } from '../../models/openai-api-executor.js';
import type {
  ExecutorResult,
  ModelAssignment,
  ModelEngine,
  ModelExecutor,
  ModelSpec,
  PlanArtifact,
  StageOutputSchemaConfig,
  StreamEvent,
} from '../../types.js';

// ─── Fake OpenAI Client Factory ────────────────────────────────

export interface FakeOpenAiClientOptions {
  /**
   * Custom handler for chat.completions.create.
   * When provided, overrides the default response behavior.
   */
  chatCompletionsCreate?: (
    args: Record<string, unknown>,
  ) => Promise<Record<string, unknown> | AsyncIterable<OpenAiStreamChunkLike>>;

  /**
   * If true or an object, the client will throw on create().
   * If an object, { code, statusCode } are used to build the error.
   */
  shouldFail?: boolean | { code: string; statusCode?: number };

  /**
   * When true, records all calls to chat.completions.create
   * in the returned client's `_calls` array.
   */
  trackCalls?: boolean;
}

export interface FakeOpenAiClientLike extends OpenAiClientLike {
  _calls: Array<{ args: Record<string, unknown> }>;
}

export function makeFakeOpenAiClient(opts: FakeOpenAiClientOptions = {}): FakeOpenAiClientLike {
  const calls: Array<{ args: Record<string, unknown> }> = [];

  const client: FakeOpenAiClientLike = {
    _calls: calls,
    chat: {
      completions: {
        async create(
          params: Record<string, unknown>,
        ): Promise<Record<string, unknown> | AsyncIterable<OpenAiStreamChunkLike>> {
          if (opts.trackCalls) {
            calls.push({ args: { ...params } });
          }

          if (opts.shouldFail) {
            const failConfig =
              typeof opts.shouldFail === 'object' ? opts.shouldFail : { code: 'test_error' };
            const err = new Error(failConfig.code) as Error & {
              status?: number;
              code?: string;
            };
            err.code = failConfig.code;
            if (failConfig.statusCode != null) {
              err.status = failConfig.statusCode;
            }
            throw err;
          }

          if (opts.chatCompletionsCreate) {
            return opts.chatCompletionsCreate(params);
          }

          // Default: check if streaming was requested
          const isStreaming = params['stream'] === true;
          if (isStreaming) {
            return defaultStreamingResponse();
          }
          return defaultNonStreamingResponse();
        },
      },
    },
  };

  return client;
}

function defaultNonStreamingResponse(): Record<string, unknown> {
  return {
    id: 'chatcmpl-test-default',
    choices: [
      {
        message: { content: '{"summary":"test","findings":[],"decisions":[]}', refusal: null },
        finish_reason: 'stop',
      },
    ],
    usage: {
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 150,
      completion_tokens_details: { reasoning_tokens: 0 },
    },
  };
}

async function* defaultStreamingResponse(): AsyncIterable<OpenAiStreamChunkLike> {
  yield {
    id: 'chatcmpl-test-stream',
    choices: [{ delta: { content: '{"summary":"test",' }, finish_reason: null }],
  };
  yield {
    id: 'chatcmpl-test-stream',
    choices: [{ delta: { content: '"findings":[],' }, finish_reason: null }],
  };
  yield {
    id: 'chatcmpl-test-stream',
    choices: [{ delta: { content: '"decisions":[]}' }, finish_reason: 'stop' }],
  };
  yield {
    id: 'chatcmpl-test-stream',
    usage: {
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 150,
      completion_tokens_details: { reasoning_tokens: 0 },
    },
  };
}

// ─── Cost Attribution Fixture ──────────────────────────────────

/**
 * Sample costByProvider shape used across pipeline-engine.test.ts
 * (INT-5 cost-accumulator assertions, UT-8b 9-call-site coverage guard)
 * and oracle-constellation.test.ts (INT-3 mixed-engine cost attribution).
 */
export const COST_ATTRIBUTION_FIXTURE: Record<string, { totalUsd: number; callCount: number }> = {
  'claude-code:opus': { totalUsd: 0.42, callCount: 3 },
  'openai-api:gpt-5': { totalUsd: 0.18, callCount: 1 },
  'codex-cli:gpt-5.5': { totalUsd: 0.05, callCount: 1 },
  'claude-code:claude-sonnet-4-6': { totalUsd: 0.02, callCount: 1 },
};

// ─── Phase 2: Plan Fixtures ──────────────────────────────────

export const PLAN_A_FIXTURE: PlanArtifact = {
  output: JSON.stringify({
    summary: 'Plan A: Extract shared seam first, then fix consumer routes.',
    slices: [
      {
        title: 'Extract validation to shared boundary',
        description: 'Move validation from consumer route to shared seam module',
        findings: ['finding-seam-001'],
        files: ['src/shared/validation.ts'],
        tests: ['src/shared/validation.test.ts'],
        dependencies: [],
        legacyPaths: [],
      },
    ],
  }),
  costUsd: 0.35,
  engine: 'claude-code',
  model: 'claude-opus-4-7',
  capturedAt: '2026-04-19T10:00:00.000Z',
  durationMs: 5_000,
  turnsUsed: 3,
};

export const PLAN_B_FIXTURE: PlanArtifact = {
  output: JSON.stringify({
    summary: 'Plan B: Inline fix first, then extract common patterns.',
    slices: [
      {
        title: 'Inline fix consumer route',
        description: 'Apply the fix directly in the consumer route handler',
        findings: ['finding-seam-001'],
        files: ['src/routes/consumer.ts'],
        tests: ['src/routes/consumer.test.ts'],
        dependencies: [],
        legacyPaths: [],
      },
    ],
  }),
  costUsd: 0.28,
  engine: 'openai-api',
  model: 'gpt-5',
  capturedAt: '2026-04-19T10:00:05.000Z',
  durationMs: 4_500,
  turnsUsed: 2,
};

export const PLAN_C_FIXTURE: PlanArtifact = {
  output: JSON.stringify({
    summary: 'Plan C: Convergent — extract shared seam with inline consumer guard.',
    slices: [
      {
        title: 'Convergent slice combining both approaches',
        description: 'Extract shared seam and add inline guard as a transitional measure',
        findings: ['finding-seam-001'],
        files: ['src/shared/validation.ts', 'src/routes/consumer.ts'],
        tests: ['src/shared/validation.test.ts', 'src/routes/consumer.test.ts'],
        dependencies: [],
        legacyPaths: [],
      },
    ],
  }),
  costUsd: 0.15,
  engine: 'codex-cli',
  model: 'gpt-5.5',
  capturedAt: '2026-04-19T10:00:10.000Z',
  durationMs: 6_400,
  turnsUsed: 1,
};

export const DIVERGENCE_NOTES_FIXTURE =
  '## Divergence Notes\n\n' +
  '- **Ordering**: Plan A prefers extract-first; Plan B prefers inline-first. ' +
  'Plan C favors extract-first with an inline transitional guard.\n' +
  '- **Scope**: Plan A limits to shared boundary; Plan B touches consumer route. ' +
  'Plan C addresses both files.';

// ─── Phase 2: Fake Claude SDK ────────────────────────────────

export interface FakeClaudeSdkOptions {
  /**
   * The output string the fake executor will return.
   * Defaults to PLAN_A_FIXTURE.output.
   */
  output?: string;

  /** If set, the executor will return an error in ExecutorResult.error. */
  errorMessage?: string;

  /** costUsd to report on the result. */
  costUsd?: number;

  /** Model name to report. */
  model?: string;

  /** Track call count. */
  trackCalls?: boolean;
}

export interface FakeClaudeSdkResult {
  executor: ModelExecutor;
  callCount: () => number;
}

/**
 * Returns a fake ModelExecutor with engine 'claude-code' that can be
 * registered on a ModelRouter via registerExecutor().
 */
export function makeFakeClaudeSdk(opts: FakeClaudeSdkOptions = {}): FakeClaudeSdkResult {
  let calls = 0;

  const executor: ModelExecutor = {
    engine: 'claude-code' as ModelEngine,
    async isAvailable(): Promise<boolean> {
      return true;
    },
    async execute(
      _prompt: string,
      spec: ModelSpec,
      _tools?: string[],
      _onStream?: (event: StreamEvent) => void,
      _outputSchema?: StageOutputSchemaConfig,
      _timeoutMs?: number,
      _abortSignal?: AbortSignal,
    ): Promise<ExecutorResult> {
      calls++;
      if (opts.errorMessage) {
        return {
          output: '',
          model: opts.model ?? spec.model ?? 'claude-opus-4-7',
          engine: 'claude-code',
          turnsUsed: 1,
          durationMs: 100,
          error: opts.errorMessage,
        };
      }
      return {
        output: opts.output ?? PLAN_A_FIXTURE.output,
        model: opts.model ?? spec.model ?? 'claude-opus-4-7',
        engine: 'claude-code',
        turnsUsed: 3,
        durationMs: 5_000,
        costUsd: opts.costUsd ?? 0.35,
      };
    },
  };

  return {
    executor,
    callCount: () => calls,
  };
}

// ─── Phase 2: Fake Codex Spawner ─────────────────────────────

export interface FakeCodexSpawnerOptions {
  /**
   * The output string the fake codex executor will return.
   * Defaults to a valid plan-c-with-divergence JSON.
   */
  output?: string;

  /** If set, the executor will return an error in ExecutorResult.error. */
  errorMessage?: string;

  /** costUsd to report on the result. */
  costUsd?: number;

  /** Track call count. */
  trackCalls?: boolean;
}

export interface FakeCodexSpawnerResult {
  executor: ModelExecutor;
  callCount: () => number;
}

/**
 * Returns a fake ModelExecutor with engine 'codex-cli' that can be
 * registered on a ModelRouter via registerExecutor().
 *
 * Default output is a valid plan-c-with-divergence JSON envelope
 * combining PLAN_C_FIXTURE content + DIVERGENCE_NOTES_FIXTURE.
 */
export function makeFakeCodexSpawner(opts: FakeCodexSpawnerOptions = {}): FakeCodexSpawnerResult {
  let calls = 0;

  const defaultOutput = JSON.stringify({
    ...JSON.parse(PLAN_C_FIXTURE.output),
    divergenceNotes: DIVERGENCE_NOTES_FIXTURE,
  });

  const executor: ModelExecutor = {
    engine: 'codex-cli' as ModelEngine,
    async isAvailable(): Promise<boolean> {
      return true;
    },
    async execute(
      _prompt: string,
      spec: ModelSpec,
      _tools?: string[],
      _onStream?: (event: StreamEvent) => void,
      _outputSchema?: StageOutputSchemaConfig,
      _timeoutMs?: number,
      _abortSignal?: AbortSignal,
    ): Promise<ExecutorResult> {
      calls++;
      if (opts.errorMessage) {
        return {
          output: '',
          model: spec.model ?? 'gpt-5.5',
          engine: 'codex-cli',
          turnsUsed: 1,
          durationMs: 100,
          error: opts.errorMessage,
        };
      }
      return {
        output: opts.output ?? defaultOutput,
        model: spec.model ?? 'gpt-5.5',
        engine: 'codex-cli',
        turnsUsed: 1,
        durationMs: 6_400,
        costUsd: opts.costUsd ?? 0.15,
      };
    },
  };

  return {
    executor,
    callCount: () => calls,
  };
}
