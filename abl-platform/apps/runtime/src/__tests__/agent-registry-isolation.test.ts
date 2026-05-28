import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { AgentIR } from '@abl/compiler';
import { RuntimeExecutor, compileToResolvedAgent } from '../services/runtime-executor.js';
import { AgentRegistryStore } from '../services/execution/agent-registry.js';
import { lookupAgentForSession, hasAgentForSession } from '../services/execution/agent-lookup.js';
import { buildSessionScopedAgentRegistry } from '../services/execution/session-agent-registry.js';
import type {
  AgentRegistry,
  AgentRegistryEntry,
  ExecutorContext,
  RuntimeSession,
} from '../services/execution/types.js';
import type { ProductionExecutionScope } from '../services/session/execution-scope.js';
import type { SessionService } from '../services/session/session-service.js';
import type { HydratedSession } from '../services/session/types.js';

/**
 * Cross-project and multi-version isolation for the session-scoped agent
 * registry. Exercises `lookupAgentForSession` against a real `AgentRegistryStore`
 * populated with colliding names across (projectId, version) tuples.
 *
 * These are the invariants ABLP-366 relies on:
 *  - A session scoped to project A can never resolve an IR registered under
 *    project B, even when the agent name matches.
 *  - A session pinned to version 1.0.0 can never resolve the 2.0.0 IR, even
 *    within the same project.
 *  - The legacy flat `agentRegistry` Record remains a compatibility fallback
 *    for test harnesses whose sessions do not carry a projectId.
 */

function makeEntry(agentName: string, marker: string): AgentRegistryEntry {
  const ir = {
    metadata: { name: agentName, marker },
    execution: {},
  } as unknown as AgentIR;
  return { dsl: '', ir };
}

function makeSession(
  projectId: string | undefined,
  rawVersions: Record<string, string> | undefined,
  tenantId?: string,
): RuntimeSession {
  // Only the fields read by `lookupAgentForSession` are populated.
  return {
    projectId,
    tenantId,
    versionInfo: rawVersions
      ? {
          versions: {},
          rawVersions,
        }
      : undefined,
  } as unknown as RuntimeSession;
}

function makeRemoteHandoffSession(targetAgent: string, endpoint: string): RuntimeSession {
  return {
    agentIR: {
      coordination: {
        handoffs: [
          {
            to: targetAgent,
            when: 'true',
            context: {
              pass: [],
              summary: '',
            },
            return: true,
            remote: {
              location: 'remote',
              endpoint,
              protocol: 'a2a',
            },
          },
        ],
      },
    } as AgentIR,
  } as RuntimeSession;
}

function makeCtx(legacy: AgentRegistry, store: AgentRegistryStore): ExecutorContext {
  return {
    agentRegistry: legacy,
    agentRegistryStore: store,
  } as unknown as ExecutorContext;
}

function makeHydratedSession(overrides: Partial<HydratedSession> = {}): HydratedSession {
  return {
    id: 'rehydrated-session-1',
    agentName: 'Scoped_Agent',
    agentIR: makeEntry('Scoped_Agent', 'rehydrated').ir,
    compilationOutput: null,
    conversationHistory: [],
    state: {
      gatherProgress: {},
      conversationPhase: 'active',
      context: {},
    },
    dataValues: {
      session: {
        channel: 'digital',
      },
    },
    dataGatheredKeys: [],
    version: 1,
    isComplete: false,
    isEscalated: false,
    transferInitiated: false,
    handoffStack: ['Scoped_Agent'],
    delegateStack: [],
    initialized: true,
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    threads: [],
    activeThreadIndex: 0,
    threadStack: [],
    ...overrides,
  } as HydratedSession;
}

function buildProductionScope(
  overrides: Partial<ProductionExecutionScope> = {},
): ProductionExecutionScope {
  return {
    kind: 'production',
    tenantId: 'tenant-1',
    projectId: 'project-1',
    sessionId: 'runtime-session-1',
    sessionPrincipalId: 'principal-1',
    channelId: 'sdk',
    environment: 'prod',
    source: 'sdk',
    authType: 'sdk_session',
    traceId: 'trace-1',
    actor: { kind: 'contact', contactId: 'contact-1' },
    subject: { kind: 'contact', contactId: 'contact-1' },
    identityEvidence: {
      identityTier: 1,
      verificationMethod: 'sdk_bootstrap',
      artifacts: [{ type: 'external', valueHash: 'hash-1' }],
    },
    callerContext: {},
    ...overrides,
  };
}

describe('Agent registry session isolation (ABLP-366)', () => {
  let store: AgentRegistryStore;
  let legacy: AgentRegistry;
  let ctx: ExecutorContext;

  beforeEach(() => {
    store = new AgentRegistryStore();
    legacy = {};
    ctx = makeCtx(legacy, store);
  });

  describe('cross-project isolation', () => {
    it('resolves to the scoped IR when both projects host the same name', () => {
      const entryA = makeEntry('Supervisor', 'proj-a');
      const entryB = makeEntry('Supervisor', 'proj-b');
      store.register('proj-a', 'Supervisor', '1.0.0', entryA);
      store.register('proj-b', 'Supervisor', '1.0.0', entryB);

      const sessionA = makeSession('proj-a', { Supervisor: '1.0.0' });
      const sessionB = makeSession('proj-b', { Supervisor: '1.0.0' });

      expect(lookupAgentForSession(ctx, sessionA, 'Supervisor')?.ir).toBe(entryA.ir);
      expect(lookupAgentForSession(ctx, sessionB, 'Supervisor')?.ir).toBe(entryB.ir);
    });

    it('does not leak project A IR into a session scoped to project B', () => {
      const entryA = makeEntry('Billing_Agent', 'proj-a');
      store.register('proj-a', 'Billing_Agent', '1.0.0', entryA);

      const sessionB = makeSession('proj-b', { Billing_Agent: '1.0.0' });
      expect(lookupAgentForSession(ctx, sessionB, 'Billing_Agent')).toBeUndefined();
      expect(hasAgentForSession(ctx, sessionB, 'Billing_Agent')).toBe(false);
    });

    it('does not leak IR across tenants when project/name/version collide', () => {
      const entryTenantA = makeEntry('Supervisor', 'tenant-a');
      const entryTenantB = makeEntry('Supervisor', 'tenant-b');
      store.register(
        { tenantId: 'tenant-a', projectId: 'shared-project' },
        'Supervisor',
        '1.0.0',
        entryTenantA,
      );
      store.register(
        { tenantId: 'tenant-b', projectId: 'shared-project' },
        'Supervisor',
        '1.0.0',
        entryTenantB,
      );

      const sessionA = makeSession('shared-project', { Supervisor: '1.0.0' }, 'tenant-a');
      const sessionB = makeSession('shared-project', { Supervisor: '1.0.0' }, 'tenant-b');

      expect(lookupAgentForSession(ctx, sessionA, 'Supervisor')?.ir).toBe(entryTenantA.ir);
      expect(lookupAgentForSession(ctx, sessionB, 'Supervisor')?.ir).toBe(entryTenantB.ir);
      expect(store.lookup('shared-project', 'Supervisor', '1.0.0')).toBeUndefined();
    });
  });

  describe('multi-version isolation', () => {
    it('returns the version pinned by the session, not any newer or older IR', () => {
      const v1 = makeEntry('Supervisor', 'v1');
      const v2 = makeEntry('Supervisor', 'v2');
      store.register('proj-a', 'Supervisor', '1.0.0', v1);
      store.register('proj-a', 'Supervisor', '2.0.0', v2);

      const sessionV1 = makeSession('proj-a', { Supervisor: '1.0.0' });
      const sessionV2 = makeSession('proj-a', { Supervisor: '2.0.0' });

      expect(lookupAgentForSession(ctx, sessionV1, 'Supervisor')?.ir).toBe(v1.ir);
      expect(lookupAgentForSession(ctx, sessionV2, 'Supervisor')?.ir).toBe(v2.ir);
    });

    it('returns undefined when the session pins a version that was never registered', () => {
      store.register('proj-a', 'Supervisor', '1.0.0', makeEntry('Supervisor', 'v1'));
      const sessionV3 = makeSession('proj-a', { Supervisor: '3.0.0' });
      expect(lookupAgentForSession(ctx, sessionV3, 'Supervisor')).toBeUndefined();
    });
  });

  describe('legacy fallback', () => {
    it('prefers a session-scoped remote handoff over a colliding legacy entry', () => {
      const flat = makeEntry('Billing_Agent', 'legacy');
      legacy['Billing_Agent'] = flat;

      const session = makeRemoteHandoffSession(
        'Billing_Agent',
        'https://project-b.example.com/agents/billing',
      );

      const resolved = lookupAgentForSession(ctx, session, 'Billing_Agent');
      expect(resolved?.location).toBe('remote');
      expect(resolved?.remote?.endpoint).toBe('https://project-b.example.com/agents/billing');
      expect(resolved?.ir).toBeNull();
    });

    it('falls back to the flat registry when the session has no projectId', () => {
      const entry = makeEntry('Flat_Agent', 'legacy');
      legacy['Flat_Agent'] = entry;

      const session = makeSession(undefined, undefined);
      expect(lookupAgentForSession(ctx, session, 'Flat_Agent')?.ir).toBe(entry.ir);
    });

    it('fails closed when rawVersions has no entry for a project-scoped session', () => {
      const entry = makeEntry('Flat_Agent', 'legacy');
      legacy['Flat_Agent'] = entry;

      const session = makeSession('proj-a', { Other_Agent: '1.0.0' });
      expect(lookupAgentForSession(ctx, session, 'Flat_Agent')).toBeUndefined();
    });

    it('prefers the per-session compatibility registry over legacy when rawVersions are absent', () => {
      const scoped = makeEntry('Flat_Agent', 'session');
      legacy['Flat_Agent'] = makeEntry('Flat_Agent', 'legacy');

      const session = {
        ...makeSession('proj-a', undefined),
        _sessionAgentRegistry: {
          Flat_Agent: scoped,
        },
      } as RuntimeSession;

      expect(lookupAgentForSession(ctx, session, 'Flat_Agent')?.ir).toBe(scoped.ir);
    });

    it('can resolve remote targets preserved in the session-scoped registry', () => {
      const registry = buildSessionScopedAgentRegistry({
        version: '1.0',
        compiled_at: new Date().toISOString(),
        agents: {},
        entry_agent: 'Supervisor',
        deployment: {
          runtime_recommendations: {},
          parallel_safe: [],
          stateful: [],
          hitl_capable: [],
        },
        remote_agents: {
          Hosted_Vercel_Agent: {
            location: 'remote',
            endpoint: 'https://remote.example.com/a2a',
            protocol: 'a2a',
            timeout: '30s',
          },
        },
      });

      const session = {
        ...makeSession('proj-a', undefined),
        _sessionAgentRegistry: registry,
      } as RuntimeSession;

      const resolved = lookupAgentForSession(ctx, session, 'Hosted_Vercel_Agent');
      expect(resolved?.location).toBe('remote');
      expect(resolved?.remote?.endpoint).toBe('https://remote.example.com/a2a');
      expect(resolved?.remote?.timeout).toBe(30_000);
    });

    it('prefers the scoped store over the legacy Record when both are populated', () => {
      const scoped = makeEntry('Supervisor', 'store');
      const flat = makeEntry('Supervisor', 'legacy');
      store.register('proj-a', 'Supervisor', '1.0.0', scoped);
      legacy['Supervisor'] = flat;

      const session = makeSession('proj-a', { Supervisor: '1.0.0' });
      expect(lookupAgentForSession(ctx, session, 'Supervisor')?.ir).toBe(scoped.ir);
    });
  });

  describe('undefined / empty inputs', () => {
    it('returns undefined for an empty agent name', () => {
      const session = makeSession('proj-a', { Supervisor: '1.0.0' });
      expect(lookupAgentForSession(ctx, session, '')).toBeUndefined();
    });

    it('returns undefined when no session, no legacy, and no store entry', () => {
      expect(lookupAgentForSession(ctx, undefined, 'Missing')).toBeUndefined();
    });
  });

  describe('scope-backed bootstrap', () => {
    it('populates the scoped store when createSessionFromResolved receives only scope.projectId', () => {
      const executor = new RuntimeExecutor();
      try {
        const resolved = compileToResolvedAgent(
          [
            `AGENT: Scoped_Agent

GOAL: "Handle requests"

PERSONA: "Helpful assistant"
`,
          ],
          'Scoped_Agent',
        );
        resolved.versionInfo = {
          ...resolved.versionInfo,
          versions: { Scoped_Agent: 1 },
          rawVersions: { Scoped_Agent: '1.0.0' },
        };

        const session = executor.createSessionFromResolved(resolved, {
          scope: buildProductionScope({
            projectId: 'scope-project',
            sessionId: 'scope-session-1',
          }),
        });

        const legacyCollision = makeEntry('Scoped_Agent', 'legacy');
        const executorCtx = executor as unknown as ExecutorContext & {
          agentRegistry: AgentRegistry;
        };
        executorCtx.agentRegistry['Scoped_Agent'] = legacyCollision;

        expect(lookupAgentForSession(executorCtx, session, 'Scoped_Agent')?.ir).toBe(
          session.agentIR,
        );
        expect(
          executor.agentRegistryStore.lookup(
            { tenantId: 'tenant-1', projectId: 'scope-project' },
            'Scoped_Agent',
            '1.0.0',
          )?.ir,
        ).toBe(session.agentIR);
      } finally {
        executor.stopStaleReaper();
      }
    });

    it('materializes module-resolved tool definitions before session tool wiring', () => {
      const executor = new RuntimeExecutor();
      try {
        const resolved = compileToResolvedAgent(
          [
            `AGENT: Scoped_Agent

GOAL: "Handle requests"

PERSONA: "Helpful assistant"
`,
          ],
          'Scoped_Agent',
        );
        const stubTool = {
          name: 'payments__lookup',
          description: 'DSL stub',
          parameters: [],
          returns: { type: 'object' },
          hints: {},
          tool_type: 'http',
          on_result: { set: { last_lookup_id: 'result.id' } },
          store_result: false,
        };
        const resolvedTool = {
          name: 'payments__lookup',
          description: 'Executable module lookup',
          parameters: [{ name: 'accountId', type: 'string', required: true }],
          returns: { type: 'object' },
          hints: {},
          tool_type: 'http',
          http_binding: {
            method: 'GET',
            url: 'https://payments.example.test/accounts/{accountId}',
          },
        };

        resolved.agents.Scoped_Agent.tools = [stubTool as AgentIR['tools'][number]];
        resolved.compilationOutput.agents.Scoped_Agent.tools = [
          stubTool as AgentIR['tools'][number],
        ];
        (resolved as any).resolvedTools = {
          payments__lookup: resolvedTool,
        };

        const llmWiring = (
          executor as unknown as {
            llmWiring: {
              wireToolExecutor: ReturnType<typeof vi.fn>;
              wireLLMClient: ReturnType<typeof vi.fn>;
            };
          }
        ).llmWiring;
        llmWiring.wireToolExecutor = vi.fn();
        llmWiring.wireLLMClient = vi.fn().mockResolvedValue(undefined);

        const session = executor.createSessionFromResolved(resolved, {
          scope: buildProductionScope({
            projectId: 'scope-project',
            sessionId: 'scope-session-tools',
          }),
        });

        const materializedTool = session.agentIR?.tools.find(
          (tool) => tool.name === 'payments__lookup',
        );
        expect(materializedTool).toMatchObject({
          description: 'Executable module lookup',
          http_binding: resolvedTool.http_binding,
          on_result: stubTool.on_result,
          store_result: false,
        });
        expect((session as any).resolvedTools?.payments__lookup).toBeDefined();

        const wiredCompilationOutput = llmWiring.wireToolExecutor.mock.calls[0]?.[1] as
          | { agents: Record<string, AgentIR> }
          | undefined;
        expect(
          wiredCompilationOutput?.agents.Scoped_Agent.tools.find(
            (tool) => tool.name === 'payments__lookup',
          ),
        ).toMatchObject({
          description: 'Executable module lookup',
          http_binding: resolvedTool.http_binding,
        });
      } finally {
        executor.stopStaleReaper();
      }
    });
  });

  describe('rehydration compatibility', () => {
    it('rebuilds the per-session registry from persisted hashes when rawVersions are missing', async () => {
      const executor = new RuntimeExecutor();
      try {
        const scopedEntry = makeEntry('Scoped_Agent', 'rehydrated');
        const mockSessionService = {
          loadSession: vi.fn().mockResolvedValue(
            makeHydratedSession({
              agentIR: scopedEntry.ir,
              projectId: 'scope-project',
              tenantId: 'tenant-1',
              agentVersions: { Scoped_Agent: 1 },
            }),
          ),
          getAgentRegistry: vi.fn().mockResolvedValue({
            Scoped_Agent: 'ir-hash-1',
          }),
          getAgentRegistryScoped: vi.fn().mockResolvedValue(null),
          resolveAgentIR: vi.fn().mockResolvedValue(scopedEntry.ir),
        };

        executor.setSessionService(mockSessionService as unknown as SessionService);

        const llmWiring = (
          executor as unknown as {
            llmWiring: {
              wireToolExecutor: ReturnType<typeof vi.fn>;
              wireLLMClient: ReturnType<typeof vi.fn>;
            };
          }
        ).llmWiring;
        llmWiring.wireToolExecutor = vi.fn();
        llmWiring.wireLLMClient = vi.fn().mockResolvedValue(undefined);

        const legacyCollision = makeEntry('Scoped_Agent', 'legacy');
        const executorCtx = executor as unknown as ExecutorContext & {
          agentRegistry: AgentRegistry;
        };
        executorCtx.agentRegistry['Scoped_Agent'] = legacyCollision;

        const session = await executor.rehydrateSession('rehydrated-session-1');

        expect(session).not.toBeNull();
        expect(mockSessionService.getAgentRegistry).toHaveBeenCalledWith('rehydrated-session-1');
        expect(mockSessionService.resolveAgentIR).toHaveBeenCalledWith('ir-hash-1');
        expect(session?._sessionAgentRegistry?.Scoped_Agent?.ir).toBe(scopedEntry.ir);
        expect(lookupAgentForSession(executorCtx, session ?? undefined, 'Scoped_Agent')?.ir).toBe(
          scopedEntry.ir,
        );
      } finally {
        executor.stopStaleReaper();
      }
    });
  });
});
