import { describe, it, expect, vi } from 'vitest';

const { mockIsDB } = vi.hoisted(() => {
  const mockIsDB = vi.fn().mockReturnValue(true);
  return { mockIsDB };
});

vi.mock('../db/index.js', () => ({
  isDatabaseAvailable: () => mockIsDB(),
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
vi.mock('@agent-platform/shared/encryption', () => ({
  isEncryptionAvailable: () => true,
  isTenantEncryptionReady: () => true,
  getEncryptionService: () => ({ decryptForTenant: (v: string) => `dec:${v}` }),
  decryptForTenantAuto: (val: string, _tid: string) => Promise.resolve(`dec:${val}`),
  getEncryptionFacade: () => null,
}));
vi.mock('@agent-platform/database/models', () => ({
  EnvironmentVariable: {
    find: (..._args: unknown[]) => ({
      select: () => ({
        limit: () => ({
          lean: () => Promise.resolve([{ key: 'K', encryptedValue: 'E' }]),
        }),
      }),
    }),
  },
}));

import { LLMWiringService } from '../services/execution/llm-wiring.js';

describe('debug2', () => {
  it('loads env vars', async () => {
    const svc = new LLMWiringService({});
    const svcAny = svc as any;
    const store = svcAny.getOrCreateEnvVarStore();
    console.log('store:', store);
    console.log('isDB:', mockIsDB());
    const result = await svc.loadEnvironmentVariables('t1', 'p1', 'dev');
    console.log('RESULT:', result);
    expect(result).toEqual({ K: 'dec:E' });
  });
});
