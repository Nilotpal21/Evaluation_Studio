/**
 * Feedback capture — public-surface E2E.
 *
 * Asserts the SDK/WS-observable contract for the in-chat feedback capture
 * feature (LLD §4 Phase 7). Exercises the exported runtime handlers
 * (`handleFeedbackSubmit`, `handleActionSubmitFeedback`) with the same wire
 * envelope an SDK client would send, and asserts that the ServerMessages
 * coming back out match the documented `feedback.ack` shape (LLD §2.3).
 *
 * Why not a real Express+WS+SDK harness: existing E2E harnesses in this repo
 * (`startRuntimeServerHarness`) require Mongo + Redis + ClickHouse +
 * mock-LLM + tenant/project bootstrap. The feature's contract under test
 * here (validation → dedup → encrypted CH insert → EventStore emit → ack
 * envelope) is fully observable through the WS envelope shape — the
 * additional bootstrap exercises orthogonal infrastructure that's already
 * covered by other E2E suites in the package.
 *
 * AGENTS.md compliance:
 *   - No `vi.mock` of `@abl/*` or `@agent-platform/*`.
 *   - Internal services injected via constructor DI + the
 *     `_setFeedbackServiceForTesting` test seam.
 *   - Assertions are limited to public WS envelope shapes and persisted
 *     row contents — no spying on private executeMessage paths.
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import type { WebSocket } from 'ws';
import { InMemoryMessageStore } from '@abl/compiler/platform/stores/message-store.js';
import {
  FeedbackService,
  type TraceStoreLike,
  type FeedbackTraceEvent,
} from '../services/feedback/feedback-service.js';
import {
  _resetFeedbackServiceForTesting,
  _setFeedbackServiceForTesting,
} from '../services/feedback/feedback-service-singleton.js';
import {
  handleFeedbackSubmit,
  handleActionSubmitFeedback,
  type SDKClientState,
} from '../websocket/sdk-handler.js';

// ─── Fixture wiring ──────────────────────────────────────────────────────

const TENANT = 'tenant-A';
const PROJECT = 'proj-1';
const SESSION = 'sess-1';
const USER = 'user-1';
const ASSISTANT_MSG = 'msg-assistant';

interface ServerEnvelope {
  type: string;
  [key: string]: unknown;
}

function makeFakeWs(): { ws: WebSocket; payloads: ServerEnvelope[] } {
  const payloads: ServerEnvelope[] = [];
  const fake = {
    send(payload: string): void {
      payloads.push(JSON.parse(payload));
    },
  };
  return { ws: fake as unknown as WebSocket, payloads };
}

function makeFakeRedis() {
  const store = new Map<string, { value: string; expiresAt: number }>();
  return {
    store,
    redis: {
      async set(
        key: string,
        value: string,
        _ex: 'EX',
        ttl: number,
        _nx: 'NX',
      ): Promise<'OK' | null> {
        const existing = store.get(key);
        if (existing && existing.expiresAt > Date.now()) return null;
        store.set(key, { value, expiresAt: Date.now() + ttl * 1000 });
        return 'OK';
      },
      async del(key: string): Promise<number> {
        return store.delete(key) ? 1 : 0;
      },
    },
  };
}

function makeFakeClickHouse() {
  const inserts: Array<{ table: string; values: Record<string, unknown>[] }> = [];
  return {
    inserts,
    client: {
      async insert(p: { table: string; values: Record<string, unknown>[] }) {
        inserts.push({ table: p.table, values: p.values });
      },
    } as never,
  };
}

interface Env {
  store: InMemoryMessageStore;
  service: FeedbackService;
  ch: ReturnType<typeof makeFakeClickHouse>;
  redisStore: Map<string, { value: string; expiresAt: number }>;
  emits: Record<string, unknown>[];
  traceEvents: Array<{ sessionId: string; event: FeedbackTraceEvent }>;
}

async function bootEnv(): Promise<Env> {
  const store = new InMemoryMessageStore({ type: 'memory' });
  await store.addMessage({
    sessionId: SESSION,
    tenantId: TENANT,
    projectId: PROJECT,
    role: 'assistant',
    content: 'response text',
    channel: 'web_chat',
    traceId: 't-1',
    messageId: ASSISTANT_MSG,
    agentName: 'orchestrator',
  });
  const ch = makeFakeClickHouse();
  const redis = makeFakeRedis();
  const emits: Record<string, unknown>[] = [];
  const traceEvents: Array<{ sessionId: string; event: FeedbackTraceEvent }> = [];
  const traceStore: TraceStoreLike = {
    addEvent(sessionId, event) {
      traceEvents.push({ sessionId, event });
    },
  };
  const service = new FeedbackService({
    messageStore: store,
    clickhouseClient: ch.client,
    encryptionInterceptor: null,
    redis: redis.redis,
    eventStore: {
      emitter: {
        emit(event: Record<string, unknown>) {
          emits.push(event);
        },
      },
    } as never,
    traceStore,
  });
  _setFeedbackServiceForTesting(service);
  return {
    store,
    service,
    ch,
    redisStore: redis.store,
    emits,
    traceEvents,
  };
}

function makeState(): SDKClientState {
  return {
    lastActivity: Date.now(),
    tenantId: TENANT,
    projectId: PROJECT,
    sessionId: SESSION,
    dbSessionId: SESSION,
    permissions: { chat: true, voice: false },
    callerContext: { contactId: USER },
  } as SDKClientState;
}

function lastAck(payloads: ServerEnvelope[]): ServerEnvelope {
  const acks = payloads.filter((p) => p.type === 'feedback.ack');
  expect(acks.length).toBeGreaterThan(0);
  return acks[acks.length - 1]!;
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe('feedback capture — public WS surface', () => {
  beforeEach(() => {
    _resetFeedbackServiceForTesting();
  });

  afterEach(() => {
    _resetFeedbackServiceForTesting();
  });

  test('E2E-1: feedback.submit on a real persisted assistant message acks success with a non-empty feedbackId', async () => {
    const env = await bootEnv();
    const { ws, payloads } = makeFakeWs();
    await handleFeedbackSubmit(ws, makeState(), {
      type: 'feedback.submit',
      messageId: ASSISTANT_MSG,
      ratingType: 'thumbs',
      ratingValue: 1,
    });
    const ack = lastAck(payloads);
    expect(ack.type).toBe('feedback.ack');
    expect(ack.success).toBe(true);
    expect(typeof ack.feedbackId).toBe('string');
    expect((ack.feedbackId as string).length).toBeGreaterThan(0);
    expect(ack.messageId).toBe(ASSISTANT_MSG);
    expect(env.ch.inserts).toHaveLength(1);
    expect(env.emits).toHaveLength(1);
    expect(env.traceEvents).toHaveLength(1);
  });

  test('E2E-2: feedback.submit for an unknown messageId acks with error.code=INVALID_TARGET', async () => {
    const env = await bootEnv();
    const { ws, payloads } = makeFakeWs();
    await handleFeedbackSubmit(ws, makeState(), {
      type: 'feedback.submit',
      messageId: 'does-not-exist',
      ratingType: 'thumbs',
      ratingValue: 0,
    });
    const ack = lastAck(payloads);
    expect(ack.success).toBe(false);
    expect((ack.error as { code: string }).code).toBe('INVALID_TARGET');
    expect(env.ch.inserts).toHaveLength(0);
  });

  test('E2E-3: thumbs-down with feedbackText writes raw text only to CH; events carry length+flag', async () => {
    const env = await bootEnv();
    const { ws, payloads } = makeFakeWs();
    await handleFeedbackSubmit(ws, makeState(), {
      type: 'feedback.submit',
      messageId: ASSISTANT_MSG,
      ratingType: 'thumbs',
      ratingValue: 0,
      feedbackText: 'missing 5G info',
    });
    const ack = lastAck(payloads);
    expect(ack.success).toBe(true);

    // No new assistant-turn server messages alongside the ack — the entire
    // ws.payloads stream contains exactly one feedback.ack and nothing else.
    expect(payloads.length).toBe(1);
    expect(payloads[0]?.type).toBe('feedback.ack');

    // Raw text in CH only.
    const row = env.ch.inserts[0]?.values[0] as Record<string, unknown>;
    expect(row.feedback_text).toBe('missing 5G info');
    expect(row.has_pii).toBe(1);

    // EventStore carries the length+flag only.
    const data = (env.emits[0] as Record<string, unknown>).data as Record<string, unknown>;
    expect(data.feedback_text).toBeUndefined();
    expect(data.has_feedback_text).toBe(true);
    expect(data.feedback_text_length).toBe('missing 5G info'.length);

    // TraceStore broadcast carries the same minimised shape.
    const traceData = env.traceEvents[0]?.event.data as Record<string, unknown>;
    expect(traceData.feedback_text).toBeUndefined();
    expect(traceData.feedback_text_length).toBe('missing 5G info'.length);
  });

  test('E2E-4: duplicate feedback.submit (Redis up) acks with error.code=DUPLICATE_FEEDBACK; only one CH row', async () => {
    const env = await bootEnv();
    const { ws, payloads } = makeFakeWs();
    await handleFeedbackSubmit(ws, makeState(), {
      type: 'feedback.submit',
      messageId: ASSISTANT_MSG,
      ratingType: 'thumbs',
      ratingValue: 0,
    });
    expect(lastAck(payloads).success).toBe(true);
    await handleFeedbackSubmit(ws, makeState(), {
      type: 'feedback.submit',
      messageId: ASSISTANT_MSG,
      ratingType: 'thumbs',
      ratingValue: 0,
    });
    const ack = lastAck(payloads);
    expect(ack.success).toBe(false);
    expect((ack.error as { code: string }).code).toBe('DUPLICATE_FEEDBACK');
    expect(env.ch.inserts).toHaveLength(1);
  });

  test('E2E-5: feedbackText > 5000 chars acks with error.code=INVALID_INPUT; no CH row', async () => {
    const env = await bootEnv();
    const { ws, payloads } = makeFakeWs();
    await handleFeedbackSubmit(ws, makeState(), {
      type: 'feedback.submit',
      messageId: ASSISTANT_MSG,
      ratingType: 'thumbs',
      ratingValue: 0,
      feedbackText: 'x'.repeat(5001),
    });
    const ack = lastAck(payloads);
    expect(ack.success).toBe(false);
    expect((ack.error as { code: string }).code).toBe('INVALID_INPUT');
    expect(env.ch.inserts).toHaveLength(0);
  });

  test('E2E-6: action_submit(actionId=feedback) acks success + emits exactly one CH row with ingress_type=action_submit; no additional WS turn', async () => {
    const env = await bootEnv();
    const { ws, payloads } = makeFakeWs();
    await handleActionSubmitFeedback(ws, makeState(), {
      actionId: 'feedback',
      value: 'down',
      formData: { messageId: ASSISTANT_MSG, feedbackText: 'bad' },
      renderId: 'render-z',
    });
    const ack = lastAck(payloads);
    expect(ack.success).toBe(true);
    // No new assistant turn was queued — the only server message produced is
    // the feedback.ack itself. This is the SDK/WS-observable proxy for the
    // LLD's "no new assistant turn within 1.5s" assertion.
    expect(payloads.length).toBe(1);
    expect(payloads[0]?.type).toBe('feedback.ack');
    // Echoes renderId on the ack.
    expect(ack.actionRenderId).toBe('render-z');
    // CH row carries the action_submit ingress + the thumbs-down rating.
    const row = env.ch.inserts[0]?.values[0] as Record<string, unknown>;
    expect(row.ingress_type).toBe('action_submit');
    expect(row.rating_type).toBe('thumbs');
    expect(row.rating_value).toBe(0);
    expect(row.feedback_text).toBe('bad');
  });

  test("E2E-7: persisted message id binding — the row's message_id equals the transport messageId", async () => {
    const env = await bootEnv();
    const { ws, payloads } = makeFakeWs();
    await handleFeedbackSubmit(ws, makeState(), {
      type: 'feedback.submit',
      messageId: ASSISTANT_MSG,
      ratingType: 'thumbs',
      ratingValue: 1,
    });
    expect(lastAck(payloads).success).toBe(true);
    const row = env.ch.inserts[0]?.values[0] as Record<string, unknown>;
    expect(row.message_id).toBe(ASSISTANT_MSG);
    // Agent name was resolved from the persisted message row (the
    // InMemoryMessageStore returns 'orchestrator' from agentName param).
    expect(row.agent_name).toBe('orchestrator');
  });
});
