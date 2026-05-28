import { describe, expect, it } from 'vitest';
import type { ProjectManifestV2 } from '../types.js';
import { resolveImportedAgentIdentities } from '../import/agent-identity-resolver.js';

function makeManifest(overrides: Partial<ProjectManifestV2> = {}): ProjectManifestV2 {
  return {
    format_version: '2.0',
    name: 'Imported Project',
    slug: 'imported-project',
    description: 'Imported project',
    abl_version: '1.0',
    exported_at: '2026-03-27T00:00:00.000Z',
    exported_by: 'user-1',
    entry_agent: null,
    dsl_format: 'yaml',
    layers_included: ['core'],
    agents: {},
    tools: {},
    metadata: {
      entity_counts: {},
      required_env_vars: [],
      required_connectors: [],
      required_mcp_servers: [],
    },
    ...overrides,
  };
}

describe('resolveImportedAgentIdentities', () => {
  it('resolves manifest aliases to the declared imported agent name', () => {
    const manifest = makeManifest({
      entry_agent: 'afg_supervisor',
      agents: {
        afg_supervisor: {
          path: 'agents/afg_supervisor.agent.yaml',
          owner: 'user-1',
          ownerTeam: null,
          description: 'Routes requests',
          version: '1.0',
        },
      },
    });

    const result = resolveImportedAgentIdentities(
      new Map([
        ['agents/afg_supervisor.agent.yaml', 'SUPERVISOR: AFG_Supervisor\nGOAL: Route requests'],
      ]),
      manifest,
    );

    expect(result.agents.has('AFG_Supervisor')).toBe(true);
    expect(result.agents.get('AFG_Supervisor')?.description).toBe('Routes requests');
    expect(result.aliasMap.get('afg_supervisor')).toBe('AFG_Supervisor');
    expect(result.entryAgent).toEqual({
      requested: 'afg_supervisor',
      resolved: 'AFG_Supervisor',
      matchedBy: 'alias',
    });
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Resolved agent alias "afg_supervisor"'),
        expect.stringContaining('Resolved entry agent alias "afg_supervisor"'),
      ]),
    );
  });

  it('marks ambiguous aliases and keeps the entry agent unresolved', () => {
    const manifest = makeManifest({
      entry_agent: 'shared',
      agents: {
        legacy_shared: {
          path: 'agents/shared.agent.yaml',
          owner: 'user-1',
          ownerTeam: null,
          description: null,
          version: '1.0',
        },
        shared: {
          path: 'agents/beta.agent.yaml',
          owner: 'user-1',
          ownerTeam: null,
          description: null,
          version: '1.0',
        },
      },
    });

    const result = resolveImportedAgentIdentities(
      new Map([
        ['agents/shared.agent.yaml', 'AGENT: Alpha\nGOAL: Alpha goal'],
        ['agents/beta.agent.yaml', 'AGENT: Beta\nGOAL: Beta goal'],
      ]),
      manifest,
    );

    expect(result.ambiguousAliases.has('shared')).toBe(true);
    expect(result.entryAgent).toEqual({
      requested: 'shared',
      resolved: null,
      matchedBy: 'missing',
    });
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Imported agent alias "shared" is ambiguous'),
        expect.stringContaining('Entry agent "shared" is ambiguous'),
      ]),
    );
  });

  it('reports collisions when multiple files resolve to the same agent name', () => {
    const result = resolveImportedAgentIdentities(
      new Map([
        ['agents/first.agent.yaml', 'AGENT: Clash\nGOAL: First'],
        ['agents/second.agent.yaml', 'AGENT: Clash\nGOAL: Second'],
      ]),
      null,
    );

    expect(result.agents.size).toBe(1);
    expect(result.errors).toEqual([
      expect.stringContaining('Imported agent name collision: "Clash"'),
    ]);
  });

  it('rejects imported agent names that cannot be represented by canonical DSL identity', () => {
    const result = resolveImportedAgentIdentities(
      new Map([['agents/support-agent.agent.yaml', 'AGENT: support-agent\nGOAL: Help']]),
      null,
    );

    expect(result.agents.size).toBe(0);
    expect(result.errors).toEqual([
      expect.stringContaining('Invalid imported agent name "support-agent"'),
    ]);
  });
});
