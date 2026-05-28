import { beforeEach, describe, expect, it, vi } from 'vitest';
import { computeSourceHash } from '../../utils/hash.js';
import { resolveToolImplementations } from '../resolve-tool-implementations.js';

const mockProjectToolFind = vi.fn();

vi.mock('@agent-platform/database/models', () => ({
  ProjectTool: {
    find: (...args: unknown[]) => ({ lean: () => mockProjectToolFind(...args) }),
  },
}));

const TOOL_DSL = [
  'lookup_customer(id: string) -> object',
  '  type: http',
  '  endpoint: https://crm.example.com/customers/{{input.id}}',
  '  method: GET',
].join('\n');

const MCP_TOOL_DSL = [
  'search_docs(query: string) -> object',
  '  type: mcp',
  '  server: docs-mcp',
  '  tool: search',
].join('\n');

function makeTool(variableNamespaceIds: string[]) {
  return {
    _id: 'tool-1',
    name: 'lookup_customer',
    toolType: 'http',
    description: 'Lookup customer',
    dslContent: TOOL_DSL,
    sourceHash: computeSourceHash(TOOL_DSL),
    variableNamespaceIds,
  };
}

function makeMcpTool() {
  return {
    _id: 'tool-mcp-1',
    name: 'search_docs',
    toolType: 'mcp',
    description: 'Search docs',
    dslContent: MCP_TOOL_DSL,
    sourceHash: computeSourceHash(MCP_TOOL_DSL),
    variableNamespaceIds: [],
  };
}

function makeMcpServerConfig(url: string) {
  return {
    id: 'mcp-1',
    tenantId: 'tenant-1',
    projectId: 'project-1',
    name: 'docs-mcp',
    transport: 'http',
    url,
    encryptedEnv: null,
    encryptedAuthConfig: null,
    headers: null,
    authType: 'none',
    authProfileId: null,
    connectionTimeoutMs: 10_000,
    requestTimeoutMs: 30_000,
  };
}

describe('resolveToolImplementations cache identity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('invalidates cached compiled tools when variable namespace metadata changes', async () => {
    const cache = new Map<string, string>();
    const redis = {
      get: vi.fn(async (key: string) => cache.get(key) ?? null),
      setex: vi.fn(async (key: string, _seconds: number, value: string) => {
        cache.set(key, value);
      }),
    };

    const toolsByAgent = new Map([['agent-1', ['lookup_customer']]]);

    mockProjectToolFind.mockResolvedValueOnce([makeTool(['ns-a'])]);
    const first = await resolveToolImplementations(
      { tenantId: 'tenant-1', projectId: 'project-1', toolsByAgent },
      { redis },
    );
    expect(first.resolvedByAgent.get('agent-1')?.[0]?.variable_namespace_ids).toEqual(['ns-a']);
    expect(first.timings.redisCacheMisses).toBe(1);

    mockProjectToolFind.mockResolvedValueOnce([makeTool(['ns-b'])]);
    const second = await resolveToolImplementations(
      { tenantId: 'tenant-1', projectId: 'project-1', toolsByAgent },
      { redis },
    );

    expect(second.resolvedByAgent.get('agent-1')?.[0]?.variable_namespace_ids).toEqual(['ns-b']);
    expect(second.timings.redisCacheMisses).toBe(1);
  });

  it('invalidates cached MCP tools when server config changes', async () => {
    const cache = new Map<string, string>();
    const redis = {
      get: vi.fn(async (key: string) => cache.get(key) ?? null),
      setex: vi.fn(async (key: string, _seconds: number, value: string) => {
        cache.set(key, value);
      }),
    };
    const mcpServerConfigRawLoader = vi.fn();
    const toolsByAgent = new Map([['agent-1', ['search_docs']]]);

    mockProjectToolFind.mockResolvedValueOnce([makeMcpTool()]);
    mcpServerConfigRawLoader.mockResolvedValueOnce([
      makeMcpServerConfig('https://old.example.com/mcp'),
    ]);
    const first = await resolveToolImplementations(
      { tenantId: 'tenant-1', projectId: 'project-1', toolsByAgent },
      { redis, mcpServerConfigRawLoader },
    );

    expect(first.resolvedByAgent.get('agent-1')?.[0]?.mcp_binding?.server_config?.url).toBe(
      'https://old.example.com/mcp',
    );
    expect(first.timings.redisCacheMisses).toBe(1);

    mockProjectToolFind.mockResolvedValueOnce([makeMcpTool()]);
    mcpServerConfigRawLoader.mockResolvedValueOnce([
      makeMcpServerConfig('https://new.example.com/mcp'),
    ]);
    const second = await resolveToolImplementations(
      { tenantId: 'tenant-1', projectId: 'project-1', toolsByAgent },
      { redis, mcpServerConfigRawLoader },
    );

    expect(second.resolvedByAgent.get('agent-1')?.[0]?.mcp_binding?.server_config?.url).toBe(
      'https://new.example.com/mcp',
    );
    expect(second.timings.redisCacheMisses).toBe(1);
    expect(second.snapshotEntries[0].runtimeMetadataHash).not.toBe(
      first.snapshotEntries[0].runtimeMetadataHash,
    );
  });
});
