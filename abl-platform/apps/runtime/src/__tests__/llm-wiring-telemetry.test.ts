/**
 * UT-5 — LLM Wiring Telemetry: workflowTools count in session log
 *
 * Verifies that wireToolExecutor includes `workflowTools` in the telemetry
 * log emitted at the end of tool wiring.
 *
 * Uses the same mock infrastructure as llm-wiring.test.ts since LLMWiringService
 * has deep coupling to many platform singletons. The focus here is on the log
 * payload shape, not on the internal wiring logic.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// =============================================================================
// HOISTED MOCK FACTORIES
// =============================================================================

const {
  mockGetAuditStore,
  mockGetToolOAuthService,
  mockGetRuntimeMcpProvider,
  mockGetConfig,
  mockIsSearchAITool,
  mockIsTransferTool,
  MockToolBindingExecutorClass,
  MockTransferToolExecutorClass,
  mockLogInfo,
} = vi.hoisted(() => {
  const mockGetAuditStore = vi.fn().mockReturnValue(null);
  const mockGetToolOAuthService = vi.fn().mockReturnValue(null);
  const mockIsSearchAITool = vi.fn().mockReturnValue(false);
  const mockIsTransferTool = vi.fn().mockReturnValue(false);
  const mockGetConfig = vi.fn().mockReturnValue({
    llmCache: { resolutionCooldownSeconds: 30 },
    sandbox: null,
  });
  const mockLogInfo = vi.fn();

  class MockToolBindingExecutorClass {
    static instances: { opts: unknown; instance: unknown }[] = [];
    setProxyResolver = vi.fn();
    execute = vi.fn().mockResolvedValue({ success: true, executor: 'base' });
    executeParallel = vi
      .fn()
      .mockImplementation(async (calls: Array<{ name: string; params: Record<string, unknown> }>) =>
        calls.map((call) => ({
          name: call.name,
          result: { success: true, executor: 'base' },
        })),
      );
    constructor(opts: unknown) {
      MockToolBindingExecutorClass.instances.push({ opts, instance: this });
    }
  }

  class MockTransferToolExecutorClass {
    static instances: { opts: unknown; instance: unknown }[] = [];
    execute = vi.fn().mockResolvedValue({ success: true, executor: 'transfer' });
    executeParallel = vi
      .fn()
      .mockImplementation(async (calls: Array<{ name: string; params: Record<string, unknown> }>) =>
        calls.map((call) => ({
          name: call.name,
          result: { success: true, executor: 'transfer' },
        })),
      );
    constructor(opts: unknown) {
      MockTransferToolExecutorClass.instances.push({ opts, instance: this });
    }
  }

  const mockGetRuntimeMcpProvider = vi.fn().mockReturnValue({
    hasRegistry: vi.fn().mockReturnValue(false),
  });

  return {
    mockGetAuditStore,
    mockGetToolOAuthService,
    mockGetRuntimeMcpProvider,
    mockGetConfig,
    mockIsSearchAITool,
    mockIsTransferTool,
    MockToolBindingExecutorClass,
    MockTransferToolExecutorClass,
    mockLogInfo,
  };
});

// =============================================================================
// MODULE MOCKS — mirrors llm-wiring.test.ts pattern
// =============================================================================

vi.mock('@abl/compiler/platform', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: mockLogInfo,
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

vi.mock('@abl/compiler', () => ({
  ToolBindingExecutor: MockToolBindingExecutorClass,
  loggingMiddleware: vi.fn(() => vi.fn()),
  createAuditMiddleware: vi.fn(() => vi.fn()),
  createSecretScrubberMiddleware: vi.fn(() => vi.fn()),
  createSecretValidationMiddleware: vi.fn(() => vi.fn()),
  createSandboxRunner: vi.fn(),
  createIdentityTierGateMiddleware: vi.fn(() => vi.fn()),
  GvisorSandboxRunner: vi.fn(),
}));

vi.mock('../services/mcp/inline-mcp-provider.js', () => ({
  InlineMcpClientProvider: vi.fn(),
}));

vi.mock('../services/llm/session-llm-client.js', () => ({
  SessionLLMClient: vi.fn(() => ({ _isLLMClient: true })),
}));

vi.mock('../services/llm/model-resolution.js', () => ({
  ModelResolutionService: vi.fn(),
}));

vi.mock('../services/secrets-provider.js', () => ({
  RuntimeSecretsProvider: vi.fn(),
}));

vi.mock('../services/search-ai/index.js', () => ({
  SearchAIAwareToolExecutor: vi.fn(),
  isSearchAITool: (...args: unknown[]) => mockIsSearchAITool(...args),
}));

vi.mock('../services/resilience/tool-resilience-factory.js', () => ({
  createToolResilienceFactory: vi.fn().mockReturnValue({}),
}));

vi.mock('@agent-platform/shared-kernel/security', () => ({
  getDevSSRFOptions: vi.fn().mockReturnValue({ allowLocalhost: false }),
}));

vi.mock('../services/proxy-config-service.js', () => ({
  ProxyConfigService: vi.fn().mockImplementation(() => ({
    getResolver: vi.fn().mockResolvedValue(null),
  })),
}));

vi.mock('../services/tool-audit-logger.js', () => ({
  ToolAuditLoggerImpl: vi.fn(),
}));

vi.mock('../services/audit-store-singleton.js', () => ({
  getAuditStore: (...args: unknown[]) => mockGetAuditStore(...args),
}));

vi.mock('@agent-platform/shared/encryption', () => ({
  getEncryptionService: () => ({ decryptForTenant: vi.fn() }),
  isEncryptionAvailable: vi.fn().mockReturnValue(false),
  isTenantEncryptionReady: vi.fn().mockReturnValue(false),
  decryptForTenantAuto: vi.fn(),
}));

vi.mock('../db/index.js', () => ({
  isDatabaseAvailable: vi.fn().mockReturnValue(false),
}));

vi.mock('../services/tool-oauth-service-singleton.js', () => ({
  getToolOAuthService: (...args: unknown[]) => mockGetToolOAuthService(...args),
}));

vi.mock('../services/mcp/runtime-mcp-provider.js', () => ({
  getRuntimeMcpProvider: (...args: unknown[]) => mockGetRuntimeMcpProvider(...args),
}));

vi.mock('../services/auth-profile/auth-profile-tool-middleware.js', () => ({
  createAuthProfileToolMiddleware: vi.fn(() => vi.fn()),
}));

vi.mock('../config/loader.js', () => ({
  isConfigLoaded: vi.fn().mockReturnValue(false),
  getConfig: (...args: unknown[]) => mockGetConfig(...args),
}));

vi.mock('@agent-platform/database/models', () => ({
  EnvironmentVariable: {
    find: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        limit: vi.fn().mockReturnValue({
          lean: vi.fn().mockResolvedValue([]),
        }),
      }),
    }),
  },
}));

vi.mock('../repos/llm-resolution-repo.js', () => ({
  isResolutionDatabaseAvailable: vi.fn().mockReturnValue(false),
}));

vi.mock('@agent-platform/shared/repos', () => ({
  findOrgProxyConfigs: vi.fn().mockResolvedValue([]),
}));

vi.mock('../services/execution/noop-tool-executor.js', () => ({
  NoOpToolExecutor: vi.fn(),
}));

vi.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: vi.fn().mockImplementation(function (this: any) {
    this.send = vi.fn();
  }),
  CreateFunctionCommand: vi.fn(),
  DeleteFunctionCommand: vi.fn(),
  GetFunctionCommand: vi.fn(),
  InvokeCommand: vi.fn(),
  Runtime: { nodejs20x: 'nodejs20.x', python312: 'python3.12' },
}));

vi.mock('../services/execution/tool-jsonl-trace.js', () => ({
  createToolJsonlTraceMiddleware: vi.fn(() => vi.fn()),
}));

vi.mock('../services/execution/tool-memory-bridge.js', () => ({
  createToolMemoryBridge: vi.fn(),
}));

vi.mock('../services/execution/memory-bridge-registry.js', () => ({
  getMemoryBridgeRegistry: vi.fn().mockReturnValue({
    register: vi.fn(),
  }),
}));

vi.mock('../services/llm/model-resolution-versioning.js', () => ({
  buildReasoningSettingsCacheKey: vi.fn().mockReturnValue('cache-key'),
}));

vi.mock('@agent-platform/shared/services/lambda', () => ({
  RedisLambdaDeploymentStore: vi.fn(),
}));

vi.mock('../services/redis/redis-client.js', () => ({
  getRedisClient: vi.fn().mockReturnValue(null),
}));

vi.mock('../services/search-ai/searchai-kb-tool-executor.js', () => ({
  SearchAIKBToolExecutor: vi.fn(),
}));

vi.mock('../services/execution/transfer-tool-executor.js', () => ({
  isTransferTool: (...args: unknown[]) => mockIsTransferTool(...args),
  TransferToolExecutor: MockTransferToolExecutorClass,
}));

vi.mock('../services/agent-transfer/index.js', () => ({
  isAgentTransferInitialized: vi.fn().mockReturnValue(false),
  getAdapterRegistry: vi.fn(),
  getSmartAssistClient: vi.fn(),
  getTransferTraceEmitter: vi.fn(),
}));

vi.mock('../../tools/attachment-tool-executor.js', () => ({
  isAttachmentTool: vi.fn().mockReturnValue(false),
  AttachmentToolExecutor: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('../../tools/load-project-tools-as-ir.js', () => ({
  enrichSearchAIParamDescriptions: vi.fn(),
}));

vi.mock('../../attachments/multimodal-service-client.js', () => ({
  MultimodalServiceClient: vi.fn().mockImplementation(() => ({})),
}));

// =============================================================================
// IMPORT MODULE UNDER TEST
// =============================================================================

import { LLMWiringService } from '../services/execution/llm-wiring.js';

// =============================================================================
// HELPERS
// =============================================================================

function makeSession(overrides: Record<string, unknown> = {}): any {
  return {
    id: 'session-telemetry-1',
    agentName: 'test-agent',
    agentIR: null,
    compilationOutput: null,
    conversationHistory: [],
    state: { gatherProgress: {}, conversationPhase: 'start', context: {} },
    data: { values: {}, gatheredKeys: new Set() },
    isComplete: false,
    isEscalated: false,
    handoffStack: [],
    threads: [],
    activeThreadIndex: 0,
    threadStack: [],
    initialized: false,
    storeVersion: 0,
    createdAt: new Date(),
    lastActivityAt: new Date(),
    ...overrides,
  };
}

function makeAgentIR(name = 'agent1'): any {
  return {
    metadata: { name },
    execution: { mode: 'conversational' },
    tools: [],
  };
}

function makeTool(name: string, toolType = 'http'): any {
  return { name, tool_type: toolType, description: `Tool ${name}` };
}

function makeCompilationOutput(tools: any[]): any {
  return {
    agents: {
      agent1: { ...makeAgentIR(), tools },
    },
  };
}

// =============================================================================
// TESTS
// =============================================================================

describe('UT-5: LLM Wiring Telemetry — workflowTools count', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    MockToolBindingExecutorClass.instances = [];
    MockTransferToolExecutorClass.instances = [];
    mockIsTransferTool.mockReturnValue(false);
    mockGetConfig.mockReturnValue({
      llmCache: { resolutionCooldownSeconds: 30 },
      sandbox: null,
    });
    mockGetRuntimeMcpProvider.mockReturnValue({
      hasRegistry: vi.fn().mockReturnValue(false),
    });
  });

  it('emits workflowTools count of 0 when no workflow tools', () => {
    const service = new LLMWiringService({});
    const session = makeSession();
    const compilationOutput = makeCompilationOutput([
      makeTool('http_tool', 'http'),
      makeTool('sandbox_tool', 'sandbox'),
    ]);

    service.wireToolExecutor(session, compilationOutput, 'tok-1', 'tenant-1');

    const infoCall = mockLogInfo.mock.calls.find(
      (c: unknown[]) => c[0] === 'ToolBindingExecutor wired for session',
    );
    expect(infoCall).toBeDefined();
    expect(infoCall![1]).toHaveProperty('workflowTools', 0);
  });

  it('emits correct workflowTools count when workflow tools present', () => {
    const service = new LLMWiringService({});
    const session = makeSession();
    const compilationOutput = makeCompilationOutput([
      makeTool('http_tool', 'http'),
      makeTool('workflow_a', 'workflow'),
      makeTool('workflow_b', 'workflow'),
    ]);

    service.wireToolExecutor(session, compilationOutput, 'tok-1', 'tenant-1', 'proj-1');

    const infoCall = mockLogInfo.mock.calls.find(
      (c: unknown[]) => c[0] === 'ToolBindingExecutor wired for session',
    );
    expect(infoCall).toBeDefined();
    expect(infoCall![1]).toHaveProperty('workflowTools', 2);
  });

  it('includes workflowTools alongside other tool counts', () => {
    const service = new LLMWiringService({});
    const session = makeSession();
    const compilationOutput = makeCompilationOutput([
      makeTool('h1', 'http'),
      makeTool('h2', 'http'),
      makeTool('wf1', 'workflow'),
    ]);

    service.wireToolExecutor(session, compilationOutput, 'tok-1', 'tenant-1', 'proj-1');

    const infoCall = mockLogInfo.mock.calls.find(
      (c: unknown[]) => c[0] === 'ToolBindingExecutor wired for session',
    );
    expect(infoCall).toBeDefined();
    const meta = infoCall![1] as Record<string, unknown>;
    expect(meta.httpTools).toBe(2);
    expect(meta.workflowTools).toBe(1);
    expect(meta).toHaveProperty('totalTools');
    expect(meta).toHaveProperty('mcpTools');
    expect(meta).toHaveProperty('sandboxTools');
    expect(meta).toHaveProperty('middlewareCount');
  });

  it('routes transfer tools through TransferToolExecutor before the generic executor', async () => {
    mockIsTransferTool.mockImplementation((toolName: string) => toolName === 'transfer_to_agent');
    const service = new LLMWiringService({});
    const session = makeSession();
    const compilationOutput = makeCompilationOutput([
      makeTool('transfer_to_agent', 'http'),
      makeTool('http_tool', 'http'),
    ]);

    service.wireToolExecutor(session, compilationOutput, 'tok-1', 'tenant-1', 'proj-1');

    expect(MockTransferToolExecutorClass.instances).toHaveLength(1);
    const transferExecutor = MockTransferToolExecutorClass.instances[0]!.instance as any;
    const baseExecutor = MockToolBindingExecutorClass.instances[0]!.instance as any;

    await expect(
      session.toolExecutor.execute('transfer_to_agent', { provider: 'kore' }, 30000),
    ).resolves.toEqual({ success: true, executor: 'transfer' });
    await expect(session.toolExecutor.execute('http_tool', { id: '1' }, 30000)).resolves.toEqual({
      success: true,
      executor: 'base',
    });

    expect(transferExecutor.execute).toHaveBeenCalledWith(
      'transfer_to_agent',
      { provider: 'kore' },
      30000,
    );
    expect(baseExecutor.execute).toHaveBeenCalledWith('http_tool', { id: '1' }, 30000);
  });
});
