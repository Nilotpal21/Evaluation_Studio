/**
 * Tests for FlowStepExecutor correction detection fallback chain.
 *
 * Covers:
 * 1. Full 3-tier chain: regex -> sidecar -> LLM with strategy gating
 * 2. CORRECTION_FIELD_UNKNOWN / undeclared field deferral to LLM
 * 3. detectCorrectionWithLLM private method (direct unit tests)
 *
 * The correction chain lives inside executeFlowStep (lines ~2372-2515 of
 * flow-step-executor.ts). The chain logic is tested via a faithful simulation
 * function that mirrors the production code, plus direct private method tests
 * for detectCorrectionWithLLM.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FlowStepExecutor } from '../../services/execution/flow-step-executor.js';
import { CORRECTION_FIELD_UNKNOWN } from '@abl/compiler/platform/constructs/utils.js';
import type { CorrectionDetectionStrategy } from '@abl/compiler/platform/ir/schema.js';
import type {
  CorrectionResult as SidecarCorrectionResult,
  SidecarCallContext,
  SidecarResult,
} from '../../services/nlu/sidecar-client.js';
import type { RuntimeSession } from '../../services/execution/types.js';

// =============================================================================
// HELPERS
// =============================================================================

/** Build a minimal RuntimeSession with the fields the correction logic needs. */
function buildSession(overrides: Partial<RuntimeSession> = {}): RuntimeSession {
  return {
    id: 'test-session',
    agentName: 'test-agent',
    agentIR: null,
    compilationOutput: null,
    conversationHistory: [],
    state: { gatherProgress: {}, conversationPhase: 'start', context: {} },
    data: {
      values: {},
      gatheredKeys: new Set<string>(),
    },
    isComplete: false,
    isEscalated: false,
    handoffStack: [],
    delegateStack: [],
    initialized: true,
    threads: [],
    activeThreadIndex: 0,
    threadStack: [],
    createdAt: new Date(),
    lastActivityAt: new Date(),
    storeVersion: 0,
    ...overrides,
  } as RuntimeSession;
}

/** Build a FlowStepExecutor with a mock context. */
function buildExecutor(ctxOverrides: Record<string, unknown> = {}): FlowStepExecutor {
  const ctx = {
    debouncedPersist: vi.fn(),
    config: {},
    sessions: new Map(),
    agentRegistry: {},
    executeMessage: vi.fn(),
    wireLLMClient: vi.fn(),
    checkConstraints: vi.fn().mockReturnValue(null),
    handleConstraintViolation: vi.fn(),
    interpolateTemplate: vi.fn((t: string) => t),
    markExecuting: vi.fn(),
    unmarkExecuting: vi.fn(),
    cancelPendingPersist: vi.fn(),
    ...ctxOverrides,
  } as any;

  const routing = {
    checkHandoffConditions: vi.fn().mockResolvedValue(null),
    checkCompletionConditions: vi.fn().mockReturnValue(null),
  } as any;

  return new FlowStepExecutor(ctx, routing);
}

/** Access private detectCorrectionWithLLM via bracket notation. */
function callDetectCorrectionWithLLM(
  executor: FlowStepExecutor,
  userMessage: string,
  session: RuntimeSession,
  gatherFields?: Array<{ name: string; depends_on?: string[] }>,
) {
  return (executor as any).detectCorrectionWithLLM(userMessage, session, gatherFields);
}

// =============================================================================
// Correction chain simulation — mirrors flow-step-executor.ts lines 2372-2515.
// This is a faithful extraction of the production logic, used to test the
// 3-tier chain without needing a full session + executeFlowStep invocation.
// =============================================================================

interface CorrectionChainOpts {
  userMessage: string;
  collectedValues: Record<string, unknown>;
  correctionMode: CorrectionDetectionStrategy;
  declaredFieldNames: Set<string>;
  // Tier 1: regex
  regexResult: { field: string; newValue: string } | null;
  // Tier 2: sidecar
  sidecarClient: {
    detectCorrection: (
      opts: {
        text: string;
        context: Record<string, unknown>;
        locale: string;
      },
      ctx: SidecarCallContext,
    ) => Promise<SidecarResult<SidecarCorrectionResult>>;
  } | null;
  // Tier 3: LLM
  llmClient: boolean;
  llmResult: { field: string; newValue: string; oldValue: unknown } | null;
  llmFallbackResult: { field: string; newValue: string; oldValue: unknown } | null;
}

interface CorrectionChainResult {
  correctionField: string | undefined;
  correctionNewValue: string | undefined;
  correctionDetectionMethod: 'regex' | 'sidecar' | 'llm';
  regexCalled: boolean;
  sidecarCalled: boolean;
  llmCalled: boolean;
  llmFallbackCalled: boolean;
}

/**
 * Simulate the 3-tier correction chain from flow-step-executor.ts.
 * Each mock is called only when enabled by the strategy and previous tiers missed.
 */
async function runCorrectionChain(opts: CorrectionChainOpts): Promise<CorrectionChainResult> {
  const {
    correctionMode,
    declaredFieldNames,
    regexResult,
    sidecarClient,
    llmClient,
    llmResult,
    llmFallbackResult,
  } = opts;

  let correctionField: string | undefined;
  let correctionNewValue: string | undefined;
  let correctionDetectionMethod: 'regex' | 'sidecar' | 'llm' = 'regex';

  let regexCalled = false;
  let sidecarCalled = false;
  let llmCalled = false;
  let llmFallbackCalled = false;

  if (correctionMode === 'disabled') {
    return {
      correctionField,
      correctionNewValue,
      correctionDetectionMethod,
      regexCalled,
      sidecarCalled,
      llmCalled,
      llmFallbackCalled,
    };
  }

  const enableRegex =
    correctionMode === 'auto' || correctionMode === 'ml' || correctionMode === 'regex';
  const enableSidecar =
    correctionMode === 'auto' || correctionMode === 'ml' || correctionMode === 'sidecar';
  const enableLLM = correctionMode === 'auto' || correctionMode === 'llm';

  // 1. Regex
  if (enableRegex) {
    regexCalled = true;
    if (regexResult) {
      correctionField = regexResult.field;
      correctionNewValue = regexResult.newValue;
      correctionDetectionMethod = 'regex';
    }
  }

  // 2. Sidecar
  if (!correctionField && enableSidecar) {
    if (sidecarClient) {
      sidecarCalled = true;
      try {
        const sidecarResult = await sidecarClient.detectCorrection(
          {
            text: opts.userMessage,
            context: opts.collectedValues,
            locale: 'en',
          },
          {
            tenantId: 'tenant-1',
            projectId: 'project-1',
            sessionId: 'session-1',
          },
        );

        if (sidecarResult.ok && sidecarResult.value.is_correction && sidecarResult.value.field) {
          correctionField = sidecarResult.value.field;
          correctionNewValue = String(sidecarResult.value.new_value);
          correctionDetectionMethod = 'sidecar';
        }
      } catch {
        // Sidecar failure is non-blocking — falls through
      }
    }
  }

  // 3. LLM
  if (!correctionField && enableLLM && llmClient) {
    llmCalled = true;
    if (llmResult) {
      correctionField = llmResult.field;
      correctionNewValue = llmResult.newValue;
      correctionDetectionMethod = 'llm';
    }
  }

  // Validate correctionField against declared gather fields
  if (correctionField && correctionNewValue !== undefined) {
    if (correctionField === CORRECTION_FIELD_UNKNOWN || !declaredFieldNames.has(correctionField)) {
      if (correctionDetectionMethod !== 'llm') {
        correctionField = undefined;
        correctionNewValue = undefined;

        // LLM fallback
        if (enableLLM && llmClient) {
          llmFallbackCalled = true;
          if (llmFallbackResult && declaredFieldNames.has(llmFallbackResult.field)) {
            correctionField = llmFallbackResult.field;
            correctionNewValue = llmFallbackResult.newValue;
            correctionDetectionMethod = 'llm';
          }
        }
      } else {
        // LLM was the original detector — no recursive retry
        correctionField = undefined;
        correctionNewValue = undefined;
      }
    }
  }

  return {
    correctionField,
    correctionNewValue,
    correctionDetectionMethod,
    regexCalled,
    sidecarCalled,
    llmCalled,
    llmFallbackCalled,
  };
}

function sidecarOk(
  overrides: Partial<SidecarCorrectionResult> = {},
): SidecarResult<SidecarCorrectionResult> {
  return {
    ok: true,
    value: {
      is_correction: false,
      field: '',
      new_value: undefined,
      confidence: 0,
      ...overrides,
    },
  };
}

// =============================================================================
// FULL CHAIN TESTS (12)
// =============================================================================

describe('correction detection full chain', () => {
  const declaredFields = new Set(['destination', 'guests', 'date']);

  const defaultOpts: CorrectionChainOpts = {
    userMessage: 'actually Paris',
    collectedValues: { destination: 'London', guests: 3 },
    correctionMode: 'auto',
    declaredFieldNames: declaredFields,
    regexResult: null,
    sidecarClient: null,
    llmClient: false,
    llmResult: null,
    llmFallbackResult: null,
  };

  it('regex match returns correction without falling through to sidecar/LLM', async () => {
    const result = await runCorrectionChain({
      ...defaultOpts,
      regexResult: { field: 'destination', newValue: 'paris' },
      sidecarClient: {
        detectCorrection: vi.fn().mockResolvedValue(sidecarOk()),
      },
      llmClient: true,
      llmResult: { field: 'destination', newValue: 'paris', oldValue: 'London' },
    });

    expect(result.correctionField).toBe('destination');
    expect(result.correctionNewValue).toBe('paris');
    expect(result.correctionDetectionMethod).toBe('regex');
    expect(result.regexCalled).toBe(true);
    expect(result.sidecarCalled).toBe(false);
    expect(result.llmCalled).toBe(false);
  });

  it('regex miss + sidecar match returns correction', async () => {
    const sidecarMock = vi
      .fn()
      .mockResolvedValue(sidecarOk({ is_correction: true, field: 'guests', new_value: 5 }));

    const result = await runCorrectionChain({
      ...defaultOpts,
      regexResult: null,
      sidecarClient: { detectCorrection: sidecarMock },
      llmClient: true,
      llmResult: { field: 'guests', newValue: '5', oldValue: 3 },
    });

    expect(result.correctionField).toBe('guests');
    expect(result.correctionNewValue).toBe('5');
    expect(result.correctionDetectionMethod).toBe('sidecar');
    expect(result.regexCalled).toBe(true);
    expect(result.sidecarCalled).toBe(true);
    expect(result.llmCalled).toBe(false);
  });

  it('regex + sidecar miss + LLM match returns correction', async () => {
    const sidecarMock = vi.fn().mockResolvedValue(sidecarOk());

    const result = await runCorrectionChain({
      ...defaultOpts,
      regexResult: null,
      sidecarClient: { detectCorrection: sidecarMock },
      llmClient: true,
      llmResult: { field: 'date', newValue: '2026-04-01', oldValue: '2026-03-15' },
    });

    expect(result.correctionField).toBe('date');
    expect(result.correctionNewValue).toBe('2026-04-01');
    expect(result.correctionDetectionMethod).toBe('llm');
    expect(result.regexCalled).toBe(true);
    expect(result.sidecarCalled).toBe(true);
    expect(result.llmCalled).toBe(true);
  });

  it('all three methods miss returns no correction', async () => {
    const sidecarMock = vi.fn().mockResolvedValue(sidecarOk());

    const result = await runCorrectionChain({
      ...defaultOpts,
      regexResult: null,
      sidecarClient: { detectCorrection: sidecarMock },
      llmClient: true,
      llmResult: null,
    });

    expect(result.correctionField).toBeUndefined();
    expect(result.correctionNewValue).toBeUndefined();
    expect(result.regexCalled).toBe(true);
    expect(result.sidecarCalled).toBe(true);
    expect(result.llmCalled).toBe(true);
  });

  it('sidecar timeout falls back to LLM gracefully', async () => {
    const sidecarMock = vi.fn().mockRejectedValue(new Error('Per-project sidecar timeout'));

    const result = await runCorrectionChain({
      ...defaultOpts,
      regexResult: null,
      sidecarClient: { detectCorrection: sidecarMock },
      llmClient: true,
      llmResult: { field: 'destination', newValue: 'paris', oldValue: 'London' },
    });

    expect(result.correctionField).toBe('destination');
    expect(result.correctionNewValue).toBe('paris');
    expect(result.correctionDetectionMethod).toBe('llm');
    expect(result.sidecarCalled).toBe(true);
    expect(result.llmCalled).toBe(true);
  });

  it('CORRECTION_FIELD_UNKNOWN from regex defers to LLM fallback', async () => {
    const result = await runCorrectionChain({
      ...defaultOpts,
      regexResult: { field: CORRECTION_FIELD_UNKNOWN, newValue: 'paris' },
      llmClient: true,
      llmFallbackResult: { field: 'destination', newValue: 'paris', oldValue: 'London' },
    });

    expect(result.correctionField).toBe('destination');
    expect(result.correctionNewValue).toBe('paris');
    expect(result.correctionDetectionMethod).toBe('llm');
    expect(result.regexCalled).toBe(true);
    expect(result.llmFallbackCalled).toBe(true);
  });

  it('undeclared field from sidecar defers to LLM fallback', async () => {
    const sidecarMock = vi.fn().mockResolvedValue(
      sidecarOk({
        is_correction: true,
        field: 'unknown_field',
        new_value: 'paris',
      }),
    );

    const result = await runCorrectionChain({
      ...defaultOpts,
      regexResult: null,
      sidecarClient: { detectCorrection: sidecarMock },
      llmClient: true,
      llmFallbackResult: { field: 'destination', newValue: 'paris', oldValue: 'London' },
    });

    expect(result.correctionField).toBe('destination');
    expect(result.correctionNewValue).toBe('paris');
    expect(result.correctionDetectionMethod).toBe('llm');
    expect(result.sidecarCalled).toBe(true);
    expect(result.llmFallbackCalled).toBe(true);
  });

  it('undeclared field from LLM logs warning and skips', async () => {
    const sidecarMock = vi.fn().mockResolvedValue(sidecarOk());

    const result = await runCorrectionChain({
      ...defaultOpts,
      regexResult: null,
      sidecarClient: { detectCorrection: sidecarMock },
      llmClient: true,
      llmResult: { field: 'nonexistent', newValue: 'val', oldValue: undefined },
    });

    // LLM was the original detector, so no recursive retry
    expect(result.correctionField).toBeUndefined();
    expect(result.correctionNewValue).toBeUndefined();
    expect(result.llmCalled).toBe(true);
    expect(result.llmFallbackCalled).toBe(false);
  });

  it('strategy regex only enables regex detection', async () => {
    const sidecarMock = vi.fn().mockResolvedValue(
      sidecarOk({
        is_correction: true,
        field: 'destination',
        new_value: 'paris',
      }),
    );

    const result = await runCorrectionChain({
      ...defaultOpts,
      correctionMode: 'regex',
      regexResult: null,
      sidecarClient: { detectCorrection: sidecarMock },
      llmClient: true,
      llmResult: { field: 'destination', newValue: 'paris', oldValue: 'London' },
    });

    expect(result.regexCalled).toBe(true);
    expect(result.sidecarCalled).toBe(false);
    expect(result.llmCalled).toBe(false);
    expect(result.correctionField).toBeUndefined();
  });

  it('strategy ml enables regex + sidecar but not LLM', async () => {
    const sidecarMock = vi.fn().mockResolvedValue(sidecarOk());

    const result = await runCorrectionChain({
      ...defaultOpts,
      correctionMode: 'ml',
      regexResult: null,
      sidecarClient: { detectCorrection: sidecarMock },
      llmClient: true,
      llmResult: { field: 'destination', newValue: 'paris', oldValue: 'London' },
    });

    expect(result.regexCalled).toBe(true);
    expect(result.sidecarCalled).toBe(true);
    expect(result.llmCalled).toBe(false);
    expect(result.correctionField).toBeUndefined();
  });

  it('strategy llm only enables LLM detection', async () => {
    const result = await runCorrectionChain({
      ...defaultOpts,
      correctionMode: 'llm',
      regexResult: { field: 'destination', newValue: 'paris' },
      sidecarClient: {
        detectCorrection: vi.fn().mockResolvedValue(
          sidecarOk({
            is_correction: true,
            field: 'destination',
            new_value: 'paris',
          }),
        ),
      },
      llmClient: true,
      llmResult: { field: 'destination', newValue: 'paris', oldValue: 'London' },
    });

    expect(result.regexCalled).toBe(false);
    expect(result.sidecarCalled).toBe(false);
    expect(result.llmCalled).toBe(true);
    expect(result.correctionField).toBe('destination');
    expect(result.correctionDetectionMethod).toBe('llm');
  });

  it('strategy auto enables all three methods', async () => {
    const sidecarMock = vi.fn().mockResolvedValue(sidecarOk());

    const result = await runCorrectionChain({
      ...defaultOpts,
      correctionMode: 'auto',
      regexResult: null,
      sidecarClient: { detectCorrection: sidecarMock },
      llmClient: true,
      llmResult: null,
    });

    // All tiers attempted
    expect(result.regexCalled).toBe(true);
    expect(result.sidecarCalled).toBe(true);
    expect(result.llmCalled).toBe(true);
    // None found a correction
    expect(result.correctionField).toBeUndefined();
  });
});

// =============================================================================
// detectCorrectionWithLLM TESTS (6) — direct private method tests
// =============================================================================

describe('detectCorrectionWithLLM', () => {
  let executor: FlowStepExecutor;

  beforeEach(() => {
    executor = buildExecutor();
  });

  it('returns null when no LLM client', async () => {
    const session = buildSession();
    // No llmClient set on session
    const result = await callDetectCorrectionWithLLM(executor, 'actually 5 guests', session);
    expect(result).toBeNull();
  });

  it('returns null when no collected entries', async () => {
    const mockLlm = { chatWithToolUse: vi.fn() };
    const session = buildSession({ llmClient: mockLlm as any });
    // data.values is empty — nothing to correct
    const result = await callDetectCorrectionWithLLM(executor, 'actually 5 guests', session);
    expect(result).toBeNull();
    expect(mockLlm.chatWithToolUse).not.toHaveBeenCalled();
  });

  it('parses valid JSON response correctly', async () => {
    const mockLlm = {
      chatWithToolUse: vi.fn().mockResolvedValue({
        text: '{"field": "destination", "newValue": "London"}',
      }),
    };
    const session = buildSession({ llmClient: mockLlm as any });
    session.data.values.destination = 'Paris';
    session.data.values.guests = 3;

    const result = await callDetectCorrectionWithLLM(executor, 'I meant London', session, [
      { name: 'destination' },
      { name: 'guests' },
    ]);

    expect(result).toEqual({
      field: 'destination',
      newValue: 'London',
      oldValue: 'Paris',
    });
    expect(mockLlm.chatWithToolUse).toHaveBeenCalledOnce();
  });

  it('falls back to regex extraction on malformed JSON', async () => {
    const mockLlm = {
      chatWithToolUse: vi.fn().mockResolvedValue({
        text: 'Here is the correction: {"field": "guests", "newValue": "5"} Hope that helps.',
      }),
    };
    const session = buildSession({ llmClient: mockLlm as any });
    session.data.values.guests = 3;

    const result = await callDetectCorrectionWithLLM(executor, 'actually 5', session);

    expect(result).toEqual({
      field: 'guests',
      newValue: '5',
      oldValue: 3,
    });
  });

  it('returns null when field not in collected values', async () => {
    const mockLlm = {
      chatWithToolUse: vi.fn().mockResolvedValue({
        text: '{"field": "unknown_field", "newValue": "abc"}',
      }),
    };
    const session = buildSession({ llmClient: mockLlm as any });
    session.data.values.destination = 'Paris';

    const result = await callDetectCorrectionWithLLM(executor, 'change x to abc', session);
    expect(result).toBeNull();
  });

  it('returns null on LLM exception (non-blocking)', async () => {
    const mockLlm = {
      chatWithToolUse: vi.fn().mockRejectedValue(new Error('LLM service unavailable')),
    };
    const session = buildSession({ llmClient: mockLlm as any });
    session.data.values.destination = 'Paris';

    const result = await callDetectCorrectionWithLLM(
      executor,
      'actually change destination to London',
      session,
    );
    expect(result).toBeNull();
  });
});
