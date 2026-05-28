import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ResolvedConnection, NormalizedOutgoingMessage } from '../../../channels/types.js';

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockSmtpSendReply = vi.fn().mockResolvedValue({ messageId: '<smtp-msg-001>' });
const mockGraphSendReply = vi.fn().mockResolvedValue({ messageId: 'graph-msg-001' });

vi.mock('../../../services/email/transports/smtp-transport.js', () => ({
  SmtpTransport: vi.fn().mockImplementation(function (this: Record<string, unknown>) {
    this.sendReply = mockSmtpSendReply;
  }),
}));

vi.mock('../../../services/email/transports/graph-transport.js', () => ({
  GraphTransport: vi.fn().mockImplementation(function (this: Record<string, unknown>) {
    this.sendReply = mockGraphSendReply;
  }),
}));

vi.mock('../../../services/email/feedback-token.js', () => ({
  signFeedbackToken: vi.fn().mockReturnValue('mock-feedback-token'),
}));

// ── Import after mocks ───────────────────────────────────────────────────────

import { EmailAdapter } from '../../../channels/adapters/email-adapter.js';
import { clearTransportCache } from '../../../services/email/transports/resolve-transport.js';

// ── Test Fixtures ────────────────────────────────────────────────────────────

function makeConnection(overrides: Partial<ResolvedConnection> = {}): ResolvedConnection {
  return {
    id: 'conn-001',
    tenantId: 'tenant-001',
    projectId: 'project-001',
    agentId: 'agent-001',
    channelType: 'email',
    externalIdentifier: 'agent@example.com',
    credentials: null,
    config: {},
    status: 'active',
    ...overrides,
  };
}

function makeOutgoingMessage(
  overrides: Partial<NormalizedOutgoingMessage> = {},
): NormalizedOutgoingMessage {
  return {
    sessionId: 'session-001',
    text: 'Hello, this is a reply.',
    eventType: 'agent.response',
    metadata: {
      from: 'user@test.com',
      subject: 'Test Subject',
      messageId: '<orig-msg@test.com>',
      references: '<prev-msg@test.com>',
    },
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('EmailAdapter transport selection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearTransportCache();
  });

  it('uses SMTP transport by default (no outbound config)', async () => {
    const adapter = new EmailAdapter();
    const connection = makeConnection();
    const message = makeOutgoingMessage();

    const result = await adapter.sendResponse(message, connection);

    expect(result.success).toBe(true);
    expect(result.deliveryId).toBe('<smtp-msg-001>');
    expect(mockSmtpSendReply).toHaveBeenCalledOnce();
    expect(mockGraphSendReply).not.toHaveBeenCalled();
  });

  it('uses Graph transport when config.outbound.transport is graph', async () => {
    const adapter = new EmailAdapter();
    const connection = makeConnection({
      config: {
        outbound: {
          transport: 'graph',
          graph: {
            tenantId: 'ms-tenant-id',
            clientId: 'ms-client-id',
            senderAddress: 'bot@example.com',
          },
        },
      },
      credentials: { graph_client_secret: 'ms-secret' },
    });
    const message = makeOutgoingMessage();

    const result = await adapter.sendResponse(message, connection);

    expect(result.success).toBe(true);
    expect(result.deliveryId).toBe('graph-msg-001');
    expect(mockGraphSendReply).toHaveBeenCalledOnce();
    expect(mockSmtpSendReply).not.toHaveBeenCalled();
  });

  it('uses SMTP transport when config.outbound.transport is smtp', async () => {
    const adapter = new EmailAdapter();
    const connection = makeConnection({
      config: {
        outbound: {
          transport: 'smtp',
        },
      },
    });
    const message = makeOutgoingMessage();

    const result = await adapter.sendResponse(message, connection);

    expect(result.success).toBe(true);
    expect(result.deliveryId).toBe('<smtp-msg-001>');
    expect(mockSmtpSendReply).toHaveBeenCalledOnce();
    expect(mockGraphSendReply).not.toHaveBeenCalled();
  });
});
