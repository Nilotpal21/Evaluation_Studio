/**
 * Five9 Transfer Lifecycle E2E Tests
 *
 * Tests the full Five9 transfer lifecycle: execute -> sendMessage -> webhook -> endSession.
 * Uses a real Express mock HTTP server for Five9 API, real session store (in-memory),
 * and real adapter instances. No codebase component mocking.
 *
 * Gated with AGENT_TRANSFER_E2E=1.
 *
 * E2E-5: Full transfer lifecycle (anonymous)
 * E2E-6: Kore backward compatibility
 * E2E-8: Full transfer lifecycle (supervisor)
 * E2E-9: Five9 auth failure -> TransferResult.status === 'failed'
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import {
  Five9Adapter,
  KoreAdapter,
  AdapterRegistry,
  KoreEventHandler,
  Five9EventHandler,
  sessionKey,
} from '@agent-platform/agent-transfer';
import type {
  TransferSessionStoreHandle,
  TransferPayload,
  AgentEvent,
} from '@agent-platform/agent-transfer';

const SKIP_REASON = !process.env.AGENT_TRANSFER_E2E;

/**
 * In-memory session store for transfer lifecycle tests.
 */
function createInMemorySessionStore(): TransferSessionStoreHandle & {
  _sessions: Map<string, Record<string, string>>;
  _providerIndex: Map<string, string>;
  _ended: string[];
} {
  const sessions = new Map<string, Record<string, string>>();
  const providerIndex = new Map<string, string>();
  const ended: string[] = [];

  return {
    _sessions: sessions,
    _providerIndex: providerIndex,
    _ended: ended,
    async create(params) {
      const key = sessionKey(params.tenantId, params.contactId, params.channel);
      sessions.set(key, {
        tenantId: params.tenantId,
        projectId: params.projectId,
        contactId: params.contactId,
        channel: params.channel,
        provider: params.provider,
        providerSessionId: params.providerSessionId ?? '',
        agentId: params.agentId,
        providerData: params.providerData ? JSON.stringify(params.providerData) : '',
        metadata: params.metadata ? JSON.stringify(params.metadata) : '',
      });
      if (params.providerSessionId) {
        providerIndex.set(`${params.provider}:${params.tenantId}:${params.providerSessionId}`, key);
      }
      return { success: true, sessionKey: key };
    },
    async get(key) {
      return sessions.get(key) ?? null;
    },
    async end(sk) {
      sessions.delete(sk);
      ended.push(sk);
    },
    async extendTTL() {
      // no-op
    },
    async getByProvider(provider, tenantId, providerSessionId) {
      const key = providerIndex.get(`${provider}:${tenantId}:${providerSessionId}`);
      if (!key) return null;
      return sessions.get(key) ?? null;
    },
  };
}

/**
 * Build a mock Five9 API server that responds to auth, metadata, conversations.
 */
function buildMockFive9Api(options?: {
  authFailure?: boolean;
  supervisorMode?: boolean;
}): express.Express {
  const app = express();
  app.use(express.json());

  app.post('/appsvcs/rs/svc/auth/anon', (_req, res) => {
    if (options?.authFailure) {
      return res.status(401).json({ error: 'Auth failed' });
    }
    return res.json({
      tokenId: 'anon-tok-e2e',
      orgId: 'org-e2e-1',
      context: { farmId: 'farm-e2e-1' },
    });
  });

  app.post('/appsvcs/rs/svc/auth/login', (req, res) => {
    if (options?.authFailure) {
      return res.status(401).json({ error: 'Auth failed' });
    }
    const { username, password } = req.body as { username?: string; password?: string };
    if (!username || !password) {
      return res.status(401).json({ error: 'Missing credentials' });
    }
    return res.json({
      tokenId: 'sup-tok-e2e',
      orgId: 'org-e2e-sup',
      context: { farmId: 'farm-e2e-sup' },
    });
  });

  app.get('/appsvcs/rs/svc/auth/metadata', (_req, res) => {
    return res.json({
      orgId: 'org-e2e-1',
      context: { farmId: 'farm-e2e-1' },
      metadata: {
        dataCenters: [
          {
            name: 'us',
            active: true,
            uiUrls: [],
            apiUrls: [{ host: 'app.five9.com', port: '443' }],
            loginUrls: [],
          },
        ],
      },
    });
  });

  app.post('/appsvcs/rs/svc/conversations', (_req, res) => {
    return res.json({ conversationId: 'conv-lifecycle-1' });
  });

  app.post('/appsvcs/rs/svc/conversations/:id/messages', (_req, res) => {
    return res.status(200).json({ success: true });
  });

  app.delete('/appsvcs/rs/svc/conversations/:id', (_req, res) => {
    return res.status(200).json({ success: true });
  });

  return app;
}

describe.skipIf(SKIP_REASON)('Five9 Transfer Lifecycle E2E Tests', () => {
  let mockApiServer: http.Server;
  let mockApiPort: number;
  let store: ReturnType<typeof createInMemorySessionStore>;

  beforeAll(async () => {
    const app = buildMockFive9Api();
    mockApiServer = await new Promise<http.Server>((resolve) => {
      const server = http.createServer(app);
      server.listen(0, '127.0.0.1', () => resolve(server));
    });
    mockApiPort = (mockApiServer.address() as AddressInfo).port;
  });

  afterAll(async () => {
    if (mockApiServer) {
      await new Promise<void>((resolve, reject) => {
        mockApiServer.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  beforeEach(() => {
    store = createInMemorySessionStore();
  });

  /**
   * Create a fetchFn that rewrites https to http for our local mock server.
   */
  function createHttpFetch(): typeof fetch {
    return async (input, init) => {
      let url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      url = url.replace(/^https:\/\//, 'http://');
      // Replace any Five9 host with our mock server
      url = url.replace(/\/\/[^/]+\//, `//127.0.0.1:${mockApiPort}/`);
      return fetch(url, init);
    };
  }

  describe('E2E-5: Full transfer lifecycle (anonymous)', () => {
    it('executes transfer, sends message, processes webhook, ends session', async () => {
      const httpFetch = createHttpFetch();
      const adapter = new Five9Adapter(
        {
          tenantName: 'test-tenant',
          campaignName: 'test-campaign',
          host: 'app.five9.com',
          authMode: 'anonymous',
        },
        store,
        httpFetch,
      );

      // Collect agent messages
      const receivedEvents: AgentEvent[] = [];
      adapter.onAgentMessage(async (event) => {
        receivedEvents.push(event);
      });

      // Step 1: Execute transfer
      const payload: TransferPayload = {
        tenantId: 'tenant-e2e',
        projectId: 'project-e2e',
        agentId: 'agent-e2e',
        contactId: 'contact-e2e',
        sessionId: 'agent_transfer:tenant-e2e:contact-e2e:chat',
        channel: 'chat',
      };

      const result = await adapter.execute(payload);
      expect(result.success).toBe(true);
      expect(result.status).toBe('transferred');
      expect(result.sessionId).toBe('agent_transfer:tenant-e2e:contact-e2e:chat');
      expect(result.providerSessionId).toBe('conv-lifecycle-1');
      expect(await store.get(result.sessionId!)).toEqual(
        expect.objectContaining({
          projectId: 'project-e2e',
        }),
      );

      // Step 2: Send a user message
      await adapter.sendUserMessage(result.sessionId!, {
        content: 'Hello from user',
      });

      // Step 3: Simulate webhook (agent message back)
      await adapter.handleInboundEvent(
        {
          type: 'agent_message',
          conversationId: 'conv-lifecycle-1',
          data: { text: 'Hello from agent' },
        },
        'tenant-e2e',
      );

      expect(receivedEvents.length).toBe(1);
      expect(receivedEvents[0].type).toBe('agent:message');
      expect(receivedEvents[0].tenantId).toBe('tenant-e2e');

      // Step 4: End session
      await adapter.endSession(result.sessionId!, 'conversation_complete');

      // Verify session is cleaned up
      const sessionAfter = await store.get(result.sessionId!);
      expect(sessionAfter).toBeNull();
      expect(store._ended).toContain(result.sessionId);
    });
  });

  describe('E2E-6: Kore backward compatibility', () => {
    it('KoreEventHandler still maps all known event types', () => {
      // Verify the Kore event handler still works with its known events
      const koreEvents = [
        ['agent_message', 'agent:message'],
        ['agent_accepted', 'agent:connected'],
        ['conversation_queued', 'agent:queued'],
        ['closed', 'agent:disconnected'],
        ['typing', 'agent:typing'],
        ['stop_typing', 'agent:typing_stop'],
        ['agent_joined', 'agent:joined'],
        ['conversation_closed', 'agent:disconnected'],
      ] as const;

      for (const [koreType, expectedAbl] of koreEvents) {
        const mapped = KoreEventHandler.mapEventType(koreType);
        expect(mapped).toBe(expectedAbl);
      }
    });

    it('Five9EventHandler maps its own events independently', () => {
      const five9Events = [
        ['agent_message', 'agent:message'],
        ['agent_connected', 'agent:connected'],
        ['agent_joined', 'agent:joined'],
        ['agent_disconnected', 'agent:disconnected'],
        ['conversation_queued', 'agent:queued'],
        ['conversation_closed', 'agent:disconnected'],
        ['agent_typing', 'agent:typing'],
        ['agent_typing_stop', 'agent:typing_stop'],
      ] as const;

      for (const [five9Type, expectedAbl] of five9Events) {
        const mapped = Five9EventHandler.mapEventType(five9Type);
        expect(mapped).toBe(expectedAbl);
      }
    });

    it('both adapters can coexist in the same registry', () => {
      const registry = new AdapterRegistry();

      const koreAdapter = new KoreAdapter(undefined, store);
      const five9Adapter = new Five9Adapter(undefined, store);

      registry.register('kore', koreAdapter);
      registry.register('five9', five9Adapter);

      expect(registry.listNames()).toEqual(expect.arrayContaining(['kore', 'five9']));
      expect(registry.get('kore')?.name).toBe('kore');
      expect(registry.get('five9')?.name).toBe('five9');
    });
  });

  describe('E2E-8: Full transfer lifecycle (supervisor)', () => {
    it('executes transfer with supervisor auth mode', async () => {
      const httpFetch = createHttpFetch();
      const adapter = new Five9Adapter(
        {
          tenantName: 'test-tenant',
          campaignName: 'test-campaign',
          host: 'app.five9.com',
          authMode: 'supervisor',
          username: 'admin@test.com',
          password: 's3cret',
        },
        store,
        httpFetch,
      );

      const payload: TransferPayload = {
        tenantId: 'tenant-sup',
        projectId: 'project-sup',
        agentId: 'agent-sup',
        contactId: 'contact-sup',
        sessionId: 'agent_transfer:tenant-sup:contact-sup:chat',
        channel: 'chat',
      };

      const result = await adapter.execute(payload);
      expect(result.success).toBe(true);
      expect(result.status).toBe('transferred');
      expect(result.providerSessionId).toBe('conv-lifecycle-1');

      // Verify session was created
      const session = await store.get(result.sessionId!);
      expect(session).not.toBeNull();
      expect(session?.['provider']).toBe('five9');

      // End session
      await adapter.endSession(result.sessionId!, 'completed');
      expect(store._ended).toContain(result.sessionId);
    });
  });

  describe('E2E-9: Five9 auth failure', () => {
    it('returns TransferResult.status === failed on auth failure', async () => {
      // Create a fetchFn that simulates auth failure
      const failFetch: typeof fetch = async () => {
        return new Response(JSON.stringify({ error: 'Auth failed' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        });
      };

      const adapter = new Five9Adapter(
        {
          tenantName: 'test-tenant',
          campaignName: 'test-campaign',
          host: 'app.five9.com',
          authMode: 'anonymous',
        },
        store,
        failFetch,
      );

      const payload: TransferPayload = {
        tenantId: 'tenant-fail',
        projectId: 'project-fail',
        agentId: 'agent-fail',
        contactId: 'contact-fail',
        sessionId: 'agent_transfer:tenant-fail:contact-fail:chat',
        channel: 'chat',
      };

      const result = await adapter.execute(payload);
      expect(result.success).toBe(false);
      expect(result.status).toBe('failed');
      expect(result.error?.code).toBe('FIVE9_AUTH_FAILED');

      // Verify no session was created in the store
      const sessionKey = `agent_transfer:tenant-fail:contact-fail:chat`;
      const session = await store.get(sessionKey);
      expect(session).toBeNull();
    });
  });
});
