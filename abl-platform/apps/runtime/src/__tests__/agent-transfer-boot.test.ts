/**
 * Agent Transfer Boot Tests
 *
 * Validates:
 * - Config loading with valid/invalid env vars
 * - Boot initialization sequence (Redis ready -> agent-transfer init)
 * - Shutdown hooks called in correct order
 * - Disabled only when AGENT_TRANSFER_ENABLED explicitly disables the subsystem
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const mockFindProjectSettings = vi.fn();
const mockTransferStoreInstances: Array<Record<string, ReturnType<typeof vi.fn>>> = [];
let capturedStoreHandle: Record<string, (...args: unknown[]) => Promise<unknown>> | null = null;

vi.mock('../repos/project-settings-repo.js', () => ({
  findProjectSettings: (...args: unknown[]) => mockFindProjectSettings(...args),
}));

// Mock the agent-transfer package before importing the config loader
vi.mock('@agent-platform/agent-transfer', () => {
  const { z } = require('zod');

  const AgentTransferConfigSchema = z.object({
    session: z
      .object({
        ttl: z
          .object({
            chat: z.number().default(3600),
            email: z.number().default(86400),
            voice: z.number().default(1800),
            messaging: z.number().default(3600),
            campaign: z.number().default(7200),
            default: z.number().default(3600),
          })
          .default({}),
        maxConcurrentPerContact: z.number().default(3),
        cleanupBatchSize: z.number().default(100),
      })
      .default({}),
    smartassist: z
      .object({
        baseUrl: z.string(),
        apiKey: z.string(),
        timeoutMs: z.number().default(5000),
        appId: z.string().optional(),
        orgId: z.string().optional(),
        accountId: z.string().optional(),
        koreAccountId: z.string().optional(),
        botSIPURI: z.string().optional(),
        ablWebhookBaseUrl: z.string().optional(),
        circuitBreaker: z
          .object({
            failureThreshold: z.number().default(5),
            resetTimeoutMs: z.number().default(30000),
            halfOpenMax: z.number().default(3),
          })
          .default({}),
        retry: z
          .object({
            maxAttempts: z.number().default(2),
            backoffMs: z.number().default(500),
            backoffMultiplier: z.number().default(2),
          })
          .default({}),
      })
      .optional(),
    providers: z.array(z.any()).default([]),
    voice: z
      .object({
        type: z.enum(['audiocodes', 'korevg', 'jambonz']).default('audiocodes'),
        sipDefaults: z
          .object({
            transferMethod: z.enum(['invite', 'refer', 'bye']).default('refer'),
            headerPassthrough: z.boolean().default(true),
          })
          .default({}),
        recording: z
          .object({
            enabled: z.boolean().default(false),
            orgLevelCheck: z.boolean().default(false),
          })
          .default({}),
      })
      .default({}),
    identity: z
      .object({
        mapAgentIdToBotId: z.boolean().default(false),
        mapContactIdToUserId: z.boolean().default(false),
      })
      .default({}),
    pii: z
      .object({
        deTokenizeBeforeTransfer: z.boolean().default(false),
        detectionPattern: z.string().default(''),
      })
      .default({}),
    analytics: z
      .object({
        emitTraceEvents: z.boolean().default(true),
        trackContainment: z.boolean().default(true),
        trackDialogTone: z.boolean().default(false),
      })
      .default({}),
  });

  class MockTransferSessionStore {
    constructor() {
      mockTransferStoreInstances.push(this as unknown as Record<string, ReturnType<typeof vi.fn>>);
    }
    create = vi.fn();
    get = vi.fn();
    update = vi.fn();
    end = vi.fn().mockResolvedValue(true);
    extendTTL = vi.fn().mockResolvedValue(true);
    getByProvider = vi.fn().mockResolvedValue(null);
    getActiveSessions = vi.fn().mockResolvedValue([]);
  }

  class MockAdapterRegistry {
    private readonly adapters = new Map<string, unknown>();

    register = vi.fn((name: string, adapter: unknown) => {
      this.adapters.set(name, adapter);
    });
    get = vi.fn((name: string) => this.adapters.get(name));
    getOrThrow = vi.fn((name: string) => {
      const adapter = this.adapters.get(name);
      if (!adapter) {
        throw new Error(`Adapter not found: ${name}`);
      }
      return adapter;
    });
    has = vi.fn((name: string) => this.adapters.has(name));
    listNames = vi.fn(() => Array.from(this.adapters.keys()));
    unregister = vi.fn((name: string) => this.adapters.delete(name));
    invalidateAuth = vi.fn();
  }

  class MockTenantScopedSessionEncryptor {
    constructor(_deps?: unknown) {}
  }

  class MockKoreAdapter {
    name = 'kore';
    capabilities = {};
    constructor(_smartAssistConfig?: unknown, sessionStore?: unknown) {
      if (sessionStore && typeof sessionStore === 'object') {
        capturedStoreHandle = sessionStore as Record<
          string,
          (...args: unknown[]) => Promise<unknown>
        >;
      }
    }
    initialize = vi.fn().mockResolvedValue(undefined);
    execute = vi.fn();
    sendUserMessage = vi.fn();
    endSession = vi.fn();
    onAgentMessage = vi.fn();
    onSessionEvent = vi.fn();
    checkHealth = vi.fn().mockResolvedValue(true);
    handleInboundEvent = vi.fn();
    getSmartAssistClient = vi.fn().mockReturnValue(null);
    submitCsatRating = vi.fn().mockResolvedValue({ success: true });
    close = vi.fn().mockResolvedValue(undefined);
  }

  class MockSessionRecoveryService {
    start = vi.fn().mockResolvedValue(undefined);
    stop = vi.fn().mockResolvedValue(undefined);
    getStats = vi.fn().mockReturnValue({
      scansCompleted: 0,
      sessionsRecovered: 0,
      claimsFailed: 0,
      lastScanAt: null,
    });
    getIsLeader = vi.fn().mockReturnValue(false);
  }

  class MockFive9Adapter {
    name = 'five9';
    capabilities = {};
    constructor(_credentials?: unknown, sessionStore?: unknown) {
      if (sessionStore && typeof sessionStore === 'object') {
        capturedStoreHandle = sessionStore as Record<
          string,
          (...args: unknown[]) => Promise<unknown>
        >;
      }
    }
    initialize = vi.fn().mockResolvedValue(undefined);
    execute = vi.fn();
    sendUserMessage = vi.fn();
    endSession = vi.fn();
    onAgentMessage = vi.fn();
    onSessionEvent = vi.fn();
    checkHealth = vi.fn().mockResolvedValue(true);
    handleInboundEvent = vi.fn();
    close = vi.fn().mockResolvedValue(undefined);
  }

  class MockCsatHandler {
    constructor(_sessionStore?: unknown) {}
    handleAgentClosed = vi.fn().mockResolvedValue(undefined);
    completeCsat = vi.fn().mockResolvedValue(undefined);
    skipCsat = vi.fn().mockResolvedValue(undefined);
  }

  return {
    AgentTransferConfigSchema,
    CHANNEL_TTL_DEFAULTS: {
      chat: 1800,
      email: 86400,
      voice: 0,
      messaging: 1800,
      campaign: 3600,
      default: 1800,
    },
    TransferSessionStore: MockTransferSessionStore,
    AdapterRegistry: MockAdapterRegistry,
    KoreAdapter: MockKoreAdapter,
    Five9Adapter: MockFive9Adapter,
    SessionRecoveryService: MockSessionRecoveryService,
    createTraceStoreAdapter: vi.fn(() => ({ emit: vi.fn() })),
    TenantScopedSessionEncryptor: MockTenantScopedSessionEncryptor,
    CsatHandler: MockCsatHandler,
    normalizeTransferChannel: (channel: string) => channel,
    resolveTransferSessionOwnerId: (session: { ownerId?: string; contactId?: string }) =>
      session.ownerId ?? session.contactId ?? '',
    sessionKey: (tenantId: string, contactId: string, channel: string) =>
      `agent_transfer:${tenantId}:${contactId}:${channel}`,
    ACTIVE_SESSIONS_SET: 'at_active_sessions',
  };
});

vi.mock('@agent-platform/shared/encryption', () => ({
  isTenantEncryptionReady: () => true,
  encryptForTenantAuto: async (plaintext: string) => plaintext,
  decryptForTenantAuto: async (ciphertext: string) => ciphertext,
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

function createRedisSubscriberStub() {
  return {
    subscribe: vi.fn().mockResolvedValue(1),
    unsubscribe: vi.fn().mockResolvedValue(0),
    psubscribe: vi.fn().mockResolvedValue(1),
    punsubscribe: vi.fn().mockResolvedValue(0),
    on: vi.fn(),
    disconnect: vi.fn(),
  };
}

function createMockRedis() {
  return {
    duplicate: vi.fn(() => createRedisSubscriberStub()),
    config: vi.fn().mockResolvedValue('OK'),
    srem: vi.fn().mockResolvedValue(1),
    publish: vi.fn().mockResolvedValue(1),
  };
}

// =============================================================================
// CONFIG LOADING
// =============================================================================

describe('loadAgentTransferConfig', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('treats an unset AGENT_TRANSFER_ENABLED as enabled by default', async () => {
    delete process.env.AGENT_TRANSFER_ENABLED;
    const { isAgentTransferEnabled, loadAgentTransferConfig } =
      await import('../config/agent-transfer.js');
    const config = loadAgentTransferConfig();

    expect(isAgentTransferEnabled()).toBe(true);
    expect(config).not.toBeNull();
  });

  it('returns null when AGENT_TRANSFER_ENABLED is "false"', async () => {
    process.env.AGENT_TRANSFER_ENABLED = 'false';
    const { isAgentTransferEnabled, loadAgentTransferConfig } =
      await import('../config/agent-transfer.js');
    expect(isAgentTransferEnabled()).toBe(false);
    expect(loadAgentTransferConfig()).toBeNull();
  });

  it('returns valid config with defaults when enabled', async () => {
    process.env.AGENT_TRANSFER_ENABLED = 'true';
    const { loadAgentTransferConfig } = await import('../config/agent-transfer.js');
    const config = loadAgentTransferConfig();

    expect(config).not.toBeNull();
    expect(config!.session.ttl.chat).toBe(3600);
    expect(config!.smartassist).toBeUndefined();
  });

  it('parses SmartAssist config from env vars', async () => {
    process.env.AGENT_TRANSFER_ENABLED = 'true';
    process.env.SMARTASSIST_API_URL = 'https://smartassist.example.com';
    process.env.SMARTASSIST_API_KEY = 'test-key-123';
    process.env.SMARTASSIST_TIMEOUT_MS = '10000';

    const { loadAgentTransferConfig } = await import('../config/agent-transfer.js');
    const config = loadAgentTransferConfig();

    expect(config!.smartassist).toBeDefined();
    expect(config!.smartassist!.baseUrl).toBe('https://smartassist.example.com');
    expect(config!.smartassist!.apiKey).toBe('test-key-123');
    expect(config!.smartassist!.timeoutMs).toBe(10000);
  });

  it('parses extended SmartAssist voice settings from env vars', async () => {
    process.env.AGENT_TRANSFER_ENABLED = 'true';
    process.env.SMARTASSIST_API_URL = 'https://smartassist.example.com';
    process.env.SMARTASSIST_API_KEY = 'test-key-123';
    process.env.SMARTASSIST_APP_ID = 'bot-1';
    process.env.SMARTASSIST_ORG_ID = 'org-1';
    process.env.SMARTASSIST_ACCOUNT_ID = 'acct-1';
    process.env.SMARTASSIST_BOT_SIP_URI = 'sip:bot@example.com';

    const { loadAgentTransferConfig } = await import('../config/agent-transfer.js');
    const config = loadAgentTransferConfig();

    expect(config!.smartassist).toMatchObject({
      appId: 'bot-1',
      orgId: 'org-1',
      accountId: 'acct-1',
      koreAccountId: 'acct-1',
      botSIPURI: 'sip:bot@example.com',
    });
  });

  it('parses session TTL overrides from env vars', async () => {
    process.env.AGENT_TRANSFER_ENABLED = 'true';
    process.env.TRANSFER_SESSION_TTL_CHAT = '7200';
    process.env.TRANSFER_SESSION_TTL_VOICE = '900';

    const { loadAgentTransferConfig } = await import('../config/agent-transfer.js');
    const config = loadAgentTransferConfig();

    expect(config!.session.ttl.chat).toBe(7200);
    expect(config!.session.ttl.voice).toBe(900);
  });

  it('parses voice gateway type from env var', async () => {
    process.env.AGENT_TRANSFER_ENABLED = 'true';
    process.env.VOICE_GATEWAY_TYPE = 'jambonz';

    const { loadAgentTransferConfig } = await import('../config/agent-transfer.js');
    const config = loadAgentTransferConfig();

    expect(config!.voice.type).toBe('jambonz');
  });

  it('does not include SmartAssist when only URL is set (no key)', async () => {
    process.env.AGENT_TRANSFER_ENABLED = 'true';
    process.env.SMARTASSIST_API_URL = 'https://smartassist.example.com';

    const { loadAgentTransferConfig } = await import('../config/agent-transfer.js');
    const config = loadAgentTransferConfig();

    expect(config!.smartassist).toBeUndefined();
  });
});

// =============================================================================
// BOOT INITIALIZATION
// =============================================================================

describe('initializeAgentTransfer', () => {
  let mockRedis: ReturnType<typeof createMockRedis>;

  beforeEach(() => {
    vi.resetModules();
    mockFindProjectSettings.mockReset();
    mockTransferStoreInstances.length = 0;
    capturedStoreHandle = null;
    mockRedis = createMockRedis();
  });

  it('initializes all components with valid config', async () => {
    const {
      initializeAgentTransfer,
      isAgentTransferInitialized,
      getAdapterRegistry,
      getTransferSessionStore,
      getSessionRecoveryService,
    } = await import('../services/agent-transfer/index.js');

    const config = {
      session: {
        ttl: {
          chat: 3600,
          email: 86400,
          voice: 1800,
          messaging: 3600,
          campaign: 7200,
          default: 3600,
        },
        maxConcurrentPerContact: 3,
        cleanupBatchSize: 100,
      },
      smartassist: {
        baseUrl: 'https://sa.example.com',
        apiKey: 'key',
        timeoutMs: 5000,
        circuitBreaker: { failureThreshold: 5, resetTimeoutMs: 30000, halfOpenMax: 3 },
        retry: { maxAttempts: 2, backoffMs: 500, backoffMultiplier: 2 },
      },
      providers: [],
      voice: {
        type: 'audiocodes' as const,
        sipDefaults: { transferMethod: 'refer' as const, headerPassthrough: true },
        recording: { enabled: false, orgLevelCheck: false },
      },
      identity: { mapAgentIdToBotId: false, mapContactIdToUserId: false },
      pii: { deTokenizeBeforeTransfer: false, detectionPattern: '' },
      analytics: { emitTraceEvents: true, trackContainment: true, trackDialogTone: false },
    };

    await initializeAgentTransfer(mockRedis, config);

    expect(isAgentTransferInitialized()).toBe(true);
    expect(getAdapterRegistry()).not.toBeNull();
    expect(getTransferSessionStore()).not.toBeNull();
    expect(getSessionRecoveryService()).not.toBeNull();
  });

  it('skips re-initialization if already initialized', async () => {
    const { initializeAgentTransfer, isAgentTransferInitialized } =
      await import('../services/agent-transfer/index.js');

    const config = {
      session: {
        ttl: {
          chat: 3600,
          email: 86400,
          voice: 1800,
          messaging: 3600,
          campaign: 7200,
          default: 3600,
        },
        maxConcurrentPerContact: 3,
        cleanupBatchSize: 100,
      },
      providers: [],
      voice: {
        type: 'audiocodes' as const,
        sipDefaults: { transferMethod: 'refer' as const, headerPassthrough: true },
        recording: { enabled: false, orgLevelCheck: false },
      },
      identity: { mapAgentIdToBotId: false, mapContactIdToUserId: false },
      pii: { deTokenizeBeforeTransfer: false, detectionPattern: '' },
      analytics: { emitTraceEvents: true, trackContainment: true, trackDialogTone: false },
    };

    await initializeAgentTransfer(mockRedis, config);
    await initializeAgentTransfer(mockRedis, config); // second call should be no-op

    expect(isAgentTransferInitialized()).toBe(true);
  });

  it('injects resolved project transfer TTL into the store create path', async () => {
    const { initializeAgentTransfer } = await import('../services/agent-transfer/index.js');

    mockFindProjectSettings.mockResolvedValue({
      agentTransfer: {
        session: {
          ttl: {
            chat: 900,
          },
        },
      },
    });

    await initializeAgentTransfer(mockRedis, {
      session: {
        ttl: {
          chat: 3600,
          email: 86400,
          voice: 1800,
          messaging: 3600,
          campaign: 7200,
          default: 3600,
        },
        maxConcurrentPerContact: 3,
        cleanupBatchSize: 100,
      },
      providers: [],
      voice: {
        type: 'audiocodes' as const,
        sipDefaults: { transferMethod: 'refer' as const, headerPassthrough: true },
        recording: { enabled: false, orgLevelCheck: false },
      },
      identity: { mapAgentIdToBotId: false, mapContactIdToUserId: false },
      pii: { deTokenizeBeforeTransfer: false, detectionPattern: '' },
      analytics: { emitTraceEvents: true, trackContainment: true, trackDialogTone: false },
    });

    expect(capturedStoreHandle).not.toBeNull();
    await capturedStoreHandle!.create({
      tenantId: 'tenant-1',
      projectId: 'project-1',
      contactId: 'contact-1',
      channel: 'chat',
      provider: 'kore',
      providerSessionId: 'provider-session-1',
      agentId: 'agent-1',
    });

    const [store] = mockTransferStoreInstances;
    expect(store.create).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        projectId: 'project-1',
        channel: 'chat',
        ttl: 900,
      }),
    );
  });

  it('injects resolved project transfer TTL into the store extend path', async () => {
    const { initializeAgentTransfer } = await import('../services/agent-transfer/index.js');

    mockFindProjectSettings.mockResolvedValue({
      agentTransfer: {
        session: {
          ttl: {
            chat: 1200,
          },
        },
      },
    });

    await initializeAgentTransfer(mockRedis, {
      session: {
        ttl: {
          chat: 3600,
          email: 86400,
          voice: 1800,
          messaging: 3600,
          campaign: 7200,
          default: 3600,
        },
        maxConcurrentPerContact: 3,
        cleanupBatchSize: 100,
      },
      providers: [],
      voice: {
        type: 'audiocodes' as const,
        sipDefaults: { transferMethod: 'refer' as const, headerPassthrough: true },
        recording: { enabled: false, orgLevelCheck: false },
      },
      identity: { mapAgentIdToBotId: false, mapContactIdToUserId: false },
      pii: { deTokenizeBeforeTransfer: false, detectionPattern: '' },
      analytics: { emitTraceEvents: true, trackContainment: true, trackDialogTone: false },
    });

    const [store] = mockTransferStoreInstances;
    store.get.mockResolvedValue({
      tenantId: 'tenant-1',
      projectId: 'project-1',
      channel: 'chat',
    });

    await capturedStoreHandle!.extendTTL('agent_transfer:tenant-1:contact-1:chat');

    expect(store.extendTTL).toHaveBeenCalledWith(
      'agent_transfer:tenant-1:contact-1:chat',
      1200,
      'chat',
    );
  });
});

// =============================================================================
// SHUTDOWN
// =============================================================================

describe('shutdownAgentTransfer', () => {
  let mockRedis: ReturnType<typeof createMockRedis>;

  beforeEach(() => {
    vi.resetModules();
    mockRedis = createMockRedis();
  });

  it('cleans up all singletons on shutdown', async () => {
    const {
      initializeAgentTransfer,
      shutdownAgentTransfer,
      isAgentTransferInitialized,
      getAdapterRegistry,
      getTransferSessionStore,
      getSessionRecoveryService,
    } = await import('../services/agent-transfer/index.js');

    const config = {
      session: {
        ttl: {
          chat: 3600,
          email: 86400,
          voice: 1800,
          messaging: 3600,
          campaign: 7200,
          default: 3600,
        },
        maxConcurrentPerContact: 3,
        cleanupBatchSize: 100,
      },
      providers: [],
      voice: {
        type: 'audiocodes' as const,
        sipDefaults: { transferMethod: 'refer' as const, headerPassthrough: true },
        recording: { enabled: false, orgLevelCheck: false },
      },
      identity: { mapAgentIdToBotId: false, mapContactIdToUserId: false },
      pii: { deTokenizeBeforeTransfer: false, detectionPattern: '' },
      analytics: { emitTraceEvents: true, trackContainment: true, trackDialogTone: false },
    };

    await initializeAgentTransfer(mockRedis, config);
    expect(isAgentTransferInitialized()).toBe(true);

    await shutdownAgentTransfer();

    expect(isAgentTransferInitialized()).toBe(false);
    expect(getAdapterRegistry()).toBeNull();
    expect(getTransferSessionStore()).toBeNull();
    expect(getSessionRecoveryService()).toBeNull();
  });

  it('is a no-op when not initialized', async () => {
    const { shutdownAgentTransfer, isAgentTransferInitialized } =
      await import('../services/agent-transfer/index.js');

    await shutdownAgentTransfer(); // should not throw
    expect(isAgentTransferInitialized()).toBe(false);
  });
});
