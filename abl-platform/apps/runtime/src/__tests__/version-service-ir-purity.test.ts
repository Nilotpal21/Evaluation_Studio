import { describe, it, expect } from 'vitest';
import { createHash } from 'crypto';
import type { AgentIR } from '@abl/compiler';
import { VersionService, type VersionServiceDeps } from '../services/version-service.js';

/**
 * Locks in the Model Resolution Contract (ABLP-383): `createVersion()` must
 * persist `AgentVersion.irContent` exactly as the compiler produced it,
 * without mutating `execution.model`, `execution.temperature`,
 * `execution.max_tokens`, or `execution.operation_models` from any database
 * policy (e.g., AgentModelConfig). Runtime `ModelResolutionService` Level 2
 * is the sole owner of those fields; baking them in at save time
 * short-circuits the live resolution chain.
 *
 * Uses real `@abl/core` + `@abl/compiler` — no mocking. Repository seams are
 * injected via `VersionServiceDeps` so the test runs without a database and
 * without violating `.claude/hooks/platform-mock-lint.sh`.
 */

interface CapturedCreate {
  agentId: string;
  version: string;
  dslContent: string;
  irContent: string;
  sourceHash: string;
  toolSnapshot?: Array<{
    name: string;
    projectToolId: string;
    sourceHash: string;
    runtimeMetadataHash?: string;
    toolType: string;
    description: string | null;
    dslContent: string;
  }>;
}

function makeTestDeps(): {
  deps: VersionServiceDeps;
  captured: {
    create: CapturedCreate | null;
    cachedIRs: AgentIR[];
    toolSnapshotUpdate: {
      versionId: string;
      agentId: string;
      toolSnapshot: CapturedCreate['toolSnapshot'];
    } | null;
  };
} {
  const captured = {
    create: null as CapturedCreate | null,
    cachedIRs: [] as AgentIR[],
    toolSnapshotUpdate: null as {
      versionId: string;
      agentId: string;
      toolSnapshot: CapturedCreate['toolSnapshot'];
    } | null,
  };

  const deps: VersionServiceDeps = {
    findProjectAgentForProject: async () => {
      return {
        id: 'agent-internal-id',
        _id: 'agent-internal-id',
        tenantId: 'tenant-a',
        projectId: 'proj-a',
        name: 'Test_Agent',
      } as any;
    },
    loadProjectConfigVariables: async () => ({}),
    findLatestAgentVersion: async () => null,
    cacheAgentIR: async (ir) => {
      captured.cachedIRs.push(ir);
    },
    createAgentVersion: async (data: any) => {
      captured.create = {
        agentId: data.agentId,
        version: data.version,
        dslContent: data.dslContent,
        irContent: data.irContent,
        sourceHash: data.sourceHash,
        toolSnapshot: data.toolSnapshot,
      };
      return {
        id: 'version-internal-id',
        _id: 'version-internal-id',
        ...data,
      } as any;
    },
    updateAgentVersionToolSnapshot: async (versionId, agentId, toolSnapshot) => {
      captured.toolSnapshotUpdate = {
        versionId,
        agentId,
        toolSnapshot: toolSnapshot ?? undefined,
      };
      return { matchedCount: 1, modifiedCount: 1 };
    },
  };

  return { deps, captured };
}

describe('VersionService createVersion — IR content purity', () => {
  it('does not inject model/temperature/max_tokens/operation_models when DSL omits them', async () => {
    const dsl = `AGENT: Test_Agent

GOAL: "Answer questions"

PERSONA: "Helpful assistant"
`;

    const { deps, captured } = makeTestDeps();
    const svc = new VersionService(deps);

    const result = await svc.createVersion({
      projectId: 'proj-a',
      agentName: 'Test_Agent',
      dslContent: dsl,
      version: '1.0.0',
      createdBy: 'user-a',
      tenantId: 'tenant-a',
    });

    expect(result.compileErrors).toBeUndefined();
    expect(captured.create).not.toBeNull();

    const parsed = JSON.parse(captured.create!.irContent);
    const agentIR = parsed.agents?.Test_Agent;
    expect(agentIR, 'compiled IR for Test_Agent must be present in stored irContent').toBeDefined();

    const exec = agentIR.execution ?? {};
    expect(exec.model, 'execution.model must NOT be populated from DB policy').toBeUndefined();
    expect(
      exec.temperature,
      'execution.temperature must NOT be populated from DB policy',
    ).toBeUndefined();
    expect(
      exec.max_tokens,
      'execution.max_tokens must NOT be populated from DB policy',
    ).toBeUndefined();
    expect(
      exec.operation_models,
      'execution.operation_models must NOT be populated from DB policy',
    ).toBeUndefined();
  });

  it('preserves DSL-declared execution fields verbatim into stored irContent', async () => {
    const dsl = `AGENT: Test_Agent

EXECUTION:
  model: "anthropic/claude-sonnet-4"
  temperature: 0.42
  max_tokens: 1234

GOAL: "Answer questions"

PERSONA: "Helpful assistant"
`;

    const { deps, captured } = makeTestDeps();
    const svc = new VersionService(deps);

    const result = await svc.createVersion({
      projectId: 'proj-a',
      agentName: 'Test_Agent',
      dslContent: dsl,
      version: '1.0.0',
      createdBy: 'user-a',
      tenantId: 'tenant-a',
    });

    expect(result.compileErrors).toBeUndefined();
    const parsed = JSON.parse(captured.create!.irContent);
    const exec = parsed.agents?.Test_Agent?.execution ?? {};

    expect(exec.model).toBe('anthropic/claude-sonnet-4');
    expect(exec.temperature).toBe(0.42);
    expect(exec.max_tokens).toBe(1234);
  });

  it('returns target-agent compilation errors without caching or persisting an unsafe version', async () => {
    const dsl = `AGENT: Test_Agent

GOAL: "Collect account values"

GATHER:
  account:
    PROMPT: "What is your account?"
    TYPE: string
    extraction_pattern: "(a+)+$"
`;

    const { deps, captured } = makeTestDeps();
    const svc = new VersionService(deps);

    const result = await svc.createVersion({
      projectId: 'proj-a',
      agentName: 'Test_Agent',
      dslContent: dsl,
      version: '1.0.0',
      createdBy: 'user-a',
      tenantId: 'tenant-a',
    });

    expect(result.versionId).toBe('');
    expect(result.compileErrors).toEqual([expect.stringContaining('unsafe extraction_pattern')]);
    expect(result.compileErrors?.[0]).toContain('Nested quantifiers');
    expect(captured.create).toBeNull();
    expect(captured.cachedIRs).toHaveLength(0);
  });

  it('returns peer-agent compilation errors without caching or persisting unsafe batch IR', async () => {
    const dsl = `AGENT: Test_Agent

GOAL: "Route account requests"
`;
    const peerDsl = `AGENT: Peer_Agent

GOAL: "Collect account values"

GATHER:
  account:
    PROMPT: "What is your account?"
    TYPE: string
    extraction_pattern: "(a+)+$"
`;

    const { deps, captured } = makeTestDeps();
    const svc = new VersionService(deps);

    const result = await svc.createVersion({
      projectId: 'proj-a',
      agentName: 'Test_Agent',
      dslContent: dsl,
      version: '1.0.0',
      createdBy: 'user-a',
      tenantId: 'tenant-a',
      peerDsls: [peerDsl],
    });

    expect(result.versionId).toBe('');
    expect(result.compileErrors).toEqual([expect.stringContaining('unsafe extraction_pattern')]);
    expect(result.compileErrors?.[0]).toContain('Peer_Agent');
    expect(captured.create).toBeNull();
    expect(captured.cachedIRs).toHaveLength(0);
  });

  it('returns peer-agent parse errors without caching or persisting a partial batch IR', async () => {
    const dsl = `AGENT: Test_Agent

GOAL: "Route account requests"
`;
    const peerDsl = `GOAL: "Malformed peer without an agent header"
`;

    const { deps, captured } = makeTestDeps();
    const svc = new VersionService(deps);

    const result = await svc.createVersion({
      projectId: 'proj-a',
      agentName: 'Test_Agent',
      dslContent: dsl,
      version: '1.0.0',
      createdBy: 'user-a',
      tenantId: 'tenant-a',
      peerDsls: [peerDsl],
    });

    expect(result.versionId).toBe('');
    expect(result.compileErrors).toEqual([expect.stringContaining('Peer DSL parse failed')]);
    expect(captured.create).toBeNull();
    expect(captured.cachedIRs).toHaveLength(0);
  });

  it('fails closed when authored project tool resolution reports a missing tool', async () => {
    const dsl = `AGENT: Test_Agent

GOAL: "Answer questions"

TOOLS:
  missing_tool(query: string) -> object
`;

    const { deps, captured } = makeTestDeps();
    (deps as any).resolveToolImplementationsForVersion = async () => ({
      resolvedByAgent: new Map(),
      errors: [
        {
          code: 'E721',
          message: "ProjectTool 'missing_tool' not found",
          location: 'Test_Agent.tools.missing_tool',
        },
      ],
    });
    const svc = new VersionService(deps);

    const result = await svc.createVersion({
      projectId: 'proj-a',
      agentName: 'Test_Agent',
      dslContent: dsl,
      version: '1.0.0',
      createdBy: 'user-a',
      tenantId: 'tenant-a',
    });

    expect(result.versionId).toBe('');
    expect(result.compileErrors).toEqual([expect.stringContaining('E721')]);
    expect(captured.create).toBeNull();
    expect(captured.cachedIRs).toHaveLength(0);
  });

  it('fails closed when a peer agent references a missing authored project tool', async () => {
    const dsl = `AGENT: Test_Agent

GOAL: "Route requests"
`;
    const peerDsl = `AGENT: Peer_Agent

GOAL: "Handle peer work"

TOOLS:
  missing_peer_tool(query: string) -> object
`;

    const { deps, captured } = makeTestDeps();
    let capturedToolsByAgent: Map<string, string[]> | null = null;
    (deps as any).findProjectToolsForVersionSnapshot = async () => [];
    (deps as any).resolveToolImplementationsForVersion = async ({ toolsByAgent }: any) => {
      capturedToolsByAgent = new Map(toolsByAgent);
      return {
        resolvedByAgent: new Map(),
        errors: [
          {
            code: 'E721',
            message: "ProjectTool 'missing_peer_tool' not found",
            location: 'Peer_Agent.tools.missing_peer_tool',
          },
        ],
      };
    };
    const svc = new VersionService(deps);

    const result = await svc.createVersion({
      projectId: 'proj-a',
      agentName: 'Test_Agent',
      dslContent: dsl,
      version: '1.0.0',
      createdBy: 'user-a',
      tenantId: 'tenant-a',
      peerDsls: [peerDsl],
    });

    expect(capturedToolsByAgent?.get('Peer_Agent')).toEqual(['missing_peer_tool']);
    expect(result.versionId).toBe('');
    expect(result.compileErrors).toEqual([expect.stringContaining('E721')]);
    expect(captured.create).toBeNull();
    expect(captured.cachedIRs).toHaveLength(0);
  });

  it('derives tool snapshot hashes from current DSL content and preserves workflow tool type', async () => {
    const workflowToolDsl = [
      'run_flow(payload: object) -> object',
      '  description: "Run flow"',
      '  type: workflow',
      '  workflow_id: wf-1',
      '  trigger_id: tr-1',
    ].join('\n');
    const expectedToolHash = createHash('sha256').update(workflowToolDsl).digest('hex');
    const dsl = `AGENT: Test_Agent

GOAL: "Run workflows"

TOOLS:
  run_flow(payload: object) -> object
`;

    const { deps, captured } = makeTestDeps();
    (deps as any).resolveToolImplementationsForVersion = async () => ({
      resolvedByAgent: new Map([
        [
          'Test_Agent',
          [
            {
              name: 'run_flow',
              description: 'Run flow',
              parameters: [{ name: 'payload', type: 'object', required: true }],
              returns: { type: 'object' },
              hints: {
                cacheable: false,
                latency: 'medium',
                parallelizable: true,
                side_effects: true,
                requires_auth: false,
              },
              tool_type: 'workflow',
              workflow_binding: {
                workflowId: 'wf-1',
                triggerId: 'tr-1',
                mode: 'sync',
                paramMapping: {},
              },
            },
          ],
        ],
      ]),
      errors: [],
    });
    (deps as any).findProjectToolsForVersionSnapshot = async () => [
      {
        _id: 'tool-1',
        name: 'run_flow',
        sourceHash: 'stale-persisted-hash',
        toolType: 'workflow',
        description: 'Run flow',
        dslContent: workflowToolDsl,
      },
    ];
    const svc = new VersionService(deps);

    const result = await svc.createVersion({
      projectId: 'proj-a',
      agentName: 'Test_Agent',
      dslContent: dsl,
      version: '1.0.0',
      createdBy: 'user-a',
      tenantId: 'tenant-a',
    });

    expect(result.compileErrors).toBeUndefined();
    expect(captured.create?.toolSnapshot).toEqual([
      expect.objectContaining({
        name: 'run_flow',
        projectToolId: 'tool-1',
        sourceHash: expectedToolHash,
        toolType: 'workflow',
        dslContent: workflowToolDsl,
      }),
    ]);
  });

  it('refreshes the persisted tool snapshot when createVersion deduplicates', async () => {
    const workflowToolDsl = [
      'run_flow(payload: object) -> object',
      '  description: "Run flow"',
      '  type: workflow',
      '  workflow_id: wf-1',
      '  trigger_id: tr-1',
    ].join('\n');
    const dsl = `AGENT: Test_Agent

GOAL: "Run workflows"

TOOLS:
  run_flow(payload: object) -> object
`;

    const { deps, captured } = makeTestDeps();
    (deps as any).resolveToolImplementationsForVersion = async () => ({
      resolvedByAgent: new Map([
        [
          'Test_Agent',
          [
            {
              name: 'run_flow',
              description: 'Run flow',
              parameters: [{ name: 'payload', type: 'object', required: true }],
              returns: { type: 'object' },
              hints: {
                cacheable: false,
                latency: 'medium',
                parallelizable: true,
                side_effects: true,
                requires_auth: false,
              },
              tool_type: 'workflow',
              workflow_binding: {
                workflowId: 'wf-1',
                triggerId: 'tr-1',
                mode: 'sync',
                paramMapping: {},
              },
            },
          ],
        ],
      ]),
      errors: [],
    });
    (deps as any).findProjectToolsForVersionSnapshot = async () => [
      {
        _id: 'tool-1',
        name: 'run_flow',
        sourceHash: 'stale-persisted-hash',
        toolType: 'workflow',
        description: 'Run flow',
        dslContent: workflowToolDsl,
      },
    ];

    const svc = new VersionService(deps);
    const first = await svc.createVersion({
      projectId: 'proj-a',
      agentName: 'Test_Agent',
      dslContent: dsl,
      version: '1.0.0',
      createdBy: 'user-a',
      tenantId: 'tenant-a',
    });

    expect(first.compileErrors).toBeUndefined();
    expect(captured.create?.sourceHash).toBeTruthy();
    const firstSourceHash = captured.create!.sourceHash;
    captured.create = null;

    deps.findLatestAgentVersion = async () =>
      ({
        id: 'existing-version',
        _id: 'existing-version',
        version: '1.0.0',
        sourceHash: firstSourceHash,
        toolSnapshot: [
          {
            name: 'run_flow',
            projectToolId: 'tool-1',
            sourceHash: 'old-snapshot-hash',
            toolType: 'workflow',
            description: 'Run flow',
            dslContent: workflowToolDsl,
          },
        ],
      }) as any;

    const second = await svc.createVersion({
      projectId: 'proj-a',
      agentName: 'Test_Agent',
      dslContent: dsl,
      version: '1.0.1',
      createdBy: 'user-a',
      tenantId: 'tenant-a',
    });

    expect(second.deduplicated).toBe(true);
    expect(second.toolSnapshotRefresh).toEqual({
      attempted: true,
      matchedCount: 1,
      modifiedCount: 1,
      refreshed: true,
    });
    expect(captured.create).toBeNull();
    expect(captured.toolSnapshotUpdate).toEqual({
      versionId: 'existing-version',
      agentId: 'agent-internal-id',
      toolSnapshot: [
        expect.objectContaining({
          name: 'run_flow',
          projectToolId: 'tool-1',
          sourceHash: createHash('sha256').update(workflowToolDsl).digest('hex'),
          toolType: 'workflow',
          dslContent: workflowToolDsl,
        }),
      ],
    });
  });

  it('does not deduplicate when only tool runtime namespace metadata changes', async () => {
    const workflowToolDsl = [
      'run_flow(payload: object) -> object',
      '  description: "Run flow"',
      '  type: workflow',
      '  workflow_id: wf-1',
      '  trigger_id: tr-1',
    ].join('\n');
    const dsl = `AGENT: Test_Agent

GOAL: "Run workflows"

TOOLS:
  run_flow(payload: object) -> object
`;

    const { deps, captured } = makeTestDeps();
    (deps as any).resolveToolImplementationsForVersion = async () => ({
      resolvedByAgent: new Map([
        [
          'Test_Agent',
          [
            {
              name: 'run_flow',
              description: 'Run flow',
              parameters: [{ name: 'payload', type: 'object', required: true }],
              returns: { type: 'object' },
              hints: {
                cacheable: false,
                latency: 'medium',
                parallelizable: true,
                side_effects: true,
                requires_auth: false,
              },
              tool_type: 'workflow',
              workflow_binding: {
                workflowId: 'wf-1',
                triggerId: 'tr-1',
                mode: 'sync',
                paramMapping: {},
              },
            },
          ],
        ],
      ]),
      errors: [],
    });

    let variableNamespaceIds = ['ns-default'];
    (deps as any).findProjectToolsForVersionSnapshot = async () => [
      {
        _id: 'tool-1',
        name: 'run_flow',
        sourceHash: 'stored-hash',
        toolType: 'workflow',
        description: 'Run flow',
        dslContent: workflowToolDsl,
        variableNamespaceIds,
      },
    ];

    const svc = new VersionService(deps);
    const first = await svc.createVersion({
      projectId: 'proj-a',
      agentName: 'Test_Agent',
      dslContent: dsl,
      version: '1.0.0',
      createdBy: 'user-a',
      tenantId: 'tenant-a',
    });

    expect(first.compileErrors).toBeUndefined();
    expect(captured.create?.toolSnapshot?.[0]?.runtimeMetadataHash).toBeTruthy();
    const firstSourceHash = captured.create!.sourceHash;
    const firstRuntimeMetadataHash = captured.create!.toolSnapshot![0].runtimeMetadataHash;

    deps.findLatestAgentVersion = async () =>
      ({
        id: 'existing-version',
        _id: 'existing-version',
        version: '1.0.0',
        sourceHash: firstSourceHash,
      }) as any;
    captured.create = null;
    variableNamespaceIds = ['ns-secure'];

    const second = await svc.createVersion({
      projectId: 'proj-a',
      agentName: 'Test_Agent',
      dslContent: dsl,
      version: '1.0.1',
      createdBy: 'user-a',
      tenantId: 'tenant-a',
    });

    expect(second.compileErrors).toBeUndefined();
    expect(second.deduplicated).toBeUndefined();
    expect(captured.create).not.toBeNull();
    expect(captured.create!.sourceHash).not.toBe(firstSourceHash);
    expect(captured.create!.toolSnapshot![0].runtimeMetadataHash).not.toBe(
      firstRuntimeMetadataHash,
    );
  });

  it('does not deduplicate when only the prompt-library version id changes', async () => {
    const dsl = `AGENT: Test_Agent

GOAL: "Answer questions"
`;

    const { deps, captured } = makeTestDeps();
    (deps as any).resolvePromptLibraryRefForVersion = async (document: unknown) => {
      const doc = document as {
        systemPrompt?: string | null;
        systemPromptLibraryRef?: {
          promptId: string;
          versionId: string;
          resolvedHash?: string;
        } | null;
      };

      doc.systemPrompt = 'Shared prompt template';
      if (doc.systemPromptLibraryRef) {
        doc.systemPromptLibraryRef.resolvedHash = 'prompt-template-hash';
      }
    };

    const svc = new VersionService(deps);

    const first = await svc.createVersion({
      projectId: 'proj-a',
      agentName: 'Test_Agent',
      dslContent: dsl,
      version: '1.0.0',
      createdBy: 'user-a',
      tenantId: 'tenant-a',
      libraryRef: { promptId: 'prompt-1', versionId: 'version-1' },
    });

    expect(first.compileErrors).toBeUndefined();
    expect(captured.create).not.toBeNull();
    const firstHash = captured.create!.sourceHash;

    deps.findLatestAgentVersion = async () =>
      ({
        id: 'existing-version',
        _id: 'existing-version',
        version: '1.0.0',
        sourceHash: firstHash,
      }) as any;
    captured.create = null;

    const second = await svc.createVersion({
      projectId: 'proj-a',
      agentName: 'Test_Agent',
      dslContent: dsl,
      version: '1.0.1',
      createdBy: 'user-a',
      tenantId: 'tenant-a',
      libraryRef: { promptId: 'prompt-1', versionId: 'version-2' },
    });

    expect(second.compileErrors).toBeUndefined();
    expect(second.deduplicated).toBeUndefined();
    expect(captured.create).not.toBeNull();
    expect(captured.create!.sourceHash).not.toBe(firstHash);

    const parsed = JSON.parse(captured.create!.irContent);
    expect(parsed.agents?.Test_Agent?.identity?.system_prompt?.libraryRef).toEqual({
      promptId: 'prompt-1',
      versionId: 'version-2',
      resolvedHash: 'prompt-template-hash',
    });
  });

  it('compiles standalone stored behavior profiles into version IR', async () => {
    const dsl = `AGENT: Test_Agent

GOAL: "Answer questions"

USE BEHAVIOR_PROFILE: voice_profile
`;

    const { deps, captured } = makeTestDeps();
    deps.loadProjectConfigVariables = async () => ({
      'profile:voice_profile': `BEHAVIOR_PROFILE: voice_profile
PRIORITY: 10
WHEN: channel.name == "voice"

CONVERSATION:
  speaking:
    style: warm
`,
    });
    const svc = new VersionService(deps);

    const result = await svc.createVersion({
      projectId: 'proj-a',
      agentName: 'Test_Agent',
      dslContent: dsl,
      version: '1.0.0',
      createdBy: 'user-a',
      tenantId: 'tenant-a',
    });

    expect(result.compileErrors).toBeUndefined();
    const parsed = JSON.parse(captured.create!.irContent);
    expect(parsed.agents?.Test_Agent?.behavior_profiles?.[0]).toMatchObject({
      name: 'voice_profile',
      conversation_behavior: {
        speaking: {
          style: 'warm',
        },
      },
    });
  });
});
