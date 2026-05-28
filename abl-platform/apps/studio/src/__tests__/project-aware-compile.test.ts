import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseAgentBasedABL } from '@abl/core';
import {
  compileABLtoIR,
  type CompilationOutput,
  VALIDATION_CODES,
  type ValidationDiagnostic,
} from '@abl/compiler';

const mockFindConfigVariablesByProject = vi.fn();
const mockGetProjectAgents = vi.fn();
const mockResolveToolImplementations = vi.fn();
const mockBuildStudioConnectorToolResolver = vi.fn();
const mockResolvePromptLibraryRefOnDocument = vi.fn();
const mockProjectRuntimeConfigFindOne = vi.fn();
const mockProjectLLMConfigFindOne = vi.fn();
const mockGetProjectExportReadinessIssues = vi.hoisted(() => vi.fn());

vi.mock('@abl/compiler', async () => ({
  ...(await vi.importActual<Record<string, unknown>>('@abl/compiler/platform/ir')),
  ...(await vi.importActual<Record<string, unknown>>(
    '@abl/compiler/platform/ir/project-runtime-config.js',
  )),
}));

vi.mock('@/repos/config-variable-repo', () => ({
  findConfigVariablesByProject: (...args: unknown[]) => mockFindConfigVariablesByProject(...args),
}));

vi.mock('@/services/project-service', () => ({
  getProjectAgents: (...args: unknown[]) => mockGetProjectAgents(...args),
}));

vi.mock('@agent-platform/shared/tools/resolve', () => ({
  resolveToolImplementations: (...args: unknown[]) => mockResolveToolImplementations(...args),
}));

vi.mock('@agent-platform/shared/repos', () => ({
  findMcpServerConfigsRaw: vi.fn().mockResolvedValue([]),
}));

vi.mock('@/lib/connection-service', () => ({
  buildStudioConnectorToolResolver: (...args: unknown[]) =>
    mockBuildStudioConnectorToolResolver(...args),
}));

vi.mock('@agent-platform/database/models', () => ({
  ProjectRuntimeConfig: {
    findOne: (...args: unknown[]) => ({ lean: () => mockProjectRuntimeConfigFindOne(...args) }),
  },
  ProjectLLMConfig: {
    findOne: (...args: unknown[]) => ({ lean: () => mockProjectLLMConfigFindOne(...args) }),
  },
}));

vi.mock('@agent-platform/shared/prompts', () => ({
  resolvePromptLibraryRefOnDocument: (...args: unknown[]) =>
    mockResolvePromptLibraryRefOnDocument(...args),
}));

vi.mock('@agent-platform/project-io', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getProjectExportReadinessIssues: (...args: unknown[]) =>
    mockGetProjectExportReadinessIssues(...args),
}));

import {
  buildProjectCompileContext,
  buildStudioCompilerOptions,
  collectTargetCompilationMessages,
  compileProjectAgentsForDiagnostics,
} from '@/lib/abl/project-aware-compile';

function makeCompilationOutput(overrides: Partial<CompilationOutput> = {}): CompilationOutput {
  return {
    version: '1.0',
    compiled_at: '2026-04-16T00:00:00.000Z',
    agents: {},
    ...overrides,
  } as CompilationOutput;
}

function parseDocument(dsl: string) {
  const result = parseAgentBasedABL(dsl);
  expect(result.errors).toHaveLength(0);
  expect(result.document).not.toBeNull();
  return result.document!;
}

describe('buildProjectCompileContext', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetProjectAgents.mockResolvedValue([]);
    mockFindConfigVariablesByProject.mockResolvedValue([]);
    mockResolveToolImplementations.mockResolvedValue({
      resolvedByAgent: new Map(),
      errors: [],
      warnings: [],
    });
    mockBuildStudioConnectorToolResolver.mockResolvedValue(undefined);
    mockProjectRuntimeConfigFindOne.mockResolvedValue(null);
    mockProjectLLMConfigFindOne.mockResolvedValue(null);
    mockResolvePromptLibraryRefOnDocument.mockImplementation(async (document: any) => {
      document.systemPrompt = 'Resolved prompt';
      document.systemPromptLibraryRef = {
        ...(document.systemPromptLibraryRef ?? {}),
        resolvedHash: 'prompt-hash',
      };
    });
  });

  it('blocks duplicate agent names before project-aware compilation can overwrite the target IR', async () => {
    mockGetProjectAgents.mockResolvedValue([
      {
        name: 'booking_agent',
        dslContent: 'AGENT: booking_agent\nGOAL: "Original persisted agent"',
      },
      {
        name: 'travel_agent',
        dslContent: 'AGENT: travel_agent\nGOAL: "Existing sibling"',
      },
    ]);

    const result = await buildProjectCompileContext({
      agentName: 'booking_agent',
      projectId: 'proj-1',
      targetDocument: parseDocument('AGENT: travel_agent\nGOAL: "Renamed agent"'),
      tenantId: 'tenant-1',
    });

    expect(result.allDocs.map((doc) => doc.name)).toEqual(['travel_agent']);
    expect(result.errors).toEqual([
      'Agent name "travel_agent" is already used by edited agent "booking_agent" and project agent "travel_agent". Rename one of the agents before compiling.',
    ]);
  });

  it('keeps project-aware compile best-effort when sibling agent context cannot be loaded', async () => {
    mockGetProjectAgents.mockRejectedValue(new Error('project service unavailable'));

    const result = await buildProjectCompileContext({
      agentName: 'booking_agent',
      mode: 'best_effort',
      projectId: 'proj-1',
      targetDocument: parseDocument('AGENT: booking_agent\nGOAL: "Handle bookings"'),
      tenantId: 'tenant-1',
    });

    expect(result.allDocs.map((doc) => doc.name)).toEqual(['booking_agent']);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([
      'Project-aware compile continued without sibling agent context: project service unavailable',
    ]);
  });

  it('keeps project-aware compile best-effort when config variables cannot be loaded', async () => {
    mockFindConfigVariablesByProject.mockRejectedValue(new Error('config store unavailable'));

    const result = await buildProjectCompileContext({
      agentName: 'booking_agent',
      mode: 'best_effort',
      projectId: 'proj-1',
      targetDocument: parseDocument('AGENT: booking_agent\nGOAL: "Handle bookings"'),
      tenantId: 'tenant-1',
    });

    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([
      'Project-aware compile continued without project config variables: config store unavailable',
    ]);
  });

  it('returns explicit context errors in strict mode when config variables cannot be loaded', async () => {
    mockFindConfigVariablesByProject.mockRejectedValue(new Error('config store unavailable'));

    const result = await buildProjectCompileContext({
      agentName: 'booking_agent',
      mode: 'strict',
      projectId: 'proj-1',
      targetDocument: parseDocument('AGENT: booking_agent\nGOAL: "Handle bookings"'),
      tenantId: 'tenant-1',
    });

    expect(result.errors).toEqual([
      'Project-aware compile requires project config variables, but they could not be loaded: config store unavailable',
    ]);
    expect(result.warnings).toEqual([]);
  });

  it('resolves persisted prompt-library refs and appends config-backed behavior profiles', async () => {
    mockGetProjectAgents.mockResolvedValue([
      {
        name: 'booking_agent',
        dslContent: 'AGENT: booking_agent\nGOAL: "Persisted booking agent"',
        systemPromptLibraryRef: { promptId: 'prompt-1', versionId: 'version-1' },
      },
    ]);
    mockFindConfigVariablesByProject.mockResolvedValue([
      {
        key: 'profile:voice_profile',
        value: 'BEHAVIOR_PROFILE: voice_profile\nPRIORITY: 10\nWHEN: true',
      },
    ]);

    const result = await buildProjectCompileContext({
      agentName: 'booking_agent',
      projectId: 'proj-1',
      targetDocument: parseDocument(
        'AGENT: booking_agent\nGOAL: "Handle bookings"\nUSE BEHAVIOR_PROFILE: voice_profile',
      ),
      tenantId: 'tenant-1',
    });

    expect(mockResolvePromptLibraryRefOnDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'booking_agent',
        systemPromptLibraryRef: expect.objectContaining({
          promptId: 'prompt-1',
          versionId: 'version-1',
        }),
      }),
      { tenantId: 'tenant-1', projectId: 'proj-1' },
    );
    expect(result.errors).toEqual([]);
    expect(result.allDocs.map((doc) => doc.name)).toEqual(
      expect.arrayContaining(['booking_agent', 'voice_profile']),
    );
    expect((result.allDocs[0] as AgentBasedDocument & { systemPrompt?: string }).systemPrompt).toBe(
      'Resolved prompt',
    );
  });
});

describe('buildStudioCompilerOptions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveToolImplementations.mockResolvedValue({
      resolvedByAgent: new Map([
        ['booking_agent', [{ name: 'send_email' }]],
        ['billing_agent', [{ name: 'billing_lookup' }]],
      ]),
      errors: [],
      warnings: [],
    });
    mockBuildStudioConnectorToolResolver.mockResolvedValue('connector-resolver');
    mockProjectRuntimeConfigFindOne.mockResolvedValue(null);
    mockProjectLLMConfigFindOne.mockResolvedValue(null);
    mockGetProjectExportReadinessIssues.mockResolvedValue([]);
  });

  it('resolves tools across all compile documents and passes the connector resolver through', async () => {
    const result = await buildStudioCompilerOptions({
      documents: [
        parseDocument(
          'AGENT: booking_agent\nGOAL: "Handle bookings"\nTOOLS:\n  send_email(query: string) -> object',
        ),
        parseDocument(
          'AGENT: billing_agent\nGOAL: "Handle billing"\nTOOLS:\n  billing_lookup(id: string) -> object',
        ),
      ],
      projectId: 'proj-1',
      tenantId: 'tenant-1',
      configVariables: { API_BASE: 'https://example.com' },
    });

    expect(result.compilerOptions).toMatchObject({
      config_variables: { API_BASE: 'https://example.com' },
      resolvedToolImplementations: new Map([
        ['booking_agent', [{ name: 'send_email' }]],
        ['billing_agent', [{ name: 'billing_lookup' }]],
      ]),
    });
    expect(mockResolveToolImplementations).toHaveBeenCalledTimes(1);
    const [input, deps] = mockResolveToolImplementations.mock.calls[0];
    expect(input).toEqual({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      toolsByAgent: new Map([
        ['booking_agent', ['send_email']],
        ['billing_agent', ['billing_lookup']],
      ]),
    });
    expect(deps).toMatchObject({
      connectorToolResolver: 'connector-resolver',
      mcpServerConfigRawLoader: expect.any(Function),
    });
  });

  it('includes project runtime config in compiler options for Studio parity', async () => {
    mockProjectRuntimeConfigFindOne.mockResolvedValue({
      extraction: {
        strategy: 'hybrid',
        correction_detection: 'llm',
      },
      compaction: {
        tool_results: {
          max_chars: 4096,
        },
      },
    });

    const result = await buildStudioCompilerOptions({
      documents: [parseDocument('AGENT: booking_agent\nGOAL: "Handle bookings"')],
      projectId: 'proj-1',
      tenantId: 'tenant-1',
    });

    expect(mockProjectRuntimeConfigFindOne).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
    });
    expect(result.compilerOptions.project_runtime_config).toMatchObject({
      extraction_strategy: 'hybrid',
      correction_detection: 'llm',
      compaction: {
        tool_results: {
          max_chars: 4096,
        },
      },
    });
  });

  it('reports invalid persisted runtime config as a non-blocking warning by default', async () => {
    mockProjectRuntimeConfigFindOne.mockResolvedValue({
      extraction: {
        nlu_provider: 'advanced',
      },
    });
    mockGetProjectExportReadinessIssues.mockResolvedValueOnce([
      {
        kind: 'runtime_config',
        diagnostics: [
          {
            severity: 'error',
            message: 'advanced_sidecar_url is required when nlu_provider is advanced',
            source: 'export-runtime-config-readiness',
          },
        ],
      },
    ]);

    const result = await buildStudioCompilerOptions({
      documents: [parseDocument('AGENT: booking_agent\nGOAL: "Handle bookings"')],
      projectId: 'proj-1',
      tenantId: 'tenant-1',
    });

    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([
      expect.stringContaining(
        'Project configuration is not execution-ready: advanced_sidecar_url is required when nlu_provider is advanced',
      ),
    ]);
    expect(result.warnings[0]).toContain(
      'Used by: Project Settings > Runtime Config > Extraction uses advanced NLU provider',
    );
    expect(result.warnings[0]).toContain(
      'Next: Set the advanced sidecar URL in Runtime Config or switch the extraction provider back to standard.',
    );
    expect(result.compilerOptions.project_runtime_config).toMatchObject({
      nlu_provider: 'advanced',
    });
  });

  it('can promote invalid persisted runtime config to a blocking compiler option error', async () => {
    mockProjectRuntimeConfigFindOne.mockResolvedValue({
      extraction: {
        nlu_provider: 'advanced',
      },
    });
    mockGetProjectExportReadinessIssues.mockResolvedValueOnce([
      {
        kind: 'runtime_config',
        diagnostics: [
          {
            severity: 'error',
            message: 'advanced_sidecar_url is required when nlu_provider is advanced',
            source: 'export-runtime-config-readiness',
          },
        ],
      },
    ]);

    const result = await buildStudioCompilerOptions({
      documents: [parseDocument('AGENT: booking_agent\nGOAL: "Handle bookings"')],
      projectId: 'proj-1',
      runtimeConfigReadinessMode: 'blocking',
      tenantId: 'tenant-1',
    });

    expect(result.errors).toEqual([
      expect.stringContaining(
        'Project configuration is not execution-ready: advanced_sidecar_url is required when nlu_provider is advanced',
      ),
    ]);
    expect(result.warnings).toEqual([]);
    expect(result.compilerOptions.project_runtime_config).toMatchObject({
      nlu_provider: 'advanced',
    });
  });

  it('reports invalid persisted model policy as a non-blocking warning by default', async () => {
    mockProjectLLMConfigFindOne.mockResolvedValue({
      operationTierOverrides: {
        response_gen: 'voice',
      },
    });
    mockGetProjectExportReadinessIssues.mockResolvedValueOnce([
      {
        kind: 'model_policy',
        diagnostics: [
          {
            severity: 'error',
            message: 'Invalid operation-tier overrides',
            source: 'export-model-policy-readiness',
          },
        ],
      },
    ]);

    const result = await buildStudioCompilerOptions({
      documents: [parseDocument('AGENT: booking_agent\nGOAL: "Handle bookings"')],
      projectId: 'proj-1',
      tenantId: 'tenant-1',
    });

    expect(mockGetProjectExportReadinessIssues).toHaveBeenCalledWith(
      expect.objectContaining({
        llmConfig: expect.objectContaining({
          operationTierOverrides: {
            response_gen: 'voice',
          },
        }),
      }),
    );
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([
      expect.stringContaining(
        'Project configuration is not execution-ready: Invalid operation-tier overrides',
      ),
    ]);
    expect(result.warnings[0]).toContain(
      'Used by: Project Settings > Runtime Config > Model policy',
    );
    expect(result.warnings[0]).toContain(
      'Next: Review the project model policy operation-tier overrides and choose supported tiers.',
    );
  });

  it('does not block Studio compile when a selected tenant model is unavailable', async () => {
    mockProjectRuntimeConfigFindOne.mockResolvedValue({
      pipeline: {
        enabled: true,
        modelSource: 'tenant',
        tenantModelId: 'deleted-tenant-model',
      },
    });
    mockGetProjectExportReadinessIssues.mockResolvedValueOnce([
      {
        kind: 'runtime_config',
        diagnostics: [
          {
            severity: 'error',
            message: 'Selected tenant model must belong to this tenant',
            source: 'export-runtime-config-readiness',
          },
        ],
      },
    ]);

    const result = await buildStudioCompilerOptions({
      documents: [parseDocument('AGENT: booking_agent\nGOAL: "Handle bookings"')],
      projectId: 'proj-1',
      tenantId: 'tenant-1',
    });

    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([
      expect.stringContaining(
        'Project configuration is not execution-ready: Selected tenant model must belong to this tenant',
      ),
    ]);
    expect(result.warnings[0]).toContain(
      'Used by: Project Settings > Runtime Config > Reasoning pipeline model uses tenantModelId "deleted-tenant-model"',
    );
    expect(result.warnings[0]).toContain(
      'Next: Choose an active tenant model in Runtime Config, switch the affected model source back to default, or recreate/enable the tenant model in Admin > Models.',
    );
    expect(result.compilerOptions.project_runtime_config).toMatchObject({
      pipeline: {
        enabled: true,
        modelSource: 'tenant',
        tenantModelId: 'deleted-tenant-model',
      },
    });
  });

  it('can promote tool resolution errors to blocking compiler option errors for publish paths', async () => {
    mockResolveToolImplementations.mockResolvedValueOnce({
      resolvedByAgent: new Map(),
      errors: [
        {
          code: 'E721',
          message: "Tool 'missing_tool' not found in project. Create it in the Tool Library first.",
        },
      ],
      warnings: [],
    });

    const result = await buildStudioCompilerOptions({
      documents: [
        parseDocument(
          'AGENT: booking_agent\nGOAL: "Handle bookings"\nTOOLS:\n  missing_tool(query: string) -> object',
        ),
      ],
      projectId: 'proj-1',
      tenantId: 'tenant-1',
      toolResolutionMode: 'blocking',
    });

    expect(result.errors).toEqual([
      "E721: Tool 'missing_tool' not found in project. Create it in the Tool Library first.",
    ]);
    expect(result.warnings).toEqual([]);
  });
});

describe('compileProjectAgentsForDiagnostics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindConfigVariablesByProject.mockResolvedValue([
      {
        key: 'profile:voice_profile',
        value: 'BEHAVIOR_PROFILE: voice_profile\nPRIORITY: 10\nWHEN: true',
      },
    ]);
    mockResolveToolImplementations.mockResolvedValue({
      resolvedByAgent: new Map(),
      errors: [],
      warnings: [],
    });
    mockBuildStudioConnectorToolResolver.mockResolvedValue(undefined);
    mockProjectRuntimeConfigFindOne.mockResolvedValue(null);
    mockGetProjectExportReadinessIssues.mockResolvedValue([]);
    mockResolvePromptLibraryRefOnDocument.mockImplementation(async (document: any) => {
      document.systemPrompt = 'Resolved prompt';
      document.systemPromptLibraryRef = {
        ...(document.systemPromptLibraryRef ?? {}),
        resolvedHash: 'prompt-hash',
      };
    });
  });

  it('resolves prompt refs and compiles stored project agents with project context', async () => {
    const result = await compileProjectAgentsForDiagnostics({
      projectId: 'proj-1',
      tenantId: 'tenant-1',
      agents: [
        {
          name: 'booking_agent',
          dslContent:
            'AGENT: booking_agent\nGOAL: "Handle bookings"\nUSE BEHAVIOR_PROFILE: voice_profile',
          systemPromptLibraryRef: {
            promptId: 'prompt-1',
            versionId: 'version-1',
          },
        },
      ],
    });

    expect(mockResolvePromptLibraryRefOnDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'booking_agent',
        systemPromptLibraryRef: expect.objectContaining({
          promptId: 'prompt-1',
          versionId: 'version-1',
        }),
      }),
      { tenantId: 'tenant-1', projectId: 'proj-1' },
    );
    expect(result.errors).toEqual([]);
    expect(result.parseErrors).toEqual([]);
    expect(result.compiled?.agents.booking_agent).toBeDefined();
  });

  it('compiles diagnostics with the same project runtime config that execution will use', async () => {
    mockProjectRuntimeConfigFindOne.mockResolvedValue({
      extraction: {
        strategy: 'hybrid',
        correction_detection: 'llm',
      },
      compaction: {
        tool_results: {
          max_chars: 4096,
        },
      },
    });

    const result = await compileProjectAgentsForDiagnostics({
      projectId: 'proj-1',
      tenantId: 'tenant-1',
      agents: [
        {
          name: 'booking_agent',
          dslContent: 'AGENT: booking_agent\nGOAL: "Handle bookings"',
        },
      ],
    });

    expect(result.errors).toEqual([]);
    expect(result.compiled?.agents.booking_agent.project_runtime_config).toMatchObject({
      extraction_strategy: 'hybrid',
      correction_detection: 'llm',
      compaction: {
        tool_results: {
          max_chars: 4096,
        },
      },
    });
  });

  it('surfaces invalid runtime config as a diagnostic compile warning', async () => {
    mockFindConfigVariablesByProject.mockResolvedValue([]);
    mockProjectRuntimeConfigFindOne.mockResolvedValue({
      extraction: {
        nlu_provider: 'advanced',
      },
    });
    mockGetProjectExportReadinessIssues.mockResolvedValueOnce([
      {
        kind: 'runtime_config',
        diagnostics: [
          {
            severity: 'error',
            message: 'advanced_sidecar_url is required when nlu_provider is advanced',
            source: 'export-runtime-config-readiness',
          },
        ],
      },
    ]);

    const result = await compileProjectAgentsForDiagnostics({
      projectId: 'proj-1',
      tenantId: 'tenant-1',
      agents: [
        {
          name: 'booking_agent',
          dslContent: 'AGENT: booking_agent\nGOAL: "Handle bookings"',
        },
      ],
    });

    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          'Project configuration is not execution-ready: advanced_sidecar_url is required when nlu_provider is advanced',
        ),
      ]),
    );
    expect(result.warnings[0]).toContain(
      'Project configuration is not execution-ready: advanced_sidecar_url is required when nlu_provider is advanced',
    );
    expect(result.warnings[0]).toContain(
      'Used by: Project Settings > Runtime Config > Extraction uses advanced NLU provider',
    );
    expect(result.warnings[0]).toContain(
      'Next: Set the advanced sidecar URL in Runtime Config or switch the extraction provider back to standard.',
    );
    expect(result.compiled?.agents.booking_agent.project_runtime_config).toMatchObject({
      nlu_provider: 'advanced',
    });
  });
});

describe('collectTargetCompilationMessages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uses structured referenced-agent metadata instead of parsing diagnostic copy', () => {
    const output = makeCompilationOutput({
      compilation_errors: [
        {
          agent: 'billing_agent',
          message: 'Cross-agent validation failed after rename',
          type: 'validation',
          severity: 'error',
          code: VALIDATION_CODES.INVALID_HANDOFF_TARGET,
          path: 'coordination.handoffs[0].to',
          referenced_agent: 'booking_agent',
        } as never,
      ],
    });

    const messages = collectTargetCompilationMessages(output, ['travel_agent', 'booking_agent']);

    expect(messages.errors).toEqual(['billing_agent: Cross-agent validation failed after rename']);
    expect(messages.warnings).toEqual([]);
  });

  it('includes sibling cross-agent errors from real compiler output after a rename', () => {
    const output = compileABLtoIR([
      parseDocument('AGENT: travel_agent\nGOAL: "Handle travel questions"'),
      parseDocument(`
AGENT: billing_agent
GOAL: "Handle billing questions"

HANDOFF:
  - TO: booking_agent
    WHEN: always
    CONTEXT:
      pass: []
`),
    ]);

    const messages = collectTargetCompilationMessages(output, ['travel_agent', 'booking_agent']);
    const renameError = output.compilation_errors?.find(
      (entry) => (entry as ValidationDiagnostic).code === VALIDATION_CODES.INVALID_HANDOFF_TARGET,
    ) as ValidationDiagnostic | undefined;

    expect(renameError).toMatchObject({
      agent: 'billing_agent',
      code: VALIDATION_CODES.INVALID_HANDOFF_TARGET,
      referenced_agent: 'booking_agent',
    });
    expect(messages.errors).toEqual(
      expect.arrayContaining([
        'billing_agent: Handoff target "booking_agent" does not exist in this compilation. Known agents: travel_agent, billing_agent',
      ]),
    );
    expect(messages.warnings).toEqual([]);
  });

  it('does not pull in unrelated sibling errors that only mention target names in known-agents context', () => {
    const output = makeCompilationOutput({
      agents: {
        travel_agent: { metadata: { name: 'travel_agent' } } as never,
        billing_agent: { metadata: { name: 'billing_agent' } } as never,
      },
      compilation_errors: [
        {
          agent: 'billing_agent',
          message:
            'Handoff target "ghost_agent" does not exist in this compilation. Known agents: travel_agent, billing_agent',
          type: 'validation',
          severity: 'error',
          code: VALIDATION_CODES.INVALID_HANDOFF_TARGET,
          path: 'coordination.handoffs[0].to',
          referenced_agent: 'ghost_agent',
        },
      ],
    });

    const messages = collectTargetCompilationMessages(output, ['travel_agent', 'booking_agent']);

    expect(messages.errors).toEqual([]);
    expect(messages.warnings).toEqual([]);
  });
});
