/**
 * TurnEngine INTERVIEW flow — unit tests.
 *
 * All dependencies are injected (FakeLLM, FakeTurnBuffer, FakeToolRegistry).
 * No vi.mock of internal packages per CLAUDE.md test architecture rules.
 *
 * Covers:
 *   Test 1 — plain text response (turn_started → text_delta* → turn_committed → turn_ended)
 *   Test 2 — client-side tool pause (interactive_tool + pendingInteraction → turn_ended)
 *   Test 3 — server-side tool round-trip (tool invoke → artifact_update → turn_ended)
 *   Test 4 — cancel mid-stream (partial turn is committed with reason:canceled)
 *   Test 5 — abort mid-stream (partial turn is committed with reason:interrupted)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { z } from 'zod';

import { TurnEngine } from '../../engine/turn-engine.js';
import { ToolRegistry } from '../../tools/v2/registry.js';
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

  // Whether commit() should throw (simulates DB failure).
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

    // Execute any pending project writes (for Test 3 — update_specification)
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

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Collect all events emitted by runTurn into an array. */
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

/** Build a baseline RunTurnInput — override specific fields per test. */
function makeInput(
  overrides: Partial<Parameters<TurnEngine['runTurn']>[0]> & {
    buffer: FakeTurnBuffer;
    llmClient?: LLMStreamClient;
    allowedTools?: ToolRegistry;
  },
): Parameters<TurnEngine['runTurn']>[0] {
  return {
    sessionId: 'sess-test',
    tenantId: 'tenant-test',
    userId: 'user-test',
    turnId: 'turn-test',
    phase: 'INTERVIEW',
    mode: 'onboarding',
    history: [],
    systemPrompt: 'You are Arch AI.',
    userInput: 'Hello',
    allowedTools: overrides.allowedTools ?? new ToolRegistry(),
    buffer: overrides.buffer as unknown as import('../../engine/turn-buffer.js').TurnBuffer,
    signal: new AbortController().signal,
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

// ─── Test 1: plain text response ─────────────────────────────────────────────

describe('TurnEngine INTERVIEW — plain text response', () => {
  let buffer: FakeTurnBuffer;
  let liveEvents: TurnEvent[];
  let durableEvents: TurnEvent[];

  beforeEach(() => {
    seq = 0;
    buffer = new FakeTurnBuffer();
    liveEvents = [];
    durableEvents = [];
  });

  it('emits turn_started → text_delta* → turn_committed → turn_ended', async () => {
    const llm = makeFakeLLM([
      { type: 'text_delta', text: 'Hello, ' },
      { type: 'text_delta', text: 'welcome!' },
      {
        type: 'finish',
        finishReason: 'stop',
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        model: 'fake-model',
      },
    ]);

    const engine = new TurnEngine({
      llmClient: llm,
      toolRegistry: new ToolRegistry(),
      publishLive: async (ev) => {
        liveEvents.push(ev);
      },
      publishDurable: async (ev) => {
        durableEvents.push(ev);
      },
      now: deterministicClock,
      newId: deterministicId,
    });

    const events = await collect(engine, makeInput({ buffer, llmClient: llm }));

    // turn_started must be first
    expect(events[0].type).toBe('turn_started');

    // At least one text_delta
    const textDeltas = events.filter((e) => e.type === 'text_delta');
    expect(textDeltas.length).toBeGreaterThanOrEqual(1);

    // turn_committed fires before turn_ended
    const committedIdx = events.findIndex((e) => e.type === 'turn_committed');
    const endedIdx = events.findIndex((e) => e.type === 'turn_ended');
    expect(committedIdx).toBeGreaterThan(-1);
    expect(endedIdx).toBeGreaterThan(committedIdx);

    // turn_ended has reason 'natural'
    const endedEvent = events[endedIdx];
    expect(endedEvent.type).toBe('turn_ended');
    if (endedEvent.type === 'turn_ended') {
      expect(endedEvent.reason).toBe('natural');
    }

    // Buffer committed
    expect(buffer.committed).toBe(true);

    // turn_started is live (not durable)
    expect(liveEvents.some((e) => e.type === 'turn_started')).toBe(true);
    // turn_committed is durable
    expect(durableEvents.some((e) => e.type === 'turn_committed')).toBe(true);
    // turn_ended is durable
    expect(durableEvents.some((e) => e.type === 'turn_ended')).toBe(true);
  });
});

// ─── Test 2: client-side tool pause ──────────────────────────────────────────

describe('TurnEngine INTERVIEW — client-side tool pause (ask_user)', () => {
  let buffer: FakeTurnBuffer;

  beforeEach(() => {
    seq = 0;
    buffer = new FakeTurnBuffer();
  });

  it('emits interactive_tool (durable) and ends the turn after commit', async () => {
    // Register ask_user as an interactive tool
    const registry = new ToolRegistry();
    registry.register({
      name: 'ask_user',
      kind: 'interactive',
      description: 'Pause and ask the user a question.',
      inputSchema: z.object({ question: z.string() }),
    });

    const llm = makeFakeLLM([
      {
        type: 'tool_call',
        toolCallId: 'tc-1',
        toolName: 'ask_user',
        args: { question: 'What name?' },
      },
      {
        type: 'finish',
        finishReason: 'tool_calls',
        usage: { inputTokens: 8, outputTokens: 3, totalTokens: 11 },
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
      expect(interactiveEvt.toolCallId).toBe('tc-1');
      expect(interactiveEvt.payload).toMatchObject({ question: 'What name?' });
    }

    // interactive_tool is durable
    expect(durableEvents.some((e) => e.type === 'interactive_tool')).toBe(true);

    // Buffer committed (turn pauses with interactive, but still commits before pause)
    expect(buffer.committed).toBe(true);

    // Interactive turns remain ACTIVE and persist a pendingInteraction payload.
    const patch = buffer.sessionPatchSnapshot;
    expect(patch.state).toBe('ACTIVE');
    expect(patch['metadata.pendingInteraction']).toMatchObject({
      kind: 'widget',
      id: 'tc-1',
      payload: { question: 'What name?' },
    });

    // turn_ended emitted (because the engine returns after interactive commit)
    // Note: the engine doesn't emit a separate turn_ended after interactive pause;
    // it returns after flushing [turn_committed, interactive_tool]. The last yielded
    // event should be interactive_tool (after committed is flushed).
    const lastEvent = events[events.length - 1];
    // The engine emits: turn_started (live), then after commit: [turn_committed, interactive_tool] (durable)
    expect(['interactive_tool', 'turn_committed']).toContain(lastEvent.type);

    // turn_committed must fire before interactive_tool
    const committedIdx = events.findIndex((e) => e.type === 'turn_committed');
    const interactiveIdx = events.findIndex((e) => e.type === 'interactive_tool');
    expect(committedIdx).toBeGreaterThan(-1);
    expect(interactiveIdx).toBeGreaterThan(committedIdx);
  });
});

// ─── Test 3: server-side tool round-trip ─────────────────────────────────────

describe('TurnEngine INTERVIEW — server-side tool round-trip (update_specification)', () => {
  let buffer: FakeTurnBuffer;

  beforeEach(() => {
    seq = 0;
    buffer = new FakeTurnBuffer();
  });

  it('invokes tool, emits artifact_updated (durable), then continues to turn_ended', async () => {
    const specPatches: unknown[] = [];

    // Register update_specification as an internal tool
    const registry = new ToolRegistry();
    registry.register({
      name: 'update_specification',
      kind: 'internal',
      description: 'Update the spec document.',
      statusLabel: 'Updating specification…',
      inputSchema: z.object({
        patches: z.array(z.object({ path: z.string(), value: z.unknown() })),
      }),
      execute: async (args, ctx) => {
        // Emit a spec artifact update via the context
        ctx.emit({
          artifact: 'spec' as const,
          version: 1,
          patches: (args as { patches: Array<{ path: string; value: unknown }> }).patches.map(
            (p) => ({
              path: p.path,
              value: p.value,
              op: 'set' as const,
            }),
          ),
        });
        specPatches.push(...(args as { patches: Array<{ path: string; value: unknown }> }).patches);
        return { ok: true };
      },
    });

    // First LLM call: emits tool call
    // Second LLM call (after tool result fed back): emits final text
    let callCount = 0;
    const firstCallChunks: ScriptedChunk[] = [
      {
        type: 'tool_call',
        toolCallId: 'tc-spec-1',
        toolName: 'update_specification',
        args: { patches: [{ path: 'name', value: 'My Project' }] },
      },
      {
        type: 'finish',
        finishReason: 'tool_calls',
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        model: 'fake-model',
      },
    ];
    const secondCallChunks: ScriptedChunk[] = [
      { type: 'text_delta', text: 'Spec updated!' },
      {
        type: 'finish',
        finishReason: 'stop',
        usage: { inputTokens: 20, outputTokens: 3, totalTokens: 23 },
        model: 'fake-model',
      },
    ];

    const llm: LLMStreamClient = {
      stream(_req: LLMStreamRequest): AsyncIterable<LLMStreamChunk> {
        const chunks = callCount === 0 ? firstCallChunks : secondCallChunks;
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

    // At least one text_delta from the second LLM round
    const textDeltas = events.filter((e) => e.type === 'text_delta');
    expect(textDeltas.length).toBeGreaterThanOrEqual(1);

    // artifact_updated event emitted (durable)
    const artifactEvt = events.find((e) => e.type === 'artifact_updated');
    expect(artifactEvt).toBeDefined();
    if (artifactEvt?.type === 'artifact_updated') {
      expect(artifactEvt.update.artifact).toBe('spec');
    }
    expect(durableEvents.some((e) => e.type === 'artifact_updated')).toBe(true);

    // turn_ended is 'natural'
    const endedEvt = events.find((e) => e.type === 'turn_ended');
    expect(endedEvt).toBeDefined();
    if (endedEvt?.type === 'turn_ended') {
      expect(endedEvt.reason).toBe('natural');
    }

    // Tool was actually executed (patches collected)
    expect(specPatches.length).toBeGreaterThan(0);

    const storedAssistantMessage = buffer.pendingMessagesSnapshot.find(
      (message) =>
        message.role === 'assistant' &&
        Array.isArray((message as { toolCalls?: unknown[] }).toolCalls),
    ) as
      | (StoredMessageV2 & {
          toolCalls?: Array<{
            toolCallId: string;
            toolName: string;
            result?: unknown;
          }>;
        })
      | undefined;
    expect(storedAssistantMessage?.toolCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          toolCallId: 'tc-spec-1',
          toolName: 'update_specification',
          result: expect.objectContaining({
            summary: expect.stringContaining('ok'),
          }),
        }),
      ]),
    );

    // Buffer committed
    expect(buffer.committed).toBe(true);

    // LLM called twice (first round: tool call, second round: text)
    expect(callCount).toBe(2);
  });

  it('feeds multiple internal tool calls from one step back as a single assistant tool-call message', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'first_tool',
      kind: 'internal',
      description: 'First internal tool.',
      inputSchema: z.object({ value: z.string() }),
      execute: async (args) => ({ ok: true, seen: args }),
    });
    registry.register({
      name: 'second_tool',
      kind: 'internal',
      description: 'Second internal tool.',
      inputSchema: z.object({ value: z.string() }),
      execute: async (args) => ({ ok: true, seen: args }),
    });

    const requestMessages: Array<LLMStreamRequest['messages']> = [];
    let callCount = 0;
    const llm: LLMStreamClient = {
      stream(req: LLMStreamRequest): AsyncIterable<LLMStreamChunk> {
        requestMessages.push(
          JSON.parse(JSON.stringify(req.messages)) as LLMStreamRequest['messages'],
        );
        const chunks: LLMStreamChunk[] =
          callCount++ === 0
            ? [
                { type: 'text_delta', text: 'Checking tools...' },
                {
                  type: 'tool_call',
                  toolCallId: 'tc-1',
                  toolName: 'first_tool',
                  args: { value: 'alpha' },
                },
                {
                  type: 'tool_call',
                  toolCallId: 'tc-2',
                  toolName: 'second_tool',
                  args: { value: 'beta' },
                },
                {
                  type: 'finish',
                  finishReason: 'tool_calls',
                  usage: { inputTokens: 12, outputTokens: 6, totalTokens: 18 },
                  model: 'fake-model',
                },
              ]
            : [
                { type: 'text_delta', text: 'Done.' },
                {
                  type: 'finish',
                  finishReason: 'stop',
                  usage: { inputTokens: 18, outputTokens: 4, totalTokens: 22 },
                  model: 'fake-model',
                },
              ];

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

    const engine = new TurnEngine({
      llmClient: llm,
      toolRegistry: registry,
      publishLive: async () => {},
      publishDurable: async () => {},
      now: deterministicClock,
      newId: deterministicId,
    });

    await collect(engine, makeInput({ buffer, allowedTools: registry }));

    expect(callCount).toBe(2);
    expect(requestMessages).toHaveLength(2);

    const secondRoundMessages = requestMessages[1];
    const assistantToolMessage = secondRoundMessages.find(
      (message) => message.role === 'assistant' && Array.isArray(message.toolCalls),
    );
    expect(assistantToolMessage).toMatchObject({
      role: 'assistant',
      content: 'Checking tools...',
      toolCalls: [
        { id: 'tc-1', name: 'first_tool', args: { value: 'alpha' } },
        { id: 'tc-2', name: 'second_tool', args: { value: 'beta' } },
      ],
    });

    const toolMessages = secondRoundMessages.filter((message) => message.role === 'tool');
    expect(toolMessages).toHaveLength(2);
    expect(toolMessages).toMatchObject([
      { role: 'tool', toolCallId: 'tc-1' },
      { role: 'tool', toolCallId: 'tc-2' },
    ]);
  });

  it('fails fast when the provider claims tool calls but emits none', async () => {
    const llm = makeFakeLLM([
      {
        type: 'finish',
        finishReason: 'tool_calls',
        usage: { inputTokens: 5, outputTokens: 0, totalTokens: 5 },
        model: 'fake-model',
      },
    ]);

    const liveEvents: TurnEvent[] = [];
    const durableEvents: TurnEvent[] = [];
    const engine = new TurnEngine({
      llmClient: llm,
      toolRegistry: new ToolRegistry(),
      publishLive: async (ev) => {
        liveEvents.push(ev);
      },
      publishDurable: async (ev) => {
        durableEvents.push(ev);
      },
      now: deterministicClock,
      newId: deterministicId,
    });

    const events = await collect(engine, makeInput({ buffer, llmClient: llm }));

    const errorEvent = events.find((event) => event.type === 'error');
    expect(errorEvent).toBeDefined();
    if (errorEvent?.type === 'error') {
      expect(errorEvent.error.code).toBe('MODEL_TOOL_PROTOCOL_ERROR');
    }

    const endedEvent = events.find((event) => event.type === 'turn_ended');
    expect(endedEvent).toBeDefined();
    if (endedEvent?.type === 'turn_ended') {
      expect(endedEvent.reason).toBe('model_provider_error');
    }

    expect(liveEvents.some((event) => event.type === 'error')).toBe(true);
    expect(durableEvents.some((event) => event.type === 'turn_ended')).toBe(true);
    expect(buffer.committed).toBe(true);
  });

  it('surfaces an error when the provider ends with no text, tools, or artifacts', async () => {
    const llm = makeFakeLLM([
      {
        type: 'finish',
        finishReason: 'stop',
        usage: { inputTokens: 5, outputTokens: 0, totalTokens: 5 },
        model: 'fake-model',
      },
    ]);

    const liveEvents: TurnEvent[] = [];
    const durableEvents: TurnEvent[] = [];
    const engine = new TurnEngine({
      llmClient: llm,
      toolRegistry: new ToolRegistry(),
      publishLive: async (ev) => {
        liveEvents.push(ev);
      },
      publishDurable: async (ev) => {
        durableEvents.push(ev);
      },
      now: deterministicClock,
      newId: deterministicId,
    });

    const events = await collect(engine, makeInput({ buffer, llmClient: llm }));

    const errorEvent = events.find((event) => event.type === 'error');
    expect(errorEvent).toBeDefined();
    if (errorEvent?.type === 'error') {
      expect(errorEvent.error).toMatchObject({
        code: 'EMPTY_ASSISTANT_RESPONSE',
        retryable: true,
      });
    }

    const endedEvent = events.find((event) => event.type === 'turn_ended');
    expect(endedEvent).toBeDefined();
    if (endedEvent?.type === 'turn_ended') {
      expect(endedEvent.reason).toBe('model_provider_error');
      expect(endedEvent.error).toMatchObject({
        code: 'EMPTY_ASSISTANT_RESPONSE',
      });
    }

    expect(liveEvents.some((event) => event.type === 'error')).toBe(true);
    expect(durableEvents.some((event) => event.type === 'turn_ended')).toBe(true);
    expect(buffer.committed).toBe(true);
  });

  it('commits streamed text when the provider ends with a stale tool-call finish reason', async () => {
    const llm = makeFakeLLM([
      { type: 'text_delta', text: 'Here is the completed audit summary.' },
      {
        type: 'finish',
        finishReason: 'tool_calls',
        usage: { inputTokens: 5, outputTokens: 7, totalTokens: 12 },
        model: 'fake-model',
      },
    ]);

    const liveEvents: TurnEvent[] = [];
    const durableEvents: TurnEvent[] = [];
    const engine = new TurnEngine({
      llmClient: llm,
      toolRegistry: new ToolRegistry(),
      publishLive: async (ev) => {
        liveEvents.push(ev);
      },
      publishDurable: async (ev) => {
        durableEvents.push(ev);
      },
      now: deterministicClock,
      newId: deterministicId,
    });

    const events = await collect(engine, makeInput({ buffer, llmClient: llm }));

    expect(events.some((event) => event.type === 'error')).toBe(false);
    expect(liveEvents.some((event) => event.type === 'error')).toBe(false);

    const endedEvent = events.find((event) => event.type === 'turn_ended');
    expect(endedEvent).toBeDefined();
    if (endedEvent?.type === 'turn_ended') {
      expect(endedEvent.reason).toBe('natural');
    }

    expect(durableEvents.some((event) => event.type === 'turn_ended')).toBe(true);
    expect(buffer.committed).toBe(true);
  });

  it('retries for a visible answer after a valid tool round-trip when the provider repeats an empty stale tool-call finish reason', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'inspect_project',
      kind: 'internal',
      description: 'Inspect project context.',
      inputSchema: z.object({ projectId: z.string() }),
      execute: async (args) => ({ ok: true, inspected: args }),
    });

    let callCount = 0;
    const llm: LLMStreamClient = {
      stream(_req: LLMStreamRequest): AsyncIterable<LLMStreamChunk> {
        const round = callCount++;
        const chunks: LLMStreamChunk[] =
          round === 0
            ? [
                {
                  type: 'tool_call',
                  toolCallId: 'tc-inspect-1',
                  toolName: 'inspect_project',
                  args: { projectId: 'project-test' },
                },
                {
                  type: 'finish',
                  finishReason: 'tool_calls',
                  usage: { inputTokens: 12, outputTokens: 4, totalTokens: 16 },
                  model: 'fake-model',
                },
              ]
            : round === 1
              ? [
                  {
                    type: 'finish',
                    finishReason: 'tool_calls',
                    usage: { inputTokens: 16, outputTokens: 0, totalTokens: 16 },
                    model: 'fake-model',
                  },
                ]
              : [
                  { type: 'text_delta', text: 'I inspected the project context.' },
                  {
                    type: 'finish',
                    finishReason: 'stop',
                    usage: { inputTokens: 18, outputTokens: 6, totalTokens: 24 },
                    model: 'fake-model',
                  },
                ];

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

    const liveEvents: TurnEvent[] = [];
    const durableEvents: TurnEvent[] = [];
    const engine = new TurnEngine({
      llmClient: llm,
      toolRegistry: registry,
      publishLive: async (ev) => {
        liveEvents.push(ev);
      },
      publishDurable: async (ev) => {
        durableEvents.push(ev);
      },
      now: deterministicClock,
      newId: deterministicId,
    });

    const events = await collect(engine, makeInput({ buffer, allowedTools: registry }));

    expect(callCount).toBe(3);
    expect(events.some((event) => event.type === 'error')).toBe(false);
    expect(liveEvents.some((event) => event.type === 'error')).toBe(false);
    expect(events.some((event) => event.type === 'text_delta')).toBe(true);

    const endedEvent = events.find((event) => event.type === 'turn_ended');
    expect(endedEvent).toBeDefined();
    if (endedEvent?.type === 'turn_ended') {
      expect(endedEvent.reason).toBe('natural');
    }

    expect(durableEvents.some((event) => event.type === 'turn_ended')).toBe(true);
    expect(buffer.committed).toBe(true);
    expect(buffer.pendingMessagesSnapshot).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'assistant',
          toolCalls: expect.arrayContaining([
            expect.objectContaining({
              toolCallId: 'tc-inspect-1',
              toolName: 'inspect_project',
            }),
          ]),
        }),
      ]),
    );
  });
});

// ─── Test 4: cancel mid-stream ────────────────────────────────────────────────
//
// Cancel detection fires at two checkpoints inside the engine loop:
//   1. At the TOP of every while-iteration (before the LLM round).
//   2. WITHIN the stream loop, after every internal tool call result is fed back.
//
// To trigger cancel via path (2): we use an internal tool call that sets the flag
// during execution.  The engine processes the tool call, then checks cancel before
// looping back to start the next LLM round.

describe('TurnEngine INTERVIEW — cancel after internal tool call', () => {
  let buffer: FakeTurnBuffer;

  beforeEach(() => {
    seq = 0;
    buffer = new FakeTurnBuffer();
  });

  it('commits the partial turn and emits turn_ended with reason "canceled"', async () => {
    // Cancel flag is set during the tool's execute() call.
    // The engine checks cancelRequestedRead between tool calls (within the stream loop),
    // so cancel is detected before the next LLM round begins.
    let cancelFlag = false;

    // Register a no-op internal tool that sets the cancel flag during execution.
    const registry = new ToolRegistry();
    registry.register({
      name: 'probe_cancel',
      kind: 'internal',
      description: 'Probe that triggers cancel mid-turn.',
      inputSchema: z.object({ payload: z.string().optional() }),
      execute: async (_args, _ctx) => {
        cancelFlag = true; // Signal cancellation
        return { probed: true };
      },
    });

    // First (and only) LLM round: emits a tool call, then finish.
    // After the tool runs (which sets cancelFlag), the engine checks cancel
    // between tool calls and detects the flag.
    const llm = makeFakeLLM([
      {
        type: 'tool_call',
        toolCallId: 'tc-cancel-1',
        toolName: 'probe_cancel',
        args: { payload: 'test' },
      },
      {
        type: 'finish',
        finishReason: 'tool_calls',
        usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
        model: 'fake-model',
      },
    ]);

    const liveEvents: TurnEvent[] = [];
    const durableEvents: TurnEvent[] = [];

    const engine = new TurnEngine({
      llmClient: llm,
      toolRegistry: registry,
      publishLive: async (ev) => {
        liveEvents.push(ev);
      },
      publishDurable: async (ev) => {
        durableEvents.push(ev);
      },
      cancelRequestedRead: async (_sessionId) => cancelFlag,
      cancelRequestedClear: async (_sessionId) => {
        cancelFlag = false;
      },
      now: deterministicClock,
      newId: deterministicId,
    });

    const events = await collect(engine, makeInput({ buffer, allowedTools: registry }));

    // turn_ended with reason 'canceled' must be emitted
    const canceledEvt = events.find((e) => e.type === 'turn_ended' && e.reason === 'canceled');
    expect(canceledEvt).toBeDefined();

    // turn_committed remains part of the durable stream so resume/discard can recover.
    const committedEvt = events.find((e) => e.type === 'turn_committed');
    expect(committedEvt).toBeDefined();

    // Durable events include the normal commit boundary and any tool artifacts
    // produced before cancel was observed.
    expect(durableEvents.filter((e) => e.type === 'turn_committed')).toHaveLength(1);
    expect(
      durableEvents.filter((e) => e.type === 'turn_ended' && e.reason === 'canceled'),
    ).toHaveLength(1);

    // Buffer commits the partial turn and clears the cancel flag atomically.
    expect(buffer.committed).toBe(true);
    expect(buffer.sessionPatchSnapshot.cancelRequested).toBe(false);

    // The canceled terminal event is durable rather than live-only.
    const liveCanceled = liveEvents.find((e) => e.type === 'turn_ended' && e.reason === 'canceled');
    expect(liveCanceled).toBeUndefined();
  });
});

describe('TurnEngine INTERVIEW — abort during streamed text', () => {
  let buffer: FakeTurnBuffer;

  beforeEach(() => {
    seq = 0;
    buffer = new FakeTurnBuffer();
  });

  it('commits the partial turn and emits turn_ended with reason "interrupted"', async () => {
    const controller = new AbortController();
    const llm: LLMStreamClient = {
      stream(): AsyncIterable<LLMStreamChunk> {
        return {
          [Symbol.asyncIterator]() {
            let idx = 0;
            const chunks: LLMStreamChunk[] = [
              { type: 'text_delta', text: 'Partial response...' },
              { type: 'text_delta', text: 'This should not be processed.' },
            ];
            return {
              async next() {
                if (idx >= chunks.length) return { done: true, value: undefined };
                const value = chunks[idx++];
                if (idx === 1) {
                  controller.abort(new DOMException('manual abort', 'AbortError'));
                }
                return { done: false, value };
              },
            };
          },
        };
      },
    };

    const durableEvents: TurnEvent[] = [];
    const engine = new TurnEngine({
      llmClient: llm,
      toolRegistry: new ToolRegistry(),
      publishLive: async () => {},
      publishDurable: async (ev) => {
        durableEvents.push(ev);
      },
      now: deterministicClock,
      newId: deterministicId,
    });

    const events = await collect(engine, makeInput({ buffer, signal: controller.signal }));

    expect(events.some((e) => e.type === 'turn_committed')).toBe(true);
    expect(events.some((e) => e.type === 'turn_ended' && e.reason === 'interrupted')).toBe(true);
    expect(events.some((e) => e.type === 'turn_ended' && e.reason === 'natural')).toBe(false);
    expect(buffer.committed).toBe(true);
    expect(durableEvents.some((e) => e.type === 'turn_ended' && e.reason === 'interrupted')).toBe(
      true,
    );
  });
});
