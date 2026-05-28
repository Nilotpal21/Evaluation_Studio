import { describe, it, expect } from 'vitest';
import { importProject, type ExistingProjectState } from '../import/project-importer.js';
import { exportProject, type ProjectData } from '../export/project-exporter.js';
import { stripCommonPrefix } from '../import/path-normalizer.js';
import type { ImportOptions } from '../types.js';

const AGENT_A = `AGENT: AgentA
VERSION: "1.0"

GOAL: "Do A"
COMPLETE:
  - WHEN: true
    RESPOND: "Done A"`;

const AGENT_B = `AGENT: AgentB
VERSION: "1.0"

GOAL: "Do B"
COMPLETE:
  - WHEN: true
    RESPOND: "Done B"`;

function makeImportOptions(overrides: Partial<ImportOptions> = {}): ImportOptions {
  return {
    projectId: 'proj-1',
    userId: 'user-1',
    tenantId: 'tenant-1',
    files: new Map(),
    ...overrides,
  };
}

describe('stripCommonPrefix', () => {
  it('strips single wrapper directory', () => {
    const files = new Map([
      ['my-export/agents/a.agent.abl', 'A'],
      ['my-export/project.json', '{}'],
    ]);
    const result = stripCommonPrefix(files);
    expect(result.strippedPrefix).toBe('my-export/');
    expect([...result.files.keys()].sort()).toEqual(['agents/a.agent.abl', 'project.json']);
  });

  it('strips nested wrapper directories', () => {
    const files = new Map([
      ['repo-main/src/agents/a.agent.abl', 'A'],
      ['repo-main/src/tools/t.tools.abl', 'T'],
    ]);
    const result = stripCommonPrefix(files);
    expect(result.strippedPrefix).toBe('repo-main/src/');
    expect([...result.files.keys()].sort()).toEqual(['agents/a.agent.abl', 'tools/t.tools.abl']);
  });

  it('does not strip when files are already at canonical level', () => {
    const files = new Map([
      ['agents/a.agent.abl', 'A'],
      ['project.json', '{}'],
    ]);
    const result = stripCommonPrefix(files);
    expect(result.strippedPrefix).toBeNull();
    expect([...result.files.keys()].sort()).toEqual(['agents/a.agent.abl', 'project.json']);
  });

  it('returns original map for empty input', () => {
    const files = new Map<string, string>();
    const result = stripCommonPrefix(files);
    expect(result.strippedPrefix).toBeNull();
    expect(result.files.size).toBe(0);
  });

  it('stops before content directory names (agents/, tools/)', () => {
    const files = new Map([
      ['wrapper/agents/a.agent.abl', 'A'],
      ['wrapper/tools/t.tools.abl', 'T'],
    ]);
    const result = stripCommonPrefix(files);
    expect(result.strippedPrefix).toBe('wrapper/');
    expect([...result.files.keys()].sort()).toEqual(['agents/a.agent.abl', 'tools/t.tools.abl']);
  });

  it('does not over-strip prompt and core content directories', () => {
    const promptOnly = stripCommonPrefix(new Map([['prompts/support.prompt.json', '{}']]));
    const coreOnly = stripCommonPrefix(
      new Map([['core/mcp-servers/server.mcp-config.json', '{}']]),
    );

    expect(promptOnly.strippedPrefix).toBeNull();
    expect([...promptOnly.files.keys()]).toEqual(['prompts/support.prompt.json']);
    expect(coreOnly.strippedPrefix).toBeNull();
    expect([...coreOnly.files.keys()]).toEqual(['core/mcp-servers/server.mcp-config.json']);
  });

  it('normalizes a loose top-level agent .abl file into the canonical agents path', () => {
    const files = new Map([
      [
        'support-bot.abl',
        `AGENT: SupportBot
GOAL: Help customers
`,
      ],
    ]);

    const result = stripCommonPrefix(files);

    expect(result.strippedPrefix).toBeNull();
    expect([...result.files.keys()]).toEqual(['agents/support-bot.agent.abl']);
  });

  it('rewrites manifest paths when a loose top-level agent .abl file is normalized', () => {
    const files = new Map([
      [
        'project.json',
        JSON.stringify({
          name: 'Support',
          slug: 'support',
          version: '1.0.0',
          abl_version: '1.0',
          exported_at: new Date().toISOString(),
          exported_by: 'user-1',
          entry_agent: 'SupportBot',
          agents: {
            SupportBot: {
              path: 'support-bot.abl',
              owner: null,
              ownerTeam: null,
              description: null,
              version: null,
            },
          },
          tools: {},
          behavior_profiles: {},
          dependencies: { agent_references: [], tool_imports: [] },
        }),
      ],
      [
        'support-bot.abl',
        `AGENT: SupportBot
GOAL: Help customers
`,
      ],
    ]);

    const result = stripCommonPrefix(files);
    const manifest = JSON.parse(result.files.get('project.json') ?? '{}') as {
      agents?: Record<string, { path?: string }>;
    };

    expect(manifest.agents?.SupportBot?.path).toBe('agents/support-bot.agent.abl');
    expect(result.files.has('agents/support-bot.agent.abl')).toBe(true);
  });

  it('rewrites manifest paths when a loose top-level behavior profile file is normalized', () => {
    const files = new Map([
      [
        'project.json',
        JSON.stringify({
          format_version: '2.0',
          name: 'Support',
          slug: 'support',
          layers_included: ['core'],
          behavior_profiles: {
            voice: {
              path: 'voice.profile.abl',
            },
          },
          metadata: {
            entity_counts: { core: 1, behavior_profiles: 1 },
          },
        }),
      ],
      [
        'voice.profile.abl',
        `BEHAVIOR_PROFILE: voice
PRIORITY: 1
WHEN: true
CONVERSATION:
  speaking:
    tone: clear
`,
      ],
    ]);

    const result = stripCommonPrefix(files);
    const manifest = JSON.parse(result.files.get('project.json') ?? '{}') as {
      behavior_profiles?: Record<string, { path?: string }>;
    };

    expect(manifest.behavior_profiles?.voice?.path).toBe('behavior_profiles/voice.profile.abl');
    expect(result.files.has('behavior_profiles/voice.profile.abl')).toBe(true);
  });
});

describe('importProject', () => {
  it('should import a valid project', () => {
    const files = new Map<string, string>();
    files.set(
      'project.json',
      JSON.stringify({
        name: 'Test',
        slug: 'test',
        description: null,
        version: '1.0.0',
        abl_version: '1.0',
        exported_at: new Date().toISOString(),
        exported_by: 'user-1',
        entry_agent: 'AgentA',
        agents: {
          AgentA: {
            path: 'agents/agenta.agent.abl',
            owner: null,
            ownerTeam: null,
            description: null,
            version: null,
          },
        },
        tools: {},
        dependencies: { agent_references: [], tool_imports: [] },
      }),
    );
    files.set('agents/agenta.agent.abl', AGENT_A);

    const emptyState: ExistingProjectState = {
      agents: new Map(),
      toolFiles: new Map(),
    };

    const result = importProject(files, emptyState, makeImportOptions());

    expect(result.success).toBe(true);
    expect(result.preview.changes.agents.added).toContain('AgentA');
    expect(result.operations).toHaveLength(1);
    expect(result.operations[0].type).toBe('create');
  });

  it('should detect modified agents', () => {
    const files = new Map<string, string>();
    files.set(
      'project.json',
      JSON.stringify({
        name: 'Test',
        slug: 'test',
        description: null,
        version: '1.0.0',
        abl_version: '1.0',
        exported_at: new Date().toISOString(),
        exported_by: 'user-1',
        entry_agent: null,
        agents: {
          AgentA: {
            path: 'agents/agenta.agent.abl',
            owner: null,
            ownerTeam: null,
            description: null,
            version: null,
          },
        },
        tools: {},
        dependencies: { agent_references: [], tool_imports: [] },
      }),
    );

    const modifiedA = AGENT_A.replace('GOAL: "Do A"', 'GOAL: "Do A but better"');
    files.set('agents/agenta.agent.abl', modifiedA);

    const existingState: ExistingProjectState = {
      agents: new Map([['AgentA', { name: 'AgentA', dslContent: AGENT_A }]]),
      toolFiles: new Map(),
    };

    const result = importProject(files, existingState, makeImportOptions());

    expect(result.success).toBe(true);
    expect(result.preview.changes.agents.modified).toHaveLength(1);
    expect(result.preview.changes.agents.modified[0].name).toBe('AgentA');
  });

  it('should detect removed agents', () => {
    const files = new Map<string, string>();
    files.set(
      'project.json',
      JSON.stringify({
        name: 'Test',
        slug: 'test',
        description: null,
        version: '1.0.0',
        abl_version: '1.0',
        exported_at: new Date().toISOString(),
        exported_by: 'user-1',
        entry_agent: null,
        agents: {
          AgentA: {
            path: 'agents/agenta.agent.abl',
            owner: null,
            ownerTeam: null,
            description: null,
            version: null,
          },
        },
        tools: {},
        dependencies: { agent_references: [], tool_imports: [] },
      }),
    );
    files.set('agents/agenta.agent.abl', AGENT_A);

    // Existing state has AgentA and AgentB, import only has AgentA
    const existingState: ExistingProjectState = {
      agents: new Map([
        ['AgentA', { name: 'AgentA', dslContent: AGENT_A }],
        ['AgentB', { name: 'AgentB', dslContent: AGENT_B }],
      ]),
      toolFiles: new Map(),
    };

    const result = importProject(files, existingState, makeImportOptions());

    expect(result.preview.changes.agents.removed).toContain('AgentB');
    expect(result.operations.some((o) => o.type === 'delete' && o.agentName === 'AgentB')).toBe(
      true,
    );
  });

  it('should succeed without project.json (optional manifest)', () => {
    const files = new Map<string, string>();
    files.set('agents/agenta.agent.abl', AGENT_A);

    const result = importProject(
      files,
      { agents: new Map(), toolFiles: new Map() },
      makeImportOptions(),
    );
    expect(result.success).toBe(true);
    expect(result.preview.changes.agents.added).toContain('AgentA');
  });

  it('should succeed with a loose top-level .abl agent upload', () => {
    const files = new Map<string, string>();
    files.set('agenta.abl', AGENT_A);

    const result = importProject(
      files,
      { agents: new Map(), toolFiles: new Map() },
      makeImportOptions(),
    );

    expect(result.success).toBe(true);
    expect(result.preview.changes.agents.added).toContain('AgentA');
    expect(result.operations).toEqual([
      expect.objectContaining({
        type: 'create',
        agentName: 'AgentA',
      }),
    ]);
  });

  it('should strip wrapper prefix from zip-like paths with project.json', () => {
    const manifest = JSON.stringify({
      name: 'Test',
      slug: 'test',
      description: null,
      version: '1.0.0',
      abl_version: '1.0',
      exported_at: new Date().toISOString(),
      exported_by: 'user-1',
      entry_agent: 'AgentA',
      agents: {
        AgentA: {
          path: 'agents/agenta.agent.abl',
          owner: null,
          ownerTeam: null,
          description: null,
          version: null,
        },
      },
      tools: {},
      dependencies: { agent_references: [], tool_imports: [] },
    });

    // Simulate zip extraction with a wrapper directory (e.g., my-export/)
    const files = new Map<string, string>();
    files.set('my-export/project.json', manifest);
    files.set('my-export/agents/agenta.agent.abl', AGENT_A);

    const result = importProject(
      files,
      { agents: new Map(), toolFiles: new Map() },
      makeImportOptions(),
    );

    expect(result.success).toBe(true);
    expect(result.preview.changes.agents.added).toContain('AgentA');
    expect(result.operations).toHaveLength(1);
    expect(result.operations[0].type).toBe('create');
  });

  it('should round-trip export→import with byte-identical content', () => {
    const projectData: ProjectData = {
      name: 'RoundTrip',
      slug: 'round-trip',
      description: null,
      entryAgentName: null,
      agents: [
        {
          name: 'AgentA',
          description: null,
          dslContent: AGENT_A,
          ownerId: null,
          ownerTeamId: null,
          version: '1.0',
          status: 'active',
        },
        {
          name: 'AgentB',
          description: null,
          dslContent: AGENT_B,
          ownerId: null,
          ownerTeamId: null,
          version: '1.0',
          status: 'active',
        },
      ],
      toolFiles: [],
      deployments: [],
    };

    // Export
    const exportResult = exportProject(projectData, {
      projectId: 'p1',
      userId: 'u1',
      tenantId: 't1',
      format: 'folder',
    });

    expect(exportResult.success).toBe(true);

    // Import into fresh state
    const importResult = importProject(
      exportResult.files,
      { agents: new Map(), toolFiles: new Map() },
      makeImportOptions(),
    );

    expect(importResult.success).toBe(true);
    expect(importResult.preview.changes.agents.added).toContain('AgentA');
    expect(importResult.preview.changes.agents.added).toContain('AgentB');

    // Verify the operations contain the exact original DSL content
    const createOps = importResult.operations.filter((o) => o.type === 'create');
    const agentAOp = createOps.find((o) => o.agentName === 'AgentA');
    const agentBOp = createOps.find((o) => o.agentName === 'AgentB');
    expect(agentAOp?.dslContent).toBe(AGENT_A);
    expect(agentBOp?.dslContent).toBe(AGENT_B);
  });

  it('should detect added and modified locale files', () => {
    const files = new Map<string, string>();
    files.set('agents/agenta.agent.abl', AGENT_A);
    files.set('locales/en/agenta.json', '{"greeting": "Hello"}');
    files.set('locales/es/agenta.json', '{"greeting": "Hola"}');

    const existingState: ExistingProjectState = {
      agents: new Map(),
      toolFiles: new Map(),
      localeFiles: new Map([['locales/en/agenta.json', '{"greeting": "Hi"}']]),
    };

    const result = importProject(files, existingState, makeImportOptions());

    expect(result.success).toBe(true);
    expect(result.preview.changes.locales.added).toContain('locales/es/agenta.json');
    expect(result.preview.changes.locales.modified).toContain('locales/en/agenta.json');
  });

  it('should detect removed locale files', () => {
    const files = new Map<string, string>();
    files.set('agents/agenta.agent.abl', AGENT_A);

    const existingState: ExistingProjectState = {
      agents: new Map(),
      toolFiles: new Map(),
      localeFiles: new Map([['locales/en/agenta.json', '{"greeting": "Hello"}']]),
    };

    const result = importProject(files, existingState, makeImportOptions());

    expect(result.success).toBe(true);
    expect(result.preview.changes.locales.removed).toContain('locales/en/agenta.json');
  });

  describe('tool extraction in import', () => {
    const TOOL_DSL = `TOOLS:
  my_tool(x: string) -> string
    description: "test"
    type: http
    endpoint: "/test"
    method: GET`;

    it('should include toolOperations in import result', () => {
      const files = new Map([
        ['agents/test.agent.abl', AGENT_A],
        ['tools/api.tools.abl', TOOL_DSL],
      ]);
      const existingState: ExistingProjectState = {
        agents: new Map(),
        toolFiles: new Map(),
      };
      const result = importProject(files, existingState, makeImportOptions());

      expect(result.toolOperations).toBeDefined();
      expect(result.toolOperations.length).toBeGreaterThan(0);
      expect(result.toolOperations[0].type).toBe('create');
      expect(result.toolOperations[0].toolName).toBe('my_tool');
    });

    it('should show tool names in preview', () => {
      const files = new Map([
        ['agents/test.agent.abl', AGENT_A],
        ['tools/api.tools.abl', TOOL_DSL],
      ]);
      const existingState: ExistingProjectState = {
        agents: new Map(),
        toolFiles: new Map(),
      };
      const result = importProject(files, existingState, makeImportOptions());

      expect(result.preview.changes.tools.added).toHaveLength(1);
      expect(result.preview.changes.tools.added[0].name).toBe('my_tool');
    });
  });
});
