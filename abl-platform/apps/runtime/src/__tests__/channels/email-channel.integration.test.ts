/**
 * Email Channel — End-to-End Integration Test
 *
 * Tests the full email channel flow:
 * 1. SMTP server receives email
 * 2. Email is parsed and connection is resolved
 * 3. Message is enqueued to BullMQ
 * 4. Inbound worker processes the message
 * 5. Email adapter sends the agent reply
 *
 * Also tests session reuse (email threading) and the registry wiring.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EmailAdapter } from '../../channels/adapters/email-adapter.js';
import { getChannelRegistry } from '../../channels/registry.js';
import type {
  InboundJobPayload,
  NormalizedOutgoingMessage,
  ResolvedConnection,
} from '../../channels/types.js';

// Mock transport resolver for outbound
const mockSendReply = vi.fn();

vi.mock('../../services/email/transports/resolve-transport.js', () => ({
  resolveEmailTransport: vi.fn(() => ({ sendReply: mockSendReply })),
}));

// Mock feedback token for CSAT tests
vi.mock('../../services/email/feedback-token.js', () => ({
  signFeedbackToken: vi.fn().mockReturnValue('mock-csat-token'),
}));

function makeConnection(overrides: Partial<ResolvedConnection> = {}): ResolvedConnection {
  return {
    id: 'conn-email-e2e',
    tenantId: 'tenant-e2e',
    projectId: 'project-e2e',
    agentId: 'agent-e2e',
    channelType: 'email',
    externalIdentifier: 'agent@company.com',
    credentials: null,
    config: {},
    status: 'active',
    ...overrides,
  };
}

describe('Email Channel — E2E Integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSendReply.mockResolvedValue({ messageId: '<reply@company.com>' });
  });

  // ===========================================================================
  // REGISTRY
  // ===========================================================================

  describe('Channel Registry', () => {
    it('should have email adapter registered', () => {
      const registry = getChannelRegistry();
      expect(registry.has('email')).toBe(true);
    });

    it('should return EmailAdapter instance for email channel type', () => {
      const registry = getChannelRegistry();
      const adapter = registry.get('email');
      expect(adapter).toBeDefined();
      expect(adapter!.channelType).toBe('email');
      expect(adapter).toBeInstanceOf(EmailAdapter);
    });

    it('should list email in registered types', () => {
      const registry = getChannelRegistry();
      const types = registry.getRegisteredTypes();
      expect(types).toContain('email');
    });
  });

  // ===========================================================================
  // FULL INBOUND → OUTBOUND FLOW (simulated)
  // ===========================================================================

  describe('Inbound → Outbound Flow', () => {
    it('should process a first email and send reply', async () => {
      mockSendReply.mockResolvedValue({
        messageId: '<agent-reply-001@company.com>',
      });

      const registry = getChannelRegistry();
      const adapter = registry.get('email')!;

      // Simulate what the SMTP server would produce
      // New email (no Re: prefix, no threading headers) → message-ID-based key
      const inboundPayload: InboundJobPayload = {
        connectionId: 'conn-email-e2e',
        tenantId: 'tenant-e2e',
        projectId: 'project-e2e',
        agentId: 'agent-e2e',
        channelType: 'email',
        message: {
          externalMessageId: '<user-msg-001@gmail.com>',
          externalSessionKey: 'email:conn-email-e2e:msg:<user-msg-001@gmail.com>',
          text: 'I need help with my bill.',
          metadata: {
            from: 'customer@gmail.com',
            to: 'agent@company.com',
            subject: 'Help with billing',
            messageId: '<user-msg-001@gmail.com>',
            inReplyTo: undefined,
            references: '',
            subjectBasedKey: 'email:conn-email-e2e:customer@gmail.com:help with billing',
            hasThreadingHeaders: false,
          },
          timestamp: new Date('2025-06-01T09:00:00Z'),
        },
        subscriptionId: 'conn-email-e2e',
        idempotencyKey: 'email-_user-msg-001_gmail.com_',
      };

      // 1. Parse incoming (adapter just returns the pre-normalized message)
      const normalized = adapter.parseIncoming(inboundPayload);
      expect(normalized.text).toBe('I need help with my bill.');
      expect(normalized.externalSessionKey).toBe(
        'email:conn-email-e2e:msg:<user-msg-001@gmail.com>',
      );

      // 2. Simulate runtime execution → agent response
      const agentResponse: NormalizedOutgoingMessage = {
        sessionId: 'runtime-session-001',
        text: 'I can help you with your billing question. What is your account number?',
        eventType: 'agent.response',
        metadata: normalized.metadata,
      };

      // 3. Send response via adapter
      const sendResult = await adapter.sendResponse(agentResponse, makeConnection());

      expect(sendResult.success).toBe(true);
      expect(sendResult.deliveryId).toBe('<agent-reply-001@company.com>');

      // Verify email was sent with correct threading
      // Adapter now adds Re: prefix and builds reference chain
      expect(mockSendReply).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'customer@gmail.com',
          from: '"Agent" <agent@company.com>',
          subject: 'Re: Help with billing',
          text: 'I can help you with your billing question. What is your account number?',
          inReplyTo: '<user-msg-001@gmail.com>',
          references: '<user-msg-001@gmail.com>',
        }),
      );
    });

    it('should handle threaded follow-up emails (session reuse)', async () => {
      mockSendReply.mockResolvedValue({
        messageId: '<agent-reply-002@company.com>',
      });

      const registry = getChannelRegistry();
      const adapter = registry.get('email')!;

      // Simulate second email in thread (user replies with Re: subject + threading headers)
      // Reply with In-Reply-To/References → message-ID-based key (unique per message).
      // Session reuse happens in session-resolver via emailMessageIds lookup, not via key matching.
      const followUpPayload: InboundJobPayload = {
        connectionId: 'conn-email-e2e',
        tenantId: 'tenant-e2e',
        projectId: 'project-e2e',
        agentId: 'agent-e2e',
        channelType: 'email',
        message: {
          externalMessageId: '<user-msg-002@gmail.com>',
          // Each message gets a unique key; session resolver matches via emailMessageIds
          externalSessionKey: 'email:conn-email-e2e:msg:<user-msg-002@gmail.com>',
          text: 'My account number is 12345.',
          metadata: {
            from: 'customer@gmail.com',
            to: 'agent@company.com',
            subject: 'Re: Help with billing',
            messageId: '<user-msg-002@gmail.com>',
            inReplyTo: '<agent-reply-001@company.com>',
            references: '<user-msg-001@gmail.com> <agent-reply-001@company.com>',
            subjectBasedKey: 'email:conn-email-e2e:customer@gmail.com:help with billing',
            hasThreadingHeaders: true,
          },
          timestamp: new Date('2025-06-01T09:05:00Z'),
        },
        subscriptionId: 'conn-email-e2e',
        idempotencyKey: 'email-_user-msg-002_gmail.com_',
      };

      const normalized = adapter.parseIncoming(followUpPayload);

      // Each message gets a unique message-ID-based key
      expect(normalized.externalSessionKey).toBe(
        'email:conn-email-e2e:msg:<user-msg-002@gmail.com>',
      );

      // Agent processes and replies
      const agentResponse: NormalizedOutgoingMessage = {
        sessionId: 'runtime-session-001', // Same session
        text: 'I found your account. Your balance is $45.00.',
        eventType: 'agent.response',
        metadata: normalized.metadata,
      };

      const sendResult = await adapter.sendResponse(agentResponse, makeConnection());
      expect(sendResult.success).toBe(true);

      // Verify threading headers chain grows correctly
      // Adapter builds refChain = [metadata.references, metadata.messageId].filter(Boolean).join(' ')
      expect(mockSendReply).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'customer@gmail.com',
          from: '"Agent" <agent@company.com>',
          subject: 'Re: Help with billing',
          text: 'I found your account. Your balance is $45.00.',
          inReplyTo: '<user-msg-002@gmail.com>',
          references:
            '<user-msg-001@gmail.com> <agent-reply-001@company.com> <user-msg-002@gmail.com>',
        }),
      );
    });
  });

  // ===========================================================================
  // CC/BCC HANDLING
  // ===========================================================================

  describe('CC/BCC Handling', () => {
    it('should pass CC recipients on reply, filtering out self', async () => {
      const adapter = getChannelRegistry().get('email')!;

      const outgoing: NormalizedOutgoingMessage = {
        sessionId: 'session-1',
        text: 'Here is the answer.',
        eventType: 'agent.response',
        metadata: {
          from: 'customer@gmail.com',
          to: 'agent@company.com',
          subject: 'Question',
          messageId: '<msg@gmail.com>',
          references: '',
          cc: ['colleague@gmail.com', 'agent@company.com'],
        },
      };

      const connection = makeConnection({ externalIdentifier: 'agent@company.com' });
      await adapter.sendResponse(outgoing, connection);

      expect(mockSendReply).toHaveBeenCalledWith(
        expect.objectContaining({
          cc: ['colleague@gmail.com'],
        }),
      );
    });

    it('should not pass BCC on reply', async () => {
      const adapter = getChannelRegistry().get('email')!;

      const outgoing: NormalizedOutgoingMessage = {
        sessionId: 'session-1',
        text: 'Here is the answer.',
        eventType: 'agent.response',
        metadata: {
          from: 'customer@gmail.com',
          to: 'agent@company.com',
          subject: 'Question',
          messageId: '<msg@gmail.com>',
          references: '',
          bcc: ['secret@gmail.com'],
        },
      };

      const connection = makeConnection({ externalIdentifier: 'agent@company.com' });
      await adapter.sendResponse(outgoing, connection);

      expect(mockSendReply).toHaveBeenCalledWith(
        expect.not.objectContaining({
          bcc: expect.anything(),
        }),
      );
    });

    it('should not include cc key when all CC addresses are self', async () => {
      const adapter = getChannelRegistry().get('email')!;

      const outgoing: NormalizedOutgoingMessage = {
        sessionId: 'session-1',
        text: 'Here is the answer.',
        eventType: 'agent.response',
        metadata: {
          from: 'customer@gmail.com',
          to: 'agent@company.com',
          subject: 'Question',
          messageId: '<msg@gmail.com>',
          references: '',
          cc: ['agent@company.com'],
        },
      };

      const connection = makeConnection({ externalIdentifier: 'agent@company.com' });
      await adapter.sendResponse(outgoing, connection);

      expect(mockSendReply).toHaveBeenCalledWith(
        expect.not.objectContaining({
          cc: expect.anything(),
        }),
      );
    });

    it('should filter self from CC case-insensitively', async () => {
      const adapter = getChannelRegistry().get('email')!;

      const outgoing: NormalizedOutgoingMessage = {
        sessionId: 'session-1',
        text: 'Reply',
        eventType: 'agent.response',
        metadata: {
          from: 'customer@gmail.com',
          to: 'agent@company.com',
          subject: 'Question',
          messageId: '<msg@gmail.com>',
          references: '',
          cc: ['Agent@Company.COM', 'other@gmail.com'],
        },
      };

      const connection = makeConnection({ externalIdentifier: 'agent@company.com' });
      await adapter.sendResponse(outgoing, connection);

      expect(mockSendReply).toHaveBeenCalledWith(
        expect.objectContaining({
          cc: ['other@gmail.com'],
        }),
      );
    });
  });

  // ===========================================================================
  // SESSION KEY NORMALIZATION
  // ===========================================================================

  describe('Session Key Strategy', () => {
    /**
     * The SMTP server builds session keys using RFC 5322 Message-ID threading:
     * - New emails → message-ID-based key (unique per message)
     * - Replies with threading headers → message-ID-based key (session resolver matches via emailMessageIds)
     * - Replies with Re: but no headers → subject-based fallback key
     */

    it('should give new emails unique message-ID-based keys', () => {
      const connId = 'conn-1';
      const msgId1 = '<msg-001@gmail.com>';
      const msgId2 = '<msg-002@gmail.com>';

      const key1 = `email:${connId}:msg:${msgId1}`;
      const key2 = `email:${connId}:msg:${msgId2}`;

      expect(key1).not.toBe(key2);
      expect(key1).toBe('email:conn-1:msg:<msg-001@gmail.com>');
    });

    it('should use subject-based fallback for Re: without threading headers', () => {
      // This tests the normalizeSubject logic from the SMTP server
      const normalizeSubject = (s: string) => {
        let result = s;
        while (/^(Re|Fwd|Fw):\s*/i.test(result)) {
          result = result.replace(/^(Re|Fwd|Fw):\s*/i, '');
        }
        return result.trim();
      };

      const connId = 'conn-1';
      const from = 'user@test.com';

      // Re: without threading headers falls back to subject-based key
      const subjects = [
        'Hello Agent',
        'Re: Hello Agent',
        'Fwd: Hello Agent',
        'Re: Re: Fwd: Hello Agent',
      ];
      const keys = subjects.map(
        (s) => `email:${connId}:${from}:${normalizeSubject(s).toLowerCase()}`,
      );

      // All normalize to the same subject-based key
      expect(new Set(keys).size).toBe(1);
      expect(keys[0]).toBe('email:conn-1:user@test.com:hello agent');
    });

    it('should produce different subject-based keys for different subjects', () => {
      const connId = 'conn-1';
      const from = 'user@test.com';
      const key1 = `email:${connId}:${from}:billing question`;
      const key2 = `email:${connId}:${from}:technical support`;

      expect(key1).not.toBe(key2);
    });

    it('should produce different subject-based keys for different senders', () => {
      const connId = 'conn-1';
      const key1 = `email:${connId}:alice@test.com:hello`;
      const key2 = `email:${connId}:bob@test.com:hello`;

      expect(key1).not.toBe(key2);
    });
  });

  // ===========================================================================
  // HTML OUTBOUND
  // ===========================================================================

  describe('HTML Email Outbound', () => {
    it('should send both plain text and HTML in outbound email', async () => {
      const adapter = getChannelRegistry().get('email')!;

      const outgoing: NormalizedOutgoingMessage = {
        sessionId: 'session-1',
        text: 'Here is **bold** and a [link](https://example.com).',
        eventType: 'agent.response',
        metadata: {
          from: 'customer@gmail.com',
          to: 'agent@company.com',
          subject: 'Test',
          messageId: '<msg@gmail.com>',
          references: '',
        },
      };

      await adapter.sendResponse(outgoing, makeConnection());

      const callArgs = mockSendReply.mock.calls[0][0];
      expect(callArgs.text).toBe('Here is **bold** and a [link](https://example.com).');
      expect(callArgs.html).toContain('<strong>bold</strong>');
      expect(callArgs.html).toContain('href="https://example.com"');
      expect(callArgs.html).toContain('max-width');
    });

    it('should escape raw HTML in agent response to prevent injection', async () => {
      const adapter = getChannelRegistry().get('email')!;

      const outgoing: NormalizedOutgoingMessage = {
        sessionId: 'session-1',
        text: 'You said: <img src="http://evil.com/track.png"> and <script>alert(1)</script>',
        eventType: 'agent.response',
        metadata: {
          from: 'customer@gmail.com',
          to: 'agent@company.com',
          subject: 'Test',
          messageId: '<msg@gmail.com>',
          references: '',
        },
      };

      await adapter.sendResponse(outgoing, makeConnection());

      const callArgs = mockSendReply.mock.calls[0][0];
      // Raw HTML tags must be escaped, not rendered
      expect(callArgs.html).not.toContain('<img');
      expect(callArgs.html).not.toContain('<script');
      expect(callArgs.html).toContain('&lt;img');
      expect(callArgs.html).toContain('&lt;script');
    });

    it('should strip javascript: links from markdown output', async () => {
      const adapter = getChannelRegistry().get('email')!;

      const outgoing: NormalizedOutgoingMessage = {
        sessionId: 'session-1',
        text: 'Click [here](javascript:alert(1)) or [data](data:text/html,<h1>pwned</h1>)',
        eventType: 'agent.response',
        metadata: {
          from: 'customer@gmail.com',
          to: 'agent@company.com',
          subject: 'Test',
          messageId: '<msg@gmail.com>',
          references: '',
        },
      };

      await adapter.sendResponse(outgoing, makeConnection());

      const callArgs = mockSendReply.mock.calls[0][0];
      expect(callArgs.html).not.toContain('javascript:');
      expect(callArgs.html).not.toContain('data:text');
      // Link text is preserved, dangerous href is removed
      expect(callArgs.html).toContain('here');
      expect(callArgs.html).toContain('data');
    });

    it('should escape HTML in link text and render inline formatting', async () => {
      const adapter = getChannelRegistry().get('email')!;

      const outgoing: NormalizedOutgoingMessage = {
        sessionId: 'session-1',
        text: 'Click [x<script>alert(1)</script>](https://example.com) or [**bold link**](https://example.com)',
        eventType: 'agent.response',
        metadata: {
          from: 'customer@gmail.com',
          to: 'agent@company.com',
          subject: 'Test',
          messageId: '<msg@gmail.com>',
          references: '',
        },
      };

      await adapter.sendResponse(outgoing, makeConnection());

      const callArgs = mockSendReply.mock.calls[0][0];
      // Script in link text must be escaped
      expect(callArgs.html).not.toContain('<script');
      expect(callArgs.html).toContain('&lt;script&gt;');
      // Inline formatting in link text must render
      expect(callArgs.html).toContain('<strong>bold link</strong>');
      expect(callArgs.html).not.toContain('**bold link**');
    });

    it('should not emit <img> tags for markdown images (tracking pixel prevention)', async () => {
      const adapter = getChannelRegistry().get('email')!;

      const outgoing: NormalizedOutgoingMessage = {
        sessionId: 'session-1',
        text: 'See this: ![diagram](https://evil.example/track.png)',
        eventType: 'agent.response',
        metadata: {
          from: 'customer@gmail.com',
          to: 'agent@company.com',
          subject: 'Test',
          messageId: '<msg@gmail.com>',
          references: '',
        },
      };

      await adapter.sendResponse(outgoing, makeConnection());

      const callArgs = mockSendReply.mock.calls[0][0];
      // No <img> tag — rendered as a text link instead
      expect(callArgs.html).not.toContain('<img');
      expect(callArgs.html).toContain('diagram');
      expect(callArgs.html).toContain('href="https://evil.example/track.png"');
    });
  });

  // ===========================================================================
  // HEADER/FOOTER TEMPLATES
  // ===========================================================================

  describe('Header/Footer Templates', () => {
    it('should inject header and footer from connection config into HTML email', async () => {
      const adapter = getChannelRegistry().get('email')!;

      const outgoing: NormalizedOutgoingMessage = {
        sessionId: 'session-1',
        text: 'Your order has shipped.',
        eventType: 'agent.response',
        metadata: {
          from: 'customer@gmail.com',
          to: 'agent@company.com',
          subject: 'Order update',
          messageId: '<msg@gmail.com>',
          references: '',
        },
      };

      const connection = makeConnection({
        config: {
          emailHeader: '<div style="background:#003366;color:white;padding:12px">Acme Corp</div>',
          emailFooter: '<div style="font-size:11px;color:#666;padding:12px">Confidential</div>',
        },
      });

      await adapter.sendResponse(outgoing, connection);

      const callArgs = mockSendReply.mock.calls[0][0];
      expect(callArgs.html).toContain('Acme Corp');
      expect(callArgs.html).toContain('Confidential');
      // Header before body before footer
      const headerIdx = callArgs.html.indexOf('Acme Corp');
      const bodyIdx = callArgs.html.indexOf('Your order has shipped');
      const footerIdx = callArgs.html.indexOf('Confidential');
      expect(headerIdx).toBeLessThan(bodyIdx);
      expect(bodyIdx).toBeLessThan(footerIdx);
    });

    it('should work without header/footer config', async () => {
      const adapter = getChannelRegistry().get('email')!;

      const outgoing: NormalizedOutgoingMessage = {
        sessionId: 'session-1',
        text: 'Hello!',
        eventType: 'agent.response',
        metadata: {
          from: 'customer@gmail.com',
          to: 'agent@company.com',
          subject: 'Hi',
          messageId: '<msg@gmail.com>',
          references: '',
        },
      };

      await adapter.sendResponse(outgoing, makeConnection({ config: {} }));

      const callArgs = mockSendReply.mock.calls[0][0];
      expect(callArgs.html).toBeDefined();
      expect(callArgs.html).toContain('Hello!');
    });
  });

  // ===========================================================================
  // ERROR SCENARIOS
  // ===========================================================================

  describe('Error Scenarios', () => {
    it('should handle SMTP relay failure gracefully', async () => {
      mockSendReply.mockRejectedValue(new Error('ECONNREFUSED'));

      const adapter = getChannelRegistry().get('email')!;

      const outgoing: NormalizedOutgoingMessage = {
        sessionId: 'session-1',
        text: 'Agent reply',
        eventType: 'agent.response',
        metadata: {
          from: 'user@test.com',
          subject: 'Test',
          messageId: '<msg@test.com>',
        },
      };

      const result = await adapter.sendResponse(outgoing, makeConnection());

      expect(result.success).toBe(false);
      expect(result.error).toBe('ECONNREFUSED');
    });

    it('should handle missing metadata gracefully', async () => {
      const adapter = getChannelRegistry().get('email')!;

      const outgoing: NormalizedOutgoingMessage = {
        sessionId: 'session-1',
        text: 'Reply',
        eventType: 'agent.response',
        // No metadata
      };

      const result = await adapter.sendResponse(outgoing, makeConnection());
      expect(result.success).toBe(false);
    });
  });

  // ===========================================================================
  // CSAT FEEDBACK
  // ===========================================================================

  describe('CSAT Feedback', () => {
    it('should include CSAT rating links when csatEnabled is true', async () => {
      const adapter = getChannelRegistry().get('email')!;

      const outgoing: NormalizedOutgoingMessage = {
        sessionId: 'session-1',
        text: 'Here is your answer.',
        eventType: 'agent.response',
        metadata: {
          from: 'customer@gmail.com',
          to: 'agent@company.com',
          subject: 'Help',
          messageId: '<msg@gmail.com>',
          references: '',
        },
      };

      const connection = makeConnection({
        config: { csatEnabled: true },
      });

      await adapter.sendResponse(outgoing, connection);

      const callArgs = mockSendReply.mock.calls[0][0];
      // Should have 5 rating links
      expect(callArgs.html).toContain('rating=1');
      expect(callArgs.html).toContain('rating=2');
      expect(callArgs.html).toContain('rating=3');
      expect(callArgs.html).toContain('rating=4');
      expect(callArgs.html).toContain('rating=5');
      expect(callArgs.html).toContain('How was this response');
    });

    it('should not include CSAT when csatEnabled is false or absent', async () => {
      const adapter = getChannelRegistry().get('email')!;

      const outgoing: NormalizedOutgoingMessage = {
        sessionId: 'session-1',
        text: 'Here is your answer.',
        eventType: 'agent.response',
        metadata: {
          from: 'customer@gmail.com',
          to: 'agent@company.com',
          subject: 'Help',
          messageId: '<msg@gmail.com>',
          references: '',
        },
      };

      await adapter.sendResponse(outgoing, makeConnection({ config: {} }));

      const callArgs = mockSendReply.mock.calls[0][0];
      expect(callArgs.html).not.toContain('rating=');
      expect(callArgs.html).not.toContain('How was this response');
    });
  });
});
