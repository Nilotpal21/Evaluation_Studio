import { describe, it, expect, vi } from 'vitest';
import {
  exportProject,
  resolveLayers,
  exportProjectV2,
  type ProjectData,
  type ExportV2Deps,
} from '../export/project-exporter.js';
import type { ExportOptions, ExportOptionsV2, LayerName, LayerAssemblyResult } from '../types.js';
import type { LayerAssembler, LayerQueryContext } from '../export/layer-assemblers/types.js';

vi.mock('@abl/language-service', () => ({
  serializeToYAML: vi.fn(
    (ir: Record<string, unknown>) => `# YAML converted\nagent: ${ir?.name ?? 'unknown'}\n`,
  ),
}));

import { serializeToYAML } from '@abl/language-service';

const SUPERVISOR_DSL = `SUPERVISOR: Main
VERSION: "1.0"

GOAL: "Route requests"
HANDOFF:
  - TO: Worker
    WHEN: true`;

const WORKER_DSL = `AGENT: Worker
VERSION: "1.0"

GOAL: "Do work"
COMPLETE:
  - WHEN: true
    RESPOND: "Done"`;

function makeProjectData(overrides: Partial<ProjectData> = {}): ProjectData {
  return {
    name: 'Test Project',
    slug: 'test-project',
    description: 'A test project',
    entryAgentName: 'Main',
    agents: [
      {
        name: 'Main',
        description: 'Supervisor',
        dslContent: SUPERVISOR_DSL,
        ownerId: 'user-1',
        ownerTeamId: null,
        version: '1.0',
        status: 'active',
      },
      {
        name: 'Worker',
        description: 'Worker agent',
        dslContent: WORKER_DSL,
        ownerId: 'user-2',
        ownerTeamId: null,
        version: '1.0',
        status: 'active',
      },
    ],
    toolFiles: [],
    deployments: [],
    ...overrides,
  };
}

const DEFAULT_OPTIONS: ExportOptions = {
  projectId: 'proj-1',
  userId: 'user-1',
  tenantId: 'tenant-1',
  format: 'folder',
};

describe('exportProject', () => {
  it('should export a project with manifest and lockfile', () => {
    const result = exportProject(makeProjectData(), DEFAULT_OPTIONS);

    expect(result.success).toBe(true);
    expect(result.files.has('project.json')).toBe(true);
    expect(result.files.has('abl.lock')).toBe(true);
  });

  it('should create agent files in agents/ directory', () => {
    const result = exportProject(makeProjectData(), DEFAULT_OPTIONS);

    const agentFiles = [...result.files.keys()].filter((p) => p.startsWith('agents/'));
    expect(agentFiles).toHaveLength(2);
    expect(agentFiles.some((p) => p.includes('main'))).toBe(true);
    expect(agentFiles.some((p) => p.includes('worker'))).toBe(true);
  });

  it('should preserve exact dslContent in agent files', () => {
    const result = exportProject(makeProjectData(), DEFAULT_OPTIONS);

    const mainFile = [...result.files.entries()].find(([p]) => p.includes('main'));
    expect(mainFile).toBeDefined();
    expect(mainFile![1]).toBe(SUPERVISOR_DSL);
  });

  it('should generate valid manifest with dependencies', () => {
    const result = exportProject(makeProjectData(), DEFAULT_OPTIONS);

    expect(result.manifest.name).toBe('Test Project');
    expect(result.manifest.entry_agent).toBe('Main');
    expect(result.manifest.agents['Main']).toBeDefined();
    expect(result.manifest.agents['Worker']).toBeDefined();

    // Supervisor handoffs to Worker
    const handoffs = result.manifest.dependencies.agent_references;
    expect(handoffs.some((h) => h.from === 'Main' && h.to === 'Worker')).toBe(true);
  });

  it('should preserve systemPromptLibraryRef in the exported manifest', () => {
    const result = exportProject(
      makeProjectData({
        agents: [
          {
            name: 'Main',
            description: 'Supervisor',
            dslContent: SUPERVISOR_DSL,
            ownerId: 'user-1',
            ownerTeamId: null,
            version: '1.0',
            status: 'active',
            systemPromptLibraryRef: {
              promptId: 'prompt-1',
              versionId: 'version-1',
              resolvedHash: 'prompt-hash-1',
            },
          },
          {
            name: 'Worker',
            description: 'Worker agent',
            dslContent: WORKER_DSL,
            ownerId: 'user-2',
            ownerTeamId: null,
            version: '1.0',
            status: 'active',
          },
        ],
      }),
      DEFAULT_OPTIONS,
    );

    expect(result.success).toBe(true);
    expect(result.manifest.agents['Main'].systemPromptLibraryRef).toEqual({
      promptId: 'prompt-1',
      versionId: 'version-1',
      resolvedHash: 'prompt-hash-1',
    });
  });

  it('should generate lockfile with source hashes', () => {
    const result = exportProject(makeProjectData(), DEFAULT_OPTIONS);

    expect(result.lockfile.lockfile_version).toBe('1.0');
    expect(result.lockfile.agents['Main']).toBeDefined();
    expect(result.lockfile.agents['Main'].source_hash).toBeTruthy();
    expect(result.lockfile.agents['Worker']).toBeDefined();
  });

  it('should change v1 lockfile agent hashes when only systemPromptLibraryRef changes', () => {
    const withoutPromptRef = exportProject(makeProjectData(), DEFAULT_OPTIONS);
    const withPromptRef = exportProject(
      makeProjectData({
        agents: [
          {
            name: 'Main',
            description: 'Supervisor',
            dslContent: SUPERVISOR_DSL,
            ownerId: 'user-1',
            ownerTeamId: null,
            version: '1.0',
            status: 'active',
            systemPromptLibraryRef: {
              promptId: 'prompt-1',
              versionId: 'version-1',
              resolvedHash: 'prompt-hash-1',
            },
          },
          {
            name: 'Worker',
            description: 'Worker agent',
            dslContent: WORKER_DSL,
            ownerId: 'user-2',
            ownerTeamId: null,
            version: '1.0',
            status: 'active',
          },
        ],
      }),
      DEFAULT_OPTIONS,
    );

    expect(withPromptRef.lockfile.agents['Main'].source_hash).not.toBe(
      withoutPromptRef.lockfile.agents['Main'].source_hash,
    );
  });

  it('should fail with NO_AGENTS error for empty project', () => {
    const result = exportProject(makeProjectData({ agents: [] }), DEFAULT_OPTIONS);
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('NO_AGENTS');
  });

  it('should auto-detect entry agent from SUPERVISOR keyword', () => {
    const data = makeProjectData({ entryAgentName: null });
    const result = exportProject(data, DEFAULT_OPTIONS);
    expect(result.manifest.entry_agent).toBe('Main');
  });

  it('should warn when no entry agent can be detected', () => {
    const data = makeProjectData({
      entryAgentName: null,
      agents: [
        {
          name: 'Worker',
          description: 'Worker agent',
          dslContent: WORKER_DSL,
          ownerId: 'user-2',
          ownerTeamId: null,
          version: '1.0',
          status: 'active',
        },
      ],
    });
    const result = exportProject(data, DEFAULT_OPTIONS);
    expect(result.success).toBe(true);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toContain('No entry agent detected');
  });

  it('should include tool files in export', () => {
    const data = makeProjectData({
      toolFiles: [
        { name: 'lookup', path: 'tools/lookup.ts', content: 'export function lookup() {}' },
        { name: 'search', path: 'tools/search.ts', content: 'export function search() {}' },
      ],
    });
    const result = exportProject(data, DEFAULT_OPTIONS);
    expect(result.success).toBe(true);
    const toolFiles = [...result.files.keys()].filter((p) => p.startsWith('tools/'));
    expect(toolFiles).toHaveLength(2);
    expect(result.manifest.tools['lookup']).toBeDefined();
    expect(result.manifest.tools['search']).toBeDefined();
  });

  it('should include deployments when includeDeployments is true', () => {
    const data = makeProjectData({
      deployments: [
        {
          environment: 'staging',
          status: 'active',
          agentVersions: { Main: '1.0' },
          config: {},
          createdAt: new Date('2026-01-01'),
          deployedBy: 'user-1',
        },
        {
          environment: 'production',
          status: 'active',
          agentVersions: { Main: '1.0' },
          config: {},
          createdAt: new Date('2026-01-02'),
          deployedBy: 'user-1',
        },
      ],
    });
    const options: ExportOptions = { ...DEFAULT_OPTIONS, includeDeployments: true };
    const result = exportProject(data, options);
    expect(result.success).toBe(true);
    const deployFiles = [...result.files.keys()].filter((p) => p.startsWith('deployments/'));
    expect(deployFiles.length).toBeGreaterThan(0);
  });

  it('should include locale asset files when locales are present', () => {
    const data = makeProjectData({
      locales: new Map([
        ['en/_shared.json', '{"greeting":"Hello"}'],
        ['fr/worker.json', '{"greeting":"Bonjour"}'],
      ]),
    });

    const result = exportProject(data, DEFAULT_OPTIONS);

    expect(result.success).toBe(true);
    expect(result.files.get('locales/en/_shared.json')).toBe('{"greeting":"Hello"}');
    expect(result.files.get('locales/fr/worker.json')).toBe('{"greeting":"Bonjour"}');
  });

  it('should filter deployments by environment', () => {
    const data = makeProjectData({
      deployments: [
        {
          environment: 'staging',
          status: 'active',
          agentVersions: { Main: '1.0' },
          config: {},
          createdAt: new Date('2026-01-01'),
          deployedBy: 'user-1',
        },
        {
          environment: 'production',
          status: 'active',
          agentVersions: { Main: '1.0' },
          config: {},
          createdAt: new Date('2026-01-02'),
          deployedBy: 'user-1',
        },
      ],
    });
    const options: ExportOptions = {
      ...DEFAULT_OPTIONS,
      includeDeployments: true,
      environments: ['staging'],
    };
    const result = exportProject(data, options);
    expect(result.success).toBe(true);
    const deployFiles = [...result.files.keys()].filter((p) => p.startsWith('deployments/'));
    // Only staging deployment should be included
    expect(deployFiles).toHaveLength(1);
    expect(deployFiles[0]).toContain('staging');
  });

  it('should convert DSL to YAML when dslFormat is yaml and compileFn succeeds', () => {
    const compileFn = vi.fn().mockReturnValue({ name: 'Main', type: 'supervisor' });
    const options: ExportOptions = { ...DEFAULT_OPTIONS, dslFormat: 'yaml', compileFn };
    const result = exportProject(makeProjectData(), options);
    expect(result.success).toBe(true);
    expect(compileFn).toHaveBeenCalled();

    // Verify serializeToYAML received the IR object from compileFn
    expect(serializeToYAML).toHaveBeenCalledWith({ name: 'Main', type: 'supervisor' });

    // Agent files should contain YAML-converted content
    const agentFiles = [...result.files.entries()].filter(([p]) => p.startsWith('agents/'));
    const mainFile = agentFiles.find(([p]) => p.includes('main'));
    expect(mainFile).toBeDefined();
    expect(mainFile![1]).toContain('# YAML converted');
  });

  it('should warn and keep original DSL when compileFn returns null', () => {
    const compileFn = vi.fn().mockReturnValue(null);
    const options: ExportOptions = { ...DEFAULT_OPTIONS, dslFormat: 'yaml', compileFn };
    const result = exportProject(makeProjectData(), options);
    expect(result.success).toBe(true);
    expect(result.warnings.some((w) => w.includes('Failed to compile agent'))).toBe(true);

    // Agent files should still contain original DSL
    const mainFile = [...result.files.entries()].find(([p]) => p.includes('main'));
    expect(mainFile).toBeDefined();
    expect(mainFile![1]).toBe(SUPERVISOR_DSL);
  });

  it('should export profile metadata when profiles map is present', () => {
    const profiles = new Map<string, string>();
    profiles.set(
      'Formal',
      `BEHAVIOR_PROFILE: Formal
PRIORITY: 10
WHEN: "channel == 'email'"
TONE: professional`,
    );

    const agentWithProfile = `AGENT: Worker
VERSION: "1.0"
GOAL: "Do work"
USE BEHAVIOR_PROFILE: Formal
COMPLETE:
  - WHEN: true
    RESPOND: "Done"`;

    const data = makeProjectData({
      agents: [
        {
          name: 'Main',
          description: 'Supervisor',
          dslContent: SUPERVISOR_DSL,
          ownerId: 'user-1',
          ownerTeamId: null,
          version: '1.0',
          status: 'active',
        },
        {
          name: 'Worker',
          description: 'Worker agent',
          dslContent: agentWithProfile,
          ownerId: 'user-2',
          ownerTeamId: null,
          version: '1.0',
          status: 'active',
        },
      ],
      profiles,
    });
    const result = exportProject(data, DEFAULT_OPTIONS);
    expect(result.success).toBe(true);
    expect(result.manifest.behavior_profiles).toBeDefined();
    expect(result.manifest.behavior_profiles!['Formal']).toBeDefined();
    expect(result.manifest.behavior_profiles!['Formal'].priority).toBe(10);
    expect(result.manifest.behavior_profiles!['Formal'].used_by).toContain('Worker');
  });

  it('should preserve hyphenated behavior profile names in manifest usage metadata', () => {
    const profiles = new Map<string, string>();
    profiles.set(
      'voice-optimized',
      `BEHAVIOR_PROFILE: voice-optimized
PRIORITY: 7
WHEN: "channel == 'voice'"`,
    );

    const agentWithProfile = `AGENT: Worker
VERSION: "1.0"
GOAL: "Do work"
USE BEHAVIOR_PROFILE: voice-optimized
COMPLETE:
  - WHEN: true
    RESPOND: "Done"`;

    const data = makeProjectData({
      agents: [
        {
          name: 'Worker',
          description: 'Worker agent',
          dslContent: agentWithProfile,
          ownerId: 'user-2',
          ownerTeamId: null,
          version: '1.0',
          status: 'active',
        },
      ],
      profiles,
    });

    const result = exportProject(data, DEFAULT_OPTIONS);
    expect(result.success).toBe(true);
    expect(result.manifest.behavior_profiles).toBeDefined();
    expect(result.manifest.behavior_profiles!['voice-optimized']).toBeDefined();
    expect(result.manifest.behavior_profiles!['voice-optimized'].used_by).toContain('Worker');
  });

  it('should use the same materialized profile paths in the v1 manifest and exported files', () => {
    const profiles = new Map<string, string>([
      ['Formal-Tone', 'BEHAVIOR_PROFILE: Formal-Tone\nPRIORITY: 10'],
      ['formal_tone', 'BEHAVIOR_PROFILE: formal_tone\nPRIORITY: 5'],
    ]);

    const result = exportProject(makeProjectData({ profiles }), DEFAULT_OPTIONS);

    expect(result.success).toBe(true);
    expect(result.files.get('behavior_profiles/formal_tone.behavior_profile.abl')).toContain(
      'BEHAVIOR_PROFILE: Formal-Tone',
    );
    expect(result.files.get('behavior_profiles/formal_tone_2.behavior_profile.abl')).toContain(
      'BEHAVIOR_PROFILE: formal_tone',
    );
    expect(result.manifest.behavior_profiles?.['Formal-Tone'].path).toBe(
      'behavior_profiles/formal_tone.behavior_profile.abl',
    );
    expect(result.manifest.behavior_profiles?.['formal_tone'].path).toBe(
      'behavior_profiles/formal_tone_2.behavior_profile.abl',
    );
  });
});

// ─── resolveLayers tests ─────────────────────────────────────────────────

describe('resolveLayers', () => {
  it('should return default layers when no layers are requested', () => {
    const layers = resolveLayers();
    expect(layers).toEqual([
      'core',
      'connections',
      'prompts',
      'guardrails',
      'workflows',
      'evals',
      'search',
      'channels',
      'vocabulary',
    ]);
  });

  it('should return default layers when empty array is passed', () => {
    const layers = resolveLayers([]);
    // Empty array triggers defaults
    expect(layers).toContain('core');
    expect(layers).toContain('connections');
  });

  it('should always include core even if not explicitly requested', () => {
    const layers = resolveLayers(['guardrails']);
    expect(layers).toContain('core');
    expect(layers).toContain('guardrails');
  });

  it('should respect explicit layer list', () => {
    const layers = resolveLayers(['core', 'evals', 'search']);
    expect(layers).toContain('core');
    expect(layers).toContain('evals');
    expect(layers).toContain('search');
    // Should not include layers not requested
    expect(layers).not.toContain('connections');
    expect(layers).not.toContain('guardrails');
  });
});

// ─── exportProjectV2 tests ───────────────────────────────────────────────

function makeMockAssembler(
  layer: LayerName,
  entityCount: number,
  files: Map<string, string> = new Map(),
  warnings: string[] = [],
  metadata?: LayerAssemblyResult['metadata'],
): LayerAssembler {
  return {
    layer,
    assemble: vi.fn(
      async (): Promise<LayerAssemblyResult> => ({
        layer,
        files,
        entityCount,
        warnings,
        ...(metadata ? { metadata } : {}),
      }),
    ),
    countEntities: vi.fn(async () => entityCount),
  };
}

function makeV2Options(overrides: Partial<ExportOptionsV2> = {}): ExportOptionsV2 {
  return {
    projectId: 'proj-1',
    userId: 'user-1',
    tenantId: 'tenant-1',
    format: 'folder',
    layers: ['core', 'connections'],
    ...overrides,
  };
}

function makeManifestMeta() {
  return {
    projectName: 'Test Project',
    projectSlug: 'test-project',
    projectDescription: 'A test project' as string | null,
    exportedBy: 'user-1',
    entryAgent: 'Main' as string | null,
    agents: [
      {
        name: 'Main',
        description: 'Supervisor' as string | null,
        ownerId: 'user-1' as string | null,
        ownerTeamId: null as string | null,
        version: '1.0' as string | null,
      },
    ],
    tools: [] as Array<{ name: string; ownerId: string | null }>,
    entityCounts: {} as Record<string, number>,
    requiredEnvVars: [] as string[],
    requiredConnectors: [] as string[],
    requiredMcpServers: [] as string[],
  };
}

describe('exportProjectV2', () => {
  it('should export with core and connections assemblers', async () => {
    const coreFiles = new Map([['agents/main.abl', SUPERVISOR_DSL]]);
    const connFiles = new Map([['connections/api.json', '{}']]);

    const assemblers = new Map<LayerName, LayerAssembler>([
      ['core', makeMockAssembler('core', 1, coreFiles)],
      ['connections', makeMockAssembler('connections', 1, connFiles)],
    ]);
    const deps: ExportV2Deps = {
      assemblers,
      agentData: [{ name: 'Main', version: '1.0', dslContent: SUPERVISOR_DSL, status: 'active' }],
      edges: [],
    };

    const result = await exportProjectV2(makeV2Options(), deps, makeManifestMeta());
    expect(result.success).toBe(true);
    expect(result.files.has('agents/main.abl')).toBe(true);
    expect(result.files.has('connections/api.json')).toBe(true);
    expect(result.files.has('project.json')).toBe(true);
    expect(result.files.has('abl.lock')).toBe(true);
  });

  it('should reject export when size limit is exceeded', async () => {
    // core limit is 1000 agents — exceed it
    const assemblers = new Map<LayerName, LayerAssembler>([
      ['core', makeMockAssembler('core', 1001)],
    ]);
    const deps: ExportV2Deps = { assemblers };

    const result = await exportProjectV2(
      makeV2Options({ layers: ['core'] }),
      deps,
      makeManifestMeta(),
    );
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('SIZE_LIMIT_EXCEEDED');
    expect(result.error?.message).toContain('core');
    expect(result.error?.message).toContain('1001');
  });

  it('should aggregate warnings from all assemblers', async () => {
    const assemblers = new Map<LayerName, LayerAssembler>([
      ['core', makeMockAssembler('core', 5, new Map(), ['Core warning 1'])],
      ['connections', makeMockAssembler('connections', 2, new Map(), ['Conn warning 1'])],
    ]);
    const deps: ExportV2Deps = { assemblers };

    const result = await exportProjectV2(makeV2Options(), deps, makeManifestMeta());
    expect(result.success).toBe(true);
    expect(result.warnings).toContain('Core warning 1');
    expect(result.warnings).toContain('Conn warning 1');
  });

  it('should reject explicit layers with no registered assembler', async () => {
    // Request core + connections but only provide core assembler
    const assemblers = new Map<LayerName, LayerAssembler>([
      ['core', makeMockAssembler('core', 1, new Map([['agents/a.abl', 'content']]))],
    ]);
    const deps: ExportV2Deps = { assemblers };

    const result = await exportProjectV2(makeV2Options(), deps, makeManifestMeta());
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('MISSING_LAYER_ASSEMBLER');
    expect(result.error?.message).toContain('connections');
  });

  it('should assemble wave 2 layers when requested', async () => {
    const guardrailFiles = new Map([['guardrails/policy.json', '{"rule": "no-pii"}']]);
    const assemblers = new Map<LayerName, LayerAssembler>([
      ['core', makeMockAssembler('core', 1, new Map())],
      ['guardrails', makeMockAssembler('guardrails', 1, guardrailFiles)],
    ]);
    const deps: ExportV2Deps = { assemblers };
    const options = makeV2Options({ layers: ['core', 'guardrails'] });

    const result = await exportProjectV2(options, deps, makeManifestMeta());
    expect(result.success).toBe(true);
    expect(result.files.has('guardrails/policy.json')).toBe(true);
  });

  it('should export prompt bundles through the prompts layer when requested', async () => {
    const promptFiles = new Map([
      [
        'prompts/support_prompt.prompt.json',
        JSON.stringify(
          {
            promptId: 'pl_prompt_1',
            name: 'Support Prompt',
            status: 'active',
            nextVersionNumber: 2,
            versions: [
              {
                versionId: 'plv_prompt_1_v1',
                versionNumber: 1,
                template: 'Hello {{name}}',
                variables: ['name'],
                status: 'active',
                sourceHash: 'hash-v1',
              },
            ],
          },
          null,
          2,
        ),
      ],
    ]);
    const assemblers = new Map<LayerName, LayerAssembler>([
      ['core', makeMockAssembler('core', 1, new Map())],
      ['prompts', makeMockAssembler('prompts', 1, promptFiles)],
    ]);
    const deps: ExportV2Deps = { assemblers };

    const result = await exportProjectV2(
      makeV2Options({ layers: ['core', 'prompts'] }),
      deps,
      makeManifestMeta(),
    );

    expect(result.success).toBe(true);
    expect(result.manifest.layers_included).toEqual(['core', 'prompts']);
    expect(result.files.get('prompts/support_prompt.prompt.json')).toContain(
      '"promptId": "pl_prompt_1"',
    );
    expect(result.lockfile.layer_hashes.prompts).toBeTruthy();
  });

  it('should pass guardrailFormat through to layer assembly context', async () => {
    const guardrailAssembler = makeMockAssembler('guardrails', 1, new Map());
    const assemblers = new Map<LayerName, LayerAssembler>([
      ['core', makeMockAssembler('core', 1, new Map())],
      ['guardrails', guardrailAssembler],
    ]);
    const deps: ExportV2Deps = { assemblers };

    const result = await exportProjectV2(
      makeV2Options({ layers: ['core', 'guardrails'], guardrailFormat: 'yaml' }),
      deps,
      makeManifestMeta(),
    );

    expect(result.success).toBe(true);
    expect(guardrailAssembler.assemble).toHaveBeenCalledWith(
      expect.objectContaining({ guardrailFormat: 'yaml' }),
    );
  });

  it('should use empty arrays for edges and agentData when not provided', async () => {
    const assemblers = new Map<LayerName, LayerAssembler>([
      ['core', makeMockAssembler('core', 0, new Map())],
    ]);
    const deps: ExportV2Deps = { assemblers };

    const result = await exportProjectV2(
      makeV2Options({ layers: ['core'] }),
      deps,
      makeManifestMeta(),
    );
    expect(result.success).toBe(true);
    expect(result.lockfile).toBeDefined();
    expect(result.manifest).toBeDefined();
  });

  it('should auto-detect entry agent from SUPERVISOR keyword when manifestMeta.entryAgent is null', async () => {
    const assemblers = new Map<LayerName, LayerAssembler>([
      ['core', makeMockAssembler('core', 1, new Map())],
    ]);
    const deps: ExportV2Deps = {
      assemblers,
      agentData: [
        { name: 'Main', version: '1.0', dslContent: SUPERVISOR_DSL, status: 'active' },
        { name: 'Worker', version: '1.0', dslContent: WORKER_DSL, status: 'active' },
      ],
    };
    const meta = { ...makeManifestMeta(), entryAgent: null };

    const result = await exportProjectV2(makeV2Options({ layers: ['core'] }), deps, meta);
    expect(result.success).toBe(true);
    expect(result.manifest.entry_agent).toBe('Main');
    expect(result.warnings.some((w) => w.includes('No entry agent detected'))).toBe(false);
  });

  it('should warn when no SUPERVISOR agent exists and manifestMeta.entryAgent is null', async () => {
    const assemblers = new Map<LayerName, LayerAssembler>([
      ['core', makeMockAssembler('core', 1, new Map())],
    ]);
    const deps: ExportV2Deps = {
      assemblers,
      agentData: [{ name: 'Worker', version: '1.0', dslContent: WORKER_DSL, status: 'active' }],
    };
    const meta = { ...makeManifestMeta(), entryAgent: null };

    const result = await exportProjectV2(makeV2Options({ layers: ['core'] }), deps, meta);
    expect(result.success).toBe(true);
    expect(result.warnings.some((w) => w.includes('No entry agent detected'))).toBe(true);
  });

  it('should use materialized profile paths from layer metadata in the v2 manifest', async () => {
    const coreFiles = new Map([
      ['behavior_profiles/formal_tone.behavior_profile.abl', 'BEHAVIOR_PROFILE: Formal-Tone'],
      ['behavior_profiles/formal_tone_2.behavior_profile.abl', 'BEHAVIOR_PROFILE: formal_tone'],
    ]);
    const assemblers = new Map<LayerName, LayerAssembler>([
      [
        'core',
        makeMockAssembler('core', 2, coreFiles, [], {
          profiles: [
            {
              name: 'Formal-Tone',
              path: 'behavior_profiles/formal_tone.behavior_profile.abl',
            },
            {
              name: 'formal_tone',
              path: 'behavior_profiles/formal_tone_2.behavior_profile.abl',
            },
          ],
        }),
      ],
    ]);
    const deps: ExportV2Deps = { assemblers };
    const meta = {
      ...makeManifestMeta(),
      profiles: [
        {
          name: 'Formal-Tone',
          priority: 10,
          whenSummary: 'channel == "email"',
          usedBy: ['Main'],
        },
        {
          name: 'formal_tone',
          priority: 5,
          whenSummary: 'channel == "sms"',
          usedBy: ['Main'],
        },
      ],
    };

    const result = await exportProjectV2(makeV2Options({ layers: ['core'] }), deps, meta);

    expect(result.success).toBe(true);
    expect(result.manifest.behavior_profiles?.['Formal-Tone'].path).toBe(
      'behavior_profiles/formal_tone.behavior_profile.abl',
    );
    expect(result.manifest.behavior_profiles?.['formal_tone'].path).toBe(
      'behavior_profiles/formal_tone_2.behavior_profile.abl',
    );
  });

  it('should change v2 lockfile agent hashes when only companion metadata changes', async () => {
    const assemblers = new Map<LayerName, LayerAssembler>([
      ['core', makeMockAssembler('core', 1, new Map([['agents/main.abl', SUPERVISOR_DSL]]))],
    ]);

    const withoutPromptRef = await exportProjectV2(
      makeV2Options({ layers: ['core'] }),
      {
        assemblers,
        agentData: [
          {
            name: 'Main',
            version: '1.0',
            dslContent: SUPERVISOR_DSL,
            status: 'active',
          },
        ],
      },
      makeManifestMeta(),
    );
    const withPromptRef = await exportProjectV2(
      makeV2Options({ layers: ['core'] }),
      {
        assemblers,
        agentData: [
          {
            name: 'Main',
            version: '1.0',
            dslContent: SUPERVISOR_DSL,
            status: 'active',
            systemPromptLibraryRef: {
              promptId: 'prompt-1',
              versionId: 'version-1',
              resolvedHash: 'prompt-hash-1',
            },
          } as NonNullable<ExportV2Deps['agentData']>[number],
        ],
      },
      makeManifestMeta(),
    );

    expect(withPromptRef.lockfile.agents['Main'].source_hash).not.toBe(
      withoutPromptRef.lockfile.agents['Main'].source_hash,
    );
  });
});
