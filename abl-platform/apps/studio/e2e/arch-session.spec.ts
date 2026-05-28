import { test, expect, request } from '@playwright/test';
import { checkArchConversationPrerequisites, type ArchE2EPrerequisites } from './helpers/arch';

/**
 * Arch session flow — Stage 1 baseline E2E.
 *
 * HTTP-only. No UI. No mocks. Each scenario exercises real auth, real
 * Mongo persistence via the public API, real SSE stream drain.
 *
 * Spec: docs/superpowers/specs/2026-04-19-arch-v4-session-fix-design.md
 */

const BASE_URL = process.env.STUDIO_URL ?? 'http://localhost:5173';

/**
 * Login via the dev-login API (programmatic — no Origin header).
 *
 * The real endpoint is `/api/auth/dev-login`. It returns:
 *   { accessToken, user, expiresIn, refreshToken? }
 *
 * The tenantId is encoded in the JWT (requireTenantAuth reads it from
 * the Bearer token), so we do NOT need an X-Tenant-Id header.
 */
async function devLogin(): Promise<{ accessToken: string }> {
  const ctx = await request.newContext({ baseURL: BASE_URL });
  const res = await ctx.post('/api/auth/dev-login', {
    data: {
      email: `arch-ai-session-${Date.now()}@e2e-smoke.test`,
      name: 'Arch Session E2E',
    },
  });
  expect(res.ok(), `dev login failed: ${res.status()}`).toBe(true);
  const body = (await res.json()) as { accessToken: string };
  await ctx.dispose();
  return body;
}

interface ArchSessionLite {
  id: string;
  state: string;
  metadata: {
    messages?: Array<{ role: string; content?: unknown }>;
    phase?: string;
    specification?: { projectName?: string };
    pendingInteraction?: { kind?: string };
  };
}

/** Drain an SSE response body — waits for the turn to commit. */
async function drainStream(res: { body(): Promise<Buffer> }): Promise<void> {
  // Playwright's request API buffers the whole body; awaiting body() waits for end-of-stream.
  await res.body();
}

test.describe('Arch session flow @arch-session', () => {
  let prerequisites: ArchE2EPrerequisites = { ok: true, reason: 'ready' };

  test.setTimeout(180_000); // LLM turns can take 30-60s each.

  test.beforeAll(async ({ request }) => {
    prerequisites = await checkArchConversationPrerequisites(request);
  });

  test.beforeEach(() => {
    test.skip(!prerequisites.ok, prerequisites.reason);
  });

  test('1. message persistence — metadata.messages grows across turns', async () => {
    const { accessToken } = await devLogin();
    const ctx = await request.newContext({
      baseURL: BASE_URL,
      extraHTTPHeaders: {
        Authorization: `Bearer ${accessToken}`,
      },
    });
    try {
      // POST /sessions returns { success: true, sessionId: "..." }
      const createRes = await ctx.post('/api/arch-ai/sessions', {
        data: { mode: 'ONBOARDING' },
      });
      expect(createRes.ok()).toBe(true);
      const createBody = (await createRes.json()) as { success: boolean; sessionId: string };
      expect(createBody.sessionId).toBeTruthy();
      const sessionId = createBody.sessionId;

      const msg1 = await ctx.post('/api/arch-ai/message', {
        data: { sessionId, type: 'message', text: 'I want a customer support bot' },
      });
      expect(msg1.ok()).toBe(true);
      await drainStream(msg1);

      // GET /sessions/:id returns { success, session, resume }
      const mid = await ctx.get(`/api/arch-ai/sessions/${sessionId}`);
      expect(mid.ok()).toBe(true);
      const midDoc = (await mid.json()) as { session: ArchSessionLite };
      expect(midDoc.session.metadata.messages?.length ?? 0).toBeGreaterThanOrEqual(2);
      // Guard Task 1: no stray top-level messages field.
      expect((midDoc.session as unknown as { messages?: unknown }).messages).toBeUndefined();

      const msg2 = await ctx.post('/api/arch-ai/message', {
        data: { sessionId, type: 'message', text: 'Name it SupportBot' },
      });
      expect(msg2.ok()).toBe(true);
      await drainStream(msg2);

      const final = await ctx.get(`/api/arch-ai/sessions/${sessionId}`);
      const finalDoc = (await final.json()) as { session: ArchSessionLite };
      expect(finalDoc.session.metadata.messages?.length ?? 0).toBeGreaterThan(
        midDoc.session.metadata.messages?.length ?? 0,
      );
      expect(finalDoc.session.metadata.phase).toBe('INTERVIEW');
    } finally {
      await ctx.dispose();
    }
  });

  test('2. /sessions/current returns { session, resume } with populated resume', async () => {
    const { accessToken } = await devLogin();
    const ctx = await request.newContext({
      baseURL: BASE_URL,
      extraHTTPHeaders: {
        Authorization: `Bearer ${accessToken}`,
      },
    });
    try {
      const createRes = await ctx.post('/api/arch-ai/sessions', {
        data: { mode: 'ONBOARDING' },
      });
      expect(createRes.ok()).toBe(true);
      const createBody = (await createRes.json()) as { sessionId: string };
      const sessionId = createBody.sessionId;

      const msg = await ctx.post('/api/arch-ai/message', {
        data: { sessionId, type: 'message', text: 'Build a recommender for movies' },
      });
      await drainStream(msg);

      const cur = await ctx.get('/api/arch-ai/sessions/current?mode=ONBOARDING');
      expect(cur.ok()).toBe(true);
      const body = (await cur.json()) as {
        session: ArchSessionLite;
        resume: {
          phase?: string;
          state?: string;
          canSendMessage?: boolean;
          pending?: unknown;
          nextAction?: unknown;
          artifacts?: {
            topology?: unknown;
            files?: unknown;
            buildProgress?: unknown;
            pendingMutation?: unknown;
          };
        } | null;
      };

      expect(body.session.id).toBe(sessionId);
      expect(body.resume).not.toBeNull();
      expect(body.resume?.phase).toBe('INTERVIEW');
      expect(body.resume?.canSendMessage).toBeDefined();
      expect(body.resume?.artifacts).toBeDefined();
      expect(body.resume?.nextAction).toBeDefined();
    } finally {
      await ctx.dispose();
    }
  });

  test('3. discard — archive then create yields fresh IDLE session', async () => {
    const { accessToken } = await devLogin();
    const ctx = await request.newContext({
      baseURL: BASE_URL,
      extraHTTPHeaders: {
        Authorization: `Bearer ${accessToken}`,
      },
    });
    try {
      const create1 = await ctx.post('/api/arch-ai/sessions', {
        data: { mode: 'ONBOARDING' },
      });
      const create1Body = (await create1.json()) as { sessionId: string };
      const oldSessionId = create1Body.sessionId;

      const msg = await ctx.post('/api/arch-ai/message', {
        data: { sessionId: oldSessionId, type: 'message', text: 'Just exploring' },
      });
      await drainStream(msg);

      const archiveRes = await ctx.post(`/api/arch-ai/sessions/${oldSessionId}/archive`);
      expect(archiveRes.ok()).toBe(true);

      const create2 = await ctx.post('/api/arch-ai/sessions', {
        data: { mode: 'ONBOARDING' },
      });
      expect(create2.ok()).toBe(true);
      const create2Body = (await create2.json()) as { sessionId: string };
      expect(create2Body.sessionId).not.toBe(oldSessionId);

      // Verify new session is IDLE via GET
      const freshGet = await ctx.get(`/api/arch-ai/sessions/${create2Body.sessionId}`);
      const freshDoc = (await freshGet.json()) as { session: ArchSessionLite };
      expect(freshDoc.session.state).toBe('IDLE');

      // Verify old session is ARCHIVED
      const oldDoc = await ctx.get(`/api/arch-ai/sessions/${oldSessionId}`);
      const oldBody = (await oldDoc.json()) as { session: ArchSessionLite };
      expect(oldBody.session.state).toBe('ARCHIVED');
    } finally {
      await ctx.dispose();
    }
  });

  test('4. cancel — in-flight turn terminates and session returns to IDLE', async () => {
    const { accessToken } = await devLogin();
    const ctx = await request.newContext({
      baseURL: BASE_URL,
      extraHTTPHeaders: {
        Authorization: `Bearer ${accessToken}`,
      },
    });
    try {
      const createRes = await ctx.post('/api/arch-ai/sessions', {
        data: { mode: 'ONBOARDING' },
      });
      expect(createRes.ok()).toBe(true);
      const { sessionId } = (await createRes.json()) as { sessionId: string };

      // Kick off a real turn (not awaited).
      const turnPromise = ctx.post('/api/arch-ai/message', {
        data: {
          sessionId,
          type: 'message',
          text: 'Tell me about agent orchestration',
        },
        timeout: 60_000,
      });

      // Give the LLM a brief head start so there's an in-flight turn to cancel.
      await new Promise((r) => setTimeout(r, 500));

      const cancelRes = await ctx.post(`/api/arch-ai/sessions/${sessionId}/cancel`);
      expect(cancelRes.ok()).toBe(true);

      // Drain the turn response — should complete with turn_canceled, not hang.
      const res = await turnPromise;
      expect(res.ok()).toBe(true);
      const streamBody = (await res.body()).toString('utf8');
      expect(streamBody).toMatch(/"type"\s*:\s*"turn_ended"/);
      expect(streamBody).toMatch(/"reason"\s*:\s*"canceled"/);

      const state = await ctx.get(`/api/arch-ai/sessions/${sessionId}`);
      const body = (await state.json()) as { session: { state: string } };
      expect(body.session.state).toBe('IDLE');
    } finally {
      await ctx.dispose();
    }
  });

  test('5. ring buffer — /events replays durable events since lastSeenSeq', async () => {
    // SNAPSHOT_REQUIRED semantics (cursor behind a buffer with evictions) are
    // unit-tested in packages/arch-ai/src/__tests__/session/ring-buffer.test.ts —
    // triggering it in E2E would require pushing >1000 events, which is impractical.
    const { accessToken } = await devLogin();
    const ctx = await request.newContext({
      baseURL: BASE_URL,
      extraHTTPHeaders: {
        Authorization: `Bearer ${accessToken}`,
      },
    });
    try {
      const createRes = await ctx.post('/api/arch-ai/sessions', {
        data: { mode: 'ONBOARDING' },
      });
      expect(createRes.ok()).toBe(true);
      const { sessionId } = (await createRes.json()) as { sessionId: string };

      const msg = await ctx.post('/api/arch-ai/message', {
        data: { sessionId, type: 'message', text: 'Call it Helper' },
      });
      await msg.body();

      // Replay from seq 0 — expect at least one turn_committed event.
      const events = await ctx.get(`/api/arch-ai/sessions/${sessionId}/events?lastSeenSeq=-1`);
      expect(events.ok()).toBe(true);
      const body = (await events.body()).toString('utf8');
      expect(body).toMatch(/event:\s*turn_committed/);
    } finally {
      await ctx.dispose();
    }
  });
});
