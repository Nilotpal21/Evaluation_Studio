/**
 * FeedbackService unit tests.
 *
 * Strictly DI — no platform mocks. Hand-rolled fakes for the ClickHouse
 * client, encryption interceptor, Redis client, EventStore, and TraceStore.
 *
 * Coverage:
 *   - INVALID_TARGET on unknown / cross-scope / non-assistant messageId
 *   - Happy path writes encrypted row, emits to EventStore (PII-minimised),
 *     broadcasts to TraceStore (PII-minimised), returns feedbackId
 *   - DUPLICATE_FEEDBACK when dedup slot held
 *   - Soft-allow when Redis null — still writes row
 *   - STORAGE_FAILURE on CH insert error releases the dedup slot
 *   - feedback_text never leaves CH row (not in EventStore data, not in
 *     TraceStore event payload)
 *   - encrypted + key_version columns mirror interceptor state (0/0 when
 *     none, 1/1 when configured); plaintext arrives at the interceptor
 *   - rich-template ingress (action_submit) preserved through to the row
 *   - happy-path also fires when EventStore / TraceStore are null (graceful)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryMessageStore } from '@abl/compiler/platform/stores/message-store.js';
import type { TraceEvent } from '@agent-platform/shared-kernel';
import { FeedbackService, type FeedbackSubmitInput } from '../feedback-service.js';
import type { FeedbackSubmission } from '../types.js';

// ─── Fakes ────────────────────────────────────────────────────────────────

interface CapturedInsert {
  table: string;
  values: Record<string, unknown>[];
}

function makeFakeClickHouseClient() {
  const inserts: CapturedInsert[] = [];
  let throwOnInsert = false;
  return {
    inserts,
    setThrowOnInsert(v: boolean) {
      throwOnInsert = v;
    },
    client: {
      async insert(params: { table: string; values: Record<string, unknown>[] }) {
        if (throwOnInsert) throw new Error('ch down');
        inserts.push({ table: params.table, values: params.values });
      },
      // BufferedClickHouseWriter only calls .insert + .close; other surfaces unused.
      async close() {
        /* no-op */
      },
    },
  };
}

/**
 * Fake encryption interceptor matching the runtime surface used by the
 * BufferedWriter. Records pre-encrypt input so tests can assert plaintext
 * arrives and that the row's `encrypted` / `key_version` are set by the
 * service (the interceptor itself does not mutate those columns in this
 * fake — the service writes 1/1 when an interceptor is configured).
 */
function makeFakeInterceptor() {
  const beforeInsertCalls: { table: string; rows: Record<string, unknown>[] }[] = [];
  return {
    beforeInsertCalls,
    interceptor: {
      async beforeInsert(table: string, rows: Record<string, unknown>[]) {
        beforeInsertCalls.push({ table, rows: rows.map((r) => ({ ...r })) });
        return rows.map((r) => ({ ...r, feedback_text: `[ENCRYPTED:${r.feedback_text}]` }));
      },
      async afterQuery(_table: string, rows: Record<string, unknown>[]) {
        return rows;
      },
    },
  };
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

function makeFakeEventStore() {
  const emits: Record<string, unknown>[] = [];
  return {
    emits,
    eventStore: {
      emitter: {
        emit(event: Record<string, unknown>) {
          emits.push(event);
        },
      },
    },
  };
}

function makeFakeTraceStore() {
  const events: Array<{ sessionId: string; event: TraceEvent }> = [];
  return {
    events,
    traceStore: {
      addEvent(sessionId: string, event: TraceEvent) {
        events.push({ sessionId, event });
      },
    },
  };
}

// ─── Test fixtures ────────────────────────────────────────────────────────

const TENANT = 'tenant-A';
const PROJECT = 'proj-1';
const SESSION = 'sess-1';
const USER = 'user-1';
const MSG_ID = 'msg-assistant-1';

async function seedAssistantMessage(
  store: InMemoryMessageStore,
  opts: { messageId?: string; agentName?: string; sessionId?: string } = {},
) {
  await store.addMessage({
    sessionId: opts.sessionId ?? SESSION,
    tenantId: TENANT,
    projectId: PROJECT,
    role: 'assistant',
    content: 'hi',
    channel: 'web_chat',
    traceId: 't-1',
    messageId: opts.messageId ?? MSG_ID,
    ...(opts.agentName ? { agentName: opts.agentName } : {}),
  });
}

async function seedUserMessage(store: InMemoryMessageStore, messageId: string) {
  await store.addMessage({
    sessionId: SESSION,
    tenantId: TENANT,
    projectId: PROJECT,
    role: 'user',
    content: 'q',
    channel: 'web_chat',
    traceId: 't-1',
    messageId,
  });
}

function makeInput(overrides: Partial<FeedbackSubmission> = {}): FeedbackSubmitInput {
  return {
    tenantId: TENANT,
    projectId: PROJECT,
    sessionId: SESSION,
    userId: USER,
    channel: 'web',
    messageId: MSG_ID,
    ratingType: 'thumbs',
    ratingValue: 0,
    ingress: 'feedback_submit',
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe('FeedbackService', () => {
  let store: InMemoryMessageStore;

  beforeEach(() => {
    store = new InMemoryMessageStore({ type: 'memory' });
  });

  it('writes a feedback row + EventStore emit + TraceStore broadcast on the happy path', async () => {
    await seedAssistantMessage(store, { agentName: 'orchestrator' });
    const ch = makeFakeClickHouseClient();
    const es = makeFakeEventStore();
    const ts = makeFakeTraceStore();
    const { redis } = makeFakeRedis();
    const svc = new FeedbackService({
      messageStore: store,
      clickhouseClient: ch.client as never,
      encryptionInterceptor: null,
      redis,
      eventStore: es.eventStore as never,
      traceStore: ts.traceStore,
      idGenerator: () => 'feedback-1',
    });

    const result = await svc.submit(makeInput({ feedbackText: 'better next time' }));
    expect(result).toEqual({ ok: true, feedbackId: 'feedback-1' });

    // CH row
    expect(ch.inserts).toHaveLength(1);
    const row = ch.inserts[0]?.values[0] as Record<string, unknown>;
    expect(row).toMatchObject({
      tenant_id: TENANT,
      project_id: PROJECT,
      feedback_id: 'feedback-1',
      session_id: SESSION,
      message_id: MSG_ID,
      agent_name: 'orchestrator',
      user_id: USER,
      rating_type: 'thumbs',
      rating_value: 0,
      feedback_text: 'better next time',
      source: 'websocket',
      ingress_type: 'feedback_submit',
      has_pii: 1,
      encrypted: 0,
      key_version: 0,
    });

    // EventStore emit
    expect(es.emits).toHaveLength(1);
    const event = es.emits[0] as Record<string, unknown>;
    expect(event.event_type).toBe('feedback.submitted');
    expect(event.tenant_id).toBe(TENANT);
    expect(event.agent_name).toBe('orchestrator');
    const data = event.data as Record<string, unknown>;
    expect(data.rating_type).toBe('thumbs');
    expect(data.has_feedback_text).toBe(true);
    expect(data.feedback_text_length).toBe('better next time'.length);
    expect(data.feedback_text).toBeUndefined(); // PII never leaves CH

    // TraceStore broadcast
    expect(ts.events).toHaveLength(1);
    expect(ts.events[0]?.sessionId).toBe(SESSION);
    expect(ts.events[0]?.event.type).toBe('feedback.submitted');
    expect(ts.events[0]?.event.agentName).toBe('orchestrator');
    expect(ts.events[0]?.event.data.feedback_text).toBeUndefined();
    expect(ts.events[0]?.event.data.feedback_text_length).toBe('better next time'.length);
  });

  it('returns INVALID_TARGET when the message does not exist', async () => {
    const ch = makeFakeClickHouseClient();
    const svc = new FeedbackService({
      messageStore: store,
      clickhouseClient: ch.client as never,
      encryptionInterceptor: null,
      redis: null,
      eventStore: null,
      traceStore: null,
    });
    const result = await svc.submit(makeInput({ messageId: 'unknown' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('INVALID_TARGET');
    expect(ch.inserts).toHaveLength(0);
  });

  it('returns INVALID_TARGET when the target message is from a user role', async () => {
    await seedUserMessage(store, 'user-msg');
    const ch = makeFakeClickHouseClient();
    const svc = new FeedbackService({
      messageStore: store,
      clickhouseClient: ch.client as never,
      encryptionInterceptor: null,
      redis: null,
      eventStore: null,
      traceStore: null,
    });
    const result = await svc.submit(makeInput({ messageId: 'user-msg' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('INVALID_TARGET');
    expect(ch.inserts).toHaveLength(0);
  });

  it('returns INVALID_TARGET on cross-scope tenant lookup', async () => {
    await seedAssistantMessage(store);
    const ch = makeFakeClickHouseClient();
    const svc = new FeedbackService({
      messageStore: store,
      clickhouseClient: ch.client as never,
      encryptionInterceptor: null,
      redis: null,
      eventStore: null,
      traceStore: null,
    });
    const result = await svc.submit(makeInput({ messageId: MSG_ID }));
    // Same scope works
    expect(result.ok).toBe(true);

    const result2 = await new FeedbackService({
      messageStore: store,
      clickhouseClient: ch.client as never,
      encryptionInterceptor: null,
      redis: null,
      eventStore: null,
      traceStore: null,
    }).submit({ ...makeInput({ messageId: MSG_ID }), tenantId: 'tenant-OTHER' });
    expect(result2.ok).toBe(false);
    if (result2.ok) return;
    expect(result2.code).toBe('INVALID_TARGET');
  });

  it('returns DUPLICATE_FEEDBACK on the second submit when Redis is available', async () => {
    await seedAssistantMessage(store);
    const ch = makeFakeClickHouseClient();
    const { redis } = makeFakeRedis();
    const svc = new FeedbackService({
      messageStore: store,
      clickhouseClient: ch.client as never,
      encryptionInterceptor: null,
      redis,
      eventStore: null,
      traceStore: null,
    });
    const first = await svc.submit(makeInput());
    expect(first.ok).toBe(true);
    const second = await svc.submit(makeInput());
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.code).toBe('DUPLICATE_FEEDBACK');
    expect(ch.inserts).toHaveLength(1);
  });

  it('soft-allows duplicates when Redis is null (relies on read-side argMax backstop)', async () => {
    await seedAssistantMessage(store);
    const ch = makeFakeClickHouseClient();
    const svc = new FeedbackService({
      messageStore: store,
      clickhouseClient: ch.client as never,
      encryptionInterceptor: null,
      redis: null,
      eventStore: null,
      traceStore: null,
    });
    await svc.submit(makeInput());
    await svc.submit(makeInput());
    expect(ch.inserts).toHaveLength(2);
  });

  it('returns STORAGE_FAILURE when CH insert throws AND releases the dedup slot', async () => {
    await seedAssistantMessage(store);
    const ch = makeFakeClickHouseClient();
    const { redis, store: redisStore } = makeFakeRedis();
    ch.setThrowOnInsert(true);
    const svc = new FeedbackService({
      messageStore: store,
      clickhouseClient: ch.client as never,
      encryptionInterceptor: null,
      redis,
      eventStore: null,
      traceStore: null,
    });
    const result = await svc.submit(makeInput());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('STORAGE_FAILURE');

    // Slot released → retry can proceed once CH recovers
    expect(redisStore.size).toBe(0);
    ch.setThrowOnInsert(false);
    const retry = await svc.submit(makeInput());
    expect(retry.ok).toBe(true);
  });

  it('runs EventStore + TraceStore emits through scrubSecrets — never sends raw feedback_text', async () => {
    await seedAssistantMessage(store);
    const ch = makeFakeClickHouseClient();
    const es = makeFakeEventStore();
    const ts = makeFakeTraceStore();
    const svc = new FeedbackService({
      messageStore: store,
      clickhouseClient: ch.client as never,
      encryptionInterceptor: null,
      redis: null,
      eventStore: es.eventStore as never,
      traceStore: ts.traceStore,
    });
    await svc.submit(makeInput({ feedbackText: 'My SSN is 123-45-6789 — terrible answer' }));
    const data = (es.emits[0] as Record<string, unknown>).data as Record<string, unknown>;
    expect(data.feedback_text).toBeUndefined();
    expect(data.has_feedback_text).toBe(true);
    expect(data.feedback_text_length).toBeGreaterThan(0);
    const traceData = ts.events[0]?.event.data as Record<string, unknown>;
    expect(traceData.feedback_text).toBeUndefined();
  });

  it('passes plaintext to the encryption interceptor and sets encrypted=1/key_version=1', async () => {
    await seedAssistantMessage(store);
    const ch = makeFakeClickHouseClient();
    const { interceptor, beforeInsertCalls } = makeFakeInterceptor();
    const svc = new FeedbackService({
      messageStore: store,
      clickhouseClient: ch.client as never,
      encryptionInterceptor: interceptor as never,
      redis: null,
      eventStore: null,
      traceStore: null,
    });
    await svc.submit(makeInput({ feedbackText: 'plaintext-secret' }));
    expect(beforeInsertCalls).toHaveLength(1);
    const rowsToInterceptor = beforeInsertCalls[0]!.rows;
    // Interceptor sees plaintext
    expect(rowsToInterceptor[0]?.feedback_text).toBe('plaintext-secret');
    // CH gets the post-interceptor row (encryption applied by the fake)
    const row = ch.inserts[0]?.values[0] as Record<string, unknown>;
    expect(row.feedback_text).toBe('[ENCRYPTED:plaintext-secret]');
    // Service-side `encrypted` flags reflect that an interceptor is configured
    expect(row.encrypted).toBe(1);
    expect(row.key_version).toBe(1);
  });

  it('sets encrypted=0 / key_version=0 when no interceptor is configured', async () => {
    await seedAssistantMessage(store);
    const ch = makeFakeClickHouseClient();
    const svc = new FeedbackService({
      messageStore: store,
      clickhouseClient: ch.client as never,
      encryptionInterceptor: null,
      redis: null,
      eventStore: null,
      traceStore: null,
    });
    await svc.submit(makeInput({ feedbackText: 'whatever' }));
    const row = ch.inserts[0]?.values[0] as Record<string, unknown>;
    expect(row.encrypted).toBe(0);
    expect(row.key_version).toBe(0);
  });

  it('preserves ingress_type for action_submit', async () => {
    await seedAssistantMessage(store);
    const ch = makeFakeClickHouseClient();
    const svc = new FeedbackService({
      messageStore: store,
      clickhouseClient: ch.client as never,
      encryptionInterceptor: null,
      redis: null,
      eventStore: null,
      traceStore: null,
    });
    await svc.submit(makeInput({ ingress: 'action_submit' }));
    const row = ch.inserts[0]?.values[0] as Record<string, unknown>;
    expect(row.ingress_type).toBe('action_submit');
    expect(row.source).toBe('websocket'); // stays in the documented enum
  });

  it('writes has_pii=1 only when feedback_text is non-empty', async () => {
    await seedAssistantMessage(store);
    const ch = makeFakeClickHouseClient();
    const svc = new FeedbackService({
      messageStore: store,
      clickhouseClient: ch.client as never,
      encryptionInterceptor: null,
      redis: null,
      eventStore: null,
      traceStore: null,
    });
    await svc.submit(makeInput()); // no feedback_text
    let row = ch.inserts[0]?.values[0] as Record<string, unknown>;
    expect(row.has_pii).toBe(0);
    expect(row.feedback_text).toBe('');

    await svc.submit({ ...makeInput({ feedbackText: 'with text' }), userId: 'user-2' });
    row = ch.inserts[1]?.values[0] as Record<string, unknown>;
    expect(row.has_pii).toBe(1);
  });

  it('runs without an EventStore (null deps gracefully)', async () => {
    await seedAssistantMessage(store);
    const ch = makeFakeClickHouseClient();
    const ts = makeFakeTraceStore();
    const svc = new FeedbackService({
      messageStore: store,
      clickhouseClient: ch.client as never,
      encryptionInterceptor: null,
      redis: null,
      eventStore: null,
      traceStore: ts.traceStore,
    });
    const result = await svc.submit(makeInput());
    expect(result.ok).toBe(true);
    expect(ch.inserts).toHaveLength(1);
    expect(ts.events).toHaveLength(1);
  });

  it('runs without a TraceStore (null deps gracefully)', async () => {
    await seedAssistantMessage(store);
    const ch = makeFakeClickHouseClient();
    const es = makeFakeEventStore();
    const svc = new FeedbackService({
      messageStore: store,
      clickhouseClient: ch.client as never,
      encryptionInterceptor: null,
      redis: null,
      eventStore: es.eventStore as never,
      traceStore: null,
    });
    const result = await svc.submit(makeInput());
    expect(result.ok).toBe(true);
    expect(ch.inserts).toHaveLength(1);
    expect(es.emits).toHaveLength(1);
  });

  it('returns the generated feedbackId and uses it as event_id', async () => {
    await seedAssistantMessage(store);
    const ch = makeFakeClickHouseClient();
    const es = makeFakeEventStore();
    const svc = new FeedbackService({
      messageStore: store,
      clickhouseClient: ch.client as never,
      encryptionInterceptor: null,
      redis: null,
      eventStore: es.eventStore as never,
      traceStore: null,
      idGenerator: () => 'deterministic-id',
    });
    const result = await svc.submit(makeInput());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.feedbackId).toBe('deterministic-id');
    const event = es.emits[0] as Record<string, unknown>;
    expect(event.event_id).toBe('deterministic-id');
    const row = ch.inserts[0]?.values[0] as Record<string, unknown>;
    expect(row.feedback_id).toBe('deterministic-id');
  });

  it('records different user ids without colliding on dedup', async () => {
    await seedAssistantMessage(store);
    const ch = makeFakeClickHouseClient();
    const { redis } = makeFakeRedis();
    const svc = new FeedbackService({
      messageStore: store,
      clickhouseClient: ch.client as never,
      encryptionInterceptor: null,
      redis,
      eventStore: null,
      traceStore: null,
    });
    const a = await svc.submit(makeInput({ ingress: 'feedback_submit' }));
    const b = await svc.submit({ ...makeInput(), userId: 'user-2' });
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(ch.inserts).toHaveLength(2);
  });

  it('persists star ratings 1..5', async () => {
    await seedAssistantMessage(store);
    const ch = makeFakeClickHouseClient();
    const svc = new FeedbackService({
      messageStore: store,
      clickhouseClient: ch.client as never,
      encryptionInterceptor: null,
      redis: null,
      eventStore: null,
      traceStore: null,
    });
    for (let star = 1; star <= 5; star += 1) {
      await svc.submit({
        ...makeInput({ ratingType: 'star', ratingValue: star }),
        userId: `user-${star}`,
      });
    }
    expect(ch.inserts).toHaveLength(5);
    expect(ch.inserts.map((i) => (i.values[0] as Record<string, unknown>).rating_value)).toEqual([
      1, 2, 3, 4, 5,
    ]);
  });
});
