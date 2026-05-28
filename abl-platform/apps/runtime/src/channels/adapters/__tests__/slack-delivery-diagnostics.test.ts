import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SlackAdapter } from '../slack-adapter.js';
import type { NormalizedOutgoingMessage, ResolvedConnection } from '../../types.js';

const fetchMock = vi.fn();

function makeConnection(overrides?: Partial<ResolvedConnection>): ResolvedConnection {
  return {
    id: 'conn-slack-1',
    tenantId: 'tenant-1',
    projectId: 'project-1',
    agentId: 'agent-1',
    channelType: 'slack',
    externalIdentifier: 'T123',
    credentials: {
      bot_token: 'xoxb-secret-token',
    },
    config: {},
    status: 'active',
    ...overrides,
  };
}

function makeMessage(
  metadata: Record<string, unknown> = { slackChannelId: 'C123' },
): NormalizedOutgoingMessage {
  return {
    sessionId: 'session-1',
    text: 'Hello from the agent',
    eventType: 'agent.response',
    metadata,
  };
}

describe('SlackAdapter delivery diagnostics', () => {
  let adapter: SlackAdapter;

  beforeEach(() => {
    adapter = new SlackAdapter();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('preserves successful chat.postMessage delivery behavior', async () => {
    fetchMock.mockResolvedValue({
      json: () => Promise.resolve({ ok: true, ts: '1715888000.000100' }),
    } as Response);

    const result = await adapter.sendResponse(makeMessage(), makeConnection());

    expect(result).toEqual({ success: true, deliveryId: '1715888000.000100' });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://slack.com/api/chat.postMessage',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer xoxb-secret-token',
        }),
      }),
    );
  });

  it('returns sanitized channel diagnostics when Slack rejects delivery', async () => {
    fetchMock.mockResolvedValue({
      json: () => Promise.resolve({ ok: false, error: 'invalid_auth' }),
    } as Response);

    const result = await adapter.sendResponse(makeMessage(), makeConnection());

    expect(result.success).toBe(false);
    expect(result.error).toBe("I'm having trouble delivering that response. Please try again.");
    expect(result.metadata?.channelDiagnostic).toMatchObject({
      source: 'channel_delivery',
      category: 'provider',
      severity: 'error',
      code: 'CHANNEL_PROVIDER_REJECTED',
      channelType: 'slack',
      provider: 'slack',
      providerErrorCode: 'invalid_auth',
      retryable: false,
    });
    expect(JSON.stringify(result)).not.toContain('Slack API error: invalid_auth');
    expect(JSON.stringify(result)).not.toContain('xoxb-secret-token');
  });

  it('does not expose raw network exception text in SendResult.error or diagnostics', async () => {
    fetchMock.mockRejectedValue(
      new Error(
        'network failure while using xoxb-secret-token for tenant_abc at https://slack.com/api/chat.postMessage',
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
    expect(JSON.stringify(result)).not.toContain('xoxb-secret-token');
    expect(JSON.stringify(result)).not.toContain('tenant_abc');
    expect(JSON.stringify(result)).not.toContain('slack.com/api/chat.postMessage');
  });
});
