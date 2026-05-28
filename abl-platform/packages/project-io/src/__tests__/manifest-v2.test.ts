/**
 * Tests for manifest generator v2
 */

import { describe, it, expect } from 'vitest';
import { generateManifestV2 } from '../export/manifest-generator.js';
import type { ManifestInputV2 } from '../export/manifest-generator.js';
import type { LayerName } from '../types.js';

function makeInput(overrides: Partial<ManifestInputV2> = {}): ManifestInputV2 {
  return {
    projectName: 'Test Project',
    projectSlug: 'test-project',
    projectDescription: 'A test project',
    exportedBy: 'user-1',
    entryAgent: 'Supervisor',
    agents: [
      {
        name: 'Supervisor',
        description: 'Main router',
        ownerId: 'user-1',
        ownerTeamId: null,
        version: '1.0',
      },
    ],
    tools: [{ name: 'search-tool', ownerId: 'user-1' }],
    edges: [],
    dslFormat: 'yaml',
    layers: ['core', 'connections'] as LayerName[],
    entityCounts: { agents: 1, tools: 1, connections: 3 },
    requiredEnvVars: ['OPENAI_API_KEY'],
    requiredConnectors: ['salesforce'],
    requiredMcpServers: ['mcp-knowledge'],
    ...overrides,
  };
}

describe('generateManifestV2', () => {
  it('should produce format_version 2.0', () => {
    const manifest = generateManifestV2(makeInput());

    expect(manifest.format_version).toBe('2.0');
  });

  it('should include layers_included from input', () => {
    const manifest = generateManifestV2(
      makeInput({ layers: ['core', 'connections', 'guardrails'] }),
    );

    expect(manifest.layers_included).toEqual(['core', 'connections', 'guardrails']);
  });

  it('should populate agents with correct paths', () => {
    const manifest = generateManifestV2(makeInput());

    expect(manifest.agents['Supervisor']).toBeDefined();
    expect(manifest.agents['Supervisor'].path).toContain('supervisor');
    expect(manifest.agents['Supervisor'].owner).toBe('user-1');
    expect(manifest.agents['Supervisor'].description).toBe('Main router');
    expect(manifest.agents['Supervisor'].version).toBe('1.0');
  });

  it('should include prompt library refs when an agent carries companion metadata', () => {
    const manifest = generateManifestV2(
      makeInput({
        agents: [
          {
            name: 'Supervisor',
            description: 'Main router',
            ownerId: 'user-1',
            ownerTeamId: null,
            version: '1.0',
            systemPromptLibraryRef: {
              promptId: 'prompt-1',
              versionId: 'version-2',
            },
          },
        ],
      }),
    );

    expect(manifest.agents['Supervisor'].systemPromptLibraryRef).toEqual({
      promptId: 'prompt-1',
      versionId: 'version-2',
    });
  });

  it('should populate tools with correct paths', () => {
    const manifest = generateManifestV2(makeInput());

    expect(manifest.tools['search-tool']).toBeDefined();
    expect(manifest.tools['search-tool'].path).toContain('search-tool');
    expect(manifest.tools['search-tool'].owner).toBe('user-1');
  });

  it('should include metadata block with entity counts', () => {
    const manifest = generateManifestV2(makeInput());

    expect(manifest.metadata.entity_counts).toEqual({
      agents: 1,
      tools: 1,
      connections: 3,
    });
  });

  it('should include required env vars in metadata', () => {
    const manifest = generateManifestV2(makeInput());

    expect(manifest.metadata.required_env_vars).toEqual(['OPENAI_API_KEY']);
  });

  it('should include required connectors in metadata', () => {
    const manifest = generateManifestV2(makeInput());

    expect(manifest.metadata.required_connectors).toEqual(['salesforce']);
  });

  it('should include required MCP servers in metadata', () => {
    const manifest = generateManifestV2(makeInput());

    expect(manifest.metadata.required_mcp_servers).toEqual(['mcp-knowledge']);
  });

  it('should include behavior profiles when provided', () => {
    const manifest = generateManifestV2(
      makeInput({
        profiles: [
          {
            name: 'cautious',
            priority: 1,
            whenSummary: 'When handling sensitive data',
            usedBy: ['Supervisor'],
          },
        ],
      }),
    );

    expect(manifest.behavior_profiles).toBeDefined();
    expect(manifest.behavior_profiles!['cautious']).toBeDefined();
    expect(manifest.behavior_profiles!['cautious'].priority).toBe(1);
    expect(manifest.behavior_profiles!['cautious'].used_by).toEqual(['Supervisor']);
  });

  it('should include empty behavior_profiles when none provided', () => {
    const manifest = generateManifestV2(makeInput({ profiles: undefined }));

    expect(manifest.behavior_profiles).toEqual({});
  });

  it('should set exported_at to ISO string', () => {
    const before = new Date().toISOString();
    const manifest = generateManifestV2(makeInput());
    const after = new Date().toISOString();

    expect(manifest.exported_at >= before).toBe(true);
    expect(manifest.exported_at <= after).toBe(true);
  });

  it('should use yaml dsl_format by default', () => {
    const manifest = generateManifestV2(makeInput({ dslFormat: undefined }));

    expect(manifest.dsl_format).toBe('yaml');
  });

  it('should use yaml dsl_format when specified', () => {
    const manifest = generateManifestV2(makeInput({ dslFormat: 'yaml' }));

    expect(manifest.dsl_format).toBe('yaml');
  });

  it('should preserve mixed and legacy dsl_format values for honest exports', () => {
    expect(generateManifestV2(makeInput({ dslFormat: 'mixed' })).dsl_format).toBe('mixed');
    expect(generateManifestV2(makeInput({ dslFormat: 'legacy' })).dsl_format).toBe('legacy');
  });

  it('should handle empty metadata arrays', () => {
    const manifest = generateManifestV2(
      makeInput({
        requiredEnvVars: [],
        requiredConnectors: [],
        requiredMcpServers: [],
      }),
    );

    expect(manifest.metadata.required_env_vars).toEqual([]);
    expect(manifest.metadata.required_connectors).toEqual([]);
    expect(manifest.metadata.required_mcp_servers).toEqual([]);
  });

  it('should set entry_agent when entryAgent is provided', () => {
    const manifest = generateManifestV2(makeInput({ entryAgent: 'my_supervisor' }));

    expect(manifest.entry_agent).toBe('my_supervisor');
  });

  it('should set entry_agent to null when entryAgent is null', () => {
    const manifest = generateManifestV2(makeInput({ entryAgent: null }));

    expect(manifest.entry_agent).toBeNull();
  });

  it('should use materialized agent and tool paths when provided', () => {
    const manifest = generateManifestV2(
      makeInput({
        agentPaths: {
          Supervisor: 'agents/supervisor.agent.abl',
        },
        toolPaths: {
          'search-tool': 'tools/search-tool.tools.abl',
        },
      }),
    );

    expect(manifest.agents['Supervisor'].path).toBe('agents/supervisor.agent.abl');
    expect(manifest.tools['search-tool'].path).toBe('tools/search-tool.tools.abl');
  });

  it('should handle multiple agents and tools', () => {
    const manifest = generateManifestV2(
      makeInput({
        agents: [
          {
            name: 'Supervisor',
            description: 'Main',
            ownerId: 'u1',
            ownerTeamId: null,
            version: '1.0',
          },
          {
            name: 'Helper',
            description: 'Assists',
            ownerId: 'u2',
            ownerTeamId: 'team-1',
            version: '2.0',
          },
        ],
        tools: [
          { name: 'search', ownerId: 'u1' },
          { name: 'calendar', ownerId: 'u2' },
        ],
        entityCounts: { agents: 2, tools: 2 },
      }),
    );

    expect(Object.keys(manifest.agents)).toHaveLength(2);
    expect(Object.keys(manifest.tools)).toHaveLength(2);
    expect(manifest.agents['Helper'].ownerTeam).toBe('team-1');
  });
});
