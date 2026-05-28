/**
 * Tests for AgentTransferMessageBridge attachment delivery (Phase 3).
 *
 * Validates that attachments in agent events are delivered as
 * separate messages, and that attachments without URLs are skipped.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentEvent } from '@agent-platform/agent-transfer';
import type { NormalizedOutgoingMessage, SendResult } from '../../../channels/types.js';

// Mock the logger
vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Track sendResponse calls
const sendResponseCalls: Array<{
  message: NormalizedOutgoingMessage;
  connectionId: string;
}> = [];

const mockSendResponse = vi.fn(async (message: NormalizedOutgoingMessage): Promise<SendResult> => {
  sendResponseCalls.push({ message, connectionId: 'conn-1' });
  return { success: true, deliveryId: `delivery-${sendResponseCalls.length}` };
});

const mockAdapter = {
  channelType: 'slack' as const,
  capabilities: {
    supportsAsync: true,
    supportsStreaming: false,
    supportsMedia: true,
    supportsThreading: true,
  },
  verifyRequest: vi.fn().mockResolvedValue(true),
  parseIncoming: vi.fn(),
  sendResponse: mockSendResponse,
};

const mockConnection = {
  id: 'conn-1',
  tenantId: 'tenant-1',
  projectId: 'project-1',
  agentId: 'agent-1',
  channelType: 'slack' as const,
  externalIdentifier: 'ext-1',
  credentials: null,
  config: {},
  status: 'active',
};

// Mock channel registry and connection resolver
vi.mock('../../../channels/registry.js', () => ({
  getChannelRegistry: () => ({
    get: () => mockAdapter,
  }),
}));

vi.mock('../../../channels/connection-resolver.js', () => ({
  resolveConnectionById: () => Promise.resolve(mockConnection),
}));

// Import after mocks
import { AgentTransferMessageBridge } from '../message-bridge.js';

function createAgentEvent(overrides: Partial<AgentEvent> = {}): AgentEvent {
  return {
    type: 'agent:message',
    sessionId: 'session-1',
    tenantId: 'tenant-1',
    contactId: 'contact-1',
    channel: 'chat',
    timestamp: new Date().toISOString(),
    data: {
      message: 'Hello from agent',
      channelType: 'slack',
      connectionId: 'conn-1',
    },
    ...overrides,
  };
}

describe('AgentTransferMessageBridge — attachment delivery', () => {
  let bridge: AgentTransferMessageBridge;

  beforeEach(() => {
    bridge = new AgentTransferMessageBridge();
    sendResponseCalls.length = 0;
    mockSendResponse.mockClear();
  });

  it('delivers attachments as separate messages after main message', async () => {
    const event = createAgentEvent({
      data: {
        message: 'Here are the files',
        channelType: 'slack',
        connectionId: 'conn-1',
        attachments: [
          {
            url: 'https://cdn.example.com/report.pdf',
            fileName: 'report.pdf',
            fileType: 'application/pdf',
          },
          {
            url: 'https://cdn.example.com/image.png',
            fileName: 'image.png',
            fileType: 'image/png',
          },
        ],
      },
    });

    await bridge.deliverViaChatChannel(event);

    // 1 main message + 2 attachment messages
    expect(mockSendResponse).toHaveBeenCalledTimes(3);

    // First call: main message
    const mainMsg = sendResponseCalls[0].message;
    expect(mainMsg.eventType).toBe('agent.response');
    expect(mainMsg.text).toBe('Here are the files');

    // Second call: first attachment
    const attach1 = sendResponseCalls[1].message;
    expect(attach1.eventType).toBe('agent.attachment');
    expect(attach1.text).toBe('report.pdf');
    expect(attach1.metadata?.fileUrl).toBe('https://cdn.example.com/report.pdf');
    expect(attach1.metadata?.fileName).toBe('report.pdf');
    expect(attach1.metadata?.fileType).toBe('application/pdf');
    expect(attach1.metadata?.source).toBe('agent-transfer');

    // Third call: second attachment
    const attach2 = sendResponseCalls[2].message;
    expect(attach2.eventType).toBe('agent.attachment');
    expect(attach2.text).toBe('image.png');
    expect(attach2.metadata?.fileUrl).toBe('https://cdn.example.com/image.png');
  });

  it('delivers agent messages from text/body fallback fields through channel adapters', async () => {
    const event = createAgentEvent({
      data: {
        text: 'Template text content',
        body: 'Body fallback content',
        channelType: 'slack',
        connectionId: 'conn-1',
      },
    });

    await bridge.deliverViaChatChannel(event);

    expect(mockSendResponse).toHaveBeenCalledTimes(1);
    expect(sendResponseCalls[0].message.text).toBe('Template text content');
  });

  it('skips attachments without URL and logs warning', async () => {
    const event = createAgentEvent({
      data: {
        message: 'File attached',
        channelType: 'slack',
        connectionId: 'conn-1',
        attachments: [
          {
            fileId: 'file-123',
            // No url — needs resolution via SmartAssistClient.resolveFileUrl()
            fileName: 'pending-file.pdf',
            fileType: 'application/pdf',
          },
          {
            url: 'https://cdn.example.com/resolved.pdf',
            fileName: 'resolved.pdf',
            fileType: 'application/pdf',
          },
        ],
      },
    });

    await bridge.deliverViaChatChannel(event);

    // 1 main message + 1 attachment (the one without URL is skipped)
    expect(mockSendResponse).toHaveBeenCalledTimes(2);

    const mainMsg = sendResponseCalls[0].message;
    expect(mainMsg.eventType).toBe('agent.response');

    const attachMsg = sendResponseCalls[1].message;
    expect(attachMsg.eventType).toBe('agent.attachment');
    expect(attachMsg.text).toBe('resolved.pdf');
  });

  it('uses "Attachment" as text when fileName is missing', async () => {
    const event = createAgentEvent({
      data: {
        message: 'See attached',
        channelType: 'slack',
        connectionId: 'conn-1',
        attachments: [
          {
            url: 'https://cdn.example.com/unnamed-file',
            // No fileName
            fileType: 'application/octet-stream',
          },
        ],
      },
    });

    await bridge.deliverViaChatChannel(event);

    expect(mockSendResponse).toHaveBeenCalledTimes(2);
    const attachMsg = sendResponseCalls[1].message;
    expect(attachMsg.text).toBe('Attachment');
  });

  it('does not deliver attachments when array is empty', async () => {
    const event = createAgentEvent({
      data: {
        message: 'No attachments here',
        channelType: 'slack',
        connectionId: 'conn-1',
        attachments: [],
      },
    });

    await bridge.deliverViaChatChannel(event);

    // Only the main message
    expect(mockSendResponse).toHaveBeenCalledTimes(1);
    expect(sendResponseCalls[0].message.eventType).toBe('agent.response');
  });

  it('does not deliver attachments when no attachments field exists', async () => {
    const event = createAgentEvent({
      data: {
        message: 'Plain message',
        channelType: 'slack',
        connectionId: 'conn-1',
      },
    });

    await bridge.deliverViaChatChannel(event);

    // Only the main message
    expect(mockSendResponse).toHaveBeenCalledTimes(1);
  });

  it('skips all attachments when none have URLs', async () => {
    const event = createAgentEvent({
      data: {
        message: 'Files pending resolution',
        channelType: 'slack',
        connectionId: 'conn-1',
        attachments: [
          { fileId: 'file-1', fileName: 'a.pdf' },
          { fileId: 'file-2', fileName: 'b.pdf' },
        ],
      },
    });

    await bridge.deliverViaChatChannel(event);

    // Only the main message — both attachments skipped
    expect(mockSendResponse).toHaveBeenCalledTimes(1);
  });
});
