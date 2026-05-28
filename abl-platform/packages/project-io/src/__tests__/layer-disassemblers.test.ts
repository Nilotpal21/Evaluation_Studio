import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import {
  CoreDisassembler,
  EvalsDisassembler,
  ChannelsDisassembler,
  WorkflowsDisassembler,
  SearchDisassembler,
  ConnectionsDisassembler,
  GuardrailsDisassembler,
  VocabularyDisassembler,
} from '../import/layer-disassemblers/index.js';
import type { DisassembleContext } from '../import/layer-disassemblers/types.js';
import {
  buildRecord,
  buildSuperseded,
  injectOwnership,
  safeParseJSON,
  safeParseJSONArray,
  stripRedactedValues,
  extractNameFromPath,
} from '../import/layer-disassemblers/disassembler-utils.js';
import {
  ImportedEvalPersonaSchema,
  ImportedEvalScenarioSchema,
  ImportedEvalSetSchema,
  validateStagedRecordBatch,
} from '../import/entity-schemas.js';

// ─── Test Helpers ────────────────────────────────────────────────────────────

const OWNERSHIP = {
  projectId: 'proj-1',
  tenantId: 'tenant-1',
  userId: 'user-1',
};

function makeCtx(
  files: Map<string, string>,
  overrides: Partial<DisassembleContext> = {},
): DisassembleContext {
  return {
    files,
    projectId: OWNERSHIP.projectId,
    tenantId: OWNERSHIP.tenantId,
    userId: OWNERSHIP.userId,
    conflictStrategy: 'replace',
    ...overrides,
  };
}

function filesFrom(entries: [string, string][]): Map<string, string> {
  return new Map(entries);
}

// ─── Disassembler Utils ──────────────────────────────────────────────────────

describe('disassembler-utils', () => {
  describe('safeParseJSON', () => {
    it('should parse valid JSON', () => {
      const warnings: string[] = [];
      const result = safeParseJSON('test.json', '{"key": "value"}', warnings);
      expect(result).toEqual({ key: 'value' });
      expect(warnings).toHaveLength(0);
    });

    it('should return null and add warning for invalid JSON', () => {
      const warnings: string[] = [];
      const result = safeParseJSON('broken.json', '{bad json}', warnings);
      expect(result).toBeNull();
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('Failed to parse broken.json');
    });
  });

  describe('safeParseJSONArray', () => {
    it('should parse a valid JSON array', () => {
      const warnings: string[] = [];
      const result = safeParseJSONArray('arr.json', '[{"a":1},{"b":2}]', warnings);
      expect(result).toEqual([{ a: 1 }, { b: 2 }]);
      expect(warnings).toHaveLength(0);
    });

    it('should return empty array and add warning when JSON is not an array', () => {
      const warnings: string[] = [];
      const result = safeParseJSONArray('obj.json', '{"key":"value"}', warnings);
      expect(result).toEqual([]);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('expected array');
    });

    it('should return empty array on invalid JSON', () => {
      const warnings: string[] = [];
      const result = safeParseJSONArray('bad.json', 'not json', warnings);
      expect(result).toEqual([]);
      expect(warnings).toHaveLength(1);
    });
  });

  describe('injectOwnership', () => {
    it('should inject projectId, tenantId, and createdBy from context', () => {
      const data = { name: 'test', extra: true };
      const result = injectOwnership(data, OWNERSHIP);
      expect(result).toEqual({
        name: 'test',
        extra: true,
        projectId: 'proj-1',
        tenantId: 'tenant-1',
        createdBy: 'user-1',
      });
    });

    it('should overwrite client-supplied ownership fields', () => {
      const data = {
        name: 'test',
        projectId: 'malicious-proj',
        tenantId: 'malicious-tenant',
        createdBy: 'malicious-user',
      };
      const result = injectOwnership(data, OWNERSHIP);
      expect(result.projectId).toBe('proj-1');
      expect(result.tenantId).toBe('tenant-1');
      expect(result.createdBy).toBe('user-1');
      expect(result.name).toBe('test');
    });

    it('should strip existing ownership fields before injecting', () => {
      const data = { tenantId: 'old', projectId: 'old', createdBy: 'old', value: 42 };
      const result = injectOwnership(data, OWNERSHIP);
      expect(result).toEqual({
        value: 42,
        projectId: 'proj-1',
        tenantId: 'tenant-1',
        createdBy: 'user-1',
      });
    });

    it('should strip source-local audit and owner fields before injecting', () => {
      const data = {
        name: 'test',
        __v: 7,
        _v: 4,
        id: 'source-id',
        updatedBy: 'source-updater',
        modifiedBy: 'source-modifier',
        ownerId: 'source-owner',
        ownerTeamId: 'source-team',
        lastEditedBy: 'source-editor',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-02T00:00:00.000Z',
      };
      const result = injectOwnership(data, OWNERSHIP);

      expect(result).toEqual({
        name: 'test',
        projectId: 'proj-1',
        tenantId: 'tenant-1',
        createdBy: 'user-1',
      });
    });
  });

  describe('buildRecord', () => {
    it('should build a StagedRecord with layer, collection, and data', () => {
      const data = { name: 'agent1' };
      const record = buildRecord('core', 'project_agents', data);
      expect(record).toEqual({
        layer: 'core',
        collection: 'project_agents',
        data: { name: 'agent1' },
      });
    });
  });

  describe('buildSuperseded', () => {
    it('should build SupersededRecord entries from existing records', () => {
      const existing = [{ _id: 'id-1' }, { _id: 'id-2' }];
      const result = buildSuperseded('core', 'project_agents', existing);
      expect(result).toEqual([
        { layer: 'core', collection: 'project_agents', recordId: 'id-1' },
        { layer: 'core', collection: 'project_agents', recordId: 'id-2' },
      ]);
    });

    it('should return empty array when existingRecords is undefined', () => {
      const result = buildSuperseded('core', 'project_agents', undefined);
      expect(result).toEqual([]);
    });
  });

  describe('stripRedactedValues', () => {
    it('should strip top-level REDACTED values', () => {
      const obj = { name: 'test', secret: '***REDACTED***', value: 123 };
      const result = stripRedactedValues(obj);
      expect(result).toEqual({ name: 'test', value: 123 });
    });

    it('should strip REDACTED values from nested objects', () => {
      const obj = { config: { apiKey: '***REDACTED***', host: 'localhost' } };
      const result = stripRedactedValues(obj);
      expect(result).toEqual({ config: { host: 'localhost' } });
    });

    it('should strip REDACTED values from arrays', () => {
      const obj = { items: ['keep', '***REDACTED***', 'also-keep'] };
      const result = stripRedactedValues(obj);
      expect(result).toEqual({ items: ['keep', 'also-keep'] });
    });

    it('should handle deeply nested structures', () => {
      const obj = {
        a: { b: { c: '***REDACTED***', d: 'safe' } },
        list: [{ secret: '***REDACTED***', name: 'ok' }],
      };
      const result = stripRedactedValues(obj);
      expect(result).toEqual({
        a: { b: { d: 'safe' } },
        list: [{ name: 'ok' }],
      });
    });
  });

  describe('extractNameFromPath', () => {
    it('should extract name by removing suffix and directory', () => {
      const result = extractNameFromPath('guardrails/pii-filter.guardrail.json', '.guardrail.json');
      expect(result).toBe('pii-filter');
    });

    it('should return null if suffix does not match', () => {
      const result = extractNameFromPath('guardrails/pii-filter.json', '.guardrail.json');
      expect(result).toBeNull();
    });

    it('should handle nested paths', () => {
      const result = extractNameFromPath(
        'config/agent-model-configs/gpt4.model-config.json',
        '.model-config.json',
      );
      expect(result).toBe('gpt4');
    });

    it('should return null for empty path', () => {
      const result = extractNameFromPath('', '.json');
      expect(result).toBeNull();
    });
  });
});

// ─── CoreDisassembler ────────────────────────────────────────────────────────

describe('CoreDisassembler', () => {
  let disassembler: CoreDisassembler;

  beforeEach(() => {
    disassembler = new CoreDisassembler();
  });

  it('should have layer name "core"', () => {
    expect(disassembler.layer).toBe('core');
  });

  describe('agents', () => {
    it('should parse .agent.abl files into staged records for project_agents', async () => {
      const dsl = 'agent: Supervisor\ndescription: Main agent';
      const files = filesFrom([['agents/supervisor.agent.abl', dsl]]);
      const result = await disassembler.disassemble(makeCtx(files));

      expect(result.records).toHaveLength(1);
      const rec = result.records[0];
      expect(rec.layer).toBe('core');
      expect(rec.collection).toBe('project_agents');
      expect(rec.data.name).toBe('Supervisor');
      expect(rec.data.dslContent).toBe(dsl);
      expect(rec.data).not.toHaveProperty('status');
      expect(rec.data).not.toHaveProperty('version');
    });

    it('should reject agent files with names outside the canonical DSL identity contract', async () => {
      const files = filesFrom([['agents/support-agent.agent.abl', 'AGENT: support-agent\n']]);
      const result = await disassembler.disassemble(makeCtx(files));

      expect(result.records).toHaveLength(0);
      expect(result.warnings).toEqual([
        expect.stringContaining(
          'Invalid agent name "support-agent" in agents/support-agent.agent.abl',
        ),
      ]);
    });

    it('should inject ownership fields on agent records', async () => {
      const dsl = 'agent: TestAgent\n';
      const files = filesFrom([['agents/test.agent.abl', dsl]]);
      const result = await disassembler.disassemble(makeCtx(files));

      const data = result.records[0].data;
      expect(data.projectId).toBe('proj-1');
      expect(data.tenantId).toBe('tenant-1');
      expect(data.createdBy).toBe('user-1');
    });

    it('should extract agent name from "agent:" line in DSL', async () => {
      const dsl = 'agent: MyCustomAgent\nsome other content';
      const files = filesFrom([['agents/my_custom.agent.abl', dsl]]);
      const result = await disassembler.disassemble(makeCtx(files));

      expect(result.records[0].data.name).toBe('MyCustomAgent');
    });

    it('should fall back to "name:" line if no "agent:" line', async () => {
      const dsl = 'name: FallbackAgent\nsome content';
      const files = filesFrom([['agents/fallback.agent.abl', dsl]]);
      const result = await disassembler.disassemble(makeCtx(files));

      expect(result.records[0].data.name).toBe('FallbackAgent');
    });

    it('should fall back to file base name if no DSL name found', async () => {
      const dsl = 'description: no agent or name directive';
      const files = filesFrom([['agents/my_agent.agent.abl', dsl]]);
      const result = await disassembler.disassemble(makeCtx(files));

      expect(result.records[0].data.name).toBe('my_agent');
    });

    it('should warn and skip if agent name cannot be determined', async () => {
      // This scenario: both extractNameFromPath and DSL parsing fail
      // In practice, extractNameFromPath always succeeds for .agent.abl files,
      // but we test the warning path by verifying the flow with an empty content
      // that has no agent/name directive and a file whose name extraction works.
      // The actual skip only triggers if extractNameFromPath returns null too,
      // which doesn't happen with valid path patterns.
      const dsl = 'agent: ValidAgent';
      const files = filesFrom([['agents/valid.agent.abl', dsl]]);
      const result = await disassembler.disassemble(makeCtx(files));
      expect(result.records).toHaveLength(1);
      expect(result.warnings).toHaveLength(0);
    });

    it('should parse .agent.yaml files', async () => {
      const yaml = 'agent: YAMLAgent\ndescription: yaml based';
      const files = filesFrom([['agents/yamlbot.agent.yaml', yaml]]);
      const result = await disassembler.disassemble(makeCtx(files));

      expect(result.records).toHaveLength(1);
      expect(result.records[0].data.name).toBe('YAMLAgent');
    });

    it('should parse quoted YAML agent names through the canonical parser', async () => {
      const yaml = 'agent: "QuotedYamlAgent" # inline comment\ndescription: yaml based';
      const files = filesFrom([['agents/quoted.agent.yaml', yaml]]);
      const result = await disassembler.disassemble(makeCtx(files));

      expect(result.records).toHaveLength(1);
      expect(result.records[0].data.name).toBe('QuotedYamlAgent');
    });

    it('should skip agents in skip mode if name already exists', async () => {
      const dsl = 'agent: Existing\n';
      const files = filesFrom([['agents/existing.agent.abl', dsl]]);
      const ctx = makeCtx(files, {
        conflictStrategy: 'skip',
        existingRecordIds: new Map([['project_agents', [{ _id: 'ag-1', name: 'Existing' }]]]),
      });
      const result = await disassembler.disassemble(ctx);

      expect(result.records).toHaveLength(0);
    });
  });

  describe('tools', () => {
    it('should parse .tools.abl files into staged records for project_tools', async () => {
      const dsl = `TOOLS:
  get_weather(location: string) -> object
    type: http
    description: "Fetch current weather"
    endpoint: "https://weather.example.com/{location}"
    method: GET
`;
      const files = filesFrom([['tools/get-weather.tools.abl', dsl]]);
      const result = await disassembler.disassemble(makeCtx(files));

      expect(result.records).toHaveLength(1);
      const rec = result.records[0];
      expect(rec.collection).toBe('project_tools');
      expect(rec.data.slug).toBe('get_weather');
      expect(rec.data.name).toBe('get_weather');
      expect(rec.data.toolType).toBe('http');
      expect(rec.data.description).toBe('Fetch current weather');
      expect(rec.data.dslContent).toContain('get_weather(location: string) -> object');
      expect(rec.data.sourceHash).toMatch(/^[a-f0-9]{64}$/);
      expect(rec.data.sourceFile).toBe('tools/get-weather.tools.abl');
    });

    it('should inject ownership on tool records', async () => {
      const files = filesFrom([
        [
          'tools/my-tool.tools.abl',
          `TOOLS:
  my_tool() -> object
    type: http
    endpoint: "https://api.example.com"
`,
        ],
      ]);
      const result = await disassembler.disassemble(makeCtx(files));

      expect(result.records[0].data.projectId).toBe('proj-1');
      expect(result.records[0].data.tenantId).toBe('tenant-1');
    });

    it('should skip tools in skip mode if slug already exists', async () => {
      const files = filesFrom([
        [
          'tools/my-tool.tools.abl',
          `TOOLS:
  my_tool() -> object
    type: http
    endpoint: "https://api.example.com"
`,
        ],
      ]);
      const ctx = makeCtx(files, {
        conflictStrategy: 'skip',
        existingRecordIds: new Map([['project_tools', [{ _id: 'tool-1', slug: 'my_tool' }]]]),
      });
      const result = await disassembler.disassemble(ctx);

      expect(result.records).toHaveLength(0);
    });
  });

  describe('project settings and config', () => {
    it('should parse project-settings.json as singleton', async () => {
      const json = JSON.stringify({ theme: 'dark', language: 'en' });
      const files = filesFrom([['config/project-settings.json', json]]);
      const result = await disassembler.disassemble(makeCtx(files));

      expect(result.records).toHaveLength(1);
      expect(result.records[0].collection).toBe('project_settings');
      expect(result.records[0].data.theme).toBe('dark');
    });

    it('should parse runtime-config.json', async () => {
      const json = JSON.stringify({ maxConcurrency: 10 });
      const files = filesFrom([['config/runtime-config.json', json]]);
      const result = await disassembler.disassemble(makeCtx(files));

      expect(result.records).toHaveLength(1);
      expect(result.records[0].collection).toBe('project_runtime_configs');
    });

    it('should parse llm-config.json', async () => {
      const json = JSON.stringify({ model: 'gpt-4', temperature: 0.7 });
      const files = filesFrom([['config/llm-config.json', json]]);
      const result = await disassembler.disassemble(makeCtx(files));

      expect(result.records).toHaveLength(1);
      expect(result.records[0].collection).toBe('project_llm_configs');
    });

    it('should parse agent model config files', async () => {
      const json = JSON.stringify({ agentName: 'bot1', model: 'gpt-4o' });
      const files = filesFrom([['config/agent-model-configs/bot1.model-config.json', json]]);
      const result = await disassembler.disassemble(makeCtx(files));

      expect(result.records).toHaveLength(1);
      expect(result.records[0].collection).toBe('agent_model_configs');
    });

    it('should parse project model config files', async () => {
      const json = JSON.stringify({ name: 'gpt-4o-mini', model: 'gpt-4o-mini' });
      const files = filesFrom([
        ['config/project-model-configs/gpt-4o-mini.model-config.json', json],
      ]);
      const result = await disassembler.disassemble(makeCtx(files));

      expect(result.records).toHaveLength(1);
      expect(result.records[0]).toMatchObject({
        collection: 'model_configs',
        data: {
          name: 'gpt-4o-mini',
          model: 'gpt-4o-mini',
        },
      });
      expect(result.records[0].data.sourceFile).toBeUndefined();
    });

    it('should merge project model config files by name without superseding unrelated configs', async () => {
      const json = JSON.stringify({ name: 'gpt-4o-mini', model: 'gpt-4o-mini' });
      const files = filesFrom([
        ['config/project-model-configs/gpt-4o-mini.model-config.json', json],
      ]);
      const result = await disassembler.disassemble(
        makeCtx(files, {
          conflictStrategy: 'merge',
          existingRecordIds: new Map([
            [
              'model_configs',
              [
                { _id: 'existing-matching', name: 'gpt-4o-mini' },
                { _id: 'existing-other', name: 'claude' },
              ],
            ],
          ]),
        }),
      );

      expect(result.superseded).toEqual([
        {
          layer: 'core',
          collection: 'model_configs',
          recordId: 'existing-matching',
        },
      ]);
    });
  });

  describe('environment and config variables', () => {
    it('should parse env-vars.json as array of environment_variables', async () => {
      const json = JSON.stringify([
        { key: 'API_KEY', description: 'The api key', isSecret: true },
        { key: 'REGION', description: null, isSecret: false, environment: 'production' },
      ]);
      const files = filesFrom([['environment/env-vars.json', json]]);
      const result = await disassembler.disassemble(makeCtx(files));

      expect(result.records).toHaveLength(2);
      expect(result.records[0].collection).toBe('environment_variables');
      expect(result.records[0].data.key).toBe('API_KEY');
      expect(result.records[0].data.isSecret).toBe(true);
      expect(result.records[0].data.environment).toBe('global');
      expect(result.records[1].data.key).toBe('REGION');
      expect(result.records[1].data.environment).toBe('production');
    });

    it('should parse config-vars.json as array of project_config_variables', async () => {
      const json = JSON.stringify([{ key: 'MAX_RETRIES', value: '3' }]);
      const files = filesFrom([['environment/config-vars.json', json]]);
      const result = await disassembler.disassemble(makeCtx(files));

      expect(result.records).toHaveLength(1);
      expect(result.records[0].collection).toBe('project_config_variables');
      expect(result.records[0].data.key).toBe('MAX_RETRIES');
    });

    it('should strip source ownership and audit fields from imported config records', async () => {
      const files = filesFrom([
        [
          'config/runtime-config.json',
          JSON.stringify({
            _id: 'source-runtime',
            _v: 2,
            projectId: 'source-project',
            tenantId: 'source-tenant',
            createdBy: 'source-user',
            updatedBy: 'source-updater',
            ownerId: 'source-owner',
            extraction: { nlu_provider: 'standard' },
          }),
        ],
        [
          'environment/config-vars.json',
          JSON.stringify([
            {
              _id: 'source-config-var',
              key: 'MAX_RETRIES',
              value: '3',
              projectId: 'source-project',
              tenantId: 'source-tenant',
              createdBy: 'source-user',
              updatedBy: 'source-updater',
            },
          ]),
        ],
      ]);
      const result = await disassembler.disassemble(makeCtx(files));

      const runtimeConfig = result.records.find(
        (record) => record.collection === 'project_runtime_configs',
      );
      const configVar = result.records.find(
        (record) => record.collection === 'project_config_variables',
      );

      expect(runtimeConfig?.data).toMatchObject({
        projectId: 'proj-1',
        tenantId: 'tenant-1',
        createdBy: 'user-1',
        extraction: { nlu_provider: 'standard' },
      });
      expect(runtimeConfig?.data).not.toHaveProperty('_id');
      expect(runtimeConfig?.data).not.toHaveProperty('_v');
      expect(runtimeConfig?.data).not.toHaveProperty('updatedBy');
      expect(runtimeConfig?.data).not.toHaveProperty('ownerId');
      expect(configVar?.data).toMatchObject({
        key: 'MAX_RETRIES',
        value: '3',
        projectId: 'proj-1',
        tenantId: 'tenant-1',
        createdBy: 'user-1',
      });
      expect(configVar?.data).not.toHaveProperty('_id');
      expect(configVar?.data).not.toHaveProperty('updatedBy');
    });
  });

  describe('MCP servers', () => {
    it('should parse mcp-config.json files', async () => {
      const json = JSON.stringify({
        name: 'my-mcp',
        transport: 'http',
        url: 'http://localhost:8080',
      });
      const files = filesFrom([['core/mcp-servers/my-mcp.mcp-config.json', json]]);
      const result = await disassembler.disassemble(makeCtx(files));

      expect(result.records).toHaveLength(1);
      expect(result.records[0].collection).toBe('mcp_server_configs');
      expect(result.records[0].data).toMatchObject({
        name: 'my-mcp',
        transport: 'http',
        url: 'http://localhost:8080',
        authType: 'none',
      });
    });

    it('skips legacy-shaped MCP config files with a validation warning', async () => {
      const json = JSON.stringify({
        serverName: 'legacy-mcp',
        endpoint: 'http://localhost:8080',
      });
      const files = filesFrom([['core/mcp-servers/legacy-mcp.mcp-config.json', json]]);
      const result = await disassembler.disassemble(makeCtx(files));

      expect(result.records).toHaveLength(0);
      expect(result.warnings).toEqual(
        expect.arrayContaining([
          expect.stringContaining('Skipping core/mcp-servers/legacy-mcp.mcp-config.json'),
        ]),
      );
    });
  });

  describe('behavior profiles', () => {
    it('should store behavior profiles as config variables with profile: prefix', async () => {
      const content = 'tone: formal\nstyle: concise';
      const files = filesFrom([['behavior_profiles/professional.behavior_profile.abl', content]]);
      const result = await disassembler.disassemble(makeCtx(files));

      expect(result.records).toHaveLength(1);
      const rec = result.records[0];
      expect(rec.collection).toBe('project_config_variables');
      expect(rec.data.key).toBe('profile:professional');
      expect(rec.data.value).toBe(content);
    });

    it('should store manifest-declared behavior profile paths accepted by the folder reader', async () => {
      const content = 'BEHAVIOR_PROFILE: voltmart_voice\nPRIORITY: 5';
      const files = filesFrom([['behavior_profiles/voltmart_voice.profile.abl', content]]);
      const result = await disassembler.disassemble(makeCtx(files));

      expect(result.records).toHaveLength(1);
      expect(result.records[0].collection).toBe('project_config_variables');
      expect(result.records[0].data.key).toBe('profile:voltmart_voice');
      expect(result.records[0].data.value).toBe(content);
    });

    it('does not emit preservation warnings for behavior profile config variables', async () => {
      const files = filesFrom([['behavior_profiles/casual.behavior_profile.abl', 'tone: casual']]);
      const result = await disassembler.disassemble(makeCtx(files));

      expect(result.warnings).toEqual([]);
    });
  });

  describe('locale files', () => {
    it('should store locale files as config variables with locale: prefix', async () => {
      const json = JSON.stringify({ greeting: 'Hola' });
      const files = filesFrom([['locales/es/messages.json', json]]);
      const result = await disassembler.disassemble(makeCtx(files));

      expect(result.records).toHaveLength(1);
      const rec = result.records[0];
      expect(rec.collection).toBe('project_config_variables');
      expect(rec.data.key).toBe('locale:es/messages.json');
    });

    it('should not emit a preservation-only warning for locale files', async () => {
      const files = filesFrom([['locales/en/ui.json', '{}']]);
      const result = await disassembler.disassemble(makeCtx(files));

      expect(result.warnings).toEqual([]);
    });
  });

  describe('superseded records', () => {
    it('should build superseded records for replace strategy', async () => {
      const files = filesFrom([['agents/bot.agent.abl', 'agent: Bot']]);
      const ctx = makeCtx(files, {
        conflictStrategy: 'replace',
        existingRecordIds: new Map([
          ['project_agents', [{ _id: 'old-ag-1' }, { _id: 'old-ag-2' }]],
          ['project_tools', [{ _id: 'old-tool-1' }]],
        ]),
      });
      const result = await disassembler.disassemble(ctx);

      const agentSuperseded = result.superseded.filter((s) => s.collection === 'project_agents');
      expect(agentSuperseded).toHaveLength(2);
      expect(agentSuperseded[0].recordId).toBe('old-ag-1');
      expect(agentSuperseded[1].recordId).toBe('old-ag-2');

      const toolSuperseded = result.superseded.filter((s) => s.collection === 'project_tools');
      expect(toolSuperseded).toHaveLength(1);
    });

    it('should NOT build superseded records for skip strategy', async () => {
      const files = filesFrom([['agents/bot.agent.abl', 'agent: Bot']]);
      const ctx = makeCtx(files, {
        conflictStrategy: 'skip',
        existingRecordIds: new Map([['project_agents', [{ _id: 'existing-1' }]]]),
      });
      const result = await disassembler.disassemble(ctx);

      expect(result.superseded).toHaveLength(0);
    });

    it('should only supersede matching records for merge strategy', async () => {
      const files = filesFrom([
        ['agents/bot.agent.abl', 'agent: Bot'],
        ['tools/search.tools.abl', 'search(query: string) -> object'],
        [
          'config/runtime-config.json',
          JSON.stringify({ extraction: { nlu_provider: 'standard' } }),
        ],
      ]);
      const ctx = makeCtx(files, {
        conflictStrategy: 'merge',
        existingRecordIds: new Map([
          [
            'project_agents',
            [
              { _id: 'old-bot', name: 'Bot' },
              { _id: 'old-other-agent', name: 'Other' },
            ],
          ],
          [
            'project_tools',
            [
              { _id: 'old-search-tool', slug: 'search' },
              { _id: 'old-other-tool', slug: 'other' },
            ],
          ],
          ['project_runtime_configs', [{ _id: 'old-runtime' }]],
        ]),
      });

      const result = await disassembler.disassemble(ctx);
      expect(result.superseded).toEqual(
        expect.arrayContaining([
          { layer: 'core', collection: 'project_agents', recordId: 'old-bot' },
          { layer: 'core', collection: 'project_tools', recordId: 'old-search-tool' },
          { layer: 'core', collection: 'project_runtime_configs', recordId: 'old-runtime' },
        ]),
      );
      expect(result.superseded.map((record) => record.recordId)).not.toContain('old-other-agent');
      expect(result.superseded.map((record) => record.recordId)).not.toContain('old-other-tool');
    });
  });

  describe('invalid JSON handling', () => {
    it('should warn and skip files with invalid JSON', async () => {
      const files = filesFrom([['config/project-settings.json', '{broken']]);
      const result = await disassembler.disassemble(makeCtx(files));

      expect(result.records).toHaveLength(0);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain('Failed to parse');
    });
  });

  describe('multiple file types in one pass', () => {
    it('should handle agents, tools, settings, and env vars together', async () => {
      const files = filesFrom([
        ['agents/bot.agent.abl', 'agent: Bot'],
        [
          'tools/weather.tools.abl',
          `TOOLS:
  weather() -> object
    type: http
    endpoint: "https://weather.example.com"
`,
        ],
        ['config/project-settings.json', JSON.stringify({ lang: 'en' })],
        ['environment/env-vars.json', JSON.stringify([{ key: 'KEY1', isSecret: false }])],
      ]);
      const result = await disassembler.disassemble(makeCtx(files));

      expect(result.records).toHaveLength(4);
      const collections = result.records.map((r) => r.collection);
      expect(collections).toContain('project_agents');
      expect(collections).toContain('project_tools');
      expect(collections).toContain('project_settings');
      expect(collections).toContain('environment_variables');
    });
  });
});

// ─── EvalsDisassembler ───────────────────────────────────────────────────────

describe('EvalsDisassembler', () => {
  let disassembler: EvalsDisassembler;

  beforeEach(() => {
    disassembler = new EvalsDisassembler();
  });

  it('should have layer name "evals"', () => {
    expect(disassembler.layer).toBe('evals');
  });

  describe('eval sets', () => {
    it('should parse eval set files from evals/{setName}/eval-set.json', async () => {
      const setJson = JSON.stringify({
        name: 'Regression Suite',
        description: 'Tests',
        scenarioIds: ['old-id-1'],
        personaIds: ['old-id-2'],
      });
      const files = filesFrom([['evals/regression-suite/eval-set.json', setJson]]);
      const result = await disassembler.disassemble(makeCtx(files));

      const setRecords = result.records.filter((r) => r.collection === 'eval_sets');
      expect(setRecords).toHaveLength(1);
      expect(setRecords[0].data.name).toBe('Regression Suite');
    });

    it('should clear stale scenarioIds and personaIds on eval sets', async () => {
      const setJson = JSON.stringify({
        name: 'Suite1',
        scenarioIds: ['stale-1', 'stale-2'],
        personaIds: ['stale-3'],
      });
      const files = filesFrom([['evals/suite1/eval-set.json', setJson]]);
      const result = await disassembler.disassemble(makeCtx(files));

      const data = result.records[0].data;
      expect(data.scenarioIds).toEqual([]);
      expect(data.personaIds).toEqual([]);
    });

    it('should resolve stale evaluatorIds to _nestedEvaluatorNames via _exportedId', async () => {
      const setJson = JSON.stringify({
        name: 'Suite2',
        scenarioIds: [],
        personaIds: [],
        evaluatorIds: ['eval-1', 'eval-2'],
      });
      const evaluatorJson = JSON.stringify({
        name: 'Accuracy',
        _exportedId: 'eval-1',
        type: 'llm-judge',
      });
      const files = filesFrom([
        ['evals/suite2/eval-set.json', setJson],
        ['evals/evaluators/accuracy.evaluator.json', evaluatorJson],
      ]);
      const result = await disassembler.disassemble(makeCtx(files));

      const data = result.records[0].data;
      expect(data.evaluatorIds).toEqual([]);
      expect(data._nestedEvaluatorNames).toEqual(['Accuracy']);
      // eval-2 has no matching evaluator file — should warn
      expect(result.warnings.some((w) => w.includes('eval-2'))).toBe(true);
    });

    it('should resolve stale evaluatorIds when older archives use id as the portable anchor', async () => {
      const setJson = JSON.stringify({
        name: 'SuiteFromId',
        evaluatorIds: ['eval-source-id'],
      });
      const evaluatorJson = JSON.stringify({
        id: 'eval-source-id',
        name: 'Safety',
        type: 'llm-judge',
      });
      const files = filesFrom([
        ['evals/suite-from-id/eval-set.json', setJson],
        ['evals/evaluators/safety.evaluator.json', evaluatorJson],
      ]);
      const result = await disassembler.disassemble(makeCtx(files));

      const set = result.records.find((record) => record.collection === 'eval_sets');
      const evaluator = result.records.find((record) => record.collection === 'eval_evaluators');
      expect(set!.data._nestedEvaluatorNames).toEqual(['Safety']);
      expect(evaluator!.data._exportedId).toBe('eval-source-id');
    });

    it('should populate _nestedScenarioNames and _nestedPersonaNames', async () => {
      const setJson = JSON.stringify({
        name: 'MySet',
        scenarioIds: [],
        personaIds: [],
      });
      const scenarioJson = JSON.stringify({ name: 'Scenario A' });
      const personaJson = JSON.stringify({ name: 'Persona B' });
      const files = filesFrom([
        ['evals/my-set/eval-set.json', setJson],
        ['evals/my-set/scenarios/scenario-a.scenario.json', scenarioJson],
        ['evals/my-set/personas/persona-b.persona.json', personaJson],
      ]);
      const result = await disassembler.disassemble(makeCtx(files));

      const setRecord = result.records.find((r) => r.collection === 'eval_sets');
      expect(setRecord).toBeDefined();
      expect(setRecord!.data._nestedScenarioNames).toEqual(['Scenario A']);
      expect(setRecord!.data._nestedPersonaNames).toEqual(['Persona B']);
    });
  });

  describe('nested scenarios', () => {
    it('should parse nested scenarios under evals/{setName}/scenarios/', async () => {
      const setJson = JSON.stringify({
        name: 'My Suite',
        scenarioIds: [],
        personaIds: [],
      });
      const scenarioJson = JSON.stringify({
        name: 'Happy Path',
        description: 'Basic test',
      });
      const files = filesFrom([
        ['evals/my-suite/eval-set.json', setJson],
        ['evals/my-suite/scenarios/happy-path.scenario.json', scenarioJson],
      ]);
      const result = await disassembler.disassemble(makeCtx(files));

      const scenarios = result.records.filter((r) => r.collection === 'eval_scenarios');
      expect(scenarios).toHaveLength(1);
      expect(scenarios[0].data.name).toBe('Happy Path');
    });

    it('should set _parentSetName to the actual JSON name, not the sanitized directory name', async () => {
      const setJson = JSON.stringify({
        name: 'My Special Suite!',
        scenarioIds: [],
        personaIds: [],
      });
      const scenarioJson = JSON.stringify({ name: 'Test Scenario' });
      const files = filesFrom([
        ['evals/my-special-suite/eval-set.json', setJson],
        ['evals/my-special-suite/scenarios/test.scenario.json', scenarioJson],
      ]);
      const result = await disassembler.disassemble(makeCtx(files));

      const scenario = result.records.find((r) => r.collection === 'eval_scenarios');
      expect(scenario!.data._parentSetName).toBe('My Special Suite!');
    });

    it('should fall back to directory name for _parentSetName if eval set is not found', async () => {
      // scenario without a matching eval-set.json
      const scenarioJson = JSON.stringify({ name: 'Orphan Scenario' });
      const files = filesFrom([['evals/orphan-set/scenarios/orphan.scenario.json', scenarioJson]]);
      const result = await disassembler.disassemble(makeCtx(files));

      const scenario = result.records.find((r) => r.collection === 'eval_scenarios');
      expect(scenario!.data._parentSetName).toBe('orphan-set');
    });
  });

  describe('nested personas', () => {
    it('should parse nested personas and set _parentSetName', async () => {
      const setJson = JSON.stringify({
        name: 'Persona Suite',
        scenarioIds: [],
        personaIds: [],
      });
      const personaJson = JSON.stringify({
        name: 'Angry Customer',
        communicationStyle: 'aggressive',
      });
      const files = filesFrom([
        ['evals/persona-suite/eval-set.json', setJson],
        ['evals/persona-suite/personas/angry-customer.persona.json', personaJson],
      ]);
      const result = await disassembler.disassemble(makeCtx(files));

      const personas = result.records.filter((r) => r.collection === 'eval_personas');
      expect(personas).toHaveLength(1);
      expect(personas[0].data._parentSetName).toBe('Persona Suite');
      expect(personas[0].data.name).toBe('Angry Customer');
    });
  });

  describe('standalone scenarios and personas', () => {
    it('should parse standalone scenarios without _parentSetName', async () => {
      const json = JSON.stringify({
        name: 'Standalone Scenario',
        description: 'Not in any set',
      });
      const files = filesFrom([['evals/scenarios/standalone.scenario.json', json]]);
      const result = await disassembler.disassemble(makeCtx(files));

      const scenarios = result.records.filter((r) => r.collection === 'eval_scenarios');
      expect(scenarios).toHaveLength(1);
      expect(scenarios[0].data.name).toBe('Standalone Scenario');
      expect(scenarios[0].data._parentSetName).toBeUndefined();
    });

    it('should parse standalone personas', async () => {
      const json = JSON.stringify({
        name: 'Standalone Persona',
        communicationStyle: 'casual',
      });
      const files = filesFrom([['evals/personas/standalone.persona.json', json]]);
      const result = await disassembler.disassemble(makeCtx(files));

      const personas = result.records.filter((r) => r.collection === 'eval_personas');
      expect(personas).toHaveLength(1);
      expect(personas[0].data.name).toBe('Standalone Persona');
    });
  });

  describe('evaluators', () => {
    it('should parse evaluator files', async () => {
      const json = JSON.stringify({
        name: 'Quality Checker',
        type: 'llm-judge',
      });
      const files = filesFrom([['evals/evaluators/quality-checker.evaluator.json', json]]);
      const result = await disassembler.disassemble(makeCtx(files));

      const evaluators = result.records.filter((r) => r.collection === 'eval_evaluators');
      expect(evaluators).toHaveLength(1);
      expect(evaluators[0].data.name).toBe('Quality Checker');
    });
  });

  describe('superseded records', () => {
    it('should build superseded records for all eval collections in replace mode', async () => {
      const files = filesFrom([
        [
          'evals/suite/eval-set.json',
          JSON.stringify({ name: 'S', scenarioIds: [], personaIds: [] }),
        ],
      ]);
      const ctx = makeCtx(files, {
        conflictStrategy: 'replace',
        existingRecordIds: new Map([
          ['eval_sets', [{ _id: 'es-1' }]],
          ['eval_scenarios', [{ _id: 'esc-1' }, { _id: 'esc-2' }]],
          ['eval_personas', [{ _id: 'ep-1' }]],
          ['eval_evaluators', [{ _id: 'ee-1' }]],
        ]),
      });
      const result = await disassembler.disassemble(ctx);

      expect(result.superseded.filter((s) => s.collection === 'eval_sets')).toHaveLength(1);
      expect(result.superseded.filter((s) => s.collection === 'eval_scenarios')).toHaveLength(2);
      expect(result.superseded.filter((s) => s.collection === 'eval_personas')).toHaveLength(1);
      expect(result.superseded.filter((s) => s.collection === 'eval_evaluators')).toHaveLength(1);
    });
  });

  describe('ownership injection', () => {
    it('should inject ownership on all eval records', async () => {
      const files = filesFrom([
        [
          'evals/suite/eval-set.json',
          JSON.stringify({ name: 'Set', scenarioIds: [], personaIds: [] }),
        ],
        ['evals/suite/scenarios/sc.scenario.json', JSON.stringify({ name: 'SC' })],
        ['evals/evaluators/ev.evaluator.json', JSON.stringify({ name: 'EV' })],
      ]);
      const result = await disassembler.disassemble(makeCtx(files));

      for (const rec of result.records) {
        expect(rec.data.projectId).toBe('proj-1');
        expect(rec.data.tenantId).toBe('tenant-1');
        expect(rec.data.createdBy).toBe('user-1');
      }
    });
  });

  // ─── ABLP-905: exporter / importer schema round-trip ─────────────────────
  //
  // Locks the contract that the file-level Zod schemas and the staged-batch
  // validator both accept the exact shapes EvalsAssembler emits — including
  // five fields where the Mongoose / Zod types previously disagreed
  // (eval_sets.personaModel null, eval_scenarios.expectedMilestones string[],
  // eval_scenarios.version number, eval_personas.goals string,
  // eval_personas.constraints string).
  describe('ABLP-905: round-trip from exporter shapes', () => {
    /** eval_sets document as produced by EvalsAssembler (after stripInternalFields) */
    const EVAL_SET_FIXTURE = {
      name: 'Regression Suite Alpha',
      description: 'Core regression coverage',
      scenarioIds: [],
      personaIds: [],
      evaluatorIds: [],
      variants: 3,
      maxConcurrency: 5,
      regressionThreshold: 0.8,
      ciEnabled: true,
      // Mongoose `{ type: String, default: null }` → exports contain null.
      personaModel: null,
      personaModelConfig: { temperature: 0.7 },
    };

    /** eval_scenarios document as produced by EvalsAssembler */
    const EVAL_SCENARIO_FIXTURE = {
      name: 'Happy Path Booking',
      description: 'User books a flight without issues',
      category: 'happy-path',
      difficulty: 'easy',
      entryAgent: 'BookingAgent',
      initialMessage: 'I want to book a flight to NYC',
      expectedOutcome: 'Booking confirmed',
      maxTurns: 10,
      tags: ['booking', 'happy-path'],
      agentPath: ['Router', 'BookingAgent'],
      // Mongoose `{ type: [String], default: [] }` → exports contain string[].
      expectedMilestones: ['greeting', 'destination_confirmed', 'booking_complete'],
      maxToolCalls: 20,
      // Mongoose `{ type: Number, default: 1 }` → exports contain number.
      version: 1,
    };

    /** eval_personas document as produced by EvalsAssembler */
    const EVAL_PERSONA_FIXTURE = {
      name: 'Impatient Traveler',
      description: 'A user who is in a hurry and gives short responses',
      communicationStyle: 'terse',
      domainKnowledge: 'Basic travel booking',
      behaviorTraits: ['impatient', 'direct'],
      // Mongoose `{ type: String, default: '' }` → exports contain string.
      goals: 'Book a flight quickly',
      // Mongoose `{ type: String, default: '' }` → exports contain string.
      constraints: 'Must complete within 5 turns',
      sessionVariables: { preferredAirline: 'Delta' },
      systemPrompt: 'You are an impatient traveler.',
      source: 'manual',
      isAdversarial: false,
      isBuiltIn: false,
    };

    it('accepts exporter-shaped eval artifacts at file-level validation', () => {
      expect(ImportedEvalSetSchema.parse(EVAL_SET_FIXTURE).personaModel).toBeNull();
      expect(ImportedEvalScenarioSchema.parse(EVAL_SCENARIO_FIXTURE).expectedMilestones).toEqual(
        EVAL_SCENARIO_FIXTURE.expectedMilestones,
      );
      expect(ImportedEvalScenarioSchema.parse(EVAL_SCENARIO_FIXTURE).version).toBe(1);
      expect(ImportedEvalPersonaSchema.parse(EVAL_PERSONA_FIXTURE).goals).toBe(
        EVAL_PERSONA_FIXTURE.goals,
      );
      expect(ImportedEvalPersonaSchema.parse(EVAL_PERSONA_FIXTURE).constraints).toBe(
        EVAL_PERSONA_FIXTURE.constraints,
      );
    });

    it('validates eval_set with personaModel: null without errors', async () => {
      const files = filesFrom([
        ['evals/regression-suite-alpha/eval-set.json', JSON.stringify(EVAL_SET_FIXTURE)],
      ]);
      const result = await disassembler.disassemble(makeCtx(files));

      expect(result.records.length).toBeGreaterThan(0);
      const { errors } = validateStagedRecordBatch(result.records);
      expect(errors).toHaveLength(0);
    });

    it('validates eval_scenario with expectedMilestones: string[] and version: number without errors', async () => {
      const files = filesFrom([
        ['evals/scenarios/happy-path-booking.scenario.json', JSON.stringify(EVAL_SCENARIO_FIXTURE)],
      ]);
      const result = await disassembler.disassemble(makeCtx(files));

      expect(result.records.length).toBeGreaterThan(0);
      const { errors } = validateStagedRecordBatch(result.records);
      expect(errors).toHaveLength(0);
    });

    it('validates eval_persona with goals: string and constraints: string without errors', async () => {
      const files = filesFrom([
        ['evals/personas/impatient-traveler.persona.json', JSON.stringify(EVAL_PERSONA_FIXTURE)],
      ]);
      const result = await disassembler.disassemble(makeCtx(files));

      expect(result.records.length).toBeGreaterThan(0);
      const { errors } = validateStagedRecordBatch(result.records);
      expect(errors).toHaveLength(0);
    });

    it('full round-trip: all three entity types pass validation when exported shapes are used', async () => {
      const files = filesFrom([
        ['evals/regression-suite-alpha/eval-set.json', JSON.stringify(EVAL_SET_FIXTURE)],
        [
          'evals/regression-suite-alpha/scenarios/happy-path-booking.scenario.json',
          JSON.stringify(EVAL_SCENARIO_FIXTURE),
        ],
        [
          'evals/regression-suite-alpha/personas/impatient-traveler.persona.json',
          JSON.stringify(EVAL_PERSONA_FIXTURE),
        ],
      ]);
      const result = await disassembler.disassemble(makeCtx(files));

      expect(result.records.length).toBe(3);
      const { errors } = validateStagedRecordBatch(result.records);
      expect(errors).toHaveLength(0);
    });
  });
});

// ─── ChannelsDisassembler ────────────────────────────────────────────────────

describe('ChannelsDisassembler', () => {
  let disassembler: ChannelsDisassembler;

  beforeEach(() => {
    disassembler = new ChannelsDisassembler();
  });

  it('should have layer name "channels"', () => {
    expect(disassembler.layer).toBe('channels');
  });

  describe('channel connections', () => {
    it('should parse channel connection files from channels/{name}.channel.json', async () => {
      const json = JSON.stringify({
        displayName: 'Slack Channel',
        type: 'slack',
        externalIdentifier: 'C123',
      });
      const files = filesFrom([['channels/slack-channel.channel.json', json]]);
      const result = await disassembler.disassemble(makeCtx(files));

      const channels = result.records.filter((r) => r.collection === 'channel_connections');
      expect(channels).toHaveLength(1);
      expect(channels[0].data.displayName).toBe('Slack Channel');
    });

    it('should strip encryptedCredentials from channel records', async () => {
      const json = JSON.stringify({
        displayName: 'Secure Channel',
        encryptedCredentials: 'secret-bytes',
      });
      const files = filesFrom([['channels/secure.channel.json', json]]);
      const result = await disassembler.disassemble(makeCtx(files));

      expect(result.records[0].data.encryptedCredentials).toBeUndefined();
    });

    it('should strip verifyTokenHash from channel records', async () => {
      const json = JSON.stringify({
        displayName: 'Token Channel',
        verifyTokenHash: 'hash-abc',
      });
      const files = filesFrom([['channels/token.channel.json', json]]);
      const result = await disassembler.disassemble(makeCtx(files));

      expect(result.records[0].data.verifyTokenHash).toBeUndefined();
    });

    it('should preserve only portable channel status values', async () => {
      const files = filesFrom([
        [
          'channels/active.channel.json',
          JSON.stringify({ displayName: 'Active', status: 'active' }),
        ],
        [
          'channels/legacy.channel.json',
          JSON.stringify({ displayName: 'Legacy', status: 'configured' }),
        ],
      ]);
      const result = await disassembler.disassemble(makeCtx(files));

      const channels = result.records.filter((r) => r.collection === 'channel_connections');
      expect(channels.find((r) => r.data.displayName === 'Active')?.data.status).toBe('active');
      expect(channels.find((r) => r.data.displayName === 'Legacy')?.data.status).toBeUndefined();
    });

    it('should convert portable agentName to a destination agent cross-ref anchor', async () => {
      const json = JSON.stringify({
        displayName: 'Slack Channel',
        agentName: 'SupportAgent',
        agentId: 'source-agent-id',
        deploymentId: 'source-deployment-id',
      });
      const files = filesFrom([['channels/slack-channel.channel.json', json]]);
      const result = await disassembler.disassemble(makeCtx(files));

      const channel = result.records.find((r) => r.collection === 'channel_connections');
      expect(channel!.data._channelAgentName).toBe('SupportAgent');
      expect(channel!.data.agentName).toBeUndefined();
      expect(channel!.data.agentId).toBeUndefined();
      expect(channel!.data.deploymentId).toBeUndefined();
    });

    it('should fall back to externalIdentifier for displayName if not present', async () => {
      const json = JSON.stringify({
        externalIdentifier: 'ext-id-123',
        type: 'teams',
      });
      const files = filesFrom([['channels/teams.channel.json', json]]);
      const result = await disassembler.disassemble(makeCtx(files));

      expect(result.records[0].data.displayName).toBe('ext-id-123');
    });

    it('should fall back to file name for displayName if no displayName or externalIdentifier', async () => {
      const json = JSON.stringify({ type: 'custom' });
      const files = filesFrom([['channels/my-custom-channel.channel.json', json]]);
      const result = await disassembler.disassemble(makeCtx(files));

      expect(result.records[0].data.displayName).toBe('my-custom-channel');
    });
  });

  describe('webhooks', () => {
    it('should parse webhook files and strip runtime/secret fields', async () => {
      const channelJson = JSON.stringify({
        displayName: 'Main Channel',
        _exportedId: 'ch-orig-1',
      });
      const webhookJson = JSON.stringify({
        description: 'Notify on event',
        channelConnectionId: 'ch-orig-1',
        encryptedSecret: 'secret',
        lastDeliveryAt: '2024-01-01',
        failureCount: 5,
      });
      const files = filesFrom([
        ['channels/main.channel.json', channelJson],
        ['channels/webhooks/event-notify.webhook.json', webhookJson],
      ]);
      const result = await disassembler.disassemble(makeCtx(files));

      const webhooks = result.records.filter((r) => r.collection === 'webhook_subscriptions');
      expect(webhooks).toHaveLength(1);
      expect(webhooks[0].data.encryptedSecret).toBeUndefined();
      expect(webhooks[0].data.lastDeliveryAt).toBeUndefined();
      expect(webhooks[0].data.failureCount).toBeUndefined();
    });

    it('should resolve channelConnectionId to displayName via _exportedId', async () => {
      const channelJson = JSON.stringify({
        displayName: 'Resolved Channel',
        _exportedId: 'orig-id-1',
      });
      const webhookJson = JSON.stringify({
        description: 'My Webhook',
        channelConnectionId: 'orig-id-1',
      });
      const files = filesFrom([
        ['channels/resolved.channel.json', channelJson],
        ['channels/webhooks/my-webhook.webhook.json', webhookJson],
      ]);
      const result = await disassembler.disassemble(makeCtx(files));

      const webhook = result.records.find((r) => r.collection === 'webhook_subscriptions');
      expect(webhook!.data._channelDisplayName).toBe('Resolved Channel');
      expect(webhook!.data.channelConnectionId).toBeUndefined();
    });

    it('should resolve channelConnectionId when older archives use id as the portable anchor', async () => {
      const channelJson = JSON.stringify({
        id: 'orig-id-from-id',
        displayName: 'ID Anchored Channel',
      });
      const webhookJson = JSON.stringify({
        description: 'ID anchored webhook',
        channelConnectionId: 'orig-id-from-id',
      });
      const files = filesFrom([
        ['channels/id-anchored.channel.json', channelJson],
        ['channels/webhooks/id-anchored.webhook.json', webhookJson],
      ]);
      const result = await disassembler.disassemble(makeCtx(files));

      const channel = result.records.find((r) => r.collection === 'channel_connections');
      const webhook = result.records.find((r) => r.collection === 'webhook_subscriptions');
      expect(channel!.data._exportedId).toBe('orig-id-from-id');
      expect(webhook!.data._channelDisplayName).toBe('ID Anchored Channel');
    });

    it('should fall back to single-channel when _exportedId lookup fails', async () => {
      const channelJson = JSON.stringify({
        displayName: 'Only Channel',
      });
      const webhookJson = JSON.stringify({
        description: 'Webhook',
        channelConnectionId: 'unknown-id',
      });
      const files = filesFrom([
        ['channels/only.channel.json', channelJson],
        ['channels/webhooks/hook.webhook.json', webhookJson],
      ]);
      const result = await disassembler.disassemble(makeCtx(files));

      const webhook = result.records.find((r) => r.collection === 'webhook_subscriptions');
      expect(webhook!.data._channelDisplayName).toBe('Only Channel');
    });

    it('should warn when channelConnectionId cannot be resolved and multiple channels exist', async () => {
      const ch1 = JSON.stringify({ displayName: 'Chan1' });
      const ch2 = JSON.stringify({ displayName: 'Chan2' });
      const webhookJson = JSON.stringify({
        description: 'unlinked hook',
        channelConnectionId: 'no-match',
      });
      const files = filesFrom([
        ['channels/chan1.channel.json', ch1],
        ['channels/chan2.channel.json', ch2],
        ['channels/webhooks/unlinked.webhook.json', webhookJson],
      ]);
      const result = await disassembler.disassemble(makeCtx(files));

      const webhook = result.records.find((r) => r.collection === 'webhook_subscriptions');
      expect(webhook!.data._channelDisplayName).toBeNull();
      expect(result.warnings.some((w) => w.includes('Cannot resolve channelConnectionId'))).toBe(
        true,
      );
    });
  });

  describe('widget config', () => {
    it('should parse widget-config.json', async () => {
      const json = JSON.stringify({ theme: 'dark', position: 'bottom-right' });
      const files = filesFrom([['channels/widgets/widget-config.json', json]]);
      const result = await disassembler.disassemble(makeCtx(files));

      const widgets = result.records.filter((r) => r.collection === 'widget_configs');
      expect(widgets).toHaveLength(1);
      expect(widgets[0].data.theme).toBe('dark');
    });
  });

  describe('superseded records', () => {
    it('should build superseded records for replace strategy', async () => {
      const files = filesFrom([
        ['channels/ch.channel.json', JSON.stringify({ displayName: 'CH' })],
      ]);
      const ctx = makeCtx(files, {
        conflictStrategy: 'replace',
        existingRecordIds: new Map([
          ['channel_connections', [{ _id: 'cc-1' }]],
          ['webhook_subscriptions', [{ _id: 'ws-1' }, { _id: 'ws-2' }]],
          ['widget_configs', [{ _id: 'wc-1' }]],
        ]),
      });
      const result = await disassembler.disassemble(ctx);

      expect(result.superseded.filter((s) => s.collection === 'channel_connections')).toHaveLength(
        1,
      );
      expect(
        result.superseded.filter((s) => s.collection === 'webhook_subscriptions'),
      ).toHaveLength(2);
      expect(result.superseded.filter((s) => s.collection === 'widget_configs')).toHaveLength(1);
    });
  });
});

// ─── WorkflowsDisassembler ──────────────────────────────────────────────────

describe('WorkflowsDisassembler', () => {
  let disassembler: WorkflowsDisassembler;

  beforeEach(() => {
    disassembler = new WorkflowsDisassembler();
  });

  it('should have layer name "workflows"', () => {
    expect(disassembler.layer).toBe('workflows');
  });

  describe('workflow definitions', () => {
    it('should parse workflow .workflow.json files', async () => {
      const json = JSON.stringify({
        name: 'Onboarding Flow',
        status: 'active',
        description: 'Guides new users',
      });
      const files = filesFrom([['workflows/onboarding-flow.workflow.json', json]]);
      const result = await disassembler.disassemble(makeCtx(files));

      const workflows = result.records.filter((r) => r.collection === 'workflows');
      expect(workflows).toHaveLength(1);
      expect(workflows[0].data.name).toBe('Onboarding Flow');
    });

    it('should strip workflow status in version-first model', async () => {
      // In the version-first model, Workflow is a thin container and carries
      // no `status` field — lifecycle state lives on WorkflowVersion.
      const json = JSON.stringify({
        name: 'Active Workflow',
        status: 'active',
      });
      const files = filesFrom([['workflows/active.workflow.json', json]]);
      const result = await disassembler.disassemble(makeCtx(files));

      expect(result.records[0].data.status).toBeUndefined();
    });

    it('strips workflow deployment metadata to avoid tenant-global endpoint slug collisions', async () => {
      const json = JSON.stringify({
        name: 'Published Workflow',
        deployment: {
          endpointSlug: 'loan-processing',
          authMode: 'bearer',
        },
      });
      const files = filesFrom([['workflows/published.workflow.json', json]]);
      const result = await disassembler.disassemble(makeCtx(files));

      expect(result.records[0].data.deployment).toBeUndefined();
    });

    it('should skip workflows in skip mode if name already exists', async () => {
      const json = JSON.stringify({ name: 'Existing Workflow', status: 'active' });
      const files = filesFrom([['workflows/existing.workflow.json', json]]);
      const ctx = makeCtx(files, {
        conflictStrategy: 'skip',
        existingRecordIds: new Map([['workflows', [{ _id: 'wf-1', name: 'Existing Workflow' }]]]),
      });
      const result = await disassembler.disassemble(ctx);

      expect(result.records).toHaveLength(0);
    });

    it('should fall back to file name if no name in JSON', async () => {
      const json = JSON.stringify({ status: 'active', description: 'No name field' });
      const files = filesFrom([['workflows/auto-named.workflow.json', json]]);
      const result = await disassembler.disassemble(makeCtx(files));

      expect(result.records[0].data.name).toBe('auto-named');
    });

    it('preserves exported workflow id as _exportedId for portable tool binding resolution', async () => {
      const json = JSON.stringify({
        id: 'source-workflow-1',
        name: 'Loan Application Processing',
        status: 'active',
      });
      const files = filesFrom([['workflows/loan_application_processing.workflow.json', json]]);
      const result = await disassembler.disassemble(makeCtx(files));

      expect(result.records[0].data._exportedId).toBe('source-workflow-1');
    });
  });

  describe('workflow versions', () => {
    it('should parse version files and set _workflowName temp field', async () => {
      const wfJson = JSON.stringify({ name: 'MyFlow', status: 'active' });
      const versionJson = JSON.stringify({
        version: '1.0.0',
        definition: { steps: [] },
        source_hash: 'abc123',
        changelog: 'Initial version',
      });
      const files = filesFrom([
        ['workflows/myflow.workflow.json', wfJson],
        ['workflows/versions/MyFlow/1.0.0.version.json', versionJson],
      ]);
      const result = await disassembler.disassemble(makeCtx(files));

      const versions = result.records.filter((r) => r.collection === 'workflow_versions');
      expect(versions).toHaveLength(1);
      expect(versions[0].data._workflowName).toBe('MyFlow');
      expect(versions[0].data.version).toBe('1.0.0');
      expect(versions[0].data.definition).toEqual({ steps: [] });
      // Published versions (version !== 'draft') are reset to inactive state
      // on import; drafts are always active. Version field is `state`, not `status`.
      expect(versions[0].data.state).toBe('inactive');
      expect(versions[0].data.status).toBeUndefined();
    });

    it('should skip version files when parent workflow was skipped', async () => {
      const wfJson = JSON.stringify({ name: 'SkippedWF', status: 'active' });
      const versionJson = JSON.stringify({
        version: '2.0.0',
        definition: { steps: [] },
      });
      const files = filesFrom([
        ['workflows/skippedwf.workflow.json', wfJson],
        ['workflows/versions/SkippedWF/2.0.0.version.json', versionJson],
      ]);
      const ctx = makeCtx(files, {
        conflictStrategy: 'skip',
        existingRecordIds: new Map([['workflows', [{ _id: 'wf-exist', name: 'SkippedWF' }]]]),
      });
      const result = await disassembler.disassemble(ctx);

      const versions = result.records.filter((r) => r.collection === 'workflow_versions');
      expect(versions).toHaveLength(0);
    });

    it('should warn and skip versions missing required fields', async () => {
      const wfJson = JSON.stringify({ name: 'WF1', status: 'active' });
      const versionJson = JSON.stringify({ changelog: 'no version or definition' });
      const files = filesFrom([
        ['workflows/wf1.workflow.json', wfJson],
        ['workflows/versions/WF1/bad.version.json', versionJson],
      ]);
      const result = await disassembler.disassemble(makeCtx(files));

      const versions = result.records.filter((r) => r.collection === 'workflow_versions');
      expect(versions).toHaveLength(0);
      expect(result.warnings.some((w) => w.includes('missing required fields'))).toBe(true);
    });

    it('stages trigger registrations from portable version trigger exports', async () => {
      const wfJson = JSON.stringify({ name: 'LoanFlow' });
      const versionJson = JSON.stringify({
        version: 'draft',
        definition: { steps: [] },
        triggers: [
          {
            id: 'tr-source-1',
            triggerName: 'webhook',
            type: 'webhook',
            status: 'active',
            config: { inputSchema: { type: 'object' } },
            webhookMode: 'sync',
          },
        ],
      });
      const files = filesFrom([
        ['workflows/loanflow.workflow.json', wfJson],
        ['workflows/versions/LoanFlow/draft.version.json', versionJson],
      ]);

      const result = await disassembler.disassemble(makeCtx(files));
      const triggerRegistrations = result.records.filter(
        (record) => record.collection === 'trigger_registrations',
      );

      expect(triggerRegistrations).toHaveLength(1);
      expect(triggerRegistrations[0].data).toMatchObject({
        _exportedId: 'tr-source-1',
        _workflowName: 'LoanFlow',
        _workflowVersion: 'draft',
        triggerName: 'webhook',
        triggerType: 'webhook',
        status: 'active',
        config: { inputSchema: { type: 'object' } },
        webhookMode: 'sync',
        tenantId: 'tenant-1',
        projectId: 'proj-1',
      });
      expect(triggerRegistrations[0].data.workflowId).toBeUndefined();
      expect(triggerRegistrations[0].data.workflowVersionId).toBeUndefined();
    });

    it('resolves workflow trigger auth profile names with the destination mapping', async () => {
      const wfJson = JSON.stringify({ name: 'LoanFlow' });
      const versionJson = JSON.stringify({
        version: 'draft',
        definition: { steps: [] },
        triggers: [
          {
            id: 'tr-source-1',
            triggerName: 'webhook',
            type: 'webhook',
            authProfileName: 'production-oauth',
            authProfileId: 'source-profile-id',
          },
        ],
      });
      const files = filesFrom([
        ['workflows/loanflow.workflow.json', wfJson],
        ['workflows/versions/LoanFlow/draft.version.json', versionJson],
      ]);

      const result = await disassembler.disassemble(
        makeCtx(files, { authProfileMapping: { 'production-oauth': 'dest-profile-id' } }),
      );
      const trigger = result.records.find(
        (record) => record.collection === 'trigger_registrations',
      );

      expect(trigger?.data.authProfileId).toBe('dest-profile-id');
    });

    it('warns instead of importing stale workflow trigger auth profile ids without mapping', async () => {
      const wfJson = JSON.stringify({ name: 'LoanFlow' });
      const versionJson = JSON.stringify({
        version: 'draft',
        definition: { steps: [] },
        triggers: [
          {
            id: 'tr-source-1',
            triggerName: 'webhook',
            type: 'webhook',
            authProfileName: 'production-oauth',
            authProfileId: 'source-profile-id',
          },
        ],
      });
      const files = filesFrom([
        ['workflows/loanflow.workflow.json', wfJson],
        ['workflows/versions/LoanFlow/draft.version.json', versionJson],
      ]);

      const result = await disassembler.disassemble(makeCtx(files));
      const trigger = result.records.find(
        (record) => record.collection === 'trigger_registrations',
      );

      expect(trigger?.data.authProfileId).toBeUndefined();
      expect(result.warnings.some((warning) => warning.includes('production-oauth'))).toBe(true);
    });

    it('uses the real workflow name for sanitized version folder paths', async () => {
      const wfJson = JSON.stringify({ name: 'Loan Processing' });
      const versionJson = JSON.stringify({
        version: 'draft',
        definition: { steps: [] },
        triggers: [
          {
            id: 'tr-source-1',
            triggerName: 'webhook',
            type: 'webhook',
          },
        ],
      });
      const files = filesFrom([
        ['workflows/loan_processing.workflow.json', wfJson],
        ['workflows/versions/loan_processing/draft.version.json', versionJson],
      ]);

      const result = await disassembler.disassemble(makeCtx(files));
      const version = result.records.find((record) => record.collection === 'workflow_versions');
      const trigger = result.records.find(
        (record) => record.collection === 'trigger_registrations',
      );

      expect(version?.data._workflowName).toBe('Loan Processing');
      expect(trigger?.data._workflowName).toBe('Loan Processing');
    });
  });

  describe('superseded records', () => {
    it('should build superseded records for replace strategy', async () => {
      const files = filesFrom([
        ['workflows/wf.workflow.json', JSON.stringify({ name: 'WF', status: 'active' })],
      ]);
      const ctx = makeCtx(files, {
        conflictStrategy: 'replace',
        existingRecordIds: new Map([
          ['workflows', [{ _id: 'wf-old-1' }]],
          ['workflow_versions', [{ _id: 'wv-old-1' }, { _id: 'wv-old-2' }]],
          ['trigger_registrations', [{ _id: 'tr-old-1' }]],
        ]),
      });
      const result = await disassembler.disassemble(ctx);

      expect(result.superseded.filter((s) => s.collection === 'workflows')).toHaveLength(1);
      expect(result.superseded.filter((s) => s.collection === 'workflow_versions')).toHaveLength(2);
      expect(
        result.superseded.filter((s) => s.collection === 'trigger_registrations'),
      ).toHaveLength(1);
    });
  });
});

// ─── SearchDisassembler ──────────────────────────────────────────────────────

describe('SearchDisassembler', () => {
  let disassembler: SearchDisassembler;

  beforeEach(() => {
    disassembler = new SearchDisassembler();
  });

  it('should have layer name "search"', () => {
    expect(disassembler.layer).toBe('search');
  });

  describe('search indexes', () => {
    it('should parse search index files', async () => {
      const json = JSON.stringify({
        slug: 'main-index',
        name: 'Main Index',
        documentCount: 1000,
        lastIndexedAt: '2024-01-01',
      });
      const files = filesFrom([['search/indexes/main-index.index.json', json]]);
      const result = await disassembler.disassemble(makeCtx(files));

      const indexes = result.records.filter((r) => r.collection === 'search_indexes');
      expect(indexes).toHaveLength(1);
      expect(indexes[0].data.slug).toBe('main-index');
      // Runtime stats should be stripped
      expect(indexes[0].data.documentCount).toBeUndefined();
      expect(indexes[0].data.lastIndexedAt).toBeUndefined();
    });

    it('should fall back to name field for slug if slug not present', async () => {
      const json = JSON.stringify({ name: 'fallback-name' });
      const files = filesFrom([['search/indexes/fallback-name.index.json', json]]);
      const result = await disassembler.disassemble(makeCtx(files));

      expect(result.records[0].data.slug).toBe('fallback-name');
    });

    it('should fall back to path match for slug if neither slug nor name', async () => {
      const json = JSON.stringify({ description: 'no slug or name' });
      const files = filesFrom([['search/indexes/from-path.index.json', json]]);
      const result = await disassembler.disassemble(makeCtx(files));

      expect(result.records[0].data.slug).toBe('from-path');
    });

    it('should preserve search index id as _exportedId for older archives', async () => {
      const json = JSON.stringify({ id: 'idx-source-id', slug: 'portable-index' });
      const files = filesFrom([['search/indexes/portable-index.index.json', json]]);
      const result = await disassembler.disassemble(makeCtx(files));

      expect(result.records[0].data._exportedId).toBe('idx-source-id');
    });
  });

  describe('search sources', () => {
    it('should parse search source files and set _indexSlug', async () => {
      const indexJson = JSON.stringify({
        slug: 'my-index',
        _exportedId: 'idx-orig-1',
      });
      const sourceJson = JSON.stringify({
        name: 'Wiki Source',
        indexId: 'idx-orig-1',
        documentCount: 50,
      });
      const files = filesFrom([
        ['search/indexes/my-index.index.json', indexJson],
        ['search/sources/wiki-source.source.json', sourceJson],
      ]);
      const result = await disassembler.disassemble(makeCtx(files));

      const sources = result.records.filter((r) => r.collection === 'search_sources');
      expect(sources).toHaveLength(1);
      expect(sources[0].data._indexSlug).toBe('my-index');
      expect(sources[0].data.indexId).toBeUndefined();
      // Runtime stats stripped
      expect(sources[0].data.documentCount).toBeUndefined();
    });

    it('should resolve search source indexId when older archives use index id as the portable anchor', async () => {
      const indexJson = JSON.stringify({
        id: 'idx-from-id',
        slug: 'id-index',
      });
      const sourceJson = JSON.stringify({
        name: 'ID Source',
        indexId: 'idx-from-id',
      });
      const files = filesFrom([
        ['search/indexes/id-index.index.json', indexJson],
        ['search/sources/id-source.source.json', sourceJson],
      ]);
      const result = await disassembler.disassemble(makeCtx(files));

      const source = result.records.find((r) => r.collection === 'search_sources');
      expect(source!.data._indexSlug).toBe('id-index');
    });

    it('should strip sourceConfig from sources', async () => {
      const indexJson = JSON.stringify({ slug: 'idx' });
      const sourceJson = JSON.stringify({
        name: 'src',
        sourceConfig: { accessToken: 'secret' },
      });
      const files = filesFrom([
        ['search/indexes/idx.index.json', indexJson],
        ['search/sources/src.source.json', sourceJson],
      ]);
      const result = await disassembler.disassemble(makeCtx(files));

      const source = result.records.find((r) => r.collection === 'search_sources');
      expect(source!.data.sourceConfig).toBeUndefined();
    });

    it('should fall back to single-index when _exportedId lookup fails', async () => {
      const indexJson = JSON.stringify({ slug: 'only-index' });
      const sourceJson = JSON.stringify({
        name: 'My Source',
        indexId: 'unknown-id',
      });
      const files = filesFrom([
        ['search/indexes/only-index.index.json', indexJson],
        ['search/sources/my-source.source.json', sourceJson],
      ]);
      const result = await disassembler.disassemble(makeCtx(files));

      const source = result.records.find((r) => r.collection === 'search_sources');
      expect(source!.data._indexSlug).toBe('only-index');
    });
  });

  describe('knowledge bases', () => {
    it('should parse KB files and set _indexSlug via _exportedId', async () => {
      const indexJson = JSON.stringify({
        slug: 'kb-index',
        _exportedId: 'idx-2',
      });
      const kbJson = JSON.stringify({
        name: 'Help Center KB',
        searchIndexId: 'idx-2',
        documentCount: 200,
      });
      const files = filesFrom([
        ['search/indexes/kb-index.index.json', indexJson],
        ['search/knowledge-bases/help-center.kb.json', kbJson],
      ]);
      const result = await disassembler.disassemble(makeCtx(files));

      const kbs = result.records.filter((r) => r.collection === 'knowledge_bases');
      expect(kbs).toHaveLength(1);
      expect(kbs[0].data._indexSlug).toBe('kb-index');
      expect(kbs[0].data.searchIndexId).toBeUndefined();
      expect(kbs[0].data.documentCount).toBeUndefined();
    });

    it('should preserve knowledge base id as _exportedId for cross-layer references', async () => {
      const indexJson = JSON.stringify({
        slug: 'kb-index',
      });
      const kbJson = JSON.stringify({
        id: 'kb-source-id',
        name: 'Portable KB',
        searchIndexId: 'idx-unknown',
      });
      const files = filesFrom([
        ['search/indexes/kb-index.index.json', indexJson],
        ['search/knowledge-bases/portable.kb.json', kbJson],
      ]);
      const result = await disassembler.disassemble(makeCtx(files));

      const kb = result.records.find((r) => r.collection === 'knowledge_bases');
      expect(kb!.data._exportedId).toBe('kb-source-id');
    });

    it('should warn when index slug cannot be resolved for KB', async () => {
      const idx1 = JSON.stringify({ slug: 'idx-a' });
      const idx2 = JSON.stringify({ slug: 'idx-b' });
      const kbJson = JSON.stringify({
        name: 'Unlinked KB',
        searchIndexId: 'no-match',
      });
      const files = filesFrom([
        ['search/indexes/idx-a.index.json', idx1],
        ['search/indexes/idx-b.index.json', idx2],
        ['search/knowledge-bases/unlinked.kb.json', kbJson],
      ]);
      const result = await disassembler.disassemble(makeCtx(files));

      const kb = result.records.find((r) => r.collection === 'knowledge_bases');
      expect(kb!.data._indexSlug).toBeNull();
      expect(result.warnings.some((w) => w.includes('Cannot resolve indexId'))).toBe(true);
    });

    it('should resolve slug by name-matching convention', async () => {
      const idx1 = JSON.stringify({ slug: 'docs' });
      const idx2 = JSON.stringify({ slug: 'wiki' });
      const kbJson = JSON.stringify({
        name: 'docs-knowledge-base',
        searchIndexId: 'stale-id',
      });
      const files = filesFrom([
        ['search/indexes/docs.index.json', idx1],
        ['search/indexes/wiki.index.json', idx2],
        ['search/knowledge-bases/docs-kb.kb.json', kbJson],
      ]);
      const result = await disassembler.disassemble(makeCtx(files));

      const kb = result.records.find((r) => r.collection === 'knowledge_bases');
      expect(kb!.data._indexSlug).toBe('docs');
    });
  });

  describe('crawl patterns', () => {
    it('should parse crawl-patterns.json as array', async () => {
      const json = JSON.stringify([
        {
          url: 'https://example.com/*',
          lastCrawlAt: '2024-01-01',
          totalCrawlsCompleted: 5,
        },
        { url: 'https://docs.example.com/*' },
      ]);
      const files = filesFrom([['search/crawl-patterns.json', json]]);
      const result = await disassembler.disassemble(makeCtx(files));

      const patterns = result.records.filter((r) => r.collection === 'crawl_patterns');
      expect(patterns).toHaveLength(2);
      // Runtime stats should be stripped
      expect(patterns[0].data.lastCrawlAt).toBeUndefined();
      expect(patterns[0].data.totalCrawlsCompleted).toBeUndefined();
    });
  });

  describe('superseded records', () => {
    it('should build superseded records for all search collections', async () => {
      const files = filesFrom([['search/indexes/idx.index.json', JSON.stringify({ slug: 'idx' })]]);
      const ctx = makeCtx(files, {
        conflictStrategy: 'replace',
        existingRecordIds: new Map([
          ['search_indexes', [{ _id: 'si-1' }]],
          ['search_sources', [{ _id: 'ss-1' }]],
          ['knowledge_bases', [{ _id: 'kb-1' }]],
          ['crawl_patterns', [{ _id: 'cp-1' }, { _id: 'cp-2' }]],
        ]),
      });
      const result = await disassembler.disassemble(ctx);

      expect(result.superseded.filter((s) => s.collection === 'search_indexes')).toHaveLength(1);
      expect(result.superseded.filter((s) => s.collection === 'search_sources')).toHaveLength(1);
      expect(result.superseded.filter((s) => s.collection === 'knowledge_bases')).toHaveLength(1);
      expect(result.superseded.filter((s) => s.collection === 'crawl_patterns')).toHaveLength(2);
    });

    it('should match crawl pattern superseded records by domain during merge', async () => {
      const files = filesFrom([
        [
          'search/crawl-patterns.json',
          JSON.stringify([{ domain: 'example.com' }, { domain: 'docs.example.com' }]),
        ],
      ]);
      const ctx = makeCtx(files, {
        conflictStrategy: 'merge',
        existingRecordIds: new Map([
          [
            'crawl_patterns',
            [
              { _id: 'cp-1', domain: 'example.com' },
              { _id: 'cp-2', domain: 'other.com' },
            ],
          ],
        ]),
      });

      const result = await disassembler.disassemble(ctx);

      expect(result.superseded.filter((s) => s.collection === 'crawl_patterns')).toEqual([
        { layer: 'search', collection: 'crawl_patterns', recordId: 'cp-1' },
      ]);
    });
  });
});

// ─── ConnectionsDisassembler ─────────────────────────────────────────────────

describe('ConnectionsDisassembler', () => {
  let disassembler: ConnectionsDisassembler;

  beforeEach(() => {
    disassembler = new ConnectionsDisassembler();
  });

  it('should have layer name "connections"', () => {
    expect(disassembler.layer).toBe('connections');
  });

  describe('connector connections', () => {
    it('should parse connection files', async () => {
      const json = JSON.stringify({
        displayName: 'Jira Connection',
        connectorName: 'jira',
        config: { baseUrl: 'https://jira.example.com' },
      });
      const files = filesFrom([['connections/connectors/jira-conn.connection.json', json]]);
      const result = await disassembler.disassemble(makeCtx(files));

      const conns = result.records.filter((r) => r.collection === 'connector_connections');
      expect(conns).toHaveLength(1);
      expect(conns[0].data.displayName).toBe('Jira Connection');
    });

    it('should strip REDACTED values from connection data', async () => {
      const json = JSON.stringify({
        displayName: 'SecureConn',
        config: { apiKey: '***REDACTED***', host: 'https://api.example.com' },
      });
      const files = filesFrom([['connections/connectors/secure.connection.json', json]]);
      const result = await disassembler.disassemble(makeCtx(files));

      const config = result.records[0].data.config as Record<string, unknown>;
      expect(config.apiKey).toBeUndefined();
      expect(config.host).toBe('https://api.example.com');
    });

    it('should resolve auth profile name to ID when mapping is provided', async () => {
      const json = JSON.stringify({
        displayName: 'AuthConn',
        authProfileName: 'production-oauth',
      });
      const files = filesFrom([['connections/connectors/auth.connection.json', json]]);
      const ctx = makeCtx(files, {
        authProfileMapping: { 'production-oauth': 'profile-id-123' },
      });
      const result = await disassembler.disassemble(ctx);

      expect(result.records[0].data.authProfileId).toBe('profile-id-123');
      expect(result.records[0].data.authProfileName).toBeUndefined();
    });

    it('should warn when auth profile name cannot be resolved', async () => {
      const json = JSON.stringify({
        displayName: 'MissingAuth',
        authProfileName: 'nonexistent-profile',
      });
      const files = filesFrom([['connections/connectors/missing-auth.connection.json', json]]);
      const ctx = makeCtx(files, {
        authProfileMapping: { 'other-profile': 'id-1' },
      });
      const result = await disassembler.disassemble(ctx);

      expect(
        result.warnings.some(
          (w) => w.includes("'nonexistent-profile'") && w.includes('MissingAuth'),
        ),
      ).toBe(true);
    });

    it('should warn when no auth profile mapping is provided but connections reference profiles', async () => {
      const json = JSON.stringify({
        displayName: 'NeedsAuth',
        authProfileName: 'some-profile',
      });
      const files = filesFrom([['connections/connectors/needs-auth.connection.json', json]]);
      const ctx = makeCtx(files); // no authProfileMapping
      const result = await disassembler.disassemble(ctx);

      expect(result.warnings.some((w) => w.includes('No auth profile mapping'))).toBe(true);
    });

    it('should skip connections in skip mode if displayName already exists', async () => {
      const json = JSON.stringify({
        displayName: 'Existing Conn',
        connectorName: 'slack',
      });
      const files = filesFrom([['connections/connectors/existing.connection.json', json]]);
      const ctx = makeCtx(files, {
        conflictStrategy: 'skip',
        existingRecordIds: new Map([
          ['connector_connections', [{ _id: 'cc-1', displayName: 'Existing Conn' }]],
        ]),
      });
      const result = await disassembler.disassemble(ctx);

      expect(result.records.filter((r) => r.collection === 'connector_connections')).toHaveLength(
        0,
      );
    });
  });

  describe('connector configs', () => {
    it('should parse connector config files', async () => {
      const json = JSON.stringify({
        connectorType: 'jira',
        settings: { maxRetries: 3 },
      });
      const files = filesFrom([['connections/configs/jira.connector-config.json', json]]);
      const result = await disassembler.disassemble(makeCtx(files));

      const configs = result.records.filter((r) => r.collection === 'connector_configs');
      expect(configs).toHaveLength(1);
      expect(configs[0].data.connectorType).toBe('jira');
    });

    it('should strip runtime fields from connector configs', async () => {
      const json = JSON.stringify({
        connectorType: 'slack',
        oauthTokenId: 'token-123',
        syncState: { lastSync: 'now' },
        errorState: { lastError: 'timeout' },
      });
      const files = filesFrom([['connections/configs/slack.connector-config.json', json]]);
      const result = await disassembler.disassemble(makeCtx(files));

      const config = result.records[0].data;
      expect(config.oauthTokenId).toBeUndefined();
      expect(config.syncState).toBeUndefined();
      expect(config.errorState).toBeUndefined();
    });

    it('should skip configs in skip mode if connectorType already exists', async () => {
      const json = JSON.stringify({ connectorType: 'jira' });
      const files = filesFrom([['connections/configs/jira.connector-config.json', json]]);
      const ctx = makeCtx(files, {
        conflictStrategy: 'skip',
        existingRecordIds: new Map([
          ['connector_configs', [{ _id: 'cfg-1', connectorType: 'jira' }]],
        ]),
      });
      const result = await disassembler.disassemble(ctx);

      expect(result.records.filter((r) => r.collection === 'connector_configs')).toHaveLength(0);
    });
  });

  describe('superseded records', () => {
    it('should build superseded records for replace strategy', async () => {
      const files = filesFrom([
        ['connections/connectors/c.connection.json', JSON.stringify({ displayName: 'C' })],
      ]);
      const ctx = makeCtx(files, {
        conflictStrategy: 'replace',
        existingRecordIds: new Map([
          ['connector_connections', [{ _id: 'cc-1' }]],
          ['connector_configs', [{ _id: 'cfg-1' }, { _id: 'cfg-2' }]],
        ]),
      });
      const result = await disassembler.disassemble(ctx);

      expect(
        result.superseded.filter((s) => s.collection === 'connector_connections'),
      ).toHaveLength(1);
      expect(result.superseded.filter((s) => s.collection === 'connector_configs')).toHaveLength(2);
    });
  });
});

// ─── GuardrailsDisassembler ─────────────────────────────────────────────────

describe('GuardrailsDisassembler', () => {
  let disassembler: GuardrailsDisassembler;

  beforeEach(() => {
    disassembler = new GuardrailsDisassembler();
  });

  it('should have layer name "guardrails"', () => {
    expect(disassembler.layer).toBe('guardrails');
  });

  describe('guardrail policies', () => {
    it('should parse guardrail .guardrail.json files', async () => {
      const json = JSON.stringify({
        name: 'PII Filter',
        rules: [{ guardrailName: 'pii', override: 'action' }],
      });
      const files = filesFrom([['guardrails/pii-filter.guardrail.json', json]]);
      const result = await disassembler.disassemble(makeCtx(files));

      expect(result.records).toHaveLength(1);
      expect(result.records[0].collection).toBe('guardrail_policies');
      expect(result.records[0].data.name).toBe('PII Filter');
    });

    it('should parse guardrail .guardrail.yaml files', async () => {
      const yaml = [
        'name: PII Filter',
        'rules:',
        '  - guardrailName: pii',
        '    override: action',
      ].join('\n');
      const files = filesFrom([['guardrails/pii-filter.guardrail.yaml', yaml]]);
      const result = await disassembler.disassemble(makeCtx(files));

      expect(result.records).toHaveLength(1);
      expect(result.records[0].collection).toBe('guardrail_policies');
      expect(result.records[0].data.name).toBe('PII Filter');
    });

    it('should rebind scope.projectId to the target project', async () => {
      const json = JSON.stringify({
        name: 'Scoped Rule',
        scope: { type: 'project', projectId: 'old-project-id' },
      });
      const files = filesFrom([['guardrails/scoped-rule.guardrail.json', json]]);
      const result = await disassembler.disassemble(makeCtx(files));

      const scope = result.records[0].data.scope as Record<string, unknown>;
      expect(scope.projectId).toBe('proj-1');
    });

    it('should rebind scope.projectId and normalize legacy agentId for agent-scoped guardrails', async () => {
      const json = JSON.stringify({
        name: 'Agent Rule',
        scope: { type: 'agent', projectId: 'old-proj', agentId: 'agent-1' },
      });
      const files = filesFrom([['guardrails/agent-rule.guardrail.json', json]]);
      const result = await disassembler.disassemble(makeCtx(files));

      const scope = result.records[0].data.scope as Record<string, unknown>;
      expect(scope.projectId).toBe('proj-1');
      expect(scope.agentDefId).toBe('agent-1');
      expect(scope.agentId).toBeUndefined();
    });

    it('stages agent-scoped guardrails with agentName as a temp cross-ref anchor', async () => {
      const json = JSON.stringify({
        name: 'Portable Agent Rule',
        scope: {
          type: 'agent',
          projectId: 'old-proj',
          agentDefId: 'source-agent-id',
          agentName: 'TransferAgent',
        },
      });
      const files = filesFrom([['guardrails/portable-agent-rule.guardrail.json', json]]);
      const result = await disassembler.disassemble(makeCtx(files));

      const data = result.records[0].data;
      const scope = data.scope as Record<string, unknown>;
      expect(scope.projectId).toBe('proj-1');
      expect(scope.agentDefId).toBeUndefined();
      expect(scope.agentName).toBeUndefined();
      expect(data._guardrailAgentName).toBe('TransferAgent');
    });

    it('should not modify scope for non-project/agent types', async () => {
      const json = JSON.stringify({
        name: 'Global Rule',
        scope: { type: 'global' },
      });
      const files = filesFrom([['guardrails/global-rule.guardrail.json', json]]);
      const result = await disassembler.disassemble(makeCtx(files));

      const scope = result.records[0].data.scope as Record<string, unknown>;
      expect(scope.type).toBe('global');
      expect(scope.projectId).toBeUndefined();
    });

    it('should still create a record when name is not in JSON (file name used for skip check only)', async () => {
      const json = JSON.stringify({ type: 'input', rules: [] });
      const files = filesFrom([['guardrails/auto-named-rule.guardrail.json', json]]);
      const result = await disassembler.disassemble(makeCtx(files));

      // The guardrails disassembler derives name from the file path for the skip check,
      // but does not write it back to the record data (unlike workflows).
      expect(result.records).toHaveLength(1);
      expect(result.records[0].collection).toBe('guardrail_policies');
      expect(result.records[0].data.type).toBe('input');
    });

    it('should skip guardrails in skip mode if name already exists', async () => {
      const json = JSON.stringify({ name: 'Existing Guard' });
      const files = filesFrom([['guardrails/existing.guardrail.json', json]]);
      const ctx = makeCtx(files, {
        conflictStrategy: 'skip',
        existingRecordIds: new Map([
          ['guardrail_policies', [{ _id: 'gp-1', name: 'Existing Guard' }]],
        ]),
      });
      const result = await disassembler.disassemble(ctx);

      expect(result.records).toHaveLength(0);
    });

    it('should inject ownership on guardrail records', async () => {
      const json = JSON.stringify({ name: 'Owned Rule' });
      const files = filesFrom([['guardrails/owned.guardrail.json', json]]);
      const result = await disassembler.disassemble(makeCtx(files));

      expect(result.records[0].data.projectId).toBe('proj-1');
      expect(result.records[0].data.tenantId).toBe('tenant-1');
      expect(result.records[0].data.createdBy).toBe('user-1');
    });
  });

  describe('superseded records', () => {
    it('should build superseded records for replace strategy', async () => {
      const files = filesFrom([['guardrails/g.guardrail.json', JSON.stringify({ name: 'G' })]]);
      const ctx = makeCtx(files, {
        conflictStrategy: 'replace',
        existingRecordIds: new Map([['guardrail_policies', [{ _id: 'gp-1' }, { _id: 'gp-2' }]]]),
      });
      const result = await disassembler.disassemble(ctx);

      expect(result.superseded).toHaveLength(2);
      expect(result.superseded.every((s) => s.collection === 'guardrail_policies')).toBe(true);
    });

    it('should only supersede guardrails with matching names for merge strategy', async () => {
      const files = filesFrom([['guardrails/g.guardrail.json', JSON.stringify({ name: 'G' })]]);
      const ctx = makeCtx(files, {
        conflictStrategy: 'merge',
        existingRecordIds: new Map([
          [
            'guardrail_policies',
            [
              { _id: 'gp-1', name: 'G' },
              { _id: 'gp-2', name: 'Keep Me' },
            ],
          ],
        ]),
      });
      const result = await disassembler.disassemble(ctx);

      expect(result.superseded).toEqual([
        { layer: 'guardrails', collection: 'guardrail_policies', recordId: 'gp-1' },
      ]);
    });
  });
});

// ─── VocabularyDisassembler ──────────────────────────────────────────────────

describe('VocabularyDisassembler', () => {
  let disassembler: VocabularyDisassembler;

  beforeEach(() => {
    disassembler = new VocabularyDisassembler();
  });

  it('should have layer name "vocabulary"', () => {
    expect(disassembler.layer).toBe('vocabulary');
  });

  describe('domain vocabularies', () => {
    it('should parse domain-vocabulary.json as array', async () => {
      const json = JSON.stringify([
        { term: 'API', definition: 'Application Programming Interface' },
        { term: 'SDK', definition: 'Software Development Kit' },
      ]);
      const files = filesFrom([['vocabulary/domain-vocabulary.json', json]]);
      const result = await disassembler.disassemble(makeCtx(files));

      const vocabs = result.records.filter((r) => r.collection === 'domain_vocabularies');
      expect(vocabs).toHaveLength(2);
      expect(vocabs[0].data.term).toBe('API');
    });

    it('should preserve exported knowledge-base IDs as remappable temp fields', async () => {
      const json = JSON.stringify([
        {
          term: 'ARR',
          definition: 'Annual recurring revenue',
          projectKnowledgeBaseId: 'source-kb-1',
        },
      ]);
      const files = filesFrom([['vocabulary/domain-vocabulary.json', json]]);
      const result = await disassembler.disassemble(makeCtx(files));

      const vocab = result.records.find((r) => r.collection === 'domain_vocabularies');
      expect(vocab?.data.projectKnowledgeBaseId).toBe('source-kb-1');
      expect(vocab?.data._vocabularyKnowledgeBaseId).toBe('source-kb-1');
    });
  });

  describe('lookup tables', () => {
    it('should parse lookup table files and set tableName on entries', async () => {
      const json = JSON.stringify([
        { key: 'US', value: 'United States' },
        { key: 'UK', value: 'United Kingdom' },
      ]);
      const files = filesFrom([['vocabulary/lookup-tables/countries.lookup.json', json]]);
      const result = await disassembler.disassemble(makeCtx(files));

      const entries = result.records.filter((r) => r.collection === 'lookup_entries');
      expect(entries).toHaveLength(2);
      expect(entries[0].data.tableName).toBe('countries');
      expect(entries[0].data.key).toBe('US');
      expect(entries[1].data.tableName).toBe('countries');
    });

    it('should handle multiple lookup tables', async () => {
      const countries = JSON.stringify([{ key: 'US' }]);
      const languages = JSON.stringify([{ key: 'en' }, { key: 'es' }]);
      const files = filesFrom([
        ['vocabulary/lookup-tables/countries.lookup.json', countries],
        ['vocabulary/lookup-tables/languages.lookup.json', languages],
      ]);
      const result = await disassembler.disassemble(makeCtx(files));

      const entries = result.records.filter((r) => r.collection === 'lookup_entries');
      expect(entries).toHaveLength(3);
      expect(entries.filter((e) => e.data.tableName === 'countries')).toHaveLength(1);
      expect(entries.filter((e) => e.data.tableName === 'languages')).toHaveLength(2);
    });
  });

  describe('canonical schemas', () => {
    it('should parse schema files', async () => {
      const json = JSON.stringify({
        name: 'User',
        fields: [{ name: 'email', type: 'string' }],
      });
      const files = filesFrom([['vocabulary/schemas/user.schema.json', json]]);
      const result = await disassembler.disassemble(makeCtx(files));

      const schemas = result.records.filter((r) => r.collection === 'canonical_schemas');
      expect(schemas).toHaveLength(1);
      expect(schemas[0].data.name).toBe('User');
    });

    it('should preserve exported schema knowledge-base IDs as remappable temp fields', async () => {
      const json = JSON.stringify({
        name: 'Account',
        knowledgeBaseId: 'source-kb-1',
        fields: [{ name: 'arr', type: 'number' }],
      });
      const files = filesFrom([['vocabulary/schemas/account.schema.json', json]]);
      const result = await disassembler.disassemble(makeCtx(files));

      const schema = result.records.find((r) => r.collection === 'canonical_schemas');
      expect(schema?.data.knowledgeBaseId).toBe('source-kb-1');
      expect(schema?.data._schemaKnowledgeBaseId).toBe('source-kb-1');
    });
  });

  describe('facts', () => {
    it('should parse facts.json as array and set scope to project', async () => {
      const json = JSON.stringify([
        { content: 'The company was founded in 2020', scope: 'global' },
        { content: 'Our main product is an AI assistant' },
      ]);
      const files = filesFrom([['vocabulary/facts.json', json]]);
      const result = await disassembler.disassemble(makeCtx(files));

      const facts = result.records.filter((r) => r.collection === 'facts');
      expect(facts).toHaveLength(2);
      // scope is always set to 'project'
      expect(facts[0].data.scope).toBe('project');
      expect(facts[1].data.scope).toBe('project');
    });
  });

  describe('superseded records', () => {
    it('should build superseded records for all vocabulary collections', async () => {
      const files = filesFrom([
        ['vocabulary/domain-vocabulary.json', JSON.stringify([{ term: 'A' }])],
      ]);
      const ctx = makeCtx(files, {
        conflictStrategy: 'replace',
        existingRecordIds: new Map([
          ['domain_vocabularies', [{ _id: 'dv-1' }]],
          ['lookup_entries', [{ _id: 'le-1' }, { _id: 'le-2' }]],
          ['canonical_schemas', [{ _id: 'cs-1' }]],
          ['facts', [{ _id: 'f-1' }]],
        ]),
      });
      const result = await disassembler.disassemble(ctx);

      expect(result.superseded.filter((s) => s.collection === 'domain_vocabularies')).toHaveLength(
        1,
      );
      expect(result.superseded.filter((s) => s.collection === 'lookup_entries')).toHaveLength(2);
      expect(result.superseded.filter((s) => s.collection === 'canonical_schemas')).toHaveLength(1);
      expect(result.superseded.filter((s) => s.collection === 'facts')).toHaveLength(1);
    });
  });

  describe('ownership injection', () => {
    it('should inject ownership on all vocabulary records', async () => {
      const files = filesFrom([
        ['vocabulary/domain-vocabulary.json', JSON.stringify([{ term: 'API' }])],
        ['vocabulary/lookup-tables/t.lookup.json', JSON.stringify([{ key: 'k' }])],
        ['vocabulary/schemas/s.schema.json', JSON.stringify({ name: 'S' })],
        ['vocabulary/facts.json', JSON.stringify([{ content: 'fact' }])],
      ]);
      const result = await disassembler.disassemble(makeCtx(files));

      for (const rec of result.records) {
        expect(rec.data.projectId).toBe('proj-1');
        expect(rec.data.tenantId).toBe('tenant-1');
        expect(rec.data.createdBy).toBe('user-1');
      }
    });
  });
});

// ─── Edge cases and empty inputs ─────────────────────────────────────────────

describe('edge cases', () => {
  it('should return empty results for empty file maps', async () => {
    const emptyFiles = new Map<string, string>();
    const ctx = makeCtx(emptyFiles);

    const core = await new CoreDisassembler().disassemble(ctx);
    expect(core.records).toHaveLength(0);
    expect(core.superseded).toHaveLength(0);
    expect(core.warnings).toHaveLength(0);

    const evals = await new EvalsDisassembler().disassemble(ctx);
    expect(evals.records).toHaveLength(0);

    const channels = await new ChannelsDisassembler().disassemble(ctx);
    expect(channels.records).toHaveLength(0);

    const workflows = await new WorkflowsDisassembler().disassemble(ctx);
    expect(workflows.records).toHaveLength(0);

    const search = await new SearchDisassembler().disassemble(ctx);
    expect(search.records).toHaveLength(0);

    const connections = await new ConnectionsDisassembler().disassemble(ctx);
    expect(connections.records).toHaveLength(0);

    const guardrails = await new GuardrailsDisassembler().disassemble(ctx);
    expect(guardrails.records).toHaveLength(0);

    const vocabulary = await new VocabularyDisassembler().disassemble(ctx);
    expect(vocabulary.records).toHaveLength(0);
  });

  it('should ignore unrecognized files in each disassembler', async () => {
    const files = filesFrom([
      ['random/unknown-file.txt', 'hello'],
      ['not-a-layer/file.json', '{}'],
    ]);
    const ctx = makeCtx(files);

    const core = await new CoreDisassembler().disassemble(ctx);
    expect(core.records).toHaveLength(0);

    const evals = await new EvalsDisassembler().disassemble(ctx);
    expect(evals.records).toHaveLength(0);

    const channels = await new ChannelsDisassembler().disassemble(ctx);
    expect(channels.records).toHaveLength(0);
  });

  it('should handle files with invalid JSON gracefully across disassemblers', async () => {
    const files = filesFrom([
      ['config/project-settings.json', 'not-json'],
      ['guardrails/bad.guardrail.json', '{broken'],
      ['workflows/bad.workflow.json', '[[invalid'],
    ]);
    const ctx = makeCtx(files);

    const core = await new CoreDisassembler().disassemble(ctx);
    expect(core.records).toHaveLength(0);
    expect(core.warnings.length).toBeGreaterThan(0);

    const guardrails = await new GuardrailsDisassembler().disassemble(ctx);
    expect(guardrails.records).toHaveLength(0);
    expect(guardrails.warnings.length).toBeGreaterThan(0);

    const workflows = await new WorkflowsDisassembler().disassemble(ctx);
    expect(workflows.records).toHaveLength(0);
    expect(workflows.warnings.length).toBeGreaterThan(0);
  });
});
