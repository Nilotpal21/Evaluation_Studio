/**
 * Tests for Studio Tool Test Service
 *
 * Covers:
 *   - HTTP tool execution via ToolBindingExecutor
 *   - MCP tool execution with provider setup/teardown
 *   - Sandbox tool execution with shared sandbox-runner factory
 *   - Tool not found error path
 *   - ToolExecutionError structured error capture
 *   - Generic error capture
 *   - Tenant isolation in all repo calls
 *   - HTTP inspection data (request/response) for HTTP tools
 *   - MCP provider setup failure (non-fatal)
 *   - Default timeout fallback
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — @abl/compiler (single consolidated mock)
// ---------------------------------------------------------------------------

const mockExecute = vi.fn();

const MockToolBindingExecutor = vi.fn().mockImplementation(function () {
  return { execute: mockExecute };
});

const mockLoggingMiddleware = vi.fn().mockReturnValue('logging-middleware-stub');
const mockCreateSecretScrubberMiddleware = vi
  .fn()
  .mockReturnValue('secret-scrubber-middleware-stub');
const mockCreateSandboxRunner = vi.fn().mockReturnValue({ runner: 'sandbox-runner-stub' });
const mockResolveConfigVariables = vi.fn(
  (ir: { metadata?: { name?: string }; tools?: unknown[] }, configVars: Record<string, string>) => {
    const errors: string[] = [];
    const used = new Set<string>();
    const pattern = /\{\{config\.(\w+)\}\}/g;

    const walkAndReplace = (value: unknown): unknown => {
      if (typeof value === 'string') {
        return value.replace(pattern, (match, key: string) => {
          if (key in configVars) {
            used.add(key);
            return configVars[key];
          }
          errors.push(
            `Undefined config variable "${key}" referenced in agent "${ir.metadata?.name ?? 'unknown'}"`,
          );
          return match;
        });
      }

      if (Array.isArray(value)) {
        for (let index = 0; index < value.length; index += 1) {
          value[index] = walkAndReplace(value[index]);
        }
        return value;
      }

      if (value && typeof value === 'object') {
        for (const key of Object.keys(value as Record<string, unknown>)) {
          (value as Record<string, unknown>)[key] = walkAndReplace(
            (value as Record<string, unknown>)[key],
          );
        }
      }

      return value;
    };

    for (const tool of ir.tools ?? []) {
      for (const [key, value] of Object.entries(tool as Record<string, unknown>)) {
        if (key === 'auth_profile_ref') {
          continue;
        }
        (tool as Record<string, unknown>)[key] = walkAndReplace(value);
      }
    }

    return { errors, warnings: [], used };
  },
);

const mockRegisterServer = vi.fn();
const mockConnectServer = vi.fn();
const mockGetClient = vi.fn();
const mockDisconnectAll = vi.fn().mockResolvedValue(undefined);

const MockMCPServerManager = vi.fn().mockImplementation(function () {
  return {
    registerServer: mockRegisterServer,
    connectServer: mockConnectServer,
    getClient: mockGetClient,
    disconnectAll: mockDisconnectAll,
  };
});

const mockCreateLogger = vi.fn().mockReturnValue({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
});

vi.mock('@abl/compiler', () => ({
  ToolBindingExecutor: MockToolBindingExecutor,
  loggingMiddleware: (...args: unknown[]) => mockLoggingMiddleware(...args),
  createSecretScrubberMiddleware: (...args: unknown[]) =>
    mockCreateSecretScrubberMiddleware(...args),
  createSandboxRunner: (...args: unknown[]) => mockCreateSandboxRunner(...args),
  resolveConfigVariables: (...args: unknown[]) => mockResolveConfigVariables(...args),
}));

// ---------------------------------------------------------------------------
// Mocks — @abl/compiler/platform
// ---------------------------------------------------------------------------

vi.mock('@abl/compiler/platform', () => ({
  MCPServerManager: MockMCPServerManager,
  createLogger: (...args: unknown[]) => mockCreateLogger(...args),
}));

// ---------------------------------------------------------------------------
// Mocks — @agent-platform/shared
// ---------------------------------------------------------------------------

// Build a real-ish ToolExecutionError class that instanceof checks will match.
class MockToolExecutionError extends Error {
  readonly code: string;
  readonly toolName: string;
  readonly retryable: boolean;
  readonly statusCode?: number;
  readonly cause?: unknown;
  constructor(opts: {
    code: string;
    message: string;
    toolName: string;
    retryable?: boolean;
    statusCode?: number;
    cause?: unknown;
  }) {
    super(opts.message);
    this.name = 'ToolExecutionError';
    this.code = opts.code;
    this.toolName = opts.toolName;
    this.retryable = opts.retryable ?? false;
    this.statusCode = opts.statusCode;
    this.cause = opts.cause;
  }
}

vi.mock('@agent-platform/shared', () => ({
  ToolExecutionError: MockToolExecutionError,
}));

// ---------------------------------------------------------------------------
// Mocks — @agent-platform/shared-kernel/security
// ---------------------------------------------------------------------------

const mockGetDevSSRFOptions = vi.fn().mockReturnValue({
  allowLocalhost: true,
  allowPrivateRanges: true,
});

vi.mock('@agent-platform/shared-kernel/security', () => ({
  getDevSSRFOptions: (...args: unknown[]) => mockGetDevSSRFOptions(...args),
}));

// ---------------------------------------------------------------------------
// Mocks — @agent-platform/shared/repos
// ---------------------------------------------------------------------------

const mockFindProjectToolById = vi.fn();
const mockFindToolSecrets = vi.fn();

vi.mock('@agent-platform/shared/repos', () => ({
  findProjectToolById: (...args: unknown[]) => mockFindProjectToolById(...args),
  findToolSecrets: (...args: unknown[]) => mockFindToolSecrets(...args),
}));

// ---------------------------------------------------------------------------
// Mocks — shared auth profile services
// ---------------------------------------------------------------------------

const mockApplyAuth = vi.fn();
const mockBuildAuthProfileOAuthProviderKey = vi.fn();
const mockRefreshOAuth2Token = vi.fn();
const mockResolveClientCredentialsToken = vi.fn();
const mockResolveWithGracePeriod = vi.fn();
const mockSanitizeAuthProfileError = vi.fn((err: unknown) => {
  const code =
    err && typeof err === 'object' && typeof (err as { code?: unknown }).code === 'string'
      ? (err as { code: string }).code
      : 'AUTH_PROFILE_CREDENTIAL_RESOLUTION_FAILED';
  const userMessage =
    err instanceof Error ? err.message : 'Failed to resolve auth profile credentials.';
  return { code, userMessage };
});

vi.mock('@agent-platform/shared/services/auth-profile', () => ({
  applyAuth: (...args: unknown[]) => mockApplyAuth(...args),
  buildAuthProfileOAuthProviderKey: (...args: unknown[]) =>
    mockBuildAuthProfileOAuthProviderKey(...args),
  refreshOAuth2Token: (...args: unknown[]) => mockRefreshOAuth2Token(...args),
  resolveClientCredentialsToken: (...args: unknown[]) => mockResolveClientCredentialsToken(...args),
  resolveWithGracePeriod: (...args: unknown[]) => mockResolveWithGracePeriod(...args),
  sanitizeAuthProfileError: (...args: unknown[]) => mockSanitizeAuthProfileError(...args),
}));

// ---------------------------------------------------------------------------
// Mocks — database models used by auth/config/env resolution
// ---------------------------------------------------------------------------

function makeQueryResult<T>(value: T) {
  return {
    select: vi.fn().mockReturnThis(),
    lean: vi.fn().mockResolvedValue(value),
  };
}

const mockAuthProfileFindOne = vi.fn();
const mockEndUserOAuthTokenFindOne = vi.fn();
const mockEnvironmentVariableFindOne = vi.fn();
const mockProjectConfigVariableFindOne = vi.fn();
const mockVariableNamespaceFindOne = vi.fn();
const mockVariableNamespaceCreate = vi.fn();
const mockVariableNamespaceMembershipFindOne = vi.fn();

vi.mock('@agent-platform/database/models', () => ({
  AuthProfile: {
    findOne: (...args: unknown[]) => mockAuthProfileFindOne(...args),
  },
  EndUserOAuthToken: {
    findOne: (...args: unknown[]) => mockEndUserOAuthTokenFindOne(...args),
  },
  EnvironmentVariable: {
    findOne: (...args: unknown[]) => mockEnvironmentVariableFindOne(...args),
  },
  ProjectConfigVariable: {
    findOne: (...args: unknown[]) => mockProjectConfigVariableFindOne(...args),
  },
  VariableNamespace: {
    findOne: (...args: unknown[]) => mockVariableNamespaceFindOne(...args),
    create: (...args: unknown[]) => mockVariableNamespaceCreate(...args),
  },
  VariableNamespaceMembership: {
    findOne: (...args: unknown[]) => mockVariableNamespaceMembershipFindOne(...args),
  },
}));

// ---------------------------------------------------------------------------
// Mocks — @agent-platform/shared/encryption
// ---------------------------------------------------------------------------

const mockDecryptForTenant = vi.fn();

const mockEncryptionServiceInstance = { decryptForTenant: mockDecryptForTenant };

vi.mock('@agent-platform/shared/encryption', () => ({
  EncryptionService: vi.fn().mockImplementation(function () {
    return mockEncryptionServiceInstance;
  }),
  getEncryptionService: vi.fn(() => mockEncryptionServiceInstance),
  decryptForTenantAuto: (...args: unknown[]) => mockDecryptForTenant(...args),
}));

// ---------------------------------------------------------------------------
// Mocks — Studio Redis client
// ---------------------------------------------------------------------------

const mockGetRedisClient = vi.fn().mockReturnValue(null);

vi.mock('@/lib/redis-client', () => ({
  getRedisClient: (...args: unknown[]) => mockGetRedisClient(...args),
}));

// ---------------------------------------------------------------------------
// Mocks — MCP registry (dynamic import in service)
// ---------------------------------------------------------------------------

const mockGetServerConfigs = vi.fn();

vi.mock('@agent-platform/shared/services/mcp-registry', () => ({
  MCPServerRegistryService: vi.fn().mockImplementation(function () {
    return { getServerConfigs: mockGetServerConfigs };
  }),
}));

// ---------------------------------------------------------------------------
// Test Data — project_tools format (single collection, dslContent-based)
// ---------------------------------------------------------------------------

const httpProjectTool = {
  id: 'tool-http-1',
  name: 'weather_api',
  slug: 'weather_api',
  toolType: 'http',
  description: 'Fetches weather',
  dslContent: [
    'weather_api(city: string) -> object',
    '  description: "Fetches weather"',
    '  type: http',
    '  endpoint: "https://api.weather.com/v1/data"',
    '  method: GET',
    '  timeout: 15000',
  ].join('\n'),
  sourceHash: 'a'.repeat(64),
  projectId: 'proj-1',
  tenantId: 'tenant-1',
  createdBy: 'user-1',
  createdAt: '2025-01-01',
  updatedAt: '2025-01-01',
};

const mcpProjectTool = {
  id: 'tool-mcp-1',
  name: 'mcp_tool',
  slug: 'mcp_tool',
  toolType: 'mcp',
  description: 'MCP tool',
  dslContent: [
    'mcp_tool() -> object',
    '  description: "MCP tool"',
    '  type: mcp',
    '  server: "test-server"',
    '  server_tool: "mcp-tool"',
  ].join('\n'),
  sourceHash: 'b'.repeat(64),
  projectId: 'proj-1',
  tenantId: 'tenant-1',
  createdBy: 'user-1',
  createdAt: '2025-01-01',
  updatedAt: '2025-01-01',
};

const sandboxProjectTool = {
  id: 'tool-sandbox-1',
  name: 'sandbox_tool',
  slug: 'sandbox_tool',
  toolType: 'sandbox',
  description: 'Sandbox tool',
  dslContent: [
    'sandbox_tool(data: object) -> object',
    '  description: "Sandbox tool"',
    '  type: sandbox',
    '  runtime: "python"',
    '  timeout: 20000',
    '  code: |',
    '    print("hello")',
  ].join('\n'),
  sourceHash: 'c'.repeat(64),
  projectId: 'proj-1',
  tenantId: 'tenant-1',
  createdBy: 'user-1',
  createdAt: '2025-01-01',
  updatedAt: '2025-01-01',
};

// ---------------------------------------------------------------------------
// Global setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  mockExecute.mockReset();
  mockExecute.mockResolvedValue({});
  mockApplyAuth.mockReset();
  mockBuildAuthProfileOAuthProviderKey.mockReset();
  mockRefreshOAuth2Token.mockReset();
  mockResolveClientCredentialsToken.mockReset();
  mockResolveWithGracePeriod.mockReset();
  mockAuthProfileFindOne.mockReset();
  mockEndUserOAuthTokenFindOne.mockReset();
  mockEnvironmentVariableFindOne.mockReset();
  mockProjectConfigVariableFindOne.mockReset();
  mockVariableNamespaceFindOne.mockReset();
  mockVariableNamespaceCreate.mockReset();
  mockVariableNamespaceMembershipFindOne.mockReset();
  mockFindToolSecrets.mockResolvedValue([]);
  mockGetServerConfigs.mockResolvedValue([]);
  mockDisconnectAll.mockResolvedValue(undefined);
  mockGetDevSSRFOptions.mockReturnValue({ allowLocalhost: true, allowPrivateRanges: true });
  mockCreateSandboxRunner.mockReturnValue({ runner: 'sandbox-runner-stub' });
  mockGetRedisClient.mockReturnValue(null);
  mockApplyAuth.mockResolvedValue({ headers: {}, queryParams: new URLSearchParams() });
  mockBuildAuthProfileOAuthProviderKey.mockImplementation((authProfileId: string) => {
    return `auth-profile:${authProfileId}`;
  });
  mockRefreshOAuth2Token.mockResolvedValue({
    accessToken: 'refreshed-access-token',
    refreshed: true,
  });
  mockResolveClientCredentialsToken.mockResolvedValue({
    accessToken: 'cc-token',
    expiresAt: null,
    cached: false,
  });
  mockResolveWithGracePeriod.mockResolvedValue({});
  mockAuthProfileFindOne.mockReturnValue(makeQueryResult(null));
  mockEndUserOAuthTokenFindOne.mockReturnValue(makeQueryResult(null));
  mockEnvironmentVariableFindOne.mockReturnValue(makeQueryResult(null));
  mockProjectConfigVariableFindOne.mockReturnValue(makeQueryResult(null));
  mockVariableNamespaceFindOne.mockReturnValue(makeQueryResult(null));
  mockVariableNamespaceCreate.mockResolvedValue({
    toObject: () => ({
      _id: 'ns-default',
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      isDefault: true,
    }),
  });
  mockVariableNamespaceMembershipFindOne.mockReturnValue(makeQueryResult(null));
  delete process.env.SANDBOX_BACKEND;
});

// ---------------------------------------------------------------------------
// Import under test (after mocks are set up)
// ---------------------------------------------------------------------------

async function getExecuteToolTest() {
  const mod = await import('@/services/tool-test-service');
  return mod.executeToolTest;
}

// ===========================================================================
// HTTP Tool Execution
// ===========================================================================

describe('executeToolTest — HTTP tools', () => {
  it('executes an HTTP tool and returns output with latency', async () => {
    mockFindProjectToolById.mockResolvedValue(httpProjectTool);
    mockExecute.mockResolvedValue({ data: 'weather-result' });

    const executeToolTest = await getExecuteToolTest();
    const result = await executeToolTest({
      toolId: 'tool-http-1',
      tenantId: 'tenant-1',
      userId: 'user-1',
      projectId: 'proj-1',
      input: { city: 'London' },
    });

    expect(result.output).toEqual({ data: 'weather-result' });
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.error).toBeUndefined();
  });

  it('includes HTTP request/response inspection data for HTTP tools', async () => {
    mockFindProjectToolById.mockResolvedValue(httpProjectTool);
    mockExecute.mockResolvedValue({ temp: 22 });

    const executeToolTest = await getExecuteToolTest();
    const result = await executeToolTest({
      toolId: 'tool-http-1',
      tenantId: 'tenant-1',
      userId: 'user-1',
      projectId: 'proj-1',
      input: { city: 'Paris' },
    });

    expect(result.request).toBeDefined();
    expect(result.request!.method).toBe('GET');
    expect(result.request!.url).toBe('https://api.weather.com/v1/data');
    expect(result.response).toBeDefined();
    expect(result.response!.status).toBe(200);
    expect(result.response!.statusText).toBe('OK');
    expect(result.response!.body).toEqual({ temp: 22 });
  });

  it('resolves {{input.X}} template variables in display URL', async () => {
    const tool = {
      ...httpProjectTool,
      dslContent: [
        'get_post(post_id: integer) -> object',
        '  description: "Get a post by ID"',
        '  type: http',
        '  endpoint: "https://api.example.com/posts/{{input.post_id}}"',
        '  method: GET',
      ].join('\n'),
    };
    mockFindProjectToolById.mockResolvedValue(tool);
    mockExecute.mockResolvedValue({ id: 7 });

    const executeToolTest = await getExecuteToolTest();
    const result = await executeToolTest({
      toolId: 'tool-http-1',
      tenantId: 'tenant-1',
      userId: 'user-1',
      projectId: 'proj-1',
      input: { post_id: 7 },
    });

    expect(result.request!.url).toBe('https://api.example.com/posts/7');
  });

  it('resolves {{X}} bare template variables in display URL', async () => {
    const tool = {
      ...httpProjectTool,
      dslContent: [
        'get_post(post_id: integer) -> object',
        '  description: "Get a post"',
        '  type: http',
        '  endpoint: "https://api.example.com/posts/{{post_id}}"',
        '  method: GET',
      ].join('\n'),
    };
    mockFindProjectToolById.mockResolvedValue(tool);
    mockExecute.mockResolvedValue({ id: 3 });

    const executeToolTest = await getExecuteToolTest();
    const result = await executeToolTest({
      toolId: 'tool-http-1',
      tenantId: 'tenant-1',
      userId: 'user-1',
      projectId: 'proj-1',
      input: { post_id: 3 },
    });

    expect(result.request!.url).toBe('https://api.example.com/posts/3');
  });

  it('masks {{secrets.X}} in display URL', async () => {
    const tool = {
      ...httpProjectTool,
      dslContent: [
        'get_data() -> object',
        '  description: "Get data"',
        '  type: http',
        '  endpoint: "https://api.example.com/{{secrets.API_KEY}}/data"',
        '  method: GET',
      ].join('\n'),
    };
    mockFindProjectToolById.mockResolvedValue(tool);
    mockExecute.mockResolvedValue({});

    const executeToolTest = await getExecuteToolTest();
    const result = await executeToolTest({
      toolId: 'tool-http-1',
      tenantId: 'tenant-1',
      userId: 'user-1',
      projectId: 'proj-1',
    });

    expect(result.request!.url).toBe('https://api.example.com/***/data');
  });

  it('masks {{env.X}} in display URL', async () => {
    const tool = {
      ...httpProjectTool,
      dslContent: [
        'get_data() -> object',
        '  description: "Get data"',
        '  type: http',
        '  endpoint: "https://{{env.API_HOST}}/data"',
        '  method: GET',
      ].join('\n'),
    };
    mockFindProjectToolById.mockResolvedValue(tool);
    mockExecute.mockResolvedValue({});

    const executeToolTest = await getExecuteToolTest();
    const result = await executeToolTest({
      toolId: 'tool-http-1',
      tenantId: 'tenant-1',
      userId: 'user-1',
      projectId: 'proj-1',
    });

    expect(result.request!.url).toBe('https://***/data');
  });

  it('resolves query_params with {{input.X}} and appends to display URL', async () => {
    const tool = {
      ...httpProjectTool,
      dslContent: [
        'search(q: string, limit?: integer) -> object',
        '  description: "Search"',
        '  type: http',
        '  endpoint: "https://api.example.com/search"',
        '  method: GET',
        '  query_params:',
        '    q: "{{input.q}}"',
        '    limit: "{{input.limit}}"',
      ].join('\n'),
    };
    mockFindProjectToolById.mockResolvedValue(tool);
    mockExecute.mockResolvedValue({ results: [] });

    const executeToolTest = await getExecuteToolTest();
    const result = await executeToolTest({
      toolId: 'tool-http-1',
      tenantId: 'tenant-1',
      userId: 'user-1',
      projectId: 'proj-1',
      input: { q: 'hello', limit: 10 },
    });

    expect(result.request!.url).toContain('https://api.example.com/search?');
    expect(result.request!.url).toContain('q=hello');
    expect(result.request!.url).toContain('limit=10');
  });

  it('masks {{secrets.X}} in query_params display', async () => {
    const tool = {
      ...httpProjectTool,
      dslContent: [
        'get_data() -> object',
        '  description: "Get data"',
        '  type: http',
        '  endpoint: "https://api.example.com/data"',
        '  method: GET',
        '  query_params:',
        '    api_key: "{{secrets.API_KEY}}"',
      ].join('\n'),
    };
    mockFindProjectToolById.mockResolvedValue(tool);
    mockExecute.mockResolvedValue({});

    const executeToolTest = await getExecuteToolTest();
    const result = await executeToolTest({
      toolId: 'tool-http-1',
      tenantId: 'tenant-1',
      userId: 'user-1',
      projectId: 'proj-1',
    });

    expect(result.request!.url).toContain('api_key=***');
  });

  it('resolves {{input.X}} in display headers', async () => {
    const tool = {
      ...httpProjectTool,
      dslContent: [
        'get_data(org_id: string) -> object',
        '  description: "Get data"',
        '  type: http',
        '  endpoint: "https://api.example.com/data"',
        '  method: GET',
        '  headers:',
        '    X-Org-Id: "{{input.org_id}}"',
      ].join('\n'),
    };
    mockFindProjectToolById.mockResolvedValue(tool);
    mockExecute.mockResolvedValue({});

    const executeToolTest = await getExecuteToolTest();
    const result = await executeToolTest({
      toolId: 'tool-http-1',
      tenantId: 'tenant-1',
      userId: 'user-1',
      projectId: 'proj-1',
      input: { org_id: 'acme-123' },
    });

    expect(result.request!.headers).toBeDefined();
    expect(result.request!.headers!['X-Org-Id']).toBe('acme-123');
  });

  it('masks {{secrets.X}} in display headers', async () => {
    const tool = {
      ...httpProjectTool,
      dslContent: [
        'get_data() -> object',
        '  description: "Get data"',
        '  type: http',
        '  endpoint: "https://api.example.com/data"',
        '  method: GET',
        '  headers:',
        '    Authorization: "Bearer {{secrets.TOKEN}}"',
      ].join('\n'),
    };
    mockFindProjectToolById.mockResolvedValue(tool);
    mockExecute.mockResolvedValue({});

    const executeToolTest = await getExecuteToolTest();
    const result = await executeToolTest({
      toolId: 'tool-http-1',
      tenantId: 'tenant-1',
      userId: 'user-1',
      projectId: 'proj-1',
    });

    expect(result.request!.headers!['Authorization']).toBe('Bearer ***');
  });

  it('resolves body_template with {{input.X}} for POST tools', async () => {
    const tool = {
      ...httpProjectTool,
      dslContent: [
        'create_post(title: string, body: string, userId: number) -> object',
        '  description: "Create a post"',
        '  type: http',
        '  endpoint: "https://api.example.com/posts"',
        '  method: POST',
        '  body: |',
        '    { "title": "{{input.title}}", "body": "{{input.body}}", "userId": {{input.userId}} }',
      ].join('\n'),
    };
    mockFindProjectToolById.mockResolvedValue(tool);
    mockExecute.mockResolvedValue({ id: 101 });

    const executeToolTest = await getExecuteToolTest();
    const result = await executeToolTest({
      toolId: 'tool-http-1',
      tenantId: 'tenant-1',
      userId: 'user-1',
      projectId: 'proj-1',
      input: { title: 'Hello', body: 'World', userId: 3 },
    });

    expect(result.request!.body).toBe('{ "title": "Hello", "body": "World", "userId": 3 }');
  });

  it('urlencodes body_template placeholders for form POST tools', async () => {
    const tool = {
      ...httpProjectTool,
      dslContent: [
        'create_token(client_id: string, scope: string) -> object',
        '  description: "Create token"',
        '  type: http',
        '  endpoint: "https://login.example.com/oauth2/token"',
        '  method: POST',
        '  body_type: form',
        '  body: |',
        '    grant_type=client_credentials&client_id={{input.client_id}}&scope={{input.scope}}',
      ].join('\n'),
    };
    mockFindProjectToolById.mockResolvedValue(tool);
    mockExecute.mockResolvedValue({ access_token: 'token' });

    const executeToolTest = await getExecuteToolTest();
    const result = await executeToolTest({
      toolId: 'tool-http-1',
      tenantId: 'tenant-1',
      userId: 'user-1',
      projectId: 'proj-1',
      input: { client_id: 'client+123', scope: 'read write:all' },
    });

    expect(result.request!.body).toBe(
      'grant_type=client_credentials&client_id=client%2B123&scope=read+write%3Aall',
    );
  });

  it('masks {{secrets.X}} in body_template display', async () => {
    const tool = {
      ...httpProjectTool,
      dslContent: [
        'send_data(msg: string) -> object',
        '  description: "Send data"',
        '  type: http',
        '  endpoint: "https://api.example.com/send"',
        '  method: POST',
        '  body: |',
        '    { "message": "{{input.msg}}", "key": "{{secrets.API_KEY}}" }',
      ].join('\n'),
    };
    mockFindProjectToolById.mockResolvedValue(tool);
    mockExecute.mockResolvedValue({});

    const executeToolTest = await getExecuteToolTest();
    const result = await executeToolTest({
      toolId: 'tool-http-1',
      tenantId: 'tenant-1',
      userId: 'user-1',
      projectId: 'proj-1',
      input: { msg: 'hello' },
    });

    expect(result.request!.body).toBe('{ "message": "hello", "key": "***" }');
  });

  it('excludes {{input.X}} consumed by URL from auto-body in PUT', async () => {
    const tool = {
      ...httpProjectTool,
      dslContent: [
        'update_post(post_id: integer, title: string) -> object',
        '  description: "Update a post"',
        '  type: http',
        '  endpoint: "https://api.example.com/posts/{{input.post_id}}"',
        '  method: PUT',
      ].join('\n'),
    };
    mockFindProjectToolById.mockResolvedValue(tool);
    mockExecute.mockResolvedValue({ id: 5 });

    const executeToolTest = await getExecuteToolTest();
    const result = await executeToolTest({
      toolId: 'tool-http-1',
      tenantId: 'tenant-1',
      userId: 'user-1',
      projectId: 'proj-1',
      input: { post_id: 5, title: 'Updated' },
    });

    expect(result.request!.url).toBe('https://api.example.com/posts/5');
    // post_id consumed by URL, only title remains in body
    expect(result.request!.body).toEqual({ title: 'Updated' });
  });

  it('omits headers from request when tool has no custom headers', async () => {
    mockFindProjectToolById.mockResolvedValue(httpProjectTool);
    mockExecute.mockResolvedValue({});

    const executeToolTest = await getExecuteToolTest();
    const result = await executeToolTest({
      toolId: 'tool-http-1',
      tenantId: 'tenant-1',
      userId: 'user-1',
      projectId: 'proj-1',
    });

    // No custom headers defined in httpProjectTool DSL
    expect(result.request!.headers).toBeUndefined();
  });

  it('sets response status 500 on HTTP tool error', async () => {
    mockFindProjectToolById.mockResolvedValue(httpProjectTool);
    mockExecute.mockRejectedValue(new Error('Connection refused'));

    const executeToolTest = await getExecuteToolTest();
    const result = await executeToolTest({
      toolId: 'tool-http-1',
      tenantId: 'tenant-1',
      userId: 'user-1',
      projectId: 'proj-1',
    });

    expect(result.error).toBe('Connection refused');
    expect(result.response).toBeDefined();
    expect(result.response!.status).toBe(500);
    expect(result.response!.statusText).toBe('Internal Server Error');
  });

  it('does not include request/response for non-HTTP tools', async () => {
    mockFindProjectToolById.mockResolvedValue(sandboxProjectTool);
    mockExecute.mockResolvedValue({ result: 'hello' });

    const executeToolTest = await getExecuteToolTest();
    const result = await executeToolTest({
      toolId: 'tool-sandbox-1',
      tenantId: 'tenant-1',
      userId: 'user-1',
      projectId: 'proj-1',
    });

    expect(result.request).toBeUndefined();
    expect(result.response).toBeUndefined();
  });

  it('shows bearer auth as masked Authorization header', async () => {
    const tool = {
      ...httpProjectTool,
      dslContent: [
        'get_data() -> object',
        '  description: "Get data"',
        '  type: http',
        '  endpoint: "https://api.example.com/data"',
        '  method: GET',
        '  auth: bearer',
        '  auth_config:',
        '    token: "{{secrets.TOKEN}}"',
      ].join('\n'),
    };
    mockFindProjectToolById.mockResolvedValue(tool);
    mockExecute.mockResolvedValue({});

    const executeToolTest = await getExecuteToolTest();
    const result = await executeToolTest({
      toolId: 'tool-http-1',
      tenantId: 'tenant-1',
      userId: 'user-1',
      projectId: 'proj-1',
    });

    expect(result.request!.headers!['Authorization']).toBe('Bearer ***');
  });

  it('shows api_key auth with custom header name', async () => {
    const tool = {
      ...httpProjectTool,
      dslContent: [
        'get_data() -> object',
        '  description: "Get data"',
        '  type: http',
        '  endpoint: "https://api.example.com/data"',
        '  method: GET',
        '  auth: api_key',
        '  auth_config:',
        '    header_name: X-Custom-Key',
        '    api_key: "{{secrets.MY_KEY}}"',
      ].join('\n'),
    };
    mockFindProjectToolById.mockResolvedValue(tool);
    mockExecute.mockResolvedValue({});

    const executeToolTest = await getExecuteToolTest();
    const result = await executeToolTest({
      toolId: 'tool-http-1',
      tenantId: 'tenant-1',
      userId: 'user-1',
      projectId: 'proj-1',
    });

    expect(result.request!.headers!['X-Custom-Key']).toBe('***');
  });

  it('shows oauth2_client auth as masked Authorization header', async () => {
    const tool = {
      ...httpProjectTool,
      dslContent: [
        'get_data() -> object',
        '  description: "Get data"',
        '  type: http',
        '  endpoint: "https://api.example.com/data"',
        '  method: GET',
        '  auth: oauth2_client',
        '  auth_config:',
        '    token_url: "https://auth.example.com/token"',
        '    client_id: "my-client"',
        '    client_secret: "{{secrets.CLIENT_SECRET}}"',
      ].join('\n'),
    };
    mockFindProjectToolById.mockResolvedValue(tool);
    mockExecute.mockResolvedValue({});

    const executeToolTest = await getExecuteToolTest();
    const result = await executeToolTest({
      toolId: 'tool-http-1',
      tenantId: 'tenant-1',
      userId: 'user-1',
      projectId: 'proj-1',
    });

    expect(result.request!.headers!['Authorization']).toBe('Bearer [oauth2_client ***]');
  });
});

// ===========================================================================
// Tenant Isolation
// ===========================================================================

describe('executeToolTest — tenant isolation', () => {
  it('passes tenantId and projectId to findProjectToolById', async () => {
    mockFindProjectToolById.mockResolvedValue(httpProjectTool);
    mockExecute.mockResolvedValue({});

    const executeToolTest = await getExecuteToolTest();
    await executeToolTest({
      toolId: 'tool-http-1',
      tenantId: 'tenant-1',
      userId: 'user-1',
      projectId: 'proj-1',
    });

    expect(mockFindProjectToolById).toHaveBeenCalledWith('tool-http-1', 'tenant-1', 'proj-1');
  });

  it('scopes ToolBindingExecutor session context with tenantId', async () => {
    mockFindProjectToolById.mockResolvedValue(httpProjectTool);
    mockExecute.mockResolvedValue({});

    const executeToolTest = await getExecuteToolTest();
    await executeToolTest({
      toolId: 'tool-http-1',
      tenantId: 'tenant-1',
      userId: 'user-1',
      projectId: 'proj-1',
    });

    expect(MockToolBindingExecutor).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionContext: expect.objectContaining({
          tenantId: 'tenant-1',
          userId: 'user-1',
        }),
        projectId: 'proj-1',
      }),
    );
  });
});

// ===========================================================================
// Tool Not Found
// ===========================================================================

describe('executeToolTest — not found paths', () => {
  it('returns error when tool not found', async () => {
    mockFindProjectToolById.mockResolvedValue(null);

    const executeToolTest = await getExecuteToolTest();
    const result = await executeToolTest({
      toolId: 'nonexistent',
      tenantId: 'tenant-1',
      userId: 'user-1',
      projectId: 'proj-1',
    });

    expect(result.output).toBeNull();
    expect(result.error).toBe('Tool not found');
    expect(result.errorCode).toBe('NOT_FOUND');
    expect(result.latencyMs).toBe(0);
    expect(result.logs).toEqual([]);
  });

  it('does not call executor when tool is not found', async () => {
    mockFindProjectToolById.mockResolvedValue(null);

    const executeToolTest = await getExecuteToolTest();
    await executeToolTest({
      toolId: 'nonexistent',
      tenantId: 'tenant-1',
      userId: 'user-1',
      projectId: 'proj-1',
    });

    expect(MockToolBindingExecutor).not.toHaveBeenCalled();
    expect(mockExecute).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// ToolExecutionError handling
// ===========================================================================

describe('executeToolTest — ToolExecutionError', () => {
  it('captures structured error code and retryable flag', async () => {
    mockFindProjectToolById.mockResolvedValue(httpProjectTool);
    mockExecute.mockRejectedValue(
      new MockToolExecutionError({
        code: 'TOOL_TIMEOUT',
        message: 'Tool execution timed out after 15000ms',
        toolName: 'weather_api',
        retryable: true,
      }),
    );

    const executeToolTest = await getExecuteToolTest();
    const result = await executeToolTest({
      toolId: 'tool-http-1',
      tenantId: 'tenant-1',
      userId: 'user-1',
      projectId: 'proj-1',
    });

    expect(result.error).toBe('Tool execution timed out after 15000ms');
    expect(result.errorCode).toBe('TOOL_TIMEOUT');
    expect(result.retryable).toBe(true);
    expect(result.output).toBeUndefined();
  });

  it('captures non-retryable ToolExecutionError', async () => {
    mockFindProjectToolById.mockResolvedValue(httpProjectTool);
    mockExecute.mockRejectedValue(
      new MockToolExecutionError({
        code: 'TOOL_AUTH_FAILED',
        message: 'Invalid API key',
        toolName: 'weather_api',
        retryable: false,
      }),
    );

    const executeToolTest = await getExecuteToolTest();
    const result = await executeToolTest({
      toolId: 'tool-http-1',
      tenantId: 'tenant-1',
      userId: 'user-1',
      projectId: 'proj-1',
    });

    expect(result.error).toBe('Invalid API key');
    expect(result.errorCode).toBe('TOOL_AUTH_FAILED');
    expect(result.retryable).toBe(false);
  });
});

// ===========================================================================
// Generic error handling
// ===========================================================================

describe('executeToolTest — generic errors', () => {
  it('captures generic Error message', async () => {
    mockFindProjectToolById.mockResolvedValue(httpProjectTool);
    mockExecute.mockRejectedValue(new Error('Network failure'));

    const executeToolTest = await getExecuteToolTest();
    const result = await executeToolTest({
      toolId: 'tool-http-1',
      tenantId: 'tenant-1',
      userId: 'user-1',
      projectId: 'proj-1',
    });

    expect(result.error).toBe('Network failure');
    expect(result.errorCode).toBeUndefined();
    expect(result.retryable).toBeUndefined();
  });

  it('captures non-Error thrown values as "Unknown error"', async () => {
    mockFindProjectToolById.mockResolvedValue(httpProjectTool);
    mockExecute.mockRejectedValue('string-error');

    const executeToolTest = await getExecuteToolTest();
    const result = await executeToolTest({
      toolId: 'tool-http-1',
      tenantId: 'tenant-1',
      userId: 'user-1',
      projectId: 'proj-1',
    });

    expect(result.error).toBe('Unknown error');
  });
});

// ===========================================================================
// Sandbox tool execution
// ===========================================================================

describe('executeToolTest — sandbox tools', () => {
  it('creates a gvisor sandbox runner via the shared factory for sandbox tool type', async () => {
    mockFindProjectToolById.mockResolvedValue(sandboxProjectTool);
    mockExecute.mockResolvedValue({ result: 'hello' });

    const executeToolTest = await getExecuteToolTest();
    await executeToolTest({
      toolId: 'tool-sandbox-1',
      tenantId: 'tenant-1',
      userId: 'user-1',
      projectId: 'proj-1',
    });

    expect(mockCreateSandboxRunner).toHaveBeenCalledWith(
      'gvisor',
      expect.objectContaining({
        gvisor: expect.objectContaining({
          pythonPodUrl: 'http://kr-python-svc',
          javascriptPodUrl: 'http://kr-javascript-svc',
          podPath: '/execute-script',
          timeoutMs: 60_000,
        }),
        lambda: expect.objectContaining({
          region: 'us-east-1',
          memoryApiBaseUrl: '',
          healthTtlMs: 300000,
        }),
      }),
      expect.objectContaining({
        tenantId: 'tenant-1',
        userId: 'user-1',
        sessionId: 'studio-test-tool-sandbox-1',
      }),
      undefined, // jwtSigner is undefined when SANDBOX_JWT_SECRET is not set
    );
  });

  it('does not create sandbox runner for HTTP tool', async () => {
    mockFindProjectToolById.mockResolvedValue(httpProjectTool);
    mockExecute.mockResolvedValue({});

    const executeToolTest = await getExecuteToolTest();
    await executeToolTest({
      toolId: 'tool-http-1',
      tenantId: 'tenant-1',
      userId: 'user-1',
      projectId: 'proj-1',
    });

    expect(mockCreateSandboxRunner).not.toHaveBeenCalled();
  });

  it('honors SANDBOX_BACKEND=mock for direct Studio tool tests', async () => {
    process.env.SANDBOX_BACKEND = 'mock';
    mockFindProjectToolById.mockResolvedValue(sandboxProjectTool);
    mockExecute.mockResolvedValue({});

    const executeToolTest = await getExecuteToolTest();
    await executeToolTest({
      toolId: 'tool-sandbox-1',
      tenantId: 'tenant-1',
      userId: 'user-1',
      projectId: 'proj-1',
    });

    expect(mockCreateSandboxRunner).toHaveBeenCalledWith(
      'mock',
      expect.any(Object),
      expect.objectContaining({
        tenantId: 'tenant-1',
        userId: 'user-1',
        sessionId: 'studio-test-tool-sandbox-1',
      }),
      undefined,
    );
  });

  it('passes sandbox runner to ToolBindingExecutor', async () => {
    mockFindProjectToolById.mockResolvedValue(sandboxProjectTool);
    mockExecute.mockResolvedValue({});

    const executeToolTest = await getExecuteToolTest();
    await executeToolTest({
      toolId: 'tool-sandbox-1',
      tenantId: 'tenant-1',
      userId: 'user-1',
      projectId: 'proj-1',
    });

    expect(MockToolBindingExecutor).toHaveBeenCalledWith(
      expect.objectContaining({
        sandboxRunner: expect.anything(),
      }),
    );
  });

  it('returns sandbox inspection data with runtime and limits', async () => {
    mockFindProjectToolById.mockResolvedValue(sandboxProjectTool);
    mockExecute.mockResolvedValue({ result: 'hello' });

    const executeToolTest = await getExecuteToolTest();
    const result = await executeToolTest({
      toolId: 'tool-sandbox-1',
      tenantId: 'tenant-1',
      userId: 'user-1',
      projectId: 'proj-1',
      input: { data: { key: 'value' } },
    });

    expect(result.sandbox).toBeDefined();
    expect(result.sandbox!.runtime).toBe('python');
    expect(result.sandbox!.timeoutMs).toBe(20000);
    expect(result.sandbox!.memoryMb).toBe(128);
    // Should not have HTTP-specific fields
    expect(result.request).toBeUndefined();
    expect(result.response).toBeUndefined();
    expect(result.mcp).toBeUndefined();
  });

  it('uses default limits when sandbox DSL omits them', async () => {
    const toolMinimal = {
      ...sandboxProjectTool,
      dslContent: [
        'sandbox_tool(data: object) -> object',
        '  description: "Sandbox tool"',
        '  type: sandbox',
        '  runtime: "javascript"',
        '  code: |',
        '    return data;',
      ].join('\n'),
    };
    mockFindProjectToolById.mockResolvedValue(toolMinimal);
    mockExecute.mockResolvedValue({});

    const executeToolTest = await getExecuteToolTest();
    const result = await executeToolTest({
      toolId: 'tool-sandbox-1',
      tenantId: 'tenant-1',
      userId: 'user-1',
      projectId: 'proj-1',
    });

    expect(result.sandbox).toBeDefined();
    expect(result.sandbox!.runtime).toBe('javascript');
    expect(result.sandbox!.timeoutMs).toBe(30000); // DEFAULT_TIMEOUT_MS
    expect(result.sandbox!.memoryMb).toBe(128); // default
  });
});

// ===========================================================================
// MCP tool execution
// ===========================================================================

describe('executeToolTest — MCP tools', () => {
  it('sets up MCP provider for MCP tool type', async () => {
    mockFindProjectToolById.mockResolvedValue(mcpProjectTool);
    mockGetServerConfigs.mockResolvedValue([
      { id: 'server-1', name: 'Test Server', url: 'http://localhost:9000' },
    ]);
    mockExecute.mockResolvedValue({ result: 'mcp-data' });

    const executeToolTest = await getExecuteToolTest();
    const result = await executeToolTest({
      toolId: 'tool-mcp-1',
      tenantId: 'tenant-1',
      userId: 'user-1',
      projectId: 'proj-1',
    });

    expect(result.output).toEqual({ result: 'mcp-data' });
    expect(result.error).toBeUndefined();
  });

  it('disconnects MCP provider after execution (cleanup)', async () => {
    mockFindProjectToolById.mockResolvedValue(mcpProjectTool);
    mockGetServerConfigs.mockResolvedValue([]);
    mockExecute.mockResolvedValue({});

    const executeToolTest = await getExecuteToolTest();
    await executeToolTest({
      toolId: 'tool-mcp-1',
      tenantId: 'tenant-1',
      userId: 'user-1',
      projectId: 'proj-1',
    });

    expect(mockDisconnectAll).toHaveBeenCalled();
  });

  it('disconnects MCP provider even when execution throws', async () => {
    mockFindProjectToolById.mockResolvedValue(mcpProjectTool);
    mockGetServerConfigs.mockResolvedValue([]);
    mockExecute.mockRejectedValue(new Error('MCP call failed'));

    const executeToolTest = await getExecuteToolTest();
    await executeToolTest({
      toolId: 'tool-mcp-1',
      tenantId: 'tenant-1',
      userId: 'user-1',
      projectId: 'proj-1',
    });

    expect(mockDisconnectAll).toHaveBeenCalled();
  });

  it('logs MCP provider setup failure but continues (non-fatal)', async () => {
    mockFindProjectToolById.mockResolvedValue(mcpProjectTool);
    mockGetServerConfigs.mockRejectedValue(new Error('Registry unavailable'));
    mockExecute.mockResolvedValue({});

    const executeToolTest = await getExecuteToolTest();
    const result = await executeToolTest({
      toolId: 'tool-mcp-1',
      tenantId: 'tenant-1',
      userId: 'user-1',
      projectId: 'proj-1',
    });

    // Execution should still proceed (executor handles missing MCP provider)
    expect(result.logs).toEqual(
      expect.arrayContaining([expect.stringContaining('MCP provider setup failed')]),
    );
  });

  it('returns MCP inspection data with server and tool name', async () => {
    mockFindProjectToolById.mockResolvedValue(mcpProjectTool);
    mockGetServerConfigs.mockResolvedValue([]);
    mockExecute.mockResolvedValue({ result: 'mcp-data' });

    const executeToolTest = await getExecuteToolTest();
    const result = await executeToolTest({
      toolId: 'tool-mcp-1',
      tenantId: 'tenant-1',
      userId: 'user-1',
      projectId: 'proj-1',
    });

    expect(result.mcp).toBeDefined();
    expect(result.mcp!.server).toBe('test-server');
    expect(result.mcp!.tool).toBe('mcp-tool');
    // Should not have HTTP-specific or sandbox fields
    expect(result.request).toBeUndefined();
    expect(result.response).toBeUndefined();
    expect(result.sandbox).toBeUndefined();
  });

  it('does not set up MCP provider for HTTP tool', async () => {
    mockFindProjectToolById.mockResolvedValue(httpProjectTool);
    mockExecute.mockResolvedValue({});

    const executeToolTest = await getExecuteToolTest();
    await executeToolTest({
      toolId: 'tool-http-1',
      tenantId: 'tenant-1',
      userId: 'user-1',
      projectId: 'proj-1',
    });

    expect(mockGetServerConfigs).not.toHaveBeenCalled();
    expect(MockMCPServerManager).not.toHaveBeenCalled();
  });

  it('applies SSRF dev options to server configs before registering', async () => {
    const serverConfig = { id: 'server-1', name: 'Test Server', url: 'http://localhost:9000' };
    mockFindProjectToolById.mockResolvedValue(mcpProjectTool);
    mockGetServerConfigs.mockResolvedValue([serverConfig]);
    mockExecute.mockResolvedValue({});

    const executeToolTest = await getExecuteToolTest();
    await executeToolTest({
      toolId: 'tool-mcp-1',
      tenantId: 'tenant-1',
      userId: 'user-1',
      projectId: 'proj-1',
    });

    // In test environment (non-production), getDevSSRFOptions returns { allowLocalhost: true, allowPrivateRanges: true }
    // The service should spread ssrfOptions onto config before registering
    expect(mockRegisterServer).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'server-1',
        name: 'Test Server',
        ssrfOptions: expect.objectContaining({
          allowLocalhost: true,
        }),
      }),
    );
  });

  it('does not apply SSRF options in production mode', async () => {
    mockGetDevSSRFOptions.mockReturnValue({});
    const serverConfig = { id: 'server-1', name: 'Test Server', url: 'https://mcp.example.com' };
    mockFindProjectToolById.mockResolvedValue(mcpProjectTool);
    mockGetServerConfigs.mockResolvedValue([serverConfig]);
    mockExecute.mockResolvedValue({});

    const executeToolTest = await getExecuteToolTest();
    await executeToolTest({
      toolId: 'tool-mcp-1',
      tenantId: 'tenant-1',
      userId: 'user-1',
      projectId: 'proj-1',
    });

    // When getDevSSRFOptions returns {} (production), ssrfOptions should NOT be set
    expect(mockRegisterServer).toHaveBeenCalledWith(
      expect.not.objectContaining({
        ssrfOptions: expect.anything(),
      }),
    );
  });

  it('registers servers by display name for executor lookup', async () => {
    const serverConfig = {
      id: 'server-db-id-123',
      name: 'Human Readable Name',
      url: 'http://localhost:9000',
    };
    mockFindProjectToolById.mockResolvedValue(mcpProjectTool);
    mockGetServerConfigs.mockResolvedValue([serverConfig]);
    mockExecute.mockResolvedValue({});

    const executeToolTest = await getExecuteToolTest();
    await executeToolTest({
      toolId: 'tool-mcp-1',
      tenantId: 'tenant-1',
      userId: 'user-1',
      projectId: 'proj-1',
    });

    // Server registered with full config; connectServer uses display name
    expect(mockRegisterServer).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'server-db-id-123', name: 'Human Readable Name' }),
    );
    expect(mockConnectServer).toHaveBeenCalledWith('Human Readable Name');
  });

  it('logs warning when individual server connection fails', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const serverConfig = {
      id: 'server-fail',
      name: 'Failing Server',
      url: 'http://localhost:9999',
    };
    mockFindProjectToolById.mockResolvedValue(mcpProjectTool);
    mockGetServerConfigs.mockResolvedValue([serverConfig]);
    mockConnectServer.mockRejectedValueOnce(new Error('Connection refused'));
    mockExecute.mockResolvedValue({});

    const executeToolTest = await getExecuteToolTest();
    await executeToolTest({
      toolId: 'tool-mcp-1',
      tenantId: 'tenant-1',
      userId: 'user-1',
      projectId: 'proj-1',
    });

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[ToolTest] Failed to connect MCP server server-fail'),
      expect.stringContaining('Connection refused'),
    );
    warnSpy.mockRestore();
  });

  it('continues with other servers when one fails to connect', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const configs = [
      { id: 'server-fail', name: 'Failing', url: 'http://localhost:9999' },
      { id: 'server-ok', name: 'Working', url: 'http://localhost:9000' },
    ];
    mockFindProjectToolById.mockResolvedValue(mcpProjectTool);
    mockGetServerConfigs.mockResolvedValue(configs);
    mockConnectServer
      .mockRejectedValueOnce(new Error('Connection refused'))
      .mockResolvedValueOnce(undefined);
    mockExecute.mockResolvedValue({ result: 'ok' });

    const executeToolTest = await getExecuteToolTest();
    const result = await executeToolTest({
      toolId: 'tool-mcp-1',
      tenantId: 'tenant-1',
      userId: 'user-1',
      projectId: 'proj-1',
    });

    // Both servers should be attempted
    expect(mockRegisterServer).toHaveBeenCalledTimes(2);
    expect(mockConnectServer).toHaveBeenCalledTimes(2);
    // Execution still succeeds
    expect(result.output).toEqual({ result: 'ok' });
    expect(result.error).toBeUndefined();
    vi.restoreAllMocks();
  });
});

// ===========================================================================
// Timeout and executor config
// ===========================================================================

describe('executeToolTest — timeout and executor configuration', () => {
  it('uses custom timeoutMs from input params', async () => {
    mockFindProjectToolById.mockResolvedValue(httpProjectTool);
    mockExecute.mockResolvedValue({});

    const executeToolTest = await getExecuteToolTest();
    await executeToolTest({
      toolId: 'tool-http-1',
      tenantId: 'tenant-1',
      userId: 'user-1',
      projectId: 'proj-1',
      timeoutMs: 5000,
    });

    // Executor created with custom timeout
    expect(MockToolBindingExecutor).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultTimeoutMs: 5000,
      }),
    );
    // Execute called with custom timeout
    expect(mockExecute).toHaveBeenCalledWith('weather_api', {}, 5000);
  });

  it('falls back to DSL timeout when no custom timeout', async () => {
    mockFindProjectToolById.mockResolvedValue(httpProjectTool); // dslContent has timeout: 15000
    mockExecute.mockResolvedValue({});

    const executeToolTest = await getExecuteToolTest();
    await executeToolTest({
      toolId: 'tool-http-1',
      tenantId: 'tenant-1',
      userId: 'user-1',
      projectId: 'proj-1',
    });

    expect(MockToolBindingExecutor).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultTimeoutMs: 15000,
      }),
    );
    expect(mockExecute).toHaveBeenCalledWith('weather_api', {}, 15000);
  });

  it('falls back to DEFAULT_TIMEOUT_MS (30000) when neither input nor DSL provides timeout', async () => {
    const toolNoTimeout = {
      ...httpProjectTool,
      dslContent: [
        'weather_api(city: string) -> object',
        '  description: "Fetches weather"',
        '  type: http',
        '  endpoint: "https://api.weather.com/v1/data"',
        '  method: GET',
      ].join('\n'),
    };
    mockFindProjectToolById.mockResolvedValue(toolNoTimeout);
    mockExecute.mockResolvedValue({});

    const executeToolTest = await getExecuteToolTest();
    await executeToolTest({
      toolId: 'tool-http-1',
      tenantId: 'tenant-1',
      userId: 'user-1',
      projectId: 'proj-1',
    });

    expect(MockToolBindingExecutor).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultTimeoutMs: 30000,
      }),
    );
    expect(mockExecute).toHaveBeenCalledWith('weather_api', {}, 30000);
  });

  it('uses empty object as input when input is undefined', async () => {
    mockFindProjectToolById.mockResolvedValue(httpProjectTool);
    mockExecute.mockResolvedValue({});

    const executeToolTest = await getExecuteToolTest();
    await executeToolTest({
      toolId: 'tool-http-1',
      tenantId: 'tenant-1',
      userId: 'user-1',
      projectId: 'proj-1',
      // no input
    });

    expect(mockExecute).toHaveBeenCalledWith('weather_api', {}, expect.any(Number));
  });

  it('passes tool definition to executor', async () => {
    mockFindProjectToolById.mockResolvedValue(httpProjectTool);
    mockExecute.mockResolvedValue({});

    const executeToolTest = await getExecuteToolTest();
    await executeToolTest({
      toolId: 'tool-http-1',
      tenantId: 'tenant-1',
      userId: 'user-1',
      projectId: 'proj-1',
    });

    // ToolDefinition is built from dslContent internally
    expect(MockToolBindingExecutor).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: [
          expect.objectContaining({
            name: 'weather_api',
            tool_type: 'http',
            http_binding: expect.objectContaining({
              endpoint: 'https://api.weather.com/v1/data',
              method: 'GET',
            }),
          }),
        ],
      }),
    );
  });
});

// ===========================================================================
// Logs capture
// ===========================================================================

describe('executeToolTest — auth_config fields in IR', () => {
  it('passes bearer token from auth_config to ToolBindingExecutor', async () => {
    const tool = {
      ...httpProjectTool,
      dslContent: [
        'get_data() -> object',
        '  description: "Get data"',
        '  type: http',
        '  endpoint: "https://api.example.com/data"',
        '  method: GET',
        '  auth: bearer',
        '  auth_config:',
        '    token: "{{secrets.MY_TOKEN}}"',
      ].join('\n'),
    };
    mockFindProjectToolById.mockResolvedValue(tool);
    mockExecute.mockResolvedValue({});

    const executeToolTest = await getExecuteToolTest();
    await executeToolTest({
      toolId: 'tool-http-1',
      tenantId: 'tenant-1',
      userId: 'user-1',
      projectId: 'proj-1',
    });

    const toolDefs = MockToolBindingExecutor.mock.calls[0][0].tools;
    expect(toolDefs[0].http_binding.auth.config.token).toBe('{{secrets.MY_TOKEN}}');
  });

  it('passes api_key from auth_config to ToolBindingExecutor', async () => {
    const tool = {
      ...httpProjectTool,
      dslContent: [
        'get_data() -> object',
        '  description: "Get data"',
        '  type: http',
        '  endpoint: "https://api.example.com/data"',
        '  method: GET',
        '  auth: api_key',
        '  auth_config:',
        '    api_key: "{{secrets.MY_KEY}}"',
        '    header_name: X-API-Key',
      ].join('\n'),
    };
    mockFindProjectToolById.mockResolvedValue(tool);
    mockExecute.mockResolvedValue({});

    const executeToolTest = await getExecuteToolTest();
    await executeToolTest({
      toolId: 'tool-http-1',
      tenantId: 'tenant-1',
      userId: 'user-1',
      projectId: 'proj-1',
    });

    const toolDefs = MockToolBindingExecutor.mock.calls[0][0].tools;
    expect(toolDefs[0].http_binding.auth.config.apiKey).toBe('{{secrets.MY_KEY}}');
    expect(toolDefs[0].http_binding.auth.config.headerName).toBe('X-API-Key');
  });

  it('passes oauth2 client_secret from auth_config to ToolBindingExecutor', async () => {
    const tool = {
      ...httpProjectTool,
      dslContent: [
        'get_data() -> object',
        '  description: "Get data"',
        '  type: http',
        '  endpoint: "https://api.example.com/data"',
        '  method: GET',
        '  auth: oauth2_client',
        '  auth_config:',
        '    token_url: "https://auth.example.com/token"',
        '    client_id: my-client',
        '    client_secret: "{{secrets.SECRET}}"',
        '    scopes: "read,write"',
      ].join('\n'),
    };
    mockFindProjectToolById.mockResolvedValue(tool);
    mockExecute.mockResolvedValue({});

    const executeToolTest = await getExecuteToolTest();
    await executeToolTest({
      toolId: 'tool-http-1',
      tenantId: 'tenant-1',
      userId: 'user-1',
      projectId: 'proj-1',
    });

    const toolDefs = MockToolBindingExecutor.mock.calls[0][0].tools;
    expect(toolDefs[0].http_binding.auth.config.clientSecret).toBe('{{secrets.SECRET}}');
    expect(toolDefs[0].http_binding.auth.config.oauth.tokenUrl).toBe(
      'https://auth.example.com/token',
    );
    expect(toolDefs[0].http_binding.auth.config.oauth.clientId).toBe('my-client');
  });

  it('passes MCP headers from DSL to ToolBindingExecutor', async () => {
    const tool = {
      ...mcpProjectTool,
      dslContent: [
        'mcp_tool() -> object',
        '  description: "MCP tool"',
        '  type: mcp',
        '  server: "test-server"',
        '  server_tool: "mcp-tool"',
        '  headers:',
        '    Authorization: "Bearer {{secrets.TOKEN}}"',
        '    X-Custom: my-value',
      ].join('\n'),
    };
    mockFindProjectToolById.mockResolvedValue(tool);
    mockExecute.mockResolvedValue({});

    const executeToolTest = await getExecuteToolTest();
    await executeToolTest({
      toolId: 'tool-mcp-1',
      tenantId: 'tenant-1',
      userId: 'user-1',
      projectId: 'proj-1',
    });

    const toolDefs = MockToolBindingExecutor.mock.calls[0][0].tools;
    expect(toolDefs[0].mcp_binding.headers).toEqual({
      Authorization: 'Bearer {{secrets.TOKEN}}',
      'X-Custom': 'my-value',
    });
  });
});

describe('executeToolTest — auth profiles and scoped variable resolution', () => {
  it('passes auth profile metadata into the executable tool definition and resolves profile auth in middleware', async () => {
    const tool = {
      ...httpProjectTool,
      variableNamespaceIds: ['ns-tools'],
      dslContent: [
        'get_billing() -> object',
        '  description: "Get billing data"',
        '  type: http',
        '  endpoint: "https://api.example.com/billing"',
        '  method: GET',
        '  auth_profile: "billing_shared_auth"',
        '  connection: shared',
        '  consent: preflight',
      ].join('\n'),
    };
    mockFindProjectToolById.mockResolvedValue(tool);
    mockExecute.mockResolvedValue({});
    mockAuthProfileFindOne.mockReturnValue(
      makeQueryResult({
        _id: 'profile-1',
        tenantId: 'tenant-1',
        projectId: 'proj-1',
        name: 'billing_shared_auth',
        authType: 'api_key',
        config: { headerName: 'X-API-Key' },
        encryptedSecrets: JSON.stringify({ apiKey: 'secret-key' }),
        updatedAt: new Date('2026-01-01T00:00:00.000Z'),
        expiresAt: null,
      }),
    );
    mockApplyAuth.mockResolvedValue({
      headers: { 'X-API-Key': 'secret-key' },
      queryParams: new URLSearchParams(),
    });

    const executeToolTest = await getExecuteToolTest();
    await executeToolTest({
      toolId: 'tool-http-1',
      tenantId: 'tenant-1',
      userId: 'user-1',
      projectId: 'proj-1',
    });

    const constructorArg = MockToolBindingExecutor.mock.calls[0][0];
    const toolDef = constructorArg.tools[0];
    expect(toolDef.auth_profile_ref).toBe('billing_shared_auth');
    expect(toolDef.connection_mode).toBe('shared');
    expect(toolDef.consent_mode).toBe('preflight');
    expect(toolDef.variable_namespace_ids).toEqual(['ns-tools']);

    const middleware = constructorArg.middleware[0];
    const next = vi.fn(async (ctx) => ({ result: ctx.tool }));
    await middleware({ tool: toolDef }, next);

    expect(mockAuthProfileFindOne).toHaveBeenCalled();
    expect(mockApplyAuth).toHaveBeenCalledWith(
      expect.objectContaining({
        authType: 'api_key',
        config: { headerName: 'X-API-Key' },
        secrets: { apiKey: 'secret-key' },
      }),
    );
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({
        tool: expect.objectContaining({
          http_binding: expect.objectContaining({
            headers: { 'X-API-Key': 'secret-key' },
            auth: { type: 'none' },
          }),
        }),
      }),
    );
  });

  it('propagates ws_security credentials to the patched HTTP binding', async () => {
    const tool = {
      ...httpProjectTool,
      dslContent: [
        'call_soap() -> object',
        '  description: "Call SOAP endpoint"',
        '  type: http',
        '  endpoint: "https://api.example.com/soap"',
        '  method: POST',
        '  protocol: soap',
        '  auth_profile: "soap_ws_auth"',
      ].join('\n'),
    };
    mockFindProjectToolById.mockResolvedValue(tool);
    mockExecute.mockResolvedValue({});
    mockAuthProfileFindOne.mockReturnValue(
      makeQueryResult({
        _id: 'profile-ws-1',
        tenantId: 'tenant-1',
        projectId: 'proj-1',
        name: 'soap_ws_auth',
        authType: 'ws_security',
        config: { mustUnderstand: true },
        encryptedSecrets: JSON.stringify({
          username: 'soap-user',
          password: 'soap-pass',
        }),
        updatedAt: new Date('2026-01-01T00:00:00.000Z'),
        expiresAt: null,
      }),
    );
    mockApplyAuth.mockResolvedValue({
      headers: {},
      queryParams: new URLSearchParams(),
      wsSecurityCredentials: {
        username: 'soap-user',
        password: 'soap-pass',
        mustUnderstand: true,
      },
    });

    const executeToolTest = await getExecuteToolTest();
    await executeToolTest({
      toolId: 'tool-http-1',
      tenantId: 'tenant-1',
      userId: 'user-1',
      projectId: 'proj-1',
    });

    const constructorArg = MockToolBindingExecutor.mock.calls[0][0];
    const middleware = constructorArg.middleware[0];
    const next = vi.fn(async (ctx) => ({ result: ctx.tool }));
    await middleware({ tool: constructorArg.tools[0] }, next);

    const patchedTool = next.mock.calls[0][0].tool as {
      http_binding?: Record<string, unknown>;
    };
    expect(patchedTool.http_binding?.['_wsSecurityCredentials']).toEqual({
      username: 'soap-user',
      password: 'soap-pass',
      mustUnderstand: true,
    });
    expect(patchedTool.http_binding?.auth).toEqual({ type: 'none' });
  });

  it('uses legacy oauth2_client_credentials config.scope string for token exchange scopes', async () => {
    const tool = {
      ...httpProjectTool,
      dslContent: [
        'get_client_data() -> object',
        '  description: "Get data with client credentials"',
        '  type: http',
        '  endpoint: "https://api.example.com/data"',
        '  method: GET',
        '  auth_profile: "legacy_client_creds"',
      ].join('\n'),
    };
    mockFindProjectToolById.mockResolvedValue(tool);
    mockExecute.mockResolvedValue({});
    mockAuthProfileFindOne.mockReturnValue(
      makeQueryResult({
        _id: 'profile-cc-legacy',
        tenantId: 'tenant-1',
        projectId: 'proj-1',
        name: 'legacy_client_creds',
        authType: 'oauth2_client_credentials',
        config: {
          tokenUrl: 'https://oauth.example.com/token',
          scope: 'read,write',
        },
        encryptedSecrets: JSON.stringify({
          clientId: 'client-id',
          clientSecret: 'client-secret',
        }),
        updatedAt: new Date('2026-01-01T00:00:00.000Z'),
        expiresAt: null,
      }),
    );
    mockResolveClientCredentialsToken.mockResolvedValue({
      accessToken: 'cc-token',
      expiresAt: null,
      cached: false,
    });
    mockApplyAuth.mockResolvedValue({
      headers: { Authorization: 'Bearer cc-token' },
      queryParams: new URLSearchParams(),
    });

    const executeToolTest = await getExecuteToolTest();
    await executeToolTest({
      toolId: 'tool-http-1',
      tenantId: 'tenant-1',
      userId: 'user-1',
      projectId: 'proj-1',
    });

    const constructorArg = MockToolBindingExecutor.mock.calls[0][0];
    const middleware = constructorArg.middleware[0];
    const next = vi.fn(async (ctx) => ({ result: ctx.tool }));
    await middleware({ tool: constructorArg.tools[0] }, next);

    expect(mockResolveClientCredentialsToken).toHaveBeenCalled();
    const tokenCall = mockResolveClientCredentialsToken.mock.calls[0];
    expect(tokenCall[6]).toEqual(['read', 'write']);
    expect(mockApplyAuth).toHaveBeenCalledWith(
      expect.objectContaining({
        authType: 'oauth2_client_credentials',
        secrets: { accessToken: 'cc-token' },
      }),
    );
  });

  it('falls back to global environment variables and resolves config-backed auth profile refs', async () => {
    const tool = {
      ...httpProjectTool,
      variableNamespaceIds: ['ns-tools'],
      dslContent: [
        'get_crm() -> object',
        '  description: "Get CRM data"',
        '  type: http',
        '  endpoint: "https://api.example.com/crm"',
        '  method: GET',
        '  auth_profile: "{{config.CRM_AUTH_PROFILE}}"',
      ].join('\n'),
    };
    mockFindProjectToolById.mockResolvedValue(tool);
    mockExecute.mockResolvedValue({});
    mockEnvironmentVariableFindOne.mockReturnValueOnce(makeQueryResult(null)).mockReturnValueOnce(
      makeQueryResult({
        _id: 'env-1',
        encryptedValue: 'ciphertext',
      }),
    );
    mockVariableNamespaceMembershipFindOne
      .mockReturnValueOnce(makeQueryResult({ namespaceId: 'ns-tools' }))
      .mockReturnValueOnce(makeQueryResult({ namespaceId: 'ns-tools' }));
    mockDecryptForTenant.mockResolvedValue('resolved-global-secret');
    mockProjectConfigVariableFindOne.mockReturnValue(
      makeQueryResult({
        _id: 'cfg-1',
        value: 'crm_profile_live',
      }),
    );
    mockAuthProfileFindOne.mockReturnValue(
      makeQueryResult({
        _id: 'profile-2',
        tenantId: 'tenant-1',
        projectId: 'proj-1',
        name: 'crm_profile_live',
        authType: 'bearer',
        config: {},
        encryptedSecrets: JSON.stringify({ token: 'bearer-secret' }),
        updatedAt: new Date('2026-01-01T00:00:00.000Z'),
        expiresAt: null,
      }),
    );
    mockApplyAuth.mockResolvedValue({
      headers: { Authorization: 'Bearer bearer-secret' },
      queryParams: new URLSearchParams(),
    });

    const executeToolTest = await getExecuteToolTest();
    await executeToolTest({
      toolId: 'tool-http-1',
      tenantId: 'tenant-1',
      userId: 'user-1',
      projectId: 'proj-1',
    });

    const constructorArg = MockToolBindingExecutor.mock.calls[0][0];
    const resolvedSecret = await constructorArg.secrets.getSecret('CRM_BASE_URL');
    expect(resolvedSecret).toBe('resolved-global-secret');

    const middleware = constructorArg.middleware[0];
    const next = vi.fn(async (ctx) => ({ result: ctx.tool }));
    await middleware({ tool: constructorArg.tools[0] }, next);

    expect(mockProjectConfigVariableFindOne).toHaveBeenCalled();
    expect(
      mockVariableNamespaceMembershipFindOne.mock.calls.every(
        ([query]) => query.tenantId === 'tenant-1' && query.projectId === 'proj-1',
      ),
    ).toBe(true);
    expect(mockApplyAuth).toHaveBeenCalledWith(
      expect.objectContaining({
        authType: 'bearer',
        secrets: { token: 'bearer-secret' },
      }),
    );
  });

  it('resolves per_user oauth2_app grants for the current user and applies bearer auth', async () => {
    const tool = {
      ...httpProjectTool,
      dslContent: [
        'get_gmail_data() -> object',
        '  description: "Get Gmail data"',
        '  type: http',
        '  endpoint: "https://api.example.com/gmail"',
        '  method: GET',
        '  auth_profile: "gmail_oauth_app"',
      ].join('\n'),
    };
    mockFindProjectToolById.mockResolvedValue(tool);
    mockExecute.mockResolvedValue({});
    mockAuthProfileFindOne.mockReturnValue(
      makeQueryResult({
        _id: 'oauth-app-1',
        tenantId: 'tenant-1',
        projectId: 'proj-1',
        name: 'gmail_oauth_app',
        authType: 'oauth2_app',
        connectionMode: 'per_user',
        connector: 'gmail',
        config: {},
        encryptedSecrets: JSON.stringify({ clientId: 'cid', clientSecret: 'csecret' }),
        updatedAt: new Date('2026-01-01T00:00:00.000Z'),
        expiresAt: null,
      }),
    );
    mockEndUserOAuthTokenFindOne.mockReturnValue(
      makeQueryResult({
        tenantId: 'tenant-1',
        userId: 'user-1',
        encryptedAccessToken: 'user-grant-token',
        encryptedRefreshToken: 'refresh-token',
        scope: 'read',
        expiresAt: new Date(Date.now() + 60_000),
        revokedAt: null,
      }),
    );
    mockApplyAuth.mockResolvedValue({
      headers: { Authorization: 'Bearer user-grant-token' },
      queryParams: new URLSearchParams(),
    });

    const executeToolTest = await getExecuteToolTest();
    await executeToolTest({
      toolId: 'tool-http-1',
      tenantId: 'tenant-1',
      userId: 'user-1',
      projectId: 'proj-1',
    });

    const constructorArg = MockToolBindingExecutor.mock.calls[0][0];
    const middleware = constructorArg.middleware[0];
    const next = vi.fn(async (ctx) => ({ result: ctx.tool }));
    await middleware({ tool: constructorArg.tools[0] }, next);

    expect(mockBuildAuthProfileOAuthProviderKey).toHaveBeenCalledWith('oauth-app-1');
    expect(mockEndUserOAuthTokenFindOne).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        userId: 'user-1',
        provider: 'auth-profile:oauth-app-1',
        revokedAt: null,
      }),
    );
    expect(mockApplyAuth).toHaveBeenCalledWith(
      expect.objectContaining({
        authType: 'oauth2_token',
        secrets: { accessToken: 'user-grant-token' },
      }),
    );
  });

  it('resolves shared oauth2_app grants using the __tenant__ principal', async () => {
    const tool = {
      ...httpProjectTool,
      dslContent: [
        'get_workspace_data() -> object',
        '  description: "Get workspace data"',
        '  type: http',
        '  endpoint: "https://api.example.com/workspace"',
        '  method: GET',
        '  auth_profile: "workspace_oauth_app"',
      ].join('\n'),
    };
    mockFindProjectToolById.mockResolvedValue(tool);
    mockExecute.mockResolvedValue({});
    mockAuthProfileFindOne.mockReturnValue(
      makeQueryResult({
        _id: 'oauth-app-2',
        tenantId: 'tenant-1',
        projectId: null,
        name: 'workspace_oauth_app',
        authType: 'oauth2_app',
        connectionMode: 'shared',
        connector: 'workspace-provider',
        config: {},
        encryptedSecrets: JSON.stringify({ clientId: 'cid', clientSecret: 'csecret' }),
        updatedAt: new Date('2026-01-01T00:00:00.000Z'),
        expiresAt: null,
      }),
    );
    mockEndUserOAuthTokenFindOne.mockReturnValue(
      makeQueryResult({
        tenantId: 'tenant-1',
        userId: '__tenant__',
        encryptedAccessToken: 'tenant-grant-token',
        encryptedRefreshToken: 'refresh-token',
        scope: 'read',
        expiresAt: new Date(Date.now() + 60_000),
        revokedAt: null,
      }),
    );
    mockApplyAuth.mockResolvedValue({
      headers: { Authorization: 'Bearer tenant-grant-token' },
      queryParams: new URLSearchParams(),
    });

    const executeToolTest = await getExecuteToolTest();
    await executeToolTest({
      toolId: 'tool-http-1',
      tenantId: 'tenant-1',
      userId: 'user-1',
      projectId: 'proj-1',
    });

    const constructorArg = MockToolBindingExecutor.mock.calls[0][0];
    const middleware = constructorArg.middleware[0];
    const next = vi.fn(async (ctx) => ({ result: ctx.tool }));
    await middleware({ tool: constructorArg.tools[0] }, next);

    expect(mockEndUserOAuthTokenFindOne).toHaveBeenCalledTimes(1);
    expect(mockEndUserOAuthTokenFindOne.mock.calls[0][0]).toMatchObject({ userId: '__tenant__' });
    expect(mockApplyAuth).toHaveBeenCalledWith(
      expect.objectContaining({
        authType: 'oauth2_token',
        secrets: { accessToken: 'tenant-grant-token' },
      }),
    );
  });

  it('uses caller principal as shared compatibility fallback when __tenant__ grant is missing', async () => {
    const tool = {
      ...httpProjectTool,
      dslContent: [
        'get_workspace_data() -> object',
        '  description: "Get workspace data"',
        '  type: http',
        '  endpoint: "https://api.example.com/workspace"',
        '  method: GET',
        '  auth_profile: "workspace_oauth_app_fallback"',
      ].join('\n'),
    };
    mockFindProjectToolById.mockResolvedValue(tool);
    mockExecute.mockResolvedValue({});
    mockAuthProfileFindOne.mockReturnValue(
      makeQueryResult({
        _id: 'oauth-app-2f',
        tenantId: 'tenant-1',
        projectId: null,
        name: 'workspace_oauth_app_fallback',
        authType: 'oauth2_app',
        connectionMode: 'shared',
        connector: 'workspace-provider',
        createdBy: 'owner-user-1',
        config: {},
        encryptedSecrets: JSON.stringify({ clientId: 'cid', clientSecret: 'csecret' }),
        updatedAt: new Date('2026-01-01T00:00:00.000Z'),
        expiresAt: null,
      }),
    );
    mockEndUserOAuthTokenFindOne.mockReturnValueOnce(makeQueryResult(null)).mockReturnValueOnce(
      makeQueryResult({
        tenantId: 'tenant-1',
        userId: 'user-1',
        encryptedAccessToken: 'user-fallback-grant-token',
        encryptedRefreshToken: 'refresh-token',
        scope: 'read',
        expiresAt: new Date(Date.now() + 60_000),
        revokedAt: null,
      }),
    );
    mockApplyAuth.mockResolvedValue({
      headers: { Authorization: 'Bearer user-fallback-grant-token' },
      queryParams: new URLSearchParams(),
    });

    const executeToolTest = await getExecuteToolTest();
    await executeToolTest({
      toolId: 'tool-http-1',
      tenantId: 'tenant-1',
      userId: 'user-1',
      projectId: 'proj-1',
    });

    const constructorArg = MockToolBindingExecutor.mock.calls[0][0];
    const middleware = constructorArg.middleware[0];
    const next = vi.fn(async (ctx) => ({ result: ctx.tool }));
    await middleware({ tool: constructorArg.tools[0] }, next);

    expect(mockEndUserOAuthTokenFindOne.mock.calls[0][0]).toMatchObject({ userId: '__tenant__' });
    expect(mockEndUserOAuthTokenFindOne.mock.calls[1][0]).toMatchObject({ userId: 'user-1' });
    expect(mockApplyAuth).toHaveBeenCalledWith(
      expect.objectContaining({
        authType: 'oauth2_token',
        secrets: { accessToken: 'user-fallback-grant-token' },
      }),
    );
  });

  it('honors tool-level shared connection mode when profile defaults to per_user', async () => {
    const tool = {
      ...httpProjectTool,
      dslContent: [
        'get_team_data() -> object',
        '  description: "Get team data"',
        '  type: http',
        '  endpoint: "https://api.example.com/team"',
        '  method: GET',
        '  auth_profile: "team_oauth_app"',
        '  connection: shared',
      ].join('\n'),
    };
    mockFindProjectToolById.mockResolvedValue(tool);
    mockExecute.mockResolvedValue({});
    mockAuthProfileFindOne.mockReturnValue(
      makeQueryResult({
        _id: 'oauth-app-2c',
        tenantId: 'tenant-1',
        projectId: 'proj-1',
        name: 'team_oauth_app',
        authType: 'oauth2_app',
        connectionMode: 'per_user',
        connector: 'workspace-provider',
        config: {},
        encryptedSecrets: JSON.stringify({ clientId: 'cid', clientSecret: 'csecret' }),
        updatedAt: new Date('2026-01-01T00:00:00.000Z'),
        expiresAt: null,
      }),
    );
    mockEndUserOAuthTokenFindOne.mockReturnValue(
      makeQueryResult({
        tenantId: 'tenant-1',
        userId: '__tenant__',
        encryptedAccessToken: 'tenant-grant-token',
        encryptedRefreshToken: 'refresh-token',
        scope: 'read',
        expiresAt: new Date(Date.now() + 60_000),
        revokedAt: null,
      }),
    );
    mockApplyAuth.mockResolvedValue({
      headers: { Authorization: 'Bearer tenant-grant-token' },
      queryParams: new URLSearchParams(),
    });

    const executeToolTest = await getExecuteToolTest();
    await executeToolTest({
      toolId: 'tool-http-1',
      tenantId: 'tenant-1',
      userId: 'user-1',
      projectId: 'proj-1',
    });

    const constructorArg = MockToolBindingExecutor.mock.calls[0][0];
    const middleware = constructorArg.middleware[0];
    const next = vi.fn(async (ctx) => ({ result: ctx.tool }));
    await middleware({ tool: constructorArg.tools[0] }, next);

    expect(mockEndUserOAuthTokenFindOne).toHaveBeenCalledTimes(1);
    expect(mockEndUserOAuthTokenFindOne.mock.calls[0][0]).toMatchObject({ userId: '__tenant__' });
    expect(mockApplyAuth).toHaveBeenCalledWith(
      expect.objectContaining({
        authType: 'oauth2_token',
        secrets: { accessToken: 'tenant-grant-token' },
      }),
    );
  });

  it('does not fall back to __tenant__ grant when connectionMode is per_user', async () => {
    const tool = {
      ...httpProjectTool,
      dslContent: [
        'get_personal_data() -> object',
        '  description: "Get personal data"',
        '  type: http',
        '  endpoint: "https://api.example.com/personal"',
        '  method: GET',
        '  auth_profile: "personal_oauth_app"',
      ].join('\n'),
    };
    mockFindProjectToolById.mockResolvedValue(tool);
    mockExecute.mockResolvedValue({});
    mockAuthProfileFindOne.mockReturnValue(
      makeQueryResult({
        _id: 'oauth-app-2b',
        tenantId: 'tenant-1',
        projectId: 'proj-1',
        name: 'personal_oauth_app',
        authType: 'oauth2_app',
        connectionMode: 'per_user',
        connector: 'workspace-provider',
        config: {},
        encryptedSecrets: JSON.stringify({ clientId: 'cid', clientSecret: 'csecret' }),
        updatedAt: new Date('2026-01-01T00:00:00.000Z'),
        expiresAt: null,
      }),
    );
    mockEndUserOAuthTokenFindOne.mockReturnValue(makeQueryResult(null));

    const executeToolTest = await getExecuteToolTest();
    await executeToolTest({
      toolId: 'tool-http-1',
      tenantId: 'tenant-1',
      userId: 'user-1',
      projectId: 'proj-1',
    });

    const constructorArg = MockToolBindingExecutor.mock.calls[0][0];
    const middleware = constructorArg.middleware[0];
    const simulatedError = await middleware({ tool: constructorArg.tools[0] }, vi.fn()).catch(
      (err: unknown) => err,
    );

    mockExecute.mockRejectedValueOnce(simulatedError);
    const reauthResult = await executeToolTest({
      toolId: 'tool-http-1',
      tenantId: 'tenant-1',
      userId: 'user-1',
      projectId: 'proj-1',
    });

    expect(mockEndUserOAuthTokenFindOne).toHaveBeenCalledTimes(1);
    expect(mockEndUserOAuthTokenFindOne.mock.calls[0][0]).toMatchObject({ userId: 'user-1' });
    expect(reauthResult.errorCode).toBe('OAUTH_REAUTH_REQUIRED');
    expect(reauthResult.response?.status).toBe(401);
  });

  it('returns OAUTH_REAUTH_REQUIRED when no oauth grant exists', async () => {
    const tool = {
      ...httpProjectTool,
      dslContent: [
        'get_shared_data() -> object',
        '  description: "Get shared data"',
        '  type: http',
        '  endpoint: "https://api.example.com/shared"',
        '  method: GET',
        '  auth_profile: "missing_oauth_app"',
      ].join('\n'),
    };
    mockFindProjectToolById.mockResolvedValue(tool);
    mockExecute.mockResolvedValue({});
    mockAuthProfileFindOne.mockReturnValue(
      makeQueryResult({
        _id: 'oauth-app-2c',
        tenantId: 'tenant-1',
        projectId: null,
        name: 'missing_oauth_app',
        authType: 'oauth2_app',
        connectionMode: 'shared',
        connector: 'shared-provider',
        config: {},
        encryptedSecrets: JSON.stringify({ clientId: 'cid', clientSecret: 'csecret' }),
        updatedAt: new Date('2026-01-01T00:00:00.000Z'),
        expiresAt: null,
      }),
    );
    mockEndUserOAuthTokenFindOne.mockReturnValue(makeQueryResult(null));

    const executeToolTest = await getExecuteToolTest();
    await executeToolTest({
      toolId: 'tool-http-1',
      tenantId: 'tenant-1',
      userId: 'user-1',
      projectId: 'proj-1',
    });

    const constructorArg = MockToolBindingExecutor.mock.calls[0][0];
    const middleware = constructorArg.middleware[0];
    const simulatedError = await middleware({ tool: constructorArg.tools[0] }, vi.fn()).catch(
      (err: unknown) => err,
    );

    mockExecute.mockRejectedValueOnce(simulatedError);
    const reauthResult = await executeToolTest({
      toolId: 'tool-http-1',
      tenantId: 'tenant-1',
      userId: 'user-1',
      projectId: 'proj-1',
    });

    expect(mockEndUserOAuthTokenFindOne).toHaveBeenCalled();
    expect(mockEndUserOAuthTokenFindOne.mock.calls[0][0]).toMatchObject({ userId: '__tenant__' });
    expect(reauthResult.errorCode).toBe('OAUTH_REAUTH_REQUIRED');
    expect(reauthResult.response?.status).toBe(401);
  });

  it('restores legacy oauth test failure when STUDIO_TEST_OAUTH_GRANT_ENABLED=false', async () => {
    const previousFlag = process.env.STUDIO_TEST_OAUTH_GRANT_ENABLED;
    process.env.STUDIO_TEST_OAUTH_GRANT_ENABLED = 'false';

    try {
      const tool = {
        ...httpProjectTool,
        dslContent: [
          'get_disabled_oauth() -> object',
          '  description: "Disabled oauth test flow"',
          '  type: http',
          '  endpoint: "https://api.example.com/oauth-disabled"',
          '  method: GET',
          '  auth_profile: "disabled_oauth_app"',
        ].join('\n'),
      };
      mockFindProjectToolById.mockResolvedValue(tool);
      mockExecute.mockResolvedValue({});
      mockAuthProfileFindOne.mockReturnValue(
        makeQueryResult({
          _id: 'oauth-app-2d',
          tenantId: 'tenant-1',
          projectId: 'proj-1',
          name: 'disabled_oauth_app',
          authType: 'oauth2_app',
          connectionMode: 'shared',
          connector: 'disabled-provider',
          config: {},
          encryptedSecrets: JSON.stringify({ clientId: 'cid', clientSecret: 'csecret' }),
          updatedAt: new Date('2026-01-01T00:00:00.000Z'),
          expiresAt: null,
        }),
      );

      const executeToolTest = await getExecuteToolTest();
      await executeToolTest({
        toolId: 'tool-http-1',
        tenantId: 'tenant-1',
        userId: 'user-1',
        projectId: 'proj-1',
      });

      const constructorArg = MockToolBindingExecutor.mock.calls[0][0];
      const middleware = constructorArg.middleware[0];
      const simulatedError = await middleware({ tool: constructorArg.tools[0] }, vi.fn()).catch(
        (err: unknown) => err,
      );

      expect(mockEndUserOAuthTokenFindOne).not.toHaveBeenCalled();
      expect(simulatedError).toBeInstanceOf(Error);
      expect((simulatedError as Error).message).toContain(
        'does not yet support OAuth grant-backed auth profile',
      );

      mockExecute.mockRejectedValueOnce(simulatedError);
      const result = await executeToolTest({
        toolId: 'tool-http-1',
        tenantId: 'tenant-1',
        userId: 'user-1',
        projectId: 'proj-1',
      });

      expect(result.error).toContain('does not yet support OAuth grant-backed auth profile');
      expect(result.response?.status).toBe(500);
    } finally {
      if (previousFlag === undefined) {
        delete process.env.STUDIO_TEST_OAUTH_GRANT_ENABLED;
      } else {
        process.env.STUDIO_TEST_OAUTH_GRANT_ENABLED = previousFlag;
      }
    }
  });

  it('refreshes expired oauth grants before applying auth', async () => {
    const tool = {
      ...httpProjectTool,
      dslContent: [
        'get_drive_data() -> object',
        '  description: "Get Drive data"',
        '  type: http',
        '  endpoint: "https://api.example.com/drive"',
        '  method: GET',
        '  auth_profile: "drive_oauth_app"',
      ].join('\n'),
    };
    mockFindProjectToolById.mockResolvedValue(tool);
    mockExecute.mockResolvedValue({});
    mockAuthProfileFindOne.mockReturnValue(
      makeQueryResult({
        _id: 'oauth-app-3',
        tenantId: 'tenant-1',
        projectId: 'proj-1',
        name: 'drive_oauth_app',
        authType: 'oauth2_app',
        connectionMode: 'shared',
        connector: 'drive',
        config: {},
        encryptedSecrets: JSON.stringify({ clientId: 'cid', clientSecret: 'csecret' }),
        updatedAt: new Date('2026-01-01T00:00:00.000Z'),
        expiresAt: null,
      }),
    );
    mockEndUserOAuthTokenFindOne.mockReturnValue(
      makeQueryResult({
        tenantId: 'tenant-1',
        userId: '__tenant__',
        encryptedAccessToken: 'expired-token',
        encryptedRefreshToken: 'refresh-token',
        scope: 'read',
        expiresAt: new Date(Date.now() - 10_000),
        revokedAt: null,
      }),
    );
    mockRefreshOAuth2Token.mockResolvedValue({
      accessToken: 'refreshed-drive-token',
      refreshed: true,
    });
    mockApplyAuth.mockResolvedValue({
      headers: { Authorization: 'Bearer refreshed-drive-token' },
      queryParams: new URLSearchParams(),
    });

    const executeToolTest = await getExecuteToolTest();
    await executeToolTest({
      toolId: 'tool-http-1',
      tenantId: 'tenant-1',
      userId: 'user-1',
      projectId: 'proj-1',
    });

    const constructorArg = MockToolBindingExecutor.mock.calls[0][0];
    const middleware = constructorArg.middleware[0];
    const next = vi.fn(async (ctx) => ({ result: ctx.tool }));
    await middleware({ tool: constructorArg.tools[0] }, next);

    expect(mockRefreshOAuth2Token).toHaveBeenCalledWith(
      expect.objectContaining({
        profileId: 'oauth-app-3',
        tenantId: 'tenant-1',
        userId: '__tenant__',
        authScope: 'tenant',
        connectionMode: 'shared',
      }),
    );
    expect(mockApplyAuth).toHaveBeenCalledWith(
      expect.objectContaining({
        authType: 'oauth2_token',
        secrets: { accessToken: 'refreshed-drive-token' },
      }),
    );
  });

  it('returns structured OAUTH_REAUTH_REQUIRED output when grant refresh fails', async () => {
    const tool = {
      ...httpProjectTool,
      dslContent: [
        'get_docs_data() -> object',
        '  description: "Get Docs data"',
        '  type: http',
        '  endpoint: "https://api.example.com/docs"',
        '  method: GET',
        '  auth_profile: "docs_oauth_app"',
      ].join('\n'),
    };
    mockFindProjectToolById.mockResolvedValue(tool);
    mockExecute.mockResolvedValue({});
    mockAuthProfileFindOne.mockReturnValue(
      makeQueryResult({
        _id: 'oauth-app-4',
        tenantId: 'tenant-1',
        projectId: 'proj-1',
        name: 'docs_oauth_app',
        authType: 'oauth2_app',
        connectionMode: 'shared',
        connector: 'google-docs',
        config: {},
        encryptedSecrets: JSON.stringify({ clientId: 'cid', clientSecret: 'csecret' }),
        updatedAt: new Date('2026-01-01T00:00:00.000Z'),
        expiresAt: null,
      }),
    );
    mockEndUserOAuthTokenFindOne.mockReturnValue(
      makeQueryResult({
        tenantId: 'tenant-1',
        userId: '__tenant__',
        encryptedAccessToken: 'expired-token',
        encryptedRefreshToken: 'refresh-token',
        scope: 'read',
        expiresAt: new Date(Date.now() - 10_000),
        revokedAt: null,
      }),
    );
    mockRefreshOAuth2Token.mockRejectedValueOnce(new Error('refresh denied'));

    const executeToolTest = await getExecuteToolTest();
    await executeToolTest({
      toolId: 'tool-http-1',
      tenantId: 'tenant-1',
      userId: 'user-1',
      projectId: 'proj-1',
    });

    const constructorArg = MockToolBindingExecutor.mock.calls[0][0];
    const middleware = constructorArg.middleware[0];
    const simulatedError = await middleware({ tool: constructorArg.tools[0] }, vi.fn()).catch(
      (err: unknown) => err,
    );

    mockExecute.mockRejectedValueOnce(simulatedError);
    const reauthResult = await executeToolTest({
      toolId: 'tool-http-1',
      tenantId: 'tenant-1',
      userId: 'user-1',
      projectId: 'proj-1',
    });

    expect(reauthResult.errorCode).toBe('OAUTH_REAUTH_REQUIRED');
    expect(reauthResult.response?.status).toBe(401);
    expect(reauthResult.oauthReauth).toEqual({
      authProfileId: 'oauth-app-4',
      profileName: 'docs_oauth_app',
      connectorName: 'google-docs',
      scope: 'project',
    });
  });

  it('unwraps wrapped OAuth reauth errors from ToolExecutionError.cause', async () => {
    const tool = {
      ...httpProjectTool,
      dslContent: [
        'get_mail_data() -> object',
        '  description: "Get Mail data"',
        '  type: http',
        '  endpoint: "https://api.example.com/mail"',
        '  method: GET',
        '  auth_profile: "mail_oauth_app"',
      ].join('\n'),
    };
    mockFindProjectToolById.mockResolvedValue(tool);
    mockExecute.mockResolvedValue({});
    mockAuthProfileFindOne.mockReturnValue(
      makeQueryResult({
        _id: 'oauth-app-5',
        tenantId: 'tenant-1',
        projectId: 'proj-1',
        name: 'mail_oauth_app',
        authType: 'oauth2_app',
        connectionMode: 'per_user',
        connector: 'gmail',
        config: {},
        encryptedSecrets: JSON.stringify({ clientId: 'cid', clientSecret: 'csecret' }),
        updatedAt: new Date('2026-01-01T00:00:00.000Z'),
        expiresAt: null,
      }),
    );
    mockEndUserOAuthTokenFindOne.mockReturnValue(makeQueryResult(null));

    const executeToolTest = await getExecuteToolTest();
    await executeToolTest({
      toolId: 'tool-http-1',
      tenantId: 'tenant-1',
      userId: 'user-1',
      projectId: 'proj-1',
    });

    const constructorArg = MockToolBindingExecutor.mock.calls[0][0];
    const middleware = constructorArg.middleware[0];
    const oauthReauthError = await middleware({ tool: constructorArg.tools[0] }, vi.fn()).catch(
      (err: unknown) => err,
    );

    const wrappedError = new MockToolExecutionError({
      code: 'TOOL_EXECUTION_ERROR',
      message: 'Tool weather_api failed: internal error',
      toolName: 'weather_api',
      statusCode: 500,
      cause: oauthReauthError,
    });
    mockExecute.mockRejectedValueOnce(wrappedError);

    const result = await executeToolTest({
      toolId: 'tool-http-1',
      tenantId: 'tenant-1',
      userId: 'user-1',
      projectId: 'proj-1',
    });

    expect(result.errorCode).toBe('OAUTH_REAUTH_REQUIRED');
    expect(result.response?.status).toBe(401);
    expect(result.oauthReauth).toEqual({
      authProfileId: 'oauth-app-5',
      profileName: 'mail_oauth_app',
      connectorName: 'gmail',
      scope: 'project',
    });
  });
});

describe('executeToolTest — config variable resolution', () => {
  it('falls back to the project default namespace for legacy tools without namespace metadata', async () => {
    const tool = {
      ...httpProjectTool,
      description: null,
      variableNamespaceIds: [],
      dslContent: [
        'send_event() -> object',
        '  description: "Send event"',
        '  type: http',
        '  endpoint: "{{config.URL}}/api/v1/process/{{config.APP_ID}}"',
        '  method: GET',
      ].join('\n'),
    };

    const configValues: Record<string, string> = {
      URL: 'https://process.kore.ai',
      APP_ID: 'a-70423854-64a4-5ae9-b3fe-1b7ba0b25732',
    };

    mockFindProjectToolById.mockResolvedValue(tool);
    mockExecute.mockResolvedValue({ ok: true });
    mockVariableNamespaceFindOne.mockReturnValue(makeQueryResult({ _id: 'ns-default' }));
    mockProjectConfigVariableFindOne.mockImplementation((query: { key?: string }) =>
      makeQueryResult(
        query.key && configValues[query.key]
          ? { _id: `cfg-${query.key}`, value: configValues[query.key] }
          : null,
      ),
    );
    mockVariableNamespaceMembershipFindOne.mockImplementation((query: { namespaceId?: unknown }) =>
      makeQueryResult(
        JSON.stringify(query.namespaceId) === JSON.stringify({ $in: ['ns-default'] })
          ? { namespaceId: 'ns-default' }
          : null,
      ),
    );

    const executeToolTest = await getExecuteToolTest();
    await executeToolTest({
      toolId: 'tool-http-1',
      tenantId: 'tenant-1',
      userId: 'user-1',
      projectId: 'proj-1',
    });

    const constructorArg = MockToolBindingExecutor.mock.calls[0][0];
    const toolDef = constructorArg.tools[0];

    expect(mockVariableNamespaceFindOne).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      isDefault: true,
    });
    expect(toolDef.variable_namespace_ids).toEqual(['ns-default']);
    expect(toolDef.http_binding.endpoint).toBe(
      'https://process.kore.ai/api/v1/process/a-70423854-64a4-5ae9-b3fe-1b7ba0b25732',
    );
    expect(MockToolBindingExecutor).toHaveBeenCalled();
  });

  it('creates the project default namespace before resolving legacy tool config variables', async () => {
    const tool = {
      ...httpProjectTool,
      description: null,
      variableNamespaceIds: [],
      dslContent: [
        'send_event() -> object',
        '  description: "Send event"',
        '  type: http',
        '  endpoint: "{{config.API_BASE}}/events"',
        '  method: GET',
      ].join('\n'),
    };

    mockFindProjectToolById.mockResolvedValue(tool);
    mockExecute.mockResolvedValue({ ok: true });
    mockVariableNamespaceFindOne.mockReturnValue(makeQueryResult(null));
    mockVariableNamespaceCreate.mockResolvedValue({
      toObject: () => ({
        _id: 'ns-created-default',
        tenantId: 'tenant-1',
        projectId: 'proj-1',
        isDefault: true,
      }),
    });
    mockProjectConfigVariableFindOne.mockImplementation((query: { key?: string }) =>
      makeQueryResult(
        query.key === 'API_BASE' ? { _id: 'cfg-API_BASE', value: 'https://api.example.com' } : null,
      ),
    );
    mockVariableNamespaceMembershipFindOne.mockImplementation((query: { namespaceId?: unknown }) =>
      makeQueryResult(
        JSON.stringify(query.namespaceId) === JSON.stringify({ $in: ['ns-created-default'] })
          ? { namespaceId: 'ns-created-default' }
          : null,
      ),
    );

    const executeToolTest = await getExecuteToolTest();
    await executeToolTest({
      toolId: 'tool-http-1',
      tenantId: 'tenant-1',
      userId: 'user-1',
      projectId: 'proj-1',
    });

    const constructorArg = MockToolBindingExecutor.mock.calls[0][0];
    const toolDef = constructorArg.tools[0];

    expect(mockVariableNamespaceCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        projectId: 'proj-1',
        name: 'default',
        isDefault: true,
      }),
    );
    expect(toolDef.variable_namespace_ids).toEqual(['ns-created-default']);
    expect(toolDef.http_binding.endpoint).toBe('https://api.example.com/events');
  });

  it('resolves namespace-scoped config variables in tool bindings while preserving auth_profile_ref', async () => {
    const tool = {
      ...httpProjectTool,
      description: null,
      variableNamespaceIds: ['ns-tools'],
      dslContent: [
        'send_event(message: string) -> object',
        '  description: "Send event to {{config.ENV_NAME}}"',
        '  type: http',
        '  endpoint: "{{config.API_BASE}}/events"',
        '  method: POST',
        '  query_params:',
        '    org: "{{config.ORG_ID}}"',
        '  headers:',
        '    X-Region: "{{config.REGION}}"',
        '  body: |',
        '    { "environment": "{{config.ENV_NAME}}", "message": "{{input.message}}" }',
        '  auth_profile: "{{config.CRM_AUTH_PROFILE}}"',
      ].join('\n'),
    };

    const configValues: Record<string, string> = {
      API_BASE: 'https://api.example.com',
      ORG_ID: 'acme-123',
      REGION: 'us-east-1',
      ENV_NAME: 'production',
      CRM_AUTH_PROFILE: 'crm_profile_live',
    };

    mockFindProjectToolById.mockResolvedValue(tool);
    mockExecute.mockResolvedValue({ ok: true });
    mockProjectConfigVariableFindOne.mockImplementation((query: { key?: string }) =>
      makeQueryResult(
        query.key && configValues[query.key]
          ? { _id: `cfg-${query.key}`, value: configValues[query.key] }
          : null,
      ),
    );
    mockVariableNamespaceMembershipFindOne.mockImplementation((query: { variableId?: string }) =>
      makeQueryResult(
        typeof query.variableId === 'string' && query.variableId.startsWith('cfg-')
          ? { namespaceId: 'ns-tools' }
          : null,
      ),
    );

    const executeToolTest = await getExecuteToolTest();
    const result = await executeToolTest({
      toolId: 'tool-http-1',
      tenantId: 'tenant-1',
      userId: 'user-1',
      projectId: 'proj-1',
      input: { message: 'hello' },
    });

    const constructorArg = MockToolBindingExecutor.mock.calls[0][0];
    const toolDef = constructorArg.tools[0];

    expect(toolDef.description).toBe('Send event to production');
    expect(toolDef.http_binding.endpoint).toBe('https://api.example.com/events');
    expect(toolDef.http_binding.query_params).toEqual({ org: 'acme-123' });
    expect(toolDef.http_binding.headers).toEqual({ 'X-Region': 'us-east-1' });
    expect(toolDef.http_binding.body_template).toBe(
      '{ "environment": "production", "message": "{{input.message}}" }',
    );
    expect(toolDef.auth_profile_ref).toBe('{{config.CRM_AUTH_PROFILE}}');

    expect(result.request!.url).toContain('https://api.example.com/events?');
    expect(result.request!.url).toContain('org=acme-123');
    expect(result.request!.headers!['X-Region']).toBe('us-east-1');
    expect(result.request!.body).toBe('{ "environment": "production", "message": "hello" }');
    expect(
      mockVariableNamespaceMembershipFindOne.mock.calls.every(
        ([query]) => query.tenantId === 'tenant-1' && query.projectId === 'proj-1',
      ),
    ).toBe(true);
  });

  it('provides getConfigVar to the executor secrets provider for late compiler resolution', async () => {
    const tool = {
      ...httpProjectTool,
      variableNamespaceIds: ['ns-tools'],
    };

    mockFindProjectToolById.mockResolvedValue(tool);
    mockExecute.mockResolvedValue({ ok: true });
    mockProjectConfigVariableFindOne.mockImplementation((query: { key?: string }) =>
      makeQueryResult(
        query.key === 'LATE_BOUND'
          ? { _id: 'cfg-LATE_BOUND', value: 'https://late.example.com' }
          : null,
      ),
    );
    mockVariableNamespaceMembershipFindOne.mockImplementation((query: { variableId?: string }) =>
      makeQueryResult(query.variableId === 'cfg-LATE_BOUND' ? { namespaceId: 'ns-tools' } : null),
    );

    const executeToolTest = await getExecuteToolTest();
    await executeToolTest({
      toolId: 'tool-http-1',
      tenantId: 'tenant-1',
      userId: 'user-1',
      projectId: 'proj-1',
    });

    const constructorArg = MockToolBindingExecutor.mock.calls[0][0];
    await expect(constructorArg.secrets.getConfigVar('LATE_BOUND')).resolves.toBe(
      'https://late.example.com',
    );
    expect(mockVariableNamespaceMembershipFindOne).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      variableId: 'cfg-LATE_BOUND',
      variableType: 'config',
      namespaceId: { $in: ['ns-tools'] },
    });
  });

  it('resolves default namespace hostname config variables before SSRF validation', async () => {
    const tool = {
      ...httpProjectTool,
      variableNamespaceIds: [],
      dslContent: [
        'list_models() -> object',
        '  description: "List models"',
        '  type: http',
        '  endpoint: "https://{{config.URL3}}/v1/models"',
        '  method: GET',
      ].join('\n'),
    };

    mockFindProjectToolById.mockResolvedValue(tool);
    mockExecute.mockResolvedValue({ ok: true });
    mockVariableNamespaceFindOne.mockReturnValue(makeQueryResult({ _id: 'ns-default' }));
    mockProjectConfigVariableFindOne.mockImplementation((query: { key?: string }) =>
      makeQueryResult(query.key === 'URL3' ? { _id: 'cfg-URL3', value: 'api.openai.com' } : null),
    );
    mockVariableNamespaceMembershipFindOne.mockImplementation((query: { namespaceId?: unknown }) =>
      makeQueryResult(
        JSON.stringify(query.namespaceId) === JSON.stringify({ $in: ['ns-default'] })
          ? { namespaceId: 'ns-default' }
          : null,
      ),
    );

    const executeToolTest = await getExecuteToolTest();
    await executeToolTest({
      toolId: 'tool-http-1',
      tenantId: 'tenant-1',
      userId: 'user-1',
      projectId: 'proj-1',
    });

    const constructorArg = MockToolBindingExecutor.mock.calls[0][0];
    const toolDef = constructorArg.tools[0];

    expect(toolDef.variable_namespace_ids).toEqual(['ns-default']);
    expect(toolDef.http_binding.endpoint).toBe('https://api.openai.com/v1/models');
  });

  it('fails closed when config variables remain unresolved in direct tool tests', async () => {
    const tool = {
      ...httpProjectTool,
      variableNamespaceIds: ['ns-tools'],
      dslContent: [
        'get_data() -> object',
        '  description: "Get data"',
        '  type: http',
        '  endpoint: "{{config.API_BASE}}/data"',
        '  method: GET',
      ].join('\n'),
    };

    mockFindProjectToolById.mockResolvedValue(tool);

    const executeToolTest = await getExecuteToolTest();
    const result = await executeToolTest({
      toolId: 'tool-http-1',
      tenantId: 'tenant-1',
      userId: 'user-1',
      projectId: 'proj-1',
    });

    expect(result.error).toContain('Undefined config variable "API_BASE"');
    expect(result.output).toBeNull();
    expect(MockToolBindingExecutor).not.toHaveBeenCalled();
  });
});

describe('executeToolTest — logs and trace', () => {
  it('returns logs array in output', async () => {
    mockFindProjectToolById.mockResolvedValue(httpProjectTool);
    mockExecute.mockResolvedValue({});

    const executeToolTest = await getExecuteToolTest();
    const result = await executeToolTest({
      toolId: 'tool-http-1',
      tenantId: 'tenant-1',
      userId: 'user-1',
      projectId: 'proj-1',
    });

    expect(Array.isArray(result.logs)).toBe(true);
  });

  it('creates executor with logging middleware', async () => {
    mockFindProjectToolById.mockResolvedValue(httpProjectTool);
    mockExecute.mockResolvedValue({});

    const executeToolTest = await getExecuteToolTest();
    await executeToolTest({
      toolId: 'tool-http-1',
      tenantId: 'tenant-1',
      userId: 'user-1',
      projectId: 'proj-1',
    });

    expect(mockLoggingMiddleware).toHaveBeenCalled();
    expect(MockToolBindingExecutor).toHaveBeenCalledWith(
      expect.objectContaining({
        middleware: [
          expect.any(Function),
          'logging-middleware-stub',
          'secret-scrubber-middleware-stub',
        ],
      }),
    );
  });
});

// ===========================================================================
// SOAP display headers
// ===========================================================================

const soapProjectTool = {
  id: 'tool-soap-1',
  name: 'number_to_words',
  slug: 'number_to_words',
  toolType: 'http',
  description: 'Converts a number to words',
  dslContent: [
    'number_to_words(ubiNum: integer) -> object',
    '  description: "Converts a number to words via SOAP"',
    '  type: http',
    '  endpoint: "https://www.dataaccess.com/webservicesserver/numberconversion.wso"',
    '  method: POST',
    '  protocol: soap',
    '  soap_version: 1.1',
    '  soap_action: "http://www.dataaccess.com/webservicesserver/NumberToWords"',
    '  body: |',
    '    <NumberToWords xmlns="http://www.dataaccess.com/webservicesserver/">',
    '      <ubiNum>{{input.ubiNum}}</ubiNum>',
    '    </NumberToWords>',
  ].join('\n'),
  sourceHash: 'c'.repeat(64),
  projectId: 'proj-1',
  tenantId: 'tenant-1',
  createdBy: 'user-1',
  createdAt: '2025-01-01',
  updatedAt: '2025-01-01',
};

const soap12ProjectTool = {
  ...soapProjectTool,
  id: 'tool-soap-2',
  dslContent: soapProjectTool.dslContent.replace('soap_version: 1.1', 'soap_version: 1.2'),
};

describe('executeToolTest — SOAP display headers', () => {
  it('shows correct Content-Type and quoted SOAPAction for SOAP 1.1', async () => {
    mockFindProjectToolById.mockResolvedValue(soapProjectTool);
    mockExecute.mockResolvedValue({ result: 'one hundred twenty-three' });

    const executeToolTest = await getExecuteToolTest();
    const result = await executeToolTest({
      toolId: 'tool-soap-1',
      tenantId: 'tenant-1',
      userId: 'user-1',
      projectId: 'proj-1',
      input: { ubiNum: 123 },
    });

    expect(result.request!.headers!['Content-Type']).toBe('text/xml; charset=utf-8');
    expect(result.request!.headers!['SOAPAction']).toBe(
      '"http://www.dataaccess.com/webservicesserver/NumberToWords"',
    );
  });

  it('embeds action in Content-Type for SOAP 1.2, omits SOAPAction header', async () => {
    mockFindProjectToolById.mockResolvedValue(soap12ProjectTool);
    mockExecute.mockResolvedValue({ result: 'one hundred twenty-three' });

    const executeToolTest = await getExecuteToolTest();
    const result = await executeToolTest({
      toolId: 'tool-soap-2',
      tenantId: 'tenant-1',
      userId: 'user-1',
      projectId: 'proj-1',
      input: { ubiNum: 123 },
    });

    expect(result.request!.headers!['Content-Type']).toContain('application/soap+xml');
    expect(result.request!.headers!['Content-Type']).toContain(
      'action="http://www.dataaccess.com/webservicesserver/NumberToWords"',
    );
    expect(result.request!.headers!['SOAPAction']).toBeUndefined();
  });
});

// ===========================================================================
// Response status code propagation
// ===========================================================================

describe('executeToolTest — response status codes', () => {
  it('maps TOOL_TIMEOUT to HTTP 504 Gateway Timeout', async () => {
    mockFindProjectToolById.mockResolvedValue(httpProjectTool);
    mockExecute.mockRejectedValue(
      new MockToolExecutionError({
        code: 'TOOL_TIMEOUT',
        message: "Tool 'weather_api' timed out after 15000ms — endpoint did not respond",
        toolName: 'weather_api',
        retryable: true,
      }),
    );

    const executeToolTest = await getExecuteToolTest();
    const result = await executeToolTest({
      toolId: 'tool-http-1',
      tenantId: 'tenant-1',
      userId: 'user-1',
      projectId: 'proj-1',
    });

    expect(result.response!.status).toBe(504);
    expect(result.response!.statusText).toBe('Gateway Timeout');
  });

  it('maps TOOL_NETWORK_ERROR to HTTP 503 Service Unavailable', async () => {
    mockFindProjectToolById.mockResolvedValue(httpProjectTool);
    mockExecute.mockRejectedValue(
      new MockToolExecutionError({
        code: 'TOOL_NETWORK_ERROR',
        message: "Tool 'weather_api' network error: connection refused",
        toolName: 'weather_api',
        retryable: true,
      }),
    );

    const executeToolTest = await getExecuteToolTest();
    const result = await executeToolTest({
      toolId: 'tool-http-1',
      tenantId: 'tenant-1',
      userId: 'user-1',
      projectId: 'proj-1',
    });

    expect(result.response!.status).toBe(503);
    expect(result.response!.statusText).toBe('Service Unavailable');
  });

  it('uses real HTTP statusCode from TOOL_HTTP_ERROR', async () => {
    mockFindProjectToolById.mockResolvedValue(httpProjectTool);
    mockExecute.mockRejectedValue(
      new MockToolExecutionError({
        code: 'TOOL_HTTP_ERROR',
        message: 'POST https://api.weather.com: HTTP 401 — Unauthorized',
        toolName: 'weather_api',
        retryable: false,
        statusCode: 401,
      }),
    );

    const executeToolTest = await getExecuteToolTest();
    const result = await executeToolTest({
      toolId: 'tool-http-1',
      tenantId: 'tenant-1',
      userId: 'user-1',
      projectId: 'proj-1',
    });

    expect(result.response!.status).toBe(401);
    expect(result.response!.statusText).toBe('Unauthorized');
  });

  it('maps TOOL_SOAP_FAULT to HTTP 200 (SOAP faults are application-level)', async () => {
    mockFindProjectToolById.mockResolvedValue(soapProjectTool);
    mockExecute.mockRejectedValue(
      new MockToolExecutionError({
        code: 'TOOL_SOAP_FAULT',
        message: 'Policy not found',
        toolName: 'number_to_words',
        retryable: false,
      }),
    );

    const executeToolTest = await getExecuteToolTest();
    const result = await executeToolTest({
      toolId: 'tool-soap-1',
      tenantId: 'tenant-1',
      userId: 'user-1',
      projectId: 'proj-1',
    });

    expect(result.response!.status).toBe(200);
    expect(result.response!.statusText).toBe('OK');
    expect(result.errorCode).toBe('TOOL_SOAP_FAULT');
  });

  it('falls back to 500 for unknown generic errors', async () => {
    mockFindProjectToolById.mockResolvedValue(httpProjectTool);
    mockExecute.mockRejectedValue(new Error('Connection refused'));

    const executeToolTest = await getExecuteToolTest();
    const result = await executeToolTest({
      toolId: 'tool-http-1',
      tenantId: 'tenant-1',
      userId: 'user-1',
      projectId: 'proj-1',
    });

    expect(result.response!.status).toBe(500);
    expect(result.response!.statusText).toBe('Internal Server Error');
  });
});
