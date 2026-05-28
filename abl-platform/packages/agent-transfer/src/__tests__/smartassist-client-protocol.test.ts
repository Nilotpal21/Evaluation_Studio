/**
 * SmartAssistClient protocol tests
 *
 * Covers Phase 1 changes: configurable paths, XO payload fields,
 * sendEvent, non-retryable initTransfer, and JSON.parse error handling.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SmartAssistClient } from '../adapters/kore/smartassist-client.js';
import type { KoreTransferPayload, KoreUserEvent } from '../adapters/kore/smartassist-client.js';

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../security/ssrf-guard.js', () => ({
  assertAllowedUrl: vi.fn(),
  assertAllowedUrlSync: vi.fn(),
}));

function makeConfig(overrides: Record<string, unknown> = {}) {
  return {
    baseUrl: 'http://localhost:9999',
    apiKey: 'test-key',
    timeoutMs: 5000,
    retry: { maxAttempts: 2, backoffMs: 100, backoffMultiplier: 2 },
    ...overrides,
  };
}

describe('SmartAssistClient protocol', () => {
  let client: SmartAssistClient;

  beforeEach(() => {
    client = new SmartAssistClient(makeConfig(), undefined);
  });

  describe('1.1 - initTransfer uses configurable path', () => {
    it('uses default path /api/v1/conversations when not configured', async () => {
      const postSpy = vi
        .spyOn(client as any, 'post')
        .mockResolvedValue({ success: true, data: { conversationId: 'c1' } });

      await client.initTransfer({
        agentId: 'a1',
        contactId: 'u1',
        tenantId: 't1',
        projectId: 'p1',
      });

      expect(postSpy).toHaveBeenCalledWith(
        '/agentassist/api/v1/conversations',
        expect.any(Object),
        'INIT_TRANSFER',
        false,
      );
    });

    it('uses custom initTransferPath when configured', async () => {
      const customClient = new SmartAssistClient(
        makeConfig({ initTransferPath: '/custom/transfer' }),
        undefined,
      );
      const postSpy = vi
        .spyOn(customClient as any, 'post')
        .mockResolvedValue({ success: true, data: { conversationId: 'c2' } });

      await customClient.initTransfer({
        agentId: 'a1',
        contactId: 'u1',
        tenantId: 't1',
        projectId: 'p1',
      });

      expect(postSpy).toHaveBeenCalledWith(
        '/custom/transfer',
        expect.any(Object),
        'INIT_TRANSFER',
        false,
      );
    });
  });

  describe('1.2 - initTransfer sends all required XO fields', () => {
    it('includes all XO payload fields in the request body', async () => {
      const postSpy = vi
        .spyOn(client as any, 'post')
        .mockResolvedValue({ success: true, data: { conversationId: 'c3' } });

      const payload: KoreTransferPayload = {
        agentId: 'a1',
        contactId: 'u1',
        tenantId: 't1',
        projectId: 'p1',
        source: 'rtm',
        conversationType: 'livechat',
        skillsIds: ['101', '202'],
        metaInfo: {
          firstName: 'John',
          lastName: 'Doe',
          email: 'john@example.com',
          phoneNumber: '+1234567890',
          city: 'NYC',
          country: 'US',
          customData: { vip: true },
          agentTransferConfig: {
            automationBotId: 'bot-1',
            lastIntentName: 'billing',
            dialog_tone: [{ tone_name: 'frustrated', level: 3 }],
          },
        },
        keyIntentName: 'billing_inquiry',
        sentimentTone: { sentiment: 'negative', emoji: '😠', strength: 0.8 },
        agentDesktopMeta: { layout: 'compact' },
        hostDomain: 'example.com',
        os: 'macOS',
        device: 'desktop',
        surveyRequired: 'YES',
        email: {
          emailId: 'e1',
          toEmailId: 'e2',
          subject: 'Help needed',
          cc: ['cc@example.com'],
        },
        campaignInfo: { campaignId: 'camp-1' },
        sourceAgentId: 'bot-source',
      };

      await client.initTransfer(payload);

      const body = postSpy.mock.calls[0][1] as Record<string, unknown>;

      // Core identity fields
      expect(body.botId).toBe('a1');
      expect(body.userId).toBe('u1');
      expect(body.orgId).toBe('t1');

      // Source and conversationType are mapped by the client from channel
      expect(body.source).toBe('rtm');
      expect(body.conversationType).toBe('livechat');
      expect(body.skillsIds).toEqual(['101', '202']);
      // metaInfo is transformed by initTransfer (wraps contact fields, adds conversationHistory)
      const metaInfo = body.metaInfo as Record<string, unknown>;
      expect(metaInfo.customData).toEqual({ vip: true });
      expect(metaInfo.agentTransferConfig).toEqual(payload.metaInfo?.agentTransferConfig);
      expect(body.automationBotId).toBe('bot-source');
    });

    it('omits undefined XO fields without error', async () => {
      const postSpy = vi
        .spyOn(client as any, 'post')
        .mockResolvedValue({ success: true, data: { conversationId: 'c4' } });

      await client.initTransfer({
        agentId: 'a1',
        contactId: 'u1',
        tenantId: 't1',
        projectId: 'p1',
      });

      const body = postSpy.mock.calls[0][1] as Record<string, unknown>;
      // Core fields are always present
      expect(body.botId).toBe('a1');
      // source is mapped from channel (defaults to 'rtm'), not passed through
      expect(body.source).toBe('rtm');
      // automationBotId only set when sourceAgentId is provided
      expect(body.automationBotId).toBeUndefined();
    });

    it('includes voice transfer fields for gateway channels', async () => {
      const postSpy = vi
        .spyOn(client as any, 'post')
        .mockResolvedValue({ success: true, data: { conversationId: 'c-voice' } });

      await client.initTransfer({
        agentId: 'a1',
        contactId: 'u1',
        tenantId: 't1',
        projectId: 'p1',
        channel: 'korevg',
        language: 'en',
        voiceData: {
          callSid: 'call-1',
          caller: '+15551234567',
          called: '+18005550199',
          sipCallId: 'sip-call-1',
          sipTo: 'bot@example.com',
          callerName: 'Jane Caller',
          originatingSipIp: '10.1.2.3',
        },
      });

      const body = postSpy.mock.calls[0][1] as Record<string, unknown>;
      const metaInfo = body.metaInfo as Record<string, unknown>;

      expect(body.source).toBe('korevg');
      expect(body.conversationType).toBe('call');
      expect(body.phoneNumber).toBe('+15551234567');
      expect(body.CallIDData).toBe('sip-call-1');
      expect(body.botSIPURI).toBe('sip:bot@example.com');
      expect(body.voiceChatAgentLang).toBe('en');
      expect(body.voiceChatUserLang).toBe('en');
      expect(body.recognizerLang).toBe('en');
      expect(metaInfo.caller).toBe('+15551234567');
      expect(metaInfo.callee).toBe('+18005550199');
      expect(metaInfo.dialedNumber).toBe('+18005550199');
      expect(metaInfo.callerName).toBe('Jane Caller');
      expect(metaInfo.callerHost).toBe('10.1.2.3');
    });
  });

  describe('1.3 - accountId mapping', () => {
    it('uses tenantId as accountId when accountId not configured', async () => {
      const postSpy = vi
        .spyOn(client as any, 'post')
        .mockResolvedValue({ success: true, data: { conversationId: 'c5' } });

      await client.initTransfer({
        agentId: 'a1',
        contactId: 'u1',
        tenantId: 'tenant-abc',
        projectId: 'p1',
      });

      const body = postSpy.mock.calls[0][1] as Record<string, unknown>;
      expect(body.accountId).toBe('tenant-abc');
    });

    it('uses configured accountId when provided', async () => {
      const customClient = new SmartAssistClient(
        makeConfig({ accountId: 'acct-override' }),
        undefined,
      );
      const postSpy = vi
        .spyOn(customClient as any, 'post')
        .mockResolvedValue({ success: true, data: { conversationId: 'c6' } });

      await customClient.initTransfer({
        agentId: 'a1',
        contactId: 'u1',
        tenantId: 'tenant-abc',
        projectId: 'p1',
      });

      const body = postSpy.mock.calls[0][1] as Record<string, unknown>;
      // accountId uses koreAccountId || orgId || accountId || tenantId
      expect(body.accountId).toBe('acct-override');
      // orgId uses orgId || accountId || tenantId — falls through to accountId
      expect(body.orgId).toBe('acct-override');
    });
  });

  describe('1.4 - sendEvent', () => {
    it('POSTs to the correct path with session and conversation IDs', async () => {
      const postSpy = vi.spyOn(client as any, 'post').mockResolvedValue({ success: true });

      const event: KoreUserEvent = {
        eventName: 'start_kore_agent_chat_message_for_agent',
        payload: {
          conversationId: 'conv-1',
          author: { id: 'user-1', type: 'USER' },
          type: 'text',
          value: 'Hello agent',
          event: 'user_message',
        },
        queryFields: { sid: 'sess-1', cId: 'conv-1' },
      };

      await client.sendEvent('sess-1', 'conv-1', event);

      expect(postSpy).toHaveBeenCalledWith(
        '/agentassist/api/v1/internal/events/handle/?sid=sess-1&cId=conv-1',
        event,
        'SEND_USER_EVENT',
      );
    });

    it('uses custom eventHandlePath when configured', async () => {
      const customClient = new SmartAssistClient(
        makeConfig({ eventHandlePath: '/custom/events/' }),
        undefined,
      );
      const postSpy = vi.spyOn(customClient as any, 'post').mockResolvedValue({ success: true });

      const event: KoreUserEvent = {
        eventName: 'close_conversation',
        payload: {
          conversationId: 'conv-2',
          author: { id: 'user-2', type: 'USER' },
          event: 'close_agent_chat',
        },
        queryFields: { sid: 'sess-2', cId: 'conv-2' },
      };

      await customClient.sendEvent('sess-2', 'conv-2', event);

      expect(postSpy).toHaveBeenCalledWith(
        '/custom/events/?sid=sess-2&cId=conv-2',
        event,
        'SEND_USER_EVENT',
      );
    });

    it('URL-encodes session and conversation IDs', async () => {
      const postSpy = vi.spyOn(client as any, 'post').mockResolvedValue({ success: true });

      const event: KoreUserEvent = {
        eventName: 'start_control_message_for_agent',
        payload: {
          conversationId: 'conv/special&id',
          author: { id: 'user-1', type: 'USER' },
          event: 'typing',
        },
        queryFields: { sid: 'sess/special&id', cId: 'conv/special&id' },
      };

      await client.sendEvent('sess/special&id', 'conv/special&id', event);

      const calledPath = postSpy.mock.calls[0][0] as string;
      expect(calledPath).toContain('sid=sess%2Fspecial%26id');
      expect(calledPath).toContain('cId=conv%2Fspecial%26id');
    });
  });

  describe('1.8 - initTransfer is non-retryable', () => {
    it('passes retryable=false to post()', async () => {
      const postSpy = vi
        .spyOn(client as any, 'post')
        .mockResolvedValue({ success: true, data: { conversationId: 'c7' } });

      await client.initTransfer({
        agentId: 'a1',
        contactId: 'u1',
        tenantId: 't1',
        projectId: 'p1',
      });

      // 4th argument is retryable=false
      expect(postSpy).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Object),
        'INIT_TRANSFER',
        false,
      );
    });

    it('does not call executeWithRetry for initTransfer', async () => {
      const executeRequestSpy = vi
        .spyOn(client as any, 'executeRequest')
        .mockResolvedValue({ success: true, data: { conversationId: 'c8' } });
      const executeWithRetrySpy = vi.spyOn(client as any, 'executeWithRetry');

      await client.initTransfer({
        agentId: 'a1',
        contactId: 'u1',
        tenantId: 't1',
        projectId: 'p1',
      });

      expect(executeRequestSpy).toHaveBeenCalledTimes(1);
      expect(executeWithRetrySpy).not.toHaveBeenCalled();
    });

    it('calls executeWithRetry for other operations', async () => {
      const executeWithRetrySpy = vi
        .spyOn(client as any, 'executeWithRetry')
        .mockResolvedValue({ success: true, data: true });

      await client.checkBusinessHours('a1', 'hours-1');

      expect(executeWithRetrySpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('M4 - JSON.parse failure returns structured error', () => {
    it('returns SMARTASSIST_PARSE_ERROR on malformed JSON response', async () => {
      // Mock the pool.request to return non-JSON text
      vi.spyOn((client as any).pool, 'request').mockResolvedValue({
        statusCode: 200,
        body: { text: () => Promise.resolve('not valid json {{{') },
      });

      // Call a method that goes through executeRequest
      const result = await client.checkBusinessHours('a1', 'hours-1');

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('SMARTASSIST_PARSE_ERROR');
      expect(result.error?.message).toContain('Failed to parse SmartAssist response as JSON');
    });

    it('succeeds when response is empty string', async () => {
      vi.spyOn((client as any).pool, 'request').mockResolvedValue({
        statusCode: 200,
        body: { text: () => Promise.resolve('') },
      });

      const result = await client.checkBusinessHours('a1', 'hours-1');

      expect(result.success).toBe(true);
      expect(result.data).toBeUndefined();
    });

    it('succeeds when response is valid JSON', async () => {
      vi.spyOn((client as any).pool, 'request').mockResolvedValue({
        statusCode: 200,
        body: { text: () => Promise.resolve('{"available":true}') },
      });

      const result = await client.checkBusinessHours('a1', 'hours-1');

      expect(result.success).toBe(true);
      expect(result.data).toEqual({ available: true });
    });
  });
});
