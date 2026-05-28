import { beforeEach, describe, expect, it, vi } from 'vitest';

const { queryMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: queryMock,
}));

import { ClaudeSdkExecutor } from '../models/claude-sdk-executor.js';

describe('ClaudeSdkExecutor', () => {
  beforeEach(() => {
    queryMock.mockReset();
  });

  it('appends the structured output contract when an output schema is provided', async () => {
    let capturedPrompt = '';

    queryMock.mockImplementation(({ prompt }: { prompt: string }) => {
      capturedPrompt = prompt;
      return createStream([
        {
          type: 'result',
          result: '{"summary":"ok","findings":[],"decisions":[]}',
        },
      ]);
    });

    const executor = new ClaudeSdkExecutor();
    const result = await executor.execute(
      'Review the scoped files and respond.',
      {
        engine: 'claude-code',
        model: 'opus',
        maxTurns: 1,
      },
      ['Read', 'Grep'],
      undefined,
      { id: 'analysis-report' },
    );

    expect(result.error).toBeUndefined();
    expect(result.output).toBe('{"summary":"ok","findings":[],"decisions":[]}');
    expect(capturedPrompt).toContain('## Structured Output Contract');
    expect(capturedPrompt).toContain('"summary": "short summary"');
  });

  it('does not duplicate structured output instructions that are already present', async () => {
    let capturedPrompt = '';

    queryMock.mockImplementation(({ prompt }: { prompt: string }) => {
      capturedPrompt = prompt;
      return createStream([
        {
          type: 'result',
          result: '{"summary":"ok","findings":[],"decisions":[]}',
        },
      ]);
    });

    const executor = new ClaudeSdkExecutor();
    await executor.execute(
      [
        'Review the scoped files and respond.',
        '',
        '## Structured Output Contract',
        'Return ONLY a JSON object.',
      ].join('\n'),
      {
        engine: 'claude-code',
        model: 'opus',
        maxTurns: 1,
      },
      ['Read'],
      undefined,
      { id: 'analysis-report' },
    );

    expect(capturedPrompt.match(/## Structured Output Contract/g)).toHaveLength(1);
  });

  it('returns a timeout error even when the Claude stream closes cleanly after abort', async () => {
    queryMock.mockImplementation(() => createHangingStream());

    const executor = new ClaudeSdkExecutor();
    const result = await executor.execute(
      'Review the scoped files and respond.',
      {
        engine: 'claude-code',
        model: 'opus',
        maxTurns: 1,
      },
      ['Read'],
      undefined,
      { id: 'analysis-report' },
      20,
    );

    expect(result.error).toMatch(/Claude stalled after \d+s of inactivity/);
    expect(result.timedOut).toBe(true);
  });

  it('does not treat unsupported keepalive messages as real activity', async () => {
    vi.useFakeTimers();
    try {
      queryMock.mockImplementation(() => createKeepaliveStream({ type: 'noop' }, 1_000));

      const executor = new ClaudeSdkExecutor();
      const pending = executor.execute(
        'Review the scoped files and respond.',
        {
          engine: 'claude-code',
          model: 'opus',
          maxTurns: 1,
          stallThresholdMs: 12_000,
        },
        ['Read'],
        undefined,
        { id: 'analysis-report' },
      );

      await vi.advanceTimersByTimeAsync(21_000);
      const result = await pending;

      expect(result.error).toMatch(/Claude stalled after \d+s of inactivity/);
      expect(result.timedOut).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('pins Claude SDK sessions to the configured worktree cwd', async () => {
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

    const executor = new ClaudeSdkExecutor('/tmp/helix-bruce-worktree');
    const result = await executor.execute(
      'Review the scoped files and respond.',
      {
        engine: 'claude-code',
        model: 'claude-opus-4-7',
        maxTurns: 1,
      },
      ['Read'],
      undefined,
      { id: 'analysis-report' },
    );

    expect(result.error).toBeUndefined();
    expect(capturedOptions?.['cwd']).toBe('/tmp/helix-bruce-worktree');
  });

  it('loads configured Claude setting sources so user MCP/settings are available', async () => {
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

    const executor = new ClaudeSdkExecutor('/tmp/helix-bruce-worktree', ['user']);
    const result = await executor.execute(
      'Review the scoped files and respond.',
      {
        engine: 'claude-code',
        model: 'claude-opus-4-7',
        maxTurns: 1,
      },
      ['Read'],
      undefined,
      { id: 'analysis-report' },
    );

    expect(result.error).toBeUndefined();
    expect(capturedOptions?.['settingSources']).toEqual(['user']);
  });

  it('tightens Claude maxTurns when a HELIX efficiency budget is present', async () => {
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

    const executor = new ClaudeSdkExecutor();
    const result = await executor.execute(
      'Implement the slice.',
      {
        engine: 'claude-code',
        model: 'claude-opus-4-7',
        maxTurns: 50,
        efficiencyBudget: {
          targetTurns: 18,
          explorationTurns: 6,
        },
      },
      ['Read', 'Edit'],
      undefined,
      { id: 'analysis-report' },
    );

    expect(result.error).toBeUndefined();
    expect(capturedOptions?.['maxTurns']).toBe(36);
  });

  it('aborts Claude once the HELIX hard cap is exceeded', async () => {
    queryMock.mockImplementation(() =>
      createClosableStream(
        Array.from({ length: 40 }, (_, index) => ({
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: `turn ${index + 1}` }],
          },
        })),
      ),
    );

    const executor = new ClaudeSdkExecutor();
    const result = await executor.execute(
      'Analyze the broader replay seam.',
      {
        engine: 'claude-code',
        model: 'claude-sonnet-4-6',
        maxTurns: 80,
        efficiencyBudget: {
          targetTurns: 14,
          explorationTurns: 6,
        },
      },
      ['Read', 'Grep'],
      undefined,
      { id: 'analysis-report' },
    );

    expect(result.error).toMatch(/Claude exceeded the HELIX efficiency hard cap/);
    expect(result.turnsUsed).toBe(28);
  });

  it('injects configured MCP servers directly into Claude SDK sessions', async () => {
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

    const executor = new ClaudeSdkExecutor('/tmp/helix-bruce-worktree', ['user'], {
      helix: {
        command: 'pnpm',
        args: ['exec', 'tsx', 'packages/helix/src/mcp-cli.ts', '--workdir', '.'],
      },
    });
    const result = await executor.execute(
      'Review the scoped files and respond.',
      {
        engine: 'claude-code',
        model: 'claude-opus-4-7',
        maxTurns: 1,
      },
      ['Read'],
      undefined,
      { id: 'analysis-report' },
    );

    expect(result.error).toBeUndefined();
    expect(capturedOptions?.['mcpServers']).toEqual({
      helix: {
        type: 'stdio',
        command: 'pnpm',
        args: ['exec', 'tsx', 'packages/helix/src/mcp-cli.ts', '--workdir', '.'],
      },
    });
  });

  it('rewrites source-checkout paths into the detached worktree inside the Claude prompt', async () => {
    let capturedPrompt = '';
    let capturedOptions: Record<string, unknown> | undefined;

    queryMock.mockImplementation(
      ({ prompt, options }: { prompt?: string; options?: Record<string, unknown> }) => {
        capturedPrompt = prompt ?? '';
        capturedOptions = options;
        return createStream([
          {
            type: 'result',
            result: '{"summary":"ok","findings":[],"decisions":[]}',
          },
        ]);
      },
    );

    const executor = new ClaudeSdkExecutor(
      '/tmp/helix-bruce-worktree',
      ['user'],
      {},
      {
        mode: 'git-worktree',
        sourceWorkDir: '/Users/prasannaarikala/projects/f-1/abl-platform',
        worktreeDir: '/tmp/helix-bruce-worktree',
      },
    );

    await executor.execute(
      'Read /Users/prasannaarikala/projects/f-1/abl-platform/packages/compiler/src/platform/ir/schema.ts and stay inside the replay workspace.',
      {
        engine: 'claude-code',
        model: 'claude-opus-4-7',
        maxTurns: 1,
      },
      ['Read'],
      undefined,
      { id: 'analysis-report' },
    );

    expect(capturedPrompt).not.toContain('/Users/prasannaarikala/projects/f-1/abl-platform');
    expect(capturedPrompt).toContain(
      '/tmp/helix-bruce-worktree/packages/compiler/src/platform/ir/schema.ts',
    );
    expect(capturedOptions?.['hooks']).toBeUndefined();
  });

  it('denies Claude tool calls that still target the source checkout during git-worktree replays', async () => {
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

    const executor = new ClaudeSdkExecutor(
      '/tmp/helix-bruce-worktree',
      ['user'],
      {},
      {
        mode: 'git-worktree',
        sourceWorkDir: '/Users/prasannaarikala/projects/f-1/abl-platform',
        worktreeDir: '/tmp/helix-bruce-worktree',
      },
    );

    await executor.execute(
      'Review the scoped files and respond.',
      {
        engine: 'claude-code',
        model: 'claude-opus-4-7',
        maxTurns: 1,
      },
      ['Read'],
      undefined,
      { id: 'analysis-report' },
    );

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
          '/Users/prasannaarikala/projects/f-1/abl-platform/packages/core/src/types/agent-based.ts',
      },
      {
        signal: new AbortController().signal,
        toolUseID: 'tool-2',
      } as never,
    );

    expect(permission).toMatchObject({
      behavior: 'deny',
      message: expect.stringContaining('/tmp/helix-bruce-worktree'),
    });
  });

  it('blocks repeated Claude reads after the exploration budget is exhausted', async () => {
    let capturedOptions: Record<string, unknown> | undefined;

    queryMock.mockImplementation(({ options }: { options?: Record<string, unknown> }) => {
      capturedOptions = options;
      return createStream([
        ...Array.from({ length: 8 }, () => ({
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'thinking through the slice' }],
          },
        })),
        {
          type: 'result',
          result: '{"summary":"ok","findings":[],"decisions":[]}',
        },
      ]);
    });

    const executor = new ClaudeSdkExecutor();
    await executor.execute(
      'Implement the slice.',
      {
        engine: 'claude-code',
        model: 'claude-opus-4-7',
        maxTurns: 50,
        efficiencyBudget: {
          targetTurns: 24,
          explorationTurns: 8,
        },
      },
      ['Read'],
      undefined,
      { id: 'analysis-report' },
    );

    const canUseTool = capturedOptions?.['canUseTool'] as
      | ((
          toolName: string,
          input: Record<string, unknown>,
          options: Record<string, unknown>,
        ) => Promise<Record<string, unknown>>)
      | undefined;
    expect(canUseTool).toBeTypeOf('function');

    const toolOptions = {
      signal: new AbortController().signal,
      toolUseID: 'tool-repeat',
    } as never;

    const firstRead = await canUseTool?.(
      'Read',
      { file_path: 'packages/helix/src/pipeline/pipeline-engine.ts' },
      toolOptions,
    );
    const secondRead = await canUseTool?.(
      'Read',
      { file_path: 'packages/helix/src/pipeline/pipeline-engine.ts' },
      toolOptions,
    );
    const thirdRead = await canUseTool?.(
      'Read',
      { file_path: 'packages/helix/src/pipeline/pipeline-engine.ts' },
      toolOptions,
    );

    expect(firstRead).toMatchObject({ behavior: 'allow' });
    expect(secondRead).toMatchObject({ behavior: 'allow' });
    expect(thirdRead).toMatchObject({
      behavior: 'deny',
      message: expect.stringContaining('repeated Read lookup'),
    });
  });

  it('passes an explicit empty allowedTools list through to Claude SDK sessions', async () => {
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

    const executor = new ClaudeSdkExecutor();
    const result = await executor.execute(
      'Synthesize from the gathered seam evidence only.',
      {
        engine: 'claude-code',
        model: 'claude-sonnet-4-6',
        maxTurns: 4,
        efficiencyBudget: {
          targetTurns: 2,
          explorationTurns: 0,
          hardTurnCap: 4,
          disableToolUse: true,
        },
      },
      [],
      undefined,
      { id: 'analysis-report' },
    );

    expect(result.error).toBeUndefined();
    expect(capturedOptions?.['allowedTools']).toEqual([]);

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
      { file_path: 'apps/studio/src/repos/project-repo.ts' },
      {
        signal: new AbortController().signal,
        toolUseID: 'tool-empty-allow-list',
      } as never,
    );

    expect(permission).toMatchObject({
      behavior: 'deny',
      message: expect.stringContaining('disabled tool use for this review'),
    });
  });

  it('denies Claude tools that are not present in the allowed tools list', async () => {
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

    const executor = new ClaudeSdkExecutor();
    await executor.execute(
      'Review the retained evidence packet.',
      {
        engine: 'claude-code',
        model: 'claude-sonnet-4-6',
        maxTurns: 4,
      },
      ['Read'],
      undefined,
      { id: 'analysis-report' },
    );

    const canUseTool = capturedOptions?.['canUseTool'] as
      | ((
          toolName: string,
          input: Record<string, unknown>,
          options: Record<string, unknown>,
        ) => Promise<Record<string, unknown>>)
      | undefined;
    expect(canUseTool).toBeTypeOf('function');

    const readPermission = await canUseTool?.(
      'Read',
      { file_path: 'apps/studio/src/repos/project-repo.ts' },
      {
        signal: new AbortController().signal,
        toolUseID: 'tool-allowed-read',
      } as never,
    );
    const bashPermission = await canUseTool?.('Bash', { command: 'pwd' }, {
      signal: new AbortController().signal,
      toolUseID: 'tool-blocked-bash',
    } as never);

    expect(readPermission).toMatchObject({ behavior: 'allow' });
    expect(bashPermission).toMatchObject({
      behavior: 'deny',
      message: expect.stringContaining('Allowed tools: Read'),
    });
  });

  it('denies Claude tool use entirely when disableToolUse is enabled', async () => {
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

    const executor = new ClaudeSdkExecutor();
    await executor.execute(
      'Synthesize from the gathered seam evidence only.',
      {
        engine: 'claude-code',
        model: 'claude-sonnet-4-6',
        maxTurns: 4,
        efficiencyBudget: {
          targetTurns: 2,
          explorationTurns: 0,
          hardTurnCap: 4,
          disableToolUse: true,
        },
      },
      [],
      undefined,
      { id: 'analysis-report' },
    );

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
      { file_path: 'apps/studio/src/repos/project-repo.ts' },
      {
        signal: new AbortController().signal,
        toolUseID: 'tool-disabled',
      } as never,
    );

    expect(permission).toMatchObject({
      behavior: 'deny',
      message: expect.stringContaining('disabled tool use'),
    });
  });

  it('issues a repair turn when Claude returns JSON that fails schema validation', async () => {
    const capturedPrompts: string[] = [];
    let callCount = 0;

    queryMock.mockImplementation(({ prompt }: { prompt: string }) => {
      capturedPrompts.push(prompt);
      callCount++;
      if (callCount === 1) {
        return createStream([
          {
            type: 'result',
            result: '{"summary":"first pass","findings":"this should be an array"}',
          },
        ]);
      }
      return createStream([
        {
          type: 'result',
          result: '{"summary":"repaired","findings":[],"decisions":[]}',
        },
      ]);
    });

    const executor = new ClaudeSdkExecutor();
    const result = await executor.execute(
      'Review the scoped files and respond.',
      {
        engine: 'claude-code',
        model: 'opus',
        maxTurns: 4,
      },
      ['Read'],
      undefined,
      { id: 'analysis-report' },
    );

    expect(callCount).toBe(2);
    expect(result.error).toBeUndefined();
    expect(result.output).toBe('{"summary":"repaired","findings":[],"decisions":[]}');
    expect(capturedPrompts[1]).toContain('did not match the required structured output contract');
    expect(capturedPrompts[1]).toContain('## Validation Errors');
    expect(capturedPrompts[1]).toContain('## Previous Output');
  });

  it('surfaces a repair-failure error when the repair turn also returns malformed JSON', async () => {
    queryMock.mockImplementation(() =>
      createStream([
        {
          type: 'result',
          result: 'not-json at all',
        },
      ]),
    );

    const executor = new ClaudeSdkExecutor();
    const result = await executor.execute(
      'Review the scoped files and respond.',
      {
        engine: 'claude-code',
        model: 'opus',
        maxTurns: 4,
      },
      ['Read'],
      undefined,
      { id: 'analysis-report' },
    );

    expect(result.error).toMatch(/structured-output repair failed/);
    expect(result.output).toBe('not-json at all');
  });

  it('skips the repair turn when the first output already matches the schema', async () => {
    let callCount = 0;

    queryMock.mockImplementation(() => {
      callCount++;
      return createStream([
        {
          type: 'result',
          result: '{"summary":"clean","findings":[],"decisions":[]}',
        },
      ]);
    });

    const executor = new ClaudeSdkExecutor();
    const result = await executor.execute(
      'Review the scoped files and respond.',
      {
        engine: 'claude-code',
        model: 'opus',
        maxTurns: 4,
      },
      ['Read'],
      undefined,
      { id: 'analysis-report' },
    );

    expect(callCount).toBe(1);
    expect(result.error).toBeUndefined();
    expect(result.output).toBe('{"summary":"clean","findings":[],"decisions":[]}');
  });
});

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

function createClosableStream(messages: unknown[]): AsyncIterable<unknown> & {
  close(): void;
} {
  let closed = false;

  return {
    close(): void {
      closed = true;
    },
    async *[Symbol.asyncIterator](): AsyncIterator<unknown> {
      for (const message of messages) {
        if (closed) {
          return;
        }
        yield message;
      }
    },
  };
}

function createHangingStream(): AsyncIterable<unknown> & { close(): void } {
  let closed = false;

  return {
    close(): void {
      closed = true;
    },
    async *[Symbol.asyncIterator](): AsyncIterator<unknown> {
      while (!closed) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    },
  };
}

function createKeepaliveStream(
  message: unknown,
  intervalMs: number,
): AsyncIterable<unknown> & {
  close(): void;
} {
  let closed = false;

  return {
    close(): void {
      closed = true;
    },
    async *[Symbol.asyncIterator](): AsyncIterator<unknown> {
      while (!closed) {
        yield message;
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
      }
    },
  };
}
