/**
 * Unit tests for FlowStepExecutor private methods:
 *   - handleConstraintControlFlow
 *   - executeMiniCollect
 *
 * These are private methods on the FlowStepExecutor class, so we access them
 * via (executor as any). We mock the dependencies:
 *   - extractEntitiesWithLLM (on the executor instance)
 *   - checkConstraints (module-level import from constraint-checker)
 *   - setGatheredValues (module-level import from types)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ConstraintCheckInfo } from '@abl/compiler';

// Mock constraint-checker module
vi.mock('../../services/execution/constraint-checker.js', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('../services/execution/constraint-checker.js')>();
  return {
    ...original,
    checkFlatConstraints: vi.fn(() => null),
    handleConstraintViolation: vi.fn(),
    executeConstraintViolation: vi.fn(),
    interpretConstraintControlFlow: vi.fn(),
    setCurrentTurnInputContext: vi.fn(),
  };
});

// Mock types module (setGatheredValues)
vi.mock('../../services/execution/types.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../services/execution/types.js')>();
  return {
    ...original,
    setGatheredValues: vi.fn(),
  };
});

import { FlowStepExecutor } from '../../services/execution/flow-step-executor.js';
import { checkFlatConstraints } from '../../services/execution/constraint-checker.js';
import type { ConstraintControlFlowDirective } from '../../services/execution/constraint-checker.js';
import { setGatheredValues } from '../../services/execution/types.js';
import type { RuntimeSession, ExecutorContext } from '../../services/execution/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createSession(overrides?: Partial<RuntimeSession>): RuntimeSession {
  return {
    id: 'test-session-1',
    agentName: 'test_agent',
    agentIR: null,
    compilationOutput: null,
    conversationHistory: [],
    state: { gatherProgress: {}, conversationPhase: 'gather', context: {} },
    data: { values: {}, gatheredKeys: new Set<string>() },
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
    backtrackCounts: {},
    constraintCollectState: undefined,
    ...overrides,
  } as RuntimeSession;
}

function createMockCtx(): ExecutorContext {
  return {
    executeMessage: vi.fn(),
    wireLLMClient: vi.fn(),
    checkConstraints: vi.fn(() => null),
    handleConstraintViolation: vi.fn(),
    interpolateTemplate: vi.fn((t: string) => t),
    debouncedPersist: vi.fn(),
    markExecuting: vi.fn(),
    unmarkExecuting: vi.fn(),
    cancelPendingPersist: vi.fn(),
    agentRegistry: new Map() as any,
    sessions: new Map(),
    config: {},
    reasoning: { execute: vi.fn() },
  } as unknown as ExecutorContext;
}

function createMockRouting() {
  return {
    handleMultiIntent: vi.fn(),
    checkCompletionCondition: vi.fn(),
  } as any;
}

// ---------------------------------------------------------------------------
// handleConstraintControlFlow
// ---------------------------------------------------------------------------

describe('handleConstraintControlFlow', () => {
  let executor: FlowStepExecutor;
  let ctx: ExecutorContext;
  let routing: ReturnType<typeof createMockRouting>;

  beforeEach(() => {
    vi.clearAllMocks();
    ctx = createMockCtx();
    routing = createMockRouting();
    executor = new FlowStepExecutor(ctx, routing);
  });

  const baseViolation: ConstraintCheckInfo = {
    type: 'constraint',
    name: 'test_constraint',
    condition: 'x > 0',
    passed: false,
    action: { type: 'respond', message: 'fail' },
  };

  it('collect_field directive sets constraintCollectState with fields and thenAction', () => {
    const session = createSession();
    const directive: ConstraintControlFlowDirective = {
      type: 'collect_field',
      fields: ['num_guests', 'room_type'],
      thenAction: 'retry',
      respond: 'Please provide the missing fields.',
      constraintCondition: 'num_guests <= 10',
    };

    const result = (executor as any).handleConstraintControlFlow(session, baseViolation, directive);

    expect(result).not.toBeNull();
    expect(result.action).toBe('collect');
    expect(result.respond).toBe('Please provide the missing fields.');

    // Verify session.constraintCollectState was set
    expect(session.constraintCollectState).toBeDefined();
    expect(session.constraintCollectState!.fields).toEqual(['num_guests', 'room_type']);
    expect(session.constraintCollectState!.thenAction).toBe('retry');
    expect(session.constraintCollectState!.constraintCondition).toBe('num_guests <= 10');
  });

  it('collect_field directive preserves thenStep follow-up state', () => {
    const session = createSession();
    const directive: ConstraintControlFlowDirective = {
      type: 'collect_field',
      fields: ['verification_code'],
      thenStep: 'verify_identity',
      respond: 'Please provide your verification code.',
      constraintCondition: 'verification_code IS SET',
    };

    const result = (executor as any).handleConstraintControlFlow(session, baseViolation, directive);

    expect(result).not.toBeNull();
    expect(result.action).toBe('collect');
    expect(session.constraintCollectState).toBeDefined();
    expect(session.constraintCollectState!.fields).toEqual(['verification_code']);
    expect(session.constraintCollectState!.thenAction).toBe('continue');
    expect(session.constraintCollectState!.thenStep).toBe('verify_identity');
    expect(session.constraintCollectState!.constraintCondition).toBe('verification_code IS SET');
  });

  it('goto_step directive increments backtrackCounts for target step', () => {
    const session = createSession({ backtrackCounts: { gather_step: 1 } });
    const directive: ConstraintControlFlowDirective = {
      type: 'goto_step',
      targetStep: 'gather_step',
      respond: 'Going back to gather.',
      constraintCondition: 'info IS SET',
    };

    const result = (executor as any).handleConstraintControlFlow(session, baseViolation, directive);

    expect(result).not.toBeNull();
    expect(result.action).toBe('goto');
    expect(result.nextStep).toBe('gather_step');
    expect(result.respond).toBe('Going back to gather.');
    // Backtrack count should have incremented from 1 to 2
    expect(session.backtrackCounts!['gather_step']).toBe(2);
  });

  it('retry_step directive returns retry action with optional respond', () => {
    const session = createSession();
    const directive: ConstraintControlFlowDirective = {
      type: 'retry_step',
      respond: 'Invalid input, please try again.',
      constraintCondition: 'valid_format == true',
    };

    const result = (executor as any).handleConstraintControlFlow(session, baseViolation, directive);

    expect(result).not.toBeNull();
    expect(result.action).toBe('retry');
    expect(result.respond).toBe('Invalid input, please try again.');
  });

  it('unknown directive type returns null', () => {
    const session = createSession();
    const directive = {
      type: 'unknown_type',
      constraintCondition: 'x > 0',
    } as unknown as ConstraintControlFlowDirective;

    const result = (executor as any).handleConstraintControlFlow(session, baseViolation, directive);

    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// executeMiniCollect
// ---------------------------------------------------------------------------

describe('executeMiniCollect', () => {
  let executor: FlowStepExecutor;
  let ctx: ExecutorContext;
  let routing: ReturnType<typeof createMockRouting>;
  const mockCheckFlatConstraints = checkFlatConstraints as ReturnType<typeof vi.fn>;
  const mockSetGatheredValues = setGatheredValues as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    ctx = createMockCtx();
    routing = createMockRouting();
    executor = new FlowStepExecutor(ctx, routing);

    // Default: extractEntitiesWithLLM returns empty by default
    (executor as any).extractEntitiesWithLLM = vi.fn().mockResolvedValue({});
    // Default: checkFlatConstraints returns null (constraint passes)
    mockCheckFlatConstraints.mockReturnValue(null);
  });

  it('extracts entities and merges into session via setGatheredValues', async () => {
    const session = createSession({
      constraintCollectState: {
        fields: ['num_guests'],
        thenAction: 'continue',
        constraintCondition: 'num_guests <= 10',
      },
    });

    (executor as any).extractEntitiesWithLLM = vi.fn().mockResolvedValue({ num_guests: 5 });

    await (executor as any).executeMiniCollect(session, 'there are 5 guests');

    // extractEntitiesWithLLM should have been called with the user message and fields
    expect((executor as any).extractEntitiesWithLLM).toHaveBeenCalledWith(
      'there are 5 guests',
      ['num_guests'],
      session,
      undefined, // onTraceEvent
    );

    // setGatheredValues should have been called with extracted values
    expect(mockSetGatheredValues).toHaveBeenCalledWith(session, { num_guests: 5 });
  });

  it('clears constraintCollectState after extraction', async () => {
    const session = createSession({
      constraintCollectState: {
        fields: ['amount'],
        thenAction: 'continue',
        constraintCondition: 'amount > 0',
      },
    });

    (executor as any).extractEntitiesWithLLM = vi.fn().mockResolvedValue({ amount: 100 });

    await (executor as any).executeMiniCollect(session, 'the amount is 100');

    // constraintCollectState should be cleared (no nesting)
    expect(session.constraintCollectState).toBeUndefined();
  });

  it('returns continue when constraint passes with continue thenAction', async () => {
    const session = createSession({
      constraintCollectState: {
        fields: ['num_guests'],
        thenAction: 'continue',
        constraintCondition: 'num_guests <= 10',
      },
    });

    (executor as any).extractEntitiesWithLLM = vi.fn().mockResolvedValue({ num_guests: 5 });
    // Constraint passes after collection
    mockCheckFlatConstraints.mockReturnValue(null);

    const result = await (executor as any).executeMiniCollect(session, '5 guests');

    expect(result).toEqual({ action: 'continue' });
  });

  it('returns retry when constraint passes with retry thenAction', async () => {
    const session = createSession({
      constraintCollectState: {
        fields: ['amount'],
        thenAction: 'retry',
        constraintCondition: 'amount > 0',
      },
    });

    (executor as any).extractEntitiesWithLLM = vi.fn().mockResolvedValue({ amount: 50 });
    // Constraint passes after collection
    mockCheckFlatConstraints.mockReturnValue(null);

    const result = await (executor as any).executeMiniCollect(session, 'amount is 50');

    expect(result).toEqual({ action: 'retry' });
  });

  it('returns goto when constraint passes with thenStep follow-up', async () => {
    const session = createSession({
      constraintCollectState: {
        fields: ['verification_code'],
        thenAction: 'retry',
        thenStep: 'verify_identity',
        constraintCondition: 'verification_code IS SET',
      },
    });

    (executor as any).extractEntitiesWithLLM = vi
      .fn()
      .mockResolvedValue({ verification_code: '123456' });
    mockCheckFlatConstraints.mockReturnValue(null);

    const result = await (executor as any).executeMiniCollect(session, 'the code is 123456');

    expect(result).toEqual({ action: 'goto', nextStep: 'verify_identity' });
  });

  it('returns escalate when constraint still fails after collection', async () => {
    const session = createSession({
      constraintCollectState: {
        fields: ['num_guests'],
        thenAction: 'continue',
        constraintCondition: 'num_guests <= 10',
      },
    });

    (executor as any).extractEntitiesWithLLM = vi.fn().mockResolvedValue({ num_guests: 15 });
    // Constraint still fails after collection
    const violation: ConstraintCheckInfo = {
      type: 'constraint',
      name: 'max_guests',
      condition: 'num_guests <= 10',
      passed: false,
      action: { type: 'respond', message: 'Still too many guests' },
    };
    mockCheckFlatConstraints.mockReturnValue(violation);

    const result = await (executor as any).executeMiniCollect(session, '15 guests please');

    expect(result).toEqual({
      action: 'escalate',
      constraintCondition: 'num_guests <= 10',
    });
  });

  it('constraint re-evaluation uses checkFlatConstraints()', async () => {
    const session = createSession({
      constraintCollectState: {
        fields: ['city'],
        thenAction: 'continue',
        constraintCondition: 'city IS SET',
      },
    });

    (executor as any).extractEntitiesWithLLM = vi.fn().mockResolvedValue({ city: 'Paris' });
    mockCheckFlatConstraints.mockReturnValue(null);

    const onTrace = vi.fn();

    await (executor as any).executeMiniCollect(session, 'Paris', undefined, onTrace);

    // checkFlatConstraints should have been called with the session and onTraceEvent
    expect(mockCheckFlatConstraints).toHaveBeenCalledWith(session, onTrace);
  });
});
