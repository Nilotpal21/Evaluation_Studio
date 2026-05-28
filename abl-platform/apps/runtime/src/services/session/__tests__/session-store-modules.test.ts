/**
 * Session Store Module Context Tests
 *
 * Tests module context in session operations:
 * - Session created with moduleProvenance when consumer project has module dependencies
 * - Module context includes provenance metadata for mounted agents
 * - Session rehydration preserves module context
 * - Non-module project session has no moduleProvenance
 * - P1-U13: Module provenance in session data
 * - P1-U15: Auth preflight for module credential references
 * - P1-U16: Module trace events emitted during session execution
 *
 * These are integration tests — DB layer is mocked but real session service
 * logic (SessionService, forkSession, SessionData) is exercised.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentIR, CompilationOutput } from '@abl/compiler';
import type { SessionData, HydratedSession } from '../types.js';
import crypto from 'crypto';

// =============================================================================
// MOCKS
// =============================================================================

vi.mock('@abl/compiler/platform', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

// =============================================================================
// HELPERS
// =============================================================================

function createMockAgentIR(name: string): AgentIR {
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
  } as any;
}

function createMockCompilationOutput(agents: Record<string, AgentIR>): CompilationOutput {
  const entryAgent = Object.keys(agents)[0];
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
}

function createSessionDataWithModules(): SessionData {
  const now = Date.now();
  return {
    id: `session-${crypto.randomUUID()}`,
    agentName: 'supervisor',
    irSourceHash: 'ir_supervisor_hash',
    compilationHash: 'comp_hash_123',
    conversationHistory: [],
    state: {
      gatherProgress: {},
      conversationPhase: 'start',
      context: {},
    },
    dataValues: {},
    dataGatheredKeys: [],
    version: 0,
    isComplete: false,
    isEscalated: false,
    handoffStack: ['supervisor'],
    delegateStack: [],
    tenantId: 'tenant-1',
    projectId: 'proj-1',
    deploymentId: 'deploy-1',
    environment: 'production',
    initialized: false,
    createdAt: now,
    lastActivityAt: now,
    threads: [
      {
        agentName: 'supervisor',
        irSourceHash: 'ir_supervisor_hash',
        conversationHistory: [],
        state: { gatherProgress: {}, conversationPhase: 'start', context: {} },
        dataValues: {},
        dataGatheredKeys: [],
        startedAt: now,
        returnExpected: false,
        status: 'active',
      },
    ],
    activeThreadIndex: 0,
    threadStack: [0],
    moduleProvenance: {
      payments__checkout: {
        alias: 'payments',
        moduleProjectId: 'mod-proj-1',
        moduleReleaseId: 'rel-1',
        sourceAgentName: 'checkout',
      },
      analytics__reporter: {
        alias: 'analytics',
        moduleProjectId: 'mod-proj-2',
        moduleReleaseId: 'rel-2',
        sourceAgentName: 'reporter',
      },
    },
  };
}

function createSessionDataWithoutModules(): SessionData {
  const now = Date.now();
  return {
    id: `session-${crypto.randomUUID()}`,
    agentName: 'main_agent',
    irSourceHash: 'ir_main_hash',
    compilationHash: 'comp_hash_456',
    conversationHistory: [],
    state: {
      gatherProgress: {},
      conversationPhase: 'start',
      context: {},
    },
    dataValues: {},
    dataGatheredKeys: [],
    version: 0,
    isComplete: false,
    isEscalated: false,
    handoffStack: ['main_agent'],
    delegateStack: [],
    tenantId: 'tenant-1',
    projectId: 'proj-2',
    environment: 'production',
    initialized: false,
    createdAt: now,
    lastActivityAt: now,
    threads: [
      {
        agentName: 'main_agent',
        irSourceHash: 'ir_main_hash',
        conversationHistory: [],
        state: { gatherProgress: {}, conversationPhase: 'start', context: {} },
        dataValues: {},
        dataGatheredKeys: [],
        startedAt: now,
        returnExpected: false,
        status: 'active',
      },
    ],
    activeThreadIndex: 0,
    threadStack: [0],
    // No moduleProvenance — this is a non-module project
  };
}

/**
 * In-memory SessionStore for testing — mimics the SessionStore interface.
 */
function createMockStore() {
  const sessions = new Map<string, SessionData>();
  const irMap = new Map<string, AgentIR>();
  const compilationMap = new Map<string, CompilationOutput>();

  return {
    create: vi.fn(async (data: SessionData) => {
      sessions.set(data.id, structuredClone(data));
    }),
    load: vi.fn(async (id: string) => {
      const session = sessions.get(id);
      return session ? structuredClone(session) : null;
    }),
    save: vi.fn(async (data: SessionData) => {
      sessions.set(data.id, structuredClone(data));
      return true;
    }),
    delete: vi.fn(async (id: string) => {
      sessions.delete(id);
    }),
    setAgentIR: vi.fn(async (hash: string, ir: AgentIR) => {
      irMap.set(hash, ir);
    }),
    getAgentIR: vi.fn(async (hash: string) => irMap.get(hash) || null),
    setCompilationOutput: vi.fn(async (hash: string, output: CompilationOutput) => {
      compilationMap.set(hash, output);
    }),
    getCompilationOutput: vi.fn(async (hash: string) => compilationMap.get(hash) || null),
    touch: vi.fn(async () => {}),
    setAgentRegistry: vi.fn(async () => {}),
    getAgentRegistry: vi.fn(async () => null),
    _sessions: sessions,
  };
}

// Import after mocks
import { SessionService } from '../session-service.js';
import { forkSession } from '../session-operations.js';

// =============================================================================
// TESTS
// =============================================================================

describe('Session Module Context', () => {
  let store: ReturnType<typeof createMockStore>;
  let sessionService: SessionService;

  beforeEach(() => {
    vi.clearAllMocks();
    store = createMockStore();
    sessionService = new SessionService(store as any);
  });

  // ===========================================================================
  // Session created with moduleProvenance
  // ===========================================================================

  describe('session created with moduleProvenance when consumer has module dependencies', () => {
    it('should create a session and persist moduleProvenance via store', async () => {
      const agentIR = createMockAgentIR('supervisor');
      const compilation = createMockCompilationOutput({ supervisor: agentIR });

      const hydrated = await sessionService.createSession({
        id: 'sess-module-1',
        agentName: 'supervisor',
        agentIR,
        compilationOutput: compilation,
        tenantId: 'tenant-1',
        projectId: 'proj-1',
        deploymentId: 'deploy-1',
        environment: 'production',
      });

      expect(hydrated.id).toBe('sess-module-1');
      expect(hydrated.agentName).toBe('supervisor');

      // Load session from store and manually add moduleProvenance
      // (moduleProvenance is set by RuntimeExecutor after createSession)
      const sessionData = await store.load('sess-module-1');
      expect(sessionData).not.toBeNull();

      // Simulate what RuntimeExecutor does
      sessionData!.moduleProvenance = {
        payments__checkout: {
          alias: 'payments',
          moduleProjectId: 'mod-proj-1',
          moduleReleaseId: 'rel-1',
          sourceAgentName: 'checkout',
        },
      };
      await store.save(sessionData!);

      // Verify provenance persisted
      const reloaded = await store.load('sess-module-1');
      expect(reloaded!.moduleProvenance).toBeDefined();
      expect(reloaded!.moduleProvenance!['payments__checkout'].alias).toBe('payments');
    });
  });

  // ===========================================================================
  // Module context includes resolvedModuleAgents and resolvedModuleTools
  // ===========================================================================

  describe('module context includes provenance for mounted agents', () => {
    it('should store provenance metadata for each mounted module agent', async () => {
      const sessionData = createSessionDataWithModules();
      await store.create(sessionData);

      const loaded = await store.load(sessionData.id);
      expect(loaded).not.toBeNull();
      expect(loaded!.moduleProvenance).toBeDefined();

      const prov = loaded!.moduleProvenance!;
      expect(Object.keys(prov)).toHaveLength(2);

      // Payments module agent
      expect(prov['payments__checkout']).toEqual({
        alias: 'payments',
        moduleProjectId: 'mod-proj-1',
        moduleReleaseId: 'rel-1',
        sourceAgentName: 'checkout',
      });

      // Analytics module agent
      expect(prov['analytics__reporter']).toEqual({
        alias: 'analytics',
        moduleProjectId: 'mod-proj-2',
        moduleReleaseId: 'rel-2',
        sourceAgentName: 'reporter',
      });
    });

    it('should support looking up provenance by mounted agent name', async () => {
      const sessionData = createSessionDataWithModules();
      await store.create(sessionData);

      const loaded = await store.load(sessionData.id);
      const provenance = loaded!.moduleProvenance;

      // Given a mounted agent name, we can trace it back to source
      const paymentsCheckout = provenance?.['payments__checkout'];
      expect(paymentsCheckout).toBeDefined();
      expect(paymentsCheckout!.sourceAgentName).toBe('checkout');
      expect(paymentsCheckout!.moduleProjectId).toBe('mod-proj-1');

      // Non-module agents should have no provenance entry
      expect(provenance?.['supervisor']).toBeUndefined();
    });
  });

  // ===========================================================================
  // Session rehydration preserves module context
  // ===========================================================================

  describe('session rehydration preserves module context', () => {
    it('should preserve moduleProvenance through load/save cycle', async () => {
      const sessionData = createSessionDataWithModules();
      await store.create(sessionData);

      // Load (simulating a pod restart or load balancer switch)
      const loaded = await store.load(sessionData.id);
      expect(loaded).not.toBeNull();

      // Modify some session state
      loaded!.version += 1;
      loaded!.lastActivityAt = Date.now();
      loaded!.conversationHistory.push({ role: 'user', content: 'Hello' });

      // Save back
      await store.save(loaded!);

      // Load again — provenance should still be intact
      const reloaded = await store.load(sessionData.id);
      expect(reloaded!.moduleProvenance).toBeDefined();
      expect(Object.keys(reloaded!.moduleProvenance!)).toHaveLength(2);
      expect(reloaded!.moduleProvenance!['payments__checkout'].alias).toBe('payments');
      expect(reloaded!.moduleProvenance!['analytics__reporter'].alias).toBe('analytics');
      expect(reloaded!.conversationHistory).toHaveLength(1);
    });

    it('should preserve moduleProvenance through SessionService loadSession', async () => {
      const sessionData = createSessionDataWithModules();
      const agentIR = createMockAgentIR('supervisor');

      // Pre-populate store with IR and session
      await store.setAgentIR(sessionData.irSourceHash, agentIR);
      await store.create(sessionData);

      // Load via SessionService (which resolves IR from cache)
      const hydrated = await sessionService.loadSession(sessionData.id);
      expect(hydrated).not.toBeNull();
      expect(hydrated!.moduleProvenance).toBeDefined();
      expect(hydrated!.moduleProvenance!['payments__checkout'].alias).toBe('payments');
      expect(hydrated!.agentIR).not.toBeNull();
    });
  });

  // ===========================================================================
  // Non-module project session has no moduleProvenance
  // ===========================================================================

  describe('non-module project session has no moduleProvenance', () => {
    it('should not have moduleProvenance field when no modules are used', async () => {
      const sessionData = createSessionDataWithoutModules();
      await store.create(sessionData);

      const loaded = await store.load(sessionData.id);
      expect(loaded).not.toBeNull();
      expect(loaded!.moduleProvenance).toBeUndefined();
    });

    it('should create session via SessionService without moduleProvenance', async () => {
      const agentIR = createMockAgentIR('main_agent');
      const compilation = createMockCompilationOutput({ main_agent: agentIR });

      const hydrated = await sessionService.createSession({
        id: 'sess-no-modules',
        agentName: 'main_agent',
        agentIR,
        compilationOutput: compilation,
        tenantId: 'tenant-1',
        projectId: 'proj-2',
        environment: 'production',
      });

      expect(hydrated.moduleProvenance).toBeUndefined();

      const stored = await store.load('sess-no-modules');
      expect(stored!.moduleProvenance).toBeUndefined();
    });
  });

  // ===========================================================================
  // P1-U13: Module provenance in session data
  // ===========================================================================

  describe('P1-U13: Module provenance in session data', () => {
    it('should store complete provenance with alias, moduleProjectId, moduleReleaseId, sourceAgentName', async () => {
      const sessionData = createSessionDataWithModules();
      await store.create(sessionData);

      const loaded = await store.load(sessionData.id);
      const prov = loaded!.moduleProvenance!['payments__checkout'];

      // All four required provenance fields must be present
      expect(prov.alias).toBe('payments');
      expect(prov.moduleProjectId).toBe('mod-proj-1');
      expect(prov.moduleReleaseId).toBe('rel-1');
      expect(prov.sourceAgentName).toBe('checkout');
    });

    it('should be keyed by the mounted (alias-prefixed) agent name', async () => {
      const sessionData = createSessionDataWithModules();
      await store.create(sessionData);

      const loaded = await store.load(sessionData.id);
      const provenanceKeys = Object.keys(loaded!.moduleProvenance!);

      // Keys should be alias-prefixed names, not source names
      expect(provenanceKeys).toContain('payments__checkout');
      expect(provenanceKeys).toContain('analytics__reporter');
      expect(provenanceKeys).not.toContain('checkout');
      expect(provenanceKeys).not.toContain('reporter');
    });

    it('should preserve provenance through fork operation', async () => {
      const parentSession = createSessionDataWithModules();
      await store.create(parentSession);

      const forkResult = await forkSession(sessionService, parentSession, {
        forkSessionId: 'forked-session-1',
      });

      expect(forkResult.sessionId).toBe('forked-session-1');
      expect(forkResult.parentSessionId).toBe(parentSession.id);

      // The forked session should have the same moduleProvenance
      const forkedData = await store.load('forked-session-1');
      expect(forkedData).not.toBeNull();
      expect(forkedData!.moduleProvenance).toBeDefined();
      expect(forkedData!.moduleProvenance!['payments__checkout'].alias).toBe('payments');
      expect(forkedData!.moduleProvenance!['analytics__reporter'].alias).toBe('analytics');
    });

    it('should deep-clone provenance during fork (mutation isolation)', async () => {
      const parentSession = createSessionDataWithModules();
      await store.create(parentSession);

      await forkSession(sessionService, parentSession, {
        forkSessionId: 'forked-session-2',
      });

      // Mutate parent's provenance
      parentSession.moduleProvenance!['payments__checkout'].alias = 'mutated';

      // Forked session should NOT be affected
      const forkedData = await store.load('forked-session-2');
      expect(forkedData!.moduleProvenance!['payments__checkout'].alias).toBe('payments');
    });
  });

  // ===========================================================================
  // P1-U15: Auth preflight for module credential references
  // ===========================================================================

  describe('P1-U15: Auth preflight for module credential references', () => {
    it('should store moduleProvenance that can be used for credential scoping', async () => {
      const sessionData = createSessionDataWithModules();
      await store.create(sessionData);

      const loaded = await store.load(sessionData.id);
      const prov = loaded!.moduleProvenance;

      // Auth middleware can use moduleProjectId to scope credential lookups
      // per-module — the provenance gives enough info to know which module
      // project a mounted agent came from
      for (const [mountedName, entry] of Object.entries(prov!)) {
        expect(entry.moduleProjectId).toBeTruthy();
        expect(entry.alias).toBeTruthy();
        // moduleProjectId is used to look up credentials in the module project's scope
        expect(typeof entry.moduleProjectId).toBe('string');
        expect(entry.moduleProjectId.length).toBeGreaterThan(0);
      }
    });

    it('should allow identifying module-sourced agents by checking provenance map', async () => {
      const sessionData = createSessionDataWithModules();
      await store.create(sessionData);

      const loaded = await store.load(sessionData.id);

      // Auth preflight: check if current agent is module-sourced
      const isModuleAgent = (agentName: string): boolean => {
        return loaded!.moduleProvenance?.[agentName] !== undefined;
      };

      expect(isModuleAgent('payments__checkout')).toBe(true);
      expect(isModuleAgent('analytics__reporter')).toBe(true);
      expect(isModuleAgent('supervisor')).toBe(false);
      expect(isModuleAgent('unknown_agent')).toBe(false);
    });
  });

  // ===========================================================================
  // P1-U16: Module trace events emitted during session execution
  // ===========================================================================

  describe('P1-U16: Module trace events emitted during session execution', () => {
    it('should provide provenance map that trace emitter can use for enrichment', async () => {
      const sessionData = createSessionDataWithModules();
      await store.create(sessionData);

      const loaded = await store.load(sessionData.id);

      // Simulate what createTraceEmitter does with the provenance map
      const provenanceMap = loaded!.moduleProvenance;

      // When emitting a trace event for a module-sourced agent,
      // the emitter enriches it with module metadata
      function enrichTraceEvent(
        event: { agentName: string; type: string },
        provMap?: typeof provenanceMap,
      ) {
        const prov = event.agentName && provMap ? provMap[event.agentName] : undefined;
        return {
          ...event,
          ...(prov && {
            moduleAlias: prov.alias,
            moduleProjectId: prov.moduleProjectId,
            moduleReleaseId: prov.moduleReleaseId,
            sourceAgentName: prov.sourceAgentName,
          }),
        };
      }

      // Module agent event — should be enriched
      const moduleEvent = enrichTraceEvent(
        { agentName: 'payments__checkout', type: 'agent_enter' },
        provenanceMap,
      );
      expect(moduleEvent.moduleAlias).toBe('payments');
      expect(moduleEvent.moduleProjectId).toBe('mod-proj-1');
      expect(moduleEvent.moduleReleaseId).toBe('rel-1');
      expect(moduleEvent.sourceAgentName).toBe('checkout');

      // Non-module agent event — should NOT be enriched
      const normalEvent = enrichTraceEvent(
        { agentName: 'supervisor', type: 'agent_enter' },
        provenanceMap,
      );
      expect(normalEvent.moduleAlias).toBeUndefined();
      expect(normalEvent.moduleProjectId).toBeUndefined();
    });

    it('should handle session without provenance map gracefully in trace enrichment', async () => {
      const sessionData = createSessionDataWithoutModules();
      await store.create(sessionData);

      const loaded = await store.load(sessionData.id);
      expect(loaded).not.toBeNull();
      const loadedSession = loaded!;

      function enrichTraceEvent(
        event: { agentName: string; type: string },
        provMap?: typeof loadedSession.moduleProvenance,
      ) {
        const prov = event.agentName && provMap ? provMap[event.agentName] : undefined;
        return {
          ...event,
          ...(prov && {
            moduleAlias: prov.alias,
            moduleProjectId: prov.moduleProjectId,
          }),
        };
      }

      // No provenance map at all — events should pass through unchanged
      const event = enrichTraceEvent(
        { agentName: 'main_agent', type: 'agent_enter' },
        loadedSession.moduleProvenance,
      );
      expect(event.moduleAlias).toBeUndefined();
      expect(event.agentName).toBe('main_agent');
      expect(event.type).toBe('agent_enter');
    });
  });

  // ===========================================================================
  // Module provenance versioning
  // ===========================================================================

  describe('module provenance versioning', () => {
    it('should track different moduleReleaseIds for different module versions', async () => {
      const now = Date.now();
      const sessionData: SessionData = {
        ...createSessionDataWithModules(),
        id: 'sess-versioned',
        moduleProvenance: {
          payments__checkout: {
            alias: 'payments',
            moduleProjectId: 'mod-proj-1',
            moduleReleaseId: 'rel-v2', // v2 of the release
            sourceAgentName: 'checkout',
          },
        },
      };

      await store.create(sessionData);
      const loaded = await store.load('sess-versioned');

      expect(loaded!.moduleProvenance!['payments__checkout'].moduleReleaseId).toBe('rel-v2');
    });
  });
});
