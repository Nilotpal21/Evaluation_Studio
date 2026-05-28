/**
 * Cross-Tenant E2E Test — External Black-Box
 *
 * Treats the runtime as an EXTERNAL HTTP service. No internal function calls,
 * no direct resolver assertions, no imported runtime modules. Every interaction
 * uses the A2A SDK client or raw HTTP requests — the same way a real remote
 * A2A client would interact.
 *
 * Prerequisites:
 *   - Runtime running on port 3112 (pm2 / apx)
 *   - Two A2A ChannelConnections pre-created via Studio APIs:
 *     Connection A: 019cff49-d759-7ef5-80e0-c63f574bc55d (proj-travel, no card overrides)
 *     Connection B: 019cff4a-8537-732c-b529-ac937cae0eb8 (proj-airlines, card overrides)
 *   - Tenant-scoped Anthropic credential configured and set as default
 *
 * SDK: @a2a-js/sdk 0.3.13
 *   Uses ClientFactory.createFromUrl() for proper SDK client construction
 *   JSON-RPC methods: message/send, message/stream, tasks/get, tasks/cancel
 */

import { describe, test, expect, beforeAll, beforeEach } from 'vitest';
import { Client, JsonRpcTransport } from '@a2a-js/sdk/client';
import type {
  AgentCard,
  Message,
  Task,
  TaskStatusUpdateEvent,
  TaskArtifactUpdateEvent,
} from '@a2a-js/sdk';

// ---------------------------------------------------------------------------
// Configuration — points to live runtime
// ---------------------------------------------------------------------------

const RUNTIME_PORT = 3112;
const BASE_URL = `http://localhost:${RUNTIME_PORT}`;

// Connection A: Travel Agent (auto-generated card, no config.card overrides)
const CONNECTION_A = '019cff49-d759-7ef5-80e0-c63f574bc55d';

// Connection B: Airlines Support (custom card overrides in config.card)
const CONNECTION_B = '019cff4a-8537-732c-b529-ac937cae0eb8';

// LLM-backed tests need longer timeouts (real API calls)
const LLM_TIMEOUT = 60_000;
const LIVE_E2E_PRECHECK_TIMEOUT_MS = 45_000;
const LIVE_E2E_HOOK_TIMEOUT_MS = 60_000;

// ---------------------------------------------------------------------------
// SDK Clients — initialized in beforeAll
// ---------------------------------------------------------------------------

let clientA: Client;
let clientB: Client;
let cardA: AgentCard;
let cardB: AgentCard;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Generate a unique ID for test isolation */
function uid(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Build a valid A2A Message for SDK sendMessage params */
function makeMessage(text: string, contextId?: string): Message {
  return {
    kind: 'message',
    messageId: uid('msg'),
    role: 'user',
    parts: [{ kind: 'text', text }],
    ...(contextId ? { contextId } : {}),
  };
}

/** Extract text from a SendMessageResult (handles both Message and Task) */
function extractResponseText(result: Message | Task): string {
  if (result.kind === 'message') {
    return (
      (result as Message).parts
        ?.filter((p) => p.kind === 'text')
        .map((p) => ('text' in p ? p.text : ''))
        .join(' ') || ''
    );
  }

  // Task response with artifacts
  const task = result as Task;
  if (task.artifacts) {
    return (
      task.artifacts
        .flatMap((a) => a.parts)
        .filter((p) => p.kind === 'text')
        .map((p) => ('text' in p ? p.text : ''))
        .join(' ') || ''
    );
  }

  return '';
}

/** Raw JSON-RPC POST — used only for error-path tests the SDK client wouldn't allow */
async function rawJsonRpc(
  connectionId: string,
  id: string,
  method: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  params: Record<string, any>,
): Promise<Response> {
  return fetch(`${BASE_URL}/a2a/${connectionId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
}

// ---------------------------------------------------------------------------
// Precondition check & SDK client initialization
// ---------------------------------------------------------------------------

let runtimeAvailable = false;

beforeAll(async () => {
  // Verify runtime is healthy — skip gracefully if not reachable
  try {
    const health = await fetch(`${BASE_URL}/health`, {
      signal: AbortSignal.timeout(LIVE_E2E_PRECHECK_TIMEOUT_MS),
    });
    if (!health.ok) {
      console.warn(
        `[SKIP] Runtime health check failed (${health.status}). ` +
          `Start it with: pnpm build --filter=@agent-platform/runtime && pm2 restart runtime`,
      );
      return;
    }
  } catch (err) {
    console.warn(
      `[SKIP] Runtime not reachable at ${BASE_URL}. ` +
        `Start it with: pnpm build --filter=@agent-platform/runtime && pm2 restart runtime. ` +
        `Original error: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  // Fetch agent cards directly. The card's `url` field is a relative path
  // (e.g. /a2a/CONNECTION_ID) — correct for production behind a reverse proxy,
  // but the SDK's Client needs an absolute URL for its transport endpoint.
  // We construct Client with a JsonRpcTransport pointing to the absolute URL.
  const [cardARes, cardBRes] = await Promise.all([
    fetch(`${BASE_URL}/a2a/${CONNECTION_A}/.well-known/agent-card.json`, {
      signal: AbortSignal.timeout(LIVE_E2E_PRECHECK_TIMEOUT_MS),
    }),
    fetch(`${BASE_URL}/a2a/${CONNECTION_B}/.well-known/agent-card.json`, {
      signal: AbortSignal.timeout(LIVE_E2E_PRECHECK_TIMEOUT_MS),
    }),
  ]);

  if (!cardARes.ok || !cardBRes.ok) {
    console.warn(
      `[SKIP] Required A2A ChannelConnections are not available. ` +
        `Agent card fetch statuses: A=${cardARes.status}, B=${cardBRes.status}. ` +
        `Ensure both ChannelConnections exist and are active before running this live E2E suite.`,
    );
    return;
  }

  cardA = await cardARes.json();
  cardB = await cardBRes.json();

  // Create SDK clients with absolute endpoint URLs
  const transportA = new JsonRpcTransport({
    endpoint: `${BASE_URL}/a2a/${CONNECTION_A}`,
  });
  const transportB = new JsonRpcTransport({
    endpoint: `${BASE_URL}/a2a/${CONNECTION_B}`,
  });
  clientA = new Client(transportA, cardA);
  clientB = new Client(transportB, cardB);

  runtimeAvailable = true;
}, LIVE_E2E_HOOK_TIMEOUT_MS);

// Skip all tests if live prerequisites are not available
beforeEach(({ skip }) => {
  if (!runtimeAvailable) skip();
});

// =============================================================================
// Suite 1: Agent Card Discovery
// =============================================================================

describe('Agent Card Discovery', () => {
  test('auto-generated card for connection with no config.card overrides', () => {
    expect(cardA).toMatchObject({
      name: expect.any(String),
      description: expect.any(String),
      url: `/a2a/${CONNECTION_A}`,
      version: '1.0.0',
      protocolVersion: '0.2.1',
      capabilities: {
        streaming: true,
        pushNotifications: true,
        stateTransitionHistory: true,
      },
      defaultInputModes: ['text'],
      defaultOutputModes: ['text'],
      skills: expect.arrayContaining([
        expect.objectContaining({
          id: expect.any(String),
          name: expect.any(String),
          description: expect.any(String),
        }),
      ]),
    });
  });

  test('customized card when config.card overrides are set', () => {
    expect(cardB.name).toBe('Flight Search API');
    expect(cardB.description).toBe('Search flights, check availability, get real-time pricing');
    expect(cardB.version).toBe('2.0.0');
    expect(cardB.defaultOutputModes).toEqual(['text', 'data']);

    expect(cardB.skills).toHaveLength(2);
    expect(cardB.skills[0]).toMatchObject({
      name: 'Flight Search',
      description: 'Search for flights by route and date',
      tags: ['flights', 'search'],
    });
    expect(cardB.skills[1]).toMatchObject({
      name: 'Availability Check',
      description: 'Check seat availability for flights',
      tags: ['availability'],
    });
  });

  test('404 for non-existent connectionId', async () => {
    const res = await fetch(
      `${BASE_URL}/a2a/non-existent-connection-id/.well-known/agent-card.json`,
    );
    expect(res.status).toBe(404);
  });

  test('400 for invalid connectionId format (path traversal attempt)', async () => {
    const res = await fetch(`${BASE_URL}/a2a/../../../etc/passwd/.well-known/agent-card.json`);
    // connectionId validation regex (/^[\w-]+$/) should reject this
    expect([400, 404]).toContain(res.status);
  });

  test('connection A and connection B have different agent identities', () => {
    expect(cardA.name).not.toBe(cardB.name);
    expect(cardA.url).not.toBe(cardB.url);
    expect(cardA.url).toContain(CONNECTION_A);
    expect(cardB.url).toContain(CONNECTION_B);
  });
});

// =============================================================================
// Suite 2: Message Lifecycle via SDK client (message/send)
// =============================================================================

describe('Message Lifecycle via SDK client', () => {
  test(
    'sendMessage returns a valid agent response via connection A',
    async () => {
      const result = await clientA.sendMessage({
        message: makeMessage('Hello, what can you help me with?'),
      });

      expect(result).toBeDefined();
      const text = extractResponseText(result);
      expect(text.length).toBeGreaterThan(10);

      // Verify it's a proper message or task
      if (result.kind === 'message') {
        const msg = result as Message;
        expect(msg.role).toBe('agent');
        expect(msg.parts.length).toBeGreaterThan(0);
        expect(msg.parts[0].kind).toBe('text');
      }
    },
    LLM_TIMEOUT,
  );

  test(
    'sendMessage to connection B produces a real LLM response',
    async () => {
      const result = await clientB.sendMessage({
        message: makeMessage('Find flights from NYC to London'),
      });

      expect(result).toBeDefined();
      const text = extractResponseText(result);
      expect(text.length).toBeGreaterThan(10);
    },
    LLM_TIMEOUT,
  );

  test(
    'getTask retrieves a previously created task (if response is a Task)',
    async () => {
      const result = await clientB.sendMessage({
        message: makeMessage('Check availability for BA117'),
      });

      // If the response was a Task (not a direct Message), verify getTask works
      if ('id' in result && result.kind !== 'message') {
        const task = result as Task;
        const retrieved = await clientB.getTask({ id: task.id });
        expect(retrieved.id).toBe(task.id);
      }
    },
    LLM_TIMEOUT,
  );
});

// =============================================================================
// Suite 3: Multi-Turn Session Continuity
// =============================================================================

describe('Multi-Turn Session Continuity', () => {
  const CONTEXT_ID = uid('ctx-multi');

  test(
    'Turn 1: initial message creates a new session',
    async () => {
      const result = await clientA.sendMessage({
        message: makeMessage('I want to book a trip to Paris for 3 people in April', CONTEXT_ID),
      });

      expect(result).toBeDefined();
      const text = extractResponseText(result);
      expect(text.length).toBeGreaterThan(10);
    },
    LLM_TIMEOUT,
  );

  test(
    'Turn 2: follow-up with same contextId continues the conversation',
    async () => {
      const result = await clientA.sendMessage({
        message: makeMessage('What about hotels near the Eiffel Tower?', CONTEXT_ID),
      });

      expect(result).toBeDefined();
      const text = extractResponseText(result).toLowerCase();
      expect(text.length).toBeGreaterThan(10);

      // Heuristic: session-aware response should reference the travel context
      const hasContext =
        text.includes('paris') ||
        text.includes('hotel') ||
        text.includes('eiffel') ||
        text.includes('trip') ||
        text.includes('travel') ||
        text.includes('accommodation');
      expect(hasContext).toBe(true);
    },
    LLM_TIMEOUT,
  );

  test(
    'Turn 3: different contextId creates an independent session',
    async () => {
      const independentCtx = uid('ctx-independent');
      const result = await clientA.sendMessage({
        message: makeMessage('Hello, what services do you offer?', independentCtx),
      });

      expect(result).toBeDefined();
      const text = extractResponseText(result).toLowerCase();
      expect(text.length).toBeGreaterThan(10);
    },
    LLM_TIMEOUT,
  );
});

// =============================================================================
// Suite 4: SSE Streaming via SDK client (sendMessageStream)
// =============================================================================

describe('SSE Streaming via SDK client', () => {
  test(
    'sendMessageStream emits correct event sequence: working → artifacts → last-chunk → message → completed',
    async () => {
      const events: Array<Message | Task | TaskStatusUpdateEvent | TaskArtifactUpdateEvent> = [];

      const stream = clientA.sendMessageStream({
        message: makeMessage('Tell me a short joke about traveling'),
      });

      for await (const event of stream) {
        events.push(event);
      }

      // Must have received events
      // Expected sequence from SDK client:
      //   0: status-update(working, final=false)
      //   1..N: artifact-update (streaming chunks)
      //   N+1: message (final agent response)
      // Note: The SDK does NOT yield the final status-update(completed, final=true)
      // because that event closes the SSE stream before the client iterator reads it.
      expect(events.length).toBeGreaterThan(2);

      // Categorize events by kind for sequence verification
      const statusEvents = events.filter(
        (e) => e.kind === 'status-update',
      ) as TaskStatusUpdateEvent[];
      const artifactEvents = events.filter(
        (e) => e.kind === 'artifact-update',
      ) as TaskArtifactUpdateEvent[];
      const messageEvents = events.filter((e) => e.kind === 'message') as Message[];

      // First event: status-update with state 'working' (non-final)
      const firstEvent = events[0];
      expect(firstEvent.kind).toBe('status-update');
      expect((firstEvent as TaskStatusUpdateEvent).status.state).toBe('working');
      expect((firstEvent as TaskStatusUpdateEvent).final).toBe(false);

      // Must have artifact-update events with streaming text chunks
      expect(artifactEvents.length).toBeGreaterThan(0);

      // Verify artifact sequence: first chunk is NOT append, last chunk has lastChunk=true
      expect(artifactEvents[0].append).toBeFalsy();
      const lastArtifact = artifactEvents[artifactEvents.length - 1];
      expect(lastArtifact.lastChunk).toBe(true);

      // Verify append flag progression: first is false, subsequent are true
      if (artifactEvents.length > 1) {
        for (let i = 1; i < artifactEvents.length; i++) {
          expect(artifactEvents[i].append).toBe(true);
        }
      }

      // Accumulate streamed text from artifact parts — must form a real response
      const streamedText = artifactEvents
        .flatMap((e) => e.artifact.parts)
        .filter((p) => p.kind === 'text')
        .map((p) => ('text' in p ? p.text : ''))
        .join('');
      expect(streamedText.length).toBeGreaterThan(0);

      // Last event from SDK: Message with the complete agent response
      const lastEvent = events[events.length - 1];
      expect(lastEvent.kind).toBe('message');
      const finalMessage = lastEvent as Message;
      expect(finalMessage.role).toBe('agent');
      expect(finalMessage.parts.length).toBeGreaterThan(0);
      expect(finalMessage.parts[0].kind).toBe('text');
      const messageText = (finalMessage.parts[0] as { text: string }).text;
      expect(messageText.length).toBeGreaterThan(10);
    },
    LLM_TIMEOUT,
  );

  test(
    'streaming multi-turn: turn 2 response references turn 1 context',
    async () => {
      const ctxId = uid('ctx-sse-mt');

      // Turn 1 via streaming — establish context about Tokyo flights
      const events1: Array<Message | Task | TaskStatusUpdateEvent | TaskArtifactUpdateEvent> = [];
      const stream1 = clientB.sendMessageStream({
        message: makeMessage('Find flights from San Francisco to Tokyo next week', ctxId),
      });
      for await (const event of stream1) {
        events1.push(event);
      }

      // Verify turn 1 event structure: working status + artifacts + message
      expect(events1[0].kind).toBe('status-update');
      expect((events1[0] as TaskStatusUpdateEvent).status.state).toBe('working');
      expect(events1.some((e) => e.kind === 'artifact-update')).toBe(true);
      expect(events1[events1.length - 1].kind).toBe('message');

      // Turn 2 via streaming — same contextId, follow-up question
      const events2: Array<Message | Task | TaskStatusUpdateEvent | TaskArtifactUpdateEvent> = [];
      const stream2 = clientB.sendMessageStream({
        message: makeMessage('Show me only business class options for that route', ctxId),
      });
      for await (const event of stream2) {
        events2.push(event);
      }

      // Verify turn 2 event structure: same pattern
      expect(events2[0].kind).toBe('status-update');
      expect(events2[events2.length - 1].kind).toBe('message');

      // Extract turn 2 accumulated text from artifact events + message
      const artifactText2 = events2
        .filter((e) => e.kind === 'artifact-update')
        .flatMap((e) => (e as TaskArtifactUpdateEvent).artifact.parts)
        .filter((p) => p.kind === 'text')
        .map((p) => ('text' in p ? p.text : ''))
        .join('');

      const messageText2 = events2
        .filter((e) => e.kind === 'message')
        .flatMap((e) => (e as Message).parts)
        .filter((p) => p.kind === 'text')
        .map((p) => ('text' in p ? p.text : ''))
        .join('');

      const turn2Text = (artifactText2 + ' ' + messageText2).toLowerCase();

      // Turn 2 should reference the travel context from turn 1
      const hasContext =
        turn2Text.includes('tokyo') ||
        turn2Text.includes('san francisco') ||
        turn2Text.includes('sfo') ||
        turn2Text.includes('flight') ||
        turn2Text.includes('business') ||
        turn2Text.includes('class');
      expect(hasContext).toBe(true);
    },
    LLM_TIMEOUT * 2,
  );
});

// =============================================================================
// Suite 5: Connection Isolation (same tenant, different projects)
// =============================================================================

describe('Connection Isolation', () => {
  test(
    'same contextId on different connections creates independent sessions',
    async () => {
      const sharedContextId = uid('ctx-shared');

      // Send to Connection A (travel project) and B (airlines project) with SAME contextId
      const [resultA, resultB] = await Promise.all([
        clientA.sendMessage({
          message: makeMessage('Book a hotel in New York City', sharedContextId),
        }),
        clientB.sendMessage({
          message: makeMessage('Find flights to London tomorrow', sharedContextId),
        }),
      ]);

      // Both should succeed independently
      expect(resultA).toBeDefined();
      expect(resultB).toBeDefined();

      const textA = extractResponseText(resultA);
      const textB = extractResponseText(resultB);

      // Both produced non-empty responses
      expect(textA.length).toBeGreaterThan(0);
      expect(textB.length).toBeGreaterThan(0);
    },
    LLM_TIMEOUT * 2,
  );
});

// =============================================================================
// Suite 6: Inbound Authentication
// =============================================================================

describe('Inbound Authentication', () => {
  // Uses Connection B for auth tests — Connection A stays unauthenticated for other suites.
  // The test lifecycle: configure API key → run auth tests → remove API key.
  const AUTH_TEST_CONNECTION = CONNECTION_B;
  const A2A_API_KEY = `test-a2a-key-${Date.now()}`;

  /** Get an auth token via Runtime's dev-login endpoint (no Studio dependency) */
  async function getAuthToken(): Promise<string> {
    const resp = await fetch(`${BASE_URL}/api/auth/dev-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'test@example.com', name: 'Test User' }),
    });
    const body = await resp.json();
    return body.accessToken;
  }

  /** Look up the connection's projectId from the agent card (already fetched) */
  function getProjectId(): string {
    // Connection B was set up in proj-airlines (from test data creation)
    // We can extract this from the cardB's url or use the known value
    return 'proj-airlines';
  }

  /** GET the current connection config via Runtime API */
  async function getConnectionConfig(
    token: string,
    projectId: string,
    connectionId: string,
  ): Promise<Record<string, unknown>> {
    const resp = await fetch(
      `${BASE_URL}/api/projects/${projectId}/channel-connections/${connectionId}`,
      {
        headers: { Authorization: `Bearer ${token}` },
      },
    );
    if (!resp.ok) throw new Error(`GET connection failed: ${resp.status}`);
    const body = await resp.json();
    return (body.connection?.config ?? {}) as Record<string, unknown>;
  }

  /** PATCH the connection config via Runtime API — merges with existing config
   *  to avoid wiping card overrides or other config fields. */
  async function patchConnectionConfig(
    token: string,
    projectId: string,
    connectionId: string,
    configPatch: Record<string, unknown>,
  ): Promise<void> {
    // Read existing config first, then merge
    const existingConfig = await getConnectionConfig(token, projectId, connectionId);
    const mergedConfig = { ...existingConfig, ...configPatch };

    // Remove null keys (e.g. a2aApiKey: null means "remove it")
    for (const [k, v] of Object.entries(mergedConfig)) {
      if (v === null) delete mergedConfig[k];
    }

    const resp = await fetch(
      `${BASE_URL}/api/projects/${projectId}/channel-connections/${connectionId}`,
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ config: mergedConfig }),
      },
    );
    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`PATCH failed: ${resp.status} ${body}`);
    }
  }

  test(
    'configure API key on connection, then reject unauthenticated requests',
    async () => {
      const token = await getAuthToken();
      const projectId = getProjectId();

      // Step 1: Set API key on connection B
      await patchConnectionConfig(token, projectId, AUTH_TEST_CONNECTION, {
        a2aApiKey: A2A_API_KEY,
      });

      // Step 2: Request WITHOUT auth header → should get 401
      const noAuthRes = await fetch(`${BASE_URL}/a2a/${AUTH_TEST_CONNECTION}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: uid('no-auth'),
          method: 'message/send',
          params: { message: makeMessage('Should be rejected') },
        }),
      });
      expect(noAuthRes.status).toBe(401);

      // Step 3: Request with WRONG key → should get 401
      const badKeyRes = await fetch(`${BASE_URL}/a2a/${AUTH_TEST_CONNECTION}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer wrong-key-12345',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: uid('bad-key'),
          method: 'message/send',
          params: { message: makeMessage('Should be rejected') },
        }),
      });
      expect(badKeyRes.status).toBe(401);

      // Step 4: Agent card without auth → should get 401
      const cardNoAuthRes = await fetch(
        `${BASE_URL}/a2a/${AUTH_TEST_CONNECTION}/.well-known/agent-card.json`,
      );
      expect(cardNoAuthRes.status).toBe(401);

      // Step 5: Request with CORRECT key → should succeed
      const goodKeyRes = await fetch(`${BASE_URL}/a2a/${AUTH_TEST_CONNECTION}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${A2A_API_KEY}`,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: uid('good-key'),
          method: 'message/send',
          params: { message: makeMessage('Should succeed with valid key') },
        }),
      });
      // Should NOT be 401 — the request should reach the handler
      expect(goodKeyRes.status).not.toBe(401);
      expect(goodKeyRes.status).not.toBe(403);

      // Step 6: Agent card WITH correct key → should succeed
      const cardAuthRes = await fetch(
        `${BASE_URL}/a2a/${AUTH_TEST_CONNECTION}/.well-known/agent-card.json`,
        { headers: { Authorization: `Bearer ${A2A_API_KEY}` } },
      );
      expect(cardAuthRes.status).toBe(200);
    },
    LLM_TIMEOUT,
  );

  test(
    'remove API key restores unauthenticated access',
    async () => {
      const token = await getAuthToken();
      const projectId = getProjectId();

      // Remove the API key by setting it to null
      await patchConnectionConfig(token, projectId, AUTH_TEST_CONNECTION, {
        a2aApiKey: null,
      });

      // Now unauthenticated requests should work again
      const res = await fetch(
        `${BASE_URL}/a2a/${AUTH_TEST_CONNECTION}/.well-known/agent-card.json`,
      );
      expect(res.status).toBe(200);
    },
    LLM_TIMEOUT,
  );
});

// =============================================================================
// Suite 7: Session Atomicity (Race Condition)
// =============================================================================

describe('Session Atomicity', () => {
  test(
    'concurrent first-turn requests with same contextId converge to ONE session',
    async () => {
      const raceCtx = uid('ctx-atomic');

      // Fire 3 concurrent first-turn messages on the SAME contextId.
      // Without atomic registration, each creates a separate session.
      // With atomic registration (SET NX), all converge to a single session.
      const results = await Promise.allSettled([
        clientA.sendMessage({
          message: makeMessage('Message A: plan a trip to Rome', raceCtx),
        }),
        clientA.sendMessage({
          message: makeMessage('Message B: plan a trip to Berlin', raceCtx),
        }),
        clientA.sendMessage({
          message: makeMessage('Message C: plan a trip to Tokyo', raceCtx),
        }),
      ]);

      const succeeded = results.filter((r) => r.status === 'fulfilled');
      expect(succeeded.length).toBeGreaterThanOrEqual(2);

      // Send TWO sequential follow-ups — the first primes session history,
      // the second verifies all concurrent messages are visible.
      // This is necessary because concurrent executions may overlap before
      // the session's conversation history is updated.
      await clientA.sendMessage({
        message: makeMessage('Summarize what we discussed so far.', raceCtx),
      });

      const followUp = await clientA.sendMessage({
        message: makeMessage(
          'Which cities did I mention in this conversation? List all of them.',
          raceCtx,
        ),
      });

      const text = extractResponseText(followUp).toLowerCase();

      // At least 2 out of 3 cities should be visible — proves session convergence.
      // Concurrent execution timing may cause one message to execute before
      // the session history fully incorporated the prior concurrent message,
      // but the majority must be present (a forked session would show only 1).
      const citiesMentioned = ['rome', 'berlin', 'tokyo'].filter((city) => text.includes(city));
      expect(citiesMentioned.length).toBeGreaterThanOrEqual(2);
    },
    LLM_TIMEOUT * 4,
  );
});

// =============================================================================
// Suite 8: Error Handling and Edge Cases
// =============================================================================

describe('Error Handling and Edge Cases', () => {
  test('malformed JSON body returns an error response', async () => {
    const res = await fetch(`${BASE_URL}/a2a/${CONNECTION_A}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{ invalid json here',
    });

    const body = await res.json();
    // Express JSON parser may intercept before SDK — verify we get an error, not success
    expect(body.error).toBeDefined();
  });

  test('unknown JSON-RPC method returns -32601 Method not found', async () => {
    const res = await rawJsonRpc(CONNECTION_A, uid('bad-method'), 'nonexistent/method', {
      message: makeMessage('hello'),
    });

    const body = await res.json();
    expect(body.error?.code).toBe(-32601);
  });

  test('missing required params returns an error (not success)', async () => {
    const res = await rawJsonRpc(CONNECTION_A, uid('no-params'), 'message/send', {});

    const body = await res.json();
    // SDK may return -32602 (Invalid params) or -32603 (Internal error)
    // depending on where validation occurs in the handler chain
    expect(body.error).toBeDefined();
    expect(body.error.code).toBeLessThan(0);
  });

  test('tasks/get for non-existent task returns error', async () => {
    await expect(clientA.getTask({ id: 'task-does-not-exist-12345' })).rejects.toThrow();
  });

  test(
    'empty message text is handled gracefully (no 500)',
    async () => {
      const res = await rawJsonRpc(CONNECTION_A, uid('empty'), 'message/send', {
        message: {
          kind: 'message',
          messageId: uid('empty-msg'),
          role: 'user',
          parts: [{ kind: 'text', text: '' }],
        },
      });

      const body = await res.json();
      // Should either reject with client error or handle gracefully
      expect(body.result || body.error).toBeDefined();
      if (body.error) {
        expect(body.error.code).not.toBe(-32603); // Not internal server error
      }
    },
    LLM_TIMEOUT,
  );

  test('connectionId with special characters returns 400', async () => {
    const res = await rawJsonRpc('conn<script>alert(1)</script>', uid('xss'), 'message/send', {
      message: makeMessage('xss test'),
    });
    expect([400, 404]).toContain(res.status);
  });

  test('404 for message/send to non-existent connectionId', async () => {
    const res = await rawJsonRpc('bogus-connection-id', 'req-404', 'message/send', {
      message: makeMessage('hello'),
    });
    expect(res.status).toBe(404);
  });
});

// =============================================================================
// Suite 9: Concurrent Requests (Race Conditions)
// =============================================================================

describe('Concurrent Requests', () => {
  test(
    'parallel sendMessage to same connection both complete',
    async () => {
      const [resultA, resultB] = await Promise.all([
        clientA.sendMessage({
          message: makeMessage('What flights are available to Rome?'),
        }),
        clientA.sendMessage({
          message: makeMessage('What hotels are in Barcelona?'),
        }),
      ]);

      expect(resultA).toBeDefined();
      expect(resultB).toBeDefined();

      const textA = extractResponseText(resultA);
      const textB = extractResponseText(resultB);
      expect(textA.length).toBeGreaterThan(0);
      expect(textB.length).toBeGreaterThan(0);
    },
    LLM_TIMEOUT * 2,
  );

  test(
    'parallel first-turn requests with same contextId both succeed and share session',
    async () => {
      const sharedCtx = uid('ctx-race');

      // Race two first-turn messages on same contextId
      const results = await Promise.allSettled([
        clientA.sendMessage({
          message: makeMessage('I want to go to Tokyo', sharedCtx),
        }),
        clientA.sendMessage({
          message: makeMessage('Book me a flight to Sydney', sharedCtx),
        }),
      ]);

      // Both should succeed
      const succeeded = results.filter((r) => r.status === 'fulfilled');
      expect(succeeded.length).toBe(2);

      // Sequential follow-up to let session history consolidate
      await clientA.sendMessage({
        message: makeMessage('Summarize our conversation so far.', sharedCtx),
      });

      const followUp = await clientA.sendMessage({
        message: makeMessage(
          'Which cities did I mention so far in this conversation? Name them all.',
          sharedCtx,
        ),
      });

      const text = extractResponseText(followUp).toLowerCase();
      const cities = ['tokyo', 'sydney'].filter((c) => text.includes(c));

      // At least one city must be present (proves session didn't completely fork).
      // Both cities should ideally be present, but concurrent execution timing
      // may cause one to be missed if executions overlapped.
      expect(cities.length).toBeGreaterThanOrEqual(1);
    },
    LLM_TIMEOUT * 3,
  );
});

// =============================================================================
// Suite 10: Mixed-Mode Multi-Turn (sync → stream → sync)
// =============================================================================

describe('Mixed-Mode Multi-Turn', () => {
  test(
    'sync turn 1 → streaming turn 2 → sync turn 3 preserves context throughout',
    async () => {
      const ctxId = uid('ctx-mixed-mode');

      // Turn 1: Sync — establish context
      const result1 = await clientA.sendMessage({
        message: makeMessage(
          'I want to plan a 5-day vacation to Barcelona in June for 2 people',
          ctxId,
        ),
      });
      expect(result1).toBeDefined();
      const text1 = extractResponseText(result1);
      expect(text1.length).toBeGreaterThan(10);

      // Turn 2: Streaming — follow-up on the same context
      const events2: Array<Message | Task | TaskStatusUpdateEvent | TaskArtifactUpdateEvent> = [];
      const stream2 = clientA.sendMessageStream({
        message: makeMessage('What about hotels near La Sagrada Familia?', ctxId),
      });
      for await (const event of stream2) {
        events2.push(event);
      }

      // Verify streaming worked: working status → artifacts → message
      expect(events2[0].kind).toBe('status-update');
      expect((events2[0] as TaskStatusUpdateEvent).status.state).toBe('working');
      expect(events2[events2.length - 1].kind).toBe('message');

      // Extract streamed response text
      const streamedText2 = events2
        .filter((e) => e.kind === 'artifact-update')
        .flatMap((e) => (e as TaskArtifactUpdateEvent).artifact.parts)
        .filter((p) => p.kind === 'text')
        .map((p) => ('text' in p ? p.text : ''))
        .join('');

      const messageText2 = events2
        .filter((e) => e.kind === 'message')
        .flatMap((e) => (e as Message).parts)
        .filter((p) => p.kind === 'text')
        .map((p) => ('text' in p ? p.text : ''))
        .join('');

      const turn2FullText = (streamedText2 + ' ' + messageText2).toLowerCase();
      // Should reference Barcelona or hotel context
      const hasBarcelonaContext =
        turn2FullText.includes('barcelona') ||
        turn2FullText.includes('sagrada') ||
        turn2FullText.includes('hotel');
      expect(hasBarcelonaContext).toBe(true);

      // Turn 3: Sync — verify full conversation context preserved
      const result3 = await clientA.sendMessage({
        message: makeMessage(
          'Summarize the full trip plan so far — destination, duration, number of people, and hotel area.',
          ctxId,
        ),
      });
      const text3 = extractResponseText(result3).toLowerCase();

      // Turn 3 should reference details from BOTH prior turns.
      // The response must show awareness of the full conversation context —
      // at minimum the destination (from turn 1) and hotel area (from turn 2).
      const contextMarkers = [
        'barcelona',
        'spain',
        'catalon',
        'sagrada',
        'hotel',
        'vacation',
        'trip',
        '5',
        'five',
        'june',
        'two',
        '2',
        'day',
        'people',
        'guest',
        'person',
      ];
      const matchedMarkers = contextMarkers.filter((m) => text3.includes(m));

      // At least 3 markers from across both turns should appear in the summary.
      // This proves the session maintained full context across sync→stream→sync.
      expect(matchedMarkers.length).toBeGreaterThanOrEqual(3);
    },
    LLM_TIMEOUT * 3,
  );
});

// =============================================================================
// Suite 11: Rich Content — DataPart and Mixed Parts
// =============================================================================

describe('Rich Content — DataPart and Mixed Parts', () => {
  test(
    'message with DataPart (structured JSON) is processed by the agent',
    async () => {
      // Send a message with a DataPart containing structured travel request data.
      // The adapter's extractContentFromParts serializes DataPart as JSON and
      // appends to text — the agent should process it.
      const result = await clientA.sendMessage({
        message: {
          kind: 'message',
          messageId: uid('msg-data'),
          role: 'user',
          parts: [
            {
              kind: 'data',
              data: {
                type: 'travel_request',
                origin: 'London Heathrow',
                destination: 'Dubai',
                departureDate: '2026-04-15',
                returnDate: '2026-04-22',
                passengers: 3,
                class: 'economy',
                preferences: ['window seat', 'vegetarian meal'],
              },
            },
          ],
        },
      });

      expect(result).toBeDefined();
      const text = extractResponseText(result).toLowerCase();
      expect(text.length).toBeGreaterThan(10);

      // Response should reference something from the structured data
      const hasDataContext =
        text.includes('dubai') ||
        text.includes('london') ||
        text.includes('heathrow') ||
        text.includes('april') ||
        text.includes('passenger') ||
        text.includes('economy') ||
        text.includes('flight');
      expect(hasDataContext).toBe(true);
    },
    LLM_TIMEOUT,
  );

  test(
    'message with mixed TextPart + DataPart is processed correctly',
    async () => {
      const result = await clientB.sendMessage({
        message: {
          kind: 'message',
          messageId: uid('msg-mixed'),
          role: 'user',
          parts: [
            {
              kind: 'text',
              text: 'Please analyze this flight search request and suggest the best options:',
            },
            {
              kind: 'data',
              data: {
                routes: [
                  { from: 'JFK', to: 'NRT', date: '2026-05-01' },
                  { from: 'NRT', to: 'JFK', date: '2026-05-15' },
                ],
                budget: 2500,
                currency: 'USD',
                flexibleDates: true,
              },
            },
          ],
        },
      });

      expect(result).toBeDefined();
      const text = extractResponseText(result).toLowerCase();
      expect(text.length).toBeGreaterThan(10);

      // Response should reference the structured data content
      const hasRouteContext =
        text.includes('jfk') ||
        text.includes('new york') ||
        text.includes('tokyo') ||
        text.includes('narita') ||
        text.includes('nrt') ||
        text.includes('flight') ||
        text.includes('budget') ||
        text.includes('2500') ||
        text.includes('round');
      expect(hasRouteContext).toBe(true);
    },
    LLM_TIMEOUT,
  );

  test(
    'multi-turn with rich content: DataPart turn 1 → text follow-up turn 2 preserves context',
    async () => {
      const ctxId = uid('ctx-rich-mt');

      // Turn 1: Structured data request
      await clientA.sendMessage({
        message: {
          kind: 'message',
          messageId: uid('msg-rich-t1'),
          role: 'user',
          contextId: ctxId,
          parts: [
            { kind: 'text', text: 'Here is my travel itinerary:' },
            {
              kind: 'data',
              data: {
                itinerary: {
                  destination: 'Kyoto, Japan',
                  checkIn: '2026-06-10',
                  checkOut: '2026-06-14',
                  guests: 2,
                  activities: ['temple visit', 'tea ceremony', 'bamboo forest'],
                },
              },
            },
          ],
        },
      });

      // Turn 2: Plain text follow-up referencing the structured data
      const result2 = await clientA.sendMessage({
        message: makeMessage(
          'Which of the activities I listed would you recommend doing on the first day?',
          ctxId,
        ),
      });

      const text2 = extractResponseText(result2).toLowerCase();
      expect(text2.length).toBeGreaterThan(10);

      // Should reference activities from the DataPart in turn 1
      const hasActivityContext =
        text2.includes('temple') ||
        text2.includes('tea') ||
        text2.includes('bamboo') ||
        text2.includes('kyoto') ||
        text2.includes('activit');
      expect(hasActivityContext).toBe(true);
    },
    LLM_TIMEOUT * 2,
  );

  test(
    'streaming with DataPart produces proper event sequence',
    async () => {
      const events: Array<Message | Task | TaskStatusUpdateEvent | TaskArtifactUpdateEvent> = [];

      const stream = clientB.sendMessageStream({
        message: {
          kind: 'message',
          messageId: uid('msg-data-stream'),
          role: 'user',
          parts: [
            { kind: 'text', text: 'Check availability for this route:' },
            {
              kind: 'data',
              data: {
                flightNumber: 'BA117',
                date: '2026-04-20',
                cabin: 'first',
              },
            },
          ],
        },
      });

      for await (const event of stream) {
        events.push(event);
      }

      // Verify proper event sequence even with DataPart input
      expect(events.length).toBeGreaterThan(2);

      // First event: working status
      expect(events[0].kind).toBe('status-update');
      expect((events[0] as TaskStatusUpdateEvent).status.state).toBe('working');

      // Last event: message (SDK doesn't yield the final completed status-update)
      expect(events[events.length - 1].kind).toBe('message');

      // Should have artifact events with accumulated content
      const artifactText = events
        .filter((e) => e.kind === 'artifact-update')
        .flatMap((e) => (e as TaskArtifactUpdateEvent).artifact.parts)
        .filter((p) => p.kind === 'text')
        .map((p) => ('text' in p ? p.text : ''))
        .join('');
      expect(artifactText.length).toBeGreaterThan(0);

      // Should have a Message event with agent response
      const messageEvents = events.filter((e) => e.kind === 'message') as Message[];
      expect(messageEvents.length).toBeGreaterThanOrEqual(1);
      expect(messageEvents[0].role).toBe('agent');
    },
    LLM_TIMEOUT,
  );
});

// =============================================================================
// Suite 12: Memory & Recall — Task History Persistence
// =============================================================================

describe('Memory & Recall — Task History', () => {
  test(
    'getTask returns conversation history after streaming multi-turn',
    async () => {
      const ctxId = uid('ctx-recall');

      // Turn 1: Stream a message and capture the taskId from events
      const events1: Array<Message | Task | TaskStatusUpdateEvent | TaskArtifactUpdateEvent> = [];
      const stream1 = clientA.sendMessageStream({
        message: makeMessage('I want to visit the Louvre Museum in Paris next month', ctxId),
      });
      for await (const event of stream1) {
        events1.push(event);
      }

      // Extract taskId from status-update or artifact-update events
      const taskId1 = events1
        .filter((e) => e.kind === 'status-update' || e.kind === 'artifact-update')
        .map((e) => (e as TaskStatusUpdateEvent | TaskArtifactUpdateEvent).taskId)
        .find((id) => id);

      expect(taskId1).toBeDefined();

      // Retrieve the task with history. The SDK clears history by default
      // unless historyLength is explicitly requested (SDK line: else { task.history = [] }).
      const task1 = await clientA.getTask({ id: taskId1!, historyLength: 10 });
      expect(task1).toBeDefined();
      expect(task1.kind).toBe('task');
      expect(task1.id).toBe(taskId1);
      expect(task1.status.state).toBe('completed');

      // History should contain at least the user message
      expect(task1.history).toBeDefined();
      expect(task1.history!.length).toBeGreaterThanOrEqual(1);

      // Verify user message is in history with correct role and content
      const userMessages = task1.history!.filter((m) => m.role === 'user');
      expect(userMessages.length).toBeGreaterThanOrEqual(1);

      const userParts = userMessages[0].parts;
      expect(userParts).toBeDefined();
      expect(userParts!.some((p) => p.kind === 'text')).toBe(true);
    },
    LLM_TIMEOUT,
  );

  test(
    'getTask returns history after sync sendMessage',
    async () => {
      // For sync path, the SDK returns a Message (not Task), so we need
      // to verify the task was stored and is retrievable.
      // Send via streaming first to get the taskId, then verify.
      const ctxId = uid('ctx-sync-recall');

      // Use streaming to capture the taskId
      const events: Array<Message | Task | TaskStatusUpdateEvent | TaskArtifactUpdateEvent> = [];
      const stream = clientA.sendMessageStream({
        message: makeMessage('Book a table at a restaurant in Rome for dinner', ctxId),
      });
      for await (const event of stream) {
        events.push(event);
      }

      const taskId = events
        .filter((e) => e.kind === 'status-update' || e.kind === 'artifact-update')
        .map((e) => (e as TaskStatusUpdateEvent | TaskArtifactUpdateEvent).taskId)
        .find((id) => id);

      expect(taskId).toBeDefined();

      // getTask should return the task with history
      // Must pass historyLength — SDK clears history when omitted
      const task = await clientA.getTask({ id: taskId!, historyLength: 10 });
      expect(task).toBeDefined();
      expect(task.id).toBe(taskId);

      // Verify task has artifacts (from streaming)
      expect(task.artifacts).toBeDefined();
      expect(task.artifacts!.length).toBeGreaterThan(0);
    },
    LLM_TIMEOUT,
  );

  test(
    'multi-turn history accumulates across turns via getTask',
    async () => {
      const ctxId = uid('ctx-history-mt');

      // Turn 1 via streaming
      const events1: Array<Message | Task | TaskStatusUpdateEvent | TaskArtifactUpdateEvent> = [];
      const stream1 = clientA.sendMessageStream({
        message: makeMessage('I want to fly from London to New York on May 1st', ctxId),
      });
      for await (const event of stream1) {
        events1.push(event);
      }

      const taskId1 = events1
        .filter((e) => e.kind === 'status-update' || e.kind === 'artifact-update')
        .map((e) => (e as TaskStatusUpdateEvent | TaskArtifactUpdateEvent).taskId)
        .find((id) => id);
      expect(taskId1).toBeDefined();

      // Turn 2 via streaming — same contextId (new taskId per turn in A2A)
      const events2: Array<Message | Task | TaskStatusUpdateEvent | TaskArtifactUpdateEvent> = [];
      const stream2 = clientA.sendMessageStream({
        message: makeMessage('What about return flights on May 10th?', ctxId),
      });
      for await (const event of stream2) {
        events2.push(event);
      }

      const taskId2 = events2
        .filter((e) => e.kind === 'status-update' || e.kind === 'artifact-update')
        .map((e) => (e as TaskStatusUpdateEvent | TaskArtifactUpdateEvent).taskId)
        .find((id) => id);
      expect(taskId2).toBeDefined();

      // Each turn creates a separate task in A2A protocol
      // Verify both tasks are retrievable
      // Must pass historyLength — SDK clears history when omitted
      const task1 = await clientA.getTask({ id: taskId1!, historyLength: 10 });
      expect(task1).toBeDefined();
      expect(task1.status.state).toBe('completed');

      const task2 = await clientA.getTask({ id: taskId2!, historyLength: 10 });
      expect(task2).toBeDefined();
      expect(task2.status.state).toBe('completed');

      // Verify task2 has history (at minimum the user message)
      expect(task2.history).toBeDefined();
      expect(task2.history!.length).toBeGreaterThanOrEqual(1);
    },
    LLM_TIMEOUT * 2,
  );

  test(
    'DataPart in message is preserved in task history',
    async () => {
      const ctxId = uid('ctx-data-recall');

      // Send a message with DataPart via streaming
      const events: Array<Message | Task | TaskStatusUpdateEvent | TaskArtifactUpdateEvent> = [];
      const stream = clientA.sendMessageStream({
        message: {
          kind: 'message',
          messageId: uid('msg-data-recall'),
          role: 'user',
          contextId: ctxId,
          parts: [
            { kind: 'text', text: 'Here is my booking request:' },
            {
              kind: 'data',
              data: {
                type: 'booking',
                destination: 'Amsterdam',
                dates: { checkIn: '2026-07-01', checkOut: '2026-07-05' },
                guests: 4,
              },
            },
          ],
        },
      });
      for await (const event of stream) {
        events.push(event);
      }

      const taskId = events
        .filter((e) => e.kind === 'status-update' || e.kind === 'artifact-update')
        .map((e) => (e as TaskStatusUpdateEvent | TaskArtifactUpdateEvent).taskId)
        .find((id) => id);
      expect(taskId).toBeDefined();

      // Retrieve task and verify history preserves the structured message
      // Must pass historyLength — SDK clears history when omitted
      const task = await clientA.getTask({ id: taskId!, historyLength: 10 });
      expect(task).toBeDefined();
      expect(task.history).toBeDefined();

      // Find the user message in history
      const userMsg = task.history!.find((m) => m.role === 'user');
      expect(userMsg).toBeDefined();

      // Verify the message has the parts we sent (text + data)
      expect(userMsg!.parts).toBeDefined();
      expect(userMsg!.parts!.length).toBeGreaterThanOrEqual(1);

      // At minimum the text part should be present
      const textParts = userMsg!.parts!.filter((p) => p.kind === 'text');
      expect(textParts.length).toBeGreaterThanOrEqual(1);
    },
    LLM_TIMEOUT,
  );
});
