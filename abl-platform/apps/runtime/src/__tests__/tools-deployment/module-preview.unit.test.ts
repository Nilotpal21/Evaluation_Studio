/**
 * Module-Aware Preview/Deployment Execution Tests
 *
 * Tests that the DeploymentResolver correctly resolves module agents from
 * deployment snapshots, builds module snapshots with environment pointer
 * resolution, handles missing releases, empty modules, and tenant isolation.
 *
 * These are integration tests — DB layer is mocked but real service logic
 * (DeploymentResolver, mergeModuleSnapshot, gzip decompression) is exercised.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import zlib from 'node:zlib';
import type { AgentIR, CompilationOutput } from '@abl/compiler';
import type { DeploymentModuleSnapshotPayload } from '../../services/modules/types.js';

// =============================================================================
// MOCK @abl/core and @abl/compiler
// =============================================================================

vi.mock('@abl/core', () => ({
  parseAgentBasedABL: vi.fn((dsl: string) => {
    const name = dsl.match(/(?:agent|supervisor)\s+(\w+)/)?.[1] || 'unknown_agent';
    return {
      document: { raw: dsl, type: 'agent', name, tools: [] },
      errors: [],
    };
  }),
}));

vi.mock('@abl/compiler', () => ({
  FAN_OUT_MIN_TASKS: 2,
  FAN_OUT_MAX_TASKS: 5,
  compileABLtoIR: vi.fn((documents: any[]) => {
    const agents: Record<string, any> = {};
    for (const doc of documents) {
      const name =
        doc.raw?.match(/(?:agent|supervisor)\s+(\w+)/)?.[1] ||
        `agent_${Object.keys(agents).length}`;
      agents[name] = createMockAgentIR(name);
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

function createMockAgentIR(name: string, opts?: { routing?: any }): AgentIR {
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
    coordination: { handoffs: [], delegates: [] },
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

const mockDeploymentFindOne = vi.fn();
const mockDeploymentUpdateOne = vi.fn().mockReturnValue({ catch: vi.fn() });
const mockProjectAgentFind = vi.fn();
const mockAgentVersionFindOne = vi.fn();
const mockAuditLogCreate = vi.fn().mockReturnValue({ catch: vi.fn() });
const mockProjectFindOne = vi.fn();
const mockProjectRuntimeConfigFindOne = vi.fn();
const mockProjectLLMConfigFindOne = vi.fn();
const mockDeploymentModuleSnapshotFindOne = vi.fn();

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
    findOne: (...args: any[]) => {
      const result = mockProjectFindOne(...args);
      return chainable(result);
    },
    findById: (...args: any[]) => {
      const result = mockProjectFindOne(...args);
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
  PromptTemplate: {
    find: (...args: any[]) => chainable([]),
  },
  DeploymentModuleSnapshot: {
    findOne: (...args: any[]) => {
      const result = mockDeploymentModuleSnapshotFindOne(...args);
      return chainable(result);
    },
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

const mockResolveProjectToolsFromDocuments = vi.fn();
vi.mock('../../services/runtime-executor.js', () => ({
  resolveProjectToolsFromDocuments: (...args: unknown[]) =>
    mockResolveProjectToolsFromDocuments(...args),
}));

// =============================================================================
// SETUP HELPERS
// =============================================================================

function buildCompressedSnapshot(payload: DeploymentModuleSnapshotPayload): Buffer {
  const json = JSON.stringify(payload);
  return zlib.gzipSync(Buffer.from(json, 'utf-8'));
}

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

  const mockProjectAgents = overrides.projectAgents || [
    {
      _id: 'pa-1',
      name: 'booking_agent',
      projectId: 'proj-1',
      dslContent: 'agent booking_agent { name: "Booking" reasoning { tools: [] } }',
      dslValidationStatus: 'valid',
      activeVersions: JSON.stringify({ production: '0.1.0', default: '0.1.0' }),
    },
    {
      _id: 'pa-2',
      name: 'supervisor',
      projectId: 'proj-1',
      dslContent: 'supervisor main_supervisor { name: "Supervisor" routing { } }',
      dslValidationStatus: 'valid',
      activeVersions: JSON.stringify({ production: '0.2.0', default: '0.2.0' }),
    },
  ];

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
    // Environment-based lookup
    if (
      where.projectId === mockDeployment.projectId &&
      where.tenantId === mockDeployment.tenantId &&
      where.environment === mockDeployment.environment &&
      where.status === 'active'
    ) {
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

  mockProjectFindOne.mockImplementation(() => {
    return { tenantId: 'tenant-1' };
  });
  mockProjectRuntimeConfigFindOne.mockReturnValue(null);
  mockProjectLLMConfigFindOne.mockReturnValue(null);

  // Default: no module snapshot
  mockDeploymentModuleSnapshotFindOne.mockReturnValue(null);

  return { mockDeployment, mockProjectAgents, mockAgentVersions };
}

// Import module under test (must be after vi.mock)
import { DeploymentResolver, type ResolvedAgent } from '../../services/deployment-resolver.js';

// =============================================================================
// TESTS
// =============================================================================

describe('Module-Aware Preview/Deployment Execution', () => {
  let sessionService: ReturnType<typeof createMockSessionService>;
  let resolver: DeploymentResolver;

  beforeEach(() => {
    vi.clearAllMocks();
    sessionService = createMockSessionService();
    setupDefaultMocks();
    resolver = new DeploymentResolver(sessionService as any);
    mockResolveProjectToolsFromDocuments.mockResolvedValue(new Map());
  });

  // ===========================================================================
  // P1-I06: Preview resolves module agents from snapshot
  // ===========================================================================

  describe('P1-I06: Preview of a consumer project resolves module agents from snapshot', () => {
    it('should merge mounted agents from module snapshot into resolved agents', async () => {
      const moduleAgentIR = createMockAgentIR('payments__checkout');
      const snapshotPayload: DeploymentModuleSnapshotPayload = {
        dependencies: [
          {
            alias: 'payments',
            moduleProjectId: 'mod-proj-1',
            moduleReleaseId: 'rel-1',
            version: '1.0.0',
          },
        ],
        mountedAgents: {
          payments__checkout: {
            sourceAgentName: 'checkout',
            alias: 'payments',
            moduleProjectId: 'mod-proj-1',
            moduleReleaseId: 'rel-1',
            ir: moduleAgentIR,
          },
        },
        mountedTools: {},
        snapshotHash: 'abc123def456',
      };

      mockDeploymentModuleSnapshotFindOne.mockReturnValue({
        tenantId: 'tenant-1',
        deploymentId: 'deploy-1',
        compressedPayload: buildCompressedSnapshot(snapshotPayload),
      });

      const result = await resolver.resolve({
        projectId: 'proj-1',
        tenantId: 'tenant-1',
        deploymentId: 'deploy-1',
      });

      // Should have the 2 original agents + 1 module agent
      expect(Object.keys(result.agents)).toHaveLength(3);
      expect(result.agents['booking_agent']).toBeDefined();
      expect(result.agents['supervisor']).toBeDefined();
      expect(result.agents['payments__checkout']).toBeDefined();

      // Module agent should carry provenance metadata
      const moduleAgent = result.agents['payments__checkout'] as any;
      expect(moduleAgent._moduleProvenance).toBeDefined();
      expect(moduleAgent._moduleProvenance.alias).toBe('payments');
      expect(moduleAgent._moduleProvenance.moduleProjectId).toBe('mod-proj-1');
      expect(moduleAgent._moduleProvenance.moduleReleaseId).toBe('rel-1');
      expect(moduleAgent._moduleProvenance.sourceAgentName).toBe('checkout');
    });

    it('should merge module snapshots returned from Mongo as Binary-like payloads', async () => {
      const moduleAgentIR = createMockAgentIR('payments__checkout');
      const snapshotPayload: DeploymentModuleSnapshotPayload = {
        dependencies: [
          {
            alias: 'payments',
            moduleProjectId: 'mod-proj-1',
            moduleReleaseId: 'rel-1',
            version: '1.0.0',
          },
        ],
        mountedAgents: {
          payments__checkout: {
            sourceAgentName: 'checkout',
            alias: 'payments',
            moduleProjectId: 'mod-proj-1',
            moduleReleaseId: 'rel-1',
            ir: moduleAgentIR,
          },
        },
        mountedTools: {},
        snapshotHash: 'binary-payload-hash',
      };
      const compressedPayload = buildCompressedSnapshot(snapshotPayload);

      mockDeploymentModuleSnapshotFindOne.mockReturnValue({
        tenantId: 'tenant-1',
        deploymentId: 'deploy-1',
        compressedPayload: {
          buffer: compressedPayload.buffer,
          byteOffset: compressedPayload.byteOffset,
          byteLength: compressedPayload.byteLength,
        },
      });

      const result = await resolver.resolve({
        projectId: 'proj-1',
        tenantId: 'tenant-1',
        deploymentId: 'deploy-1',
      });

      expect(result.agents['payments__checkout']).toBeDefined();
      expect((result.agents['payments__checkout'] as any)._moduleProvenance.moduleReleaseId).toBe(
        'rel-1',
      );
    });

    it('should merge mounted tools from module snapshot into resolvedTools', async () => {
      const snapshotPayload: DeploymentModuleSnapshotPayload = {
        dependencies: [
          {
            alias: 'payments',
            moduleProjectId: 'mod-proj-1',
            moduleReleaseId: 'rel-1',
            version: '1.0.0',
          },
        ],
        mountedAgents: {},
        mountedTools: {
          payments__lookup: {
            sourceToolName: 'lookup',
            alias: 'payments',
            moduleProjectId: 'mod-proj-1',
            moduleReleaseId: 'rel-1',
            definition: {
              name: 'payments__lookup',
              tool_type: 'http',
            } as any,
          },
        },
        snapshotHash: 'toolhash123',
      };

      mockDeploymentModuleSnapshotFindOne.mockReturnValue({
        tenantId: 'tenant-1',
        deploymentId: 'deploy-1',
        compressedPayload: buildCompressedSnapshot(snapshotPayload),
      });

      const result = await resolver.resolve({
        projectId: 'proj-1',
        tenantId: 'tenant-1',
        deploymentId: 'deploy-1',
      });

      expect(result.resolvedTools).toBeDefined();
      expect(result.resolvedTools!['payments__lookup']).toBeDefined();
      const tool = result.resolvedTools!['payments__lookup'] as any;
      expect(tool._moduleProvenance).toBeDefined();
      expect(tool._moduleProvenance.alias).toBe('payments');
      expect(tool._moduleProvenance.sourceToolName).toBe('lookup');
    });
  });

  // ===========================================================================
  // Module snapshot built correctly with environment pointer resolution
  // ===========================================================================

  describe('module snapshot is built correctly with environment pointer resolution', () => {
    it('should resolve snapshot even when compilation cache is hit', async () => {
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

      const moduleAgentIR = createMockAgentIR('analytics__reporter');
      const snapshotPayload: DeploymentModuleSnapshotPayload = {
        dependencies: [
          {
            alias: 'analytics',
            moduleProjectId: 'mod-proj-2',
            moduleReleaseId: 'rel-2',
            version: '2.0.0',
          },
        ],
        mountedAgents: {
          analytics__reporter: {
            sourceAgentName: 'reporter',
            alias: 'analytics',
            moduleProjectId: 'mod-proj-2',
            moduleReleaseId: 'rel-2',
            ir: moduleAgentIR,
          },
        },
        mountedTools: {},
        snapshotHash: 'snaphash456',
      };

      mockDeploymentModuleSnapshotFindOne.mockReturnValue({
        tenantId: 'tenant-1',
        deploymentId: 'deploy-1',
        compressedPayload: buildCompressedSnapshot(snapshotPayload),
      });

      const result = await resolver.resolve({
        projectId: 'proj-1',
        tenantId: 'tenant-1',
        deploymentId: 'deploy-1',
      });

      // Should have cache-hit agents + module agent
      expect(result.agents['analytics__reporter']).toBeDefined();
      expect(result.entryAgent).toBe('supervisor');
      // Compilation should not have loaded from DB
      expect(mockAgentVersionFindOne).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // Missing module release returns appropriate error
  // ===========================================================================

  describe('missing module release returns appropriate error', () => {
    it('should resolve gracefully when no module snapshot exists', async () => {
      mockDeploymentModuleSnapshotFindOne.mockReturnValue(null);

      const result = await resolver.resolve({
        projectId: 'proj-1',
        tenantId: 'tenant-1',
        deploymentId: 'deploy-1',
      });

      // Should still resolve without module agents
      expect(Object.keys(result.agents)).toHaveLength(2);
      expect(result.agents['booking_agent']).toBeDefined();
      expect(result.agents['supervisor']).toBeDefined();
      expect(result.resolvedTools).toBeUndefined();
    });

    it('should fail closed when the compressed module snapshot is corrupt', async () => {
      mockDeploymentModuleSnapshotFindOne.mockReturnValue({
        tenantId: 'tenant-1',
        deploymentId: 'deploy-1',
        compressedPayload: Buffer.from('corrupt-not-gzip-data'),
      });

      await expect(
        resolver.resolve({
          projectId: 'proj-1',
          tenantId: 'tenant-1',
          deploymentId: 'deploy-1',
        }),
      ).rejects.toMatchObject({
        message: 'Deployment module snapshot could not be loaded',
        statusCode: 500,
      });
    });
  });

  // ===========================================================================
  // Module with no agents returns empty resolution
  // ===========================================================================

  describe('module with no agents returns empty resolution', () => {
    it('should handle snapshot with no mounted agents or tools', async () => {
      const snapshotPayload: DeploymentModuleSnapshotPayload = {
        dependencies: [
          {
            alias: 'empty',
            moduleProjectId: 'mod-proj-empty',
            moduleReleaseId: 'rel-empty',
            version: '1.0.0',
          },
        ],
        mountedAgents: {},
        mountedTools: {},
        snapshotHash: 'emptyhash',
      };

      mockDeploymentModuleSnapshotFindOne.mockReturnValue({
        tenantId: 'tenant-1',
        deploymentId: 'deploy-1',
        compressedPayload: buildCompressedSnapshot(snapshotPayload),
      });

      const result = await resolver.resolve({
        projectId: 'proj-1',
        tenantId: 'tenant-1',
        deploymentId: 'deploy-1',
      });

      // Should only have the 2 original agents — no module additions
      expect(Object.keys(result.agents)).toHaveLength(2);
      expect(result.resolvedTools).toBeUndefined();
    });
  });

  // ===========================================================================
  // Tenant isolation: module from different tenant not resolved
  // ===========================================================================

  describe('tenant isolation: module from different tenant not resolved', () => {
    it('should not resolve module snapshot from a different tenant', async () => {
      const moduleAgentIR = createMockAgentIR('evil__agent');
      const snapshotPayload: DeploymentModuleSnapshotPayload = {
        dependencies: [
          {
            alias: 'evil',
            moduleProjectId: 'mod-proj-evil',
            moduleReleaseId: 'rel-evil',
            version: '1.0.0',
          },
        ],
        mountedAgents: {
          evil__agent: {
            sourceAgentName: 'agent',
            alias: 'evil',
            moduleProjectId: 'mod-proj-evil',
            moduleReleaseId: 'rel-evil',
            ir: moduleAgentIR,
          },
        },
        mountedTools: {},
        snapshotHash: 'evilhash',
      };

      // Snapshot exists but findOne query scopes by tenantId,
      // so for tenant-1 the snapshot for tenant-2 won't be returned
      mockDeploymentModuleSnapshotFindOne.mockImplementation((where: any) => {
        // Only return snapshot if tenantId matches "tenant-2" (the wrong tenant)
        if (where.tenantId === 'tenant-2') {
          return {
            tenantId: 'tenant-2',
            deploymentId: 'deploy-1',
            compressedPayload: buildCompressedSnapshot(snapshotPayload),
          };
        }
        return null; // tenant-1 gets nothing
      });

      const result = await resolver.resolve({
        projectId: 'proj-1',
        tenantId: 'tenant-1',
        deploymentId: 'deploy-1',
      });

      // Should NOT have the evil module agent
      expect(result.agents['evil__agent']).toBeUndefined();
      expect(Object.keys(result.agents)).toHaveLength(2);
    });

    it('should pass tenantId to DeploymentModuleSnapshot.findOne', async () => {
      mockDeploymentModuleSnapshotFindOne.mockReturnValue(null);

      await resolver.resolve({
        projectId: 'proj-1',
        tenantId: 'tenant-1',
        deploymentId: 'deploy-1',
      });

      // Verify the snapshot query includes tenantId
      expect(mockDeploymentModuleSnapshotFindOne).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: 'tenant-1',
          deploymentId: 'deploy-1',
        }),
      );
    });
  });

  // ===========================================================================
  // Multiple module dependencies resolved
  // ===========================================================================

  describe('multiple module dependencies resolved', () => {
    it('should merge agents from multiple modules', async () => {
      const paymentsAgentIR = createMockAgentIR('payments__checkout');
      const analyticsAgentIR = createMockAgentIR('analytics__reporter');

      const snapshotPayload: DeploymentModuleSnapshotPayload = {
        dependencies: [
          {
            alias: 'payments',
            moduleProjectId: 'mod-proj-1',
            moduleReleaseId: 'rel-1',
            version: '1.0.0',
          },
          {
            alias: 'analytics',
            moduleProjectId: 'mod-proj-2',
            moduleReleaseId: 'rel-2',
            version: '2.0.0',
          },
        ],
        mountedAgents: {
          payments__checkout: {
            sourceAgentName: 'checkout',
            alias: 'payments',
            moduleProjectId: 'mod-proj-1',
            moduleReleaseId: 'rel-1',
            ir: paymentsAgentIR,
          },
          analytics__reporter: {
            sourceAgentName: 'reporter',
            alias: 'analytics',
            moduleProjectId: 'mod-proj-2',
            moduleReleaseId: 'rel-2',
            ir: analyticsAgentIR,
          },
        },
        mountedTools: {
          payments__process: {
            sourceToolName: 'process',
            alias: 'payments',
            moduleProjectId: 'mod-proj-1',
            moduleReleaseId: 'rel-1',
            definition: { name: 'payments__process', tool_type: 'http' } as any,
          },
        },
        snapshotHash: 'multihash789',
      };

      mockDeploymentModuleSnapshotFindOne.mockReturnValue({
        tenantId: 'tenant-1',
        deploymentId: 'deploy-1',
        compressedPayload: buildCompressedSnapshot(snapshotPayload),
      });

      const result = await resolver.resolve({
        projectId: 'proj-1',
        tenantId: 'tenant-1',
        deploymentId: 'deploy-1',
      });

      // 2 original + 2 module agents = 4
      expect(Object.keys(result.agents)).toHaveLength(4);
      expect(result.agents['payments__checkout']).toBeDefined();
      expect(result.agents['analytics__reporter']).toBeDefined();

      // Verify provenance on each module agent
      expect((result.agents['payments__checkout'] as any)._moduleProvenance.alias).toBe('payments');
      expect((result.agents['analytics__reporter'] as any)._moduleProvenance.alias).toBe(
        'analytics',
      );

      // Tools from modules
      expect(result.resolvedTools).toBeDefined();
      expect(result.resolvedTools!['payments__process']).toBeDefined();
    });
  });
});
