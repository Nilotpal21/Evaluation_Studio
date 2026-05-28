/**
 * Tests for MCP Discovery Service
 *
 * Covers:
 *   discoverPreview()      — connects to server, lists tools, disconnects
 *   discoverAndPersist()   — discovers + creates/updates project_tools records
 *   testConnection()       — connect + disconnect with latency
 *   testMcpTool()          — connect, call tool, return result, disconnect
 *   listDiscoveredTools()  — queries project_tools by server prefix
 *   getDiscoveredTool()    — single tool lookup
 *   Error paths            — server not found, connection failures, config errors
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — Shared repos
// ---------------------------------------------------------------------------

const mockFindMcpServerConfigById = vi.fn();
const mockFindProjectToolByName = vi.fn();
const mockFindProjectToolsByProject = vi.fn();
const mockCreateProjectTool = vi.fn();
const mockUpdateProjectTool = vi.fn();
const mockUpdateMcpServerConnectionStatus = vi.fn();
const mockFindProjectToolById = vi.fn();
const mockRefreshProjectAgentDraftMetadataForToolMutation = vi.fn().mockResolvedValue(undefined);
const mockGetOrCreateDefaultVariableNamespaceIds = vi.fn();

vi.mock('@agent-platform/shared/repos', () => ({
  findMcpServerConfigById: (...args: unknown[]) => mockFindMcpServerConfigById(...args),
  findProjectToolByName: (...args: unknown[]) => mockFindProjectToolByName(...args),
  findProjectToolsByProject: (...args: unknown[]) => mockFindProjectToolsByProject(...args),
  createProjectTool: (...args: unknown[]) => mockCreateProjectTool(...args),
  updateProjectTool: (...args: unknown[]) => mockUpdateProjectTool(...args),
  updateMcpServerConnectionStatus: (...args: unknown[]) =>
    mockUpdateMcpServerConnectionStatus(...args),
  findProjectToolById: (...args: unknown[]) => mockFindProjectToolById(...args),
}));

vi.mock('@/lib/project-tool-draft-invalidation', () => ({
  refreshProjectAgentDraftMetadataForToolMutation: (...args: unknown[]) =>
    mockRefreshProjectAgentDraftMetadataForToolMutation(...args),
}));

vi.mock('@/lib/default-variable-namespace', () => ({
  getOrCreateDefaultVariableNamespaceIds: (...args: unknown[]) =>
    mockGetOrCreateDefaultVariableNamespaceIds(...args),
}));

// ---------------------------------------------------------------------------
// Mocks — Shared utilities
// ---------------------------------------------------------------------------

const mockComputeSourceHash = vi.fn().mockReturnValue('a'.repeat(64));
const mockSerializeToolFormToDsl = vi.fn().mockReturnValue('mock_tool() -> object\n  type: mcp');

vi.mock('@agent-platform/shared', () => ({
  isRecord: (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v),
  computeSourceHash: (...args: unknown[]) => mockComputeSourceHash(...args),
  serializeToolFormToDsl: (...args: unknown[]) => mockSerializeToolFormToDsl(...args),
}));

// ---------------------------------------------------------------------------
// Mocks — MCPServerRegistryService + EncryptionService
// ---------------------------------------------------------------------------

const mockGetServerConfigs = vi.fn();

vi.mock('@agent-platform/shared/services/mcp-registry', () => {
  function MockMCPServerRegistryService() {
    return { getServerConfigs: (...args: unknown[]) => mockGetServerConfigs(...args) };
  }
  return { MCPServerRegistryService: MockMCPServerRegistryService };
});

vi.mock('@agent-platform/shared/encryption', () => {
  class MockEncryptionService {}
  return {
    EncryptionService: MockEncryptionService,
    getEncryptionService: vi.fn(() => new MockEncryptionService()),
  };
});

vi.mock('@agent-platform/shared-kernel/security', () => ({
  getDevSSRFOptions: vi.fn(() => ({})),
}));

// ---------------------------------------------------------------------------
// Mocks — @abl/compiler/platform (MCPServerManager)
// ---------------------------------------------------------------------------

const mockRegisterServer = vi.fn();
const mockConnectServer = vi.fn();
const mockDisconnectServer = vi.fn();
const mockListAllTools = vi.fn();
const mockCallTool = vi.fn();

vi.mock('@abl/compiler/platform', () => {
  // Must use a real function (not arrow) so it can be called with `new`
  function MockMCPServerManager() {
    return {
      registerServer: (...args: unknown[]) => mockRegisterServer(...args),
      connectServer: (...args: unknown[]) => mockConnectServer(...args),
      disconnectServer: (...args: unknown[]) => mockDisconnectServer(...args),
      listAllTools: (...args: unknown[]) => mockListAllTools(...args),
      callTool: (...args: unknown[]) => mockCallTool(...args),
    };
  }
  return { MCPServerManager: MockMCPServerManager };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TENANT_ID = 'tenant-1';
const PROJECT_ID = 'proj-1';
const SERVER_ID = 'srv-1';
const USER_ID = 'user-1';

const mockServer = {
  id: SERVER_ID,
  name: 'test-server',
  transport: 'sse',
  url: 'https://example.com/mcp',
  projectId: PROJECT_ID,
  tenantId: TENANT_ID,
};

const mockConfig = {
  id: SERVER_ID,
  name: 'test-server',
  transport: 'sse',
  url: 'https://example.com/mcp',
};

function setupHappyPath() {
  mockFindMcpServerConfigById.mockResolvedValue(mockServer);
  mockGetServerConfigs.mockResolvedValue([mockConfig]);
  mockRegisterServer.mockResolvedValue(undefined);
  mockConnectServer.mockResolvedValue(undefined);
  mockDisconnectServer.mockResolvedValue(undefined);
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  mockUpdateMcpServerConnectionStatus.mockResolvedValue(undefined);
  mockGetOrCreateDefaultVariableNamespaceIds.mockResolvedValue(['ns-default']);
  mockComputeSourceHash.mockReturnValue('a'.repeat(64));
  mockSerializeToolFormToDsl.mockReturnValue('mock_tool() -> object\n  type: mcp');
});

// ===========================================================================
// discoverPreview
// ===========================================================================

describe('discoverPreview', () => {
  let discoverPreview: typeof import('@/services/mcp-discovery-service').discoverPreview;

  beforeEach(async () => {
    const mod = await import('@/services/mcp-discovery-service');
    discoverPreview = mod.discoverPreview;
  });

  it('returns discovered tools with filtered schemas', async () => {
    setupHappyPath();
    mockListAllTools.mockResolvedValue([
      {
        name: 'search',
        description: 'Search the web',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            thought: { type: 'string' },
            reason: { type: 'string' },
          },
          required: ['query', 'thought', 'reason'],
        },
      },
    ]);

    const result = await discoverPreview(SERVER_ID, TENANT_ID, PROJECT_ID);

    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      expect(result.totalDiscovered).toBe(1);
      expect(result.tools).toHaveLength(1);
      expect(result.tools[0].name).toBe('search');
      expect(result.tools[0].suggestedSlug).toBe('test_server__search');
      // thought and reason should be filtered out
      const schema = result.tools[0].inputSchema as Record<string, unknown>;
      const props = schema.properties as Record<string, unknown>;
      expect(props.query).toBeDefined();
      expect(props.thought).toBeUndefined();
      expect(props.reason).toBeUndefined();
      expect(schema.required).toEqual(['query']);
    }
  });

  it('returns 404 when server not found', async () => {
    mockFindMcpServerConfigById.mockResolvedValue(null);

    const result = await discoverPreview(SERVER_ID, TENANT_ID, PROJECT_ID);

    expect(result).toEqual({ error: 'MCP server not found', status: 404 });
  });

  it('returns 404 when server belongs to different project', async () => {
    mockFindMcpServerConfigById.mockResolvedValue({ ...mockServer, projectId: 'other-proj' });

    const result = await discoverPreview(SERVER_ID, TENANT_ID, PROJECT_ID);

    expect(result).toEqual({ error: 'MCP server not found', status: 404 });
  });

  it('returns 500 when config decryption fails (server not in configs)', async () => {
    mockFindMcpServerConfigById.mockResolvedValue(mockServer);
    mockGetServerConfigs.mockResolvedValue([]); // no config found

    const result = await discoverPreview(SERVER_ID, TENANT_ID, PROJECT_ID);

    expect(result).toEqual(expect.objectContaining({ status: 500 }));
  });

  it('returns 502 when connection fails', async () => {
    setupHappyPath();
    mockRegisterServer.mockRejectedValue(new Error('Connection refused'));

    const result = await discoverPreview(SERVER_ID, TENANT_ID, PROJECT_ID);

    expect(result).toEqual(
      expect.objectContaining({
        error: expect.stringContaining('Connection refused'),
        status: 502,
      }),
    );
  });

  it('returns empty tools when listAllTools throws', async () => {
    setupHappyPath();
    mockListAllTools.mockRejectedValue(new Error('List failed'));

    const result = await discoverPreview(SERVER_ID, TENANT_ID, PROJECT_ID);

    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      expect(result.tools).toHaveLength(0);
      expect(result.totalDiscovered).toBe(0);
    }
  });

  it('truncates tools to MAX_TOOLS_PER_SERVER (500)', async () => {
    setupHappyPath();
    const manyTools = Array.from({ length: 600 }, (_, i) => ({
      name: `tool-${i}`,
      description: `Tool ${i}`,
    }));
    mockListAllTools.mockResolvedValue(manyTools);

    const result = await discoverPreview(SERVER_ID, TENANT_ID, PROJECT_ID);

    if (!('error' in result)) {
      expect(result.tools).toHaveLength(500);
      expect(result.totalDiscovered).toBe(500);
    }
  });

  it('always calls disconnectServer in finally block', async () => {
    setupHappyPath();
    mockListAllTools.mockResolvedValue([]);

    await discoverPreview(SERVER_ID, TENANT_ID, PROJECT_ID);

    expect(mockDisconnectServer).toHaveBeenCalled();
  });

  it('handles tools with no inputSchema', async () => {
    setupHappyPath();
    mockListAllTools.mockResolvedValue([{ name: 'simple-tool' }]);

    const result = await discoverPreview(SERVER_ID, TENANT_ID, PROJECT_ID);

    if (!('error' in result)) {
      expect(result.tools[0].inputSchema).toBeUndefined();
      expect(result.tools[0].description).toBeUndefined();
    }
  });
});

// ===========================================================================
// discoverAndPersist
// ===========================================================================

describe('discoverAndPersist', () => {
  let discoverAndPersist: typeof import('@/services/mcp-discovery-service').discoverAndPersist;

  beforeEach(async () => {
    const mod = await import('@/services/mcp-discovery-service');
    discoverAndPersist = mod.discoverAndPersist;
  });

  it('creates new project tools when none exist', async () => {
    setupHappyPath();
    mockListAllTools.mockResolvedValue([
      { name: 'search', description: 'Search tool', inputSchema: { type: 'object' } },
    ]);
    mockFindProjectToolByName.mockResolvedValue(null); // no existing tool
    mockCreateProjectTool.mockResolvedValue({ id: 'tool-1', name: 'test_server__search' });

    const result = await discoverAndPersist(SERVER_ID, TENANT_ID, PROJECT_ID, USER_ID);

    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      expect(result.successful).toBe(1);
      expect(result.failed).toHaveLength(0);
      expect(result.totalDiscovered).toBe(1);
    }
    expect(mockCreateProjectTool).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT_ID,
        projectId: PROJECT_ID,
        name: 'test_server__search',
        slug: 'test_server__search',
        toolType: 'mcp',
        description: 'Search tool',
        variableNamespaceIds: ['ns-default'],
        createdBy: USER_ID,
      }),
    );
    expect(mockGetOrCreateDefaultVariableNamespaceIds).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      createdBy: USER_ID,
    });
    expect(mockRefreshProjectAgentDraftMetadataForToolMutation).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      tenantId: TENANT_ID,
    });
  });

  it('detects schema drift and updates existing tool when sourceHash differs', async () => {
    setupHappyPath();
    mockListAllTools.mockResolvedValue([
      { name: 'search', description: 'Updated', inputSchema: { type: 'object' } },
    ]);
    // Existing tool with different sourceHash
    mockFindProjectToolByName.mockResolvedValue({
      id: 'existing-tool-1',
      sourceHash: 'b'.repeat(64), // different from mock's 'a'.repeat(64)
    });
    mockUpdateProjectTool.mockResolvedValue({});

    const result = await discoverAndPersist(SERVER_ID, TENANT_ID, PROJECT_ID, USER_ID);

    if (!('error' in result)) {
      expect(result.successful).toBe(1);
      expect(result.schemaDrift).toHaveLength(1);
      expect(result.schemaDrift[0].toolName).toBe('search');
      expect(result.schemaDrift[0].field).toBe('dslContent');
    }
    expect(mockUpdateProjectTool).toHaveBeenCalledWith(
      'existing-tool-1',
      TENANT_ID,
      PROJECT_ID,
      expect.objectContaining({
        description: 'Updated',
        lastEditedBy: USER_ID,
      }),
    );
    expect(mockRefreshProjectAgentDraftMetadataForToolMutation).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      tenantId: TENANT_ID,
    });
  });

  it('skips update when existing tool has same sourceHash', async () => {
    setupHappyPath();
    mockListAllTools.mockResolvedValue([{ name: 'search', description: 'Search' }]);
    // Existing tool with matching sourceHash
    mockFindProjectToolByName.mockResolvedValue({
      id: 'existing-tool-1',
      sourceHash: 'a'.repeat(64), // matches mock computeSourceHash
    });

    const result = await discoverAndPersist(SERVER_ID, TENANT_ID, PROJECT_ID, USER_ID);

    if (!('error' in result)) {
      expect(result.successful).toBe(1);
      expect(result.schemaDrift).toHaveLength(0);
    }
    expect(mockUpdateProjectTool).not.toHaveBeenCalled();
    expect(mockCreateProjectTool).not.toHaveBeenCalled();
    expect(mockRefreshProjectAgentDraftMetadataForToolMutation).not.toHaveBeenCalled();
  });

  it('filters to specific toolNames when provided', async () => {
    setupHappyPath();
    mockListAllTools.mockResolvedValue([
      { name: 'search', description: 'Search' },
      { name: 'fetch', description: 'Fetch' },
      { name: 'other', description: 'Other' },
    ]);
    mockFindProjectToolByName.mockResolvedValue(null);
    mockCreateProjectTool.mockResolvedValue({ id: 'tool-new' });

    const result = await discoverAndPersist(SERVER_ID, TENANT_ID, PROJECT_ID, USER_ID, [
      'search',
      'fetch',
    ]);

    if (!('error' in result)) {
      expect(result.successful).toBe(2);
      expect(result.totalDiscovered).toBe(3);
    }
    expect(mockCreateProjectTool).toHaveBeenCalledTimes(2);
  });

  it('returns 404 when server not found', async () => {
    mockFindMcpServerConfigById.mockResolvedValue(null);

    const result = await discoverAndPersist(SERVER_ID, TENANT_ID, PROJECT_ID, USER_ID);

    expect(result).toEqual({ error: 'MCP server not found', status: 404 });
  });

  it('returns 502 when connection fails', async () => {
    setupHappyPath();
    mockRegisterServer.mockRejectedValue(new Error('Timeout'));

    const result = await discoverAndPersist(SERVER_ID, TENANT_ID, PROJECT_ID, USER_ID);

    expect(result).toEqual(expect.objectContaining({ status: 502 }));
  });

  it('records failed tools individually without stopping', async () => {
    setupHappyPath();
    mockListAllTools.mockResolvedValue([{ name: 'good-tool' }, { name: 'bad-tool' }]);
    mockFindProjectToolByName.mockImplementation((_t: string, _p: string, toolName: string) => {
      if (toolName.includes('bad_tool')) {
        throw new Error('DB write failed');
      }
      return null;
    });
    mockCreateProjectTool.mockResolvedValue({ id: 'tool-new' });

    const result = await discoverAndPersist(SERVER_ID, TENANT_ID, PROJECT_ID, USER_ID);

    if (!('error' in result)) {
      expect(result.successful).toBe(1);
      expect(result.failed).toHaveLength(1);
      expect(result.failed[0].toolName).toBe('bad-tool');
      expect(result.failed[0].error).toBe('DB write failed');
    }
  });

  it('truncates discovered tools to MAX_TOOLS_PER_SERVER', async () => {
    setupHappyPath();
    const manyTools = Array.from({ length: 600 }, (_, i) => ({
      name: `tool-${i}`,
    }));
    mockListAllTools.mockResolvedValue(manyTools);
    mockFindProjectToolByName.mockResolvedValue(null);
    mockCreateProjectTool.mockResolvedValue({ id: 'tool-new' });

    const result = await discoverAndPersist(SERVER_ID, TENANT_ID, PROJECT_ID, USER_ID);

    if (!('error' in result)) {
      expect(result.totalDiscovered).toBe(500);
    }
  });
});

// ===========================================================================
// testConnection
// ===========================================================================

describe('testConnection', () => {
  let testConnection: typeof import('@/services/mcp-discovery-service').testConnection;

  beforeEach(async () => {
    const mod = await import('@/services/mcp-discovery-service');
    testConnection = mod.testConnection;
  });

  it('returns connected status with tool count and latency', async () => {
    setupHappyPath();
    mockListAllTools.mockResolvedValue([
      { name: 'tool-a', description: 'A' },
      { name: 'tool-b', description: 'B' },
    ]);

    const result = await testConnection(SERVER_ID, TENANT_ID, PROJECT_ID);

    expect('error' in result && 'status' in result).toBe(false);
    if ('connected' in result) {
      expect(result.connected).toBe(true);
      expect(result.toolCount).toBe(2);
      expect(result.tools).toHaveLength(2);
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    }
  });

  it('returns 404 when server not found', async () => {
    mockFindMcpServerConfigById.mockResolvedValue(null);

    const result = await testConnection(SERVER_ID, TENANT_ID, PROJECT_ID);

    expect(result).toEqual({ error: 'MCP server not found', status: 404 });
  });

  it('returns connected:false with error on connection failure', async () => {
    setupHappyPath();
    mockRegisterServer.mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await testConnection(SERVER_ID, TENANT_ID, PROJECT_ID);

    if ('connected' in result) {
      expect(result.connected).toBe(false);
      expect(result.error).toContain('ECONNREFUSED');
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    }
  });

  it('returns 500 when config decryption fails', async () => {
    mockFindMcpServerConfigById.mockResolvedValue(mockServer);
    mockGetServerConfigs.mockResolvedValue([]);

    const result = await testConnection(SERVER_ID, TENANT_ID, PROJECT_ID);

    expect(result).toEqual(expect.objectContaining({ status: 500 }));
  });

  it('always disconnects even on failure', async () => {
    setupHappyPath();
    mockListAllTools.mockRejectedValue(new Error('timeout'));

    await testConnection(SERVER_ID, TENANT_ID, PROJECT_ID);

    expect(mockDisconnectServer).toHaveBeenCalled();
  });
});

// ===========================================================================
// testMcpTool
// ===========================================================================

describe('testMcpTool', () => {
  let testMcpTool: typeof import('@/services/mcp-discovery-service').testMcpTool;

  beforeEach(async () => {
    const mod = await import('@/services/mcp-discovery-service');
    testMcpTool = mod.testMcpTool;
  });

  it('calls tool and returns success with output', async () => {
    setupHappyPath();
    mockCallTool.mockResolvedValue({ data: 'result-data' });

    const result = await testMcpTool(SERVER_ID, TENANT_ID, PROJECT_ID, 'search', {
      query: 'hello',
    });

    if ('success' in result) {
      expect(result.success).toBe(true);
      expect(result.output).toEqual({ data: 'result-data' });
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    }
    expect(mockCallTool).toHaveBeenCalledWith('search', { query: 'hello' }, expect.any(String));
  });

  it('returns 404 when server not found', async () => {
    mockFindMcpServerConfigById.mockResolvedValue(null);

    const result = await testMcpTool(SERVER_ID, TENANT_ID, PROJECT_ID, 'search', {});

    expect(result).toEqual({ error: 'MCP server not found', status: 404 });
  });

  it('returns success:false on tool execution error', async () => {
    setupHappyPath();
    mockCallTool.mockRejectedValue(new Error('Tool execution failed'));

    const result = await testMcpTool(SERVER_ID, TENANT_ID, PROJECT_ID, 'search', {});

    if ('success' in result) {
      expect(result.success).toBe(false);
      expect(result.error).toContain('Tool execution failed');
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    }
  });

  it('returns success:false on connection error', async () => {
    setupHappyPath();
    mockConnectServer.mockRejectedValue(new Error('Connection refused'));

    const result = await testMcpTool(SERVER_ID, TENANT_ID, PROJECT_ID, 'search', {});

    if ('success' in result) {
      expect(result.success).toBe(false);
      expect(result.error).toContain('Connection refused');
    }
  });

  it('uses default empty input when none provided', async () => {
    setupHappyPath();
    mockCallTool.mockResolvedValue('ok');

    const result = await testMcpTool(SERVER_ID, TENANT_ID, PROJECT_ID, 'search');

    if ('success' in result) {
      expect(result.success).toBe(true);
    }
    expect(mockCallTool).toHaveBeenCalledWith('search', {}, expect.any(String));
  });

  it('always disconnects in finally block', async () => {
    setupHappyPath();
    mockCallTool.mockRejectedValue(new Error('fail'));

    await testMcpTool(SERVER_ID, TENANT_ID, PROJECT_ID, 'search', {});

    expect(mockDisconnectServer).toHaveBeenCalled();
  });
});

// ===========================================================================
// listDiscoveredTools
// ===========================================================================

describe('listDiscoveredTools', () => {
  let listDiscoveredTools: typeof import('@/services/mcp-discovery-service').listDiscoveredTools;

  beforeEach(async () => {
    const mod = await import('@/services/mcp-discovery-service');
    listDiscoveredTools = mod.listDiscoveredTools;
  });

  it('returns mapped tool list from project_tools', async () => {
    mockFindMcpServerConfigById.mockResolvedValue(mockServer);
    mockFindProjectToolsByProject.mockResolvedValue({
      data: [
        {
          id: 'tool-1',
          name: 'test_server__search',
          description: 'Search the web',
          createdAt: '2025-01-01',
          updatedAt: '2025-01-02',
        },
      ],
      pagination: { total: 1, page: 1, limit: 500 },
    });

    const result = await listDiscoveredTools(SERVER_ID, TENANT_ID, PROJECT_ID);

    expect(Array.isArray(result)).toBe(true);
    if (Array.isArray(result)) {
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('tool-1');
      expect(result[0].toolName).toBe('test_server__search');
      expect(result[0].description).toBe('Search the web');
      expect(result[0].serverName).toBe('test-server');
      expect(result[0].isAvailable).toBe(true);
    }
  });

  it('returns 404 when server not found', async () => {
    mockFindMcpServerConfigById.mockResolvedValue(null);

    const result = await listDiscoveredTools(SERVER_ID, TENANT_ID, PROJECT_ID);

    expect(result).toEqual({ error: 'MCP server not found', status: 404 });
  });

  it('returns 404 when server belongs to different project', async () => {
    mockFindMcpServerConfigById.mockResolvedValue({ ...mockServer, projectId: 'other-proj' });

    const result = await listDiscoveredTools(SERVER_ID, TENANT_ID, PROJECT_ID);

    expect(result).toEqual({ error: 'MCP server not found', status: 404 });
  });

  it('returns empty list when no tools match prefix', async () => {
    mockFindMcpServerConfigById.mockResolvedValue(mockServer);
    mockFindProjectToolsByProject.mockResolvedValue({
      data: [
        {
          id: 'tool-1',
          name: 'other_server__search',
          description: null,
          createdAt: '2025-01-01',
          updatedAt: '2025-01-02',
        },
      ],
      pagination: { total: 1, page: 1, limit: 500 },
    });

    const result = await listDiscoveredTools(SERVER_ID, TENANT_ID, PROJECT_ID);

    if (Array.isArray(result)) {
      // Filtered out because name doesn't start with 'test_server__'
      expect(result).toHaveLength(0);
    }
  });
});

// ===========================================================================
// getDiscoveredTool
// ===========================================================================

describe('getDiscoveredTool', () => {
  let getDiscoveredTool: typeof import('@/services/mcp-discovery-service').getDiscoveredTool;

  beforeEach(async () => {
    const mod = await import('@/services/mcp-discovery-service');
    getDiscoveredTool = mod.getDiscoveredTool;
  });

  it('returns tool details', async () => {
    mockFindProjectToolById.mockResolvedValue({
      id: 'tool-1',
      name: 'test_server__search',
      description: 'Search',
      createdAt: '2025-01-01',
      updatedAt: '2025-01-02',
    });

    const result = await getDiscoveredTool('tool-1', TENANT_ID, PROJECT_ID);

    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      expect(result.id).toBe('tool-1');
      expect(result.toolName).toBe('test_server__search');
      expect(result.description).toBe('Search');
      expect(result.serverName).toBe('test_server');
      expect(result.isAvailable).toBe(true);
    }
  });

  it('returns 404 when tool not found', async () => {
    mockFindProjectToolById.mockResolvedValue(null);

    const result = await getDiscoveredTool('nonexistent', TENANT_ID, PROJECT_ID);

    expect(result).toEqual({ error: 'Tool not found', status: 404 });
  });
});

// ===========================================================================
// Helper: filterSchemaArtifacts (tested indirectly via discoverPreview)
// ===========================================================================

describe('filterSchemaArtifacts (via discoverPreview)', () => {
  let discoverPreview: typeof import('@/services/mcp-discovery-service').discoverPreview;

  beforeEach(async () => {
    const mod = await import('@/services/mcp-discovery-service');
    discoverPreview = mod.discoverPreview;
  });

  it('preserves non-artifact properties', async () => {
    setupHappyPath();
    mockListAllTools.mockResolvedValue([
      {
        name: 'tool',
        inputSchema: {
          type: 'object',
          properties: { query: { type: 'string' }, limit: { type: 'number' } },
          required: ['query'],
        },
      },
    ]);

    const result = await discoverPreview(SERVER_ID, TENANT_ID, PROJECT_ID);

    if (!('error' in result)) {
      const schema = result.tools[0].inputSchema as Record<string, unknown>;
      const props = schema.properties as Record<string, unknown>;
      expect(props.query).toBeDefined();
      expect(props.limit).toBeDefined();
    }
  });

  it('handles schema with no properties', async () => {
    setupHappyPath();
    mockListAllTools.mockResolvedValue([
      {
        name: 'tool',
        inputSchema: { type: 'object' },
      },
    ]);

    const result = await discoverPreview(SERVER_ID, TENANT_ID, PROJECT_ID);

    if (!('error' in result)) {
      const schema = result.tools[0].inputSchema as Record<string, unknown>;
      expect(schema.type).toBe('object');
    }
  });
});

// ===========================================================================
// Helper: mcpSlug (tested indirectly via discoverPreview)
// ===========================================================================

describe('mcpSlug (via discoverPreview)', () => {
  let discoverPreview: typeof import('@/services/mcp-discovery-service').discoverPreview;

  beforeEach(async () => {
    const mod = await import('@/services/mcp-discovery-service');
    discoverPreview = mod.discoverPreview;
  });

  it('generates lowercase slugs with special chars replaced', async () => {
    setupHappyPath();
    mockListAllTools.mockResolvedValue([{ name: 'My-Tool.v2' }]);

    const result = await discoverPreview(SERVER_ID, TENANT_ID, PROJECT_ID);

    if (!('error' in result)) {
      // server name is 'test-server', tool name is 'My-Tool.v2'
      // test-server__My-Tool.v2 -> test_server__my_tool_v2
      expect(result.tools[0].suggestedSlug).toBe('test_server__my_tool_v2');
    }
  });
});
