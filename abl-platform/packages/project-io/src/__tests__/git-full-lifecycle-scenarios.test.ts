import { describe, expect, it, vi } from 'vitest';
import { resolveLayers, resolveLayersForToolDependencies } from '../export/project-exporter.js';
import { previewCoreImportV2 } from '../import/core-direct-apply-orchestrator.js';
import type { CoreImportSnapshotStateV2 } from '../import/core-direct-apply-orchestrator.js';
import type { LayerName } from '../types.js';

const PROJECT_ID = 'project-1';
const TENANT_ID = 'tenant-1';
const USER_ID = 'user-1';

interface LayerRoundTripScenario {
  name: string;
  requestedLayers?: LayerName[];
  toolData?: Array<{ dslContent: string; toolType?: string | null }>;
}

function buildProjectJson(layers: LayerName[]) {
  return JSON.stringify({
    format_version: '2.0',
    layers_included: layers,
  });
}

function filesForLayer(layer: LayerName): Array<[string, string]> {
  switch (layer) {
    case 'core':
      return [['agents/SupportAgent.agent.abl', 'AGENT: SupportAgent\nGOAL: Support users\n']];
    case 'connections':
      return [['connections/support.connection.json', JSON.stringify({ name: 'support' })]];
    case 'prompts':
      return [
        [
          'prompts/support.prompt.json',
          JSON.stringify({
            promptId: 'prompt-support',
            name: 'support',
            tags: [],
            status: 'active',
            nextVersionNumber: 1,
            versions: [],
          }),
        ],
      ];
    case 'guardrails':
      return [['guardrails/pii.guardrail.json', JSON.stringify({ name: 'pii', rules: [] })]];
    case 'workflows':
      return [['workflows/support.workflow.json', JSON.stringify({ name: 'support' })]];
    case 'evals':
      return [['evals/smoke.eval.json', JSON.stringify({ name: 'smoke' })]];
    case 'search':
      return [['search/support-index.search.json', JSON.stringify({ name: 'support-index' })]];
    case 'channels':
      return [['channels/web.channel.json', JSON.stringify({ name: 'web' })]];
    case 'vocabulary':
      return [['vocabulary/facts.json', JSON.stringify([])]];
  }
}

async function previewGitRoundTrip(layers: LayerName[]) {
  const currentState: CoreImportSnapshotStateV2 = {
    agents: [],
    tools: [],
    entryAgentName: null,
  };
  const files = new Map<string, string>([
    ['project.json', buildProjectJson(layers)],
    ...layers.flatMap(filesForLayer),
  ]);

  return previewCoreImportV2({
    files,
    planOptions: {
      projectId: PROJECT_ID,
      tenantId: TENANT_ID,
      userId: USER_ID,
      deleteUnmatched: false,
      layers,
      validateToolBindingForSave: vi.fn().mockResolvedValue({ valid: true }),
      validateRuntimeConfigForSave: vi.fn().mockResolvedValue({ valid: true }),
    },
    stateStore: {
      loadCurrentState: vi.fn().mockResolvedValue(currentState),
    },
  });
}

const scenarios: LayerRoundTripScenario[] = [
  {
    name: 'default Git push layers are importable by Git pull',
  },
  {
    name: 'search tools expand to a pull-importable search layer',
    toolData: [{ toolType: 'searchai', dslContent: 'type: searchai\n' }],
  },
  {
    name: 'workflow tools expand to a pull-importable workflows layer',
    toolData: [{ toolType: 'workflow', dslContent: 'type: workflow\n' }],
  },
  {
    name: 'all project object layers are pull-importable',
    requestedLayers: [
      'core',
      'connections',
      'prompts',
      'guardrails',
      'workflows',
      'evals',
      'search',
      'channels',
      'vocabulary',
    ],
  },
];

describe('Git full lifecycle layer scenarios', () => {
  it('current core, prompts, and evals layers remain pull-importable', async () => {
    const result = await previewGitRoundTrip(['core', 'prompts', 'evals']);

    expect(result).toEqual(
      expect.objectContaining({
        success: true,
        preview: expect.objectContaining({
          hasBlockingIssues: false,
        }),
      }),
    );
  });

  it('malformed supported layer files fail fast before any partial write plan is executable', async () => {
    const result = await previewCoreImportV2({
      files: new Map<string, string>([
        ['project.json', buildProjectJson(['core', 'prompts'])],
        ['agents/SupportAgent.agent.abl', 'AGENT: SupportAgent\nGOAL: Support users\n'],
        ['prompts/broken.prompt.json', '{not-json'],
      ]),
      planOptions: {
        projectId: PROJECT_ID,
        tenantId: TENANT_ID,
        userId: USER_ID,
        deleteUnmatched: false,
        layers: ['core', 'prompts'],
        validateToolBindingForSave: vi.fn().mockResolvedValue({ valid: true }),
        validateRuntimeConfigForSave: vi.fn().mockResolvedValue({ valid: true }),
      },
      stateStore: {
        loadCurrentState: vi.fn().mockResolvedValue({
          agents: [],
          tools: [],
          entryAgentName: null,
        } satisfies CoreImportSnapshotStateV2),
      },
    });

    expect(result).toEqual(
      expect.objectContaining({
        success: false,
        error: expect.objectContaining({
          code: 'INVALID_PROMPT_BUNDLE',
        }),
      }),
    );
    expect(result).not.toHaveProperty('plan');
  });

  it.each([
    ['parent traversal agent path', '../agents/Escape.agent.abl'],
    ['nested traversal prompt path', 'prompts/../../secrets.env'],
    ['absolute workflow path', '/workflows/escape.workflow.json'],
  ])('rejects unsafe pulled file paths before planning apply: %s', async (_name, filePath) => {
    const result = await previewCoreImportV2({
      files: new Map<string, string>([
        ['project.json', buildProjectJson(['core'])],
        [filePath, 'AGENT: Escape\nGOAL: Escape sync root\n'],
      ]),
      planOptions: {
        projectId: PROJECT_ID,
        tenantId: TENANT_ID,
        userId: USER_ID,
        deleteUnmatched: false,
        layers: ['core'],
        validateToolBindingForSave: vi.fn().mockResolvedValue({ valid: true }),
        validateRuntimeConfigForSave: vi.fn().mockResolvedValue({ valid: true }),
      },
      stateStore: {
        loadCurrentState: vi.fn().mockResolvedValue({
          agents: [],
          tools: [],
          entryAgentName: null,
        } satisfies CoreImportSnapshotStateV2),
      },
    });

    expect(result).toEqual(
      expect.objectContaining({
        success: false,
        error: expect.objectContaining({
          code: 'UNSAFE_IMPORT_PATH',
        }),
      }),
    );
    expect(result).not.toHaveProperty('plan');
  });

  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      const layers = resolveLayersForToolDependencies(
        resolveLayers(scenario.requestedLayers),
        scenario.toolData ?? [],
      );

      const result = await previewGitRoundTrip(layers);

      expect(result).toEqual(
        expect.objectContaining({
          success: true,
          preview: expect.objectContaining({
            hasBlockingIssues: false,
          }),
        }),
      );
    });
  }
});
