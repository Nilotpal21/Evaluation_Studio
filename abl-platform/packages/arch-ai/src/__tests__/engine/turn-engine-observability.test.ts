import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { TraceEmitter, TraceLogRecord } from '../../engine/trace/index.js';
import {
  ARCH_PHASE,
  ARCH_PHASE_FROM,
  ARCH_PHASE_TO,
  ARCH_SESSION_MODE,
  ARCH_TOOL_INTERACTIVE,
  ARCH_TURN_END_REASON,
  COST_USD,
  EVENT_PAUSE,
  GEN_AI_CONVERSATION_ID,
  GEN_AI_OPERATION_NAME,
  GEN_AI_PROVIDER_NAME,
  GEN_AI_REQUEST_MODEL,
  GEN_AI_RESPONSE_FINISH_REASONS,
  GEN_AI_RESPONSE_ID,
  GEN_AI_RESPONSE_MODEL,
  GEN_AI_TOOL_CALL_ARGUMENTS,
  GEN_AI_TOOL_CALL_ID,
  GEN_AI_TOOL_CALL_RESULT,
  GEN_AI_TOOL_NAME,
  GEN_AI_USAGE_INPUT_TOKENS,
  GEN_AI_USAGE_OUTPUT_TOKENS,
  SPAN_KIND_LLM_CALL,
  SPAN_KIND_PHASE_TRANSITION,
  SPAN_KIND_TOOL_CALL,
  SPAN_KIND_TURN,
} from '../../engine/trace/index.js';

import type { LLMStreamChunk, LLMStreamClient, LLMStreamRequest } from '../../engine/llm-client.js';
import { TurnEngine } from '../../engine/turn-engine.js';
import type { ProjectWrite } from '../../engine/turn-context.js';
import { ToolRegistry } from '../../tools/v2/registry.js';
import type { StoredMessageV2 } from '../../types/session-v2.js';
import type { TurnEvent } from '../../types/turn-events.js';

class FakeTurnBuffer {
  committed = false;
  rolledBack = false;
  suggestions: string[] = [];
  completionMetadata: Record<string, unknown> | undefined;

  private sessionPatch: Record<string, unknown> = {};
  private pendingMessages: StoredMessageV2[] = [];
  private pendingProjectWrites: ProjectWrite[] = [];

  patchSession(patch: Record<string, unknown>): void {
    if (this.committed || this.rolledBack) {
      return;
    }
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

  enqueueProjectWrite(write: ProjectWrite): void {
    if (this.committed || this.rolledBack) {
      throw new Error('FakeTurnBuffer.enqueueProjectWrite: already committed or rolled back');
    }
    this.pendingProjectWrites.push(write);
  }

  async commit(): Promise<{
    committed: boolean;
    newCommit: boolean;
    writes: { sessionPatched: boolean; messagesAppended: number; projectWritesApplied: number };
  }> {
    if (this.committed) {
      throw new Error('FakeTurnBuffer.commit: already committed');
    }
    if (this.rolledBack) {
      throw new Error('FakeTurnBuffer.commit: rolled back');
    }

    for (const write of this.pendingProjectWrites) {
      await write.execute(null);
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
    if (this.committed) {
      throw new Error('FakeTurnBuffer.rollback: already committed');
    }
    this.sessionPatch = {};
    this.pendingMessages = [];
    this.pendingProjectWrites = [];
    this.suggestions = [];
    this.completionMetadata = undefined;
    this.rolledBack = true;
  }
}

class RecordingTraceEmitter implements TraceEmitter {
  readonly records: TraceLogRecord[] = [];
  flushCalls = 0;

  emit(record: TraceLogRecord): void {
    this.records.push(record);
  }

  async flush(_deadlineMs?: number): Promise<void> {
    this.flushCalls += 1;
  }
}

type ScriptedChunk = LLMStreamChunk;

function makeFakeLLM(chunks: ScriptedChunk[]): LLMStreamClient {
  return {
    stream(_req: LLMStreamRequest): AsyncIterable<LLMStreamChunk> {
      return {
        [Symbol.asyncIterator]() {
          let idx = 0;
          return {
            async next() {
              if (idx >= chunks.length) {
                return { done: true, value: undefined };
              }
              return { done: false, value: chunks[idx++] };
            },
          };
        },
      };
    },
  };
}

function makeMultiRoundLLM(rounds: ScriptedChunk[][]): LLMStreamClient {
  let callCount = 0;
  return {
    stream(_req: LLMStreamRequest): AsyncIterable<LLMStreamChunk> {
      const chunks = rounds[callCount++] ?? [];
      return {
        [Symbol.asyncIterator]() {
          let idx = 0;
          return {
            async next() {
              if (idx >= chunks.length) {
                return { done: true, value: undefined };
              }
              return { done: false, value: chunks[idx++] };
            },
          };
        },
      };
    },
  };
}

async function collect(
  engine: TurnEngine,
  input: Parameters<TurnEngine['runTurn']>[0],
): Promise<TurnEvent[]> {
  const events: TurnEvent[] = [];
  for await (const event of engine.runTurn(input)) {
    events.push(event);
  }
  return events;
}

function makeInput(
  overrides: Partial<Parameters<TurnEngine['runTurn']>[0]> & {
    buffer: FakeTurnBuffer;
    allowedTools?: ToolRegistry;
  },
): Parameters<TurnEngine['runTurn']>[0] {
  return {
    sessionId: 'sess-observability',
    tenantId: 'tenant-observability',
    userId: 'user-observability',
    turnId: 'turn-observability',
    phase: 'INTERVIEW',
    mode: 'onboarding',
    history: [],
    systemPrompt: 'You are Arch AI.',
    userInput: 'Hello',
    allowedTools: overrides.allowedTools ?? new ToolRegistry(),
    buffer: overrides.buffer as unknown as import('../../engine/turn-buffer.js').TurnBuffer,
    signal: new AbortController().signal,
    specialist: 'onboarding',
    ...overrides,
  };
}

let seq = 0;

function deterministicId(): string {
  return `id-${seq++}`;
}

function deterministicClock(): number {
  return 1_700_000_000_000 + seq * 1000;
}

const PAYLOAD_CAPTURE_ENV = 'ARCH_OBSERVABILITY_CAPTURE_PAYLOADS' as const;
const originalPayloadCapture = process.env[PAYLOAD_CAPTURE_ENV];

describe('TurnEngine observability', () => {
  beforeEach(() => {
    seq = 0;
    delete process.env[PAYLOAD_CAPTURE_ENV];
  });

  afterEach(() => {
    if (originalPayloadCapture === undefined) {
      delete process.env[PAYLOAD_CAPTURE_ENV];
      return;
    }
    process.env[PAYLOAD_CAPTURE_ENV] = originalPayloadCapture;
  });

  it('emits a contract-compliant trace for a natural text turn', async () => {
    const buffer = new FakeTurnBuffer();
    const traceEmitter = new RecordingTraceEmitter();
    const llm = makeFakeLLM([
      { type: 'text_delta', text: 'Hello, ' },
      { type: 'text_delta', text: 'world!' },
      {
        type: 'finish',
        finishReason: 'stop',
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        model: 'claude-sonnet-4-6',
        provider: 'anthropic',
        requestedModel: 'claude-sonnet-4-6',
        responseId: 'resp-123',
        estimatedUsd: 0.0125,
        latencyMs: 4321,
      },
    ]);

    const engine = new TurnEngine({
      llmClient: llm,
      toolRegistry: new ToolRegistry(),
      traceEmitter,
      publishLive: async () => {},
      publishDurable: async () => {},
      now: deterministicClock,
      newId: deterministicId,
    });

    const events = await collect(engine, makeInput({ buffer }));

    expect(events.some((event) => event.type === 'turn_ended' && event.reason === 'natural')).toBe(
      true,
    );
    expect(buffer.committed).toBe(true);

    expect(traceEmitter.records.map((record) => record.kind)).toEqual([
      'trace_started',
      'span_started',
      'span_started',
      'span_ended',
      'span_ended',
      'trace_ended',
    ]);
    expect(traceEmitter.records.map((record) => record.seq)).toEqual([0, 1, 2, 3, 4, 5]);

    const [traceStarted, turnSpanStarted, llmSpanStarted, llmSpanEnded, turnSpanEnded, traceEnded] =
      traceEmitter.records;

    expect(traceStarted.kind).toBe('trace_started');
    if (traceStarted.kind === 'trace_started') {
      expect(traceStarted.attributes).toMatchObject({
        [ARCH_SESSION_MODE]: 'onboarding',
        [ARCH_PHASE]: 'INTERVIEW',
        [GEN_AI_CONVERSATION_ID]: 'sess-observability',
      });
    }

    expect(turnSpanStarted.kind).toBe('span_started');
    expect(llmSpanStarted.kind).toBe('span_started');
    if (turnSpanStarted.kind === 'span_started' && llmSpanStarted.kind === 'span_started') {
      expect(turnSpanStarted.spanKind).toBe(SPAN_KIND_TURN);
      expect(llmSpanStarted.spanKind).toBe(SPAN_KIND_LLM_CALL);
      expect(llmSpanStarted.parentSpanId).toBe(turnSpanStarted.spanId);
      expect(llmSpanStarted.attributes[GEN_AI_OPERATION_NAME]).toBe('chat');
    }

    expect(llmSpanEnded.kind).toBe('span_ended');
    if (llmSpanEnded.kind === 'span_ended') {
      expect(llmSpanEnded.status).toBe('ok');
      expect(llmSpanEnded.attributes).toMatchObject({
        [GEN_AI_PROVIDER_NAME]: 'anthropic',
        [GEN_AI_REQUEST_MODEL]: 'claude-sonnet-4-6',
        [GEN_AI_RESPONSE_MODEL]: 'claude-sonnet-4-6',
        [GEN_AI_RESPONSE_FINISH_REASONS]: ['stop'],
        [GEN_AI_RESPONSE_ID]: 'resp-123',
        [GEN_AI_USAGE_INPUT_TOKENS]: 10,
        [GEN_AI_USAGE_OUTPUT_TOKENS]: 5,
        [COST_USD]: 0.0125,
        'llm.latency_ms': 4321,
      });
    }

    expect(turnSpanEnded.kind).toBe('span_ended');
    if (turnSpanEnded.kind === 'span_ended') {
      expect(turnSpanEnded.status).toBe('ok');
      expect(turnSpanEnded.attributes).toMatchObject({
        [ARCH_TURN_END_REASON]: 'natural',
        [GEN_AI_PROVIDER_NAME]: 'anthropic',
        [GEN_AI_REQUEST_MODEL]: 'claude-sonnet-4-6',
        [GEN_AI_RESPONSE_MODEL]: 'claude-sonnet-4-6',
        [GEN_AI_RESPONSE_ID]: 'resp-123',
        [GEN_AI_USAGE_INPUT_TOKENS]: 10,
        [GEN_AI_USAGE_OUTPUT_TOKENS]: 5,
        [COST_USD]: 0.0125,
      });
    }

    expect(traceEnded.kind).toBe('trace_ended');
    if (traceEnded.kind === 'trace_ended') {
      expect(traceEnded.status).toBe('ok');
      expect(traceEnded.attributes[ARCH_TURN_END_REASON]).toBe('natural');
    }

    expect(traceEmitter.flushCalls).toBe(1);
  });

  it('emits pause tracing for interactive tools and keeps payload capture off by default', async () => {
    const buffer = new FakeTurnBuffer();
    const traceEmitter = new RecordingTraceEmitter();
    const registry = new ToolRegistry();
    registry.register({
      name: 'ask_user',
      kind: 'interactive',
      description: 'Pause and ask a follow-up question.',
      inputSchema: z.object({ question: z.string() }),
    });

    const llm = makeFakeLLM([
      {
        type: 'tool_call',
        toolCallId: 'tc-ask-user',
        toolName: 'ask_user',
        args: { question: 'Which ERP do you use?' },
      },
    ]);

    const engine = new TurnEngine({
      llmClient: llm,
      toolRegistry: registry,
      traceEmitter,
      publishLive: async () => {},
      publishDurable: async () => {},
      now: deterministicClock,
      newId: deterministicId,
    });

    const events = await collect(engine, makeInput({ buffer, allowedTools: registry }));

    expect(events.some((event) => event.type === 'interactive_tool')).toBe(true);
    expect(buffer.committed).toBe(true);
    expect(buffer.sessionPatchSnapshot['metadata.pendingInteraction']).toMatchObject({
      kind: 'widget',
      id: 'tc-ask-user',
      payload: { question: 'Which ERP do you use?' },
    });

    const toolSpanStarted = traceEmitter.records.find(
      (record): record is Extract<TraceLogRecord, { kind: 'span_started' }> =>
        record.kind === 'span_started' && record.spanKind === SPAN_KIND_TOOL_CALL,
    );
    expect(toolSpanStarted).toBeDefined();
    expect(toolSpanStarted?.attributes).toMatchObject({
      [GEN_AI_TOOL_NAME]: 'ask_user',
      [GEN_AI_TOOL_CALL_ID]: 'tc-ask-user',
      [ARCH_TOOL_INTERACTIVE]: true,
    });
    expect(toolSpanStarted?.attributes[GEN_AI_TOOL_CALL_ARGUMENTS]).toBeUndefined();

    const pauseEvent = traceEmitter.records.find(
      (record): record is Extract<TraceLogRecord, { kind: 'span_event' }> =>
        record.kind === 'span_event' && record.name === EVENT_PAUSE,
    );
    expect(pauseEvent).toBeDefined();
    expect(pauseEvent?.attributes).toMatchObject({
      'pause.reason': 'interactive_tool',
      tool: 'ask_user',
      toolCallId: 'tc-ask-user',
      kind: 'tool',
    });

    const llmSpanEnded = traceEmitter.records.find(
      (record): record is Extract<TraceLogRecord, { kind: 'span_ended' }> =>
        record.kind === 'span_ended' &&
        !record.error &&
        Array.isArray(record.attributes[GEN_AI_RESPONSE_FINISH_REASONS]) &&
        (record.attributes[GEN_AI_RESPONSE_FINISH_REASONS] as unknown[]).includes('tool_calls'),
    );
    expect(llmSpanEnded).toBeDefined();

    const traceEnded = traceEmitter.records.find(
      (record): record is Extract<TraceLogRecord, { kind: 'trace_ended' }> =>
        record.kind === 'trace_ended',
    );
    expect(traceEnded).toBeDefined();
    expect(traceEnded?.status).toBe('paused');
    expect(traceEnded?.attributes).toMatchObject({
      [ARCH_TURN_END_REASON]: 'interactive_pause',
      'pause.reason': 'interactive_tool',
      tool: 'ask_user',
      toolCallId: 'tc-ask-user',
    });

    expect(traceEmitter.flushCalls).toBe(1);
  });

  it('emits a phase_transition span when a tool advances the session phase', async () => {
    const buffer = new FakeTurnBuffer();
    const traceEmitter = new RecordingTraceEmitter();
    const registry = new ToolRegistry();

    registry.register({
      name: 'proceed_to_next_phase',
      kind: 'internal',
      description: 'Advance to the next phase.',
      inputSchema: z.object({ reason: z.string() }),
      execute: async (_args, ctx) => {
        (
          ctx as typeof ctx & {
            buffer: FakeTurnBuffer;
          }
        ).buffer.patchSession({
          'metadata.phase': 'BLUEPRINT',
        });
        return { transitioned: true, from: 'INTERVIEW', to: 'BLUEPRINT' };
      },
    });

    const llm = makeMultiRoundLLM([
      [
        {
          type: 'tool_call',
          toolCallId: 'tc-proceed',
          toolName: 'proceed_to_next_phase',
          args: { reason: 'Requirements are complete.' },
        },
        {
          type: 'finish',
          finishReason: 'tool_calls',
          usage: { inputTokens: 12, outputTokens: 4, totalTokens: 16 },
          model: 'fake-model',
        },
      ],
      [
        { type: 'text_delta', text: 'Moving into blueprinting.' },
        {
          type: 'finish',
          finishReason: 'stop',
          usage: { inputTokens: 20, outputTokens: 6, totalTokens: 26 },
          model: 'fake-model',
        },
      ],
    ]);

    const engine = new TurnEngine({
      llmClient: llm,
      toolRegistry: registry,
      traceEmitter,
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
        specialist: 'onboarding',
      }),
    );

    const turnSpanStarted = traceEmitter.records.find(
      (record): record is Extract<TraceLogRecord, { kind: 'span_started' }> =>
        record.kind === 'span_started' && record.spanKind === SPAN_KIND_TURN,
    );
    expect(turnSpanStarted).toBeDefined();

    const phaseSpanStarted = traceEmitter.records.find(
      (record): record is Extract<TraceLogRecord, { kind: 'span_started' }> =>
        record.kind === 'span_started' && record.spanKind === SPAN_KIND_PHASE_TRANSITION,
    );
    const phaseSpanEnded = traceEmitter.records.find(
      (record): record is Extract<TraceLogRecord, { kind: 'span_ended' }> =>
        record.kind === 'span_ended' && record.attributes[ARCH_PHASE] === 'BLUEPRINT',
    );
    expect(phaseSpanStarted).toBeDefined();
    expect(phaseSpanEnded).toBeDefined();

    if (turnSpanStarted && phaseSpanStarted) {
      expect(phaseSpanStarted.parentSpanId).toBe(turnSpanStarted.spanId);
      expect(phaseSpanStarted.attributes).toMatchObject({
        [ARCH_PHASE]: 'BLUEPRINT',
        [ARCH_PHASE_FROM]: 'INTERVIEW',
        [ARCH_PHASE_TO]: 'BLUEPRINT',
      });
    }

    const traceEnded = traceEmitter.records.find(
      (record): record is Extract<TraceLogRecord, { kind: 'trace_ended' }> =>
        record.kind === 'trace_ended',
    );
    expect(traceEnded).toBeDefined();
    expect(traceEnded?.attributes).toMatchObject({
      [ARCH_PHASE]: 'BLUEPRINT',
      [ARCH_TURN_END_REASON]: 'natural',
      [GEN_AI_USAGE_INPUT_TOKENS]: 32,
      [GEN_AI_USAGE_OUTPUT_TOKENS]: 10,
    });

    const toolSpanEnded = traceEmitter.records.find(
      (record): record is Extract<TraceLogRecord, { kind: 'span_ended' }> =>
        record.kind === 'span_ended' &&
        record.attributes[GEN_AI_TOOL_NAME] === undefined &&
        record.attributes[GEN_AI_TOOL_CALL_RESULT] !== undefined,
    );
    expect(toolSpanEnded).toBeUndefined();
    expect(buffer.sessionPatchSnapshot['metadata.phase']).toBe('BLUEPRINT');
  });
});
