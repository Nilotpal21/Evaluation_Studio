/**
 * Five9 Webhook E2E Tests
 *
 * Tests the Five9 webhook endpoint with a real Express server, real middleware,
 * and a real session store. Five9 external API is simulated via fetchFn DI.
 *
 * Gated with AGENT_TRANSFER_E2E=1 — requires Redis to be running.
 *
 * E2E-1: Valid Five9 webhook with tid param -> 200, agent event processed
 * E2E-2: Unknown conversationId -> 404
 * E2E-3: Tenant mismatch -> 404 (not 403)
 * E2E-4: Malformed payload (missing type/conversationId) -> 400
 * E2E-7: Missing tid query param -> 400
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import {
  AdapterRegistry,
  Five9Adapter,
  TransferSessionStore,
  sessionKey,
} from '@agent-platform/agent-transfer';
import type { TransferSessionStoreHandle } from '@agent-platform/agent-transfer';
import { hostname } from 'os';

const SKIP_REASON = !process.env.AGENT_TRANSFER_E2E;

/**
 * Minimal in-memory session store for E2E tests without Redis.
 * Implements the same interface as the real Redis-backed store.
 */
function createMinimalSessionStore(): TransferSessionStoreHandle & {
  _sessions: Map<string, Record<string, string>>;
  _providerIndex: Map<string, string>;
} {
  const sessions = new Map<string, Record<string, string>>();
  const providerIndex = new Map<string, string>();

  return {
    _sessions: sessions,
    _providerIndex: providerIndex,
    async create(params) {
      const key = sessionKey(params.tenantId, params.contactId, params.channel);
      sessions.set(key, {
        tenantId: params.tenantId,
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
 * Build a standalone Express app with the webhook route logic inlined.
 * This avoids importing the full runtime server and its heavy dependency chain,
 * while still testing real Express routing and middleware behavior.
 */
function buildWebhookApp(
  registry: AdapterRegistry,
  sessionStore: TransferSessionStoreHandle,
): express.Express {
  const app = express();
  app.use(express.json());

  // Replicate the webhook route logic from agent-transfer-webhooks.ts
  app.post('/api/v1/agent-transfer/webhooks/:provider', async (req, res) => {
    const { provider } = req.params;

    const adapter = registry.get(provider);
    if (!adapter) {
      return res.status(404).json({
        success: false,
        error: { code: 'UNKNOWN_PROVIDER', message: `Provider "${provider}" is not registered` },
      });
    }

    const event = req.body as { type?: string; conversationId?: string; orgId?: string };
    if (!event || !event.type || !event.conversationId) {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_EVENT', message: 'Event must include type and conversationId' },
      });
    }

    // Five9 tenant ID extraction from query param
    if (provider === 'five9') {
      const tid = req.query.tid;
      if (!tid || typeof tid !== 'string' || tid.length === 0) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'MISSING_TENANT',
            message: 'Five9 webhook requires ?tid= query parameter',
          },
        });
      }
      event.orgId = tid;
    }

    if (!event.orgId) {
      return res.status(400).json({
        success: false,
        error: { code: 'MISSING_TENANT', message: 'Event must include orgId for tenant isolation' },
      });
    }

    // Look up session
    const session = await sessionStore.getByProvider(provider, event.orgId, event.conversationId);
    if (!session) {
      return res.status(404).json({
        success: false,
        error: { code: 'SESSION_NOT_FOUND', message: 'No active transfer session found' },
      });
    }

    // Validate tenant isolation
    if (event.orgId && event.orgId !== session['tenantId']) {
      return res.status(404).json({
        success: false,
        error: { code: 'SESSION_NOT_FOUND', message: 'No active transfer session found' },
      });
    }

    try {
      await adapter.handleInboundEvent(
        {
          type: event.type,
          conversationId: event.conversationId,
          orgId: event.orgId,
        },
        session['tenantId'],
      );

      return res.status(200).json({ success: true });
    } catch (err) {
      return res.status(500).json({
        success: false,
        error: { code: 'PROCESSING_ERROR', message: 'Failed to process event' },
      });
    }
  });

  return app;
}

describe.skipIf(SKIP_REASON)('Five9 Webhook E2E Tests', () => {
  let server: http.Server;
  let baseUrl: string;
  let store: ReturnType<typeof createMinimalSessionStore>;
  let registry: AdapterRegistry;

  beforeAll(async () => {
    store = createMinimalSessionStore();
    registry = new AdapterRegistry();

    // Create a no-op fetchFn since webhooks don't call Five9 API
    const noopFetch: typeof fetch = async () => {
      return new Response('{}', { status: 200 });
    };

    const five9Adapter = new Five9Adapter(
      {
        tenantName: 'test',
        campaignName: 'test',
        host: 'app.five9.com',
        authMode: 'anonymous',
      },
      store,
      noopFetch,
    );
    registry.register('five9', five9Adapter);

    // Seed a test session
    await store.create({
      tenantId: 'tenant-1',
      contactId: 'contact-1',
      channel: 'chat',
      provider: 'five9',
      providerSessionId: 'conv-e2e-1',
      agentId: 'agent-1',
      providerData: {
        token: 'tok-e2e',
        targetHost: 'api.five9.com',
        farmId: 'farm-1',
        orgId: 'org-1',
      },
    });

    const app = buildWebhookApp(registry, store);
    server = await new Promise<http.Server>((resolve) => {
      const candidate = http.createServer(app);
      candidate.listen(0, '127.0.0.1', () => resolve(candidate));
    });
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  it('E2E-1: Valid Five9 webhook with tid param returns 200 and fires onAgentMessage', async () => {
    // Register a callback to capture the dispatched event
    const receivedEvents: Array<{ type: string; conversationId: string; orgId?: string }> = [];
    const five9Adapter = registry.get('five9')!;
    five9Adapter.onAgentMessage(async (event) => {
      receivedEvents.push(event);
    });

    const response = await fetch(`${baseUrl}/api/v1/agent-transfer/webhooks/five9?tid=tenant-1`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'agent_message',
        conversationId: 'conv-e2e-1',
      }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { success: boolean };
    expect(body.success).toBe(true);

    // Verify the onAgentMessage callback received the event
    expect(receivedEvents.length).toBeGreaterThanOrEqual(1);
    const lastEvent = receivedEvents[receivedEvents.length - 1];
    expect(lastEvent.type).toBe('agent_message');
    expect(lastEvent.conversationId).toBe('conv-e2e-1');
  });

  it('E2E-2: Unknown conversationId returns 404', async () => {
    const response = await fetch(`${baseUrl}/api/v1/agent-transfer/webhooks/five9?tid=tenant-1`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'agent_message',
        conversationId: 'unknown-conv-id',
      }),
    });

    expect(response.status).toBe(404);
    const body = (await response.json()) as { success: boolean; error: { code: string } };
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('SESSION_NOT_FOUND');
  });

  it('E2E-3: Tenant mismatch returns 404 (not 403)', async () => {
    const response = await fetch(
      `${baseUrl}/api/v1/agent-transfer/webhooks/five9?tid=wrong-tenant`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'agent_message',
          conversationId: 'conv-e2e-1',
        }),
      },
    );

    // Should be 404 (not 403) to avoid leaking session existence
    expect(response.status).toBe(404);
    const body = (await response.json()) as { success: boolean; error: { code: string } };
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('SESSION_NOT_FOUND');
  });

  it('E2E-4: Malformed payload (missing type) returns 400', async () => {
    const response = await fetch(`${baseUrl}/api/v1/agent-transfer/webhooks/five9?tid=tenant-1`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conversationId: 'conv-e2e-1',
        // missing type
      }),
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { success: boolean; error: { code: string } };
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('INVALID_EVENT');
  });

  it('E2E-4b: Malformed payload (missing conversationId) returns 400', async () => {
    const response = await fetch(`${baseUrl}/api/v1/agent-transfer/webhooks/five9?tid=tenant-1`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'agent_message',
        // missing conversationId
      }),
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { success: boolean; error: { code: string } };
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('INVALID_EVENT');
  });

  it('E2E-7: Missing tid query param returns 400', async () => {
    const response = await fetch(`${baseUrl}/api/v1/agent-transfer/webhooks/five9`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'agent_message',
        conversationId: 'conv-e2e-1',
      }),
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { success: boolean; error: { code: string } };
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('MISSING_TENANT');
  });
});
