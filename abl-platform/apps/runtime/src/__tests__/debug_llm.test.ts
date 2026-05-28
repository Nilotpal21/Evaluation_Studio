import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockIsDatabaseAvailable, mockIsEncryptionAvailable, mockDecrypt, mockEnvVarLean } =
  vi.hoisted(() => {
    const mockIsDatabaseAvailable = vi.fn().mockReturnValue(false);
    const mockIsEncryptionAvailable = vi.fn().mockReturnValue(false);
    const mockDecrypt = vi.fn((val: string) => `dec:${val}`);
    const mockEnvVarLean = vi.fn().mockResolvedValue([]);
    return { mockIsDatabaseAvailable, mockIsEncryptionAvailable, mockDecrypt, mockEnvVarLean };
  });

vi.mock('@agent-platform/database/models', () => ({
  EnvironmentVariable: {
    find: (..._args: unknown[]) => {
      const leanFn = mockEnvVarLean;
      const limitFn = vi.fn().mockReturnValue({ lean: leanFn });
      const selectFn = vi.fn().mockReturnValue({ limit: limitFn });
      return { select: selectFn };
    },
  },
}));

vi.mock('../db/index.js', () => ({
  isDatabaseAvailable: () => {
    const result = mockIsDatabaseAvailable();
    return result;
  },
}));
vi.mock('@agent-platform/shared/encryption', () => ({
  isEncryptionAvailable: () => mockIsEncryptionAvailable(),
  isTenantEncryptionReady: () => mockIsEncryptionAvailable(),
  getEncryptionService: () => ({ decryptForTenant: mockDecrypt }),
  decryptForTenantAuto: (val: string, _tid: string) => Promise.resolve(mockDecrypt(val)),
  getEncryptionFacade: () => null,
}));
vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('@abl/compiler', () => ({
  ToolBindingExecutor: vi.fn(),
  loggingMiddleware: vi.fn(() => vi.fn()),
  createAuditMiddleware: vi.fn(() => vi.fn()),
  createSecretScrubberMiddleware: vi.fn(() => vi.fn()),
  createSecretValidationMiddleware: vi.fn(() => vi.fn()),
  GvisorSandboxRunner: vi.fn(),
}));
vi.mock('../services/mcp/inline-mcp-provider.js', () => ({ InlineMcpClientProvider: vi.fn() }));
vi.mock('../services/llm/session-llm-client.js', () => ({ SessionLLMClient: vi.fn() }));
vi.mock('../services/llm/model-resolution.js', () => ({ ModelResolutionService: vi.fn() }));
vi.mock('../services/secrets-provider.js', () => ({ RuntimeSecretsProvider: vi.fn() }));
vi.mock('../services/search-ai/index.js', () => ({
  SearchAIAwareToolExecutor: vi.fn(),
  isSearchAITool: vi.fn(),
}));
vi.mock('../services/resilience/tool-resilience-factory.js', () => ({
  createToolResilienceFactory: vi.fn().mockReturnValue({}),
}));
vi.mock('@agent-platform/shared-kernel/security', () => ({
  getDevSSRFOptions: vi.fn().mockReturnValue({ allowLocalhost: false }),
}));
vi.mock('../services/proxy-config-service.js', () => ({ ProxyConfigService: vi.fn() }));
vi.mock('../services/tool-audit-logger.js', () => ({
  ToolAuditLoggerImpl: vi.fn(),
}));
vi.mock('../services/audit-store-singleton.js', () => ({
  getAuditStore: vi.fn().mockReturnValue(null),
}));
vi.mock('../services/tool-oauth-service-singleton.js', () => ({
  getToolOAuthService: vi.fn().mockReturnValue(null),
}));
vi.mock('../services/mcp/runtime-mcp-provider.js', () => ({
  getRuntimeMcpProvider: vi.fn().mockReturnValue({ hasRegistry: vi.fn().mockReturnValue(false) }),
}));
vi.mock('../config/loader.js', () => ({
  isConfigLoaded: vi.fn().mockReturnValue(false),
  getConfig: vi.fn(),
}));
vi.mock('../repos/llm-resolution-repo.js', () => ({
  isResolutionDatabaseAvailable: vi.fn().mockReturnValue(false),
}));
vi.mock('@agent-platform/shared/repos', () => ({ findOrgProxyConfigs: vi.fn() }));
vi.mock('../services/execution/noop-tool-executor.js', () => ({ NoOpToolExecutor: vi.fn() }));

import { LLMWiringService } from '../services/execution/llm-wiring.js';

describe('debug', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsDatabaseAvailable.mockReturnValue(true);
    mockIsEncryptionAvailable.mockReturnValue(true);
    mockDecrypt.mockImplementation((val: string) => `dec:${val}`);
    mockEnvVarLean.mockResolvedValue([{ key: 'K', encryptedValue: 'E' }]);
  });

  it('loads env vars', async () => {
    console.log('DB avail:', mockIsDatabaseAvailable());
    console.log('Enc avail:', mockIsEncryptionAvailable());
    const svc = new LLMWiringService({});
    const svcAny = svc as any;
    const envStore = svcAny.getOrCreateEnvVarStore();
    const decryptor = svcAny.getOrCreateSecretDecryptor();
    console.log('envStore:', envStore);
    console.log('decryptor:', decryptor);
    const result = await svc.loadEnvironmentVariables('t1', 'p1', 'dev');
    console.log('RESULT:', result);
    expect(result).toEqual({ K: 'dec:E' });
  });
});
