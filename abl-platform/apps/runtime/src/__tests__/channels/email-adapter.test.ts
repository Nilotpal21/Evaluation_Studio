/**
 * Email Adapter Tests
 *
 * Unit tests for the EmailAdapter channel adapter.
 * Tests verifyRequest, parseIncoming, and sendResponse (success + failure).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EmailAdapter } from '../../channels/adapters/email-adapter.js';
import type {
  InboundJobPayload,
  NormalizedOutgoingMessage,
  ResolvedConnection,
} from '../../channels/types.js';

const SAFE_DELIVERY_FAILURE = "I'm having trouble delivering that response. Please try again.";

// Mock the transport resolver
const mockSendReply = vi.fn();

vi.mock('../../services/email/transports/resolve-transport.js', () => ({
  resolveEmailTransport: vi.fn(() => ({ sendReply: mockSendReply })),
}));

function makeConnection(overrides: Partial<ResolvedConnection> = {}): ResolvedConnection {
  return {
    id: 'conn-email-001',
    tenantId: 'tenant-1',
    projectId: 'project-1',
    agentId: null,
    channelType: 'email',
    externalIdentifier: 'agent@example.com',
    credentials: null,
    config: {},
    status: 'active',
    ...overrides,
  };
}

describe('EmailAdapter', () => {
  let adapter: EmailAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSendReply.mockResolvedValue({ messageId: '<reply-456@example.com>' });
    adapter = new EmailAdapter();
  });

  // ===========================================================================
  // BASIC PROPERTIES
  // ===========================================================================

  describe('properties', () => {
    it('should have channelType "email"', () => {
      expect(adapter.channelType).toBe('email');
    });

    it('should declare correct capabilities', () => {
      expect(adapter.capabilities).toEqual({
        supportsAsync: true,
        supportsStreaming: false,
        supportsMedia: true,
        supportsThreading: true,
      });
    });
  });

  // ===========================================================================
  // verifyRequest
  // ===========================================================================

  describe('verifyRequest', () => {
    it('should always return true (SMTP server handles inbound directly)', async () => {
      const result = await adapter.verifyRequest({}, {});
      expect(result).toBe(true);
    });
  });

  // ===========================================================================
  // parseIncoming
  // ===========================================================================

  describe('parseIncoming', () => {
    it('should return the already-normalized message from the payload', () => {
      const payload: InboundJobPayload = {
        connectionId: 'conn-1',
        tenantId: 'tenant-1',
        projectId: 'project-1',
        agentId: null,
        channelType: 'email',
        message: {
          externalMessageId: '<msg-123@example.com>',
          externalSessionKey: 'email:user@test.com:Hello',
          text: 'What can you help me with?',
          metadata: {
            from: 'user@test.com',
            to: 'agent@example.com',
            subject: 'Hello',
            messageId: '<msg-123@example.com>',
          },
          timestamp: new Date('2025-01-15T10:00:00Z'),
        },
        subscriptionId: 'conn-1',
        idempotencyKey: 'email:<msg-123@example.com>',
      };

      const result = adapter.parseIncoming(payload);
      expect(result).toBe(payload.message);
      expect(result.externalMessageId).toBe('<msg-123@example.com>');
      expect(result.text).toBe('What can you help me with?');
    });
  });

  // ===========================================================================
  // sendResponse
  // ===========================================================================

  describe('sendResponse', () => {
    it('should send an email reply via the transport', async () => {
      const outgoing: NormalizedOutgoingMessage = {
        sessionId: 'session-1',
        text: 'I can help you with many things!',
        eventType: 'agent.response',
        metadata: {
          from: 'user@test.com',
          to: 'agent@example.com',
          subject: 'Hello',
          messageId: '<msg-123@example.com>',
          references: '<prev-msg@example.com>',
        },
      };

      const result = await adapter.sendResponse(outgoing, makeConnection());

      expect(result.success).toBe(true);
      expect(result.deliveryId).toBe('<reply-456@example.com>');
      expect(mockSendReply).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'user@test.com',
          from: '"Agent" <agent@example.com>',
          subject: 'Re: Hello',
          text: 'I can help you with many things!',
          inReplyTo: '<msg-123@example.com>',
          references: '<prev-msg@example.com> <msg-123@example.com>',
          headers: { 'X-ABL-Source': 'agent-platform' },
        }),
      );
    });

    it('should return error when no "from" address in metadata', async () => {
      const outgoing: NormalizedOutgoingMessage = {
        sessionId: 'session-1',
        text: 'Hello!',
        eventType: 'agent.response',
        metadata: {
          subject: 'Test',
        },
      };

      const result = await adapter.sendResponse(outgoing, makeConnection());

      expect(result.success).toBe(false);
      expect(result.error).toBe(SAFE_DELIVERY_FAILURE);
      expect(result.metadata?.channelDiagnostic).toMatchObject({
        channelType: 'email',
        provider: 'email',
        category: 'metadata',
        code: 'CHANNEL_DELIVERY_METADATA',
        retryable: false,
      });
    });

    it('should return error when metadata is undefined', async () => {
      const outgoing: NormalizedOutgoingMessage = {
        sessionId: 'session-1',
        text: 'Hello!',
        eventType: 'agent.response',
      };

      const result = await adapter.sendResponse(outgoing, makeConnection());

      expect(result.success).toBe(false);
      expect(result.error).toBe(SAFE_DELIVERY_FAILURE);
      expect(result.metadata?.channelDiagnostic).toMatchObject({
        channelType: 'email',
        provider: 'email',
        category: 'metadata',
        code: 'CHANNEL_DELIVERY_METADATA',
        retryable: false,
      });
    });

    it('should return metadata error when from address is not a string', async () => {
      const outgoing: NormalizedOutgoingMessage = {
        sessionId: 'session-1',
        text: 'Hello!',
        eventType: 'agent.response',
        metadata: {
          from: { address: 'user@test.com' },
          subject: 'Test',
        },
      };

      const result = await adapter.sendResponse(outgoing, makeConnection());

      expect(result.success).toBe(false);
      expect(result.error).toBe(SAFE_DELIVERY_FAILURE);
      expect(result.metadata?.channelDiagnostic).toMatchObject({
        channelType: 'email',
        provider: 'email',
        category: 'metadata',
        code: 'CHANNEL_DELIVERY_METADATA',
        retryable: false,
      });
      expect(mockSendReply).not.toHaveBeenCalled();
    });

    it('should handle email sender errors gracefully', async () => {
      mockSendReply.mockRejectedValue(new Error('SMTP relay connection refused'));

      const outgoing: NormalizedOutgoingMessage = {
        sessionId: 'session-1',
        text: 'Reply text',
        eventType: 'agent.response',
        metadata: {
          from: 'user@test.com',
          subject: 'Test',
          messageId: '<msg-1@test.com>',
        },
      };

      const result = await adapter.sendResponse(outgoing, makeConnection());

      expect(result.success).toBe(false);
      expect(result.error).toBe(SAFE_DELIVERY_FAILURE);
      expect(result.metadata?.channelDiagnostic).toMatchObject({
        channelType: 'email',
        provider: 'email',
        category: 'network',
        code: 'CHANNEL_DELIVERY_FAILED',
        retryable: true,
      });
    });

    it('should use default subject when not in metadata', async () => {
      const outgoing: NormalizedOutgoingMessage = {
        sessionId: 'session-1',
        text: 'Reply',
        eventType: 'agent.response',
        metadata: { from: 'user@test.com' },
      };

      await adapter.sendResponse(outgoing, makeConnection());

      expect(mockSendReply).toHaveBeenCalledWith(
        expect.objectContaining({ subject: 'Re: (no subject)' }),
      );
    });

    it('should ignore non-string optional email threading metadata', async () => {
      const outgoing: NormalizedOutgoingMessage = {
        sessionId: 'session-1',
        text: 'Reply',
        eventType: 'agent.response',
        metadata: {
          from: 'user@test.com',
          subject: { value: 'Bad subject' },
          messageId: { value: '<msg-1@test.com>' },
          references: ['<prev-msg@test.com>'],
        },
      };

      const result = await adapter.sendResponse(outgoing, makeConnection());

      expect(result.success).toBe(true);
      expect(mockSendReply).toHaveBeenCalledWith(
        expect.objectContaining({
          subject: 'Re: (no subject)',
          inReplyTo: undefined,
          references: undefined,
        }),
      );
    });
  });
});
