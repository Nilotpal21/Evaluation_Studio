/**
 * Deployment Build Service Tests
 *
 * Tests for buildDeploymentModuleSnapshot covering:
 * - Non-module fast path (no dependencies)
 * - Project not found
 * - Dependency version mismatch
 * - Successful build (resolves, rewrites, compresses, stores)
 * - Selector resolution failure (release not found, pointer not found)
 * - Symbol collision
 * - Size enforcement (>8 MB)
 * - Symbol count limit (>250)
 * - Diagnostics capped at 10
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentIR } from '@abl/compiler';
import zlib from 'node:zlib';

// ─── Mock DB models ──────────────────────────────────────────────────────────

const mockCountDocuments = vi.fn();
const mockDepFind = vi.fn();
const mockProjectFindOne = vi.fn();
const mockReleaseFindOne = vi.fn();
const mockSnapshotCreate = vi.fn();
const mockSnapshotFindOne = vi.fn();
const mockLoadConfigVariablesMap = vi.fn();
const mockEnvironmentVariableFind = vi.fn();
const mockMcpServerConfigFind = vi.fn();
const mockConnectorConnectionFind = vi.fn();
const mockAuthProfileFindOne = vi.fn();
const mockToolSecretFind = vi.fn();

vi.mock('@agent-platform/database/models', () => ({
  ProjectModuleDependency: {
    countDocuments: (...args: unknown[]) => mockCountDocuments(...args),
    find: (...args: unknown[]) => ({ lean: () => mockDepFind(...args) }),
  },
  ModuleRelease: {
    findOne: (...args: unknown[]) => ({ lean: () => mockReleaseFindOne(...args) }),
  },
  DeploymentModuleSnapshot: {
    create: (...args: unknown[]) => mockSnapshotCreate(...args),
    findOne: (...args: unknown[]) => ({ lean: () => mockSnapshotFindOne(...args) }),
  },
  Project: {
    findOne: (...args: unknown[]) => ({ lean: () => mockProjectFindOne(...args) }),
  },
  EnvironmentVariable: {
    find: (...args: unknown[]) => ({
      select: () => ({ lean: () => mockEnvironmentVariableFind(...args) }),
      lean: () => mockEnvironmentVariableFind(...args),
    }),
  },
  MCPServerConfig: {
    find: (...args: unknown[]) => ({
      select: () => ({ lean: () => mockMcpServerConfigFind(...args) }),
      lean: () => mockMcpServerConfigFind(...args),
    }),
  },
  ConnectorConnection: {
    find: (...args: unknown[]) => ({
      select: () => ({ lean: () => mockConnectorConnectionFind(...args) }),
      lean: () => mockConnectorConnectionFind(...args),
    }),
  },
  AuthProfile: {
    findOne: (...args: unknown[]) => ({
      lean: () => mockAuthProfileFindOne(...args),
    }),
  },
  ToolSecret: {
    find: (...args: unknown[]) => ({
      select: () => ({ lean: () => mockToolSecretFind(...args) }),
      lean: () => mockToolSecretFind(...args),
    }),
  },
}));

// ─── Mock resolveSelector ────────────────────────────────────────────────────

const mockResolveSelector = vi.fn();
const mockMaterializeModuleToolDefinition = vi.fn();

vi.mock('@agent-platform/project-io', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-platform/project-io')>();
  return {
    ...actual,
    resolveSelector: (...args: unknown[]) => mockResolveSelector(...args),
    materializeModuleToolDefinition: (...args: unknown[]) =>
      mockMaterializeModuleToolDefinition(...args),
  };
});

// ─── Mock alias rewriter ─────────────────────────────────────────────────────

const mockRewriteModuleIR = vi.fn();

vi.mock('../module-alias-rewriter.js', () => ({
  rewriteModuleIR: (...args: unknown[]) => mockRewriteModuleIR(...args),
}));

vi.mock('../../../repos/project-repo.js', () => ({
  loadConfigVariablesMap: (...args: unknown[]) => mockLoadConfigVariablesMap(...args),
}));

// ─── Import under test (after mocks) ────────────────────────────────────────

import {
  buildDeploymentModuleSnapshot,
  cloneDeploymentModuleSnapshot,
} from '../deployment-build-service.js';

// ─── Test helpers ────────────────────────────────────────────────────────────

const TENANT = 'tenant-1';
const PROJECT = 'project-1';
const DEPLOYMENT = 'deploy-1';
const DEP_VERSION = 5;

function makeAgentIR(name: string): AgentIR {
  return {
    metadata: { name, version: '1.0' },
    model: { provider: 'openai', model_name: 'gpt-4' },
    tools: [],
  } as unknown as AgentIR;
}

function makeAgentDsl(name: string, tools: string[] = []): string {
  const lines = [`AGENT: ${name}`, `GOAL: Handle ${name} requests.`];
  if (tools.length > 0) {
    lines.push('', 'TOOLS:');
    for (const tool of tools) {
      lines.push(`  ${tool}() -> string`, `    description: "Call ${tool}"`);
    }
  }

  return lines.join('\n');
}

function makeDependency(alias: string, moduleProjectId: string) {
  return {
    alias,
    moduleProjectId,
    selector: { type: 'version', value: '1.0.0' },
    resolvedReleaseId: `release-${alias}`,
  };
}

function makeRelease(agents: Record<string, unknown>, tools: Record<string, unknown> = {}) {
  const artifactAgents = Object.fromEntries(
    Object.entries(agents).map(([agentName, agentValue]) => {
      if (
        agentValue &&
        typeof agentValue === 'object' &&
        'dslContent' in agentValue &&
        'sourceHash' in agentValue &&
        !('companion' in agentValue)
      ) {
        return [
          agentName,
          {
            ...agentValue,
            // Force legacy fallback in unit helpers that still provide placeholder DSL.
            companion: {
              systemPromptLibraryRef: {
                promptId: `prompt-${agentName}`,
                versionId: 'version-1',
              },
            },
          },
        ];
      }

      return [agentName, agentValue];
    }),
  );

  return {
    _id: 'release-123',
    artifact: { agents: artifactAgents, tools },
    compiledIR: agents,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('buildDeploymentModuleSnapshot', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadConfigVariablesMap.mockResolvedValue({});
    mockEnvironmentVariableFind.mockResolvedValue([]);
    mockMcpServerConfigFind.mockResolvedValue([]);
    mockConnectorConnectionFind.mockResolvedValue([]);
    mockAuthProfileFindOne.mockResolvedValue(null);
    mockToolSecretFind.mockResolvedValue([]);
    mockMaterializeModuleToolDefinition.mockImplementation((dslContent: unknown) => ({
      name: typeof dslContent === 'string' ? dslContent.replace(/^TOOL:\s*/, '') : 'tool',
      description: 'Materialized tool',
      parameters: [],
      returns: { type: 'string' },
      hints: {
        cacheable: false,
        latency: 'medium',
        parallelizable: true,
        side_effects: false,
        requires_auth: false,
      },
      tool_type: 'http',
      http_binding: { method: 'GET', endpoint: 'https://materialized.example.com/tool' },
    }));
  });

  // ── Fast path ────────────────────────────────────────────────────────────

  describe('non-module fast path', () => {
    it('returns null when no module dependencies exist', async () => {
      mockCountDocuments.mockResolvedValue(0);

      const result = await buildDeploymentModuleSnapshot(
        TENANT,
        PROJECT,
        DEPLOYMENT,
        DEP_VERSION,
        new Set(),
      );

      expect(result).toBeNull();
      expect(mockCountDocuments).toHaveBeenCalledWith({ tenantId: TENANT, projectId: PROJECT });
      // Should not call any other DB methods
      expect(mockProjectFindOne).not.toHaveBeenCalled();
      expect(mockDepFind).not.toHaveBeenCalled();
      expect(mockReleaseFindOne).not.toHaveBeenCalled();
      expect(mockSnapshotCreate).not.toHaveBeenCalled();
    });
  });

  // ── Project not found ────────────────────────────────────────────────────

  describe('project not found', () => {
    it('returns error when project does not exist', async () => {
      mockCountDocuments.mockResolvedValue(1);
      mockProjectFindOne.mockResolvedValue(null);

      const result = await buildDeploymentModuleSnapshot(
        TENANT,
        PROJECT,
        DEPLOYMENT,
        DEP_VERSION,
        new Set(),
      );

      expect(result).toEqual({
        success: false,
        mountedAgentCount: 0,
        mountedToolCount: 0,
        diagnostics: [
          {
            severity: 'error',
            code: 'PROJECT_NOT_FOUND',
            source: 'build',
            message: 'Project not found',
          },
        ],
      });
    });
  });

  // ── Dependency version mismatch ──────────────────────────────────────────

  describe('dependency version mismatch', () => {
    it('returns error when project moduleDependencyVersion differs from expected', async () => {
      mockCountDocuments.mockResolvedValue(2);
      mockProjectFindOne.mockResolvedValue({ _id: PROJECT, moduleDependencyVersion: 3 });

      const result = await buildDeploymentModuleSnapshot(
        TENANT,
        PROJECT,
        DEPLOYMENT,
        DEP_VERSION, // 5
        new Set(),
      );

      expect(result).not.toBeNull();
      expect(result!.success).toBe(false);
      expect(result!.diagnostics[0].code).toBe('DEPENDENCY_VERSION_MISMATCH');
      expect(result!.diagnostics[0].message).toContain('v5');
      expect(result!.diagnostics[0].message).toContain('v3');
    });

    it('treats missing moduleDependencyVersion as 0', async () => {
      mockCountDocuments.mockResolvedValue(1);
      mockProjectFindOne.mockResolvedValue({ _id: PROJECT }); // no moduleDependencyVersion field

      const result = await buildDeploymentModuleSnapshot(
        TENANT,
        PROJECT,
        DEPLOYMENT,
        1, // expected = 1, current = 0 (default)
        new Set(),
      );

      expect(result!.success).toBe(false);
      expect(result!.diagnostics[0].code).toBe('DEPENDENCY_VERSION_MISMATCH');
    });
  });

  // ── Successful build ─────────────────────────────────────────────────────

  describe('successful build', () => {
    it('resolves dependencies, rewrites IR, creates compressed snapshot', async () => {
      const agentIR = makeAgentIR('main');

      mockCountDocuments.mockResolvedValue(1);
      mockProjectFindOne.mockResolvedValue({
        _id: PROJECT,
        moduleDependencyVersion: DEP_VERSION,
      });
      mockDepFind.mockResolvedValue([makeDependency('payments', 'mod-proj-1')]);
      mockResolveSelector.mockResolvedValue({ releaseId: 'release-payments', version: '1.0.0' });
      mockReleaseFindOne.mockResolvedValue(
        makeRelease(
          { main: { dslContent: makeAgentDsl('main', ['lookup']), sourceHash: 'h1' } },
          { lookup: { dslContent: 'TOOL: lookup', toolType: 'http', sourceHash: 'h2' } },
        ),
      );

      const aliasedAgentIR = {
        ...agentIR,
        metadata: { ...agentIR.metadata, name: 'payments__main' },
      };
      mockRewriteModuleIR.mockReturnValue({
        agents: { payments__main: aliasedAgentIR },
        tools: { payments__lookup: { tool_type: 'http' } },
        renameMap: { main: 'payments__main', lookup: 'payments__lookup' },
        collisions: [],
      });

      mockSnapshotCreate.mockResolvedValue({ _id: 'snap-123' });

      const result = await buildDeploymentModuleSnapshot(
        TENANT,
        PROJECT,
        DEPLOYMENT,
        DEP_VERSION,
        new Set(),
      );

      expect(result).not.toBeNull();
      expect(result!.success).toBe(true);
      expect(result!.snapshotId).toBe('snap-123');
      expect(result!.snapshotHash).toBeDefined();
      expect(result!.snapshotHash).toHaveLength(16);
      expect(result!.mountedAgentCount).toBe(1);
      expect(result!.mountedToolCount).toBe(1);
      expect(result!.diagnostics).toHaveLength(0);

      // Verify snapshot was created with correct fields
      expect(mockSnapshotCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: TENANT,
          projectId: PROJECT,
          deploymentId: DEPLOYMENT,
          snapshotHash: expect.any(String),
          compressedPayload: expect.any(Buffer),
          createdBy: 'system:deployment-build',
        }),
      );

      // Verify rewriter was called with legacy artifact agent data and resolved tool definitions.
      expect(mockRewriteModuleIR).toHaveBeenCalledWith(
        'payments',
        {
          main: expect.objectContaining({
            dslContent: makeAgentDsl('main', ['lookup']),
            sourceHash: 'h1',
          }),
        },
        {
          lookup: {
            definition: expect.objectContaining({
              name: 'lookup',
              http_binding: expect.objectContaining({
                endpoint: 'https://materialized.example.com/tool',
              }),
            }),
            toolType: 'http',
          },
        },
        expect.any(Set),
      );
    });

    it('materializes legacy tool artifacts when publish-time definitions are absent', async () => {
      mockCountDocuments.mockResolvedValue(1);
      mockProjectFindOne.mockResolvedValue({
        _id: PROJECT,
        moduleDependencyVersion: DEP_VERSION,
      });
      mockDepFind.mockResolvedValue([makeDependency('payments', 'mod-proj-1')]);
      mockResolveSelector.mockResolvedValue({ releaseId: 'release-payments', version: '1.0.0' });
      mockReleaseFindOne.mockResolvedValue(
        makeRelease(
          { main: { dslContent: makeAgentDsl('main', ['lookup']), sourceHash: 'h1' } },
          { lookup: { dslContent: 'TOOL: lookup', toolType: 'http', sourceHash: 'h2' } },
        ),
      );
      mockMaterializeModuleToolDefinition.mockReturnValue({
        name: 'lookup',
        description: 'Legacy lookup tool',
        parameters: [],
        returns: { type: 'string' },
        hints: {
          cacheable: false,
          latency: 'medium',
          parallelizable: true,
          side_effects: false,
          requires_auth: false,
        },
        tool_type: 'http',
        http_binding: { method: 'GET', endpoint: 'https://legacy.example.com/lookup' },
      });

      mockRewriteModuleIR.mockImplementation((alias, agents, tools) => ({
        agents: { [`${alias}__main`]: agents.main as AgentIR },
        tools: { [`${alias}__lookup`]: tools.lookup.definition as Record<string, unknown> },
        renameMap: { main: `${alias}__main`, lookup: `${alias}__lookup` },
        collisions: [],
      }));
      mockSnapshotCreate.mockResolvedValue({ _id: 'snap-legacy' });

      const result = await buildDeploymentModuleSnapshot(
        TENANT,
        PROJECT,
        DEPLOYMENT,
        DEP_VERSION,
        new Set(),
      );

      expect(result!.success).toBe(true);
      expect(mockMaterializeModuleToolDefinition).toHaveBeenCalledWith('TOOL: lookup', 'http');
      expect(mockRewriteModuleIR).toHaveBeenCalledWith(
        'payments',
        expect.any(Object),
        {
          lookup: {
            definition: expect.objectContaining({
              name: 'lookup',
              http_binding: expect.objectContaining({
                endpoint: 'https://legacy.example.com/lookup',
              }),
            }),
            toolType: 'http',
          },
        },
        expect.any(Set),
      );
    });

    it('applies merged project config and dependency overrides to mounted agents and tools', async () => {
      mockCountDocuments.mockResolvedValue(1);
      mockProjectFindOne.mockResolvedValue({
        _id: PROJECT,
        moduleDependencyVersion: DEP_VERSION,
      });
      mockLoadConfigVariablesMap.mockResolvedValue({
        API_BASE: 'https://project.example.com',
        REGION: 'us-east-1',
      });
      mockAuthProfileFindOne.mockResolvedValue({
        _id: 'auth-crm-shared',
        name: 'crm-shared',
        authType: 'api_key',
      });
      mockDepFind.mockResolvedValue([
        {
          ...makeDependency('payments', 'mod-proj-1'),
          configOverrides: {
            API_BASE: 'https://tenant.example.com',
            AUTH_PROFILE: 'crm-shared',
            SEARCH_INDEX: 'kb-prod',
            SEARCH_TENANT: TENANT,
            WORKFLOW_ID: 'wf-prod',
            WORKFLOW_TRIGGER_ID: 'tr-prod',
            WORKFLOW_TIMEOUT_MS: '90000',
            HTTP_TIMEOUT_MS: '12000',
            RETRY_COUNT: '3',
          },
        },
      ]);
      mockResolveSelector.mockResolvedValue({ releaseId: 'release-payments', version: '1.0.0' });

      const moduleAgent = {
        ...makeAgentIR('main'),
        identity: {
          goal: 'Call {{config.API_BASE}} from {{config.REGION}}',
        },
        tools: [
          {
            name: 'lookup',
            auth_profile_ref: '{{config.AUTH_PROFILE}}',
            variable_namespace_ids: ['source-ns'],
            searchai_binding: {
              tenantId: '{{config.SEARCH_TENANT}}',
              indexId: '{{config.SEARCH_INDEX}}',
            },
            workflow_binding: {
              workflowId: '{{config.WORKFLOW_ID}}',
              triggerId: '{{config.WORKFLOW_TRIGGER_ID}}',
              mode: 'sync',
              timeoutMs: '{{config.WORKFLOW_TIMEOUT_MS}}',
            },
          },
        ],
      } as unknown as AgentIR;

      mockReleaseFindOne.mockResolvedValue({
        _id: 'release-payments',
        contract: {
          requiredConfigKeys: [
            { key: 'API_BASE', isSecret: false },
            { key: 'AUTH_PROFILE', isSecret: false },
            { key: 'REGION', isSecret: false },
            { key: 'SEARCH_INDEX', isSecret: false },
            { key: 'SEARCH_TENANT', isSecret: false },
            { key: 'WORKFLOW_ID', isSecret: false },
            { key: 'WORKFLOW_TRIGGER_ID', isSecret: false },
            { key: 'WORKFLOW_TIMEOUT_MS', isSecret: false },
            { key: 'HTTP_TIMEOUT_MS', isSecret: false },
            { key: 'RETRY_COUNT', isSecret: false },
          ],
        },
        artifact: {
          agents: {
            main: {
              dslContent: makeAgentDsl('main'),
              sourceHash: 'h1',
              companion: {
                systemPromptLibraryRef: {
                  promptId: 'prompt-main',
                  versionId: 'version-1',
                },
              },
            },
          },
          tools: {
            lookup: {
              dslContent: 'TOOL: lookup',
              toolType: 'http',
              sourceHash: 'h2',
              definition: {
                name: 'lookup',
                description: 'Lookup {{config.REGION}} data',
                parameters: [],
                returns: { type: 'string' },
                hints: {
                  cacheable: false,
                  latency: 'medium',
                  parallelizable: true,
                  side_effects: false,
                  requires_auth: true,
                  timeout: '{{config.HTTP_TIMEOUT_MS}}',
                },
                tool_type: 'http',
                auth_profile_ref: '{{config.AUTH_PROFILE}}',
                http_binding: {
                  method: 'GET',
                  endpoint: '{{config.API_BASE}}/lookup',
                  timeout_ms: '{{config.HTTP_TIMEOUT_MS}}',
                  retry: {
                    count: '{{config.RETRY_COUNT}}',
                    delay_ms: '250',
                  },
                  headers: {
                    'X-Region': '{{config.REGION}}',
                  },
                },
              },
            },
          },
        },
        compiledIR: { main: moduleAgent },
      });

      mockRewriteModuleIR.mockImplementation((alias, agents, tools) => ({
        agents: { [`${alias}__main`]: agents.main as AgentIR },
        tools: { [`${alias}__lookup`]: tools.lookup.definition as Record<string, unknown> },
        renameMap: { main: `${alias}__main`, lookup: `${alias}__lookup` },
        collisions: [],
      }));
      mockSnapshotCreate.mockResolvedValue({ _id: 'snap-configured' });

      const result = await buildDeploymentModuleSnapshot(
        TENANT,
        PROJECT,
        DEPLOYMENT,
        DEP_VERSION,
        new Set(),
      );

      expect(result!.success).toBe(true);
      expect(mockMaterializeModuleToolDefinition).not.toHaveBeenCalled();

      expect(mockRewriteModuleIR).toHaveBeenCalledWith(
        'payments',
        {
          main: expect.objectContaining({
            identity: expect.objectContaining({
              goal: 'Call https://tenant.example.com from us-east-1',
            }),
            tools: [
              expect.objectContaining({
                auth_profile_ref: 'crm-shared',
                searchai_binding: {
                  tenantId: TENANT,
                  indexId: 'kb-prod',
                },
                workflow_binding: {
                  workflowId: 'wf-prod',
                  triggerId: 'tr-prod',
                  mode: 'sync',
                  timeoutMs: 90000,
                },
              }),
            ],
          }),
        },
        {
          lookup: {
            definition: expect.objectContaining({
              description: 'Lookup us-east-1 data',
              auth_profile_ref: 'crm-shared',
              hints: expect.objectContaining({
                timeout: 12000,
              }),
              http_binding: expect.objectContaining({
                endpoint: 'https://tenant.example.com/lookup',
                timeout_ms: 12000,
                retry: {
                  count: 3,
                  delay_ms: 250,
                },
                headers: {
                  'X-Region': 'us-east-1',
                },
              }),
            }),
            toolType: 'http',
          },
        },
        expect.any(Set),
      );

      const snapshotInput = mockSnapshotCreate.mock.calls[0][0] as {
        compressedPayload: Buffer;
      };
      const snapshotPayload = JSON.parse(
        zlib.gunzipSync(snapshotInput.compressedPayload).toString(),
      ) as {
        mountedAgents: Record<string, { ir: AgentIR }>;
        mountedTools: Record<string, { definition: Record<string, unknown> }>;
      };

      expect(snapshotPayload.mountedAgents.payments__main.ir.identity).toEqual({
        goal: 'Call https://tenant.example.com from us-east-1',
      });
      expect(snapshotPayload.mountedAgents.payments__main.ir.tools).toEqual([
        expect.objectContaining({
          auth_profile_ref: 'crm-shared',
        }),
      ]);
      expect(snapshotPayload.mountedTools.payments__lookup.definition).toEqual(
        expect.objectContaining({
          auth_profile_ref: 'crm-shared',
          hints: expect.objectContaining({
            timeout: 12000,
          }),
          http_binding: expect.objectContaining({
            endpoint: 'https://tenant.example.com/lookup',
            timeout_ms: 12000,
            retry: {
              count: 3,
              delay_ms: 250,
            },
          }),
        }),
      );
    });

    it('fails closed when legacy dependency compiled IR contains unresolved config keys', async () => {
      mockCountDocuments.mockResolvedValue(1);
      mockProjectFindOne.mockResolvedValue({
        _id: PROJECT,
        moduleDependencyVersion: DEP_VERSION,
      });
      mockLoadConfigVariablesMap.mockResolvedValue({ DECLARED_REGION: 'us-east-1' });
      mockDepFind.mockResolvedValue([
        {
          ...makeDependency('payments', 'mod-proj-1'),
          configOverrides: {
            UNDECLARED_BASE: 'https://stale-override.example.com',
          },
        },
      ]);
      mockResolveSelector.mockResolvedValue({ releaseId: 'release-payments', version: '1.0.0' });
      mockReleaseFindOne.mockResolvedValue({
        _id: 'release-payments',
        contract: {
          requiredConfigKeys: [{ key: 'DECLARED_REGION', isSecret: false }],
        },
        artifact: {
          agents: {
            main: {
              dslContent: makeAgentDsl('main'),
              sourceHash: 'h1',
              companion: {
                systemPromptLibraryRef: {
                  promptId: 'prompt-main',
                  versionId: 'version-1',
                },
              },
            },
          },
          tools: {},
        },
        compiledIR: {
          main: {
            ...makeAgentIR('main'),
            identity: {
              goal: 'Call {{config.UNDECLARED_BASE}}',
            },
          },
        },
      });
      mockRewriteModuleIR.mockImplementation((alias, agents) => ({
        agents: { [`${alias}__main`]: agents.main as AgentIR },
        tools: {},
        renameMap: { main: `${alias}__main` },
        collisions: [],
      }));
      mockSnapshotCreate.mockResolvedValue({ _id: 'snap-stale-override' });

      const result = await buildDeploymentModuleSnapshot(
        TENANT,
        PROJECT,
        DEPLOYMENT,
        DEP_VERSION,
        new Set(),
      );

      expect(result!.success).toBe(false);
      expect(result!.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            severity: 'error',
            code: 'UNRESOLVED_CONFIG_VARIABLE',
            source: 'dependency:payments:agent:main',
          }),
        ]),
      );
      expect(mockRewriteModuleIR).not.toHaveBeenCalled();
    });

    it('keeps standalone artifact tools mounted during deploy-time recompilation', async () => {
      mockCountDocuments.mockResolvedValue(1);
      mockProjectFindOne.mockResolvedValue({
        _id: PROJECT,
        moduleDependencyVersion: DEP_VERSION,
      });
      mockDepFind.mockResolvedValue([makeDependency('payments', 'mod-proj-1')]);
      mockResolveSelector.mockResolvedValue({ releaseId: 'release-payments', version: '1.0.0' });
      mockReleaseFindOne.mockResolvedValue({
        _id: 'release-payments',
        artifact: {
          agents: {
            main: {
              dslContent: makeAgentDsl('main'),
              sourceHash: 'h1',
            },
          },
          tools: {
            standalone_lookup: {
              dslContent: 'TOOL: standalone_lookup',
              toolType: 'http',
              sourceHash: 'h2',
              definition: {
                name: 'standalone_lookup',
                description: 'Standalone lookup',
                parameters: [],
                returns: { type: 'string' },
                hints: {
                  cacheable: false,
                  latency: 'medium',
                  parallelizable: true,
                  side_effects: false,
                  requires_auth: false,
                },
                tool_type: 'http',
                http_binding: {
                  method: 'GET',
                  endpoint: 'https://tenant.example.com/standalone',
                },
              },
            },
          },
        },
        compiledIR: {
          main: {
            ...makeAgentIR('main'),
            identity: { goal: 'stale compiled IR should not decide mounted tools' },
          },
        },
      });

      mockRewriteModuleIR.mockImplementation((alias, agents, tools) => ({
        agents: { [`${alias}__main`]: agents.main as AgentIR },
        tools: Object.fromEntries(
          Object.entries(tools as Record<string, { definition: Record<string, unknown> }>).map(
            ([toolName, toolEntry]) => [`${alias}__${toolName}`, toolEntry.definition],
          ),
        ),
        renameMap: {
          main: `${alias}__main`,
          standalone_lookup: `${alias}__standalone_lookup`,
        },
        collisions: [],
      }));
      mockSnapshotCreate.mockResolvedValue({ _id: 'snap-standalone-tool' });

      const result = await buildDeploymentModuleSnapshot(
        TENANT,
        PROJECT,
        DEPLOYMENT,
        DEP_VERSION,
        new Set(),
      );

      expect(result!.success).toBe(true);
      expect(result!.mountedToolCount).toBe(1);
      expect(mockRewriteModuleIR).toHaveBeenCalledWith(
        'payments',
        expect.any(Object),
        {
          standalone_lookup: {
            definition: expect.objectContaining({
              name: 'standalone_lookup',
              description: 'Standalone lookup',
            }),
            toolType: 'http',
          },
        },
        expect.any(Set),
      );
    });

    it('recompiles portable artifacts from source + prompt snapshots instead of trusting stale compiled IR', async () => {
      mockCountDocuments.mockResolvedValue(1);
      mockProjectFindOne.mockResolvedValue({
        _id: PROJECT,
        moduleDependencyVersion: DEP_VERSION,
      });
      mockLoadConfigVariablesMap.mockResolvedValue({
        CUSTOMER_NAME: 'source-project',
      });
      mockDepFind.mockResolvedValue([
        {
          ...makeDependency('payments', 'mod-proj-1'),
          configOverrides: {
            CUSTOMER_NAME: 'consumer-tenant',
          },
        },
      ]);
      mockResolveSelector.mockResolvedValue({ releaseId: 'release-payments', version: '1.0.0' });

      mockReleaseFindOne.mockResolvedValue({
        _id: 'release-payments',
        contract: {
          requiredConfigKeys: [{ key: 'CUSTOMER_NAME' }],
        },
        artifact: {
          agents: {
            main: {
              dslContent: [
                'AGENT: main',
                'GOAL: Serve {{config.CUSTOMER_NAME}}',
                'SYSTEM_PROMPT:',
                '  This line should be replaced by the prompt companion snapshot.',
              ].join('\n'),
              sourceHash: 'h1',
              companion: {
                systemPromptLibraryRef: {
                  promptId: 'prompt-1',
                  versionId: 'version-1',
                  resolvedHash: 'prompt-hash',
                },
                resolvedSystemPrompt: 'Imported prompt for {{config.CUSTOMER_NAME}}',
              },
            },
          },
          tools: {},
        },
        compiledIR: {
          main: {
            ...makeAgentIR('main'),
            identity: {
              goal: 'Serve stale-customer',
              system_prompt: {
                template: 'Stale runtime IR',
              },
            },
          },
        },
      });

      mockRewriteModuleIR.mockImplementation((alias, agents) => ({
        agents: { [`${alias}__main`]: agents.main as AgentIR },
        tools: {},
        renameMap: { main: `${alias}__main` },
        collisions: [],
      }));
      mockSnapshotCreate.mockResolvedValue({ _id: 'snap-recompiled' });

      const result = await buildDeploymentModuleSnapshot(
        TENANT,
        PROJECT,
        DEPLOYMENT,
        DEP_VERSION,
        new Set(),
      );

      expect(result!.success).toBe(true);
      expect(mockRewriteModuleIR).toHaveBeenCalledWith(
        'payments',
        {
          main: expect.objectContaining({
            identity: expect.objectContaining({
              goal: 'Serve consumer-tenant',
              system_prompt: expect.objectContaining({
                template: 'Imported prompt for consumer-tenant',
                libraryRef: {
                  promptId: 'prompt-1',
                  versionId: 'version-1',
                  resolvedHash: 'prompt-hash',
                },
              }),
            }),
          }),
        },
        {},
        expect.any(Set),
      );

      const snapshotInput = mockSnapshotCreate.mock.calls[0][0] as {
        compressedPayload: Buffer;
      };
      const snapshotPayload = JSON.parse(
        zlib.gunzipSync(snapshotInput.compressedPayload).toString(),
      ) as {
        mountedAgents: Record<string, { ir: AgentIR }>;
      };

      expect(snapshotPayload.mountedAgents.payments__main.ir.identity).toMatchObject({
        goal: 'Serve consumer-tenant',
        system_prompt: {
          template: 'Imported prompt for consumer-tenant',
          libraryRef: {
            promptId: 'prompt-1',
            versionId: 'version-1',
            resolvedHash: 'prompt-hash',
          },
        },
      });
    });

    it('fails closed on unresolved runtime templates after recompilation', async () => {
      mockCountDocuments.mockResolvedValue(1);
      mockProjectFindOne.mockResolvedValue({
        _id: PROJECT,
        moduleDependencyVersion: DEP_VERSION,
      });
      mockDepFind.mockResolvedValue([makeDependency('payments', 'mod-proj-1')]);
      mockResolveSelector.mockResolvedValue({ releaseId: 'release-payments', version: '1.0.0' });
      mockReleaseFindOne.mockResolvedValue({
        _id: 'release-payments',
        artifact: {
          agents: {
            main: {
              dslContent: [
                'AGENT: main',
                'GOAL: Lookup unresolved config.',
                '',
                'TOOLS:',
                '  lookup(query: string) -> string',
                '    auth_profile: "{{config.MISSING_AUTH_PROFILE}}"',
                '    description: "Lookup data"',
              ].join('\n'),
              sourceHash: 'h1',
            },
          },
          tools: {
            lookup: {
              dslContent: 'TOOL: lookup',
              toolType: 'http',
              sourceHash: 'h2',
              definition: {
                name: 'lookup',
                description: 'Lookup data',
                parameters: [],
                returns: { type: 'string' },
                hints: {
                  cacheable: false,
                  latency: 'medium',
                  parallelizable: true,
                  side_effects: false,
                  requires_auth: false,
                },
                tool_type: 'http',
                http_binding: {
                  method: 'GET',
                  endpoint: '{{config.MISSING_API_BASE}}/lookup',
                },
              },
            },
          },
        },
        compiledIR: {
          main: makeAgentIR('main'),
        },
      });

      mockRewriteModuleIR.mockImplementation((alias, agents) => ({
        agents: { [`${alias}__main`]: agents.main as AgentIR },
        tools: {},
        renameMap: { main: `${alias}__main` },
        collisions: [],
      }));
      mockSnapshotCreate.mockResolvedValue({ _id: 'snap-warn' });

      const result = await buildDeploymentModuleSnapshot(
        TENANT,
        PROJECT,
        DEPLOYMENT,
        DEP_VERSION,
        new Set(),
      );

      expect(result!.success).toBe(false);
      expect(result!.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            severity: 'error',
            code: 'UNRESOLVED_CONFIG_VARIABLE',
            source: 'dependency:payments:agent:main',
            message: expect.stringContaining('MISSING_AUTH_PROFILE'),
          }),
        ]),
      );
    });

    it('fails closed when standalone module tool snapshots contain unresolved placeholders across tool families', async () => {
      mockCountDocuments.mockResolvedValue(1);
      mockProjectFindOne.mockResolvedValue({
        _id: PROJECT,
        moduleDependencyVersion: DEP_VERSION,
      });
      mockDepFind.mockResolvedValue([makeDependency('payments', 'mod-proj-1')]);
      mockResolveSelector.mockResolvedValue({ releaseId: 'release-payments', version: '1.0.0' });
      mockReleaseFindOne.mockResolvedValue({
        _id: 'release-payments',
        artifact: {
          agents: {
            main: {
              dslContent: makeAgentDsl('main'),
              sourceHash: 'h1',
            },
          },
          tools: {
            soap_lookup: {
              dslContent: 'TOOL: soap_lookup',
              toolType: 'http',
              sourceHash: 'soap-hash',
              definition: {
                name: 'soap_lookup',
                tool_type: 'http',
                http_binding: {
                  protocol: 'soap',
                  method: 'POST',
                  endpoint: '{{config.SOAP_BASE_URL}}/soap',
                  soap_action: '{{config.SOAP_ACTION}}',
                },
              },
            },
            mcp_lookup: {
              dslContent: 'TOOL: mcp_lookup',
              toolType: 'mcp',
              sourceHash: 'mcp-hash',
              definition: {
                name: 'mcp_lookup',
                tool_type: 'mcp',
                mcp_binding: {
                  server: 'payments-mcp',
                  tool: 'lookup',
                  headers: {
                    'X-Region': '{{config.MCP_REGION}}',
                  },
                },
              },
            },
            workflow_lookup: {
              dslContent: 'TOOL: workflow_lookup',
              toolType: 'workflow',
              sourceHash: 'workflow-hash',
              definition: {
                name: 'workflow_lookup',
                tool_type: 'workflow',
                workflow_binding: {
                  workflowId: 'wf-payments',
                  triggerId: 'tr-payments',
                  timeoutMs: '{{config.WORKFLOW_TIMEOUT_MS}}',
                },
              },
            },
            search_lookup: {
              dslContent: 'TOOL: search_lookup',
              toolType: 'searchai',
              sourceHash: 'search-hash',
              definition: {
                name: 'search_lookup',
                tool_type: 'searchai',
                searchai_binding: {
                  tenantId: TENANT,
                  indexId: '{{config.SEARCH_INDEX_ID}}',
                },
              },
            },
            sandbox_lookup: {
              dslContent: 'TOOL: sandbox_lookup',
              toolType: 'sandbox',
              sourceHash: 'sandbox-hash',
              definition: {
                name: 'sandbox_lookup',
                tool_type: 'sandbox',
                sandbox_binding: {
                  runtime: 'python',
                  code_content: 'print("ok")',
                  timeout_ms: '{{config.SANDBOX_TIMEOUT_MS}}',
                },
              },
            },
          },
        },
        compiledIR: {
          main: makeAgentIR('main'),
        },
      });

      const result = await buildDeploymentModuleSnapshot(
        TENANT,
        PROJECT,
        DEPLOYMENT,
        DEP_VERSION,
        new Set(),
      );

      expect(result!.success).toBe(false);
      expect(result!.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            severity: 'error',
            code: 'UNRESOLVED_CONFIG_VARIABLE',
            source: 'dependency:payments:tool:soap_lookup',
            message: expect.stringContaining('SOAP_BASE_URL'),
          }),
          expect.objectContaining({
            severity: 'error',
            code: 'UNRESOLVED_CONFIG_VARIABLE',
            source: 'dependency:payments:tool:mcp_lookup',
            message: expect.stringContaining('MCP_REGION'),
          }),
          expect.objectContaining({
            severity: 'error',
            code: 'UNRESOLVED_CONFIG_VARIABLE',
            source: 'dependency:payments:tool:workflow_lookup',
            message: expect.stringContaining('WORKFLOW_TIMEOUT_MS'),
          }),
          expect.objectContaining({
            severity: 'error',
            code: 'UNRESOLVED_CONFIG_VARIABLE',
            source: 'dependency:payments:tool:search_lookup',
            message: expect.stringContaining('SEARCH_INDEX_ID'),
          }),
          expect.objectContaining({
            severity: 'error',
            code: 'UNRESOLVED_CONFIG_VARIABLE',
            source: 'dependency:payments:tool:sandbox_lookup',
            message: expect.stringContaining('SANDBOX_TIMEOUT_MS'),
          }),
        ]),
      );
      expect(mockRewriteModuleIR).not.toHaveBeenCalled();
      expect(mockSnapshotCreate).not.toHaveBeenCalled();
    });

    it('stores dependency metadata from the resolved release rather than the dependency row', async () => {
      mockCountDocuments.mockResolvedValue(1);
      mockProjectFindOne.mockResolvedValue({
        _id: PROJECT,
        moduleDependencyVersion: DEP_VERSION,
      });
      mockDepFind.mockResolvedValue([
        {
          ...makeDependency('payments', 'mod-proj-1'),
          selector: { type: 'environment', value: 'production' },
          resolvedReleaseId: 'release-stale',
        },
      ]);
      mockResolveSelector.mockResolvedValue({ releaseId: 'release-live', version: '2.0.0' });
      mockReleaseFindOne.mockResolvedValue({
        ...makeRelease({ main: { dslContent: makeAgentDsl('main'), sourceHash: 'h1' } }),
      });
      mockRewriteModuleIR.mockReturnValue({
        agents: { payments__main: makeAgentIR('payments__main') },
        tools: {},
        renameMap: { main: 'payments__main' },
        collisions: [],
      });
      mockSnapshotCreate.mockResolvedValue({ _id: 'snap-live' });

      const result = await buildDeploymentModuleSnapshot(
        TENANT,
        PROJECT,
        DEPLOYMENT,
        DEP_VERSION,
        new Set(),
      );

      expect(result!.success).toBe(true);

      const snapshotInput = mockSnapshotCreate.mock.calls[0][0] as {
        compressedPayload: Buffer;
      };
      const snapshotPayload = JSON.parse(
        zlib.gunzipSync(snapshotInput.compressedPayload).toString(),
      ) as {
        dependencies: Array<{
          alias: string;
          moduleProjectId: string;
          moduleReleaseId: string;
          version: string;
        }>;
      };

      expect(snapshotPayload.dependencies).toEqual([
        {
          alias: 'payments',
          moduleProjectId: 'mod-proj-1',
          moduleReleaseId: 'release-live',
          version: '2.0.0',
          configOverrides: {},
        },
      ]);
    });

    it('preserves consumer config overrides in the deployment snapshot payload', async () => {
      mockCountDocuments.mockResolvedValue(1);
      mockProjectFindOne.mockResolvedValue({
        _id: PROJECT,
        moduleDependencyVersion: DEP_VERSION,
      });
      mockDepFind.mockResolvedValue([
        {
          ...makeDependency('payments', 'mod-proj-1'),
          configOverrides: {
            api_url: 'https://tenant.example.com',
            region: 'eu-west-1',
          },
        },
      ]);
      mockResolveSelector.mockResolvedValue({ releaseId: 'release-live', version: '2.0.0' });
      mockReleaseFindOne.mockResolvedValue({
        ...makeRelease({ main: { dslContent: makeAgentDsl('main'), sourceHash: 'h1' } }),
        contract: {
          requiredConfigKeys: [{ key: 'api_url' }, { key: 'region' }],
        },
      });
      mockRewriteModuleIR.mockReturnValue({
        agents: { payments__main: makeAgentIR('payments__main') },
        tools: {},
        renameMap: { main: 'payments__main' },
        collisions: [],
      });
      mockSnapshotCreate.mockResolvedValue({ _id: 'snap-live' });

      const result = await buildDeploymentModuleSnapshot(
        TENANT,
        PROJECT,
        DEPLOYMENT,
        DEP_VERSION,
        new Set(),
      );

      expect(result!.success).toBe(true);

      const snapshotInput = mockSnapshotCreate.mock.calls[0][0] as {
        compressedPayload: Buffer;
      };
      const snapshotPayload = JSON.parse(
        zlib.gunzipSync(snapshotInput.compressedPayload).toString(),
      ) as {
        dependencies: Array<{
          alias: string;
          configOverrides?: Record<string, string>;
        }>;
      };

      expect(snapshotPayload.dependencies).toEqual([
        expect.objectContaining({
          alias: 'payments',
          configOverrides: {
            api_url: 'https://tenant.example.com',
            region: 'eu-west-1',
          },
        }),
      ]);
    });
  });

  // ── Selector resolution failure ──────────────────────────────────────────

  describe('selector resolution failures', () => {
    beforeEach(() => {
      mockCountDocuments.mockResolvedValue(1);
      mockProjectFindOne.mockResolvedValue({
        _id: PROJECT,
        moduleDependencyVersion: DEP_VERSION,
      });
    });

    it('returns error diagnostic when resolveSelector returns error', async () => {
      mockDepFind.mockResolvedValue([makeDependency('analytics', 'mod-proj-2')]);
      mockResolveSelector.mockResolvedValue({
        error: "No release promoted to 'production' environment. Promote a release first.",
      });

      const result = await buildDeploymentModuleSnapshot(
        TENANT,
        PROJECT,
        DEPLOYMENT,
        DEP_VERSION,
        new Set(),
      );

      expect(result!.success).toBe(false);
      expect(result!.diagnostics).toEqual([
        {
          severity: 'error',
          code: 'SELECTOR_RESOLUTION_FAILED',
          source: 'dependency:analytics',
          message: expect.stringContaining('Promote a release first'),
        },
      ]);
    });

    it('returns error when release not found after selector resolves', async () => {
      mockDepFind.mockResolvedValue([makeDependency('billing', 'mod-proj-3')]);
      mockResolveSelector.mockResolvedValue({ releaseId: 'release-missing', version: '2.0.0' });
      mockReleaseFindOne.mockResolvedValue(null);

      const result = await buildDeploymentModuleSnapshot(
        TENANT,
        PROJECT,
        DEPLOYMENT,
        DEP_VERSION,
        new Set(),
      );

      expect(result!.success).toBe(false);
      expect(result!.diagnostics[0].code).toBe('RELEASE_NOT_FOUND');
      expect(result!.diagnostics[0].source).toBe('dependency:billing');
    });

    it('fails closed when a release is archived after selector resolution', async () => {
      mockDepFind.mockResolvedValue([makeDependency('payments', 'mod-proj-1')]);
      mockResolveSelector.mockResolvedValue({ releaseId: 'release-payments', version: '1.0.0' });
      mockReleaseFindOne.mockImplementation((query: Record<string, unknown>) => {
        return Object.prototype.hasOwnProperty.call(query, 'archivedAt')
          ? null
          : makeRelease({ main: { dslContent: makeAgentDsl('main'), sourceHash: 'h1' } });
      });
      mockRewriteModuleIR.mockReturnValue({
        agents: { payments__main: makeAgentIR('payments__main') },
        tools: {},
        renameMap: { main: 'payments__main' },
        collisions: [],
      });
      mockSnapshotCreate.mockResolvedValue({ _id: 'snap-archived-race' });

      const result = await buildDeploymentModuleSnapshot(
        TENANT,
        PROJECT,
        DEPLOYMENT,
        DEP_VERSION,
        new Set(),
      );

      expect(result!.success).toBe(false);
      expect(result!.diagnostics[0].code).toBe('RELEASE_NOT_FOUND');
      expect(mockReleaseFindOne).toHaveBeenCalledWith(
        expect.objectContaining({
          _id: 'release-payments',
          tenantId: TENANT,
          moduleProjectId: 'mod-proj-1',
          archivedAt: { $in: [null, undefined] },
        }),
      );
      expect(mockSnapshotCreate).not.toHaveBeenCalled();
    });

    it('returns error when release has no artifact', async () => {
      mockDepFind.mockResolvedValue([makeDependency('chat', 'mod-proj-4')]);
      mockResolveSelector.mockResolvedValue({ releaseId: 'release-noart', version: '1.0.0' });
      mockReleaseFindOne.mockResolvedValue({ _id: 'release-noart' }); // no artifact

      const result = await buildDeploymentModuleSnapshot(
        TENANT,
        PROJECT,
        DEPLOYMENT,
        DEP_VERSION,
        new Set(),
      );

      expect(result!.success).toBe(false);
      expect(result!.diagnostics[0].code).toBe('ARTIFACT_MISSING');
    });
  });

  // ── Symbol collision ─────────────────────────────────────────────────────

  describe('symbol collision', () => {
    it('returns error when rewriter detects collisions', async () => {
      mockCountDocuments.mockResolvedValue(1);
      mockProjectFindOne.mockResolvedValue({
        _id: PROJECT,
        moduleDependencyVersion: DEP_VERSION,
      });
      mockDepFind.mockResolvedValue([makeDependency('payments', 'mod-proj-1')]);
      mockResolveSelector.mockResolvedValue({ releaseId: 'release-payments', version: '1.0.0' });
      mockReleaseFindOne.mockResolvedValue({
        ...makeRelease({ main: { dslContent: makeAgentDsl('main'), sourceHash: 'h1' } }),
      });

      mockRewriteModuleIR.mockReturnValue({
        agents: {},
        tools: {},
        renameMap: { main: 'payments__main' },
        collisions: ['payments__main'],
      });

      const result = await buildDeploymentModuleSnapshot(
        TENANT,
        PROJECT,
        DEPLOYMENT,
        DEP_VERSION,
        new Set(['payments__main']),
      );

      expect(result!.success).toBe(false);
      expect(result!.diagnostics).toEqual([
        {
          severity: 'error',
          code: 'SYMBOL_COLLISION',
          source: 'dependency:payments',
          message: expect.stringContaining('payments__main'),
        },
      ]);
    });
  });

  // ── Rewrite failure ──────────────────────────────────────────────────────

  describe('rewrite failure', () => {
    it('returns error diagnostic when rewriteModuleIR throws', async () => {
      mockCountDocuments.mockResolvedValue(1);
      mockProjectFindOne.mockResolvedValue({
        _id: PROJECT,
        moduleDependencyVersion: DEP_VERSION,
      });
      mockDepFind.mockResolvedValue([makeDependency('payments', 'mod-proj-1')]);
      mockResolveSelector.mockResolvedValue({ releaseId: 'release-payments', version: '1.0.0' });
      mockReleaseFindOne.mockResolvedValue(
        makeRelease({ main: { dslContent: makeAgentDsl('main'), sourceHash: 'h1' } }),
      );

      mockRewriteModuleIR.mockImplementation(() => {
        throw new Error('Invalid alias format');
      });

      const result = await buildDeploymentModuleSnapshot(
        TENANT,
        PROJECT,
        DEPLOYMENT,
        DEP_VERSION,
        new Set(),
      );

      expect(result!.success).toBe(false);
      expect(result!.diagnostics[0].code).toBe('REWRITE_FAILED');
      expect(result!.diagnostics[0].message).toContain('Invalid alias format');
    });
  });

  // ── Size enforcement ─────────────────────────────────────────────────────

  describe('size enforcement', () => {
    it('returns error when uncompressed payload exceeds 8 MB', async () => {
      mockCountDocuments.mockResolvedValue(1);
      mockProjectFindOne.mockResolvedValue({
        _id: PROJECT,
        moduleDependencyVersion: DEP_VERSION,
      });
      mockDepFind.mockResolvedValue([makeDependency('bigmod', 'mod-proj-big')]);
      mockResolveSelector.mockResolvedValue({ releaseId: 'release-big', version: '1.0.0' });
      mockReleaseFindOne.mockResolvedValue(
        makeRelease({ main: { dslContent: makeAgentDsl('main'), sourceHash: 'h1' } }),
      );

      // Return a massive IR to exceed 8 MB
      const hugeString = 'x'.repeat(9 * 1024 * 1024); // 9 MB string
      const hugeAgentIR = makeAgentIR('bigmod__main');
      (hugeAgentIR as unknown as Record<string, unknown>).hugePayload = hugeString;

      mockRewriteModuleIR.mockReturnValue({
        agents: { bigmod__main: hugeAgentIR },
        tools: {},
        renameMap: { main: 'bigmod__main' },
        collisions: [],
      });

      const result = await buildDeploymentModuleSnapshot(
        TENANT,
        PROJECT,
        DEPLOYMENT,
        DEP_VERSION,
        new Set(),
      );

      expect(result!.success).toBe(false);
      expect(result!.diagnostics[0].code).toBe('SNAPSHOT_TOO_LARGE');
      expect(result!.diagnostics[0].message).toContain('exceeds maximum of 8 MB');
    });
  });

  // ── Symbol count limit ───────────────────────────────────────────────────

  describe('symbol count limit', () => {
    it('returns error when total mounted symbols exceed 250', async () => {
      mockCountDocuments.mockResolvedValue(1);
      mockProjectFindOne.mockResolvedValue({
        _id: PROJECT,
        moduleDependencyVersion: DEP_VERSION,
      });
      mockDepFind.mockResolvedValue([makeDependency('huge', 'mod-proj-huge')]);
      mockResolveSelector.mockResolvedValue({ releaseId: 'release-huge', version: '1.0.0' });

      // Create release with many agents
      const agentArtifacts: Record<string, unknown> = {};
      const agentIRs: Record<string, unknown> = {};
      for (let i = 0; i < 200; i++) {
        agentArtifacts[`agent${i}`] = {
          dslContent: makeAgentDsl(`agent${i}`),
          sourceHash: `h${i}`,
        };
        agentIRs[`agent${i}`] = makeAgentIR(`agent${i}`);
      }

      const toolArtifacts: Record<string, unknown> = {};
      for (let i = 0; i < 60; i++) {
        toolArtifacts[`tool${i}`] = {
          dslContent: `TOOL: tool${i}`,
          toolType: 'http',
          sourceHash: `t${i}`,
        };
      }

      mockReleaseFindOne.mockResolvedValue({
        _id: 'release-huge',
        artifact: { agents: agentArtifacts, tools: toolArtifacts },
        compiledIR: agentIRs,
      });

      // Build rewrite result with 200 agents + 60 tools = 260 > 250
      const rewrittenAgents: Record<string, unknown> = {};
      const rewrittenTools: Record<string, unknown> = {};
      const renameMap: Record<string, string> = {};

      for (let i = 0; i < 200; i++) {
        const aliased = `huge__agent${i}`;
        rewrittenAgents[aliased] = makeAgentIR(aliased);
        renameMap[`agent${i}`] = aliased;
      }
      for (let i = 0; i < 60; i++) {
        const aliased = `huge__tool${i}`;
        rewrittenTools[aliased] = { tool_type: 'http' };
        renameMap[`tool${i}`] = aliased;
      }

      mockRewriteModuleIR.mockReturnValue({
        agents: rewrittenAgents,
        tools: rewrittenTools,
        renameMap,
        collisions: [],
      });

      const result = await buildDeploymentModuleSnapshot(
        TENANT,
        PROJECT,
        DEPLOYMENT,
        DEP_VERSION,
        new Set(),
      );

      expect(result!.success).toBe(false);
      expect(result!.diagnostics[0].code).toBe('TOO_MANY_SYMBOLS');
      expect(result!.diagnostics[0].message).toContain('260');
      expect(result!.diagnostics[0].message).toContain('250');
    });
  });

  // ── Diagnostics capping ──────────────────────────────────────────────────

  describe('diagnostics capped at 10', () => {
    it('returns at most 10 diagnostics even when more errors exist', async () => {
      mockCountDocuments.mockResolvedValue(1);
      mockProjectFindOne.mockResolvedValue({
        _id: PROJECT,
        moduleDependencyVersion: DEP_VERSION,
      });

      // Create 15 dependencies that all fail selector resolution
      const deps = Array.from({ length: 15 }, (_, i) => makeDependency(`dep${i}`, `mod-proj-${i}`));
      mockDepFind.mockResolvedValue(deps);
      mockResolveSelector.mockResolvedValue({ error: 'Not found' });

      const result = await buildDeploymentModuleSnapshot(
        TENANT,
        PROJECT,
        DEPLOYMENT,
        DEP_VERSION,
        new Set(),
      );

      expect(result!.success).toBe(false);
      expect(result!.diagnostics).toHaveLength(10);
    });
  });

  // ── Missing compiled IR warning ──────────────────────────────────────────

  describe('missing compiled IR', () => {
    it('adds warning diagnostic when agent has no compiled IR', async () => {
      mockCountDocuments.mockResolvedValue(1);
      mockProjectFindOne.mockResolvedValue({
        _id: PROJECT,
        moduleDependencyVersion: DEP_VERSION,
      });
      mockDepFind.mockResolvedValue([makeDependency('mymod', 'mod-proj-1')]);
      mockResolveSelector.mockResolvedValue({ releaseId: 'release-mymod', version: '1.0.0' });

      // Release has agent in artifact but no compiledIR for it
      mockReleaseFindOne.mockResolvedValue({
        _id: 'release-mymod',
        artifact: {
          agents: {
            orphan: {
              dslContent: makeAgentDsl('orphan'),
              sourceHash: 'h1',
              companion: {
                systemPromptLibraryRef: {
                  promptId: 'prompt-orphan',
                  versionId: 'version-1',
                },
              },
            },
          },
          tools: {},
        },
        compiledIR: {}, // no entry for 'orphan'
      });

      // Rewriter gets empty agents since orphan has no IR
      mockRewriteModuleIR.mockReturnValue({
        agents: {},
        tools: {},
        renameMap: {},
        collisions: [],
      });

      const result = await buildDeploymentModuleSnapshot(
        TENANT,
        PROJECT,
        DEPLOYMENT,
        DEP_VERSION,
        new Set(),
      );

      // Should succeed (warnings don't block) with a warning diagnostic
      expect(result!.success).toBe(true);
      expect(result!.diagnostics).toEqual([
        {
          severity: 'warning',
          code: 'MISSING_COMPILED_IR',
          source: 'dependency:mymod',
          message: expect.stringContaining('orphan'),
        },
      ]);
    });
  });

  // ── Deployment prerequisite preflight ───────────────────────────────────

  describe('deployment prerequisite preflight', () => {
    it('fails deployment builds when required config keys are missing', async () => {
      mockCountDocuments.mockResolvedValue(1);
      mockProjectFindOne.mockResolvedValue({
        _id: PROJECT,
        moduleDependencyVersion: DEP_VERSION,
      });
      mockDepFind.mockResolvedValue([makeDependency('payments', 'mod-proj-1')]);
      mockResolveSelector.mockResolvedValue({ releaseId: 'release-payments', version: '1.0.0' });
      mockReleaseFindOne.mockResolvedValue({
        ...makeRelease({ main: { dslContent: makeAgentDsl('main'), sourceHash: 'h1' } }),
        contract: {
          requiredConfigKeys: [
            { key: 'PAYMENTS_API_URL', isSecret: false },
            { key: 'PAYMENTS_TOKEN', isSecret: true },
          ],
        },
      });

      const result = await buildDeploymentModuleSnapshot(
        TENANT,
        PROJECT,
        DEPLOYMENT,
        DEP_VERSION,
        new Set(),
        { environment: 'production' },
      );

      expect(result!.success).toBe(false);
      expect(result!.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            severity: 'error',
            code: 'REQUIRED_CONFIG_KEY_MISSING',
            source: 'dependency:payments:config:PAYMENTS_API_URL',
          }),
        ]),
      );
      expect(mockSnapshotCreate).not.toHaveBeenCalled();
    });

    it('accepts required config keys from project config or non-secret overrides', async () => {
      mockCountDocuments.mockResolvedValue(1);
      mockProjectFindOne.mockResolvedValue({
        _id: PROJECT,
        moduleDependencyVersion: DEP_VERSION,
      });
      mockLoadConfigVariablesMap.mockResolvedValue({ PAYMENTS_TOKEN: 'secret-from-project' });
      mockDepFind.mockResolvedValue([
        {
          ...makeDependency('payments', 'mod-proj-1'),
          configOverrides: { PAYMENTS_API_URL: 'https://payments.example.com' },
        },
      ]);
      mockResolveSelector.mockResolvedValue({ releaseId: 'release-payments', version: '1.0.0' });
      mockReleaseFindOne.mockResolvedValue({
        ...makeRelease({ main: { dslContent: makeAgentDsl('main'), sourceHash: 'h1' } }),
        contract: {
          requiredConfigKeys: [
            { key: 'PAYMENTS_API_URL', isSecret: false },
            { key: 'PAYMENTS_TOKEN', isSecret: true },
          ],
        },
      });
      mockRewriteModuleIR.mockReturnValue({
        agents: { payments__main: makeAgentIR('payments__main') },
        tools: {},
        renameMap: { main: 'payments__main' },
        collisions: [],
      });
      mockSnapshotCreate.mockResolvedValue({ _id: 'snap-config-ok' });

      const result = await buildDeploymentModuleSnapshot(
        TENANT,
        PROJECT,
        DEPLOYMENT,
        DEP_VERSION,
        new Set(),
        { environment: 'production' },
      );

      expect(result!.success).toBe(true);
      expect(result!.diagnostics).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ code: 'REQUIRED_CONFIG_KEY_MISSING' })]),
      );
      expect(mockSnapshotCreate).toHaveBeenCalled();
    });

    it('blocks deployment when a resolved config-backed auth profile is not runtime-resolvable', async () => {
      mockCountDocuments.mockResolvedValue(1);
      mockProjectFindOne.mockResolvedValue({
        _id: PROJECT,
        moduleDependencyVersion: DEP_VERSION,
      });
      mockDepFind.mockResolvedValue([
        {
          ...makeDependency('payments', 'mod-proj-1'),
          configOverrides: { AUTH_PROFILE: 'missing-prod-auth' },
        },
      ]);
      mockResolveSelector.mockResolvedValue({ releaseId: 'release-payments', version: '1.0.0' });
      mockAuthProfileFindOne.mockResolvedValue(null);
      mockReleaseFindOne.mockResolvedValue({
        _id: 'release-payments',
        contract: {
          requiredConfigKeys: [{ key: 'AUTH_PROFILE', isSecret: false }],
          requiredAuthProfiles: [],
        },
        artifact: {
          agents: {
            main: {
              dslContent: makeAgentDsl('main'),
              sourceHash: 'h1',
              companion: {
                systemPromptLibraryRef: {
                  promptId: 'prompt-main',
                  versionId: 'version-1',
                },
              },
            },
          },
          tools: {
            lookup: {
              dslContent: 'TOOL: lookup',
              toolType: 'http',
              sourceHash: 'h2',
              definition: {
                name: 'lookup',
                description: 'Lookup',
                parameters: [],
                returns: { type: 'string' },
                hints: {
                  cacheable: false,
                  latency: 'medium',
                  parallelizable: true,
                  side_effects: false,
                  requires_auth: true,
                },
                tool_type: 'http',
                auth_profile_ref: '{{config.AUTH_PROFILE}}',
                connection_mode: 'shared',
                http_binding: {
                  method: 'GET',
                  endpoint: 'https://payments.example.com/lookup',
                },
              },
            },
          },
        },
        compiledIR: {
          main: {
            ...makeAgentIR('main'),
            tools: [{ name: 'lookup', auth_profile_ref: '{{config.AUTH_PROFILE}}' }],
          },
        },
      });

      const result = await buildDeploymentModuleSnapshot(
        TENANT,
        PROJECT,
        DEPLOYMENT,
        DEP_VERSION,
        new Set(),
        { environment: 'production', userId: 'deployer-1' },
      );

      expect(result!.success).toBe(false);
      expect(result!.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            severity: 'error',
            code: 'AUTH_PROFILE_PREFLIGHT_FAILED',
            source: 'auth-preflight',
            message: expect.stringContaining('missing-prod-auth'),
          }),
        ]),
      );
      expect(mockAuthProfileFindOne).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'missing-prod-auth',
          tenantId: TENANT,
          projectId: PROJECT,
          environment: 'production',
          visibility: 'shared',
          status: 'active',
        }),
      );
      expect(mockSnapshotCreate).not.toHaveBeenCalled();
    });

    it('fails deployment builds when stale dependency overrides contain secret config keys', async () => {
      mockCountDocuments.mockResolvedValue(1);
      mockProjectFindOne.mockResolvedValue({
        _id: PROJECT,
        moduleDependencyVersion: DEP_VERSION,
      });
      mockDepFind.mockResolvedValue([
        {
          ...makeDependency('payments', 'mod-proj-1'),
          configOverrides: { PAYMENTS_TOKEN: 'secret-in-dependency-record' },
        },
      ]);
      mockResolveSelector.mockResolvedValue({ releaseId: 'release-payments', version: '1.0.0' });
      mockReleaseFindOne.mockResolvedValue({
        ...makeRelease({ main: { dslContent: makeAgentDsl('main'), sourceHash: 'h1' } }),
        contract: {
          requiredConfigKeys: [{ key: 'PAYMENTS_TOKEN', isSecret: true }],
        },
      });

      const result = await buildDeploymentModuleSnapshot(
        TENANT,
        PROJECT,
        DEPLOYMENT,
        DEP_VERSION,
        new Set(),
        { environment: 'production' },
      );

      expect(result!.success).toBe(false);
      expect(result!.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            severity: 'error',
            code: 'SECRET_CONFIG_OVERRIDE_REJECTED',
            source: 'dependency:payments:config:PAYMENTS_TOKEN',
          }),
        ]),
      );
      expect(mockSnapshotCreate).not.toHaveBeenCalled();
    });

    it('validates required runtime secrets against aliased tool-scoped ToolSecret records', async () => {
      mockCountDocuments.mockResolvedValue(1);
      mockProjectFindOne.mockResolvedValue({
        _id: PROJECT,
        moduleDependencyVersion: DEP_VERSION,
      });
      mockDepFind.mockResolvedValue([makeDependency('payments', 'mod-proj-1')]);
      mockResolveSelector.mockResolvedValue({ releaseId: 'release-payments', version: '1.0.0' });
      mockReleaseFindOne.mockResolvedValue({
        ...makeRelease({ main: { dslContent: makeAgentDsl('main'), sourceHash: 'h1' } }),
        contract: {
          requiredSecrets: [
            { key: 'PAYMENTS_TOKEN', referencedBy: ['tool:lookup'], toolName: 'lookup' },
          ],
        },
      });

      const result = await buildDeploymentModuleSnapshot(
        TENANT,
        PROJECT,
        DEPLOYMENT,
        DEP_VERSION,
        new Set(),
        { environment: 'production' },
      );

      expect(result!.success).toBe(false);
      expect(result!.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            severity: 'error',
            code: 'REQUIRED_SECRET_MISSING',
            source: 'dependency:payments:secret:payments__lookup:PAYMENTS_TOKEN',
          }),
        ]),
      );
      expect(mockToolSecretFind).toHaveBeenCalledWith({
        tenantId: TENANT,
        projectId: PROJECT,
        secretKey: { $in: ['PAYMENTS_TOKEN'] },
        toolName: { $in: ['payments__lookup'] },
        environment: { $in: ['production', 'global'] },
      });
      expect(mockEnvironmentVariableFind).not.toHaveBeenCalled();
      expect(mockSnapshotCreate).not.toHaveBeenCalled();
    });

    it('fails deployment builds when required connectors are missing', async () => {
      mockCountDocuments.mockResolvedValue(1);
      mockProjectFindOne.mockResolvedValue({
        _id: PROJECT,
        moduleDependencyVersion: DEP_VERSION,
      });
      mockDepFind.mockResolvedValue([makeDependency('payments', 'mod-proj-1')]);
      mockResolveSelector.mockResolvedValue({ releaseId: 'release-payments', version: '1.0.0' });
      mockReleaseFindOne.mockResolvedValue({
        ...makeRelease({ main: { dslContent: makeAgentDsl('main'), sourceHash: 'h1' } }),
        contract: {
          requiredConnectors: [{ name: 'salesforce-prod' }],
        },
      });

      const result = await buildDeploymentModuleSnapshot(
        TENANT,
        PROJECT,
        DEPLOYMENT,
        DEP_VERSION,
        new Set(),
        { environment: 'production' },
      );

      expect(result!.success).toBe(false);
      expect(result!.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            severity: 'error',
            code: 'REQUIRED_CONNECTOR_MISSING',
            source: 'dependency:payments:connector:salesforce-prod',
          }),
        ]),
      );
      expect(mockConnectorConnectionFind).toHaveBeenCalledWith({
        tenantId: TENANT,
        projectId: PROJECT,
        connectorName: { $in: ['salesforce-prod'] },
        status: 'active',
      });
      expect(mockSnapshotCreate).not.toHaveBeenCalled();
    });

    it('accepts required connectors with active project bindings', async () => {
      mockCountDocuments.mockResolvedValue(1);
      mockProjectFindOne.mockResolvedValue({
        _id: PROJECT,
        moduleDependencyVersion: DEP_VERSION,
      });
      mockDepFind.mockResolvedValue([makeDependency('payments', 'mod-proj-1')]);
      mockResolveSelector.mockResolvedValue({ releaseId: 'release-payments', version: '1.0.0' });
      mockConnectorConnectionFind.mockResolvedValue([{ connectorName: 'salesforce-prod' }]);
      mockReleaseFindOne.mockResolvedValue({
        ...makeRelease({ main: { dslContent: makeAgentDsl('main'), sourceHash: 'h1' } }),
        contract: {
          requiredConnectors: [{ name: 'salesforce-prod' }],
        },
      });
      mockRewriteModuleIR.mockReturnValue({
        agents: { payments__main: makeAgentIR('payments__main') },
        tools: {},
        renameMap: { main: 'payments__main' },
        collisions: [],
      });
      mockSnapshotCreate.mockResolvedValue({ _id: 'snap-connector-ok' });

      const result = await buildDeploymentModuleSnapshot(
        TENANT,
        PROJECT,
        DEPLOYMENT,
        DEP_VERSION,
        new Set(),
        { environment: 'production' },
      );

      expect(result!.success).toBe(true);
      expect(result!.diagnostics).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ code: 'REQUIRED_CONNECTOR_MISSING' })]),
      );
      expect(mockSnapshotCreate).toHaveBeenCalled();
    });

    it('fails deployment builds when required env vars or MCP servers are missing', async () => {
      mockCountDocuments.mockResolvedValue(1);
      mockProjectFindOne.mockResolvedValue({
        _id: PROJECT,
        moduleDependencyVersion: DEP_VERSION,
      });
      mockDepFind.mockResolvedValue([makeDependency('payments', 'mod-proj-1')]);
      mockResolveSelector.mockResolvedValue({ releaseId: 'release-payments', version: '1.0.0' });
      mockReleaseFindOne.mockResolvedValue({
        ...makeRelease({ main: { dslContent: makeAgentDsl('main'), sourceHash: 'h1' } }),
        contract: {
          requiredEnvVars: [{ name: 'PAYMENTS_API_KEY' }],
          requiredMcpServers: [{ name: 'payments-mcp' }],
        },
      });

      const result = await buildDeploymentModuleSnapshot(
        TENANT,
        PROJECT,
        DEPLOYMENT,
        DEP_VERSION,
        new Set(),
        { environment: 'production' },
      );

      expect(result!.success).toBe(false);
      expect(result!.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            severity: 'error',
            code: 'REQUIRED_ENV_VAR_MISSING',
            source: 'dependency:payments:env:PAYMENTS_API_KEY',
          }),
          expect.objectContaining({
            severity: 'error',
            code: 'REQUIRED_MCP_SERVER_MISSING',
            source: 'dependency:payments:mcp:payments-mcp',
          }),
        ]),
      );
      expect(mockSnapshotCreate).not.toHaveBeenCalled();
      expect(mockEnvironmentVariableFind).toHaveBeenCalledWith({
        tenantId: TENANT,
        projectId: PROJECT,
        key: { $in: ['PAYMENTS_API_KEY'] },
        environment: { $in: ['production', 'global'] },
      });
      expect(mockMcpServerConfigFind).toHaveBeenCalledWith({
        tenantId: TENANT,
        projectId: PROJECT,
        name: { $in: ['payments-mcp'] },
      });
    });
  });

  // ── Snapshot hash behavior ──────────────────────────────────────────────

  describe('snapshot hash behavior', () => {
    it('changes when config overrides or mounted IR content changes', async () => {
      mockCountDocuments.mockResolvedValue(1);
      mockProjectFindOne.mockResolvedValue({
        _id: PROJECT,
        moduleDependencyVersion: DEP_VERSION,
      });
      mockResolveSelector.mockResolvedValue({ releaseId: 'release-payments', version: '1.0.0' });
      mockReleaseFindOne.mockResolvedValue({
        ...makeRelease({ main: { dslContent: makeAgentDsl('main'), sourceHash: 'h1' } }),
        contract: {
          requiredConfigKeys: [{ key: 'region' }],
        },
      });
      mockSnapshotCreate.mockResolvedValue({ _id: 'snap-hash' });

      mockDepFind
        .mockResolvedValueOnce([
          { ...makeDependency('payments', 'mod-proj-1'), configOverrides: { region: 'us' } },
        ])
        .mockResolvedValueOnce([
          { ...makeDependency('payments', 'mod-proj-1'), configOverrides: { region: 'eu' } },
        ])
        .mockResolvedValueOnce([
          { ...makeDependency('payments', 'mod-proj-1'), configOverrides: { region: 'us' } },
        ]);

      mockRewriteModuleIR
        .mockReturnValueOnce({
          agents: { payments__main: makeAgentIR('payments__main') },
          tools: {},
          renameMap: { main: 'payments__main' },
          collisions: [],
        })
        .mockReturnValueOnce({
          agents: { payments__main: makeAgentIR('payments__main') },
          tools: {},
          renameMap: { main: 'payments__main' },
          collisions: [],
        })
        .mockReturnValueOnce({
          agents: {
            payments__main: {
              ...makeAgentIR('payments__main'),
              identity: { goal: 'Different mounted behavior', persona: 'Helpful assistant' },
            } as AgentIR,
          },
          tools: {},
          renameMap: { main: 'payments__main' },
          collisions: [],
        });

      const first = await buildDeploymentModuleSnapshot(
        TENANT,
        PROJECT,
        'deploy-hash-1',
        DEP_VERSION,
        new Set(),
      );
      const second = await buildDeploymentModuleSnapshot(
        TENANT,
        PROJECT,
        'deploy-hash-2',
        DEP_VERSION,
        new Set(),
      );
      const third = await buildDeploymentModuleSnapshot(
        TENANT,
        PROJECT,
        'deploy-hash-3',
        DEP_VERSION,
        new Set(),
      );

      expect(first!.success).toBe(true);
      expect(second!.success).toBe(true);
      expect(third!.success).toBe(true);
      expect(second!.snapshotHash).not.toBe(first!.snapshotHash);
      expect(third!.snapshotHash).not.toBe(first!.snapshotHash);
    });
  });

  // ── Promotion clone safety ────────────────────────────────────────────────

  describe('promotion snapshot clone safety', () => {
    it('refuses cross-environment clones before reading snapshot storage', async () => {
      const result = await cloneDeploymentModuleSnapshot(
        TENANT,
        PROJECT,
        'deploy-source',
        'deploy-target',
        { sourceEnvironment: 'dev', targetEnvironment: 'staging' },
      );

      expect(result).toBeNull();
      expect(mockSnapshotFindOne).not.toHaveBeenCalled();
      expect(mockSnapshotCreate).not.toHaveBeenCalled();
    });

    it('clones snapshots when source and target environments match', async () => {
      const compressedPayload = zlib.gzipSync(
        Buffer.from(JSON.stringify({ dependencies: [], mountedAgents: {}, mountedTools: {} })),
      );
      mockSnapshotFindOne.mockResolvedValue({
        snapshotHash: 'hash-prod',
        moduleReleaseIds: ['release-prod'],
        compressedPayload,
      });
      mockSnapshotCreate.mockResolvedValue({ _id: { toString: () => 'snap-cloned' } });

      const result = await cloneDeploymentModuleSnapshot(
        TENANT,
        PROJECT,
        'deploy-source',
        'deploy-target',
        { sourceEnvironment: 'production', targetEnvironment: 'production' },
      );

      expect(result).toEqual({
        success: true,
        snapshotId: 'snap-cloned',
        snapshotHash: 'hash-prod',
        mountedAgentCount: 0,
        mountedToolCount: 0,
        diagnostics: [],
      });
      expect(mockSnapshotFindOne).toHaveBeenCalledWith({
        tenantId: TENANT,
        projectId: PROJECT,
        deploymentId: 'deploy-source',
      });
      expect(mockSnapshotCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: TENANT,
          projectId: PROJECT,
          deploymentId: 'deploy-target',
          snapshotHash: 'hash-prod',
          moduleReleaseIds: ['release-prod'],
          compressedPayload: expect.any(Buffer),
        }),
      );
    });
  });

  // ── Tenant isolation ─────────────────────────────────────────────────────

  describe('tenant isolation', () => {
    it('passes tenantId to all DB queries', async () => {
      mockCountDocuments.mockResolvedValue(1);
      mockProjectFindOne.mockResolvedValue({
        _id: PROJECT,
        moduleDependencyVersion: DEP_VERSION,
      });
      mockDepFind.mockResolvedValue([makeDependency('payments', 'mod-proj-1')]);
      mockResolveSelector.mockResolvedValue({ releaseId: 'rel-1', version: '1.0.0' });
      mockReleaseFindOne.mockResolvedValue(
        makeRelease({ main: { dslContent: makeAgentDsl('main'), sourceHash: 'h1' } }),
      );
      mockRewriteModuleIR.mockReturnValue({
        agents: { payments__main: makeAgentIR('payments__main') },
        tools: {},
        renameMap: { main: 'payments__main' },
        collisions: [],
      });
      mockSnapshotCreate.mockResolvedValue({ _id: 'snap-1' });

      await buildDeploymentModuleSnapshot(TENANT, PROJECT, DEPLOYMENT, DEP_VERSION, new Set());

      // countDocuments includes tenantId
      expect(mockCountDocuments).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: TENANT }),
      );
      // Project.findOne includes tenantId
      expect(mockProjectFindOne).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: TENANT }),
      );
      // find dependencies includes tenantId
      expect(mockDepFind).toHaveBeenCalledWith(expect.objectContaining({ tenantId: TENANT }));
      // ModuleRelease.findOne includes tenantId
      expect(mockReleaseFindOne).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: TENANT }),
      );
      // Snapshot creation includes tenantId
      expect(mockSnapshotCreate).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: TENANT }),
      );
    });
  });
});
