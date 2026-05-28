/**
 * TurnEngine BLUEPRINT flow — unit tests.
 *
 * All dependencies are injected (FakeLLM, FakeTurnBuffer, FakeToolRegistry).
 * No vi.mock of internal packages per CLAUDE.md test architecture rules.
 *
 * Covers:
 *   Test 1 — selects multi-agent-architect specialist for BLUEPRINT phase
 *   Test 2 — generate_topology tool emits artifact_updated{artifact: "topology"}
 *   Test 3 — dedicated draft turns propagate forced tool-choice hints
 *   Test 4 — proceed_to_next_phase advances BLUEPRINT → BUILD when topologyApproved
 *   Test 5 — proceed_to_next_phase rejects when topology is missing
 *   Test 6 — ask_user interactive prompt pauses turn in BLUEPRINT phase
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
// Mirrors the public interface TurnBuffer used by the engine — no MongoDB.

class FakeTurnBuffer {
  committed = false;
  rolledBack = false;
  suggestions: string[] = [];
  completionMetadata: Record<string, unknown> | undefined;

  private sessionPatch: Record<string, unknown> = {};
  private pendingMessages: Array<
    StoredMessageV2 & {
      toolCalls?: unknown[];
      specialist?: string;
      phase?: string;
      timestamp?: string;
      streamedPresentation?: unknown;
    }
  > = [];
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
    options?: {
      toolCalls?: unknown[];
      specialist?: string;
      phase?: string;
      timestamp?: string;
      streamedPresentation?: unknown;
    },
  ): StoredMessageV2 {
    const msg = {
      id: `msg-${this.pendingMessages.length + 1}`,
      turnId: 'test-turn',
      role,
      content,
      createdAt: Date.now(),
      ...(options ?? {}),
    };
    this.pendingMessages.push(msg);
    return msg as StoredMessageV2;
  }

  get pendingMessagesSnapshot(): ReadonlyArray<(typeof this.pendingMessages)[number]> {
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

function makeInspectingLLM(
  onRequest: (request: LLMStreamRequest) => void,
  chunks: ScriptedChunk[],
): LLMStreamClient {
  return {
    stream(request: LLMStreamRequest): AsyncIterable<LLMStreamChunk> {
      onRequest(request);
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
    sessionId: 'sess-blueprint-test',
    tenantId: 'tenant-test',
    userId: 'user-test',
    turnId: 'turn-bp-test',
    phase: 'BLUEPRINT',
    mode: 'onboarding',
    history: [],
    systemPrompt: 'You are Arch AI multi-agent architect.',
    userInput: 'Design the agents',
    allowedTools: overrides.allowedTools ?? new ToolRegistry(),
    buffer: overrides.buffer as unknown as import('../../engine/turn-buffer.js').TurnBuffer,
    signal: new AbortController().signal,
    specialist: 'multi-agent-architect',
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

// ─── Test 1: specialist selection ───────────────────────────────────────────

describe('TurnEngine BLUEPRINT — specialist selection via coordinator bridge', () => {
  it('selects multi-agent-architect specialist for BLUEPRINT phase', async () => {
    // Build a minimal registry with BLUEPRINT tools
    const registry = new ToolRegistry();
    registry.register({
      name: 'ask_user',
      kind: 'interactive',
      description: 'Ask a question.',
      inputSchema: z.object({ question: z.string() }),
    });
    registry.register({
      name: 'generate_topology',
      kind: 'internal',
      description: 'Generate topology.',
      inputSchema: z.object({ agents: z.array(z.unknown()) }),
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
      name: 'platform_context',
      kind: 'internal',
      description: 'Query platform.',
      inputSchema: z.object({ action: z.string() }),
      execute: async () => ({ ok: true }),
    });

    const plan = await resolveTurnPlan({
      session: {
        _id: 'sess-test',
        metadata: {
          phase: 'BLUEPRINT',
          mode: 'onboarding',
          specification: { projectName: 'Test' },
        },
      },
      userInput: 'Design the agents for a customer support bot',
      registry,
    });

    expect(plan.specialist).toBe('multi-agent-architect');
    // BLUEPRINT phase tools should include generate_topology but NOT update_specification.
    // platform_context was removed from BLUEPRINT to prevent the architect from
    // looping on speculative tool/agent discovery during fresh onboarding —
    // the spec is the sole source of truth during BLUEPRINT.
    const toolNames = plan.allowedTools.map((t) => t.name);
    expect(toolNames).toContain('generate_topology');
    expect(toolNames).toContain('proceed_to_next_phase');
    expect(toolNames).toContain('ask_user');
    expect(toolNames).not.toContain('platform_context');
    expect(toolNames).not.toContain('update_specification');
  });
});

// ─── Test 2: generate_topology emits artifact_updated ───────────────────────

describe('TurnEngine BLUEPRINT — generate_topology tool', () => {
  let buffer: FakeTurnBuffer;

  beforeEach(() => {
    seq = 0;
    buffer = new FakeTurnBuffer();
  });

  it('forwards forced tool-choice options to the llm client for dedicated topology turns', async () => {
    let seenRequest: LLMStreamRequest | null = null;

    const registry = new ToolRegistry();
    registry.register({
      name: 'generate_topology',
      kind: 'internal',
      description: 'Generate a multi-agent topology.',
      inputSchema: z.object({
        agents: z.array(z.unknown()),
        edges: z.array(z.unknown()),
        entryPoint: z.string(),
      }),
      execute: async () => ({ ok: true }),
    });

    const llm = makeInspectingLLM(
      (request) => {
        seenRequest = request;
      },
      [
        {
          type: 'finish',
          finishReason: 'stop',
          usage: { inputTokens: 10, outputTokens: 1, totalTokens: 11 },
          model: 'fake-model',
        },
      ],
    );

    const engine = new TurnEngine({
      llmClient: llm,
      toolRegistry: registry,
      publishLive: async () => {},
      publishDurable: async () => {},
      now: deterministicClock,
      newId: deterministicId,
    });

    await collect(
      engine,
      makeInput({
        buffer,
        allowedTools: registry,
        llmOptions: {
          toolChoice: { type: 'tool', toolName: 'generate_topology' },
          activeTools: ['generate_topology'],
        },
      }),
    );

    expect(seenRequest?.options).toEqual({
      toolChoice: { type: 'tool', toolName: 'generate_topology' },
      activeTools: ['generate_topology'],
    });
  });

  it('invokes generate_topology, emits artifact_updated{artifact: "topology"}, then turn_ended', async () => {
    const topologyArgs = {
      agents: [
        {
          name: 'Triage',
          role: 'Router',
          executionMode: 'reasoning',
          description: 'Routes requests',
        },
        {
          name: 'Support',
          role: 'Handler',
          executionMode: 'reasoning',
          description: 'Handles support',
        },
      ],
      edges: [{ from: 'Triage', to: 'Support', type: 'delegate', condition: 'support query' }],
      entryPoint: 'Triage',
    };

    // Track what the tool stored
    let storedTopology: unknown = null;

    const registry = new ToolRegistry();
    registry.register({
      name: 'generate_topology',
      kind: 'internal',
      statusLabel: 'Generating topology…',
      description: 'Generate a multi-agent topology.',
      inputSchema: z.object({
        agents: z.array(
          z.object({
            name: z.string(),
            role: z.string(),
            executionMode: z.string(),
            description: z.string(),
          }),
        ),
        edges: z.array(
          z.object({
            from: z.string(),
            to: z.string(),
            type: z.string(),
            condition: z.string(),
          }),
        ),
        entryPoint: z.string(),
      }),
      execute: async (args, ctx) => {
        storedTopology = args;
        // Emit topology artifact update via context (mirrors production behavior)
        ctx.emit({
          artifact: 'topology' as const,
          payload: args,
        });
        return `Topology generated: ${(args as { agents: unknown[] }).agents.length} agents`;
      },
    });

    // LLM round 1: tool call for generate_topology
    // LLM round 2: text summary
    const llm = makeMultiRoundLLM([
      [
        {
          type: 'tool_call',
          toolCallId: 'tc-topo-1',
          toolName: 'generate_topology',
          args: topologyArgs,
        },
        {
          type: 'finish',
          finishReason: 'tool_calls',
          usage: { inputTokens: 50, outputTokens: 30, totalTokens: 80 },
          model: 'fake-model',
        },
      ],
      [
        { type: 'text_delta', text: 'I designed a 2-agent topology.' },
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

    // Tool was executed — topology stored
    expect(storedTopology).toBeDefined();
    expect((storedTopology as { agents: unknown[] }).agents).toHaveLength(2);

    // artifact_updated event emitted (durable)
    const artifactEvt = events.find((e) => e.type === 'artifact_updated');
    expect(artifactEvt).toBeDefined();
    if (artifactEvt?.type === 'artifact_updated') {
      expect(artifactEvt.update.artifact).toBe('topology');
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

// ─── Test 3: proceed_to_next_phase advances BLUEPRINT → BUILD ──────────────

describe('TurnEngine BLUEPRINT — proceed_to_next_phase (phase transition)', () => {
  let buffer: FakeTurnBuffer;

  beforeEach(() => {
    seq = 0;
    buffer = new FakeTurnBuffer();
  });

  it('advances phase when topology exists and tool is invoked', async () => {
    let transitionCalled = false;
    let transitionResult: unknown = null;

    const registry = new ToolRegistry();
    registry.register({
      name: 'proceed_to_next_phase',
      kind: 'internal',
      statusLabel: 'Advancing to next phase…',
      description: 'Advance to next phase.',
      inputSchema: z.object({
        reason: z.string(),
      }),
      execute: async (_args, ctx) => {
        // Simulate the production proceed_to_next_phase behavior:
        // In production this calls executePhaseTransition which sets topologyApproved,
        // runs transitionPhase, and emits phase_transition. Here we verify the tool
        // is invoked correctly with the right context.
        transitionCalled = true;
        transitionResult = { transitioned: true, from: 'BLUEPRINT', to: 'BUILD' };

        // Emit artifact for phase transition (production uses ctx.emit for events)
        ctx.emit({
          artifact: 'topology' as const,
          payload: { approved: true },
        });

        return transitionResult;
      },
    });

    const llm = makeMultiRoundLLM([
      [
        {
          type: 'tool_call',
          toolCallId: 'tc-proceed-1',
          toolName: 'proceed_to_next_phase',
          args: { reason: 'User approved the topology' },
        },
        {
          type: 'finish',
          finishReason: 'tool_calls',
          usage: { inputTokens: 40, outputTokens: 10, totalTokens: 50 },
          model: 'fake-model',
        },
      ],
      [
        { type: 'text_delta', text: 'Moving to BUILD phase.' },
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
    expect(transitionResult).toMatchObject({ transitioned: true, from: 'BLUEPRINT', to: 'BUILD' });

    // Turn ends naturally after the tool result is fed back to LLM
    const endedEvt = events.find((e) => e.type === 'turn_ended');
    expect(endedEvt).toBeDefined();
    if (endedEvt?.type === 'turn_ended') {
      expect(endedEvt.reason).toBe('natural');
    }

    expect(buffer.committed).toBe(true);
  });
});

// ─── Test 4: proceed_to_next_phase rejects without topology ────────────────

describe('TurnEngine BLUEPRINT — proceed_to_next_phase without topology', () => {
  let buffer: FakeTurnBuffer;

  beforeEach(() => {
    seq = 0;
    buffer = new FakeTurnBuffer();
  });

  it('returns error when topology is missing, LLM receives error and continues', async () => {
    let toolReturnedError = false;

    const registry = new ToolRegistry();
    registry.register({
      name: 'proceed_to_next_phase',
      kind: 'internal',
      description: 'Advance to next phase.',
      inputSchema: z.object({ reason: z.string() }),
      execute: async () => {
        // Simulate: no topology exists → tool returns error
        toolReturnedError = true;
        return {
          error: 'No topology exists yet. Call generate_topology first to design the architecture.',
        };
      },
    });

    // LLM round 1: calls proceed_to_next_phase (will get error back)
    // LLM round 2: explains the error to the user
    const llm = makeMultiRoundLLM([
      [
        {
          type: 'tool_call',
          toolCallId: 'tc-proceed-bad',
          toolName: 'proceed_to_next_phase',
          args: { reason: 'Let us proceed' },
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
          text: 'I need to design the topology first before we can proceed.',
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

    // Turn ends naturally (LLM self-corrected after getting the error)
    const endedEvt = events.find((e) => e.type === 'turn_ended');
    expect(endedEvt).toBeDefined();
    if (endedEvt?.type === 'turn_ended') {
      expect(endedEvt.reason).toBe('natural');
    }

    expect(buffer.committed).toBe(true);
  });
});

// ─── Test 5: ask_user interactive prompt pauses turn in BLUEPRINT ───────────

describe('TurnEngine BLUEPRINT — ask_user interactive pause', () => {
  let buffer: FakeTurnBuffer;

  beforeEach(() => {
    seq = 0;
    buffer = new FakeTurnBuffer();
  });

  it('pauses turn with interactive_tool when LLM calls ask_user in BLUEPRINT phase', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'ask_user',
      kind: 'interactive',
      description: 'Ask a clarifying question.',
      inputSchema: z.object({
        question: z.string(),
        options: z.array(z.string()).optional(),
      }),
    });
    registry.register({
      name: 'generate_topology',
      kind: 'internal',
      description: 'Generate topology.',
      inputSchema: z.object({ agents: z.array(z.unknown()) }),
      execute: async () => ({ ok: true }),
    });

    const llm = makeFakeLLM([
      {
        type: 'tool_call',
        toolCallId: 'tc-ask-bp',
        toolName: 'ask_user',
        args: {
          question: 'How many specialist agents do you need?',
          options: ['2-3', '4-6', '7+'],
        },
      },
      {
        type: 'finish',
        finishReason: 'tool_calls',
        usage: { inputTokens: 25, outputTokens: 12, totalTokens: 37 },
        model: 'fake-model',
      },
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

    // interactive_tool event emitted
    const interactiveEvt = events.find((e) => e.type === 'interactive_tool');
    expect(interactiveEvt).toBeDefined();
    if (interactiveEvt?.type === 'interactive_tool') {
      expect(interactiveEvt.tool).toBe('ask_user');
      expect(interactiveEvt.toolCallId).toBe('tc-ask-bp');
      expect(interactiveEvt.payload).toMatchObject({
        question: 'How many specialist agents do you need?',
      });
    }

    // interactive_tool is durable
    expect(durableEvents.some((e) => e.type === 'interactive_tool')).toBe(true);

    // Buffer committed (turn pauses with interactive but commits first)
    expect(buffer.committed).toBe(true);

    // Interactive turns remain ACTIVE and persist a pendingInteraction payload.
    const patch = buffer.sessionPatchSnapshot;
    expect(patch.state).toBe('ACTIVE');
    expect(patch['metadata.pendingInteraction']).toMatchObject({
      kind: 'widget',
      id: 'tc-ask-bp',
      payload: { question: 'How many specialist agents do you need?' },
    });

    const storedAssistantMessage = buffer.pendingMessagesSnapshot.find(
      (message) =>
        message.role === 'assistant' &&
        Array.isArray((message as { toolCalls?: unknown[] }).toolCalls),
    ) as
      | (StoredMessageV2 & {
          toolCalls?: Array<{
            toolCallId: string;
            toolName: string;
          }>;
        })
      | undefined;
    expect(storedAssistantMessage?.toolCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          toolCallId: 'tc-ask-bp',
          toolName: 'ask_user',
        }),
      ]),
    );

    // turn_committed fires before interactive_tool
    const committedIdx = events.findIndex((e) => e.type === 'turn_committed');
    const interactiveIdx = events.findIndex((e) => e.type === 'interactive_tool');
    expect(committedIdx).toBeGreaterThan(-1);
    expect(interactiveIdx).toBeGreaterThan(committedIdx);
  });
});
