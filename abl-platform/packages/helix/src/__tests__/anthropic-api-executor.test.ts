import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ANTHROPIC_MODEL_PRICING_USD,
  AnthropicApiExecutor,
  resolveAnthropicModelAlias,
  type AnthropicClientLike,
} from '../models/anthropic-api-executor.js';

let savedApiKey: string | undefined;
let tempDir: string | null = null;

beforeEach(() => {
  savedApiKey = process.env.ANTHROPIC_API_KEY;
});

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
  if (savedApiKey !== undefined) {
    process.env.ANTHROPIC_API_KEY = savedApiKey;
  } else {
    delete process.env.ANTHROPIC_API_KEY;
  }
});

function makeFakeAnthropicClient(
  createImpl?: (params: Record<string, unknown>) => Promise<Record<string, unknown>>,
): AnthropicClientLike & { _calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = [];

  return {
    _calls: calls,
    messages: {
      async create(params: Record<string, unknown>) {
        calls.push({ ...params });
        if (createImpl) {
          return createImpl(params);
        }

        return {
          id: 'msg_default',
          model: String(params['model'] ?? 'claude-opus-4-7'),
          content: [{ type: 'text', text: '{"summary":"ok","findings":[],"decisions":[]}' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 100, output_tokens: 50 },
        };
      },
    },
  };
}

describe('AnthropicApiExecutor', () => {
  it('resolves common HELIX Claude aliases to Anthropic API model ids', () => {
    expect(resolveAnthropicModelAlias(undefined)).toBe('claude-opus-4-7');
    expect(resolveAnthropicModelAlias('opus')).toBe('claude-opus-4-7');
    expect(resolveAnthropicModelAlias('sonnet')).toBe('claude-sonnet-4-6');
    expect(resolveAnthropicModelAlias('claude-opus-4-7')).toBe('claude-opus-4-7');
  });

  it('tracks published Anthropic pricing for the API synthesis models', () => {
    expect(ANTHROPIC_MODEL_PRICING_USD['claude-opus-4-7']).toEqual({
      inputUsdPer1M: 5,
      outputUsdPer1M: 25,
    });
    expect(ANTHROPIC_MODEL_PRICING_USD['claude-sonnet-4-6']).toEqual({
      inputUsdPer1M: 3,
      outputUsdPer1M: 15,
    });
  });

  it('returns true from isAvailable when ANTHROPIC_API_KEY is present', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    const executor = new AnthropicApiExecutor('/tmp');
    expect(await executor.isAvailable()).toBe(true);
  });

  it('returns false from isAvailable when ANTHROPIC_API_KEY is missing', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const executor = new AnthropicApiExecutor('/tmp');
    expect(await executor.isAvailable()).toBe(false);
  });

  it('executes a non-streaming Anthropic request and returns cost/output', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    const client = makeFakeAnthropicClient();
    const executor = new AnthropicApiExecutor('/tmp', () => Promise.resolve(client));

    const result = await executor.execute('Analyze this seam', {
      engine: 'claude-api',
      model: 'opus',
      systemPrompt: 'Return JSON only.',
      maxTurns: 4,
    });

    expect(result.error).toBeUndefined();
    expect(result.engine).toBe('claude-api');
    expect(result.model).toBe('claude-opus-4-7');
    expect(result.output).toContain('"summary":"ok"');
    expect(result.costUsd).toBeCloseTo(0.00175, 6);
    expect(client._calls).toHaveLength(1);
    expect(client._calls[0]?.['system']).toBe('Return JSON only.');
    expect(client._calls[0]?.['model']).toBe('claude-opus-4-7');
  });

  it('returns a timedOut result when the Anthropic request never resolves', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    const client = makeFakeAnthropicClient(() => new Promise(() => undefined));
    const executor = new AnthropicApiExecutor('/tmp', () => Promise.resolve(client));

    const result = await executor.execute(
      'Analyze this seam',
      {
        engine: 'claude-api',
        model: 'sonnet',
      },
      undefined,
      undefined,
      undefined,
      10,
    );

    expect(result.error).toContain('timed out');
    expect(result.timedOut).toBe(true);
    expect(result.turnsUsed).toBe(0);
    expect(result.model).toBe('claude-sonnet-4-6');
  });

  it('prefers Anthropic streaming when the SDK exposes it', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    const createSpy = vi.fn(async () => ({
      id: 'msg_create',
      model: 'claude-opus-4-7',
      content: [{ type: 'text', text: '{"summary":"create fallback"}' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 100, output_tokens: 50 },
    }));
    const streamSpy = vi.fn((params: Record<string, unknown>) => {
      expect(params['model']).toBe('claude-opus-4-7');
      return {
        abort: vi.fn(),
        finalMessage: vi.fn(async () => ({
          id: 'msg_stream',
          model: 'claude-opus-4-7',
          content: [{ type: 'text', text: '{"summary":"stream ok","findings":[],"decisions":[]}' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 120, output_tokens: 60 },
        })),
      };
    });
    const client: AnthropicClientLike = {
      messages: {
        create: createSpy,
        stream: streamSpy,
      },
    };
    const executor = new AnthropicApiExecutor('/tmp', () => Promise.resolve(client));

    const result = await executor.execute('Analyze this seam', {
      engine: 'claude-api',
      model: 'opus',
      maxTurns: 4,
    });

    expect(result.error).toBeUndefined();
    expect(result.output).toContain('"summary":"stream ok"');
    expect(streamSpy).toHaveBeenCalledTimes(1);
    expect(createSpy).not.toHaveBeenCalled();
  });

  it('aborts Anthropic streams when the request times out', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    const abortSpy = vi.fn();
    const streamSpy = vi.fn(() => ({
      abort: abortSpy,
      finalMessage: vi.fn(() => new Promise<never>(() => undefined)),
    }));
    const client: AnthropicClientLike = {
      messages: {
        create: vi.fn(async () => ({
          id: 'msg_unused',
          model: 'claude-sonnet-4-6',
          content: [{ type: 'text', text: '{"summary":"unused"}' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 100, output_tokens: 50 },
        })),
        stream: streamSpy,
      },
    };
    const executor = new AnthropicApiExecutor('/tmp', () => Promise.resolve(client));

    const result = await executor.execute(
      'Analyze this seam',
      {
        engine: 'claude-api',
        model: 'sonnet',
      },
      undefined,
      undefined,
      undefined,
      10,
    );

    expect(result.error).toContain('timed out');
    expect(result.timedOut).toBe(true);
    expect(streamSpy).toHaveBeenCalledTimes(1);
    expect(abortSpy).toHaveBeenCalledTimes(1);
  });

  it('executes a harness-owned tool loop before returning the final response', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    tempDir = await mkdtemp(join(tmpdir(), 'helix-anthropic-tools-'));
    const targetFile = join(tempDir, 'notes.txt');
    await writeFile(targetFile, 'alpha\nbeta\ngamma\n', 'utf-8');

    let callCount = 0;
    const client = makeFakeAnthropicClient(async (params) => {
      callCount += 1;
      if (callCount === 1) {
        expect(Array.isArray(params['tools'])).toBe(true);
        return {
          id: 'msg_tool',
          model: 'claude-opus-4-7',
          stop_reason: 'tool_use',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_1',
              name: 'Read',
              input: { path: 'notes.txt', startLine: 2, endLine: 3 },
            },
          ],
          usage: { input_tokens: 120, output_tokens: 20 },
        };
      }

      const messages = params['messages'] as Array<Record<string, unknown>>;
      const lastUserMessage = messages.at(-1) as Record<string, unknown>;
      const toolResults = lastUserMessage?.['content'] as Array<Record<string, unknown>>;
      expect(toolResults[0]?.['type']).toBe('tool_result');
      expect(String(toolResults[0]?.['content'])).toContain('2: beta');

      return {
        id: 'msg_final',
        model: 'claude-opus-4-7',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: '{"summary":"used tools","findings":[],"decisions":[]}' }],
        usage: { input_tokens: 140, output_tokens: 60 },
      };
    });

    const executor = new AnthropicApiExecutor(tempDir, () => Promise.resolve(client));
    const result = await executor.execute(
      'Analyze this seam',
      {
        engine: 'claude-api',
        model: 'claude-opus-4-7',
        maxTurns: 4,
      },
      ['Read'],
      undefined,
      { id: 'analysis-report' },
    );

    expect(result.error).toBeUndefined();
    expect(result.turnsUsed).toBe(2);
    expect(result.output).toContain('"summary":"used tools"');
  });

  it('rewrites source-workspace file paths to the active worktree for tool execution', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    tempDir = await mkdtemp(join(tmpdir(), 'helix-anthropic-worktree-'));
    const targetFile = join(tempDir, 'packages/compiler/src/example.ts');
    await mkdir(dirname(targetFile), { recursive: true });
    await writeFile(targetFile, 'export const value = 42;\n', 'utf-8');

    let callCount = 0;
    const client = makeFakeAnthropicClient(async () => {
      callCount += 1;
      if (callCount === 1) {
        return {
          id: 'msg_tool',
          model: 'claude-opus-4-7',
          stop_reason: 'tool_use',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_2',
              name: 'Read',
              input: {
                path: '/Users/prasannaarikala/projects/source-checkout/packages/compiler/src/example.ts',
              },
            },
          ],
          usage: { input_tokens: 100, output_tokens: 20 },
        };
      }

      return {
        id: 'msg_final',
        model: 'claude-opus-4-7',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: '{"summary":"worktree ok","findings":[],"decisions":[]}' }],
        usage: { input_tokens: 100, output_tokens: 40 },
      };
    });

    const executor = new AnthropicApiExecutor(tempDir, () => Promise.resolve(client));
    executor.setWorkspaceContext?.({
      mode: 'git-worktree',
      sourceWorkDir: '/Users/prasannaarikala/projects/source-checkout',
      worktreeDir: tempDir,
    });

    const result = await executor.execute(
      'Analyze this seam',
      {
        engine: 'claude-api',
        model: 'claude-opus-4-7',
        maxTurns: 4,
      },
      ['Read'],
      undefined,
      { id: 'analysis-report' },
    );

    expect(result.error).toBeUndefined();
    expect(result.output).toContain('"summary":"worktree ok"');
  });
});
