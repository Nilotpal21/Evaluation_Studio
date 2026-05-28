import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessengerAdapter } from '../messenger-adapter.js';
import type { NormalizedOutgoingMessage, ResolvedConnection } from '../../types.js';

const fetchMock = vi.fn();

function makeConnection(overrides?: Partial<ResolvedConnection>): ResolvedConnection {
  return {
    id: 'conn-messenger-1',
    tenantId: 'tenant-1',
    projectId: 'project-1',
    agentId: 'agent-1',
    channelType: 'messenger',
    externalIdentifier: 'page-1',
    credentials: {
      page_access_token: 'page-secret-token',
    },
    config: {},
    status: 'active',
    ...overrides,
  };
}

function makeMessage(
  metadata: Record<string, unknown> = { messengerSenderId: 'psid-123' },
): NormalizedOutgoingMessage {
  return {
    sessionId: 'session-1',
    text: 'Hello from the agent',
    eventType: 'agent.response',
    metadata,
  };
}

describe('MessengerAdapter delivery diagnostics', () => {
  let adapter: MessengerAdapter;

  beforeEach(() => {
    adapter = new MessengerAdapter();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('MESSENGER_PAGE_ACCESS_TOKEN', '');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('preserves successful Send API delivery behavior', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ message_id: 'mid.123' }),
    } as Response);

    const result = await adapter.sendResponse(makeMessage(), makeConnection());

    expect(result).toEqual({ success: true, deliveryId: 'mid.123' });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://graph.facebook.com/v21.0/me/messages',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer page-secret-token',
        }),
      }),
    );
  });

  it('returns sanitized channel diagnostics when Messenger rejects delivery', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 401,
      text: () =>
        Promise.resolve(
          '{"error":{"message":"Invalid OAuth access token page-secret-token","code":190}}',
        ),
    } as Response);

    const result = await adapter.sendResponse(makeMessage(), makeConnection());

    expect(result.success).toBe(false);
    expect(result.error).toBe("I'm having trouble delivering that response. Please try again.");
    expect(result.metadata?.channelDiagnostic).toMatchObject({
      source: 'channel_delivery',
      category: 'provider',
      severity: 'error',
      code: 'CHANNEL_PROVIDER_REJECTED',
      channelType: 'messenger',
      provider: 'messenger',
      httpStatus: 401,
      retryable: false,
    });
    expect(result.metadata?.errorEnvelope).toMatchObject({
      code: 'CHANNEL_PROVIDER_REJECTED',
      category: 'runtime',
      customer_message: "I'm having trouble delivering that response. Please try again.",
    });
    expect(JSON.stringify(result)).not.toContain('Invalid OAuth access token');
    expect(JSON.stringify(result)).not.toContain('page-secret-token');
  });

  it('does not expose raw network exception text in SendResult.error or diagnostics', async () => {
    fetchMock.mockRejectedValue(
      new Error(
        'network failure while using page-secret-token for tenant_abc at https://graph.facebook.com/v21.0/me/messages',
      ),
    );

    const result = await adapter.sendResponse(makeMessage(), makeConnection());

    expect(result.success).toBe(false);
    expect(result.error).toBe("I'm having trouble delivering that response. Please try again.");
    expect(result.metadata?.errorEnvelope).toMatchObject({
      code: 'CHANNEL_DELIVERY_FAILED',
      category: 'runtime',
      customer_message: "I'm having trouble delivering that response. Please try again.",
    });
    expect(JSON.stringify(result)).not.toContain('page-secret-token');
    expect(JSON.stringify(result)).not.toContain('tenant_abc');
    expect(JSON.stringify(result)).not.toContain('graph.facebook.com');
  });

  it('returns a sanitized configuration diagnostic when credentials are missing', async () => {
    const result = await adapter.sendResponse(
      makeMessage(),
      makeConnection({ credentials: {}, config: {} }),
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe(
      'This channel is not fully configured for response delivery. Please contact support.',
    );
    expect(result.metadata?.channelDiagnostic).toMatchObject({
      category: 'configuration',
      code: 'CHANNEL_DELIVERY_CONFIGURATION',
      channelType: 'messenger',
      provider: 'messenger',
      retryable: false,
    });
    expect(result.metadata?.errorEnvelope).toMatchObject({
      operator_hint: expect.stringContaining('No Messenger page access token'),
    });
    expect(result.error).not.toContain('page access token');
  });
});
