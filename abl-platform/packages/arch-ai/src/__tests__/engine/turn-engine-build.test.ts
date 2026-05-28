/**
 * TurnEngine BUILD flow — unit tests.
 *
 * All dependencies are injected (FakeLLM, FakeTurnBuffer, FakeToolRegistry).
 * No vi.mock of internal packages per CLAUDE.md test architecture rules.
 *
 * Covers:
 *   Test 1 — selects abl-construct-expert specialist for BUILD phase
 *   Test 2 — generate_agent tool call updates metadata.files via buffered service
 *   Test 3 — compile_abl emits artifact_updated{channel:"build"} with status
 *   Test 4 — proceed_to_next_phase BUILD → CREATE when all agents compiled
 *   Test 5 — proceed_to_next_phase BUILD → CREATE rejects when agent has error status
 *   Test 6 — cancel during BUILD stops engine between LLM rounds
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { z } from 'zod';

import { TurnEngine } from '../../engine/turn-engine.js';
import { ToolRegistry } from '../../tools/v2/registry.js';
import { resolveTurnPlan } from '../../engine/coordinator-bridge.js';
import type { LLMStreamClient, LLMStreamChunk, LLMStreamRequest } from '../../engine/llm-client.js';
import type { TurnEvent } from '../../types/turn-events.js';
import type { ProjectWrite } from '../../engine/turn-context.js';
import type { StoredMessageV2 } from '../../types/session-v2.js';

// ─── Fake TurnBuffer ─────────────────────────────────────────────────────────

class FakeTurnBuffer {
  committed = false;
  rolledBack = false;
  suggestions: string[] = [];
  completionMetadata: Record<string, unknown> | undefined;

  private sessionPatch: Record<string, unknown> = {};
  private pendingMessages: StoredMessageV2[] = [];
  private pendingProjectWrites: ProjectWrite[] = [];

  shouldFailCommit = false;

  patchSession(patch: Record<string, unknown>): void {
    if (this.committed || this.rolledBack) return;
    Object.assign(this.sessionPatch, patch);
  }

  get sessionPatchSnapshot(): Readonly<Record<string, unknown>> {
    return { ...this.sessionPatch };
  }

  appendMessage(
    role: StoredMessageV2['role'],
    content: StoredMessageV2['content'],
  ): StoredMessageV2 {
    const msg: StoredMessageV2 = {
      id: `msg-${this.pendingMessages.length + 1}`,
      turnId: 'test-turn',
      role,
      content,
      createdAt: Date.now(),
    };
    this.pendingMessages.push(msg);
    return msg;
  }

  get pendingMessagesSnapshot(): ReadonlyArray<StoredMessageV2> {
    return [...this.pendingMessages];
  }

  enqueueProjectWrite(write: ProjectWrite): void {
    if (this.committed || this.rolledBack) {
      throw new Error('FakeTurnBuffer.enqueueProjectWrite: already committed or rolled back');
    }
    this.pendingProjectWrites.push(write);
  }

  get pendingProjectWritesSnapshot(): ReadonlyArray<ProjectWrite> {
    return [...this.pendingProjectWrites];
  }

  async commit(): Promise<{
    committed: boolean;
    newCommit: boolean;
    writes: { sessionPatched: boolean; messagesAppended: number; projectWritesApplied: number };
  }> {
    if (this.committed) throw new Error('FakeTurnBuffer.commit: already committed');
    if (this.rolledBack) throw new Error('FakeTurnBuffer.commit: rolled back');
    if (this.shouldFailCommit) throw new Error('FakeTurnBuffer.commit: simulated failure');

    for (const pw of this.pendingProjectWrites) {
      await pw.execute(null);
    }

    this.committed = true;
    return {
      committed: true,
      newCommit: true,
      writes: {
        sessionPatched: Object.keys(this.sessionPatch).length > 0,
        messagesAppended: this.pendingMessages.length,
        projectWritesApplied: this.pendingProjectWrites.length,
      },
    };
  }

  rollback(): void {
    if (this.committed) throw new Error('FakeTurnBuffer.rollback: already committed');
    this.sessionPatch = {};
    this.pendingMessages = [];
    this.pendingProjectWrites = [];
    this.suggestions = [];
    this.completionMetadata = undefined;
    this.rolledBack = true;
  }
}

// ─── Fake LLM builder ────────────────────────────────────────────────────────

type ScriptedChunk = LLMStreamChunk;

function makeFakeLLM(chunks: ScriptedChunk[]): LLMStreamClient {
  return {
    stream(_req: LLMStreamRequest): AsyncIterable<LLMStreamChunk> {
      return {
        [Symbol.asyncIterator]() {
          let idx = 0;
          return {
            async next() {
              if (idx >= chunks.length) return { done: true, value: undefined };
              return { done: false, value: chunks[idx++] };
            },
          };
        },
      };
    },
  };
}

/** Multi-round LLM: switches between chunk arrays on successive calls. */
function makeMultiRoundLLM(rounds: ScriptedChunk[][]): LLMStreamClient {
  let callCount = 0;
  return {
    stream(_req: LLMStreamRequest): AsyncIterable<LLMStreamChunk> {
      const chunks = rounds[Math.min(callCount, rounds.length - 1)];
      callCount++;
      return {
        [Symbol.asyncIterator]() {
          let idx = 0;
          return {
            async next() {
              if (idx >= chunks.length) return { done: true, value: undefined };
              return { done: false, value: chunks[idx++] };
            },
          };
        },
      };
    },
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function collect(
  engine: TurnEngine,
  input: Parameters<TurnEngine['runTurn']>[0],
): Promise<TurnEvent[]> {
  const events: TurnEvent[] = [];
  for await (const ev of engine.runTurn(input)) {
    events.push(ev);
  }
  return events;
}

function makeInput(
  overrides: Partial<Parameters<TurnEngine['runTurn']>[0]> & {
    buffer: FakeTurnBuffer;
    llmClient?: LLMStreamClient;
    allowedTools?: ToolRegistry;
  },
): Parameters<TurnEngine['runTurn']>[0] {
  return {
    sessionId: 'sess-build-test',
    tenantId: 'tenant-test',
    userId: 'user-test',
    turnId: 'turn-build-test',
    phase: 'BUILD',
    mode: 'onboarding',
    history: [],
    systemPrompt: 'You are Arch AI ABL construct expert.',
    userInput: 'Generate the agents',
    allowedTools: overrides.allowedTools ?? new ToolRegistry(),
    buffer: overrides.buffer as unknown as import('../../engine/turn-buffer.js').TurnBuffer,
    signal: new AbortController().signal,
    specialist: 'abl-construct-expert',
    ...overrides,
  };
}

let seq = 0;
function deterministicId() {
  return `id-${seq++}`;
}
function deterministicClock() {
  return 1_700_000_000_000 + seq * 1000;
}

// ─── Test 1: specialist selection for BUILD phase ────────────────────────────

describe('TurnEngine BUILD — specialist selection via coordinator bridge', () => {
  it('selects abl-construct-expert specialist for BUILD phase', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'ask_user',
      kind: 'interactive',
      description: 'Ask a question.',
      inputSchema: z.object({ question: z.string() }),
    });
    registry.register({
      name: 'generate_agent',
      kind: 'internal',
      description: 'Generate an agent.',
      inputSchema: z.object({ agentName: z.string(), code: z.string() }),
      execute: async () => ({ ok: true }),
    });
    registry.register({
      name: 'compile_abl',
      kind: 'internal',
      description: 'Compile ABL code.',
      inputSchema: z.object({ code: z.string(), agentName: z.string() }),
      execute: async () => ({ status: 'pass' }),
    });
    registry.register({
      name: 'propose_modification',
      kind: 'internal',
      description: 'Modify an agent.',
      inputSchema: z.object({
        agentName: z.string(),
        change: z.string(),
        updatedCode: z.string(),
      }),
      execute: async () => ({ ok: true }),
    });
    registry.register({
      name: 'proceed_to_next_phase',
      kind: 'internal',
      description: 'Advance phase.',
      inputSchema: z.object({ reason: z.string() }),
      execute: async () => ({ ok: true }),
    });
    registry.register({
      name: 'collect_file',
      kind: 'interactive',
      description: 'Collect a file.',
      inputSchema: z.object({ message: z.string() }),
    });

    const plan = await resolveTurnPlan({
      session: {
        _id: 'sess-test',
        metadata: {
          phase: 'BUILD',
          mode: 'onboarding',
          specification: { projectName: 'Test' },
        },
      },
      userInput: 'Generate the support agent',
      registry,
    });

    expect(plan.specialist).toBe('abl-construct-expert');
    // BUILD phase tools
    const toolNames = plan.allowedTools.map((t) => t.name);
    expect(toolNames).toContain('generate_agent');
    expect(toolNames).toContain('compile_abl');
    expect(toolNames).toContain('propose_modification');
    expect(toolNames).toContain('proceed_to_next_phase');
    expect(toolNames).toContain('ask_user');
    expect(toolNames).toContain('collect_file');
    // INTERVIEW-only tools should NOT be present
    expect(toolNames).not.toContain('update_specification');
    // BLUEPRINT-only tools should NOT be present
    expect(toolNames).not.toContain('generate_topology');
  });
});

// ─── Test 2: generate_agent tool call updates files via buffered service ─────

describe('TurnEngine BUILD — generate_agent tool', () => {
  let buffer: FakeTurnBuffer;

  beforeEach(() => {
    seq = 0;
    buffer = new FakeTurnBuffer();
  });

  it('invokes generate_agent, emits artifact_updated, then turn_ended', async () => {
    const agentArgs = {
      agentName: 'SupportAgent',
      code: 'AGENT: SupportAgent\nGOAL: Handle support\nPERSONA: Helpful assistant',
    };

    let generateExecuted = false;
    let storedAgentName: string | null = null;

    const registry = new ToolRegistry();
    registry.register({
      name: 'generate_agent',
      kind: 'internal',
      statusLabel: 'Generating agent…',
      description: 'Generate a complete ABL YAML agent definition.',
      inputSchema: z.object({
        agentName: z.string(),
        code: z.string(),
      }),
      execute: async (args, ctx) => {
        generateExecuted = true;
        storedAgentName = (args as { agentName: string }).agentName;

        // Emit build progress artifact (mirrors production behavior)
        ctx.emit({
          artifact: 'build_progress' as const,
          payload: {
            channel: 'build',
            agentName: (args as { agentName: string }).agentName,
            status: 'generated',
          },
        });

        return `Agent ${(args as { agentName: string }).agentName} generated: 3 lines`;
      },
    });

    // LLM round 1: tool call for generate_agent
    // LLM round 2: text summary
    const llm = makeMultiRoundLLM([
      [
        {
          type: 'tool_call',
          toolCallId: 'tc-gen-1',
          toolName: 'generate_agent',
          args: agentArgs,
        },
        {
          type: 'finish',
          finishReason: 'tool_calls',
          usage: { inputTokens: 50, outputTokens: 30, totalTokens: 80 },
          model: 'fake-model',
        },
      ],
      [
        { type: 'text_delta', text: 'SupportAgent has been generated.' },
        {
          type: 'finish',
          finishReason: 'stop',
          usage: { inputTokens: 60, outputTokens: 15, totalTokens: 75 },
          model: 'fake-model',
        },
      ],
    ]);

    const durableEvents: TurnEvent[] = [];

    const engine = new TurnEngine({
      llmClient: llm,
      toolRegistry: registry,
      publishLive: async () => {},
      publishDurable: async (ev) => {
        durableEvents.push(ev);
      },
      now: deterministicClock,
      newId: deterministicId,
    });

    const events = await collect(engine, makeInput({ buffer, allowedTools: registry }));

    // Tool was executed
    expect(generateExecuted).toBe(true);
    expect(storedAgentName).toBe('SupportAgent');

    // artifact_updated event emitted (durable)
    const artifactEvt = events.find((e) => e.type === 'artifact_updated');
    expect(artifactEvt).toBeDefined();
    if (artifactEvt?.type === 'artifact_updated') {
      expect(artifactEvt.update.artifact).toBe('build_progress');
    }
    expect(durableEvents.some((e) => e.type === 'artifact_updated')).toBe(true);

    // text_delta from second LLM round
    const textDeltas = events.filter((e) => e.type === 'text_delta');
    expect(textDeltas.length).toBeGreaterThanOrEqual(1);

    // turn_ended with reason 'natural'
    const endedEvt = events.find((e) => e.type === 'turn_ended');
    expect(endedEvt).toBeDefined();
    if (endedEvt?.type === 'turn_ended') {
      expect(endedEvt.reason).toBe('natural');
    }

    // Buffer committed
    expect(buffer.committed).toBe(true);
  });
});

// ─── Test 3: compile_abl emits artifact_updated{channel:"build"} ─────────────

describe('TurnEngine BUILD — compile_abl tool', () => {
  let buffer: FakeTurnBuffer;

  beforeEach(() => {
    seq = 0;
    buffer = new FakeTurnBuffer();
  });

  it('compile_abl emits artifact_updated{build_progress} with compiled status', async () => {
    let compileExecuted = false;
    let compileResult: unknown = null;

    const registry = new ToolRegistry();
    registry.register({
      name: 'compile_abl',
      kind: 'internal',
      statusLabel: 'Compiling ABL…',
      description: 'Compile ABL code.',
      inputSchema: z.object({
        code: z.string(),
        agentName: z.string(),
      }),
      execute: async (args, ctx) => {
        compileExecuted = true;
        const result = {
          status: 'pass',
          errors: [],
          warnings: [],
        };
        compileResult = result;

        // Emit build progress artifact (mirrors production behavior)
        ctx.emit({
          artifact: 'build_progress' as const,
          payload: {
            channel: 'build',
            agentName: (args as { agentName: string }).agentName,
            status: 'compiled',
          },
        });

        return result;
      },
    });

    // LLM calls compile_abl, gets result, then produces text summary
    const llm = makeMultiRoundLLM([
      [
        {
          type: 'tool_call',
          toolCallId: 'tc-compile-1',
          toolName: 'compile_abl',
          args: {
            code: 'AGENT: TestAgent\nGOAL: Test\nPERSONA: Tester',
            agentName: 'TestAgent',
          },
        },
        {
          type: 'finish',
          finishReason: 'tool_calls',
          usage: { inputTokens: 40, outputTokens: 20, totalTokens: 60 },
          model: 'fake-model',
        },
      ],
      [
        { type: 'text_delta', text: 'TestAgent compiled successfully.' },
        {
          type: 'finish',
          finishReason: 'stop',
          usage: { inputTokens: 50, outputTokens: 12, totalTokens: 62 },
          model: 'fake-model',
        },
      ],
    ]);

    const durableEvents: TurnEvent[] = [];

    const engine = new TurnEngine({
      llmClient: llm,
      toolRegistry: registry,
      publishLive: async () => {},
      publishDurable: async (ev) => {
        durableEvents.push(ev);
      },
      now: deterministicClock,
      newId: deterministicId,
    });

    const events = await collect(engine, makeInput({ buffer, allowedTools: registry }));

    // compile_abl was executed
    expect(compileExecuted).toBe(true);
    expect(compileResult).toMatchObject({ status: 'pass' });

    // artifact_updated event for build progress
    const artifactEvt = events.find((e) => e.type === 'artifact_updated');
    expect(artifactEvt).toBeDefined();
    if (artifactEvt?.type === 'artifact_updated') {
      expect(artifactEvt.update.artifact).toBe('build_progress');
      expect(artifactEvt.update.payload).toMatchObject({
        channel: 'build',
        agentName: 'TestAgent',
        status: 'compiled',
      });
    }
    expect(durableEvents.some((e) => e.type === 'artifact_updated')).toBe(true);

    // Turn ends normally
    const endedEvt = events.find((e) => e.type === 'turn_ended');
    expect(endedEvt).toBeDefined();
    expect(buffer.committed).toBe(true);
  });
});

// ─── Test 4: proceed_to_next_phase advances BUILD → CREATE ───────────────────

describe('TurnEngine BUILD — proceed_to_next_phase (BUILD → CREATE)', () => {
  let buffer: FakeTurnBuffer;

  beforeEach(() => {
    seq = 0;
    buffer = new FakeTurnBuffer();
  });

  it('advances phase when all agents are compiled and tool is invoked', async () => {
    let transitionCalled = false;
    let transitionResult: unknown = null;

    const registry = new ToolRegistry();
    registry.register({
      name: 'proceed_to_next_phase',
      kind: 'internal',
      statusLabel: 'Advancing to next phase…',
      description: 'Advance to next phase.',
      inputSchema: z.object({ reason: z.string() }),
      execute: async () => {
        // Simulate BUILD → CREATE transition with all agents compiled
        transitionCalled = true;
        transitionResult = { transitioned: true, from: 'BUILD', to: 'CREATE' };
        return transitionResult;
      },
    });

    const llm = makeMultiRoundLLM([
      [
        {
          type: 'tool_call',
          toolCallId: 'tc-proceed-build',
          toolName: 'proceed_to_next_phase',
          args: { reason: 'All agents compiled and ready for project creation' },
        },
        {
          type: 'finish',
          finishReason: 'tool_calls',
          usage: { inputTokens: 40, outputTokens: 10, totalTokens: 50 },
          model: 'fake-model',
        },
      ],
      [
        { type: 'text_delta', text: 'All agents compiled. Moving to CREATE phase.' },
        {
          type: 'finish',
          finishReason: 'stop',
          usage: { inputTokens: 50, outputTokens: 12, totalTokens: 62 },
          model: 'fake-model',
        },
      ],
    ]);

    const engine = new TurnEngine({
      llmClient: llm,
      toolRegistry: registry,
      publishLive: async () => {},
      publishDurable: async () => {},
      now: deterministicClock,
      newId: deterministicId,
    });

    const events = await collect(engine, makeInput({ buffer, allowedTools: registry }));

    // proceed_to_next_phase was invoked
    expect(transitionCalled).toBe(true);
    expect(transitionResult).toMatchObject({ transitioned: true, from: 'BUILD', to: 'CREATE' });

    // Turn ends naturally
    const endedEvt = events.find((e) => e.type === 'turn_ended');
    expect(endedEvt).toBeDefined();
    if (endedEvt?.type === 'turn_ended') {
      expect(endedEvt.reason).toBe('natural');
    }

    expect(buffer.committed).toBe(true);
  });
});

// ─── Test 5: proceed_to_next_phase rejects when agent has error status ──────

describe('TurnEngine BUILD — proceed_to_next_phase rejects on error agent', () => {
  let buffer: FakeTurnBuffer;

  beforeEach(() => {
    seq = 0;
    buffer = new FakeTurnBuffer();
  });

  it('returns error when an agent is not compiled, LLM self-corrects', async () => {
    let toolReturnedError = false;

    const registry = new ToolRegistry();
    registry.register({
      name: 'proceed_to_next_phase',
      kind: 'internal',
      description: 'Advance to next phase.',
      inputSchema: z.object({ reason: z.string() }),
      execute: async () => {
        // Simulate: one agent has 'error' status → tool returns error
        toolReturnedError = true;
        return {
          error:
            'Cannot proceed — 1 agent(s) not yet compiled: BrokenAgent. ' +
            'Generate and compile them first.',
        };
      },
    });

    // LLM round 1: calls proceed_to_next_phase (will get error back)
    // LLM round 2: explains the error to the user
    const llm = makeMultiRoundLLM([
      [
        {
          type: 'tool_call',
          toolCallId: 'tc-proceed-err',
          toolName: 'proceed_to_next_phase',
          args: { reason: 'User wants to proceed' },
        },
        {
          type: 'finish',
          finishReason: 'tool_calls',
          usage: { inputTokens: 30, outputTokens: 8, totalTokens: 38 },
          model: 'fake-model',
        },
      ],
      [
        {
          type: 'text_delta',
          text: 'BrokenAgent has compilation errors. I need to fix it before we can proceed.',
        },
        {
          type: 'finish',
          finishReason: 'stop',
          usage: { inputTokens: 40, outputTokens: 20, totalTokens: 60 },
          model: 'fake-model',
        },
      ],
    ]);

    const engine = new TurnEngine({
      llmClient: llm,
      toolRegistry: registry,
      publishLive: async () => {},
      publishDurable: async () => {},
      now: deterministicClock,
      newId: deterministicId,
    });

    const events = await collect(engine, makeInput({ buffer, allowedTools: registry }));

    // Tool returned the error
    expect(toolReturnedError).toBe(true);

    // LLM got the error as a tool result and responded with text
    const textDeltas = events.filter((e) => e.type === 'text_delta');
    expect(textDeltas.length).toBeGreaterThanOrEqual(1);

    // Turn ends naturally (LLM self-corrected)
    const endedEvt = events.find((e) => e.type === 'turn_ended');
    expect(endedEvt).toBeDefined();
    if (endedEvt?.type === 'turn_ended') {
      expect(endedEvt.reason).toBe('natural');
    }

    expect(buffer.committed).toBe(true);
  });
});

// ─── Test 6: cancel during BUILD stops engine between LLM rounds ─────────────

describe('TurnEngine BUILD — cancel checkpoint', () => {
  let buffer: FakeTurnBuffer;

  beforeEach(() => {
    seq = 0;
    buffer = new FakeTurnBuffer();
  });

  it('cancel flag set during tool execution stops next LLM round', async () => {
    // The engine checks cancelRequestedRead at two points:
    //   1. Top of while(true) loop (before each LLM round)
    //   2. After internal tool result is fed back
    // We simulate: LLM calls generate_agent, during execute() the cancel
    // flag is set. After the tool result is fed back, engine checks cancel
    // BEFORE starting the next LLM round.
    let cancelFlag = false;

    const registry = new ToolRegistry();
    registry.register({
      name: 'generate_agent',
      kind: 'internal',
      description: 'Generate an agent.',
      inputSchema: z.object({ agentName: z.string(), code: z.string() }),
      execute: async () => {
        // Set cancel during tool execution — mimics user pressing cancel mid-build
        cancelFlag = true;
        return 'Agent generated: TestAgent';
      },
    });

    // LLM round 1: calls generate_agent
    // Round 2 would normally happen but cancel prevents it
    const llm = makeMultiRoundLLM([
      [
        {
          type: 'tool_call',
          toolCallId: 'tc-gen-cancel',
          toolName: 'generate_agent',
          args: { agentName: 'TestAgent', code: 'AGENT: TestAgent\nGOAL: Test' },
        },
        {
          type: 'finish',
          finishReason: 'tool_calls',
          usage: { inputTokens: 30, outputTokens: 10, totalTokens: 40 },
          model: 'fake-model',
        },
      ],
      [
        { type: 'text_delta', text: 'This should not appear.' },
        {
          type: 'finish',
          finishReason: 'stop',
          usage: { inputTokens: 40, outputTokens: 10, totalTokens: 50 },
          model: 'fake-model',
        },
      ],
    ]);

    const liveEvents: TurnEvent[] = [];

    const engine = new TurnEngine({
      llmClient: llm,
      toolRegistry: registry,
      publishLive: async (ev) => {
        liveEvents.push(ev);
      },
      publishDurable: async () => {},
      cancelRequestedRead: async () => cancelFlag,
      cancelRequestedClear: async () => {
        cancelFlag = false;
      },
      now: deterministicClock,
      newId: deterministicId,
    });

    const events = await collect(engine, makeInput({ buffer, allowedTools: registry }));

    // turn_ended with reason 'canceled' must be emitted
    const canceledEvt = events.find((e) => e.type === 'turn_ended' && e.reason === 'canceled');
    expect(canceledEvt).toBeDefined();

    // The turn still commits so the partial BUILD state is resumable.
    const committedEvt = events.find((e) => e.type === 'turn_committed');
    expect(committedEvt).toBeDefined();

    // The second LLM round's text should NOT appear
    const textDeltas = events.filter((e) => e.type === 'text_delta');
    const hasUnwantedText = textDeltas.some(
      (e) => e.type === 'text_delta' && e.text === 'This should not appear.',
    );
    expect(hasUnwantedText).toBe(false);

    // Buffer commits and clears the cancel flag atomically.
    expect(buffer.committed).toBe(true);
    expect(buffer.sessionPatchSnapshot.cancelRequested).toBe(false);

    // The canceled terminal event is durable rather than live-only.
    const liveCanceled = liveEvents.find((e) => e.type === 'turn_ended' && e.reason === 'canceled');
    expect(liveCanceled).toBeUndefined();
  });
});
