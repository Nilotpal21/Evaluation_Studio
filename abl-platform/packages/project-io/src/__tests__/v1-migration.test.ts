import { describe, it, expect } from 'vitest';
import { migrateV1ToV2, type V1MigrationResult } from '../import/v1-migration.js';
import type { ProjectManifestV2, LockFileV2, LayerName } from '../types.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeV1Manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'My Project',
    slug: 'my-project',
    description: 'A test project',
    version: '1.0',
    abl_version: '1.0',
    exported_at: '2026-01-15T10:00:00Z',
    exported_by: 'user-1',
    entry_agent: 'Main',
    dsl_format: 'yaml',
    agents: {
      Main: {
        path: 'agents/main.agent.abl',
        owner: 'user-1',
        ownerTeam: null,
        description: 'Main agent',
        version: '1.0',
      },
    },
    tools: {
      SearchAPI: {
        path: 'tools/search_api.tools.abl',
        owner: 'user-1',
      },
    },
    dependencies: {
      agent_references: [],
      tool_imports: [],
    },
    ...overrides,
  };
}

function makeV2Manifest(): ProjectManifestV2 {
  return {
    format_version: '2.0',
    name: 'My Project V2',
    slug: 'my-project-v2',
    description: 'A v2 project',
    abl_version: '1.0',
    exported_at: '2026-03-07T10:00:00Z',
    exported_by: 'user-2',
    entry_agent: 'Main',
    dsl_format: 'yaml',
    layers_included: ['core', 'connections', 'guardrails'],
    agents: {
      Main: {
        path: 'agents/main.agent.abl',
        owner: 'user-2',
        ownerTeam: null,
        description: 'Main agent',
        version: '1.0',
      },
    },
    tools: {},
    metadata: {
      entity_counts: { agents: 1 },
      required_env_vars: [],
      required_connectors: [],
      required_mcp_servers: [],
    },
  };
}

function makeV1Files(): Map<string, string> {
  const manifest = makeV1Manifest();
  return new Map([
    ['project.json', JSON.stringify(manifest)],
    ['agents/main.agent.abl', 'AGENT: Main\nGOAL: "Hello"'],
    ['tools/search_api.tools.abl', 'TOOLS:\n  search()'],
    [
      'abl.lock',
      JSON.stringify({
        lockfile_version: '1.0',
        generated_at: '2026-01-15T10:00:00Z',
        agents: { Main: { version: '1.0', source_hash: 'abc123', status: 'active' } },
        tools: { SearchAPI: { source_hash: 'def456' } },
        integrity: 'sha256-old',
      }),
    ],
  ]);
}

function makeV2Files(): Map<string, string> {
  const manifest = makeV2Manifest();
  return new Map([
    ['project.json', JSON.stringify(manifest)],
    ['agents/main.agent.abl', 'AGENT: Main\nGOAL: "Hello"'],
    [
      'abl.lock',
      JSON.stringify({
        lockfile_version: '2.0',
        generated_at: '2026-03-07T10:00:00Z',
        agents: { Main: { version: '1.0', source_hash: 'abc', status: 'active' } },
        tools: {},
        configs: {},
        connections: {},
        guardrails: {},
        workflows: {},
        evals: {},
        search: {},
        channels: {},
        vocabulary: {},
        layer_hashes: { core: 'sha256-core' },
        integrity: 'sha256-root',
      }),
    ],
  ]);
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('migrateV1ToV2', () => {
  describe('v1 export without format_version', () => {
    it('returns core-only result with migration warnings', () => {
      const files = makeV1Files();
      const result = migrateV1ToV2(files);

      expect(result.migrated).toBe(true);
      expect(result.formatVersion).toBe('1.0');
      expect(result.warnings).toContain('v1 format — configs, connections, workflows not included');
    });

    it('normalizes manifest to v2 structure with only core layer', () => {
      const files = makeV1Files();
      const result = migrateV1ToV2(files);

      expect(result.manifest.format_version).toBe('2.0');
      expect(result.manifest.layers_included).toEqual(['core']);
      expect(result.manifest.agents).toBeDefined();
      expect(result.manifest.tools).toBeDefined();
      expect(result.manifest.metadata).toBeDefined();
      expect(result.manifest.metadata.entity_counts.agents).toBe(1);
      expect(result.manifest.metadata.entity_counts.tools).toBe(1);
      expect(result.manifest.metadata.required_env_vars).toEqual([]);
      expect(result.manifest.metadata.required_connectors).toEqual([]);
      expect(result.manifest.metadata.required_mcp_servers).toEqual([]);
    });

    it('skips lockfile v2 verification', () => {
      const files = makeV1Files();
      const result = migrateV1ToV2(files);

      expect(result.skipLockfileVerification).toBe(true);
    });

    it('passes through agent and tool files unchanged', () => {
      const files = makeV1Files();
      const result = migrateV1ToV2(files);

      expect(result.files.get('agents/main.agent.abl')).toBe('AGENT: Main\nGOAL: "Hello"');
      expect(result.files.get('tools/search_api.tools.abl')).toBe('TOOLS:\n  search()');
    });
  });

  describe('v1 export with format_version "1.0"', () => {
    it('returns core-only result with migration warnings', () => {
      const manifest = makeV1Manifest({ format_version: '1.0' });
      const files = new Map([
        ['project.json', JSON.stringify(manifest)],
        ['agents/main.agent.abl', 'AGENT: Main\nGOAL: "Hello"'],
      ]);

      const result = migrateV1ToV2(files);

      expect(result.migrated).toBe(true);
      expect(result.formatVersion).toBe('1.0');
      expect(result.warnings).toContain('v1 format — configs, connections, workflows not included');
      expect(result.manifest.format_version).toBe('2.0');
      expect(result.manifest.layers_included).toEqual(['core']);
    });
  });

  describe('v2 export', () => {
    it('passes through unchanged', () => {
      const files = makeV2Files();
      const result = migrateV1ToV2(files);

      expect(result.migrated).toBe(false);
      expect(result.formatVersion).toBe('2.0');
      expect(result.warnings).toHaveLength(0);
      expect(result.skipLockfileVerification).toBe(false);
      expect(result.manifest.format_version).toBe('2.0');
      expect(result.manifest.layers_included).toEqual(['core', 'connections', 'guardrails']);
    });

    it('preserves all files', () => {
      const files = makeV2Files();
      const result = migrateV1ToV2(files);

      expect(result.files.get('agents/main.agent.abl')).toBe('AGENT: Main\nGOAL: "Hello"');
    });
  });

  describe('unknown future version', () => {
    it('rejects with upgrade error for v3', () => {
      const manifest = makeV1Manifest({ format_version: '3.0' });
      const files = new Map([['project.json', JSON.stringify(manifest)]]);

      const result = migrateV1ToV2(files);

      expect(result.error).toBeDefined();
      expect(result.error!.code).toBe('UNSUPPORTED_VERSION');
      expect(result.error!.message).toContain('please upgrade');
    });

    it('rejects with upgrade error for v99', () => {
      const manifest = makeV1Manifest({ format_version: '99.0' });
      const files = new Map([['project.json', JSON.stringify(manifest)]]);

      const result = migrateV1ToV2(files);

      expect(result.error).toBeDefined();
      expect(result.error!.code).toBe('UNSUPPORTED_VERSION');
    });
  });

  describe('edge cases', () => {
    it('auto-generates manifest when project.json is missing', () => {
      const files = new Map([['agents/main.agent.abl', 'AGENT: Main']]);

      const result = migrateV1ToV2(files);

      // Should auto-generate a manifest instead of erroring
      expect(result.error).toBeUndefined();
      expect(result.migrated).toBe(true);
      expect(result.manifest).toBeDefined();
      expect(result.manifest!.entry_agent).toBe('Main');
      expect(result.warnings.length).toBeGreaterThan(0);
    });

    it('auto-generates manifest with both agents and tools when agents appear first in iteration', () => {
      // Regression: break (instead of continue) on the agent/tool limit checks
      // would exit the entire loop, causing tool files that appear after agent
      // files in the Map iteration order to be skipped.
      const files = new Map([
        ['agents/alpha.agent.abl', 'AGENT: Alpha'],
        ['agents/beta.agent.abl', 'AGENT: Beta'],
        ['tools/search.tools.abl', 'search(query: string) -> string'],
        ['tools/fetch.tools.abl', 'fetch(url: string) -> string'],
      ]);

      const result = migrateV1ToV2(files);

      expect(result.error).toBeUndefined();
      expect(result.migrated).toBe(true);
      expect(result.manifest.entry_agent).toBe('Alpha');
      expect(result.manifest.metadata.entity_counts.agents).toBe(2);
      expect(result.manifest.metadata.entity_counts.tools).toBe(2);
      expect(result.manifest.agents).toHaveProperty('Alpha');
      expect(result.manifest.agents).toHaveProperty('Beta');
      expect(result.manifest.tools).toHaveProperty('search');
      expect(result.manifest.tools).toHaveProperty('fetch');
    });

    it('auto-generates v2 manifest entries from parser-valid YAML agent declarations', () => {
      const files = new Map([
        ['agents/object.agent.yaml', 'agent:\n  name: YamlObjectAgent\n  goal: Help users\n'],
        ['agents/quoted.agent.yaml', 'agent: "QuotedYamlAgent" # exported by Studio\n'],
      ]);

      const result = migrateV1ToV2(files);

      expect(result.error).toBeUndefined();
      expect(result.migrated).toBe(true);
      expect(result.manifest.agents).toHaveProperty('QuotedYamlAgent');
      expect(result.manifest.agents).toHaveProperty('YamlObjectAgent');
      expect(result.manifest.entry_agent).toBe('QuotedYamlAgent');
      expect(result.manifest.metadata.entity_counts.agents).toBe(2);
    });

    it('handles malformed project.json', () => {
      const files = new Map([['project.json', 'not-json']]);

      const result = migrateV1ToV2(files);

      expect(result.error).toBeDefined();
      expect(result.error!.code).toBe('INVALID_MANIFEST');
    });

    it('handles v1 manifest with empty agents', () => {
      const manifest = makeV1Manifest({ agents: {}, tools: {} });
      const files = new Map([['project.json', JSON.stringify(manifest)]]);

      const result = migrateV1ToV2(files);

      expect(result.migrated).toBe(true);
      expect(result.manifest.metadata.entity_counts.agents).toBe(0);
      expect(result.manifest.metadata.entity_counts.tools).toBe(0);
    });
  });
});
