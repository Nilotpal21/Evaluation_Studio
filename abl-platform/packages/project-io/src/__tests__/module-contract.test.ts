import { describe, it, expect } from 'vitest';
import {
  extractModuleContract,
  type ContractAgentInput,
  type ContractToolInput,
} from '../module-release/module-contract.js';

// ─── Helpers ──────────────────────────────────────────────────────────────

function agent(name: string, dslContent: string, description?: string): ContractAgentInput {
  return { name, dslContent, ...(description ? { description } : {}) };
}

function tool(name: string, toolType: string, dslContent: string): ContractToolInput {
  return { name, toolType, dslContent };
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe('extractModuleContract', () => {
  describe('provided agents and tools', () => {
    it('extracts agent names from inputs', () => {
      const result = extractModuleContract(
        [agent('agent-a', 'AGENT: agent-a'), agent('agent-b', 'AGENT: agent-b')],
        [],
      );

      expect(result.providedAgents).toEqual([{ name: 'agent-a' }, { name: 'agent-b' }]);
    });

    it('includes agent description when provided', () => {
      const result = extractModuleContract(
        [agent('agent-a', 'AGENT: agent-a', 'My agent description')],
        [],
      );

      expect(result.providedAgents).toEqual([
        { name: 'agent-a', description: 'My agent description' },
      ]);
    });

    it('excludes description when null', () => {
      const result = extractModuleContract(
        [{ name: 'agent-a', dslContent: 'AGENT: agent-a', description: null }],
        [],
      );

      expect(result.providedAgents).toEqual([{ name: 'agent-a' }]);
    });

    it('extracts tool names and types from inputs', () => {
      const result = extractModuleContract(
        [],
        [tool('tool-a', 'http', 'TOOL: tool-a'), tool('tool-b', 'mcp', 'TOOL: tool-b')],
      );

      expect(result.providedTools).toEqual([
        { name: 'tool-a', toolType: 'http' },
        { name: 'tool-b', toolType: 'mcp' },
      ]);
    });
  });

  describe('env var extraction', () => {
    it('extracts {{env.KEY}} references from agent DSL', () => {
      const result = extractModuleContract(
        [agent('a', 'Use {{env.API_KEY}} and {{env.BASE_URL}}')],
        [],
      );

      const names = result.requiredEnvVars.map((e) => e.name);
      expect(names).toContain('API_KEY');
      expect(names).toContain('BASE_URL');
    });

    it('extracts {{env.KEY}} references from tool DSL', () => {
      const result = extractModuleContract(
        [],
        [tool('t', 'http', 'endpoint: {{env.SERVICE_URL}}')],
      );

      const names = result.requiredEnvVars.map((e) => e.name);
      expect(names).toContain('SERVICE_URL');
    });
  });

  describe('secret extraction', () => {
    it('warns on agent-level {{secrets.KEY}} references instead of publishing undeployable secrets', () => {
      const result = extractModuleContract([agent('a', 'auth: {{secrets.OPENAI_KEY}}')], []);

      const envNames = result.requiredEnvVars.map((e) => e.name);
      expect(envNames).not.toContain('OPENAI_KEY');
      expect(result.requiredSecrets).toEqual([]);
      expect(result.warnings).toEqual([
        expect.objectContaining({
          code: 'UNSCOPED_SECRET_REFERENCE',
          message: expect.stringContaining('OPENAI_KEY'),
        }),
      ]);
    });

    it('tracks tool-scoped {{secrets.KEY}} references without creating config keys', () => {
      const result = extractModuleContract([], [tool('t', 'http', 'key: {{secrets.DB_PASSWORD}}')]);

      const secretConfigs = result.requiredConfigKeys.filter((c) => c.isSecret);
      expect(secretConfigs.map((c) => c.key)).not.toContain('DB_PASSWORD');
      expect(result.requiredSecrets).toEqual([
        { key: 'DB_PASSWORD', referencedBy: ['tool:t'], toolName: 't' },
      ]);
    });

    it('tracks implicit tool-scoped fallback secrets for api_key and bearer auth tools', () => {
      const result = extractModuleContract(
        [],
        [
          tool(
            'lookup_customer',
            'http',
            'lookup_customer() -> object\n  type: http\n  auth: api_key',
          ),
          tool('sync_invoice', 'http', 'sync_invoice() -> object\n  type: http\n  auth: bearer'),
        ],
      );

      expect(result.requiredSecrets).toEqual([
        {
          key: 'api_key_token_lookup_customer',
          referencedBy: ['tool:lookup_customer'],
          toolName: 'lookup_customer',
        },
        {
          key: 'bearer_token_sync_invoice',
          referencedBy: ['tool:sync_invoice'],
          toolName: 'sync_invoice',
        },
      ]);
    });

    it('does not add implicit fallback secrets when auth credentials are explicit templates', () => {
      const result = extractModuleContract(
        [],
        [
          tool(
            'lookup_customer',
            'http',
            [
              'lookup_customer() -> object',
              '  type: http',
              '  auth: api_key',
              '  auth_config:',
              '    api_key: "{{secrets.CRM_API_KEY}}"',
            ].join('\n'),
          ),
          tool(
            'sync_invoice',
            'http',
            [
              'sync_invoice() -> object',
              '  type: http',
              '  auth: bearer',
              '  auth_config:',
              '    token: "{{env.INVOICE_TOKEN}}"',
            ].join('\n'),
          ),
        ],
      );

      expect(result.requiredSecrets).toEqual([
        {
          key: 'CRM_API_KEY',
          referencedBy: ['tool:lookup_customer'],
          toolName: 'lookup_customer',
        },
      ]);
      expect(result.requiredEnvVars).toEqual([{ name: 'INVOICE_TOKEN' }]);
    });

    it('tracks oauth and searchai implicit client secret requirements', () => {
      const result = extractModuleContract(
        [],
        [
          tool(
            'crm_oauth',
            'http',
            [
              'crm_oauth() -> object',
              '  type: http',
              '  auth: oauth2_client',
              '  auth_config:',
              '    token_url: https://auth.example.com/token',
              '    client_id: crm-client',
            ].join('\n'),
          ),
          tool(
            'search_docs',
            'http',
            [
              'search_docs() -> object',
              '  type: http',
              '  auth: searchai',
              '  auth_config:',
              '    token_url: https://search.example.com/token',
              '    client_id: search-client',
            ].join('\n'),
          ),
        ],
      );

      expect(result.requiredSecrets).toEqual([
        { key: 'oauth_client_secret', referencedBy: ['tool:crm_oauth'], toolName: 'crm_oauth' },
        {
          key: 'searchai_client_secret',
          referencedBy: ['tool:search_docs'],
          toolName: 'search_docs',
        },
      ]);
    });
  });

  describe('auth profile extraction', () => {
    it('extracts AUTH: directives from agent DSL', () => {
      const result = extractModuleContract(
        [agent('my-agent', 'TOOL t1\n  AUTH: production-openai')],
        [],
      );

      expect(result.requiredAuthProfiles).toEqual([
        expect.objectContaining({ name: 'production-openai', referencedBy: ['my-agent'] }),
      ]);
    });

    it('extracts AUTH: directives from tool DSL', () => {
      const result = extractModuleContract(
        [],
        [tool('my-tool', 'http', 'TOOL t1\n  AUTH: api-profile')],
      );

      expect(result.requiredAuthProfiles).toEqual([
        expect.objectContaining({ name: 'api-profile', referencedBy: ['tool:my-tool'] }),
      ]);
    });

    it('normalizes auth_profile_ref syntax to the referenced profile name', () => {
      const result = extractModuleContract(
        [],
        [tool('my-tool', 'http', 'TOOL t1\n  AUTH: auth_profile_ref billing-shared')],
      );

      expect(result.requiredAuthProfiles).toEqual([
        expect.objectContaining({ name: 'billing-shared', referencedBy: ['tool:my-tool'] }),
      ]);
    });

    it('extracts signature-first auth_profile properties', () => {
      const result = extractModuleContract(
        [],
        [
          tool(
            'my-tool',
            'http',
            'lookup_customer() -> object\n  type: http\n  auth_profile: crm-shared',
          ),
        ],
      );

      expect(result.requiredAuthProfiles).toEqual([
        expect.objectContaining({ name: 'crm-shared', referencedBy: ['tool:my-tool'] }),
      ]);
    });

    it('does not emit config-backed auth_profile templates as required auth profiles', () => {
      const result = extractModuleContract(
        [],
        [
          tool(
            'my-tool',
            'http',
            'lookup_customer() -> object\n  type: http\n  auth_profile: "{{config.CRM_AUTH_PROFILE}}"',
          ),
        ],
      );

      expect(result.requiredAuthProfiles).toEqual([]);
      expect(result.requiredConfigKeys.map((key) => key.key)).toContain('CRM_AUTH_PROFILE');
    });

    it('tracks referencedBy across multiple agents', () => {
      const result = extractModuleContract(
        [
          agent('agent-a', 'TOOL t1\n  AUTH: shared-profile'),
          agent('agent-b', 'TOOL t2\n  AUTH: shared-profile'),
        ],
        [],
      );

      const profile = result.requiredAuthProfiles.find((p) => p.name === 'shared-profile');
      expect(profile?.referencedBy).toEqual(['agent-a', 'agent-b']);
    });
  });

  describe('connector extraction', () => {
    it('extracts CONNECTOR: directives from tool DSL', () => {
      const result = extractModuleContract([], [tool('t', 'http', 'CONNECTOR: salesforce-prod')]);

      expect(result.requiredConnectors).toEqual([{ name: 'salesforce-prod' }]);
    });

    it('extracts multiple connectors', () => {
      const result = extractModuleContract(
        [],
        [tool('t', 'http', 'CONNECTOR: conn-a\nCONNECTOR: conn-b')],
      );

      expect(result.requiredConnectors.map((c) => c.name)).toEqual(['conn-a', 'conn-b']);
    });
  });

  describe('MCP server extraction', () => {
    it('extracts MCP_SERVER: directives from tool DSL', () => {
      const result = extractModuleContract([], [tool('t', 'mcp', 'MCP_SERVER: github-mcp')]);

      expect(result.requiredMcpServers).toEqual([{ name: 'github-mcp' }]);
    });
  });

  describe('config key extraction', () => {
    it('extracts {{config.KEY}} references', () => {
      const result = extractModuleContract([agent('a', 'timeout: {{config.REQUEST_TIMEOUT}}')], []);

      const keys = result.requiredConfigKeys.map((c) => c.key);
      expect(keys).toContain('REQUEST_TIMEOUT');
    });

    it('marks non-secret config keys with isSecret=false', () => {
      const result = extractModuleContract([agent('a', 'timeout: {{config.TIMEOUT}}')], []);

      const cfg = result.requiredConfigKeys.find((c) => c.key === 'TIMEOUT');
      expect(cfg?.isSecret).toBe(false);
    });

    it('does not mirror {{secrets.KEY}} into config keys', () => {
      const result = extractModuleContract([agent('a', 'key: {{secrets.API_SECRET}}')], []);

      const cfg = result.requiredConfigKeys.find((c) => c.key === 'API_SECRET');
      expect(cfg).toBeUndefined();
      expect(result.requiredSecrets).toEqual([]);
      expect(result.warnings).toEqual([
        expect.objectContaining({
          code: 'UNSCOPED_SECRET_REFERENCE',
          message: expect.stringContaining('API_SECRET'),
        }),
      ]);
    });
  });

  describe('deduplication', () => {
    it('deduplicates env var references across agents and tools', () => {
      const result = extractModuleContract(
        [agent('a', '{{env.SHARED_KEY}}')],
        [tool('t', 'http', '{{env.SHARED_KEY}}')],
      );

      const names = result.requiredEnvVars.filter((e) => e.name === 'SHARED_KEY');
      expect(names).toHaveLength(1);
    });

    it('deduplicates connector references across tools', () => {
      const result = extractModuleContract(
        [],
        [
          tool('t1', 'http', 'CONNECTOR: shared-conn'),
          tool('t2', 'http', 'CONNECTOR: shared-conn'),
        ],
      );

      expect(result.requiredConnectors).toHaveLength(1);
    });

    it('deduplicates config key references', () => {
      const result = extractModuleContract(
        [agent('a', '{{config.TIMEOUT}}'), agent('b', '{{config.TIMEOUT}}')],
        [],
      );

      const timeoutKeys = result.requiredConfigKeys.filter((c) => c.key === 'TIMEOUT');
      expect(timeoutKeys).toHaveLength(1);
    });

    it('deduplicates auth profile referencedBy', () => {
      const result = extractModuleContract(
        [agent('a', 'TOOL t1\n  AUTH: profile\nTOOL t2\n  AUTH: profile')],
        [],
      );

      const profile = result.requiredAuthProfiles.find((p) => p.name === 'profile');
      // referencedBy should have 'a' only once even though it references the profile twice
      expect(profile?.referencedBy).toEqual(['a']);
    });
  });

  describe('empty project', () => {
    it('returns empty contract when no agents or tools', () => {
      const result = extractModuleContract([], []);

      expect(result.providedAgents).toEqual([]);
      expect(result.providedTools).toEqual([]);
      expect(result.requiredEnvVars).toEqual([]);
      expect(result.requiredAuthProfiles).toEqual([]);
      expect(result.requiredConnectors).toEqual([]);
      expect(result.requiredMcpServers).toEqual([]);
      expect(result.requiredConfigKeys).toEqual([]);
      expect(result.warnings).toEqual([]);
    });
  });

  describe('mixed content', () => {
    it('extracts all reference types from agents and tools together', () => {
      const result = extractModuleContract(
        [
          agent('main', 'Use {{env.API_KEY}} and {{secrets.TOKEN}} with {{config.TIMEOUT}}'),
          agent('helper', 'TOOL t\n  AUTH: my-auth\nUse {{env.REGION}}'),
        ],
        [
          tool('http-tool', 'http', 'CONNECTOR: salesforce\n{{env.API_KEY}}'),
          tool('mcp-tool', 'mcp', 'MCP_SERVER: github-mcp\n{{secrets.MCP_SECRET}}'),
        ],
      );

      // Provided
      expect(result.providedAgents).toHaveLength(2);
      expect(result.providedTools).toHaveLength(2);

      // Env vars (API_KEY, REGION only; secrets are tracked separately)
      const envNames = result.requiredEnvVars.map((e) => e.name);
      expect(envNames).toContain('API_KEY');
      expect(envNames).toContain('REGION');
      expect(envNames).not.toContain('TOKEN');
      expect(envNames).not.toContain('MCP_SECRET');

      // Auth profiles
      expect(result.requiredAuthProfiles.map((a) => a.name)).toContain('my-auth');

      // Connectors
      expect(result.requiredConnectors.map((c) => c.name)).toContain('salesforce');

      // MCP servers
      expect(result.requiredMcpServers.map((m) => m.name)).toContain('github-mcp');

      // Config keys
      const configKeys = result.requiredConfigKeys.map((c) => c.key);
      expect(configKeys).toContain('TIMEOUT');
      expect(configKeys).not.toContain('MCP_SECRET');

      // Runtime secrets
      expect(result.requiredSecrets).toEqual([
        { key: 'MCP_SECRET', referencedBy: ['tool:mcp-tool'], toolName: 'mcp-tool' },
      ]);
      expect(result.warnings).toEqual([
        expect.objectContaining({
          code: 'UNSCOPED_SECRET_REFERENCE',
          message: expect.stringContaining('TOKEN'),
        }),
      ]);
    });
  });

  describe('enriched agent metadata from compiledIR', () => {
    it('extracts mode from execution.mode', () => {
      const result = extractModuleContract(
        [
          {
            name: 'orchestrator',
            dslContent: 'AGENT: orchestrator',
            compiledIR: { execution: { mode: 'sequential' } },
          },
        ],
        [],
      );

      expect(result.providedAgents[0]).toMatchObject({
        name: 'orchestrator',
        mode: 'sequential',
      });
    });

    it('extracts tool names from ir.tools', () => {
      const result = extractModuleContract(
        [
          {
            name: 'agent-a',
            dslContent: 'AGENT: agent-a',
            compiledIR: {
              tools: [{ name: 'search' }, { name: 'lookup' }],
            },
          },
        ],
        [],
      );

      expect(result.providedAgents[0].tools).toEqual(['search', 'lookup']);
    });

    it('extracts handoff targets from coordination.handoffs', () => {
      const result = extractModuleContract(
        [
          {
            name: 'router',
            dslContent: 'AGENT: router',
            compiledIR: {
              coordination: {
                handoffs: [{ to: 'billing-agent' }, { to: 'support-agent' }],
              },
            },
          },
        ],
        [],
      );

      expect(result.providedAgents[0].handoffTargets).toEqual(['billing-agent', 'support-agent']);
    });

    it('extracts delegate targets from coordination.delegates', () => {
      const result = extractModuleContract(
        [
          {
            name: 'manager',
            dslContent: 'AGENT: manager',
            compiledIR: {
              coordination: {
                delegates: [{ agent: 'worker-1' }, { agent: 'worker-2' }],
              },
            },
          },
        ],
        [],
      );

      expect(result.providedAgents[0].delegateTargets).toEqual(['worker-1', 'worker-2']);
    });

    it('sets hasGather when gather.fields is present', () => {
      const result = extractModuleContract(
        [
          {
            name: 'intake',
            dslContent: 'AGENT: intake',
            compiledIR: {
              gather: { fields: [{ name: 'email', type: 'string' }] },
            },
          },
        ],
        [],
      );

      expect(result.providedAgents[0].hasGather).toBe(true);
    });

    it('sets hasFlow when flow is present', () => {
      const result = extractModuleContract(
        [
          {
            name: 'flow-agent',
            dslContent: 'AGENT: flow-agent',
            compiledIR: {
              flow: { steps: [{ id: 'step-1' }] },
            },
          },
        ],
        [],
      );

      expect(result.providedAgents[0].hasFlow).toBe(true);
    });

    it('omits enriched fields when compiledIR is not provided', () => {
      const result = extractModuleContract([agent('simple', 'AGENT: simple')], []);

      const entry = result.providedAgents[0];
      expect(entry).toEqual({ name: 'simple' });
      expect(entry).not.toHaveProperty('mode');
      expect(entry).not.toHaveProperty('tools');
      expect(entry).not.toHaveProperty('handoffTargets');
      expect(entry).not.toHaveProperty('delegateTargets');
      expect(entry).not.toHaveProperty('hasGather');
      expect(entry).not.toHaveProperty('hasFlow');
    });

    it('omits enriched fields when compiledIR has empty arrays', () => {
      const result = extractModuleContract(
        [
          {
            name: 'empty-ir',
            dslContent: 'AGENT: empty-ir',
            compiledIR: {
              tools: [],
              coordination: { handoffs: [], delegates: [] },
              gather: { fields: [] },
            },
          },
        ],
        [],
      );

      const entry = result.providedAgents[0];
      expect(entry).toEqual({ name: 'empty-ir' });
    });
  });

  describe('enriched tool metadata from definition and DSL', () => {
    it('extracts description from definition', () => {
      const result = extractModuleContract(
        [],
        [
          {
            name: 'lookup',
            toolType: 'http',
            dslContent: 'lookup(id: string) -> object',
            definition: { description: 'Looks up a record by ID' },
          },
        ],
      );

      expect(result.providedTools[0].description).toBe('Looks up a record by ID');
    });

    it('falls back to DSL description when definition has none', () => {
      const result = extractModuleContract(
        [],
        [
          {
            name: 'lookup',
            toolType: 'http',
            dslContent: 'lookup(id: string) -> object\n  description: DSL description',
          },
        ],
      );

      expect(result.providedTools[0].description).toBe('DSL description');
    });

    it('prefers definition description over DSL description', () => {
      const result = extractModuleContract(
        [],
        [
          {
            name: 'lookup',
            toolType: 'http',
            dslContent: 'lookup(id: string) -> object\n  description: DSL desc',
            definition: { description: 'Def desc' },
          },
        ],
      );

      expect(result.providedTools[0].description).toBe('Def desc');
    });

    it('extracts parameters from DSL signature', () => {
      const result = extractModuleContract(
        [],
        [
          {
            name: 'search',
            toolType: 'http',
            dslContent: 'search(query: string, limit?: number) -> object',
          },
        ],
      );

      expect(result.providedTools[0].parameters).toEqual([
        { name: 'query', type: 'string', required: true },
        { name: 'limit', type: 'number', required: false },
      ]);
    });

    it('extracts returnType from DSL signature', () => {
      const result = extractModuleContract(
        [],
        [
          {
            name: 'get-user',
            toolType: 'http',
            dslContent: 'get_user(id: string) -> {name: string, email: string}',
          },
        ],
      );

      expect(result.providedTools[0].returnType).toBe('{name: string, email: string}');
    });

    it('extracts endpoint and method from definition http_binding', () => {
      const result = extractModuleContract(
        [],
        [
          {
            name: 'create-order',
            toolType: 'http',
            dslContent: 'create_order(item: string) -> object',
            definition: {
              http_binding: { url: 'https://api.example.com/orders', method: 'POST' },
            },
          },
        ],
      );

      expect(result.providedTools[0].endpoint).toBe('https://api.example.com/orders');
      expect(result.providedTools[0].method).toBe('POST');
    });

    it('extracts authProfileRef from definition', () => {
      const result = extractModuleContract(
        [],
        [
          {
            name: 'secure-tool',
            toolType: 'http',
            dslContent: 'secure_tool() -> object',
            definition: { auth_profile_ref: 'production-api' },
          },
        ],
      );

      expect(result.providedTools[0].authProfileRef).toBe('production-api');
    });

    it('extracts per-tool requiredEnvVars from DSL env references', () => {
      const result = extractModuleContract(
        [],
        [
          {
            name: 'api-tool',
            toolType: 'http',
            dslContent:
              'api_tool() -> object\n  url: {{env.API_HOST}}/path\n  header: {{env.API_TOKEN}}',
          },
        ],
      );

      expect(result.providedTools[0].requiredEnvVars).toEqual(['API_HOST', 'API_TOKEN']);
    });

    it('omits enriched fields when definition and DSL have no extra data', () => {
      const result = extractModuleContract([], [tool('simple-tool', 'mcp', 'TOOL: simple-tool')]);

      const entry = result.providedTools[0];
      expect(entry).toEqual({ name: 'simple-tool', toolType: 'mcp' });
      expect(entry).not.toHaveProperty('description');
      expect(entry).not.toHaveProperty('parameters');
      expect(entry).not.toHaveProperty('returnType');
      expect(entry).not.toHaveProperty('endpoint');
      expect(entry).not.toHaveProperty('method');
      expect(entry).not.toHaveProperty('authProfileRef');
      expect(entry).not.toHaveProperty('requiredEnvVars');
    });
  });

  describe('backward compatibility', () => {
    it('agents without compiledIR produce same output as before', () => {
      const result = extractModuleContract([agent('agent-a', 'AGENT: agent-a', 'My agent')], []);

      expect(result.providedAgents).toEqual([{ name: 'agent-a', description: 'My agent' }]);
    });

    it('tools without definition produce basic output with DSL-extracted fields', () => {
      const result = extractModuleContract(
        [],
        [tool('my-tool', 'http', 'my_tool(q: string) -> object\n  type: http')],
      );

      // Should still have parameters from DSL parsing
      expect(result.providedTools[0].name).toBe('my-tool');
      expect(result.providedTools[0].toolType).toBe('http');
      expect(result.providedTools[0].parameters).toEqual([
        { name: 'q', type: 'string', required: true },
      ]);
    });
  });

  describe('sorting', () => {
    it('sorts env vars alphabetically', () => {
      const result = extractModuleContract(
        [agent('a', '{{env.ZEBRA}} {{env.ALPHA}} {{env.MIDDLE}}')],
        [],
      );

      const names = result.requiredEnvVars.map((e) => e.name);
      expect(names).toEqual([...names].sort());
    });

    it('sorts auth profiles alphabetically', () => {
      const result = extractModuleContract(
        [agent('a', 'TOOL t1\n  AUTH: z-profile\nTOOL t2\n  AUTH: a-profile')],
        [],
      );

      const names = result.requiredAuthProfiles.map((p) => p.name);
      expect(names).toEqual([...names].sort());
    });

    it('sorts connectors alphabetically', () => {
      const result = extractModuleContract(
        [],
        [tool('t', 'http', 'CONNECTOR: z-conn\nCONNECTOR: a-conn')],
      );

      const names = result.requiredConnectors.map((c) => c.name);
      expect(names).toEqual([...names].sort());
    });

    it('sorts config keys alphabetically', () => {
      const result = extractModuleContract([agent('a', '{{config.ZEBRA}} {{config.ALPHA}}')], []);

      const keys = result.requiredConfigKeys.map((c) => c.key);
      expect(keys).toEqual([...keys].sort());
    });
  });
});
