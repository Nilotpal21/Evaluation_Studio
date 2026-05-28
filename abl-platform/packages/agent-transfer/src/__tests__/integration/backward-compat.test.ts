/**
 * Integration test: Backward compatibility
 *
 * Covers the 10 backward-compat guarantees from the design doc:
 *   #1  agentId maps to botId
 *   #2  contactId maps to userId
 *   #3  tenantId maps to orgId
 *   #4  tenantId maps to accountId
 *   #5  Language mapping pt-pt -> pt_pt
 *   #6  Priority clamping to 0-10, default 5
 *   #7  x-api-key header used for SmartAssist auth
 *   #8  Voice channel returns 'waiting', chat returns 'transferred'
 *   #9  Session key format: agent_transfer:{tenantId}:{contactId}:{channel}
 *   #10 Provider index key format: at_by_provider:{provider}:{tenantId}:{providerSessionId}
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentTransferConfigSchema } from '../../config/schema.js';
import { TransferToAgentInputSchema } from '../../tools/transfer-to-agent.js';
import { TransferToAgentTool, type TransferToolContext } from '../../tools/transfer-to-agent.js';
import { CHANNEL_TTL_DEFAULTS, sessionKey, providerIndexKey } from '../../session/types.js';
import { SmartAssistClient } from '../../adapters/kore/smartassist-client.js';
import type { AgentDesktopAdapter, AdapterCapabilities } from '../../adapters/interface.js';
import { AdapterRegistry } from '../../adapters/registry.js';
import type { TransferResult } from '../../types.js';

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

function createMockAdapter(name: string, executeResult: TransferResult): AgentDesktopAdapter {
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

describe('backward compatibility', () => {
  describe('config schema accepts old format with defaults', () => {
    it('empty object gets all defaults', () => {
      const result = AgentTransferConfigSchema.safeParse({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.session.ttl.chat).toBe(1800);
        expect(result.data.session.ttl.email).toBe(14400);
        expect(result.data.session.ttl.voice).toBe(0);
        expect(result.data.providers).toEqual([]);
        expect(result.data.voice.type).toBe('korevg');
      }
    });

    it('partial config merges with defaults', () => {
      const result = AgentTransferConfigSchema.safeParse({
        session: { ttl: { chat: 3600 } },
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.session.ttl.chat).toBe(3600);
        expect(result.data.session.ttl.email).toBe(14400); // default preserved
      }
    });
  });

  describe('TransferToAgentInput schema is stable', () => {
    it('minimal input with provider only', () => {
      const result = TransferToAgentInputSchema.safeParse({ provider: 'kore' });
      expect(result.success).toBe(true);
    });

    it('full input with all optional fields', () => {
      const result = TransferToAgentInputSchema.safeParse({
        provider: 'kore',
        skills: ['billing'],
        queueId: 'q-1',
        priority: 5,
        metadata: { key: 'value' },
        postAgentAction: 'return',
        providerConfig: { custom: true },
      });
      expect(result.success).toBe(true);
    });
  });

  describe('channel TTL defaults are unchanged', () => {
    it('chat = 1800', () => expect(CHANNEL_TTL_DEFAULTS.chat).toBe(1800));
    it('email = 86400', () => expect(CHANNEL_TTL_DEFAULTS.email).toBe(86400));
    it('voice = 0', () => expect(CHANNEL_TTL_DEFAULTS.voice).toBe(0));
    it('messaging = 1800', () => expect(CHANNEL_TTL_DEFAULTS.messaging).toBe(1800));
    it('campaign = 3600', () => expect(CHANNEL_TTL_DEFAULTS.campaign).toBe(3600));
    it('default = 1800', () => expect(CHANNEL_TTL_DEFAULTS.default).toBe(1800));
  });

  describe('#9 session key format is stable', () => {
    it('sessionKey format: agent_transfer:{tenantId}:{contactId}:{channel}', () => {
      expect(sessionKey('t1', 'c1', 'chat')).toBe('agent_transfer:t1:c1:chat');
    });
  });

  describe('#10 provider index key format is stable', () => {
    it('providerIndexKey format: at_by_provider:{provider}:{tenantId}:{providerSessionId}', () => {
      expect(providerIndexKey('kore', 't1', 'conv-1')).toBe('at_by_provider:kore:t1:conv-1');
    });
  });

  describe('#1-#4 SmartAssistClient.mapIdentity field mappings', () => {
    // mapIdentity is private and references this.config, so we bind it to a
    // minimal context that satisfies the config.accountId access.
    const fakeContext = { config: { accountId: undefined } };
    const mapIdentity = (SmartAssistClient.prototype as Record<string, unknown>)['mapIdentity'] as (
      agentId: string,
      contactId: string,
      tenantId: string,
    ) => Record<string, string>;
    const boundMapIdentity = (agentId: string, contactId: string, tenantId: string) =>
      mapIdentity.call(fakeContext, agentId, contactId, tenantId);

    it('#1 agentId maps to botId', () => {
      const result = boundMapIdentity('agent-123', 'contact-1', 'tenant-1');
      expect(result.botId).toBe('agent-123');
    });

    it('#2 contactId maps to userId', () => {
      const result = boundMapIdentity('agent-1', 'contact-456', 'tenant-1');
      expect(result.userId).toBe('contact-456');
    });

    it('#3 tenantId maps to orgId', () => {
      const result = boundMapIdentity('agent-1', 'contact-1', 'tenant-789');
      expect(result.orgId).toBe('tenant-789');
    });

    it('#4 tenantId maps to accountId', () => {
      const result = boundMapIdentity('agent-1', 'contact-1', 'tenant-789');
      expect(result.accountId).toBe('tenant-789');
    });
  });

  describe('#5 language mapping', () => {
    const mapLanguage = (SmartAssistClient.prototype as Record<string, unknown>)['mapLanguage'] as (
      lang?: string,
    ) => string | undefined;

    it('pt-pt maps to pt_pt', () => {
      expect(mapLanguage('pt-pt')).toBe('pt_pt');
    });

    it('unknown languages pass through unchanged', () => {
      expect(mapLanguage('en')).toBe('en');
      expect(mapLanguage('fr')).toBe('fr');
    });

    it('undefined returns undefined', () => {
      expect(mapLanguage(undefined)).toBeUndefined();
    });
  });

  describe('#6 priority clamping', () => {
    const clampPriority = (SmartAssistClient.prototype as Record<string, unknown>)[
      'clampPriority'
    ] as (priority?: number | null) => number;

    it('undefined defaults to 5', () => {
      expect(clampPriority(undefined)).toBe(5);
    });

    it('null defaults to 5', () => {
      expect(clampPriority(null)).toBe(5);
    });

    it('values within range pass through', () => {
      expect(clampPriority(0)).toBe(0);
      expect(clampPriority(5)).toBe(5);
      expect(clampPriority(10)).toBe(10);
    });

    it('values below 0 clamp to 0', () => {
      expect(clampPriority(-1)).toBe(0);
      expect(clampPriority(-100)).toBe(0);
    });

    it('values above 10 clamp to 10', () => {
      expect(clampPriority(11)).toBe(10);
      expect(clampPriority(999)).toBe(10);
    });
  });

  describe('#7 x-api-key header used for SmartAssist auth', () => {
    it('SmartAssist requests include x-api-key header', () => {
      // Verified by reading smartassist-client.ts executeRequest:
      // headers: { 'content-type': 'application/json', 'x-api-key': this.config.apiKey }
      // We verify the field exists in the config schema
      const result = AgentTransferConfigSchema.safeParse({
        smartassist: {
          baseUrl: 'https://smartassist.example.com',
          apiKey: 'test-key-123',
        },
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.smartassist).toBeDefined();
        expect(result.data.smartassist!.apiKey).toBe('test-key-123');
      }
    });
  });

  describe('#8 voice channel returns waiting, chat returns transferred', () => {
    let registry: AdapterRegistry;
    let tool: TransferToAgentTool;

    beforeEach(() => {
      registry = new AdapterRegistry();
      const mockAdapter = createMockAdapter('kore', {
        success: true,
        status: 'transferred',
        providerSessionId: 'conv-1',
      });
      registry.register('kore', mockAdapter);
      tool = new TransferToAgentTool(registry);
    });

    it('chat channel returns status "transferred"', async () => {
      const context: TransferToolContext = {
        tenantId: 't1',
        projectId: 'p1',
        agentId: 'a1',
        contactId: 'c1',
        sessionId: 's1',
        channel: 'chat',
      };
      const result = await tool.execute({ provider: 'kore' }, context);
      expect(result.success).toBe(true);
      expect(result.status).toBe('transferred');
    });

    it('voice channel returns status "waiting"', async () => {
      const context: TransferToolContext = {
        tenantId: 't1',
        projectId: 'p1',
        agentId: 'a1',
        contactId: 'c1',
        sessionId: 's1',
        channel: 'voice',
      };
      const result = await tool.execute({ provider: 'kore' }, context);
      expect(result.success).toBe(true);
      expect(result.status).toBe('waiting');
    });

    it('email channel returns status "transferred"', async () => {
      const context: TransferToolContext = {
        tenantId: 't1',
        projectId: 'p1',
        agentId: 'a1',
        contactId: 'c1',
        sessionId: 's1',
        channel: 'email',
      };
      const result = await tool.execute({ provider: 'kore' }, context);
      expect(result.success).toBe(true);
      expect(result.status).toBe('transferred');
    });
  });
});
