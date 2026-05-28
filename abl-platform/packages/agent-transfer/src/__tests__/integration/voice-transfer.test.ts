/**
 * Integration test: Voice transfer flows
 *
 * Covers the voice channel transfer lifecycle:
 *   - Voice channel detection via isVoiceChannel()
 *   - Voice-only tool rejection on chat channels
 *   - Transfer on voice returns status 'waiting'
 *   - DTMF collection with digit options
 *   - Call transfer payload construction (SIP and PSTN)
 *   - Deflect-to-chat from voice channel
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AdapterRegistry } from '../../adapters/registry.js';
import { TransferToAgentTool, type TransferToolContext } from '../../tools/transfer-to-agent.js';
import { CallTransferTool } from '../../tools/call-transfer.js';
import { IVRMenuTool } from '../../tools/ivr-menu.js';
import { IVRDigitInputTool } from '../../tools/ivr-digit-input.js';
import { DeflectToChatTool } from '../../tools/deflect-to-chat.js';
import { isVoiceChannel, VOICE_CHANNELS, buildVoicePayload } from '../../voice/index.js';
import { createMockAdapter, sampleTransferPayload } from '../helpers/index.js';
import type { AgentDesktopAdapter, AdapterCapabilities } from '../../adapters/interface.js';
import type { TransferResult } from '../../types.js';

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createAdapterWithResult(name: string, executeResult: TransferResult): AgentDesktopAdapter {
  return {
    name,
    capabilities: {
      supportsPreChecks: true,
      supportsPostAgentDialog: true,
      supportsFileUpload: false,
      supportsTranslation: false,
      transportType: 'polling',
      authType: 'internal_key',
    } satisfies AdapterCapabilities,
    initialize: vi.fn().mockResolvedValue(undefined),
    execute: vi.fn().mockResolvedValue(executeResult),
    sendUserMessage: vi.fn().mockResolvedValue(undefined),
    endSession: vi.fn().mockResolvedValue(undefined),
    onAgentMessage: vi.fn(),
    onSessionEvent: vi.fn(),
  };
}

const VOICE_CONTEXT: TransferToolContext = {
  tenantId: 'tenant-1',
  projectId: 'proj-1',
  agentId: 'agent-1',
  contactId: 'contact-1',
  sessionId: 'sess-voice-1',
  channel: 'voice',
};

const CHAT_CONTEXT: TransferToolContext = {
  tenantId: 'tenant-1',
  projectId: 'proj-1',
  agentId: 'agent-1',
  contactId: 'contact-1',
  sessionId: 'sess-chat-1',
  channel: 'chat',
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('voice transfer integration', () => {
  describe('voice channel detection', () => {
    it('recognises all registered voice channels', () => {
      const expectedVoiceChannels = [
        'voice',
        'korevg',
        'audiocodes',
        'twilio',
        'voice_twilio',
        'ivr',
        'jambonz',
      ];
      for (const ch of expectedVoiceChannels) {
        expect(isVoiceChannel(ch)).toBe(true);
      }
    });

    it('rejects non-voice channels', () => {
      const nonVoiceChannels = ['chat', 'email', 'messaging', 'campaign', 'sms', 'web'];
      for (const ch of nonVoiceChannels) {
        expect(isVoiceChannel(ch)).toBe(false);
      }
    });

    it('VOICE_CHANNELS set has expected size', () => {
      expect(VOICE_CHANNELS.size).toBe(7);
    });

    it('channel detection is case-sensitive', () => {
      expect(isVoiceChannel('Voice')).toBe(false);
      expect(isVoiceChannel('VOICE')).toBe(false);
      expect(isVoiceChannel('voice')).toBe(true);
    });
  });

  describe('transfer on voice returns waiting', () => {
    let registry: AdapterRegistry;
    let tool: TransferToAgentTool;

    beforeEach(() => {
      registry = new AdapterRegistry();
      const adapter = createAdapterWithResult('kore', {
        success: true,
        status: 'transferred',
        providerSessionId: 'kore-voice-conv-1',
      });
      registry.register('kore', adapter);
      tool = new TransferToAgentTool(registry);
    });

    it('voice channel transfer returns status "waiting"', async () => {
      const result = await tool.execute({ provider: 'kore' }, VOICE_CONTEXT);

      expect(result.success).toBe(true);
      expect(result.status).toBe('waiting');
      expect(result.conversationId).toBe('kore-voice-conv-1');
    });

    it('chat channel transfer returns status "transferred"', async () => {
      const result = await tool.execute({ provider: 'kore' }, CHAT_CONTEXT);

      expect(result.success).toBe(true);
      expect(result.status).toBe('transferred');
      expect(result.conversationId).toBe('kore-voice-conv-1');
    });

    it('adapter receives correct channel in payload', async () => {
      const adapter = registry.get('kore')!;
      await tool.execute({ provider: 'kore' }, VOICE_CONTEXT);

      expect(adapter.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: 'tenant-1',
          contactId: 'contact-1',
          channel: 'voice',
        }),
      );
    });

    it('sampleTransferPayload helper works with voice channel', () => {
      const payload = sampleTransferPayload({ channel: 'voice' });
      expect(payload.channel).toBe('voice');
      expect(payload.tenantId).toBe('tenant-1');
    });
  });

  describe('voice-only tool rejection on chat channel', () => {
    it('CallTransferTool is voice-only — does not accept chat context directly', () => {
      // CallTransferTool operates at the voice payload level and does not have
      // a channel context parameter. When the runtime invokes voice tools on a
      // chat channel, the tool registry should gate them. We verify that the
      // tool definition is correctly scoped to voice.
      const tool = new CallTransferTool();
      const def = tool.toToolDefinition();
      expect(def.name).toBe('call_transfer');
      expect(def.description).toContain('voice call');
    });

    it('IVRMenuTool is voice-only by definition', () => {
      const tool = new IVRMenuTool();
      const def = tool.toToolDefinition();
      expect(def.name).toBe('ivr_menu');
      expect(def.description).toContain('voice caller');
    });

    it('IVRDigitInputTool is voice-only by definition', () => {
      const tool = new IVRDigitInputTool();
      const def = tool.toToolDefinition();
      expect(def.name).toBe('ivr_digit_input');
      expect(def.description).toContain('voice caller');
    });

    it('DeflectToChatTool is voice-only by definition', () => {
      const tool = new DeflectToChatTool();
      const def = tool.toToolDefinition();
      expect(def.name).toBe('deflect_to_chat');
      expect(def.description).toContain('voice call');
    });

    it('voice-only tools should be filtered when channel is chat', () => {
      // Simulates the runtime tool-filtering logic: only expose voice tools
      // when isVoiceChannel is true.
      const voiceTools = [
        new CallTransferTool().toToolDefinition(),
        new IVRMenuTool().toToolDefinition(),
        new IVRDigitInputTool().toToolDefinition(),
        new DeflectToChatTool().toToolDefinition(),
      ];

      const voiceToolNames = new Set(voiceTools.map((t) => t.name));
      const channel = 'chat';

      // On chat channels, voice tools should be excluded
      const filtered = voiceTools.filter(() => isVoiceChannel(channel));
      expect(filtered).toHaveLength(0);

      // On voice channels, all voice tools should be available
      const voiceFiltered = voiceTools.filter(() => isVoiceChannel('voice'));
      expect(voiceFiltered).toHaveLength(4);
      for (const t of voiceFiltered) {
        expect(voiceToolNames.has(t.name)).toBe(true);
      }
    });
  });

  describe('DTMF collection with digit options', () => {
    describe('IVR menu DTMF', () => {
      let tool: IVRMenuTool;

      beforeEach(() => {
        tool = new IVRMenuTool();
      });

      it('builds payload with DTMF collect options', () => {
        const result = tool.execute({
          prompt: 'Press 1 for sales, 2 for support',
          dtmfMappings: [
            { key: '1', nextStep: 'sales', intent: 'sales_inquiry' },
            { key: '2', nextStep: 'support', intent: 'tech_support' },
          ],
          noInputConfig: { timeout: 10, maxRetries: 3, message: 'No input received' },
          noMatchConfig: { maxRetries: 2, message: 'Invalid selection' },
          bargeIn: true,
        });

        expect(result.success).toBe(true);
        expect(result.data).toBeDefined();

        const { payload, voiceResult } = result.data!;

        // Verify KoreVG payload
        expect(payload.isPrompt).toBe(true);
        expect(payload.sendDTMF).toBe(true);
        expect(payload.message).toBe('Press 1 for sales, 2 for support');
        expect(payload.timeout).toBe(10_000); // seconds -> ms
        expect(payload.retries).toBe(3);
        expect(payload.bargeIn).toBe(true);
        expect(payload.isHangUp).toBe(false);

        // Verify VoiceToolResult (gather type)
        expect(voiceResult.type).toBe('gather');
        if (voiceResult.type === 'gather') {
          expect(voiceResult.input).toEqual(['dtmf']);
          expect(voiceResult.dtmfMappings).toEqual({
            '1': { label: 'sales', intent: 'sales_inquiry' },
            '2': { label: 'support', intent: 'tech_support' },
          });
          expect(voiceResult.timeout).toBe(10);
          expect(voiceResult.bargeIn).toBe(true);
          expect(voiceResult.retries).toEqual({
            noInput: 3,
            noMatch: 2,
            noInputPrompt: 'No input received',
            noMatchPrompt: 'Invalid selection',
          });
        }
      });

      it('validates DTMF response against mappings', () => {
        const input = {
          prompt: 'Press 1 or 2',
          dtmfMappings: [
            { key: '1', nextStep: 'billing', intent: 'billing_inquiry' },
            { key: '2', nextStep: 'technical' },
          ],
          noInputConfig: { timeout: 5, maxRetries: 2, message: 'Please try again' },
          noMatchConfig: { maxRetries: 2, message: 'Invalid key' },
        };

        // Matching digit
        const match = tool.validateDTMFResponse(input, '1');
        expect(match.matched).toBe(true);
        expect(match.digit).toBe('1');
        expect(match.mappedIntent).toBe('billing_inquiry');
        expect(match.branch).toBe('match');

        // Non-matching digit
        const noMatch = tool.validateDTMFResponse(input, '9');
        expect(noMatch.matched).toBe(false);
        expect(noMatch.digit).toBe('9');
        expect(noMatch.branch).toBe('noMatch');
      });

      it('rejects empty dtmfMappings', () => {
        const result = tool.execute({
          prompt: 'Press a digit',
          dtmfMappings: [],
          noInputConfig: { timeout: 5, maxRetries: 1, message: 'Try again' },
          noMatchConfig: { maxRetries: 1, message: 'Invalid' },
        });

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe('INVALID_INPUT');
      });
    });

    describe('IVR digit input DTMF', () => {
      let tool: IVRDigitInputTool;

      beforeEach(() => {
        tool = new IVRDigitInputTool();
      });

      it('builds payload with digit collection options', () => {
        const result = tool.execute({
          prompt: 'Enter your 5-digit ZIP code',
          maxDigits: 5,
          endingKeyPress: '#',
          interDigitTimeout: 3000,
          noInputConfig: { timeout: 15, maxRetries: 3, message: 'No input detected' },
          noMatchConfig: { maxRetries: 2, message: 'Invalid ZIP code' },
          language: 'en',
        });

        expect(result.success).toBe(true);
        expect(result.data).toBeDefined();

        const { payload, voiceResult } = result.data!;

        // Verify KoreVG payload
        expect(payload.dtmfCollect).toBe(true);
        expect(payload.dtmfCollectMaxDigits).toBe(6); // maxDigits + 1 for endingKeyPress
        expect(payload.dtmfCollectSubmitDigit).toBe('#');
        expect(payload.dtmfCollectInterDigitTimeoutMS).toBe(3000);
        expect(payload.message).toBe('Enter your 5-digit ZIP code');
        expect(payload.isPrompt).toBe(true);
        expect(payload.language).toBe('en');

        // Verify VoiceToolResult (gather type)
        expect(voiceResult.type).toBe('gather');
        if (voiceResult.type === 'gather') {
          expect(voiceResult.input).toEqual(['dtmf']);
          expect(voiceResult.maxDigits).toBe(5);
          expect(voiceResult.finishOnKey).toBe('#');
          expect(voiceResult.interDigitTimeout).toBe(3000);
          expect(voiceResult.retries).toEqual({
            noInput: 3,
            noMatch: 2,
            noInputPrompt: 'No input detected',
            noMatchPrompt: 'Invalid ZIP code',
          });
        }
      });

      it('applies default maxDigits when not specified', () => {
        const result = tool.execute({
          prompt: 'Enter your account number',
          noInputConfig: { timeout: 10, maxRetries: 2, message: 'No input' },
          noMatchConfig: { maxRetries: 1, message: 'Invalid' },
        });

        expect(result.success).toBe(true);
        if (result.data && result.data.voiceResult.type === 'gather') {
          expect(result.data.voiceResult.maxDigits).toBe(10); // default
        }
      });

      it('rejects invalid maxDigits', () => {
        const result = tool.execute({
          prompt: 'Enter digits',
          maxDigits: 0,
          noInputConfig: { timeout: 5, maxRetries: 1, message: 'Try again' },
          noMatchConfig: { maxRetries: 1, message: 'Invalid' },
        });

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe('INVALID_INPUT');
      });
    });
  });

  describe('call transfer payload construction', () => {
    let tool: CallTransferTool;

    beforeEach(() => {
      tool = new CallTransferTool();
    });

    it('builds SIP transfer payload', () => {
      const result = tool.execute({
        callTransferType: 'sip',
        sipTransferId: 'sip-endpoint-42',
        message: 'Transferring you now',
        language: 'en',
      });

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();

      const { payload, voiceResult } = result.data!;

      // KoreVG payload
      expect(payload.isCallTransfer).toBe(true);
      expect(payload.callTransferConfig).toEqual({
        callTransferType: 'sip',
        phoneNumber: undefined,
        sipTransferId: 'sip-endpoint-42',
      });
      expect(payload.sendDTMF).toBe(true);
      expect(payload.isHangUp).toBe(false);

      // VoiceToolResult
      expect(voiceResult.type).toBe('transfer');
      if (voiceResult.type === 'transfer') {
        expect(voiceResult.transferType).toBe('sip');
        expect(voiceResult.target).toBe('sip-endpoint-42');
      }
    });

    it('builds PSTN transfer payload', () => {
      const result = tool.execute({
        callTransferType: 'pstn',
        phoneNumber: '+14155551234',
      });

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();

      const { voiceResult } = result.data!;
      expect(voiceResult.type).toBe('transfer');
      if (voiceResult.type === 'transfer') {
        expect(voiceResult.transferType).toBe('pstn');
        expect(voiceResult.target).toBe('+14155551234');
      }
    });

    it('rejects PSTN without phone number', () => {
      const result = tool.execute({
        callTransferType: 'pstn',
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('MISSING_PHONE_NUMBER');
    });

    it('rejects SIP without sipTransferId', () => {
      const result = tool.execute({
        callTransferType: 'sip',
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('MISSING_SIP_ID');
    });
  });

  describe('deflect-to-chat from voice', () => {
    let tool: DeflectToChatTool;

    beforeEach(() => {
      tool = new DeflectToChatTool();
    });

    it('deflects to automation branch', () => {
      const result = tool.execute({
        deflectionType: 'automation',
        triggerType: 'automationContext',
        message: 'Switching you to chat',
        language: 'en',
      });

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.data!.deflected).toBe(true);
      expect(result.data!.branch).toBe('DEFLECT_AUTOMATION');

      // VoiceToolResult
      expect(result.data!.voiceResult.type).toBe('deflect');
      if (result.data!.voiceResult.type === 'deflect') {
        expect(result.data!.voiceResult.targetChannel).toBe('automation');
        expect(result.data!.voiceResult.metadata).toEqual({
          branch: 'DEFLECT_AUTOMATION',
          triggerType: 'automationContext',
        });
      }
    });

    it('deflects to agent transfer branch', () => {
      const result = tool.execute({
        deflectionType: 'agentTransfer',
        triggerType: 'userSelection',
      });

      expect(result.success).toBe(true);
      expect(result.data!.branch).toBe('DEFLECT_AGENT_TRANSFER');
    });

    it('builds voice payload with hangup=false', () => {
      const result = tool.execute({
        deflectionType: 'automation',
        message: 'Please continue in chat',
      });

      expect(result.success).toBe(true);
      const { payload } = result.data!;
      expect(payload.isHangUp).toBe(false);
      expect(payload.message).toBe('Please continue in chat');
    });
  });

  describe('buildVoicePayload utility', () => {
    it('fills in defaults for optional fields', () => {
      const payload = buildVoicePayload({
        message: 'Hello',
        isHangUp: false,
      });

      expect(payload.message).toBe('Hello');
      expect(payload.isPrompt).toBe(false);
      expect(payload.sendDTMF).toBe(false);
      expect(payload.dtmfCollect).toBe(false);
      expect(payload.isHangUp).toBe(false);
      expect(payload.timeout).toBeUndefined();
      expect(payload.retries).toBeUndefined();
      expect(payload.bargeIn).toBeUndefined();
    });

    it('preserves explicit values', () => {
      const payload = buildVoicePayload({
        message: 'Please wait',
        isHangUp: false,
        isPrompt: true,
        sendDTMF: true,
        dtmfCollect: true,
        timeout: 5000,
        retries: 3,
        bargeIn: true,
        enableSpeechInput: true,
        dtmfCollectMaxDigits: 4,
        dtmfCollectSubmitDigit: '#',
        dtmfCollectInterDigitTimeoutMS: 2000,
        language: 'es',
      });

      expect(payload.isPrompt).toBe(true);
      expect(payload.sendDTMF).toBe(true);
      expect(payload.dtmfCollect).toBe(true);
      expect(payload.timeout).toBe(5000);
      expect(payload.retries).toBe(3);
      expect(payload.bargeIn).toBe(true);
      expect(payload.enableSpeechInput).toBe(true);
      expect(payload.dtmfCollectMaxDigits).toBe(4);
      expect(payload.dtmfCollectSubmitDigit).toBe('#');
      expect(payload.dtmfCollectInterDigitTimeoutMS).toBe(2000);
      expect(payload.language).toBe('es');
    });
  });

  describe('end-to-end: voice transfer with createMockAdapter helper', () => {
    it('mock adapter processes voice transfer and returns waiting', async () => {
      const registry = new AdapterRegistry();
      const adapter = createMockAdapter({
        execute: vi.fn().mockResolvedValue({
          success: true,
          status: 'transferred',
          providerSessionId: 'voice-session-abc',
        }),
      });
      registry.register('kore', adapter);

      const tool = new TransferToAgentTool(registry);
      const result = await tool.execute({ provider: 'kore' }, VOICE_CONTEXT);

      expect(result.success).toBe(true);
      expect(result.status).toBe('waiting');
      expect(result.conversationId).toBe('voice-session-abc');
    });

    it('failed adapter returns error without status override', async () => {
      const registry = new AdapterRegistry();
      const adapter = createMockAdapter({
        execute: vi.fn().mockResolvedValue({
          success: false,
          status: 'no_agents',
          error: { code: 'NO_AGENTS', message: 'No voice agents online' },
        }),
      });
      registry.register('kore', adapter);

      const tool = new TransferToAgentTool(registry);
      const result = await tool.execute({ provider: 'kore' }, VOICE_CONTEXT);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('NO_AGENTS');
    });

    it('adapter exception on voice channel returns TRANSFER_ERROR', async () => {
      const registry = new AdapterRegistry();
      const adapter = createMockAdapter({
        execute: vi.fn().mockRejectedValue(new Error('Voice gateway unreachable')),
      });
      registry.register('kore', adapter);

      const tool = new TransferToAgentTool(registry);
      const result = await tool.execute({ provider: 'kore' }, VOICE_CONTEXT);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('TRANSFER_ERROR');
      expect(result.error?.message).toContain('Voice gateway unreachable');
    });
  });
});
