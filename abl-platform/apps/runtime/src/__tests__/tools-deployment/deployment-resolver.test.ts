/**
 * DeploymentResolver Tests
 *
 * Tests the central deployment resolution service that resolves agents
 * through the deployment pipeline: Channel -> Deployment -> AgentVersion.irContent -> Session.
 *
 * Production code uses Mongoose models (Deployment, ProjectAgent, AgentVersion, AuditLog, Project)
 * accessed via dynamic `import('@agent-platform/database/models')`. We mock that module here.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentIR, CompilationOutput } from '@abl/compiler';
import zlib from 'node:zlib';

// =============================================================================
// MOCK @abl/core and @abl/compiler to avoid slow/hanging dynamic imports in CI
// =============================================================================

vi.mock('@abl/core', () => ({
  parseAgentBasedABL: vi.fn((dsl: string) => {
    const profileName = dsl.match(/^BEHAVIOR_PROFILE:\s+(\S+)/m)?.[1];
    if (profileName) {
      return {
        document: {
          raw: dsl,
          meta: { kind: 'behavior_profile' },
          name: profileName,
          conversation: { speaking: { style: 'warm' } },
        },
        errors: [],
      };
    }

    // Return a fake parsed document keyed on the DSL content
    const name = dsl.match(/(?:AGENT:|agent|supervisor)\s+(\w+)/i)?.[1] || 'unknown_agent';
    return {
      document: {
        raw: dsl,
        meta: { kind: 'agent' },
        type: 'agent',
        name,
        tools: [{ name: `${name}_tool` }],
      },
      errors: [],
    };
  }),
}));

vi.mock('@abl/compiler', () => ({
  FAN_OUT_MIN_TASKS: 2,
  FAN_OUT_MAX_TASKS: 5,
  compileABLtoIR: vi.fn((documents: any[]) => {
    // Build a fake CompilationOutput from the documents
    const agents: Record<string, any> = {};
    const profiles = documents.filter((doc) => doc.meta?.kind === 'behavior_profile');
    for (const doc of documents) {
      if (doc.meta?.kind === 'behavior_profile') continue;
      const name =
        doc.raw?.match(/(?:AGENT:|agent|supervisor)\s+(\w+)/i)?.[1] ||
        `agent_${Object.keys(agents).length}`;
      agents[name] = {
        ir_version: '1.0',
        metadata: {
          name,
          version: '1.0.0',
          type: 'agent',
          compiled_at: new Date().toISOString(),
          source_hash: 'mock',
          compiler_version: '1.0.0',
        },
        execution: {
          mode: 'reasoning',
          hints: { requires_memory: false, requires_tools: false },
          timeouts: { llm_call_ms: 30000, tool_call_ms: 10000, session_ms: 300000 },
        },
        identity: { goal: 'Test', persona: 'Test' },
        tools: [],
        gather: { fields: [], strategy: 'conversational' },
        memory: { strategy: 'full', max_turns: 50 },
        constraints: { constraints: [], guardrails: [] },
        coordination: { handoffs: [], delegates: [] },
        completion: { criteria: [] },
        error_handling: { strategy: 'graceful', max_retries: 3 },
        ...(profiles.length > 0
          ? { behavior_profiles: profiles.map((profile) => ({ name: profile.name })) }
          : {}),
      };
    }
    const entryAgent =
      Object.keys(agents).find((n) => n.includes('supervisor')) || Object.keys(agents)[0];
    return {
      version: '1.0',
      compiled_at: new Date().toISOString(),
      agents,
      entry_agent: entryAgent,
      deployment: {
        runtime_recommendations: {},
        parallel_safe: [],
        stateful: [],
        hitl_capable: [],
      },
    };
  }),
}));

// =============================================================================
// MOCK FACTORIES
// =============================================================================

function createMockAgentIR(name: string, opts?: { routing?: any; coordination?: any }): AgentIR {
  return {
    ir_version: '1.0',
    metadata: {
      name,
      version: '1.0.0',
      type: 'agent',
      compiled_at: new Date().toISOString(),
      source_hash: 'abc123',
      compiler_version: '1.0.0',
    },
    execution: {
      mode: 'reasoning',
      hints: { requires_memory: false, requires_tools: false },
      timeouts: { llm_call_ms: 30000, tool_call_ms: 10000, session_ms: 300000 },
    },
    identity: { goal: 'Test agent', persona: 'Helpful assistant' },
    tools: [],
    gather: { fields: [], strategy: 'conversational' },
    memory: { strategy: 'full', max_turns: 50 },
    constraints: { constraints: [], guardrails: [] },
    coordination: { handoffs: [], delegates: [], ...(opts?.coordination ?? {}) },
    completion: { criteria: [] },
    error_handling: { strategy: 'graceful', max_retries: 3 },
    ...(opts?.routing ? { routing: opts.routing } : {}),
  } as any;
}

function createMockSessionService(opts?: { cacheThrows?: boolean }) {
  const irCache = new Map<string, AgentIR>();
  const compilationCache = new Map<string, CompilationOutput>();

  return {
    cacheAgentIR: vi.fn(async (ir: AgentIR) => {
      if (opts?.cacheThrows) throw new Error('Redis connection refused');
      const hash = `ir_${ir.metadata.name}_hash`;
      irCache.set(hash, ir);
      return hash;
    }),
    resolveAgentIR: vi.fn(async (hash: string) => irCache.get(hash) || null),
    cacheCompilationOutput: vi.fn(async (output: CompilationOutput) => {
      if (opts?.cacheThrows) throw new Error('Redis connection refused');
      const hash = `comp_hash_${Date.now()}`;
      compilationCache.set(hash, output);
      return hash;
    }),
    resolveCompilationOutput: vi.fn(async (hash: string) => compilationCache.get(hash) || null),
    compilationL1Cache: {
      get: vi.fn((hash: string) => compilationCache.get(hash) || undefined),
    },
  };
}

// =============================================================================
// MONGOOSE MODEL MOCKS
// =============================================================================

const bookingIR = createMockAgentIR('booking_agent');
const supervisorIR = createMockAgentIR('supervisor', {
  routing: { rules: [{ to: 'booking_agent', when: 'booking' }] },
});

// Mock Mongoose model instances with chainable .lean() / .sort() / .lean()
const mockDeploymentFindOne = vi.fn();
const mockDeploymentUpdateOne = vi.fn().mockReturnValue({ catch: vi.fn() });
const mockProjectAgentFind = vi.fn();
const mockAgentVersionFindOne = vi.fn();
const mockAuditLogCreate = vi.fn().mockReturnValue({ catch: vi.fn() });
const mockProjectFindById = vi.fn();
const mockProjectConfigVariableFind = vi.fn();
const mockProjectRuntimeConfigFindOne = vi.fn();
const mockProjectLLMConfigFindOne = vi.fn();
const mockPromptLibraryVersionFindOne = vi.fn();
const mockDeploymentModuleSnapshotFindOne = vi.fn();

// Helper to create chainable query mock (simulates Mongoose's .lean() / .sort() / .lean())
function chainable(result: any) {
  const chain: any = {
    lean: vi.fn(() => Promise.resolve(result)),
    sort: vi.fn(function (this: any) {
      return this;
    }),
  };
  chain.sort.mockReturnValue(chain);
  return chain;
}

vi.mock('@agent-platform/database/models', () => ({
  Deployment: {
    findOne: (...args: any[]) => {
      const result = mockDeploymentFindOne(...args);
      return chainable(result);
    },
    updateOne: (...args: any[]) => mockDeploymentUpdateOne(...args),
  },
  ProjectAgent: {
    find: (...args: any[]) => {
      const result = mockProjectAgentFind(...args);
      // find() returns an array, needs sort().lean()
      const chain: any = {
        sort: vi.fn(),
        lean: vi.fn(() => Promise.resolve(result)),
      };
      chain.sort.mockReturnValue(chain);
      return chain;
    },
  },
  AgentVersion: {
    findOne: (...args: any[]) => {
      const result = mockAgentVersionFindOne(...args);
      return chainable(result);
    },
  },
  AuditLog: {
    create: (...args: any[]) => mockAuditLogCreate(...args),
  },
  Project: {
    findById: (...args: any[]) => {
      const result = mockProjectFindById(...args);
      return chainable(result);
    },
    findOne: (...args: any[]) => {
      const result = mockProjectFindById(...args);
      return chainable(result);
    },
  },
  ProjectConfigVariable: {
    find: (...args: any[]) => {
      const result = mockProjectConfigVariableFind(...args);
      return chainable(result);
    },
  },
  ProjectRuntimeConfig: {
    findOne: (...args: any[]) => {
      const result = mockProjectRuntimeConfigFindOne(...args);
      return chainable(result);
    },
  },
  ProjectLLMConfig: {
    findOne: (...args: any[]) => {
      const result = mockProjectLLMConfigFindOne(...args);
      return chainable(result);
    },
  },
  PromptLibraryVersion: {
    findOne: (...args: any[]) => {
      const result = mockPromptLibraryVersionFindOne(...args);
      return chainable(result);
    },
  },
  DeploymentModuleSnapshot: {
    findOne: (...args: any[]) => {
      const result = mockDeploymentModuleSnapshotFindOne(...args);
      return { lean: () => Promise.resolve(result) };
    },
  },
}));

vi.mock('../../repos/project-repo.js', () => ({
  findProjectRuntimeConfig: async () => mockProjectRuntimeConfigFindOne(),
  findProjectLLMConfig: async () => mockProjectLLMConfigFindOne(),
  loadConfigVariablesMap: async () => {
    const docs = mockProjectConfigVariableFind();
    const variables: Record<string, string> = {};
    for (const doc of Array.isArray(docs) ? docs : []) {
      if (typeof doc?.key === 'string' && typeof doc?.value === 'string') {
        variables[doc.key] = doc.value;
      }
    }
    return variables;
  },
}));

vi.mock('@abl/compiler/platform', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

const mockResolveToolImplementations = vi.fn();
vi.mock('@agent-platform/shared/tools/resolve', () => ({
  resolveToolImplementations: (...args: unknown[]) => mockResolveToolImplementations(...args),
}));

const mockFindMcpServerConfigsByProject = vi.fn().mockResolvedValue([]);
vi.mock('@agent-platform/shared/repos', () => ({
  findMcpServerConfigsByProject: (...args: unknown[]) => mockFindMcpServerConfigsByProject(...args),
}));

// Mock runtime-executor to avoid pulling in the full @abl/compiler transitive chain.
// resolveProjectToolsFromDocuments delegates to the mocked resolveToolImplementations above.
const mockResolveProjectToolsFromDocuments = vi.fn();
vi.mock('../../services/execution/types.js', () => ({
  resolveProjectToolsFromDocuments: (...args: unknown[]) =>
    mockResolveProjectToolsFromDocuments(...args),
}));

// =============================================================================
// SETUP HELPERS
// =============================================================================

function setupDefaultMocks(overrides: Record<string, any> = {}) {
  const mockDeployment = {
    _id: 'deploy-1',
    projectId: 'proj-1',
    tenantId: 'tenant-1',
    environment: 'production',
    status: 'active',
    agentVersionManifest: JSON.stringify({ booking_agent: '0.1.0', supervisor: '0.2.0' }),
    entryAgentName: 'supervisor',
    compilationHash: null,
    drainingStartedAt: null,
    ...overrides.deployment,
  };

  const mockProjectAgents = (
    overrides.projectAgents || [
      {
        _id: 'pa-1',
        name: 'booking_agent',
        projectId: 'proj-1',
        dslContent: 'AGENT: booking_agent\nGOAL: "Help users book hotels"',
        activeVersions: JSON.stringify({ production: '0.1.0', default: '0.1.0' }),
      },
      {
        _id: 'pa-2',
        name: 'supervisor',
        projectId: 'proj-1',
        dslContent: 'AGENT: supervisor\nGOAL: "Route users to the right specialist"',
        activeVersions: JSON.stringify({ production: '0.2.0', default: '0.2.0' }),
      },
    ]
  ).map((agent: Record<string, unknown>) => ({
    dslValidationStatus: 'valid',
    dslDiagnostics: [],
    ...agent,
  }));

  const mockAgentVersions: Record<string, any> = {
    'pa-1:0.1.0': {
      _id: 'av-1',
      agentId: 'pa-1',
      version: '0.1.0',
      irContent: JSON.stringify(bookingIR),
      status: 'active',
    },
    'pa-2:0.2.0': {
      _id: 'av-2',
      agentId: 'pa-2',
      version: '0.2.0',
      irContent: JSON.stringify(supervisorIR),
      status: 'active',
    },
    ...(overrides.agentVersions || {}),
  };

  mockDeploymentFindOne.mockImplementation((where: any) => {
    if (overrides.deploymentFindFirst) return overrides.deploymentFindFirst(where);
    if (where._id === mockDeployment._id && where.tenantId === mockDeployment.tenantId) {
      return mockDeployment;
    }
    return null;
  });

  mockDeploymentUpdateOne.mockReturnValue({ catch: vi.fn() });

  mockProjectAgentFind.mockImplementation((where: any) => {
    return mockProjectAgents.filter((a: any) => a.projectId === where.projectId);
  });

  mockAgentVersionFindOne.mockImplementation((where: any) => {
    const key = `${where.agentId}:${where.version}`;
    return mockAgentVersions[key] || null;
  });

  mockAuditLogCreate.mockReturnValue({ catch: vi.fn() });

  mockProjectFindById.mockImplementation(() => {
    return { tenantId: 'tenant-1' };
  });
  mockProjectConfigVariableFind.mockImplementation(() => overrides.configVariables ?? []);
  mockProjectRuntimeConfigFindOne.mockImplementation(() => overrides.runtimeConfig ?? null);
  mockProjectLLMConfigFindOne.mockImplementation(() => overrides.llmConfig ?? null);

  return { mockDeployment, mockProjectAgents, mockAgentVersions };
}

// Import module under test (must be after vi.mock)
import {
  DeploymentResolver,
  DeploymentError,
  type ResolveContext,
  type ResolvedAgent,
} from '../../services/deployment-resolver.js';

// =============================================================================
// TESTS
// =============================================================================

describe('DeploymentResolver', () => {
  let sessionService: ReturnType<typeof createMockSessionService>;
  let resolver: DeploymentResolver;

  beforeEach(() => {
    vi.clearAllMocks();
    sessionService = createMockSessionService();
    setupDefaultMocks();
    resolver = new DeploymentResolver(sessionService as any);

    // Default: resolveProjectToolsFromDocuments returns empty map
    mockResolveProjectToolsFromDocuments.mockResolvedValue(new Map());
    mockPromptLibraryVersionFindOne.mockReturnValue(null);
    mockDeploymentModuleSnapshotFindOne.mockReturnValue(null);
  });

  // ===========================================================================
  // Strategy 1: Resolve by deploymentId
  // ===========================================================================

  describe('resolveByDeployment', () => {
    it('should resolve agents from deployment manifest', async () => {
      const result = await resolver.resolve({
        projectId: 'proj-1',
        tenantId: 'tenant-1',
        deploymentId: 'deploy-1',
      });

      expect(result.entryAgent).toBe('supervisor');
      expect(Object.keys(result.agents)).toHaveLength(2);
      expect(result.agents['booking_agent']).toBeDefined();
      expect(result.agents['supervisor']).toBeDefined();
      expect(result.compilationOutput).toBeDefined();
      expect(result.compilationOutput.entry_agent).toBe('supervisor');
      expect(result.sourceHash).toBeTruthy();
      expect(result.versionInfo.deploymentId).toBe('deploy-1');
      expect(result.versionInfo.environment).toBe('production');
    });

    it('preserves remote agent metadata and coordination defaults from saved versions', async () => {
      const remoteSupervisorIR = createMockAgentIR('supervisor', {
        routing: {
          rules: [{ to: 'remote_agent', when: 'always' }],
        },
        coordination: {
          handoffs: [
            {
              to: 'remote_agent',
              when: 'always',
              context: { pass: [], summary: 'Route to remote specialist', history: 'full' },
              return: true,
              remote: {
                location: 'remote',
                endpoint: 'https://remote.example.com/a2a',
                protocol: 'a2a',
              },
            },
          ],
        },
      });

      setupDefaultMocks({
        agentVersions: {
          'pa-2:0.2.0': {
            _id: 'av-2',
            agentId: 'pa-2',
            version: '0.2.0',
            status: 'active',
            irContent: JSON.stringify({
              version: '1.0',
              compiled_at: new Date().toISOString(),
              agents: {
                supervisor: remoteSupervisorIR,
              },
              entry_agent: 'supervisor',
              deployment: {
                runtime_recommendations: {},
                parallel_safe: [],
                stateful: [],
                hitl_capable: [],
              },
              remote_agents: {
                remote_agent: {
                  location: 'remote',
                  endpoint: 'https://remote.example.com/a2a',
                  protocol: 'a2a',
                },
              },
              coordination_defaults: {
                defaultHistoryStrategy: 'full',
                autoHistoryFallbackLastN: 6,
              },
            }),
          },
        },
      });

      const result = await resolver.resolve({
        projectId: 'proj-1',
        tenantId: 'tenant-1',
        deploymentId: 'deploy-1',
      });

      expect(result.compilationOutput.remote_agents).toEqual({
        remote_agent: {
          location: 'remote',
          endpoint: 'https://remote.example.com/a2a',
          protocol: 'a2a',
        },
      });
      expect(result.compilationOutput.coordination_defaults).toEqual({
        defaultHistoryStrategy: 'full',
        autoHistoryFallbackLastN: 6,
      });
    });

    it('should cache agent IRs in session service', async () => {
      await resolver.resolve({
        projectId: 'proj-1',
        tenantId: 'tenant-1',
        deploymentId: 'deploy-1',
      });

      expect(sessionService.cacheAgentIR).toHaveBeenCalledTimes(2);
      expect(sessionService.cacheCompilationOutput).toHaveBeenCalledTimes(1);
    });

    it('should throw 404 for non-existent deployment', async () => {
      await expect(
        resolver.resolve({
          projectId: 'proj-1',
          tenantId: 'tenant-1',
          deploymentId: 'non-existent',
        }),
      ).rejects.toThrow('Deployment not found');
    });

    it('should throw 410 for retired deployment', async () => {
      setupDefaultMocks({
        deployment: { status: 'retired' },
      });

      try {
        await resolver.resolve({
          projectId: 'proj-1',
          tenantId: 'tenant-1',
          deploymentId: 'deploy-1',
        });
        expect.fail('Should have thrown');
      } catch (err: any) {
        expect(err.message).toContain('retired');
        expect(err.statusCode).toBe(410);
      }
    });

    it('should throw for project mismatch', async () => {
      await expect(
        resolver.resolve({
          projectId: 'wrong-project',
          tenantId: 'tenant-1',
          deploymentId: 'deploy-1',
        }),
      ).rejects.toThrow('Deployment does not belong to this project');
    });

    it('should update compilationHash on deployment after cache miss', async () => {
      await resolver.resolve({
        projectId: 'proj-1',
        tenantId: 'tenant-1',
        deploymentId: 'deploy-1',
      });

      expect(mockDeploymentUpdateOne).toHaveBeenCalledWith(
        expect.objectContaining({ _id: 'deploy-1' }),
        expect.objectContaining({
          $set: expect.objectContaining({
            compilationHash: expect.any(String),
          }),
        }),
      );
    });

    it('should allow draining deployments within grace period', async () => {
      setupDefaultMocks({
        deployment: {
          status: 'draining',
          drainingStartedAt: new Date(), // just started
        },
      });

      const result = await resolver.resolve({
        projectId: 'proj-1',
        tenantId: 'tenant-1',
        deploymentId: 'deploy-1',
      });

      expect(result.entryAgent).toBe('supervisor');
    });

    it('should use compilation cache hit when compilationHash is set', async () => {
      // Pre-populate cache
      const cachedCompilation: CompilationOutput = {
        version: '1.0',
        compiled_at: new Date().toISOString(),
        agents: {
          booking_agent: createMockAgentIR('booking_agent') as any,
          supervisor: createMockAgentIR('supervisor') as any,
        },
        entry_agent: 'supervisor',
        deployment: {
          runtime_recommendations: {},
          parallel_safe: [],
          stateful: [],
          hitl_capable: [],
        },
      };

      sessionService.resolveCompilationOutput.mockResolvedValueOnce(cachedCompilation);

      setupDefaultMocks({
        deployment: { compilationHash: 'cached-hash-123' },
      });

      const result = await resolver.resolve({
        projectId: 'proj-1',
        tenantId: 'tenant-1',
        deploymentId: 'deploy-1',
      });

      expect(result.entryAgent).toBe('supervisor');
      expect(sessionService.resolveCompilationOutput).toHaveBeenCalledWith('cached-hash-123');
      // Should NOT have loaded from DB (no agentVersion.findOne calls)
      expect(mockAgentVersionFindOne).not.toHaveBeenCalled();
    });

    it('rejects cached deployment resolution when current canonical LLM policy is invalid', async () => {
      const cachedCompilation: CompilationOutput = {
        version: '1.0',
        compiled_at: new Date().toISOString(),
        agents: {
          booking_agent: createMockAgentIR('booking_agent') as any,
          supervisor: createMockAgentIR('supervisor') as any,
        },
        entry_agent: 'supervisor',
        deployment: {
          runtime_recommendations: {},
          parallel_safe: [],
          stateful: [],
          hitl_capable: [],
        },
      };

      sessionService.resolveCompilationOutput.mockResolvedValueOnce(cachedCompilation);
      setupDefaultMocks({
        deployment: { compilationHash: 'cached-hash-123' },
        llmConfig: {
          operationTierOverrides: {
            response_gen: 'voice',
          },
        },
      });

      await expect(
        resolver.resolve({
          projectId: 'proj-1',
          tenantId: 'tenant-1',
          deploymentId: 'deploy-1',
        }),
      ).rejects.toMatchObject({
        statusCode: 422,
        message:
          'Project DSL has validation errors. Fix the draft or runtime config before starting a runtime session.',
      });
      expect(sessionService.resolveCompilationOutput).not.toHaveBeenCalled();
      expect(mockAgentVersionFindOne).not.toHaveBeenCalled();
    });

    it('does not let module snapshot overlays mutate a shared compilation cache hit', async () => {
      const cachedCompilation: CompilationOutput = {
        version: '1.0',
        compiled_at: new Date().toISOString(),
        agents: {
          cached_agent: createMockAgentIR('cached_agent') as any,
        },
        entry_agent: 'cached_agent',
        deployment: {
          runtime_recommendations: {},
          parallel_safe: [],
          stateful: [],
          hitl_capable: [],
        },
      };

      sessionService.resolveCompilationOutput.mockResolvedValue(cachedCompilation);
      mockDeploymentFindOne.mockImplementation((where: any) => {
        if (where.tenantId !== 'tenant-1') return null;
        if (where._id === 'deploy-a' || where._id === 'deploy-b') {
          return {
            _id: where._id,
            projectId: 'proj-1',
            tenantId: 'tenant-1',
            environment: 'production',
            status: 'active',
            agentVersionManifest: JSON.stringify({ cached_agent: '1.0.0' }),
            entryAgentName: 'cached_agent',
            compilationHash: 'shared-compilation',
            drainingStartedAt: null,
          };
        }
        return null;
      });

      mockDeploymentModuleSnapshotFindOne.mockImplementation((where: any) => {
        const mountedName =
          where.deploymentId === 'deploy-a'
            ? 'payments__checkout'
            : where.deploymentId === 'deploy-b'
              ? 'crm__lookup'
              : null;
        if (!mountedName) return null;

        const [alias, sourceAgentName] = mountedName.split('__');
        const payload = {
          dependencies: [],
          mountedAgents: {
            [mountedName]: {
              sourceAgentName,
              alias,
              moduleProjectId: `module-${alias}`,
              moduleReleaseId: `release-${alias}`,
              ir: createMockAgentIR(mountedName),
            },
          },
          mountedTools: {},
          snapshotHash: `hash-${mountedName}`,
        };

        return {
          tenantId: 'tenant-1',
          deploymentId: where.deploymentId,
          compressedPayload: zlib.gzipSync(Buffer.from(JSON.stringify(payload), 'utf-8')),
        };
      });

      const first = await resolver.resolve({
        projectId: 'proj-1',
        tenantId: 'tenant-1',
        deploymentId: 'deploy-a',
      });
      const second = await resolver.resolve({
        projectId: 'proj-1',
        tenantId: 'tenant-1',
        deploymentId: 'deploy-b',
      });

      expect(first.agents.payments__checkout).toBeDefined();
      expect(first.compilationOutput.agents.payments__checkout).toBeDefined();
      expect(first.agents.crm__lookup).toBeUndefined();

      expect(second.agents.crm__lookup).toBeDefined();
      expect(second.compilationOutput.agents.crm__lookup).toBeDefined();
      expect(second.agents.payments__checkout).toBeUndefined();

      expect(Object.keys(cachedCompilation.agents)).toEqual(['cached_agent']);
    });

    it('should fall through to DB when cache miss despite compilationHash', async () => {
      sessionService.resolveCompilationOutput.mockResolvedValueOnce(null);

      setupDefaultMocks({
        deployment: { compilationHash: 'stale-hash' },
      });

      const result = await resolver.resolve({
        projectId: 'proj-1',
        tenantId: 'tenant-1',
        deploymentId: 'deploy-1',
      });

      expect(result.agents['booking_agent']).toBeDefined();
      expect(mockAgentVersionFindOne).toHaveBeenCalled();
    });

    it('should throw 500 for corrupt manifest JSON', async () => {
      setupDefaultMocks({
        deployment: {
          agentVersionManifest: 'not-json{{{',
        },
      });

      await expect(
        resolver.resolve({
          projectId: 'proj-1',
          tenantId: 'tenant-1',
          deploymentId: 'deploy-1',
        }),
      ).rejects.toThrow('invalid version manifest');
    });

    it('should throw 500 for agent version with corrupt IR', async () => {
      setupDefaultMocks({
        agentVersions: {
          'pa-1:0.1.0': {
            _id: 'av-1',
            agentId: 'pa-1',
            version: '0.1.0',
            irContent: 'corrupt-ir{{{',
            status: 'active',
          },
        },
      });

      await expect(
        resolver.resolve({
          projectId: 'proj-1',
          tenantId: 'tenant-1',
          deploymentId: 'deploy-1',
        }),
      ).rejects.toThrow('corrupt IR content');
    });

    it('should throw 500 for agent version with no IR', async () => {
      setupDefaultMocks({
        agentVersions: {
          'pa-1:0.1.0': {
            _id: 'av-1',
            agentId: 'pa-1',
            version: '0.1.0',
            irContent: null,
            status: 'active',
          },
        },
      });

      await expect(
        resolver.resolve({
          projectId: 'proj-1',
          tenantId: 'tenant-1',
          deploymentId: 'deploy-1',
        }),
      ).rejects.toThrow('no compiled IR');
    });

    it('should throw 404 for agent not found in project', async () => {
      setupDefaultMocks({
        deployment: {
          agentVersionManifest: JSON.stringify({ nonexistent_agent: '1.0.0' }),
          entryAgentName: 'nonexistent_agent',
        },
      });

      await expect(
        resolver.resolve({
          projectId: 'proj-1',
          tenantId: 'tenant-1',
          deploymentId: 'deploy-1',
        }),
      ).rejects.toThrow('Agent not found in project');
    });

    it('should succeed even when cache writes fail (graceful degradation)', async () => {
      sessionService = createMockSessionService({ cacheThrows: true });
      resolver = new DeploymentResolver(sessionService as any);

      const result = await resolver.resolve({
        projectId: 'proj-1',
        tenantId: 'tenant-1',
        deploymentId: 'deploy-1',
      });

      // Should still resolve despite cache failure
      expect(result.agents['booking_agent']).toBeDefined();
      expect(result.entryAgent).toBe('supervisor');
    });
  });

  // ===========================================================================
  // Draining auto-retire
  // ===========================================================================

  describe('draining auto-retire', () => {
    it('should auto-retire draining deployments past grace period', async () => {
      const thirtyOneMinAgo = new Date(Date.now() - 31 * 60 * 1000);
      setupDefaultMocks({
        deployment: {
          status: 'draining',
          drainingStartedAt: thirtyOneMinAgo,
        },
      });

      try {
        await resolver.resolve({
          projectId: 'proj-1',
          tenantId: 'tenant-1',
          deploymentId: 'deploy-1',
        });
        expect.fail('Should have thrown');
      } catch (err: any) {
        expect(err.statusCode).toBe(410);
        expect(err.message).toContain('retired');
      }

      // Should have fired auto-retire update
      expect(mockDeploymentUpdateOne).toHaveBeenCalledWith(
        expect.objectContaining({ _id: 'deploy-1' }),
        expect.objectContaining({
          $set: expect.objectContaining({ status: 'retired' }),
        }),
      );
    });

    it('should allow draining deployments within grace period', async () => {
      const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);
      setupDefaultMocks({
        deployment: {
          status: 'draining',
          drainingStartedAt: fiveMinAgo,
        },
      });

      const result = await resolver.resolve({
        projectId: 'proj-1',
        tenantId: 'tenant-1',
        deploymentId: 'deploy-1',
      });

      expect(result.entryAgent).toBe('supervisor');
    });

    it('should respect custom grace period', async () => {
      const twoMinAgo = new Date(Date.now() - 2 * 60 * 1000);
      setupDefaultMocks({
        deployment: {
          status: 'draining',
          drainingStartedAt: twoMinAgo,
        },
      });
      // Custom 1-minute grace period
      resolver = new DeploymentResolver(sessionService as any, 60 * 1000);

      try {
        await resolver.resolve({
          projectId: 'proj-1',
          tenantId: 'tenant-1',
          deploymentId: 'deploy-1',
        });
        expect.fail('Should have thrown');
      } catch (err: any) {
        expect(err.statusCode).toBe(410);
      }
    });

    it('should allow draining without drainingStartedAt (no auto-retire)', async () => {
      setupDefaultMocks({
        deployment: {
          status: 'draining',
          drainingStartedAt: null,
        },
      });

      const result = await resolver.resolve({
        projectId: 'proj-1',
        tenantId: 'tenant-1',
        deploymentId: 'deploy-1',
      });

      expect(result.entryAgent).toBe('supervisor');
    });
  });

  // ===========================================================================
  // Strategy 2: Resolve by environment
  // ===========================================================================

  describe('resolveByEnvironment', () => {
    it('should resolve agents from active versions for environment', async () => {
      const result = await resolver.resolve({
        projectId: 'proj-1',
        tenantId: 'tenant-1',
        environment: 'production',
      });

      expect(Object.keys(result.agents)).toHaveLength(2);
      expect(result.versionInfo.environment).toBe('production');
    });

    it('preserves remote agent metadata for environment-based resolution', async () => {
      const remoteSupervisorIR = createMockAgentIR('supervisor', {
        routing: {
          rules: [{ to: 'remote_agent', when: 'always' }],
        },
        coordination: {
          handoffs: [
            {
              to: 'remote_agent',
              when: 'always',
              context: { pass: [], summary: 'Route to remote specialist' },
              return: true,
              remote: {
                location: 'remote',
                endpoint: 'https://remote.example.com/a2a',
                protocol: 'a2a',
              },
            },
          ],
        },
      });

      setupDefaultMocks({
        agentVersions: {
          'pa-2:0.2.0': {
            _id: 'av-2',
            agentId: 'pa-2',
            version: '0.2.0',
            status: 'active',
            irContent: JSON.stringify({
              version: '1.0',
              compiled_at: new Date().toISOString(),
              agents: {
                supervisor: remoteSupervisorIR,
              },
              entry_agent: 'supervisor',
              deployment: {
                runtime_recommendations: {},
                parallel_safe: [],
                stateful: [],
                hitl_capable: [],
              },
              remote_agents: {
                remote_agent: {
                  location: 'remote',
                  endpoint: 'https://remote.example.com/a2a',
                  protocol: 'a2a',
                },
              },
            }),
          },
        },
      });

      const result = await resolver.resolve({
        projectId: 'proj-1',
        tenantId: 'tenant-1',
        environment: 'production',
      });

      expect(result.compilationOutput.remote_agents).toEqual({
        remote_agent: {
          location: 'remote',
          endpoint: 'https://remote.example.com/a2a',
          protocol: 'a2a',
        },
      });
    });

    it('should detect supervisor as entry agent', async () => {
      const result = await resolver.resolve({
        projectId: 'proj-1',
        tenantId: 'tenant-1',
        environment: 'production',
      });

      expect(result.entryAgent).toBe('supervisor');
    });

    it('should use specific agentName as entry when provided', async () => {
      const result = await resolver.resolve({
        projectId: 'proj-1',
        tenantId: 'tenant-1',
        environment: 'production',
        agentName: 'booking_agent',
      });

      expect(result.entryAgent).toBe('booking_agent');
    });

    it('should throw for no agents in project', async () => {
      setupDefaultMocks({ projectAgents: [] });

      await expect(
        resolver.resolve({
          projectId: 'proj-1',
          tenantId: 'tenant-1',
          environment: 'production',
        }),
      ).rejects.toThrow('No agents found');
    });

    it('should throw for tenant mismatch', async () => {
      mockProjectFindById.mockImplementation(() => ({ tenantId: 'other-tenant' }));

      await expect(
        resolver.resolve({
          projectId: 'proj-1',
          tenantId: 'wrong-tenant',
          environment: 'production',
        }),
      ).rejects.toThrow('Tenant mismatch');
    });

    it('should throw when no active versions for environment', async () => {
      setupDefaultMocks({
        projectAgents: [
          {
            _id: 'pa-1',
            name: 'booking_agent',
            projectId: 'proj-1',
            dslContent: 'AGENT: booking_agent\nGOAL: "Help users book hotels"',
            activeVersions: JSON.stringify({}),
          },
        ],
      });

      await expect(
        resolver.resolve({
          projectId: 'proj-1',
          tenantId: 'tenant-1',
          environment: 'staging',
        }),
      ).rejects.toThrow('No active versions found');
    });

    it('should use default version when environment-specific is not set', async () => {
      setupDefaultMocks({
        projectAgents: [
          {
            _id: 'pa-1',
            name: 'booking_agent',
            projectId: 'proj-1',
            dslContent: 'AGENT: booking_agent\nGOAL: "Help users book hotels"',
            activeVersions: JSON.stringify({ default: '0.1.0' }),
          },
        ],
      });

      const result = await resolver.resolve({
        projectId: 'proj-1',
        tenantId: 'tenant-1',
        environment: 'staging', // Not in activeVersions, falls back to default
      });

      expect(result.agents['booking_agent']).toBeDefined();
    });
  });

  // ===========================================================================
  // Strategy 3: Resolve working copy (fallback)
  // ===========================================================================

  describe('resolveWorkingCopy', () => {
    it('should throw without allowWorkingCopy when no other strategy', async () => {
      await expect(
        resolver.resolve({
          projectId: 'proj-1',
          tenantId: 'tenant-1',
        }),
      ).rejects.toThrow('No resolution strategy available');
    });

    it('should compile from DSL content when allowWorkingCopy is true', async () => {
      const result = await resolver.resolve({
        projectId: 'proj-1',
        tenantId: 'tenant-1',
        allowWorkingCopy: true,
      });

      expect(result.agents).toBeDefined();
      expect(result.compilationOutput).toBeDefined();
      expect(result.versionInfo.versions).toEqual({});
      expect(mockProjectAgentFind).toHaveBeenCalledWith({
        projectId: 'proj-1',
        tenantId: 'tenant-1',
      });
    });

    it('continues to compile legacy persisted brace-style DSL drafts', async () => {
      setupDefaultMocks({
        projectAgents: [
          {
            _id: 'pa-legacy-1',
            name: 'booking_agent',
            projectId: 'proj-1',
            dslContent: 'agent booking_agent { name: "Booking" reasoning { tools: [] } }',
          },
          {
            _id: 'pa-legacy-2',
            name: 'main_supervisor',
            projectId: 'proj-1',
            dslContent: 'supervisor main_supervisor { name: "Supervisor" routing { } }',
          },
        ],
      });

      const result = await resolver.resolve({
        projectId: 'proj-1',
        tenantId: 'tenant-1',
        allowWorkingCopy: true,
      });

      expect(result.entryAgent).toBe('booking_agent');
      expect(result.agents.booking_agent).toBeDefined();
      expect(result.agents.main_supervisor).toBeDefined();
    });

    it('should reject working-copy DSL drafts with persisted validation errors', async () => {
      setupDefaultMocks({
        projectAgents: [
          {
            _id: 'pa-1',
            name: 'booking_agent',
            projectId: 'proj-1',
            dslContent: 'AGENT: booking_agent\nGOAL: "Help users book hotels"',
            dslValidationStatus: 'error',
            dslDiagnostics: [
              {
                severity: 'error',
                message: 'ON_ACTION handoff target "MissingAgent" must be declared',
              },
            ],
          },
        ],
      });

      await expect(
        resolver.resolve({
          projectId: 'proj-1',
          tenantId: 'tenant-1',
          allowWorkingCopy: true,
        }),
      ).rejects.toThrow('Project DSL has validation errors');
    });

    it('should reject working-copy runtime config readiness issues before compiling drafts', async () => {
      setupDefaultMocks({
        runtimeConfig: {
          extraction: {
            nlu_provider: 'advanced',
          },
        },
      });

      await expect(
        resolver.resolve({
          projectId: 'proj-1',
          tenantId: 'tenant-1',
          allowWorkingCopy: true,
        }),
      ).rejects.toThrow('Project DSL has validation errors');

      expect(mockResolveProjectToolsFromDocuments).not.toHaveBeenCalled();
    });

    it('validates tenant before loading working-copy ProjectAgent rows', async () => {
      mockProjectAgentFind.mockClear();
      mockProjectFindById.mockImplementation(() => null);

      await expect(
        resolver.resolve({
          projectId: 'proj-1',
          tenantId: 'wrong-tenant',
          allowWorkingCopy: true,
        }),
      ).rejects.toThrow('Project has no tenant assignment');

      expect(mockProjectFindById).toHaveBeenCalledWith(
        { _id: 'proj-1', tenantId: 'wrong-tenant' },
        { tenantId: 1 },
      );
      expect(mockProjectAgentFind).not.toHaveBeenCalled();
    });

    it('should include stored behavior profile documents in working-copy compilation', async () => {
      setupDefaultMocks({
        projectAgents: [
          {
            _id: 'pa-1',
            name: 'booking_agent',
            projectId: 'proj-1',
            dslContent:
              'AGENT: booking_agent\nGOAL: "Help users book hotels"\n\nUSE BEHAVIOR_PROFILE: voice_profile',
          },
        ],
        configVariables: [
          {
            key: 'profile:voice_profile',
            value: 'BEHAVIOR_PROFILE: voice_profile\nPRIORITY: 10\nWHEN: true',
          },
        ],
      });

      const result = await resolver.resolve({
        projectId: 'proj-1',
        tenantId: 'tenant-1',
        allowWorkingCopy: true,
      });

      expect(result.agents.booking_agent.behavior_profiles).toEqual([{ name: 'voice_profile' }]);
    });

    it('should ignore an unknown agentName and fall back to compiled entry agent', async () => {
      setupDefaultMocks({
        projectAgents: [
          {
            _id: 'pa-1',
            name: 'slack_bot',
            projectId: 'proj-1',
            dslContent: 'AGENT: slack_bot\nGOAL: "Help Slack users"',
          },
          {
            _id: 'pa-2',
            name: 'testagent',
            projectId: 'proj-1',
            dslContent: 'AGENT: testagent\nGOAL: "Help test users"',
          },
        ],
      });

      const result = await resolver.resolve({
        projectId: 'proj-1',
        tenantId: 'tenant-1',
        agentName: 'supervisor',
        allowWorkingCopy: true,
      });

      expect(result.entryAgent).toBe('slack_bot');
      expect(result.agents['slack_bot']).toBeDefined();
      expect(result.agents['testagent']).toBeDefined();
    });

    it('should throw for tenant mismatch in working copy path', async () => {
      mockProjectFindById.mockImplementation(() => ({ tenantId: 'other-tenant' }));

      await expect(
        resolver.resolve({
          projectId: 'proj-1',
          tenantId: 'wrong-tenant',
          allowWorkingCopy: true,
        }),
      ).rejects.toThrow('Tenant mismatch');
    });
  });

  // ===========================================================================
  // Resolution priority
  // ===========================================================================

  describe('resolution priority', () => {
    it('should prefer deploymentId over environment', async () => {
      const result = await resolver.resolve({
        projectId: 'proj-1',
        tenantId: 'tenant-1',
        deploymentId: 'deploy-1',
        environment: 'staging',
      });

      expect(result.versionInfo.deploymentId).toBe('deploy-1');
      expect(result.versionInfo.environment).toBe('production'); // From deployment, not from param
    });

    it('should prefer environment over working copy', async () => {
      const result = await resolver.resolve({
        projectId: 'proj-1',
        tenantId: 'tenant-1',
        environment: 'production',
        allowWorkingCopy: true,
      });

      expect(result.versionInfo.environment).toBe('production');
      expect(result.versionInfo.versions).toBeDefined();
      expect(Object.keys(result.versionInfo.versions).length).toBeGreaterThan(0);
    });
  });

  // ===========================================================================
  // Version info
  // ===========================================================================

  describe('versionInfo', () => {
    it('should include version numbers parsed from semver (1000000/1000 spacing)', async () => {
      const result = await resolver.resolve({
        projectId: 'proj-1',
        tenantId: 'tenant-1',
        deploymentId: 'deploy-1',
      });

      // "0.1.0" -> 0*1000000 + 1*1000 + 0 = 1000
      expect(result.versionInfo.versions['booking_agent']).toBe(1000);
      // "0.2.0" -> 0*1000000 + 2*1000 + 0 = 2000
      expect(result.versionInfo.versions['supervisor']).toBe(2000);
    });
  });

  // ===========================================================================
  // parseVersionNumber
  // ===========================================================================

  describe('parseVersionNumber', () => {
    it('should parse standard semver', () => {
      expect(resolver.parseVersionNumber('1.2.3')).toBe(1002003);
      expect(resolver.parseVersionNumber('0.0.1')).toBe(1);
      expect(resolver.parseVersionNumber('0.1.0')).toBe(1000);
      expect(resolver.parseVersionNumber('10.20.30')).toBe(10020030);
    });

    it('should strip v prefix', () => {
      expect(resolver.parseVersionNumber('v1.2.3')).toBe(1002003);
      expect(resolver.parseVersionNumber('V0.1.0')).toBe(1000);
    });

    it('should strip pre-release suffix', () => {
      expect(resolver.parseVersionNumber('1.2.3-beta')).toBe(1002003);
      expect(resolver.parseVersionNumber('1.0.0-rc.1')).toBe(1000000);
    });

    it('should handle non-semver strings', () => {
      expect(resolver.parseVersionNumber('42')).toBe(42);
      expect(resolver.parseVersionNumber('not-a-version')).toBe(0);
    });
  });

  // ===========================================================================
  // DeploymentError
  // ===========================================================================

  describe('DeploymentError', () => {
    it('should carry statusCode', () => {
      const err = new DeploymentError('not found', 404);
      expect(err.message).toBe('not found');
      expect(err.statusCode).toBe(404);
      expect(err.name).toBe('DeploymentError');
    });

    it('should default to 500', () => {
      const err = new DeploymentError('internal');
      expect(err.statusCode).toBe(500);
    });

    it('should be instanceof Error', () => {
      const err = new DeploymentError('test', 400);
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(DeploymentError);
    });
  });

  // ===========================================================================
  // Tenant isolation
  // ===========================================================================

  describe('tenant isolation', () => {
    it('should enforce tenant on deployment lookup', async () => {
      // Deployment exists but with different tenantId
      await expect(
        resolver.resolve({
          projectId: 'proj-1',
          tenantId: 'different-tenant',
          deploymentId: 'deploy-1',
        }),
      ).rejects.toThrow('Deployment not found');
    });
  });

  // ===========================================================================
  // Deterministic hashing
  // ===========================================================================

  describe('content hashing', () => {
    it('should produce consistent hash for same agent set', async () => {
      const result1 = await resolver.resolve({
        projectId: 'proj-1',
        tenantId: 'tenant-1',
        deploymentId: 'deploy-1',
      });

      const result2 = await resolver.resolve({
        projectId: 'proj-1',
        tenantId: 'tenant-1',
        deploymentId: 'deploy-1',
      });

      expect(result1.sourceHash).toBe(result2.sourceHash);
    });
  });

  // ===========================================================================
  // Tool resolution (working copy)
  // ===========================================================================

  describe('tool resolution (working copy)', () => {
    it('calls resolveProjectToolsFromDocuments for working copy compilation', async () => {
      mockResolveProjectToolsFromDocuments.mockResolvedValue(new Map());

      await resolver.resolve({
        projectId: 'proj-1',
        tenantId: 'tenant-1',
        allowWorkingCopy: true,
      });

      expect(mockResolveProjectToolsFromDocuments).toHaveBeenCalledWith(
        'tenant-1',
        'proj-1',
        expect.any(Array),
        { failOnErrors: true },
      );
    });

    it('fails closed when resolveProjectToolsFromDocuments throws', async () => {
      mockResolveProjectToolsFromDocuments.mockRejectedValue(new Error('DB connection failed'));

      await expect(
        resolver.resolve({
          projectId: 'proj-1',
          tenantId: 'tenant-1',
          allowWorkingCopy: true,
        }),
      ).rejects.toThrow('Agent compilation failed');
    });

    it('does not include shared_tools in compilationOutput', async () => {
      mockResolveProjectToolsFromDocuments.mockResolvedValue(new Map());

      const result = await resolver.resolve({
        projectId: 'proj-1',
        tenantId: 'tenant-1',
        allowWorkingCopy: true,
      });

      expect((result.compilationOutput as any).shared_tools).toBeUndefined();
    });
  });
});
