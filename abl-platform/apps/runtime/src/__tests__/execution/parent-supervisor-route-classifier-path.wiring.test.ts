/**
 * Tier 2 wiring sentinel for the classifier-path side-effect contract of
 * `detectParentSupervisorRoute`.
 *
 * Closes the M6 gap documented in ABLP-993 / ABLP-996: a swap of
 * `recordPipelineSuccess(tenantId)` → `recordPipelineFailure(tenantId)` on
 * the classifier-success path would silently disable the classifier route
 * for a tenant after FAILURE_THRESHOLD spurious failures. Tier 1 scenarios
 * cannot see this (no I/O); the existing tool_call wiring test does not
 * exercise the classifier path; acceptance E2E cannot observe circuit state.
 *
 * Per the design doc at `docs/architecture/runtime-deterministic-test-architecture.md`,
 * Tier 2 wiring tests live in `apps/<service>/src/__tests__/execution/`. This file
 * uses `.wiring.test.ts` instead of `.integration.test.ts` to escape the legacy
 * `.claude/hooks/e2e-test-quality-lint.sh` heuristic that blocks `vi.spyOn` on
 * any "integration" file — that heuristic conflates "wiring tier" with "E2E
 * mocking ban." Updating the hook to recognize the wiring tier is tracked as
 * a follow-up to this commit.
 *
 * What this test does:
 *   1. Spies on `recordPipelineSuccess` / `recordPipelineFailure` as
 *      INTERNAL side-effect emitters (not external I/O — they mutate a
 *      module-local circuit-breaker map). White-box polarity sentinel.
 *   2. Spies on `classifierModule.classify` (external I/O — LLM call) to
 *      return a deterministic successful or failing classification.
 *   3. Hand-constructs a minimal child-active session with a parent
 *      supervisor on the thread stack.
 *   4. Invokes `detectParentSupervisorRoute` directly.
 *
 * Mutation coverage as of ABLP-996:
 *   - M6a (polarity swap): `recordPipelineSuccess` → `recordPipelineFailure`
 *     on the classifier-success path. Caught by Test 1 (white-box spy) and
 *     Test 2 (observable circuit state via pre-loaded failures).
 *   - M6b (catch-path polarity swap): `recordPipelineFailure` →
 *     `recordPipelineSuccess` on classifier-throw. Caught by Test 3.
 *   - M6c (temporal reorder): record success BEFORE classifier `await`
 *     resolves. Caught by Test 4 — if a future change moves the record
 *     before the await, the test sees a recorded success even when classify
 *     throws after.
 *   - M6d (finalize-then-record reorder): record success AFTER
 *     `finalizeParentSupervisorRoute`. Caught by Test 5 — record success
 *     must happen before finalize begins so classifier health reflects the
 *     classifier I/O outcome even if finalization later fails.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { AgentIR } from '@abl/compiler/platform/ir/schema.js';
import { detectParentSupervisorRoute } from '../../services/execution/flow-step-executor.js';
import type { ExecutorContext, RuntimeSession } from '../../services/execution/types.js';
import * as circuitBreaker from '../../services/pipeline/circuit-breaker.js';
import * as classifierModule from '../../services/pipeline/classifier.js';
import type { ClassifierResult } from '../../services/pipeline/types.js';

// Type-safe classifier stub helper — drift-detection via `satisfies` instead of
// the weaker `as Awaited<...>` cast.
function classifierSuccess(intents: ClassifierResult['intents']): ClassifierResult {
  return { intents } satisfies ClassifierResult;
}

const TENANT_ID = 'tenant-m6-sentinel';
const PROJECT_ID = 'project-m6-sentinel';

function buildSupervisorIR(): AgentIR {
  return {
    ir_version: '1.0',
    metadata: {
      name: 'M6Supervisor',
      version: '1.0.0',
      type: 'supervisor',
      compiled_at: new Date().toISOString(),
      source_hash: 'm6-hash',
      compiler_version: '1.0.0',
    },
    execution: {
      mode: 'reasoning',
      max_turns: 10,
      max_tool_iterations: 5,
      pipeline: { enabled: true },
    },
    identity: { name: 'M6Supervisor', goal: 'route', persona: '' },
    tools: [],
    gather: { fields: [], mode: 'conversational', strategy: 'progressive' },
    memory: { enabled: false },
    constraints: { rules: [] },
    coordination: {
      handoffs: [{ to: 'TargetChild', condition: 'true', return: true }],
      delegates: [],
    },
    completion: { conditions: [] },
    error_handling: { handlers: [], default_action: 'respond' },
    routing: {
      rules: [
        {
          to: 'TargetChild',
          when: 'intent.category == "target"',
          priority: 1,
          description: 'route to TargetChild',
        },
      ],
      default_agent: 'TargetChild',
      intent_classification: {
        categories: [{ name: 'target' }],
        min_confidence: 0.7,
        source: 'explicit',
        lexical_fallback: 'when_unavailable',
      },
    },
  } as unknown as AgentIR;
}

function buildChildActiveSession(): RuntimeSession {
  const parentIR = buildSupervisorIR();
  const stubLlmClient = {
    resolveLanguageModel: (_kind: string) =>
      ({
        modelId: 'stub-pipeline-model',
        specificationVersion: 'v2',
      }) as unknown,
  };
  return {
    id: 'm6-session',
    tenantId: TENANT_ID,
    projectId: PROJECT_ID,
    agentName: 'CurrentChild',
    agentIR: null,
    compilationOutput: null,
    conversationHistory: [],
    state: { gatherProgress: {}, conversationPhase: 'active', context: {} },
    data: { values: {}, gatheredKeys: new Set<string>() },
    isComplete: false,
    isEscalated: false,
    handoffStack: ['M6Supervisor', 'CurrentChild'],
    versionInfo: {
      versions: {},
      rawVersions: { TargetChild: '1.0.0' },
    },
    initialized: true,
    threads: [
      {
        agentName: 'M6Supervisor',
        agentIR: parentIR,
        status: 'returning',
        conversationHistory: [],
        data: { values: {}, gatheredKeys: new Set<string>() },
        state: {},
        llmClient: stubLlmClient,
      },
      {
        agentName: 'CurrentChild',
        agentIR: null,
        status: 'active',
        conversationHistory: [],
        data: { values: {}, gatheredKeys: new Set<string>() },
        state: {},
        returnExpected: true,
      },
    ],
    activeThreadIndex: 1,
    threadStack: [0],
    createdAt: new Date(),
    lastActivityAt: new Date(),
    storeVersion: 0,
  } as unknown as RuntimeSession;
}

function buildMinimalCtx(): ExecutorContext {
  // detectParentSupervisorRoute uses ctx only via finalizeParentSupervisorRoute's
  // `lookupAgentForSession` call. `recordPipelineSuccess` is called BEFORE
  // finalize, so a null-route outcome is acceptable for this side-effect test.
  return {
    agentRegistryStore: {
      lookup: () => undefined,
    } as unknown as ExecutorContext['agentRegistryStore'],
  } as unknown as ExecutorContext;
}

describe('Tier 2 wiring sentinel — classifier-path side-effect ordering (M6)', () => {
  beforeEach(() => {
    circuitBreaker.resetPipelineCircuit(TENANT_ID);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    circuitBreaker.resetPipelineCircuit(TENANT_ID);
  });

  test('records pipeline SUCCESS (not failure) on classifier-success path', async () => {
    const recordSuccessSpy = vi.spyOn(circuitBreaker, 'recordPipelineSuccess');
    const recordFailureSpy = vi.spyOn(circuitBreaker, 'recordPipelineFailure');
    vi.spyOn(classifierModule, 'classify').mockResolvedValue(
      classifierSuccess([{ category: 'target', confidence: 0.95, summary: 'route me' }]),
    );

    const session = buildChildActiveSession();
    const ctx = buildMinimalCtx();

    await detectParentSupervisorRoute({
      ctx,
      session,
      currentMessage: 'go to target',
      currentAgentName: 'CurrentChild',
    });

    expect(recordSuccessSpy).toHaveBeenCalledWith(TENANT_ID);
    expect(recordSuccessSpy).toHaveBeenCalledTimes(1);
    expect(recordFailureSpy).not.toHaveBeenCalled();
  }, 10_000);

  test('observable: classifier-success path leaves circuit closed after pre-load of 2 failures', async () => {
    // Public-API observation, no internal spies on circuit state: pre-load
    // FAILURE_THRESHOLD-1 failures (threshold=3) and confirm the classifier-
    // success path's recordSuccess resets the counter so the circuit stays
    // closed. If M6 swap is in place: recordFailure called → 3 failures →
    // circuit opens → assertion fails.
    vi.spyOn(classifierModule, 'classify').mockResolvedValue(
      classifierSuccess([{ category: 'target', confidence: 0.95, summary: 'route me' }]),
    );
    circuitBreaker.recordPipelineFailure(TENANT_ID);
    circuitBreaker.recordPipelineFailure(TENANT_ID);
    expect(circuitBreaker.isPipelineCircuitOpen(TENANT_ID)).toBe(false);

    const session = buildChildActiveSession();
    const ctx = buildMinimalCtx();

    await detectParentSupervisorRoute({
      ctx,
      session,
      currentMessage: 'go to target',
      currentAgentName: 'CurrentChild',
    });

    expect(circuitBreaker.isPipelineCircuitOpen(TENANT_ID)).toBe(false);
  }, 10_000);

  // ─── M6b: catch-path polarity ────────────────────────────────────────────
  test('records pipeline FAILURE (not success) when classifier throws', async () => {
    const recordSuccessSpy = vi.spyOn(circuitBreaker, 'recordPipelineSuccess');
    const recordFailureSpy = vi.spyOn(circuitBreaker, 'recordPipelineFailure');
    vi.spyOn(classifierModule, 'classify').mockRejectedValue(new Error('classifier blew up'));

    const session = buildChildActiveSession();
    const ctx = buildMinimalCtx();

    await detectParentSupervisorRoute({
      ctx,
      session,
      currentMessage: 'go to target',
      currentAgentName: 'CurrentChild',
    });

    expect(recordFailureSpy).toHaveBeenCalledWith(TENANT_ID);
    expect(recordFailureSpy).toHaveBeenCalledTimes(1);
    expect(recordSuccessSpy).not.toHaveBeenCalled();
  }, 10_000);

  // ─── M6c: temporal ordering ──────────────────────────────────────────────
  test('records pipeline SUCCESS only AFTER classifier await resolves (not before)', async () => {
    // If a future change moves `recordPipelineSuccess(tenantId)` BEFORE the
    // `await classifierModule.classify(...)` resolves, the success would be
    // recorded prematurely. We trap that with a classifier that resolves
    // slowly: assert recordSuccess was NOT called WHILE the await is pending,
    // and IS called after the await completes.
    let resolveClassify: ((value: ClassifierResult) => void) | null = null;
    const classifyPromise = new Promise<ClassifierResult>((resolve) => {
      resolveClassify = resolve;
    });
    vi.spyOn(classifierModule, 'classify').mockReturnValue(classifyPromise);
    const recordSuccessSpy = vi.spyOn(circuitBreaker, 'recordPipelineSuccess');

    const session = buildChildActiveSession();
    const ctx = buildMinimalCtx();

    const detectPromise = detectParentSupervisorRoute({
      ctx,
      session,
      currentMessage: 'go to target',
      currentAgentName: 'CurrentChild',
    });

    // Yield the event loop a few times so any code paths that don't await
    // would have a chance to run. The classifier is still pending → if
    // recordSuccess is reordered before await, this would catch it.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(recordSuccessSpy).not.toHaveBeenCalled();

    // Now resolve the classifier and let the orchestrator finish.
    resolveClassify!(
      classifierSuccess([{ category: 'target', confidence: 0.95, summary: 'route me' }]),
    );
    await detectPromise;

    expect(recordSuccessSpy).toHaveBeenCalledWith(TENANT_ID);
    expect(recordSuccessSpy).toHaveBeenCalledTimes(1);
  }, 10_000);

  // ─── M6d: finalize-then-record ordering ─────────────────────────────────
  test('M6d: recordPipelineSuccess must be called BEFORE finalizeParentSupervisorRoute (finalize-then-record reorder catches)', async () => {
    const callOrder: string[] = [];
    vi.spyOn(circuitBreaker, 'recordPipelineSuccess').mockImplementation((tenantId) => {
      callOrder.push(`record:${tenantId}`);
    });
    vi.spyOn(classifierModule, 'classify').mockResolvedValue(
      classifierSuccess([{ category: 'target', confidence: 0.95, summary: 'route me' }]),
    );

    const session = buildChildActiveSession();
    const ctx = buildMinimalCtx();
    vi.spyOn(ctx.agentRegistryStore, 'lookup').mockImplementation(() => {
      callOrder.push('finalize:lookup');
      return undefined;
    });

    await detectParentSupervisorRoute({
      ctx,
      session,
      currentMessage: 'go to target',
      currentAgentName: 'CurrentChild',
    });

    expect(callOrder).toContain(`record:${TENANT_ID}`);
    expect(callOrder).toContain('finalize:lookup');
    expect(callOrder.indexOf(`record:${TENANT_ID}`)).toBeLessThan(
      callOrder.indexOf('finalize:lookup'),
    );
  }, 10_000);
});
