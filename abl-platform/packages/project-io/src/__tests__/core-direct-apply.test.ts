import { describe, expect, it, vi } from 'vitest';
import type { ImportPreviewV2 } from '../types.js';
import { computeProjectAgentDraftSourceHash } from '../project-agent-draft-metadata.js';
import type { ProjectIOPromptLibraryBundle } from '../prompt-library-io.js';
import {
  buildCoreImportApplyPlanV2,
  executeCoreImportApplyPlanV2,
  type CoreImportApplyAdapterV2,
  type CoreImportApplyPlanV2,
} from '../import/core-direct-apply.js';
import type { ExistingProjectStateV2 } from '../import/project-importer-v2.js';

const PROJECT_ID = 'proj-test-1';
const TENANT_ID = 'tenant-test-1';
const USER_ID = 'user-test-1';

function buildManifest(input: {
  agentFiles: string[];
  toolFiles?: string[];
  behaviorProfilePaths?: Record<string, string>;
  requiredMcpServers?: string[];
  entryAgent?: string | null;
  layers?: string[];
  agentManifestOverrides?: Record<string, Record<string, unknown>>;
}): string {
  const {
    agentFiles,
    toolFiles = [],
    behaviorProfilePaths = {},
    requiredMcpServers = [],
    entryAgent = agentFiles[0] ?? null,
    layers = ['core'],
    agentManifestOverrides = {},
  } = input;

  return JSON.stringify({
    format_version: '2.0',
    name: 'Test Project',
    slug: 'test-project',
    description: null,
    abl_version: '2.0',
    exported_at: '2026-01-01T00:00:00Z',
    exported_by: USER_ID,
    entry_agent: entryAgent,
    dsl_format: 'legacy',
    layers_included: layers,
    agents: Object.fromEntries(
      agentFiles.map((agentName) => [
        agentName,
        {
          path: `agents/${agentName}.agent.abl`,
          owner: null,
          ownerTeam: null,
          description: null,
          version: null,
          ...agentManifestOverrides[agentName],
        },
      ]),
    ),
    tools: Object.fromEntries(
      toolFiles.map((toolName) => [
        toolName,
        {
          path: `tools/${toolName}.tools.abl`,
          owner: null,
        },
      ]),
    ),
    behavior_profiles: Object.fromEntries(
      Object.entries(behaviorProfilePaths).map(([profileName, path]) => [
        profileName,
        {
          name: profileName,
          path,
          owner: null,
        },
      ]),
    ),
    metadata: {
      entity_counts: {
        agents: agentFiles.length,
        tools: toolFiles.length,
        behavior_profiles: Object.keys(behaviorProfilePaths).length,
      },
      required_env_vars: [],
      required_connectors: [],
      required_mcp_servers: requiredMcpServers,
    },
  });
}

function buildExistingState(input?: {
  agents?: Array<{
    name: string;
    dslContent: string | null;
    systemPromptLibraryRef?: { promptId: string; versionId: string; resolvedHash?: string } | null;
  }>;
  prompts?: ProjectIOPromptLibraryBundle[];
  tools?: Array<{ name: string; dslContent: string }>;
  localeFiles?: Array<{ filePath: string; value: string }>;
  profileFiles?: Array<{ filePath: string; value: string }>;
  runtimeConfig?: Record<string, unknown> | null;
  llmConfig?: Record<string, unknown> | null;
  projectModelConfigs?: Array<{ name: string; data: Record<string, unknown> }>;
  agentModelConfigs?: Array<{ agentName: string; data: Record<string, unknown> }>;
  mcpServers?: Array<{
    name: string;
    description: string | null;
    transport: 'http' | 'sse';
    url: string | null;
    authType: 'none' | 'bearer' | 'api_key' | 'custom_headers' | 'oauth2_client_credentials';
    priority: number;
    tags: string | null;
    connectionTimeoutMs: number;
    requestTimeoutMs: number;
    autoReconnect: boolean;
    maxReconnectAttempts: number;
    lastConnectionStatus: 'connected' | 'failed' | 'untested' | null;
  }>;
}): ExistingProjectStateV2 {
  return {
    agents: new Map(
      (input?.agents ?? []).map((agent) => [
        agent.name,
        {
          name: agent.name,
          dslContent: agent.dslContent,
          systemPromptLibraryRef: agent.systemPromptLibraryRef ?? null,
        },
      ]),
    ),
    prompts: new Map((input?.prompts ?? []).map((prompt) => [prompt.promptId, prompt])),
    toolFiles: new Map(),
    tools: new Map(
      (input?.tools ?? []).map((tool) => [
        tool.name,
        { name: tool.name, dslContent: tool.dslContent },
      ]),
    ),
    mcpServers: new Map(
      (input?.mcpServers ?? []).map((server) => [
        server.name,
        { name: server.name, config: server },
      ]),
    ),
    localeFiles: new Map(
      (input?.localeFiles ?? []).map((locale) => [locale.filePath, locale.value]),
    ),
    profileFiles: new Map(
      (input?.profileFiles ?? []).map((profile) => [profile.filePath, profile.value]),
    ),
    runtimeConfig: input?.runtimeConfig,
    llmConfig: input?.llmConfig,
    projectModelConfigs: new Map(
      (input?.projectModelConfigs ?? []).map((config) => [config.name, config]),
    ),
    agentModelConfigs: new Map(
      (input?.agentModelConfigs ?? []).map((config) => [config.agentName, config]),
    ),
    activeRecords: new Map(),
  };
}

function buildPreview(overrides: Partial<ImportPreviewV2> = {}): ImportPreviewV2 {
  return {
    valid: true,
    formatVersion: '2.0',
    layers: ['core'],
    layerChanges: {
      core: { added: 0, modified: 0, removed: 0, unchanged: 0 },
    },
    agentChanges: { added: [], modified: [], removed: [], unchanged: [] },
    toolChanges: { added: [], modified: [], removed: [] },
    shaIntegrity: {
      valid: true,
      integrityMatch: true,
      layerResults: {},
      errors: [],
      warnings: [],
    },
    crossLayerDeps: {
      valid: true,
      missingDependencies: [],
      warnings: [],
    },
    syntaxErrors: [],
    issues: [],
    hasBlockingIssues: false,
    requiresAcknowledgement: false,
    blockingIssueCount: 0,
    nonBlockingIssueCount: 0,
    entryAgentResolution: {
      requested: null,
      resolved: null,
      matchedBy: 'none',
    },
    warnings: [],
    ...overrides,
  };
}

function buildPromptBundle(
  overrides: Partial<ProjectIOPromptLibraryBundle> = {},
): ProjectIOPromptLibraryBundle {
  return {
    promptId: 'pl_prompt_1',
    name: 'Support Prompt',
    description: 'Guidance for support responses',
    tags: ['support'],
    status: 'active',
    nextVersionNumber: 2,
    versions: [
      {
        versionId: 'plv_prompt_1',
        versionNumber: 1,
        template: 'Answer politely.',
        variables: ['customer_name'],
        description: 'Active support prompt',
        status: 'active',
        sourceHash: 'prompt-version-hash-1',
        metadata: { tone: 'friendly' },
      },
    ],
    ...overrides,
  };
}

describe('buildCoreImportApplyPlanV2', () => {
  it('accepts a loose top-level .abl agent upload and plans it as a core agent import', async () => {
    const looseAgentDsl = `AGENT: LooseImport
GOAL: Accept standalone .abl uploads
`;

    const files = new Map<string, string>([['LooseImport.abl', looseAgentDsl]]);

    const result = await buildCoreImportApplyPlanV2(files, buildExistingState(), {
      projectId: PROJECT_ID,
      tenantId: TENANT_ID,
      userId: USER_ID,
      deleteUnmatched: false,
    });

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }

    expect(result.plan.agentOperations).toEqual([
      expect.objectContaining({
        type: 'create',
        agentName: 'LooseImport',
        dslContent: looseAgentDsl,
      }),
    ]);
    expect(result.plan.preview.agentChanges.added).toEqual(['LooseImport']);
    expect(result.plan.entryAgentName).toBe('LooseImport');
  });

  it('computes companion-aware sourceHash values for prompt-ref-only agent updates', async () => {
    const dslContent = `AGENT: Main
GOAL: "Help users"
`;

    const files = new Map<string, string>([
      [
        'project.json',
        buildManifest({
          agentFiles: ['Main'],
          agentManifestOverrides: {
            Main: {
              systemPromptLibraryRef: {
                promptId: 'prompt-1',
                versionId: 'version-2',
              },
            },
          },
        }),
      ],
      ['agents/Main.agent.abl', dslContent],
    ]);

    const result = await buildCoreImportApplyPlanV2(
      files,
      buildExistingState({
        agents: [
          {
            name: 'Main',
            dslContent,
            systemPromptLibraryRef: {
              promptId: 'prompt-1',
              versionId: 'version-1',
            },
          },
        ],
        prompts: [
          buildPromptBundle({
            promptId: 'prompt-1',
            versions: [
              {
                versionId: 'version-1',
                versionNumber: 1,
                template: 'Answer politely.',
                variables: [],
                description: 'Current prompt',
                status: 'active',
                sourceHash: 'prompt-version-hash-1',
              },
              {
                versionId: 'version-2',
                versionNumber: 2,
                template: 'Answer with deeper context.',
                variables: [],
                description: 'Updated prompt',
                status: 'active',
                sourceHash: 'prompt-version-hash-2',
              },
            ],
          }),
        ],
      }),
      {
        projectId: PROJECT_ID,
        tenantId: TENANT_ID,
        userId: USER_ID,
        deleteUnmatched: false,
      },
    );

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }

    expect(result.plan.agentOperations).toEqual([
      expect.objectContaining({
        type: 'update',
        agentName: 'Main',
        dslContent,
        systemPromptLibraryRef: {
          promptId: 'prompt-1',
          versionId: 'version-2',
        },
        sourceHash: computeProjectAgentDraftSourceHash({
          recordName: 'Main',
          dslContent,
          systemPromptLibraryRef: {
            promptId: 'prompt-1',
            versionId: 'version-2',
          },
        }),
      }),
    ]);
  });

  it('rejects imported agent prompt refs when the destination prompt version is unavailable', async () => {
    const dslContent = `AGENT: Main
GOAL: "Help users"
`;
    const files = new Map<string, string>([
      [
        'project.json',
        buildManifest({
          agentFiles: ['Main'],
          agentManifestOverrides: {
            Main: {
              systemPromptLibraryRef: {
                promptId: 'missing-prompt',
                versionId: 'missing-version',
              },
            },
          },
        }),
      ],
      ['agents/Main.agent.abl', dslContent],
    ]);

    const result = await buildCoreImportApplyPlanV2(files, buildExistingState(), {
      projectId: PROJECT_ID,
      tenantId: TENANT_ID,
      userId: USER_ID,
      deleteUnmatched: false,
    });

    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }
    expect(result.error).toEqual({
      code: 'INVALID_PROMPT_LIBRARY_REFERENCE',
      message: expect.stringContaining('Main'),
    });
  });

  it('accepts imported agent prompt refs when the prompts layer creates the referenced version', async () => {
    const dslContent = `AGENT: Main
GOAL: "Help users"
`;
    const promptBundle = buildPromptBundle({
      promptId: 'prompt-1',
      versions: [
        {
          versionId: 'version-1',
          versionNumber: 1,
          template: 'Answer politely.',
          variables: [],
          description: 'Active prompt',
          status: 'active',
          sourceHash: 'prompt-version-hash-1',
        },
      ],
    });
    const files = new Map<string, string>([
      [
        'project.json',
        buildManifest({
          agentFiles: ['Main'],
          layers: ['core', 'prompts'],
          agentManifestOverrides: {
            Main: {
              systemPromptLibraryRef: {
                promptId: 'prompt-1',
                versionId: 'version-1',
              },
            },
          },
        }),
      ],
      ['agents/Main.agent.abl', dslContent],
      ['prompts/support_prompt.prompt.json', JSON.stringify(promptBundle, null, 2)],
    ]);

    const result = await buildCoreImportApplyPlanV2(files, buildExistingState(), {
      projectId: PROJECT_ID,
      tenantId: TENANT_ID,
      userId: USER_ID,
      deleteUnmatched: false,
      layers: ['core', 'prompts'],
    });

    expect(result.success).toBe(true);
  });

  it('rejects deleteUnmatched prompt imports that would leave existing agents with dangling prompt refs', async () => {
    const promptBundle = buildPromptBundle({
      promptId: 'prompt-1',
      versions: [
        {
          versionId: 'version-1',
          versionNumber: 1,
          template: 'Answer politely.',
          variables: [],
          description: 'Active prompt',
          status: 'active',
          sourceHash: 'prompt-version-hash-1',
        },
      ],
    });
    const files = new Map<string, string>([
      [
        'project.json',
        buildManifest({ agentFiles: [], toolFiles: [], entryAgent: null, layers: ['prompts'] }),
      ],
    ]);

    const result = await buildCoreImportApplyPlanV2(
      files,
      buildExistingState({
        agents: [
          {
            name: 'Main',
            dslContent: 'AGENT: Main\nGOAL: "Help users"\n',
            systemPromptLibraryRef: {
              promptId: 'prompt-1',
              versionId: 'version-1',
            },
          },
        ],
        prompts: [promptBundle],
      }),
      {
        projectId: PROJECT_ID,
        tenantId: TENANT_ID,
        userId: USER_ID,
        deleteUnmatched: true,
        layers: ['prompts'],
      },
    );

    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }
    expect(result.error.code).toBe('INVALID_PROMPT_LIBRARY_REFERENCE');
    expect(result.error.message).toContain('Main');
  });

  it('builds locale create operations for locale-only imports', async () => {
    const localeValue = JSON.stringify(
      {
        messages: {
          conversation_complete: 'Conversation terminee.',
        },
      },
      null,
      2,
    );

    const files = new Map<string, string>([
      ['project.json', buildManifest({ agentFiles: [], toolFiles: [], entryAgent: null })],
      ['locales/fr/messages.json', localeValue],
    ]);

    const result = await buildCoreImportApplyPlanV2(files, buildExistingState(), {
      projectId: PROJECT_ID,
      tenantId: TENANT_ID,
      userId: USER_ID,
      deleteUnmatched: false,
    });

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }

    expect(result.plan.localeOperations).toEqual([
      expect.objectContaining({
        type: 'create',
        relativePath: 'fr/messages.json',
        filePath: 'locales/fr/messages.json',
        value: localeValue,
      }),
    ]);
    expect(result.plan.preview.localeChanges).toEqual({
      added: ['locales/fr/messages.json'],
      modified: [],
      removed: [],
    });
    expect(result.plan.applied.localesCreated).toBe(1);
    expect(result.plan.entryAgentName).toBeNull();
  });

  it('builds profile create operations for behavior-profile imports', async () => {
    const profileDsl = `BEHAVIOR_PROFILE: voice_vip
PRIORITY: 5
WHEN: channel == "voice"
`;

    const files = new Map<string, string>([
      ['project.json', buildManifest({ agentFiles: [], toolFiles: [], entryAgent: null })],
      ['behavior_profiles/voice_vip.behavior_profile.abl', profileDsl],
    ]);

    const result = await buildCoreImportApplyPlanV2(files, buildExistingState(), {
      projectId: PROJECT_ID,
      tenantId: TENANT_ID,
      userId: USER_ID,
      deleteUnmatched: false,
    });

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }

    expect(result.plan.profileOperations).toEqual([
      expect.objectContaining({
        type: 'create',
        profileName: 'voice_vip',
        filePath: 'behavior_profiles/voice_vip.behavior_profile.abl',
        dslContent: profileDsl,
      }),
    ]);
    expect(result.plan.preview.profileChanges).toEqual({
      added: ['behavior_profiles/voice_vip.behavior_profile.abl'],
      modified: [],
      removed: [],
    });
    expect(result.plan.applied.profilesCreated).toBe(1);
  });

  it('builds profile create operations from manifest-declared profile paths', async () => {
    const profileDsl = `BEHAVIOR_PROFILE: voice_vip
PRIORITY: 5
WHEN: channel == "voice"
`;
    const profilePath = 'behavior_profiles/voice_vip.profile.abl';

    const files = new Map<string, string>([
      [
        'project.json',
        buildManifest({
          agentFiles: [],
          toolFiles: [],
          behaviorProfilePaths: { voice_vip: profilePath },
          entryAgent: null,
        }),
      ],
      [profilePath, profileDsl],
    ]);

    const result = await buildCoreImportApplyPlanV2(files, buildExistingState(), {
      projectId: PROJECT_ID,
      tenantId: TENANT_ID,
      userId: USER_ID,
      deleteUnmatched: false,
    });

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }

    expect(result.plan.profileOperations).toEqual([
      expect.objectContaining({
        type: 'create',
        profileName: 'voice_vip',
        filePath: profilePath,
        sourceFile: profilePath,
        dslContent: profileDsl,
      }),
    ]);
    expect(result.plan.preview.profileChanges).toEqual({
      added: [profilePath],
      modified: [],
      removed: [],
    });
    expect(result.plan.applied.profilesCreated).toBe(1);
  });

  it('builds prompt create operations for prompt-layer imports', async () => {
    const promptBundle = buildPromptBundle();
    const files = new Map<string, string>([
      [
        'project.json',
        buildManifest({ agentFiles: [], toolFiles: [], entryAgent: null, layers: ['prompts'] }),
      ],
      ['prompts/support_prompt.prompt.json', JSON.stringify(promptBundle, null, 2)],
    ]);

    const result = await buildCoreImportApplyPlanV2(files, buildExistingState(), {
      projectId: PROJECT_ID,
      tenantId: TENANT_ID,
      userId: USER_ID,
      deleteUnmatched: false,
      layers: ['prompts'],
    });

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }

    expect(result.plan.promptOperations).toEqual([
      expect.objectContaining({
        type: 'create',
        promptId: 'pl_prompt_1',
        promptName: 'Support Prompt',
        bundle: promptBundle,
        sourceFile: 'prompts/support_prompt.prompt.json',
      }),
    ]);
    expect(result.plan.preview.layerChanges.prompts).toEqual({
      added: 1,
      modified: 0,
      removed: 0,
      unchanged: 0,
    });
    expect(result.plan.applied.promptsCreated).toBe(1);
  });

  it('builds prompt delete operations for prompt-only empty imports when deleteUnmatched is true', async () => {
    const files = new Map<string, string>([
      [
        'project.json',
        buildManifest({ agentFiles: [], toolFiles: [], entryAgent: null, layers: ['prompts'] }),
      ],
    ]);

    const result = await buildCoreImportApplyPlanV2(
      files,
      buildExistingState({
        prompts: [buildPromptBundle()],
      }),
      {
        projectId: PROJECT_ID,
        tenantId: TENANT_ID,
        userId: USER_ID,
        deleteUnmatched: true,
        layers: ['prompts'],
      },
    );

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }

    expect(result.plan.promptOperations).toEqual([
      expect.objectContaining({
        type: 'delete',
        promptId: 'pl_prompt_1',
        promptName: 'Support Prompt',
      }),
    ]);
    expect(result.plan.preview.layerChanges.prompts).toEqual({
      added: 0,
      modified: 0,
      removed: 1,
      unchanged: 0,
    });
    expect(result.plan.applied.promptsDeleted).toBe(1);
  });

  it('builds eval create operations for eval-layer imports', async () => {
    const files = new Map<string, string>([
      ['project.json', buildManifest({ agentFiles: [], toolFiles: [], entryAgent: null })],
      [
        'evals/smoke/eval-set.json',
        JSON.stringify(
          {
            name: 'Smoke Eval',
            description: 'Imported smoke eval',
            variants: 1,
            maxConcurrency: 1,
            ciEnabled: false,
          },
          null,
          2,
        ),
      ],
      [
        'evals/smoke/scenarios/greeting.scenario.json',
        JSON.stringify(
          {
            name: 'Greeting Scenario',
            difficulty: 'easy',
            initialMessage: 'Hello',
            maxTurns: 3,
            tags: [],
            agentPath: ['Main'],
            expectedMilestones: [],
          },
          null,
          2,
        ),
      ],
      [
        'evals/smoke/personas/friendly.persona.json',
        JSON.stringify(
          {
            name: 'Friendly Persona',
            communicationStyle: 'casual',
            domainKnowledge: 'beginner',
            behaviorTraits: ['friendly'],
            goals: 'Get help',
            constraints: '',
            source: 'custom',
            isAdversarial: false,
            isBuiltIn: false,
          },
          null,
          2,
        ),
      ],
      [
        'evals/evaluators/quality.evaluator.json',
        JSON.stringify(
          {
            _exportedId: 'old-evaluator-1',
            name: 'Quality Judge',
            type: 'llm_judge',
            category: 'quality',
            chainOfThought: true,
            temperature: 0,
            biasSettings: {},
            isBuiltIn: false,
          },
          null,
          2,
        ),
      ],
    ]);
    const set = JSON.parse(files.get('evals/smoke/eval-set.json')!);
    set.evaluatorIds = ['old-evaluator-1'];
    files.set('evals/smoke/eval-set.json', JSON.stringify(set, null, 2));

    const result = await buildCoreImportApplyPlanV2(files, buildExistingState(), {
      projectId: PROJECT_ID,
      tenantId: TENANT_ID,
      userId: USER_ID,
      deleteUnmatched: false,
    });

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }

    expect(result.plan.evalOperations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'create',
          collection: 'eval_scenarios',
          name: 'Greeting Scenario',
        }),
        expect.objectContaining({
          type: 'create',
          collection: 'eval_personas',
          name: 'Friendly Persona',
        }),
        expect.objectContaining({
          type: 'create',
          collection: 'eval_evaluators',
          name: 'Quality Judge',
        }),
        expect.objectContaining({
          type: 'create',
          collection: 'eval_sets',
          name: 'Smoke Eval',
          scenarioNames: ['Greeting Scenario'],
          personaNames: ['Friendly Persona'],
          evaluatorNames: ['Quality Judge'],
        }),
      ]),
    );
    expect(result.plan.applied.evalsCreated).toBe(4);
    expect(result.plan.preview.layerChanges.evals).toEqual({
      added: 4,
      modified: 0,
      removed: 0,
      unchanged: 0,
    });
  });

  it('builds delete-only plans for empty project snapshots when deleteUnmatched is true', async () => {
    const files = new Map<string, string>([
      ['project.json', buildManifest({ agentFiles: [], toolFiles: [], entryAgent: null })],
    ]);

    const result = await buildCoreImportApplyPlanV2(
      files,
      buildExistingState({
        agents: [{ name: 'Legacy', dslContent: 'AGENT: Legacy\nGOAL: Legacy flow\n' }],
        tools: [{ name: 'orphan_tool', dslContent: 'orphan_tool() -> {ok: boolean}\n' }],
        projectModelConfigs: [
          {
            name: 'Legacy Voice',
            data: {
              name: 'Legacy Voice',
              modelId: 'gpt-realtime-legacy',
              provider: 'openai',
              tier: 'voice',
            },
          },
        ],
        localeFiles: [
          {
            filePath: 'locales/fr/messages.json',
            value: JSON.stringify({ messages: { out_of_scope: 'Hors champ' } }, null, 2),
          },
        ],
      }),
      {
        projectId: PROJECT_ID,
        tenantId: TENANT_ID,
        userId: USER_ID,
        deleteUnmatched: true,
      },
    );

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }

    expect(result.plan.agentOperations).toEqual([
      expect.objectContaining({
        type: 'delete',
        agentName: 'Legacy',
      }),
    ]);
    expect(result.plan.toolOperations).toEqual([
      expect.objectContaining({
        type: 'delete',
        toolName: 'orphan_tool',
      }),
    ]);
    expect(result.plan.localeOperations).toEqual([
      expect.objectContaining({
        type: 'delete',
        relativePath: 'fr/messages.json',
        filePath: 'locales/fr/messages.json',
      }),
    ]);
    expect(result.plan.modelPolicyOperations).toEqual([
      expect.objectContaining({
        type: 'delete',
        configType: 'project_model',
        modelConfigName: 'Legacy Voice',
      }),
    ]);
    expect(result.plan.preview.agentChanges.removed).toEqual(['Legacy']);
    expect(result.plan.preview.toolChanges.removed).toEqual(['orphan_tool']);
    expect(result.plan.preview.localeChanges).toEqual({
      added: [],
      modified: [],
      removed: ['locales/fr/messages.json'],
    });
    expect(result.plan.preview.layerChanges.core?.removed).toBe(4);
    expect(result.plan.entryAgentName).toBeNull();
  });

  it('plans runtime, LLM, and agent model config upserts from exported config files', async () => {
    const runtimeConfig = {
      operationTierOverrides: { response_gen: 'powerful' },
      extraction: { nlu_provider: 'native' },
    };
    const llmConfig = {
      operationTierOverrides: { response_gen: 'powerful' },
    };
    const agentModelConfig = {
      agentName: 'Main',
      defaultModel: 'gpt-4o-mini',
      operationModels: { response_gen: 'gpt-4o' },
      temperature: 0.2,
    };
    const projectModelConfig = {
      name: 'GPT-4o Realtime Preview (2025-06-03)',
      modelId: 'gpt-4o-realtime-preview-2025-06-03',
      provider: 'openai',
      tenantModelId: 'tm-voice',
      tier: 'voice',
      isDefault: true,
      priority: 10,
      supportsStreaming: true,
      hyperParameters: { enableThinking: true, thinkingBudget: 4096 },
    };
    const portableProjectModelConfig = {
      name: 'GPT-4o Realtime Preview (2025-06-03)',
      modelId: 'gpt-4o-realtime-preview-2025-06-03',
      provider: 'openai',
      tier: 'voice',
      isDefault: true,
      priority: 10,
      supportsStreaming: true,
      hyperParameters: { enableThinking: true, thinkingBudget: 4096 },
    };

    const files = new Map<string, string>([
      ['project.json', buildManifest({ agentFiles: [], toolFiles: [], entryAgent: null })],
      ['config/runtime-config.json', JSON.stringify(runtimeConfig, null, 2)],
      ['config/llm-config.json', JSON.stringify(llmConfig, null, 2)],
      [
        'config/project-model-configs/gpt-4o-realtime-preview.model-config.json',
        JSON.stringify(projectModelConfig, null, 2),
      ],
      [
        'config/agent-model-configs/Main.model-config.json',
        JSON.stringify(agentModelConfig, null, 2),
      ],
    ]);

    const result = await buildCoreImportApplyPlanV2(files, buildExistingState(), {
      projectId: PROJECT_ID,
      tenantId: TENANT_ID,
      userId: USER_ID,
      deleteUnmatched: false,
    });

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }

    expect(result.plan.modelPolicyOperations).toEqual([
      expect.objectContaining({
        type: 'upsert',
        configType: 'runtime',
        sourceFile: 'config/runtime-config.json',
        data: runtimeConfig,
      }),
      expect.objectContaining({
        type: 'upsert',
        configType: 'llm',
        sourceFile: 'config/llm-config.json',
        data: llmConfig,
      }),
      expect.objectContaining({
        type: 'upsert',
        configType: 'project_model',
        modelConfigName: 'GPT-4o Realtime Preview (2025-06-03)',
        sourceFile: 'config/project-model-configs/gpt-4o-realtime-preview.model-config.json',
        data: portableProjectModelConfig,
      }),
      expect.objectContaining({
        type: 'upsert',
        configType: 'agent_model',
        agentName: 'Main',
        sourceFile: 'config/agent-model-configs/Main.model-config.json',
        data: agentModelConfig,
      }),
    ]);
    expect(result.plan.applied.modelPoliciesUpserted).toBe(4);
  });

  it('rejects conflicting operation-tier overrides between runtime and LLM config files', async () => {
    const files = new Map<string, string>([
      ['project.json', buildManifest({ agentFiles: [], toolFiles: [], entryAgent: null })],
      [
        'config/runtime-config.json',
        JSON.stringify({ operationTierOverrides: { response_gen: 'powerful' } }, null, 2),
      ],
      [
        'config/llm-config.json',
        JSON.stringify({ operationTierOverrides: { realtime_voice: 'voice' } }, null, 2),
      ],
    ]);

    const result = await buildCoreImportApplyPlanV2(files, buildExistingState(), {
      projectId: PROJECT_ID,
      tenantId: TENANT_ID,
      userId: USER_ID,
      deleteUnmatched: false,
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toEqual({
      code: 'INVALID_MODEL_POLICY_CONFIG',
      message: expect.stringContaining(
        'config/runtime-config.json and config/llm-config.json define conflicting operationTierOverrides',
      ),
    });
  });

  it('canonicalizes runtime-only operation-tier overrides into LLM config during delete-unmatched imports', async () => {
    const files = new Map<string, string>([
      ['project.json', buildManifest({ agentFiles: [], toolFiles: [], entryAgent: null })],
      [
        'config/runtime-config.json',
        JSON.stringify(
          {
            operationTierOverrides: { response_gen: 'powerful' },
            extraction: { nlu_provider: 'native' },
          },
          null,
          2,
        ),
      ],
    ]);

    const result = await buildCoreImportApplyPlanV2(
      files,
      buildExistingState({
        runtimeConfig: { extraction: { nlu_provider: 'native' } },
        llmConfig: { operationTierOverrides: { response_gen: 'fast' } },
      }),
      {
        projectId: PROJECT_ID,
        tenantId: TENANT_ID,
        userId: USER_ID,
        deleteUnmatched: true,
      },
    );

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }

    expect(result.plan.modelPolicyOperations).toContainEqual(
      expect.objectContaining({
        type: 'upsert',
        configType: 'llm',
        sourceFile: 'config/runtime-config.json',
        data: { operationTierOverrides: { response_gen: 'powerful' } },
      }),
    );
    expect(result.plan.modelPolicyOperations).not.toContainEqual(
      expect.objectContaining({
        configType: 'runtime',
        data: expect.objectContaining({
          operationTierOverrides: expect.anything(),
        }),
      }),
    );
    expect(result.plan.modelPolicyOperations).not.toContainEqual(
      expect.objectContaining({
        type: 'delete',
        configType: 'llm',
      }),
    );
  });

  it('rejects invalid operation-tier overrides in imported model policy configs', async () => {
    const files = new Map<string, string>([
      ['project.json', buildManifest({ agentFiles: [], toolFiles: [], entryAgent: null })],
      [
        'config/runtime-config.json',
        JSON.stringify({ operationTierOverrides: { extract: 'premium' } }, null, 2),
      ],
    ]);

    const result = await buildCoreImportApplyPlanV2(files, buildExistingState(), {
      projectId: PROJECT_ID,
      tenantId: TENANT_ID,
      userId: USER_ID,
      deleteUnmatched: false,
    });

    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }
    expect(result.error).toEqual({
      code: 'INVALID_MODEL_POLICY_CONFIG',
      message: expect.stringContaining('Invalid operation-tier overrides'),
    });
  });

  it('runs async runtime config validation before planning runtime config writes', async () => {
    const runtimeConfig = {
      filler: {
        modelSource: 'project',
        modelId: 'missing-project-model',
      },
    };
    const validateRuntimeConfigForSave = vi.fn(async () => ({
      valid: false as const,
      code: 'RUNTIME_CONFIG_MODEL_NOT_FOUND',
      message: 'Referenced project model config was not found',
    }));
    const files = new Map<string, string>([
      ['project.json', buildManifest({ agentFiles: [], toolFiles: [], entryAgent: null })],
      ['config/runtime-config.json', JSON.stringify(runtimeConfig, null, 2)],
    ]);

    const result = await buildCoreImportApplyPlanV2(files, buildExistingState(), {
      projectId: PROJECT_ID,
      tenantId: TENANT_ID,
      userId: USER_ID,
      deleteUnmatched: false,
      validateRuntimeConfigForSave,
    });

    expect(validateRuntimeConfigForSave).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      data: runtimeConfig,
      sourceFile: 'config/runtime-config.json',
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toEqual({
      code: 'INVALID_MODEL_POLICY_CONFIG',
      message: expect.stringContaining('Referenced project model config was not found'),
    });
  });

  it('plans validator-normalized runtime config data for portable tenant model refs', async () => {
    const exportedRuntimeConfig = {
      pipeline: {
        modelSource: 'tenant',
        tenantModelRef: {
          provider: 'openai',
          modelId: 'gpt-4o-realtime-preview-2025-06-03',
          tier: 'voice',
          capabilities: ['realtime_voice'],
        },
      },
    };
    const normalizedRuntimeConfig = {
      pipeline: {
        modelSource: 'tenant',
        tenantModelId: 'tm-destination-voice',
      },
    };
    const validateRuntimeConfigForSave = vi.fn(async () => ({
      valid: true as const,
      data: normalizedRuntimeConfig,
    }));
    const files = new Map<string, string>([
      ['project.json', buildManifest({ agentFiles: [], toolFiles: [], entryAgent: null })],
      ['config/runtime-config.json', JSON.stringify(exportedRuntimeConfig, null, 2)],
    ]);

    const result = await buildCoreImportApplyPlanV2(files, buildExistingState(), {
      projectId: PROJECT_ID,
      tenantId: TENANT_ID,
      userId: USER_ID,
      deleteUnmatched: false,
      validateRuntimeConfigForSave,
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.plan.modelPolicyOperations).toContainEqual(
      expect.objectContaining({
        type: 'upsert',
        configType: 'runtime',
        data: normalizedRuntimeConfig,
      }),
    );
  });

  it('suppresses delete preview and delete operations when deleteUnmatched is false', async () => {
    const mainAgentDsl = `AGENT: Main
GOAL: Help customers
`;

    const files = new Map<string, string>([
      ['project.json', buildManifest({ agentFiles: ['Main'] })],
      ['agents/Main.agent.abl', mainAgentDsl],
    ]);

    const result = await buildCoreImportApplyPlanV2(
      files,
      buildExistingState({
        agents: [
          { name: 'Main', dslContent: mainAgentDsl },
          { name: 'Legacy', dslContent: 'AGENT: Legacy\nGOAL: Legacy flow\n' },
        ],
        tools: [{ name: 'orphan_tool', dslContent: 'orphan_tool() -> {ok: boolean}\n' }],
      }),
      {
        projectId: PROJECT_ID,
        tenantId: TENANT_ID,
        userId: USER_ID,
        deleteUnmatched: false,
      },
    );

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }

    expect(result.plan.agentOperations.some((operation) => operation.type === 'delete')).toBe(
      false,
    );
    expect(result.plan.toolOperations.some((operation) => operation.type === 'delete')).toBe(false);
    expect(result.plan.preview.agentChanges.removed).toEqual([]);
    expect(result.plan.preview.toolChanges.removed).toEqual([]);
    expect(result.plan.preview.layerChanges.core?.removed).toBe(0);
  });

  it('returns a preview-only no-op plan when preview already has blocking issues', async () => {
    const files = new Map<string, string>([
      ['project.json', buildManifest({ agentFiles: ['Main'] })],
      [
        'agents/Main.agent.abl',
        `GOAL: Help customers

TOOLS:
  lookup_ticket(ticket_id: string) -> {status: string}
    description: "Look up a ticket"
`,
      ],
    ]);

    const result = await buildCoreImportApplyPlanV2(files, buildExistingState(), {
      projectId: PROJECT_ID,
      tenantId: TENANT_ID,
      userId: USER_ID,
      deleteUnmatched: false,
    });

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }

    expect(result.plan.preview.hasBlockingIssues).toBe(true);
    expect(result.plan.agentOperations).toEqual([]);
    expect(result.plan.toolOperations).toEqual([]);
    expect(result.plan.mcpServerOperations).toEqual([]);
    expect(result.plan.localeOperations).toEqual([]);
    expect(result.plan.profileOperations).toEqual([]);
    expect(result.plan.applied).toEqual({
      created: 0,
      updated: 0,
      deleted: 0,
      toolsCreated: 0,
      toolsUpdated: 0,
      toolsDeleted: 0,
      localesCreated: 0,
      localesUpdated: 0,
      localesDeleted: 0,
      profilesCreated: 0,
      profilesUpdated: 0,
      profilesDeleted: 0,
    });
  });

  it('accepts default exported layers without blocking preview planning', async () => {
    const files = new Map<string, string>([
      [
        'project.json',
        buildManifest({
          agentFiles: ['Main'],
          layers: ['core', 'connections'],
        }),
      ],
      ['agents/Main.agent.abl', 'AGENT: Main\nGOAL: Help customers\n'],
      [
        'connections/configs/salesforce.connector-config.json',
        JSON.stringify({ connectorType: 'salesforce', enabled: true }),
      ],
    ]);

    const result = await buildCoreImportApplyPlanV2(files, buildExistingState(), {
      projectId: PROJECT_ID,
      tenantId: TENANT_ID,
      userId: USER_ID,
      deleteUnmatched: false,
    });

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }

    expect(result.plan.preview.layers).toEqual(expect.arrayContaining(['core', 'connections']));
    expect(result.plan.preview.hasBlockingIssues).toBe(false);
    expect(result.plan.preview.issues).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          blocking: true,
          category: 'general',
        }),
      ]),
    );
    expect(
      result.plan.preview.issues.some(
        (issue) => issue.blocking && issue.message.includes('connections'),
      ),
    ).toBe(false);
    expect(result.plan.agentOperations).toEqual([
      expect.objectContaining({ type: 'create', agentName: 'Main' }),
    ]);
    expect(result.plan.toolOperations).toEqual([]);
    expect(result.plan.mcpServerOperations).toEqual([]);
    expect(result.plan.localeOperations).toEqual([]);
    expect(result.plan.profileOperations).toEqual([]);
    expect(result.plan.modelPolicyOperations).toEqual([]);
    expect(result.plan.evalOperations).toEqual([]);
  });

  it('allows callers to scope a mixed archive down to supported layers', async () => {
    const files = new Map<string, string>([
      [
        'project.json',
        buildManifest({
          agentFiles: ['Main'],
          layers: ['core', 'connections'],
        }),
      ],
      ['agents/Main.agent.abl', 'AGENT: Main\nGOAL: Help customers\n'],
      [
        'connections/configs/salesforce.connector-config.json',
        JSON.stringify({ connectorType: 'salesforce', enabled: true }),
      ],
    ]);

    const result = await buildCoreImportApplyPlanV2(files, buildExistingState(), {
      projectId: PROJECT_ID,
      tenantId: TENANT_ID,
      userId: USER_ID,
      deleteUnmatched: false,
      layers: ['core'],
    });

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }

    expect(result.plan.preview.layers).toEqual(['core']);
    expect(result.plan.preview.hasBlockingIssues).toBe(false);
    expect(result.plan.agentOperations).toEqual([
      expect.objectContaining({
        type: 'create',
        agentName: 'Main',
      }),
    ]);
  });

  it('adds synthesized tool stubs into both the plan and preview', async () => {
    const mainAgentDsl = `AGENT: Main
GOAL: Help customers

TOOLS:
  lookup_ticket(ticket_id: string) -> {status: string}
    description: "Look up a ticket"
`;

    const files = new Map<string, string>([
      ['project.json', buildManifest({ agentFiles: ['Main'] })],
      ['agents/Main.agent.abl', mainAgentDsl],
    ]);

    const result = await buildCoreImportApplyPlanV2(files, buildExistingState(), {
      projectId: PROJECT_ID,
      tenantId: TENANT_ID,
      userId: USER_ID,
      deleteUnmatched: false,
    });

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }

    const stubOperation = result.plan.toolOperations.find(
      (operation) => operation.toolName === 'lookup_ticket',
    );

    expect(stubOperation).toMatchObject({
      type: 'create',
      toolName: 'lookup_ticket',
      autogenerated: true,
      toolType: 'http',
    });
    expect(stubOperation?.dslContent).toContain('endpoint: "https://TODO-configure-endpoint"');
    expect(result.plan.preview.toolChanges.added).toContain('lookup_ticket');
    expect(result.plan.preview.layerChanges.core?.added).toBe(2);
    expect(result.plan.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('W_TOOL_STUB: Auto-created stub for "lookup_ticket"'),
      ]),
    );
    expect(result.plan.preview.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('W_TOOL_STUB: Auto-created stub for "lookup_ticket"'),
      ]),
    );
  });

  it('rejects imported tool records that fail ProjectTool persistence validation', async () => {
    const files = new Map<string, string>([
      ['project.json', buildManifest({ agentFiles: [], toolFiles: ['bad_workflow'] })],
      [
        'tools/bad_workflow.tools.abl',
        `TOOLS:
  bad_workflow() -> object
    description: "Invalid workflow tool"
    type: workflow
    workflow_id: "wf_missing_trigger"
`,
      ],
    ]);

    const result = await buildCoreImportApplyPlanV2(files, buildExistingState(), {
      projectId: PROJECT_ID,
      tenantId: TENANT_ID,
      userId: USER_ID,
      deleteUnmatched: false,
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('INVALID_TOOL_IMPORT');
    expect(result.error.message).toContain('trigger_id');
  });

  it('rejects imported tool records that fail async referential binding validation', async () => {
    const validateToolBindingForSave = vi.fn(async () => ({
      valid: false as const,
      code: 'SEARCHAI_INDEX_NOT_FOUND',
      message: 'SearchAI index not found in project',
    }));
    const files = new Map<string, string>([
      ['project.json', buildManifest({ agentFiles: [], toolFiles: ['search_docs'] })],
      [
        'tools/search_docs.tools.abl',
        `TOOLS:
  search_docs(query: string) -> object
    description: "Search docs"
    type: searchai
    index_id: "idx-other-project"
    tenant_id: "${TENANT_ID}"
`,
      ],
    ]);

    const result = await buildCoreImportApplyPlanV2(files, buildExistingState(), {
      projectId: PROJECT_ID,
      tenantId: TENANT_ID,
      userId: USER_ID,
      deleteUnmatched: false,
      validateToolBindingForSave,
    });

    expect(validateToolBindingForSave).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT_ID,
        projectId: PROJECT_ID,
        toolName: 'search_docs',
        toolType: 'searchai',
        dslContent: expect.stringContaining('idx-other-project'),
      }),
    );
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('INVALID_TOOL_IMPORT');
    expect(result.error.message).toContain('SearchAI index not found in project');
  });

  it('fails closed for referential tool imports when no async validator is wired', async () => {
    const files = new Map<string, string>([
      ['project.json', buildManifest({ agentFiles: [], toolFiles: ['search_docs'] })],
      [
        'tools/search_docs.tools.abl',
        `TOOLS:
  search_docs(query: string) -> object
    description: "Search docs"
    type: searchai
    index_id: "idx-docs"
    tenant_id: "${TENANT_ID}"
`,
      ],
    ]);

    const result = await buildCoreImportApplyPlanV2(files, buildExistingState(), {
      projectId: PROJECT_ID,
      tenantId: TENANT_ID,
      userId: USER_ID,
      deleteUnmatched: false,
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('INVALID_TOOL_IMPORT');
    expect(result.error.message).toContain('requires referential binding validation');
  });

  it('keeps declared existing tools when deleteUnmatched is true', async () => {
    const mainAgentDsl = `AGENT: Main
GOAL: Help customers

TOOLS:
  lookup_ticket(ticket_id: string) -> {status: string}
    description: "Look up a ticket"
`;

    const files = new Map<string, string>([
      ['project.json', buildManifest({ agentFiles: ['Main'] })],
      ['agents/Main.agent.abl', mainAgentDsl],
    ]);

    const result = await buildCoreImportApplyPlanV2(
      files,
      buildExistingState({
        tools: [
          {
            name: 'lookup_ticket',
            dslContent: 'lookup_ticket(ticket_id: string) -> {status: string}\n',
          },
          {
            name: 'orphan_tool',
            dslContent: 'orphan_tool() -> {ok: boolean}\n',
          },
        ],
      }),
      {
        projectId: PROJECT_ID,
        tenantId: TENANT_ID,
        userId: USER_ID,
        deleteUnmatched: true,
      },
    );

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }

    expect(result.plan.toolOperations).toEqual([
      expect.objectContaining({
        type: 'delete',
        toolName: 'orphan_tool',
      }),
    ]);
    expect(result.plan.preview.toolChanges.removed).toEqual(['orphan_tool']);
    expect(result.plan.preview.toolChanges.added).toEqual([]);
  });

  it('builds create operations for imported MCP server configs and counts them in core preview', async () => {
    const files = new Map<string, string>([
      [
        'project.json',
        buildManifest({ agentFiles: ['Main'], requiredMcpServers: ['public-repo-tools'] }),
      ],
      ['agents/Main.agent.abl', 'AGENT: Main\nGOAL: Help customers\n'],
      [
        'core/mcp-servers/public-repo-tools.mcp-config.json',
        JSON.stringify({
          name: 'public-repo-tools',
          description: 'Public MCP server',
          transport: 'http',
          url: 'https://mcp.example.com/public-repo',
          authType: 'none',
          priority: 10,
          connectionTimeoutMs: 15000,
          requestTimeoutMs: 45000,
          autoReconnect: true,
          maxReconnectAttempts: 5,
          lastConnectionStatus: 'connected',
        }),
      ],
    ]);

    const result = await buildCoreImportApplyPlanV2(files, buildExistingState(), {
      projectId: PROJECT_ID,
      tenantId: TENANT_ID,
      userId: USER_ID,
      deleteUnmatched: false,
    });

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }

    expect(result.plan.mcpServerOperations).toEqual([
      expect.objectContaining({
        type: 'create',
        serverName: 'public-repo-tools',
        config: expect.objectContaining({
          name: 'public-repo-tools',
          transport: 'http',
          url: 'https://mcp.example.com/public-repo',
        }),
      }),
    ]);
    expect(result.plan.preview.layerChanges.core?.added).toBe(2);
  });

  it('fails fast when MCP server configs use the legacy export shape', async () => {
    const files = new Map<string, string>([
      ['project.json', buildManifest({ agentFiles: ['Main'] })],
      ['agents/Main.agent.abl', 'AGENT: Main\nGOAL: Help customers\n'],
      [
        'core/mcp-servers/legacy.mcp-config.json',
        JSON.stringify({
          serverName: 'legacy',
          endpoint: 'https://mcp.example.com/legacy',
          capabilities: [],
          status: 'connected',
        }),
      ],
    ]);

    const result = await buildCoreImportApplyPlanV2(files, buildExistingState(), {
      projectId: PROJECT_ID,
      tenantId: TENANT_ID,
      userId: USER_ID,
      deleteUnmatched: false,
    });

    expect(result).toEqual({
      success: false,
      warnings: [],
      error: {
        code: 'INVALID_MCP_SERVER_CONFIG',
        message: expect.stringContaining('name'),
      },
    });
  });

  it('tracks locale-file create, update, and delete operations in the plan and preview', async () => {
    const files = new Map<string, string>([
      ['project.json', buildManifest({ agentFiles: ['Main'] })],
      ['agents/Main.agent.abl', 'AGENT: Main\nGOAL: Help customers\n'],
      [
        'locales/fr/messages.json',
        JSON.stringify({ messages: { conversation_complete: 'Termine' } }, null, 2),
      ],
      [
        'locales/es/messages.json',
        JSON.stringify({ messages: { conversation_complete: 'Listo' } }, null, 2),
      ],
    ]);

    const result = await buildCoreImportApplyPlanV2(
      files,
      buildExistingState({
        localeFiles: [
          {
            filePath: 'locales/fr/messages.json',
            value: JSON.stringify(
              { messages: { conversation_complete: 'Ancienne version' } },
              null,
              2,
            ),
          },
          {
            filePath: 'locales/de/messages.json',
            value: JSON.stringify({ messages: { conversation_complete: 'Fertig' } }, null, 2),
          },
        ],
      }),
      {
        projectId: PROJECT_ID,
        tenantId: TENANT_ID,
        userId: USER_ID,
        deleteUnmatched: true,
      },
    );

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }

    expect(result.plan.localeOperations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'update',
          relativePath: 'fr/messages.json',
          filePath: 'locales/fr/messages.json',
        }),
        expect.objectContaining({
          type: 'create',
          relativePath: 'es/messages.json',
          filePath: 'locales/es/messages.json',
        }),
        expect.objectContaining({
          type: 'delete',
          relativePath: 'de/messages.json',
          filePath: 'locales/de/messages.json',
        }),
      ]),
    );
    expect(result.plan.preview.localeChanges).toEqual({
      added: ['locales/es/messages.json'],
      modified: ['locales/fr/messages.json'],
      removed: ['locales/de/messages.json'],
    });
    expect(result.plan.applied.localesCreated).toBe(1);
    expect(result.plan.applied.localesUpdated).toBe(1);
    expect(result.plan.applied.localesDeleted).toBe(1);
  });
});

describe('executeCoreImportApplyPlanV2', () => {
  it('returns applied counts and updates the entry agent on success', async () => {
    const plan: CoreImportApplyPlanV2 = {
      preparedFiles: new Map(),
      preview: buildPreview(),
      promptOperations: [
        {
          type: 'create',
          promptId: 'pl_prompt_1',
          promptName: 'Support Prompt',
          bundle: buildPromptBundle(),
          sourceHash: 'prompt-bundle-hash',
          sourceFile: 'prompts/support_prompt.prompt.json',
        },
      ],
      agentOperations: [
        {
          type: 'create',
          agentName: 'Main',
          dslContent: 'AGENT: Main\nGOAL: Help customers\n',
          description: null,
          sourceHash: 'agent-hash',
        },
      ],
      toolOperations: [
        {
          type: 'create',
          toolName: 'lookup_ticket',
          toolType: 'http',
          dslContent: 'lookup_ticket(ticket_id: string) -> {status: string}\n',
          description: null,
          sourceHash: 'tool-hash',
          sourceFile: 'auto:Main',
          autogenerated: true,
        },
      ],
      mcpServerOperations: [
        {
          type: 'create',
          serverName: 'public-repo-tools',
          config: {
            name: 'public-repo-tools',
            description: 'Public MCP server',
            transport: 'http',
            url: 'https://mcp.example.com/public-repo',
            authType: 'none',
            priority: 10,
            tags: null,
            connectionTimeoutMs: 15000,
            requestTimeoutMs: 45000,
            autoReconnect: true,
            maxReconnectAttempts: 5,
            lastConnectionStatus: 'connected',
          },
          sourceHash: 'mcp-hash',
          sourceFile: 'core/mcp-servers/public-repo-tools.mcp-config.json',
        },
      ],
      localeOperations: [
        {
          type: 'create',
          relativePath: 'fr/messages.json',
          filePath: 'locales/fr/messages.json',
          value: JSON.stringify({ messages: { conversation_complete: 'Termine' } }, null, 2),
          description: 'French shared messages',
          sourceHash: 'locale-hash',
          sourceFile: 'locales/fr/messages.json',
        },
      ],
      profileOperations: [
        {
          type: 'create',
          profileName: 'voice_vip',
          filePath: 'behavior_profiles/voice_vip.behavior_profile.abl',
          dslContent: 'BEHAVIOR_PROFILE: voice_vip\nPRIORITY: 5\nWHEN: channel == "voice"\n',
          sourceHash: 'profile-hash',
          sourceFile: 'behavior_profiles/voice_vip.behavior_profile.abl',
        },
      ],
      modelPolicyOperations: [
        {
          type: 'upsert',
          configType: 'runtime',
          data: { operationTierOverrides: { response_gen: 'powerful' } },
          sourceFile: 'config/runtime-config.json',
          sourceHash: 'runtime-config-hash',
        },
      ],
      evalOperations: [],
      entryAgentName: 'Main',
      warnings: [],
      applied: {
        created: 1,
        updated: 0,
        deleted: 0,
        promptsCreated: 1,
        toolsCreated: 1,
        toolsUpdated: 0,
        toolsDeleted: 0,
        localesCreated: 1,
        localesUpdated: 0,
        localesDeleted: 0,
        profilesCreated: 1,
        profilesUpdated: 0,
        profilesDeleted: 0,
        modelPoliciesUpserted: 1,
      },
    };

    const adapter: CoreImportApplyAdapterV2 = {
      createPrompts: vi.fn().mockResolvedValue(['prompt-1']),
      updatePrompts: vi.fn().mockResolvedValue(undefined),
      deletePrompts: vi.fn().mockResolvedValue(undefined),
      createAgents: vi.fn().mockResolvedValue(['agent-1']),
      updateAgents: vi.fn().mockResolvedValue(undefined),
      deleteAgents: vi.fn().mockResolvedValue(undefined),
      createMcpServers: vi.fn().mockResolvedValue(['mcp-1']),
      updateMcpServers: vi.fn().mockResolvedValue(undefined),
      deleteMcpServers: vi.fn().mockResolvedValue(undefined),
      createTools: vi.fn().mockResolvedValue(['tool-1']),
      updateTools: vi.fn().mockResolvedValue(undefined),
      deleteTools: vi.fn().mockResolvedValue(undefined),
      createLocales: vi.fn().mockResolvedValue(['locale-1']),
      updateLocales: vi.fn().mockResolvedValue(undefined),
      deleteLocales: vi.fn().mockResolvedValue(undefined),
      createProfiles: vi.fn().mockResolvedValue(['profile-1']),
      updateProfiles: vi.fn().mockResolvedValue(undefined),
      deleteProfiles: vi.fn().mockResolvedValue(undefined),
      upsertModelPolicyConfigs: vi.fn().mockResolvedValue(undefined),
      deleteModelPolicyConfigs: vi.fn().mockResolvedValue(undefined),
      setEntryAgent: vi.fn().mockResolvedValue(undefined),
      rollbackCreated: vi.fn().mockResolvedValue(undefined),
    };

    const result = await executeCoreImportApplyPlanV2(plan, adapter);

    expect(result).toEqual({
      success: true,
      applied: plan.applied,
      entryAgentName: 'Main',
    });
    expect(adapter.createPrompts).toHaveBeenCalledWith([
      expect.objectContaining({
        promptId: 'pl_prompt_1',
        sourceHash: 'prompt-bundle-hash',
      }),
    ]);
    expect(adapter.createMcpServers).toHaveBeenCalledWith([
      expect.objectContaining({ serverName: 'public-repo-tools', sourceHash: 'mcp-hash' }),
    ]);
    expect(adapter.createLocales).toHaveBeenCalledWith([
      expect.objectContaining({ relativePath: 'fr/messages.json', sourceHash: 'locale-hash' }),
    ]);
    expect(adapter.createProfiles).toHaveBeenCalledWith([
      expect.objectContaining({ profileName: 'voice_vip', sourceHash: 'profile-hash' }),
    ]);
    expect(adapter.createProfiles.mock.invocationCallOrder[0]).toBeLessThan(
      adapter.createAgents.mock.invocationCallOrder[0],
    );
    expect(adapter.upsertModelPolicyConfigs).toHaveBeenCalledWith([
      expect.objectContaining({
        configType: 'runtime',
        sourceHash: 'runtime-config-hash',
      }),
    ]);
    expect(adapter.setEntryAgent).toHaveBeenCalledWith('Main');
    expect(adapter.rollbackCreated).not.toHaveBeenCalled();
  });

  it('runs the post-agent draft metadata refresh after compile-context dependency mutations and before entry-agent updates', async () => {
    const plan: CoreImportApplyPlanV2 = {
      preparedFiles: new Map(),
      preview: buildPreview(),
      promptOperations: [
        {
          type: 'create',
          promptId: 'pl_prompt_1',
          promptName: 'Support Prompt',
          bundle: buildPromptBundle(),
          sourceHash: 'prompt-bundle-hash',
          sourceFile: 'prompts/support_prompt.prompt.json',
        },
      ],
      agentOperations: [
        {
          type: 'create',
          agentName: 'Main',
          dslContent: 'AGENT: Main\nGOAL: Help customers\n',
          description: null,
          sourceHash: 'agent-hash',
        },
        {
          type: 'delete',
          agentName: 'Legacy',
          dslContent: null,
          description: null,
          sourceHash: null,
        },
      ],
      toolOperations: [
        {
          type: 'create',
          toolName: 'lookup_ticket',
          toolType: 'http',
          dslContent: 'lookup_ticket(ticket_id: string) -> {status: string}\n',
          description: null,
          sourceHash: 'tool-hash',
          sourceFile: 'auto:Main',
          autogenerated: true,
        },
      ],
      mcpServerOperations: [
        {
          type: 'create',
          serverName: 'public-repo-tools',
          config: {
            name: 'public-repo-tools',
            description: null,
            transport: 'http',
            url: 'https://example.com/mcp',
            authType: 'none',
            priority: 100,
            tags: null,
            connectionTimeoutMs: 10000,
            requestTimeoutMs: 30000,
            autoReconnect: true,
            maxReconnectAttempts: 3,
            lastConnectionStatus: null,
          },
          sourceHash: 'mcp-hash',
        },
        {
          type: 'delete',
          serverName: 'legacy-server',
          config: null,
          sourceHash: null,
          sourceFile: null,
        },
      ],
      localeOperations: [
        {
          type: 'create',
          relativePath: 'fr/messages.json',
          filePath: 'locales/fr/messages.json',
          value: '{"messages":{"hello":"Bonjour"}}',
          sourceHash: 'locale-hash',
        },
      ],
      profileOperations: [
        {
          type: 'create',
          profileName: 'voice_vip',
          filePath: 'behavior_profiles/voice_vip.behavior_profile.abl',
          dslContent: 'BEHAVIOR_PROFILE: voice_vip\nPRIORITY: 5\n',
          sourceHash: 'profile-hash',
        },
      ],
      modelPolicyOperations: [],
      evalOperations: [],
      entryAgentName: 'Main',
      warnings: [],
      applied: {
        created: 1,
        updated: 0,
        deleted: 1,
        promptsCreated: 1,
        toolsCreated: 1,
        localesCreated: 1,
        profilesCreated: 1,
      },
    };

    const adapter: CoreImportApplyAdapterV2 & {
      refreshAgentDraftMetadata: ReturnType<typeof vi.fn>;
    } = {
      createPrompts: vi.fn().mockResolvedValue(['prompt-1']),
      updatePrompts: vi.fn().mockResolvedValue(undefined),
      deletePrompts: vi.fn().mockResolvedValue(undefined),
      createAgents: vi.fn().mockResolvedValue(['agent-1']),
      updateAgents: vi.fn().mockResolvedValue(undefined),
      deleteAgents: vi.fn().mockResolvedValue(undefined),
      refreshAgentDraftMetadata: vi.fn().mockResolvedValue(undefined),
      createMcpServers: vi.fn().mockResolvedValue([]),
      updateMcpServers: vi.fn().mockResolvedValue(undefined),
      deleteMcpServers: vi.fn().mockResolvedValue(undefined),
      createTools: vi.fn().mockResolvedValue([]),
      updateTools: vi.fn().mockResolvedValue(undefined),
      deleteTools: vi.fn().mockResolvedValue(undefined),
      createLocales: vi.fn().mockResolvedValue([]),
      updateLocales: vi.fn().mockResolvedValue(undefined),
      deleteLocales: vi.fn().mockResolvedValue(undefined),
      createProfiles: vi.fn().mockResolvedValue([]),
      updateProfiles: vi.fn().mockResolvedValue(undefined),
      deleteProfiles: vi.fn().mockResolvedValue(undefined),
      setEntryAgent: vi.fn().mockResolvedValue(undefined),
      rollbackCreated: vi.fn().mockResolvedValue(undefined),
    };

    await executeCoreImportApplyPlanV2(plan, adapter);

    expect(adapter.refreshAgentDraftMetadata).toHaveBeenCalledTimes(1);
    expect(adapter.refreshAgentDraftMetadata.mock.invocationCallOrder[0]).toBeGreaterThan(
      adapter.createPrompts.mock.invocationCallOrder[0],
    );
    expect(adapter.refreshAgentDraftMetadata.mock.invocationCallOrder[0]).toBeGreaterThan(
      adapter.createProfiles.mock.invocationCallOrder[0],
    );
    expect(adapter.refreshAgentDraftMetadata.mock.invocationCallOrder[0]).toBeGreaterThan(
      adapter.createLocales.mock.invocationCallOrder[0],
    );
    expect(adapter.refreshAgentDraftMetadata.mock.invocationCallOrder[0]).toBeGreaterThan(
      adapter.createTools.mock.invocationCallOrder[0],
    );
    expect(adapter.refreshAgentDraftMetadata.mock.invocationCallOrder[0]).toBeGreaterThan(
      adapter.createMcpServers.mock.invocationCallOrder[0],
    );
    expect(adapter.refreshAgentDraftMetadata.mock.invocationCallOrder[0]).toBeGreaterThan(
      adapter.deleteMcpServers.mock.invocationCallOrder[0],
    );
    expect(adapter.setEntryAgent.mock.invocationCallOrder[0]).toBeGreaterThan(
      adapter.refreshAgentDraftMetadata.mock.invocationCallOrder[0],
    );
  });

  it('runs the post-agent draft metadata refresh for tool-only imports that change compile context', async () => {
    const plan: CoreImportApplyPlanV2 = {
      preparedFiles: new Map(),
      preview: buildPreview(),
      promptOperations: [],
      agentOperations: [],
      toolOperations: [
        {
          type: 'create',
          toolName: 'lookup_ticket',
          toolType: 'http',
          dslContent: 'lookup_ticket(ticket_id: string) -> {status: string}\n',
          description: null,
          sourceHash: 'tool-hash',
          sourceFile: 'auto:Main',
          autogenerated: true,
        },
      ],
      mcpServerOperations: [],
      localeOperations: [],
      profileOperations: [],
      modelPolicyOperations: [],
      evalOperations: [],
      entryAgentName: null,
      warnings: [],
      applied: {
        created: 0,
        updated: 0,
        deleted: 0,
        toolsCreated: 1,
      },
    };

    const adapter: CoreImportApplyAdapterV2 & {
      refreshAgentDraftMetadata: ReturnType<typeof vi.fn>;
    } = {
      createPrompts: vi.fn().mockResolvedValue([]),
      updatePrompts: vi.fn().mockResolvedValue(undefined),
      deletePrompts: vi.fn().mockResolvedValue(undefined),
      createAgents: vi.fn().mockResolvedValue([]),
      updateAgents: vi.fn().mockResolvedValue(undefined),
      deleteAgents: vi.fn().mockResolvedValue(undefined),
      refreshAgentDraftMetadata: vi.fn().mockResolvedValue(undefined),
      createMcpServers: vi.fn().mockResolvedValue([]),
      updateMcpServers: vi.fn().mockResolvedValue(undefined),
      deleteMcpServers: vi.fn().mockResolvedValue(undefined),
      createTools: vi.fn().mockResolvedValue(['tool-1']),
      updateTools: vi.fn().mockResolvedValue(undefined),
      deleteTools: vi.fn().mockResolvedValue(undefined),
      createLocales: vi.fn().mockResolvedValue([]),
      updateLocales: vi.fn().mockResolvedValue(undefined),
      deleteLocales: vi.fn().mockResolvedValue(undefined),
      createProfiles: vi.fn().mockResolvedValue([]),
      updateProfiles: vi.fn().mockResolvedValue(undefined),
      deleteProfiles: vi.fn().mockResolvedValue(undefined),
      setEntryAgent: vi.fn().mockResolvedValue(undefined),
      rollbackCreated: vi.fn().mockResolvedValue(undefined),
    };

    await executeCoreImportApplyPlanV2(plan, adapter);

    expect(adapter.refreshAgentDraftMetadata).toHaveBeenCalledTimes(1);
    expect(adapter.refreshAgentDraftMetadata.mock.invocationCallOrder[0]).toBeGreaterThan(
      adapter.createTools.mock.invocationCallOrder[0],
    );
  });

  it('rolls back created records when a later apply step fails', async () => {
    const plan: CoreImportApplyPlanV2 = {
      preparedFiles: new Map(),
      preview: buildPreview(),
      promptOperations: [
        {
          type: 'create',
          promptId: 'pl_prompt_1',
          promptName: 'Support Prompt',
          bundle: buildPromptBundle(),
          sourceHash: 'prompt-bundle-hash',
          sourceFile: 'prompts/support_prompt.prompt.json',
        },
      ],
      agentOperations: [
        {
          type: 'create',
          agentName: 'Main',
          dslContent: 'AGENT: Main\nGOAL: Help customers\n',
          description: null,
          sourceHash: 'agent-hash',
        },
      ],
      toolOperations: [
        {
          type: 'create',
          toolName: 'lookup_ticket',
          toolType: 'http',
          dslContent: 'lookup_ticket(ticket_id: string) -> {status: string}\n',
          description: null,
          sourceHash: 'tool-hash',
          sourceFile: 'auto:Main',
          autogenerated: true,
        },
        {
          type: 'update',
          toolName: 'notify_customer',
          toolType: 'http',
          dslContent: 'notify_customer() -> {ok: boolean}\n',
          description: null,
          sourceHash: 'tool-update-hash',
          sourceFile: 'tools/notify_customer.tools.abl',
          autogenerated: false,
        },
      ],
      mcpServerOperations: [
        {
          type: 'create',
          serverName: 'public-repo-tools',
          config: {
            name: 'public-repo-tools',
            description: 'Public MCP server',
            transport: 'http',
            url: 'https://mcp.example.com/public-repo',
            authType: 'none',
            priority: 10,
            tags: null,
            connectionTimeoutMs: 15000,
            requestTimeoutMs: 45000,
            autoReconnect: true,
            maxReconnectAttempts: 5,
            lastConnectionStatus: 'connected',
          },
          sourceHash: 'mcp-hash',
          sourceFile: 'core/mcp-servers/public-repo-tools.mcp-config.json',
        },
      ],
      localeOperations: [
        {
          type: 'create',
          relativePath: 'fr/messages.json',
          filePath: 'locales/fr/messages.json',
          value: JSON.stringify({ messages: { conversation_complete: 'Termine' } }, null, 2),
          description: 'French shared messages',
          sourceHash: 'locale-hash',
          sourceFile: 'locales/fr/messages.json',
        },
      ],
      profileOperations: [],
      modelPolicyOperations: [],
      evalOperations: [],
      entryAgentName: 'Main',
      warnings: [],
      applied: {
        created: 1,
        updated: 0,
        deleted: 0,
        promptsCreated: 1,
        toolsCreated: 1,
        toolsUpdated: 1,
        toolsDeleted: 0,
        localesCreated: 1,
        localesUpdated: 0,
        localesDeleted: 0,
        profilesCreated: 0,
        profilesUpdated: 0,
        profilesDeleted: 0,
      },
    };

    const adapter: CoreImportApplyAdapterV2 = {
      createPrompts: vi.fn().mockResolvedValue(['prompt-1']),
      updatePrompts: vi.fn().mockResolvedValue(undefined),
      deletePrompts: vi.fn().mockResolvedValue(undefined),
      createAgents: vi.fn().mockResolvedValue(['agent-1']),
      updateAgents: vi.fn().mockResolvedValue(undefined),
      deleteAgents: vi.fn().mockResolvedValue(undefined),
      createMcpServers: vi.fn().mockResolvedValue(['mcp-1']),
      updateMcpServers: vi.fn().mockResolvedValue(undefined),
      deleteMcpServers: vi.fn().mockResolvedValue(undefined),
      createTools: vi.fn().mockResolvedValue(['tool-1']),
      updateTools: vi.fn().mockRejectedValue(new Error('tool update failed')),
      deleteTools: vi.fn().mockResolvedValue(undefined),
      createLocales: vi.fn().mockResolvedValue(['locale-1']),
      updateLocales: vi.fn().mockResolvedValue(undefined),
      deleteLocales: vi.fn().mockResolvedValue(undefined),
      createProfiles: vi.fn().mockResolvedValue(['profile-1']),
      updateProfiles: vi.fn().mockResolvedValue(undefined),
      deleteProfiles: vi.fn().mockResolvedValue(undefined),
      setEntryAgent: vi.fn().mockResolvedValue(undefined),
      rollbackCreated: vi.fn().mockResolvedValue(undefined),
    };

    const result = await executeCoreImportApplyPlanV2(plan, adapter);

    expect(result).toEqual({
      success: false,
      error: {
        code: 'IMPORT_APPLY_FAILED',
        message: 'Import failed during apply. Created records have been rolled back.',
        stage: 'update_tools',
        sanitizedCause: 'Persistence operation failed',
      },
    });
    expect(adapter.rollbackCreated).toHaveBeenCalledWith(
      ['prompt-1'],
      ['agent-1'],
      ['tool-1'],
      ['mcp-1'],
      [],
      [],
      {},
    );
    expect(adapter.setEntryAgent).not.toHaveBeenCalled();
  });
});
