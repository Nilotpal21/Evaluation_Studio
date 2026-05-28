import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  resolveToolImplementations,
  toToolDefinition,
} from '../tools/resolve-tool-implementations.js';
import type { ResolvedToolImpl } from '../tools/resolve-tool-implementations.js';
import { computeSourceHash } from '../utils/hash.js';

interface MockProjectTool {
  _id: string;
  name: string;
  toolType: 'http' | 'sandbox' | 'mcp' | 'searchai' | 'workflow';
  description: string | null;
  dslContent: string;
  sourceHash: string;
  variableNamespaceIds?: string[];
}

const db = vi.hoisted(() => ({
  tools: [] as MockProjectTool[],
  find: vi.fn(),
  workflowFindOne: vi.fn(),
  workflowVersionFindOne: vi.fn(),
  triggerRegistrationFindOne: vi.fn(),
  searchIndexFindOne: vi.fn(),
}));

vi.mock('@agent-platform/database/models', () => ({
  ProjectTool: {
    find: db.find,
  },
  Workflow: {
    findOne: db.workflowFindOne,
  },
  WorkflowVersion: {
    findOne: db.workflowVersionFindOne,
  },
  TriggerRegistration: {
    findOne: db.triggerRegistrationFindOne,
  },
  SearchIndex: {
    findOne: db.searchIndexFindOne,
  },
}));

// =============================================================================
// toToolDefinition() — converts ResolvedToolImpl to ToolDefinitionLocal
// =============================================================================

describe('toToolDefinition', () => {
  it('converts a resolved HTTP tool to ToolDefinitionLocal', () => {
    const resolved: ResolvedToolImpl = {
      name: 'fetch_data',
      toolType: 'http',
      projectToolId: 'pt-1',
      sourceHash: 'abc123',
      description: 'Fetch data from API',
      dslContent: `fetch_data(url: string) -> object
  type: http
  endpoint: https://api.example.com
  method: GET
  auth: bearer`,
      httpBinding: {
        endpoint: 'https://api.example.com',
        method: 'GET',
        auth: { type: 'bearer', config: { headerName: 'Authorization', headerPrefix: 'Bearer' } },
      },
    };

    const def = toToolDefinition(resolved);

    expect(def.name).toBe('fetch_data');
    expect(def.description).toBe('Fetch data from API');
    expect(def.parameters).toEqual([{ name: 'url', type: 'string', required: true }]);
    expect(def.returns).toEqual({ type: 'object' });
    expect(def.hints.side_effects).toBe(false);
    expect(def.hints.requires_auth).toBe(true);
    expect(def.tool_type).toBe('http');
    expect(def.http_binding).toBe(resolved.httpBinding);
  });

  it('converts project-tool compaction hints to ToolDefinitionLocal', () => {
    const resolved: ResolvedToolImpl = {
      name: 'search_hotels',
      toolType: 'http',
      projectToolId: 'pt-compaction',
      sourceHash: 'compaction123',
      description: 'Search hotels',
      dslContent: `search_hotels(destination: string) -> object
  type: http
  endpoint: https://api.example.com/hotels
  method: GET
  compaction:
    essential_fields: [name, price, availability]
    max_description_length: 120`,
      httpBinding: {
        endpoint: 'https://api.example.com/hotels',
        method: 'GET',
        auth: { type: 'none' },
      },
    };

    expect(toToolDefinition(resolved).compaction).toEqual({
      essential_fields: ['name', 'price', 'availability'],
      max_description_length: 120,
    });
  });

  it('converts a resolved sandbox tool', () => {
    const resolved: ResolvedToolImpl = {
      name: 'calc',
      toolType: 'sandbox',
      projectToolId: 'pt-2',
      sourceHash: 'def456',
      description: null,
      dslContent: `calc(x: number) -> number
  type: sandbox
  runtime: javascript
  timeout: 5000
  code: |
    return x * 2;`,
      sandboxBinding: {
        runtime: 'javascript',
        code_content: 'return x * 2;',
        timeout_ms: 5000,
      },
    };

    const def = toToolDefinition(resolved);

    expect(def.name).toBe('calc');
    expect(def.description).toBe('');
    expect(def.parameters).toEqual([{ name: 'x', type: 'number', required: true }]);
    expect(def.returns).toEqual({ type: 'number' });
    expect(def.hints.timeout).toBe(5000);
    expect(def.tool_type).toBe('sandbox');
    expect(def.sandbox_binding).toBe(resolved.sandboxBinding);
  });

  it('converts a resolved MCP tool', () => {
    const resolved: ResolvedToolImpl = {
      name: 'search_docs',
      toolType: 'mcp',
      projectToolId: 'pt-3',
      sourceHash: 'ghi789',
      description: 'Search via MCP',
      dslContent: `search_docs(query: string) -> object
  type: mcp
  server: my-server
  server_tool: search`,
      mcpBinding: {
        server: 'my-server',
        tool: 'search',
      },
    };

    const def = toToolDefinition(resolved);

    expect(def.name).toBe('search_docs');
    expect(def.tool_type).toBe('mcp');
    expect(def.mcp_binding).toBe(resolved.mcpBinding);
  });

  it('converts a resolved searchai tool', () => {
    const resolved: ResolvedToolImpl = {
      name: 'search_kb',
      toolType: 'searchai',
      projectToolId: 'pt-4',
      sourceHash: 'jkl012',
      description: 'Search knowledge base',
      dslContent: `search_kb(query: string) -> object
  type: searchai
  index_id: idx_123
  tenant_id: t_456`,
      searchaiBinding: {
        tenantId: 't_456',
        indexId: 'idx_123',
      },
    };

    const def = toToolDefinition(resolved);

    expect(def.name).toBe('search_kb');
    expect(def.tool_type).toBe('searchai');
    expect(def.searchai_binding).toBe(resolved.searchaiBinding);
  });

  it('parses param metadata (description, enum, default) from DSL', () => {
    const resolved: ResolvedToolImpl = {
      name: 'weather_api',
      toolType: 'http',
      projectToolId: 'pt-5',
      sourceHash: 'mno345',
      description: 'Weather API',
      dslContent: `weather_api(city: string, units?: string) -> object
  type: http
  endpoint: https://api.weather.com
  method: GET
  auth: none
  params:
    city:
      description: "City name"
    units:
      description: "Unit"
      enum: metric, imperial
      default: metric`,
      httpBinding: {
        endpoint: 'https://api.weather.com',
        method: 'GET',
        auth: { type: 'none' },
      },
    };

    const def = toToolDefinition(resolved);

    expect(def.parameters[0].description).toBe('City name');
    expect(def.parameters[1].description).toBe('Unit');
    expect(def.parameters[1].enum).toEqual(['metric', 'imperial']);
    expect(def.parameters[1].default).toBe('metric');
  });

  it('parses schema metadata for object params into properties', () => {
    const resolved: ResolvedToolImpl = {
      name: 'create_user',
      toolType: 'http',
      projectToolId: 'pt-6',
      sourceHash: 'pqr678',
      description: 'Create user',
      dslContent: `create_user(data: object) -> object
  type: http
  endpoint: https://api.example.com/users
  method: POST
  auth: none
  params:
    data:
      schema: {"name": {"type": "string", "description": "User name"}, "age": {"type": "number"}}`,
      httpBinding: {
        endpoint: 'https://api.example.com/users',
        method: 'POST',
        auth: { type: 'none' },
      },
    };

    const def = toToolDefinition(resolved);
    const dataParam = def.parameters[0];

    expect(dataParam.properties).toBeDefined();
    expect(dataParam.properties).toHaveLength(2);
    expect(dataParam.properties![0].name).toBe('name');
    expect(dataParam.properties![0].type).toBe('string');
    expect(dataParam.properties![0].description).toBe('User name');
    expect(dataParam.properties![1].name).toBe('age');
    expect(dataParam.properties![1].type).toBe('number');
  });

  it('parses schema metadata for array params into items', () => {
    const resolved: ResolvedToolImpl = {
      name: 'search_api',
      toolType: 'http',
      projectToolId: 'pt-7',
      sourceHash: 'stu901',
      description: 'Search',
      dslContent: `search_api(tags: array) -> object
  type: http
  endpoint: https://api.example.com/search
  method: GET
  auth: none
  params:
    tags:
      schema: {"type": "string", "enum": ["a", "b"]}`,
      httpBinding: {
        endpoint: 'https://api.example.com/search',
        method: 'GET',
        auth: { type: 'none' },
      },
    };

    const def = toToolDefinition(resolved);
    const tagsParam = def.parameters[0];

    expect(tagsParam.items).toBeDefined();
    expect(tagsParam.items!.type).toBe('string');
    expect(tagsParam.items!.enum).toEqual(['a', 'b']);
  });

  it('handles invalid JSON in schema gracefully', () => {
    const resolved: ResolvedToolImpl = {
      name: 'bad_schema',
      toolType: 'http',
      projectToolId: 'pt-8',
      sourceHash: 'vwx234',
      description: 'Bad schema',
      dslContent: `bad_schema(data: object) -> object
  type: http
  endpoint: https://api.example.com
  method: GET
  auth: none
  params:
    data:
      schema: not-valid-json`,
      httpBinding: {
        endpoint: 'https://api.example.com',
        method: 'GET',
        auth: { type: 'none' },
      },
    };

    const def = toToolDefinition(resolved);

    expect(def.parameters[0].properties).toBeUndefined();
    expect(def.parameters[0].items).toBeUndefined();
  });

  it('sets side_effects true for POST method', () => {
    const resolved: ResolvedToolImpl = {
      name: 'post_api',
      toolType: 'http',
      projectToolId: 'pt-9',
      sourceHash: 'yza567',
      description: 'Post API',
      dslContent: `post_api() -> object
  type: http
  endpoint: https://api.example.com
  method: POST
  auth: none`,
      httpBinding: {
        endpoint: 'https://api.example.com',
        method: 'POST',
        auth: { type: 'none' },
      },
    };

    const def = toToolDefinition(resolved);
    expect(def.hints.side_effects).toBe(true);
  });
});

describe('resolveToolImplementations', () => {
  beforeEach(() => {
    db.tools = [];
    db.find.mockReset();
    db.find.mockReturnValue({
      lean: async () => db.tools,
    });
    db.workflowFindOne.mockReset();
    db.workflowFindOne.mockReturnValue({
      lean: async () => null,
    });
    db.workflowVersionFindOne.mockReset();
    db.workflowVersionFindOne.mockReturnValue({
      lean: async () => null,
    });
    db.triggerRegistrationFindOne.mockReset();
    db.triggerRegistrationFindOne.mockReturnValue({
      lean: async () => null,
    });
    db.searchIndexFindOne.mockReset();
    db.searchIndexFindOne.mockReturnValue({
      lean: async () => null,
    });
  });

  it('does not conflate distinct project tools that share a legacy sourceHash', async () => {
    const sharedLegacyHash = 'a'.repeat(64);
    db.tools = [
      {
        _id: 'tool-get-user',
        name: 'get_user',
        toolType: 'http',
        description: 'Get user',
        sourceHash: sharedLegacyHash,
        dslContent: `get_user(user_id: string) -> object
  description: "Get user"
  type: http
  endpoint: "https://api.example.com/users/{user_id}"
  method: GET`,
      },
      {
        _id: 'tool-create-user',
        name: 'create_user',
        toolType: 'http',
        description: 'Create user',
        sourceHash: sharedLegacyHash,
        dslContent: `create_user(name: string) -> object
  description: "Create user"
  type: http
  endpoint: "https://api.example.com/users"
  method: POST`,
      },
    ];

    const result = await resolveToolImplementations({
      tenantId: 'tenant-test',
      projectId: 'project-test',
      toolsByAgent: new Map([['Agent', ['get_user', 'create_user']]]),
    });

    expect(result.errors).toEqual([]);
    const tools = result.resolvedByAgent.get('Agent') ?? [];
    expect(tools.map((tool) => tool.name)).toEqual(['get_user', 'create_user']);
    expect(tools[0].http_binding?.endpoint).toBe('https://api.example.com/users/{user_id}');
    expect(tools[1].http_binding?.endpoint).toBe('https://api.example.com/users');
  });

  it('fails closed when persisted DB metadata disagrees with DSL content', async () => {
    db.tools = [
      {
        _id: 'tool-drifted',
        name: 'current_name',
        toolType: 'http',
        description: 'Drifted tool',
        sourceHash: 'b'.repeat(64),
        dslContent: `old_name() -> object
  description: "Drifted tool"
  type: http
  endpoint: "https://api.example.com/old"
  method: GET`,
      },
    ];

    const result = await resolveToolImplementations({
      tenantId: 'tenant-test',
      projectId: 'project-test',
      toolsByAgent: new Map([['Agent', ['current_name']]]),
    });

    expect(result.resolvedByAgent.get('Agent')).toEqual([]);
    expect(result.errors).toEqual([
      expect.objectContaining({
        code: 'E725',
        location: 'tool:current_name',
        message: expect.stringContaining('signature name "old_name"'),
      }),
    ]);
  });

  it('derives runtime cache identity from current DSL instead of stale persisted sourceHash', async () => {
    const currentDsl = `fetch_status() -> object
  description: "Fetch current status"
  type: http
  endpoint: "https://api.example.com/current"
  method: GET`;
    const staleHash = 'c'.repeat(64);
    const currentHash = computeSourceHash(currentDsl);
    const staleCachedBinding: ResolvedToolImpl = {
      name: 'fetch_status',
      toolType: 'http',
      projectToolId: 'tool-status',
      sourceHash: staleHash,
      description: 'Fetch old status',
      dslContent: `fetch_status() -> object
  description: "Fetch old status"
  type: http
  endpoint: "https://api.example.com/old"
  method: GET`,
      httpBinding: {
        endpoint: 'https://api.example.com/old',
        method: 'GET',
        auth: { type: 'none' },
      },
    };

    db.tools = [
      {
        _id: 'tool-status',
        name: 'fetch_status',
        toolType: 'http',
        description: 'Fetch current status',
        sourceHash: staleHash,
        dslContent: currentDsl,
      },
    ];

    const redis = {
      get: vi.fn(async (key: string) =>
        key.includes(currentHash) ? null : JSON.stringify(staleCachedBinding),
      ),
      setex: vi.fn(async () => {}),
    };

    const result = await resolveToolImplementations(
      {
        tenantId: 'tenant-test',
        projectId: 'project-test',
        toolsByAgent: new Map([['Agent', ['fetch_status']]]),
      },
      { redis },
    );

    expect(redis.get).toHaveBeenCalledWith(expect.stringContaining(`fetch_status:${currentHash}`));
    expect(redis.setex).toHaveBeenCalledWith(
      expect.stringContaining(`fetch_status:${currentHash}`),
      expect.any(Number),
      expect.any(String),
    );
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([
      expect.objectContaining({
        code: 'W_TOOL_SOURCE_HASH_STALE',
        location: 'tool:fetch_status',
      }),
    ]);
    expect(result.snapshotEntries[0]?.sourceHash).toBe(currentHash);
    expect(result.resolvedByAgent.get('Agent')?.[0]?.http_binding?.endpoint).toBe(
      'https://api.example.com/current',
    );
  });

  it('fails closed when a workflow tool points at a missing workflow', async () => {
    db.tools = [
      {
        _id: 'tool-workflow',
        name: 'run_refund',
        toolType: 'workflow',
        description: 'Run refund workflow',
        sourceHash: 'd'.repeat(64),
        dslContent: `run_refund(order_id: string) -> object
  type: workflow
  workflow_id: wf-missing
  trigger_id: tr-refund`,
      },
    ];

    const result = await resolveToolImplementations({
      tenantId: 'tenant-test',
      projectId: 'project-test',
      toolsByAgent: new Map([['Agent', ['run_refund']]]),
    });

    expect(result.resolvedByAgent.get('Agent')).toEqual([]);
    expect(result.errors).toEqual([
      expect.objectContaining({
        code: 'E725',
        location: 'tool:run_refund',
        message: expect.stringContaining('Workflow not found'),
      }),
    ]);
    expect(db.workflowFindOne).toHaveBeenCalledWith({
      _id: 'wf-missing',
      tenantId: 'tenant-test',
      projectId: 'project-test',
    });
  });

  it('fails closed when a SearchAI tool points at a same-tenant foreign project index', async () => {
    db.tools = [
      {
        _id: 'tool-searchai',
        name: 'search_docs',
        toolType: 'searchai',
        description: 'Search docs',
        sourceHash: 'e'.repeat(64),
        dslContent: `search_docs(query: string) -> object
  type: searchai
  index_id: idx-foreign
  tenant_id: tenant-test`,
      },
    ];
    db.searchIndexFindOne.mockImplementation((filter: Record<string, unknown>) => {
      if (filter.projectId === 'project-test') {
        return { lean: async () => null };
      }
      return {
        lean: async () => ({
          _id: 'idx-foreign',
          tenantId: 'tenant-test',
          projectId: 'other-project',
        }),
      };
    });

    const result = await resolveToolImplementations({
      tenantId: 'tenant-test',
      projectId: 'project-test',
      toolsByAgent: new Map([['Agent', ['search_docs']]]),
    });

    expect(result.resolvedByAgent.get('Agent')).toEqual([]);
    expect(result.errors).toEqual([
      expect.objectContaining({
        code: 'E725',
        location: 'tool:search_docs',
        message: expect.stringContaining('SearchAI index not found'),
      }),
    ]);
    expect(db.searchIndexFindOne).toHaveBeenCalledWith({
      _id: 'idx-foreign',
      tenantId: 'tenant-test',
      projectId: 'project-test',
    });
  });

  it('revalidates cached SearchAI bindings before accepting compiled IR', async () => {
    const dslContent = `search_docs(query: string) -> object
  type: searchai
  index_id: idx-deleted
  tenant_id: tenant-test`;
    const sourceHash = computeSourceHash(dslContent);
    const cachedBinding: ResolvedToolImpl = {
      name: 'search_docs',
      toolType: 'searchai',
      projectToolId: 'tool-searchai',
      sourceHash,
      description: 'Search docs',
      dslContent,
      searchaiBinding: {
        indexId: 'idx-deleted',
        tenantId: 'tenant-test',
      },
    };

    db.tools = [
      {
        _id: 'tool-searchai',
        name: 'search_docs',
        toolType: 'searchai',
        description: 'Search docs',
        sourceHash,
        dslContent,
      },
    ];

    const redis = {
      get: vi.fn(async () => JSON.stringify(cachedBinding)),
      setex: vi.fn(async () => {}),
    };

    const result = await resolveToolImplementations(
      {
        tenantId: 'tenant-test',
        projectId: 'project-test',
        toolsByAgent: new Map([['Agent', ['search_docs']]]),
      },
      { redis },
    );

    expect(result.resolvedByAgent.get('Agent')).toEqual([]);
    expect(result.errors).toEqual([
      expect.objectContaining({
        code: 'E725',
        location: 'tool:search_docs',
        message: expect.stringContaining('SearchAI index not found'),
      }),
    ]);
    expect(db.searchIndexFindOne).toHaveBeenCalledWith({
      _id: 'idx-deleted',
      tenantId: 'tenant-test',
      projectId: 'project-test',
    });
    expect(redis.setex).not.toHaveBeenCalled();
  });
});
