import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { queryMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: queryMock,
}));

import { AnthropicApiExecutor } from '../models/anthropic-api-executor.js';
import { ModelRouter } from '../models/model-router.js';
import { OpenAiApiExecutor } from '../models/openai-api-executor.js';
import { makeFakeOpenAiClient } from './test-helpers/plan-fixtures.js';
import type {
  ExecutorResult,
  ModelEngine,
  ModelExecutor,
  ModelSpec,
  StageOutputSchemaConfig,
  StreamEvent,
} from '../types.js';

describe('ModelRouter', () => {
  beforeEach(() => {
    queryMock.mockReset();
  });

  it('shares a single timeout budget across fallback attempts', async () => {
    const observedTimeouts: number[] = [];
    const router = new ModelRouter('/nonexistent-codex', process.cwd());

    router.registerExecutor(
      createExecutor('codex-cli', async (_prompt, spec, _tools, _onStream, _schema, timeoutMs) => {
        observedTimeouts.push(timeoutMs ?? -1);
        await delay(40);
        return createResult(spec, 'primary failed', 'primary output');
      }),
    );

    router.registerExecutor(
      createExecutor(
        'claude-code',
        async (_prompt, spec, _tools, _onStream, _schema, timeoutMs) => {
          observedTimeouts.push(timeoutMs ?? -1);
          return createResult(spec, undefined, '{"summary":"ok","findings":[],"decisions":[]}');
        },
      ),
    );

    const result = await router.execute(
      'Audit this path',
      {
        primary: { engine: 'codex-cli', model: 'gpt-5.5' },
        fallback: { engine: 'claude-code', model: 'opus' },
      },
      ['Read'],
      undefined,
      { id: 'analysis-report' },
      120,
    );

    expect(result.error).toBeUndefined();
    expect(observedTimeouts).toHaveLength(2);
    expect(observedTimeouts[0]).toBeGreaterThan(0);
    expect(observedTimeouts[0]).toBeLessThanOrEqual(120);
    expect(observedTimeouts[1]).toBeGreaterThan(0);
    expect(observedTimeouts[1]).toBeLessThan(observedTimeouts[0]);
  });

  it('routes built-in Claude executions through the configured worktree cwd', async () => {
    let capturedOptions: Record<string, unknown> | undefined;

    queryMock.mockImplementation(({ options }: { options?: Record<string, unknown> }) => {
      capturedOptions = options;
      return createStream([
        {
          type: 'result',
          result: '{"summary":"ok","findings":[],"decisions":[]}',
        },
      ]);
    });

    const router = new ModelRouter('/nonexistent-codex', '/tmp/helix-bruce-worktree');
    const result = await router.execute(
      'Audit Bruce feedback scope',
      {
        primary: { engine: 'claude-code', model: 'claude-opus-4-7', maxTurns: 1 },
      },
      ['Read'],
      undefined,
      { id: 'analysis-report' },
    );

    expect(result.error).toBeUndefined();
    expect(capturedOptions?.['cwd']).toBe('/tmp/helix-bruce-worktree');
  });

  it('passes worktree guardrails into Claude review runs', async () => {
    let capturedOptions: Record<string, unknown> | undefined;

    queryMock.mockImplementation(({ options }: { options?: Record<string, unknown> }) => {
      capturedOptions = options;
      return createStream([
        {
          type: 'result',
          result: '{"summary":"ok","findings":[],"decisions":[]}',
        },
      ]);
    });

    const router = new ModelRouter('/nonexistent-codex', '/tmp/helix-bruce-worktree', {
      workspaceContext: {
        mode: 'git-worktree',
        sourceWorkDir: '/Users/prasannaarikala/projects/f-1/abl-platform',
        worktreeDir: '/tmp/helix-bruce-worktree',
      },
    });

    const result = await router.execute(
      'Audit Bruce feedback scope',
      {
        primary: { engine: 'claude-code', model: 'claude-opus-4-7', maxTurns: 1 },
      },
      ['Read', 'Bash'],
      undefined,
      { id: 'analysis-report' },
    );

    expect(result.error).toBeUndefined();
    const canUseTool = capturedOptions?.['canUseTool'] as
      | ((
          toolName: string,
          input: Record<string, unknown>,
          options: Record<string, unknown>,
        ) => Promise<Record<string, unknown>>)
      | undefined;
    expect(canUseTool).toBeTypeOf('function');

    const permission = await canUseTool?.(
      'Read',
      {
        file_path:
          '/Users/prasannaarikala/projects/f-1/abl-platform/packages/compiler/src/platform/ir/schema.ts',
      },
      {
        signal: new AbortController().signal,
        toolUseID: 'tool-3',
      },
    );

    expect(permission).toMatchObject({
      behavior: 'deny',
      message: expect.stringContaining('/tmp/helix-bruce-worktree'),
    });
  });

  it('updates built-in executor workspace guardrails from the active session context', async () => {
    let capturedOptions: Record<string, unknown> | undefined;

    queryMock.mockImplementation(({ options }: { options?: Record<string, unknown> }) => {
      capturedOptions = options;
      return createStream([
        {
          type: 'result',
          result: '{"summary":"ok","findings":[],"decisions":[]}',
        },
      ]);
    });

    const router = new ModelRouter('/nonexistent-codex', '/tmp/helix-bruce-worktree');
    router.setWorkspaceContext({
      mode: 'git-worktree',
      sourceWorkDir: '/Users/prasannaarikala/projects/agent-platform',
      worktreeDir: '/tmp/helix-bruce-worktree',
    });

    const result = await router.execute(
      'Audit Bruce feedback scope',
      {
        primary: { engine: 'claude-code', model: 'claude-opus-4-7', maxTurns: 1 },
      },
      ['Read', 'Bash'],
      undefined,
      { id: 'analysis-report' },
    );

    expect(result.error).toBeUndefined();
    const canUseTool = capturedOptions?.['canUseTool'] as
      | ((
          toolName: string,
          input: Record<string, unknown>,
          options: Record<string, unknown>,
        ) => Promise<Record<string, unknown>>)
      | undefined;
    expect(canUseTool).toBeTypeOf('function');

    const permission = await canUseTool?.(
      'Bash',
      {
        command:
          'cd /Users/prasannaarikala/projects/agent-platform && git diff HEAD~1 -- apps/studio/src/services/project-member-service.ts',
      },
      {
        signal: new AbortController().signal,
        toolUseID: 'tool-4',
      },
    );

    expect(permission).toMatchObject({
      behavior: 'deny',
      message: expect.stringContaining('/tmp/helix-bruce-worktree'),
    });
  });

  it('can disable runtime fallbacks while preserving the primary failure', async () => {
    const primary = vi.fn(async (_prompt, spec) => createResult(spec, 'primary failed', 'partial'));
    const fallback = vi.fn(async (_prompt, spec) =>
      createResult(spec, undefined, '{"summary":"ok","findings":[],"decisions":[]}'),
    );
    const router = new ModelRouter('/nonexistent-codex', process.cwd(), {
      allowFallbacks: false,
    });

    router.registerExecutor(createExecutor('codex-cli', primary));
    router.registerExecutor(createExecutor('claude-code', fallback));

    const result = await router.execute(
      'Audit this path',
      {
        primary: { engine: 'codex-cli', model: 'gpt-5.5' },
        fallback: { engine: 'claude-code', model: 'claude-opus-4-7' },
      },
      ['Read'],
      undefined,
      { id: 'analysis-report' },
      120,
    );

    expect(result.error).toBe('primary failed');
    expect(primary).toHaveBeenCalledTimes(1);
    expect(fallback).not.toHaveBeenCalled();
  });

  it('runs layered refinement passes without inheriting tool access', async () => {
    const primary = vi.fn(async (_prompt, spec, tools) => {
      expect(tools).toEqual(['Read', 'Bash']);
      return createResult(spec, undefined, '{"summary":"primary"}');
    });
    const layered = vi.fn(async (prompt, spec, tools) => {
      expect(prompt).toContain('synthesis-only continuation pass');
      expect(prompt).toContain('Do not use tools or restart discovery');
      expect(tools).toEqual([]);
      return createResult(spec, undefined, '{"summary":"layered"}');
    });

    const router = new ModelRouter('/nonexistent-codex', process.cwd());
    router.registerExecutor(createExecutor('codex-cli', primary));
    router.registerExecutor(createExecutor('claude-code', layered));

    const result = await router.execute(
      'Refine this implementation output',
      {
        primary: { engine: 'codex-cli', model: 'gpt-5.5' },
        layered: [{ engine: 'claude-code', model: 'claude-sonnet-4-6' }],
      },
      ['Read', 'Bash'],
      undefined,
      { id: 'analysis-report' },
      120,
    );

    expect(result.error).toBeUndefined();
    expect(result.output).toContain('layered');
    expect(primary).toHaveBeenCalledTimes(1);
    expect(layered).toHaveBeenCalledTimes(1);
  });
  // ── INT-2: OpenAiApiExecutor registration and dispatch ────────

  describe('INT-2: openai-api registration and dispatch', () => {
    let savedApiKey: string | undefined;

    beforeEach(() => {
      savedApiKey = process.env.OPENAI_API_KEY;
    });

    afterEach(() => {
      if (savedApiKey !== undefined) {
        process.env.OPENAI_API_KEY = savedApiKey;
      } else {
        delete process.env.OPENAI_API_KEY;
      }
    });

    it('registers openai-api as an available engine', async () => {
      process.env.OPENAI_API_KEY = 'sk-test-int2-available';
      const router = new ModelRouter('/nonexistent-codex', process.cwd());
      const engines = await router.getAvailableEngines();
      expect(engines).toContain('openai-api');
    });

    it('dispatches to OpenAiApiExecutor when engine is openai-api', async () => {
      process.env.OPENAI_API_KEY = 'sk-test-int2-dispatch';
      const fakeClient = makeFakeOpenAiClient({ trackCalls: true });
      const router = new ModelRouter('/nonexistent-codex', process.cwd());
      router.registerExecutor(
        new OpenAiApiExecutor(process.cwd(), () => Promise.resolve(fakeClient)),
      );

      const result = await router.execute(
        'test prompt',
        { primary: { engine: 'openai-api', model: 'gpt-5' } },
        [],
      );

      expect(result.error).toBeUndefined();
      expect(result.engine).toBe('openai-api');
      expect(result.model).toBe('gpt-5');
      expect(fakeClient._calls).toHaveLength(1);
    });

    it('returns ExecutorResult with non-empty error when openai-api is unavailable', async () => {
      delete process.env.OPENAI_API_KEY;
      const router = new ModelRouter('/nonexistent-codex', process.cwd());

      const result = await router.execute(
        'test prompt',
        { primary: { engine: 'openai-api', model: 'gpt-5' } },
        [],
      );

      expect(result.error).toBeTruthy();
      expect(result.error).toContain('not available');
      expect(result.output).toBe('');
    });

    it('falls back to claude-code when primary openai-api fails', async () => {
      process.env.OPENAI_API_KEY = 'sk-test-int2-fallback';
      const fakeClient = makeFakeOpenAiClient({
        shouldFail: { code: 'server_error', statusCode: 500 },
      });
      const router = new ModelRouter('/nonexistent-codex', process.cwd());
      router.registerExecutor(
        new OpenAiApiExecutor(process.cwd(), () => Promise.resolve(fakeClient)),
      );
      // Register a working claude-code executor as fallback
      router.registerExecutor(
        createExecutor('claude-code', async (_prompt, spec) =>
          createResult(spec, undefined, '{"summary":"fallback success"}'),
        ),
      );

      const result = await router.execute(
        'test prompt',
        {
          primary: { engine: 'openai-api', model: 'gpt-5' },
          fallback: { engine: 'claude-code', model: 'opus' },
        },
        [],
      );

      expect(result.error).toBeUndefined();
      expect(result.engine).toBe('claude-code');
      expect(result.output).toContain('fallback success');
    });
  });

  describe('INT-3: claude-api registration and dispatch', () => {
    let savedAnthropicKey: string | undefined;

    beforeEach(() => {
      savedAnthropicKey = process.env.ANTHROPIC_API_KEY;
    });

    afterEach(() => {
      if (savedAnthropicKey !== undefined) {
        process.env.ANTHROPIC_API_KEY = savedAnthropicKey;
      } else {
        delete process.env.ANTHROPIC_API_KEY;
      }
    });

    it('registers claude-api as an available engine', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-ant-test-int3-available';
      const router = new ModelRouter('/nonexistent-codex', process.cwd());
      const engines = await router.getAvailableEngines();
      expect(engines).toContain('claude-api');
    });

    it('dispatches to AnthropicApiExecutor when engine is claude-api', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-ant-test-int3-dispatch';
      const fakeClient = {
        messages: {
          create: vi.fn(async () => ({
            id: 'msg_test',
            model: 'claude-opus-4-7',
            content: [{ type: 'text', text: '{"summary":"claude-api ok"}' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 100, output_tokens: 50 },
          })),
        },
      };
      const router = new ModelRouter('/nonexistent-codex', process.cwd());
      router.registerExecutor(
        new AnthropicApiExecutor(process.cwd(), () => Promise.resolve(fakeClient)),
      );

      const result = await router.execute(
        'test prompt',
        { primary: { engine: 'claude-api', model: 'claude-opus-4-7' } },
        [],
      );

      expect(result.error).toBeUndefined();
      expect(result.engine).toBe('claude-api');
      expect(result.model).toBe('claude-opus-4-7');
      expect(result.output).toContain('claude-api ok');
      expect(fakeClient.messages.create).toHaveBeenCalledTimes(1);
    });
  });
});

function createExecutor(
  engine: ModelEngine,
  handler: (
    prompt: string,
    spec: ModelSpec,
    tools?: string[],
    onStream?: (event: StreamEvent) => void,
    outputSchema?: StageOutputSchemaConfig,
    timeoutMs?: number,
  ) => Promise<ExecutorResult>,
): ModelExecutor {
  return {
    engine,
    execute: handler,
    async isAvailable(): Promise<boolean> {
      return true;
    },
  };
}

function createResult(spec: ModelSpec, error?: string, output: string = ''): ExecutorResult {
  return {
    output,
    model: spec.model ?? 'unknown',
    engine: spec.engine,
    turnsUsed: 1,
    durationMs: 1,
    error,
  };
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function createStream(messages: unknown[]): AsyncIterable<unknown> & {
  close(): void;
} {
  return {
    close(): void {
      // No-op for the unit test stream.
    },
    async *[Symbol.asyncIterator](): AsyncIterator<unknown> {
      for (const message of messages) {
        yield message;
      }
    },
  };
}
