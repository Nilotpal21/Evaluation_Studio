/**
 * Constraint Checker Unit Tests
 *
 * Tests for:
 * 1. checkConstraints — evaluates guardrails + constraints, returns first violation or null
 * 2. handleConstraintViolation — executes ON_FAIL actions: respond, escalate, handoff, block
 *
 * Mocking strategy: vi.mock('@abl/compiler') to control checkConstraintsCore behavior
 * and build minimal RuntimeSession mocks with agentIR.constraints.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import type { ConstraintCheckInfo } from '@abl/compiler';
import type { RuntimeSession, ExecutionResult } from '../../services/execution/types.js';

// ---------------------------------------------------------------------------
// Mock @abl/compiler — control checkConstraintsCore and DEFAULT_MESSAGES
// ---------------------------------------------------------------------------

const mockCheckConstraintsCore =
  vi.fn<
    (
      ...args: Parameters<typeof import('@abl/compiler').checkConstraintsCore>
    ) => ConstraintCheckInfo | null
  >();

vi.mock('@abl/compiler', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@abl/compiler')>();
  return {
    ...actual,
    checkConstraintsCore: (...args: Parameters<typeof actual.checkConstraintsCore>) =>
      mockCheckConstraintsCore(...args),
    DEFAULT_MESSAGES: {
      ...actual.DEFAULT_MESSAGES,
      constraint_blocked: 'I cannot proceed with that request.',
    },
  };
});

// Mock createLogger from @abl/compiler/platform
const { mockLoggerWarn } = vi.hoisted(() => ({ mockLoggerWarn: vi.fn() }));
vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: mockLoggerWarn,
    error: vi.fn(),
    child: vi.fn(),
    setCorrelationId: vi.fn(),
  }),
}));

// Mock interpolateTemplate to be a simple passthrough with {{var}} replacement
vi.mock('../../services/execution/value-resolution.js', () => ({
  interpolateTemplate: (template: string, data: Record<string, unknown>) => {
    let result = template;
    for (const [key, value] of Object.entries(data)) {
      result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), String(value));
    }
    return result;
  },
}));

// Import AFTER mocks are set up
import {
  checkConstraints,
  checkFlatConstraints,
  checkFlatConstraintsAtCheckpoint,
  executeConstraintViolation,
  getConstraintFieldsToClear,
  handleConstraintViolation,
  setCurrentTurnInputContext,
} from '../../services/execution/constraint-checker.js';
import {
  buildSessionLocalizationCatalog,
  storeSessionLocalizationCatalog,
} from '../../services/execution/localized-messages.js';

// ---------------------------------------------------------------------------
// Helpers — minimal mock session builder
// ---------------------------------------------------------------------------

interface MockSessionOptions {
  agentName?: string;
  constraints?: {
    guardrails?: Array<{
      name: string;
      description: string;
      check: string;
      action: {
        type: 'respond' | 'escalate' | 'handoff' | 'block' | 'redact';
        message?: string;
        target?: string;
        reason?: string;
      };
    }>;
    constraints?: Array<{
      condition: string;
      on_fail: {
        type: 'respond' | 'escalate' | 'handoff' | 'block' | 'redact';
        message?: string;
        target?: string;
        reason?: string;
      };
    }>;
  } | null;
  values?: Record<string, unknown>;
  messages?: Record<string, string>;
  currentFlowStep?: string;
}

function createMockSession(options: MockSessionOptions = {}): RuntimeSession {
  const {
    agentName = 'test_agent',
    constraints = null,
    values = {},
    messages,
    currentFlowStep,
  } = options;

  return {
    id: 'session-001',
    agentName,
    agentIR:
      constraints !== null
        ? ({
            name: agentName,
            constraints: constraints as NonNullable<typeof constraints>,
            messages,
          } as RuntimeSession['agentIR'])
        : null,
    compilationOutput: null,
    conversationHistory: [],
    state: {
      gatherProgress: {},
      conversationPhase: 'start',
      context: {},
    },
    data: {
      values: { ...values },
      gatheredKeys: new Set<string>(),
    },
    isComplete: false,
    isEscalated: false,
    handoffStack: [],
    currentFlowStep,
    initialized: true,
    threads: [],
    activeThreadIndex: 0,
    threadStack: [],
    createdAt: new Date(),
    lastActivityAt: new Date(),
  } as RuntimeSession;
}

describe('getConstraintFieldsToClear', () => {
  test('returns only extracted fields referenced by the failing condition', () => {
    expect(getConstraintFieldsToClear(['destination', 'origin', 'guests'], 'guests <= 10')).toEqual(
      ['guests'],
    );
  });

  test('returns all extracted fields when the condition does not reference them directly', () => {
    expect(getConstraintFieldsToClear(['destination', 'origin'], 'booking.total <= 1000')).toEqual([
      'destination',
      'origin',
    ]);
  });

  test('matches top-level extracted fields referenced through dot paths', () => {
    expect(getConstraintFieldsToClear(['booking', 'origin'], 'booking.total <= 1000')).toEqual([
      'booking',
    ]);
  });

  test('returns multiple referenced fields when the condition spans them', () => {
    expect(
      getConstraintFieldsToClear(
        ['destination', 'origin', 'guests'],
        'destination != origin AND guests <= 10',
      ),
    ).toEqual(['destination', 'origin', 'guests']);
  });
});

// ---------------------------------------------------------------------------
// TESTS — checkConstraints
// ---------------------------------------------------------------------------

describe('checkConstraints', () => {
  beforeEach(() => {
    mockCheckConstraintsCore.mockReset();
  });

  // =========================================================================
  // No constraints / null IR
  // =========================================================================

  describe('when no constraints are defined', () => {
    test('returns null when agentIR is null', () => {
      const session = createMockSession({ constraints: null });
      session.agentIR = null;
      const result = checkConstraints(session);
      expect(result).toBeNull();
      expect(mockCheckConstraintsCore).not.toHaveBeenCalled();
    });

    test('returns null when agentIR has no constraints property', () => {
      const session = createMockSession();
      session.agentIR = { name: 'test_agent' } as RuntimeSession['agentIR'];
      const result = checkConstraints(session);
      expect(result).toBeNull();
      expect(mockCheckConstraintsCore).not.toHaveBeenCalled();
    });

    test('returns null when agentIR.constraints is undefined', () => {
      const session = createMockSession();
      session.agentIR = {
        name: 'test_agent',
        constraints: undefined,
      } as unknown as RuntimeSession['agentIR'];
      const result = checkConstraints(session);
      expect(result).toBeNull();
      expect(mockCheckConstraintsCore).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // All constraints pass
  // =========================================================================

  describe('when all constraints pass', () => {
    test('returns null when checkConstraintsCore returns null', () => {
      mockCheckConstraintsCore.mockReturnValue(null);
      const session = createMockSession({
        constraints: {
          guardrails: [],
          constraints: [{ condition: 'amount > 0', on_fail: { type: 'block' } }],
        },
        values: { amount: 10 },
      });
      const result = checkConstraints(session);
      expect(result).toBeNull();
      expect(mockCheckConstraintsCore).toHaveBeenCalledOnce();
    });

    test('passes session.data.values as context to checkConstraintsCore', () => {
      mockCheckConstraintsCore.mockReturnValue(null);
      const values = { amount: 50, currency: 'USD' };
      const session = createMockSession({
        constraints: { guardrails: [], constraints: [] },
        values,
      });
      checkConstraints(session);
      expect(mockCheckConstraintsCore).toHaveBeenCalledWith(
        session.agentIR!.constraints,
        values,
        expect.objectContaining({}),
      );
    });

    test('strips guardrails before delegating the remaining constraint config to checkConstraintsCore', () => {
      mockCheckConstraintsCore.mockReturnValue(null);
      const constraintsConfig = {
        guardrails: [
          {
            name: 'no_pii',
            description: 'No PII',
            check: 'pii_detected IS NOT SET',
            action: { type: 'block' as const },
          },
        ],
        constraints: [
          {
            condition: 'amount <= 10000',
            on_fail: { type: 'respond' as const, message: 'Too high' },
          },
        ],
      };
      const session = createMockSession({ constraints: constraintsConfig });
      checkConstraints(session);
      const calledConfig = mockCheckConstraintsCore.mock.calls[0][0];
      expect(calledConfig).toEqual({
        ...constraintsConfig,
        guardrails: [],
      });
    });
  });

  // =========================================================================
  // Single constraint fails
  // =========================================================================

  describe('when a single constraint fails', () => {
    test('returns the violation from checkConstraintsCore', () => {
      const violation: ConstraintCheckInfo = {
        type: 'constraint',
        condition: 'amount <= 10000',
        passed: false,
        action: { type: 'respond', message: 'Amount too high' },
      };
      mockCheckConstraintsCore.mockReturnValue(violation);
      const session = createMockSession({
        constraints: {
          guardrails: [],
          constraints: [
            {
              condition: 'amount <= 10000',
              on_fail: { type: 'respond', message: 'Amount too high' },
            },
          ],
        },
        values: { amount: 15000 },
      });
      const result = checkConstraints(session);
      expect(result).toEqual(violation);
    });

    test('returns violation with correct type for constraint', () => {
      const violation: ConstraintCheckInfo = {
        type: 'constraint',
        condition: 'x > 0',
        passed: false,
        action: { type: 'block' },
      };
      mockCheckConstraintsCore.mockReturnValue(violation);
      const session = createMockSession({
        constraints: {
          guardrails: [],
          constraints: [{ condition: 'x > 0', on_fail: { type: 'block' } }],
        },
      });
      const result = checkConstraints(session);
      expect(result!.type).toBe('constraint');
    });
  });

  // =========================================================================
  // Guardrail fails
  // =========================================================================

  describe('when a guardrail fails', () => {
    test('returns the guardrail violation', () => {
      const violation: ConstraintCheckInfo = {
        type: 'guardrail',
        name: 'no_profanity',
        condition: 'profanity_detected IS NOT SET',
        passed: false,
        action: { type: 'block', message: 'Please keep it professional' },
      };
      mockCheckConstraintsCore.mockReturnValue(violation);
      const session = createMockSession({
        constraints: {
          guardrails: [
            {
              name: 'no_profanity',
              description: 'No profanity',
              check: 'profanity_detected IS NOT SET',
              action: { type: 'block', message: 'Please keep it professional' },
            },
          ],
          constraints: [],
        },
        values: { profanity_detected: true },
      });
      const result = checkConstraints(session);
      expect(result!.type).toBe('guardrail');
      expect(result!.name).toBe('no_profanity');
    });
  });

  // =========================================================================
  // Multiple constraints — first failure wins
  // =========================================================================

  describe('with multiple constraints', () => {
    test('returns the first failing constraint (short-circuit)', () => {
      const firstViolation: ConstraintCheckInfo = {
        type: 'guardrail',
        name: 'auth_check',
        condition: 'is_authenticated == true',
        passed: false,
        action: { type: 'escalate', reason: 'Not authenticated' },
      };
      mockCheckConstraintsCore.mockReturnValue(firstViolation);
      const session = createMockSession({
        constraints: {
          guardrails: [
            {
              name: 'auth_check',
              description: 'Auth check',
              check: 'is_authenticated == true',
              action: { type: 'escalate', reason: 'Not authenticated' },
            },
          ],
          constraints: [
            {
              condition: 'amount <= 5000',
              on_fail: { type: 'respond', message: 'Limit exceeded' },
            },
          ],
        },
      });
      const result = checkConstraints(session);
      expect(result).toEqual(firstViolation);
    });
  });

  // =========================================================================
  // Trace event callback
  // =========================================================================

  describe('trace event callback (onTraceEvent)', () => {
    test('passes onCheck callback when onTraceEvent is provided', () => {
      mockCheckConstraintsCore.mockReturnValue(null);
      const traceEvents: Array<{ type: string; data: Record<string, unknown> }> = [];
      const onTraceEvent = (event: { type: string; data: Record<string, unknown> }) => {
        traceEvents.push(event);
      };
      const session = createMockSession({
        constraints: { guardrails: [], constraints: [] },
      });
      checkConstraints(session, onTraceEvent);
      // The onCheck option should be set (a function)
      const callOptions = mockCheckConstraintsCore.mock.calls[0][2];
      expect(callOptions).toBeDefined();
      expect(typeof callOptions!.onCheck).toBe('function');
    });

    test('still passes onCheck callback when onTraceEvent is not provided (for warning collection)', () => {
      mockCheckConstraintsCore.mockReturnValue(null);
      const session = createMockSession({
        constraints: { guardrails: [], constraints: [] },
      });
      checkConstraints(session);
      const callOptions = mockCheckConstraintsCore.mock.calls[0][2];
      // onCheck is always passed now to collect WARN constraint warnings
      expect(typeof callOptions!.onCheck).toBe('function');
    });

    test('onCheck emits constraint_check trace event with correct data', () => {
      mockCheckConstraintsCore.mockImplementation((_config, _ctx, opts) => {
        // Simulate the core calling onCheck for a passing constraint
        opts?.onCheck?.({
          type: 'constraint',
          condition: 'amount <= 10000',
          passed: true,
          action: { type: 'respond', message: 'Too high' },
        });
        return null;
      });

      const traceEvents: Array<{ type: string; data: Record<string, unknown> }> = [];
      const session = createMockSession({
        agentName: 'booking_agent',
        constraints: {
          guardrails: [],
          constraints: [
            { condition: 'amount <= 10000', on_fail: { type: 'respond', message: 'Too high' } },
          ],
        },
        values: { amount: 500 },
      });
      checkConstraints(session, (e) => traceEvents.push(e));

      // Each onCheck emits a decision event first, then a detailed constraint_check event
      expect(traceEvents).toHaveLength(2);
      expect(traceEvents[0].type).toBe('decision');
      expect(traceEvents[1].type).toBe('constraint_check');
      expect(traceEvents[1].data.agentName).toBe('booking_agent');
      expect(traceEvents[1].data.constraintType).toBe('constraint');
      expect(traceEvents[1].data.condition).toBe('amount <= 10000');
      expect(traceEvents[1].data.passed).toBe(true);
      expect(traceEvents[1].data.onFail).toEqual({ type: 'respond', message: 'Too high' });
    });

    test('onCheck extracts relevant context variables from condition', () => {
      mockCheckConstraintsCore.mockImplementation((_config, _ctx, opts) => {
        opts?.onCheck?.({
          type: 'constraint',
          condition: 'amount <= max_limit',
          passed: false,
          action: { type: 'block' },
        });
        return {
          type: 'constraint',
          condition: 'amount <= max_limit',
          passed: false,
          action: { type: 'block' },
        };
      });

      const traceEvents: Array<{ type: string; data: Record<string, unknown> }> = [];
      const session = createMockSession({
        constraints: {
          guardrails: [],
          constraints: [{ condition: 'amount <= max_limit', on_fail: { type: 'block' } }],
        },
        values: { amount: 500, max_limit: 200, unrelated_field: 'ignore' },
      });
      checkConstraints(session, (e) => traceEvents.push(e));

      expect(traceEvents).toHaveLength(2);
      const relevantContext = traceEvents[1].data.relevantContext as Record<string, unknown>;
      expect(relevantContext.amount).toBe(500);
      expect(relevantContext.max_limit).toBe(200);
      expect(relevantContext.unrelated_field).toBeUndefined();
    });

    test('onCheck includes guardrail name in trace event', () => {
      mockCheckConstraintsCore.mockImplementation((_config, _ctx, opts) => {
        opts?.onCheck?.({
          type: 'guardrail',
          name: 'pii_guard',
          condition: 'has_pii IS NOT SET',
          passed: true,
          action: { type: 'block' },
        });
        return null;
      });

      const traceEvents: Array<{ type: string; data: Record<string, unknown> }> = [];
      const session = createMockSession({
        constraints: {
          guardrails: [
            {
              name: 'pii_guard',
              description: 'PII guard',
              check: 'has_pii IS NOT SET',
              action: { type: 'block' },
            },
          ],
          constraints: [],
        },
      });
      checkConstraints(session, (e) => traceEvents.push(e));

      // Index 1 is the detailed constraint_check event (index 0 is the decision event)
      expect(traceEvents[1].data.name).toBe('pii_guard');
      expect(traceEvents[1].data.constraintType).toBe('guardrail');
    });

    test('onCheck handles condition with no matching context variables', () => {
      mockCheckConstraintsCore.mockImplementation((_config, _ctx, opts) => {
        opts?.onCheck?.({
          type: 'constraint',
          condition: 'unknown_var > 0',
          passed: true,
          action: { type: 'block' },
        });
        return null;
      });

      const traceEvents: Array<{ type: string; data: Record<string, unknown> }> = [];
      const session = createMockSession({
        constraints: {
          guardrails: [],
          constraints: [{ condition: 'unknown_var > 0', on_fail: { type: 'block' } }],
        },
        values: { different_var: 42 },
      });
      checkConstraints(session, (e) => traceEvents.push(e));

      const relevantContext = traceEvents[1].data.relevantContext as Record<string, unknown>;
      expect(Object.keys(relevantContext)).toHaveLength(0);
    });

    test('multiple onCheck calls emit multiple trace events', () => {
      mockCheckConstraintsCore.mockImplementation((_config, _ctx, opts) => {
        opts?.onCheck?.({
          type: 'guardrail',
          name: 'guard1',
          condition: 'x IS SET',
          passed: true,
          action: { type: 'block' },
        });
        opts?.onCheck?.({
          type: 'constraint',
          condition: 'y > 0',
          passed: true,
          action: { type: 'respond', message: 'bad' },
        });
        return null;
      });

      const traceEvents: Array<{ type: string; data: Record<string, unknown> }> = [];
      const session = createMockSession({
        constraints: {
          guardrails: [
            { name: 'guard1', description: '', check: 'x IS SET', action: { type: 'block' } },
          ],
          constraints: [{ condition: 'y > 0', on_fail: { type: 'respond', message: 'bad' } }],
        },
      });
      checkConstraints(session, (e) => traceEvents.push(e));

      // 2 checks × 2 events each (decision + detailed) = 4 events total
      expect(traceEvents).toHaveLength(4);
      expect(traceEvents[1].data.constraintType).toBe('guardrail');
      expect(traceEvents[3].data.constraintType).toBe('constraint');
    });
  });

  // =========================================================================
  // Edge cases
  // =========================================================================

  describe('edge cases', () => {
    test('handles empty guardrails and constraints arrays', () => {
      mockCheckConstraintsCore.mockReturnValue(null);
      const session = createMockSession({
        constraints: { guardrails: [], constraints: [] },
      });
      const result = checkConstraints(session);
      expect(result).toBeNull();
    });

    test('handles session with empty data.values', () => {
      mockCheckConstraintsCore.mockReturnValue(null);
      const session = createMockSession({
        constraints: {
          guardrails: [],
          constraints: [{ condition: 'x > 0', on_fail: { type: 'block' } }],
        },
        values: {},
      });
      const result = checkConstraints(session);
      expect(result).toBeNull();
      expect(mockCheckConstraintsCore).toHaveBeenCalledWith(
        expect.anything(),
        {},
        expect.anything(),
      );
    });
  });
});

describe('checkFlatConstraints', () => {
  beforeEach(() => {
    mockCheckConstraintsCore.mockReset();
  });

  test('removes guardrails before delegating to checkConstraintsCore', () => {
    mockCheckConstraintsCore.mockReturnValue(null);
    const session = createMockSession({
      constraints: {
        guardrails: [
          {
            name: 'no_pii',
            description: 'No PII',
            check: 'pii_detected IS NOT SET',
            action: { type: 'block' },
          },
        ],
        constraints: [{ condition: 'amount <= 1000', on_fail: { type: 'respond' } }],
      },
    });

    checkFlatConstraints(session);

    expect(mockCheckConstraintsCore).toHaveBeenCalled();
    expect(mockCheckConstraintsCore.mock.calls[0][0]).toEqual({
      guardrails: [],
      constraints: [{ condition: 'amount <= 1000', on_fail: { type: 'respond' } }],
    });
  });
});

describe('setCurrentTurnInputContext', () => {
  test('stores sanitized input and raw input separately', () => {
    const session = createMockSession({ values: {} });

    setCurrentTurnInputContext(session, 'sanitized text', 'raw text');

    expect(session.data.values.input).toBe('sanitized text');
    expect(session.data.values._raw_input).toBe('raw text');
  });
});

describe('checkFlatConstraintsAtCheckpoint', () => {
  test('injects checkpoint context only for the duration of the check', () => {
    mockCheckConstraintsCore.mockReset();
    let capturedContext: Record<string, unknown> | undefined;
    mockCheckConstraintsCore.mockImplementation((_config, context) => {
      capturedContext = { ...context };
      return null;
    });
    const session = createMockSession({
      constraints: { guardrails: [], constraints: [] },
      values: { existing: 'value' },
    });

    checkFlatConstraintsAtCheckpoint(session, { kind: 'tool_call', target: 'search_aggregate' });

    expect(mockCheckConstraintsCore).toHaveBeenCalledOnce();
    expect(capturedContext).toMatchObject({
      existing: 'value',
      _abl_constraint_checkpoint_kind: 'tool_call',
      _abl_constraint_checkpoint_target: 'search_aggregate',
    });
    expect(session.data.values._abl_constraint_checkpoint_kind).toBeUndefined();
    expect(session.data.values._abl_constraint_checkpoint_target).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// TESTS — handleConstraintViolation
// ---------------------------------------------------------------------------

describe('handleConstraintViolation', () => {
  beforeEach(() => {
    mockCheckConstraintsCore.mockReset();
  });

  // =========================================================================
  // ON_FAIL: respond
  // =========================================================================

  describe('action type: respond', () => {
    test('returns response with violation message', () => {
      const session = createMockSession({ values: {} });
      const violation: ConstraintCheckInfo = {
        type: 'constraint',
        condition: 'amount <= 10000',
        passed: false,
        action: { type: 'respond', message: 'Amount exceeds limit.' },
      };
      const result = handleConstraintViolation(session, violation);
      expect(result.response).toBe('Amount exceeds limit.');
      expect(result.action.type).toBe('constraint_blocked');
      expect(result.action.constraint).toBe('amount <= 10000');
    });

    test('uses default message when action.message is not provided', () => {
      const session = createMockSession({ values: {} });
      const violation: ConstraintCheckInfo = {
        type: 'constraint',
        condition: 'x > 0',
        passed: false,
        action: { type: 'respond' },
      };
      const result = handleConstraintViolation(session, violation);
      expect(result.response).toBe('Request cannot be processed.');
    });

    test('interpolates template variables in the message', () => {
      const session = createMockSession({ values: { limit: 5000 } });
      const violation: ConstraintCheckInfo = {
        type: 'constraint',
        condition: 'amount <= limit',
        passed: false,
        action: { type: 'respond', message: 'Max allowed is {{limit}}.' },
      };
      const result = handleConstraintViolation(session, violation);
      expect(result.response).toBe('Max allowed is 5000.');
    });

    test('calls onChunk with the response message', () => {
      const session = createMockSession({ values: {} });
      const violation: ConstraintCheckInfo = {
        type: 'constraint',
        condition: 'x > 0',
        passed: false,
        action: { type: 'respond', message: 'Blocked!' },
      };
      const chunks: string[] = [];
      handleConstraintViolation(session, violation, (c) => chunks.push(c));
      expect(chunks).toEqual(['Blocked!']);
    });

    test('pushes assistant message to conversation history', () => {
      const session = createMockSession({ values: {} });
      const violation: ConstraintCheckInfo = {
        type: 'constraint',
        condition: 'x > 0',
        passed: false,
        action: { type: 'respond', message: 'No go.' },
      };
      handleConstraintViolation(session, violation);
      expect(session.conversationHistory).toHaveLength(1);
      expect(session.conversationHistory[0].role).toBe('assistant');
      expect(session.conversationHistory[0].content).toBe('No go.');
    });
  });

  // =========================================================================
  // ON_FAIL: escalate
  // =========================================================================

  describe('action type: escalate', () => {
    test('sets isEscalated flag on session', () => {
      const session = createMockSession({ values: {} });
      const violation: ConstraintCheckInfo = {
        type: 'guardrail',
        name: 'sensitive_topic',
        condition: 'is_sensitive IS NOT SET',
        passed: false,
        action: { type: 'escalate', reason: 'Sensitive topic detected' },
      };
      handleConstraintViolation(session, violation);
      expect(session.isEscalated).toBe(true);
    });

    test('sets escalationReason from action.reason', () => {
      const session = createMockSession({ values: {} });
      const violation: ConstraintCheckInfo = {
        type: 'guardrail',
        name: 'auth_required',
        condition: 'is_auth == true',
        passed: false,
        action: { type: 'escalate', reason: 'Authentication required' },
      };
      handleConstraintViolation(session, violation);
      expect(session.escalationReason).toBe('Authentication required');
    });

    test('uses default escalation reason when action.reason is not provided', () => {
      const session = createMockSession({ values: {} });
      const violation: ConstraintCheckInfo = {
        type: 'constraint',
        condition: 'trust_score >= 5',
        passed: false,
        action: { type: 'escalate' },
      };
      handleConstraintViolation(session, violation);
      expect(session.escalationReason).toBe('Constraint violation: trust_score >= 5');
    });

    test('returns escalate action with reason', () => {
      const session = createMockSession({ values: {} });
      const violation: ConstraintCheckInfo = {
        type: 'constraint',
        condition: 'x > 0',
        passed: false,
        action: { type: 'escalate', reason: 'Needs human' },
      };
      const result = handleConstraintViolation(session, violation);
      expect(result.action.type).toBe('escalate');
      expect(result.action.reason).toBe('Needs human');
    });

    test('response contains escalation message with reason', () => {
      const session = createMockSession({ values: {} });
      const violation: ConstraintCheckInfo = {
        type: 'constraint',
        condition: 'level >= 3',
        passed: false,
        action: { type: 'escalate', reason: 'High severity' },
      };
      const result = handleConstraintViolation(session, violation);
      expect(result.response).toContain('Escalated to Human Agent');
      expect(result.response).toContain('High severity');
    });

    test('calls onChunk with the escalation message', () => {
      const session = createMockSession({ values: {} });
      const violation: ConstraintCheckInfo = {
        type: 'constraint',
        condition: 'x > 0',
        passed: false,
        action: { type: 'escalate', reason: 'Escalation reason' },
      };
      const chunks: string[] = [];
      handleConstraintViolation(session, violation, (c) => chunks.push(c));
      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toContain('Escalated to Human Agent');
    });

    test('pushes assistant message to conversation history', () => {
      const session = createMockSession({ values: {} });
      const violation: ConstraintCheckInfo = {
        type: 'constraint',
        condition: 'x > 0',
        passed: false,
        action: { type: 'escalate', reason: 'Test' },
      };
      handleConstraintViolation(session, violation);
      expect(session.conversationHistory).toHaveLength(1);
      expect(session.conversationHistory[0].role).toBe('assistant');
    });
  });

  // =========================================================================
  // ON_FAIL: handoff
  // =========================================================================

  describe('action type: handoff', () => {
    test('returns handoff action with specified target', () => {
      const session = createMockSession({ values: {} });
      const violation: ConstraintCheckInfo = {
        type: 'constraint',
        condition: 'language == "en"',
        passed: false,
        action: { type: 'handoff', target: 'language_specialist' },
      };
      const result = handleConstraintViolation(session, violation);
      expect(result.action.type).toBe('handoff');
      expect(result.action.target).toBe('language_specialist');
    });

    test('uses "supervisor" as default target when action.target is not provided', () => {
      const session = createMockSession({ values: {} });
      const violation: ConstraintCheckInfo = {
        type: 'constraint',
        condition: 'x > 0',
        passed: false,
        action: { type: 'handoff' },
      };
      const result = handleConstraintViolation(session, violation);
      expect(result.action.target).toBe('supervisor');
    });

    test('response mentions routing to target', () => {
      const session = createMockSession({ values: {} });
      const violation: ConstraintCheckInfo = {
        type: 'constraint',
        condition: 'x > 0',
        passed: false,
        action: { type: 'handoff', target: 'support_agent' },
      };
      const result = handleConstraintViolation(session, violation);
      expect(result.response).toContain('support_agent');
      expect(result.response).toContain('Routing to');
    });

    test('does not modify session escalation flags', () => {
      const session = createMockSession({ values: {} });
      const violation: ConstraintCheckInfo = {
        type: 'constraint',
        condition: 'x > 0',
        passed: false,
        action: { type: 'handoff', target: 'other_agent' },
      };
      handleConstraintViolation(session, violation);
      expect(session.isEscalated).toBe(false);
      expect(session.escalationReason).toBeUndefined();
    });

    test('does not push to conversation history', () => {
      const session = createMockSession({ values: {} });
      const violation: ConstraintCheckInfo = {
        type: 'constraint',
        condition: 'x > 0',
        passed: false,
        action: { type: 'handoff', target: 'other_agent' },
      };
      handleConstraintViolation(session, violation);
      // Handoff branch does not push to conversation history
      expect(session.conversationHistory).toHaveLength(0);
    });
  });

  // =========================================================================
  // ON_FAIL: block
  // =========================================================================

  describe('action type: block', () => {
    test('returns blocked action with condition as reason', () => {
      const session = createMockSession({ values: {} });
      const violation: ConstraintCheckInfo = {
        type: 'constraint',
        condition: 'age >= 18',
        passed: false,
        action: { type: 'block' },
      };
      const result = handleConstraintViolation(session, violation);
      expect(result.action.type).toBe('blocked');
      expect(result.action.reason).toBe('age >= 18');
    });

    test('uses action.reason when provided without an action.message', () => {
      const session = createMockSession({ values: {} });
      const violation: ConstraintCheckInfo = {
        type: 'constraint',
        condition: 'age >= 18',
        passed: false,
        action: { type: 'block', reason: 'Adults only.' },
      };
      const result = handleConstraintViolation(session, violation);
      expect(result.response).toBe('Adults only.');
      expect(result.action.reason).toBe('Adults only.');
    });

    test('uses action.message when provided', () => {
      const session = createMockSession({ values: {} });
      const violation: ConstraintCheckInfo = {
        type: 'constraint',
        condition: 'age >= 18',
        passed: false,
        action: { type: 'block', message: 'You must be 18 or older.' },
      };
      const result = handleConstraintViolation(session, violation);
      expect(result.response).toBe('You must be 18 or older.');
    });

    test('uses agentIR.messages.constraint_blocked when action.message is not set', () => {
      const session = createMockSession({
        constraints: { guardrails: [], constraints: [] },
        values: {},
        messages: { constraint_blocked: 'Custom blocked message from IR.' },
      });
      const violation: ConstraintCheckInfo = {
        type: 'constraint',
        condition: 'x > 0',
        passed: false,
        action: { type: 'block' },
      };
      const result = handleConstraintViolation(session, violation);
      expect(result.response).toBe('Custom blocked message from IR.');
    });

    test('prefers localized catalog messages when available', () => {
      const session = createMockSession({
        constraints: { guardrails: [], constraints: [] },
        values: { _locale: 'fr-FR' },
        messages: { constraint_blocked: 'Custom blocked message from IR.' },
      });
      storeSessionLocalizationCatalog(
        session.data,
        buildSessionLocalizationCatalog({
          'locale:fr-FR/test_agent.json': JSON.stringify({
            constraint_blocked: 'Je ne peux pas continuer avec cette demande.',
          }),
        }),
      );

      const violation: ConstraintCheckInfo = {
        type: 'constraint',
        condition: 'x > 0',
        passed: false,
        action: { type: 'block' },
      };

      const result = handleConstraintViolation(session, violation);
      expect(result.response).toBe('Je ne peux pas continuer avec cette demande.');
    });

    test('uses DEFAULT_MESSAGES.constraint_blocked as final fallback', () => {
      const session = createMockSession({ values: {} });
      // Ensure agentIR has no messages
      session.agentIR = {
        name: 'test_agent',
        constraints: { guardrails: [], constraints: [] },
      } as RuntimeSession['agentIR'];
      const violation: ConstraintCheckInfo = {
        type: 'constraint',
        condition: 'x > 0',
        passed: false,
        action: { type: 'block' },
      };
      const result = handleConstraintViolation(session, violation);
      expect(result.response).toBe('I cannot proceed with that request.');
    });

    test('calls onChunk with the block message', () => {
      const session = createMockSession({ values: {} });
      const violation: ConstraintCheckInfo = {
        type: 'constraint',
        condition: 'x > 0',
        passed: false,
        action: { type: 'block', message: 'Nope.' },
      };
      const chunks: string[] = [];
      handleConstraintViolation(session, violation, (c) => chunks.push(c));
      expect(chunks).toEqual(['Nope.']);
    });

    test('pushes assistant message to conversation history', () => {
      const session = createMockSession({ values: {} });
      const violation: ConstraintCheckInfo = {
        type: 'constraint',
        condition: 'x > 0',
        passed: false,
        action: { type: 'block', message: 'Blocked.' },
      };
      handleConstraintViolation(session, violation);
      expect(session.conversationHistory).toHaveLength(1);
      expect(session.conversationHistory[0].role).toBe('assistant');
      expect(session.conversationHistory[0].content).toBe('Blocked.');
    });
  });

  // =========================================================================
  // Unknown action type — falls through to block default
  // =========================================================================

  describe('unknown action type (default to block)', () => {
    test('treats unknown action type as block', () => {
      mockLoggerWarn.mockClear();
      const session = createMockSession({ values: {} });
      const violation: ConstraintCheckInfo = {
        type: 'constraint',
        condition: 'x > 0',
        passed: false,
        action: { type: 'unknown_type' as 'block' },
      };
      const result = handleConstraintViolation(session, violation);
      expect(result.action.type).toBe('blocked');
      expect(mockLoggerWarn).toHaveBeenCalledWith(
        expect.stringContaining('Unknown constraint violation action type'),
        expect.objectContaining({ actionType: 'unknown_type' }),
      );
    });

    test('logs a warning for unknown action types', () => {
      mockLoggerWarn.mockClear();
      const session = createMockSession({ values: {} });
      const violation: ConstraintCheckInfo = {
        type: 'constraint',
        condition: 'x > 0',
        passed: false,
        action: { type: 'totally_unknown_action' as 'block' },
      };
      handleConstraintViolation(session, violation);
      // truly unknown action type falls through to default block behavior
      expect(mockLoggerWarn).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Trace events (onTraceEvent) in handleConstraintViolation
  // =========================================================================

  describe('trace event emission (onTraceEvent)', () => {
    test('emits constraint_violation trace event', () => {
      const traceEvents: Array<{ type: string; data: Record<string, unknown> }> = [];
      const session = createMockSession({
        agentName: 'booking_agent',
        constraints: { guardrails: [], constraints: [] },
        values: { amount: 99999 },
        currentFlowStep: 'collect_payment',
      });
      const violation: ConstraintCheckInfo = {
        type: 'constraint',
        condition: 'amount <= 10000',
        passed: false,
        action: { type: 'respond', message: 'Too much.' },
      };
      handleConstraintViolation(session, violation, undefined, (e) => traceEvents.push(e));

      expect(traceEvents).toHaveLength(1);
      expect(traceEvents[0].type).toBe('constraint_violation');
      expect(traceEvents[0].data.agentName).toBe('booking_agent');
      expect(traceEvents[0].data.stepName).toBe('collect_payment');
      expect(traceEvents[0].data.constraintType).toBe('constraint');
      expect(traceEvents[0].data.name).toBeUndefined();
      expect(traceEvents[0].data.condition).toBe('amount <= 10000');
      expect(traceEvents[0].data.action).toEqual({ type: 'respond', message: 'Too much.' });
    });

    test('includes guardrail name in trace event', () => {
      const traceEvents: Array<{ type: string; data: Record<string, unknown> }> = [];
      const session = createMockSession({
        agentName: 'support_agent',
        constraints: { guardrails: [], constraints: [] },
        values: {},
      });
      const violation: ConstraintCheckInfo = {
        type: 'guardrail',
        name: 'no_pii',
        condition: 'pii_detected IS NOT SET',
        passed: false,
        action: { type: 'block', message: 'PII not allowed.' },
      };
      handleConstraintViolation(session, violation, undefined, (e) => traceEvents.push(e));

      expect(traceEvents[0].data.constraintType).toBe('guardrail');
      expect(traceEvents[0].data.name).toBe('no_pii');
    });

    test('includes relevant context (data.values) in trace event', () => {
      const traceEvents: Array<{ type: string; data: Record<string, unknown> }> = [];
      const session = createMockSession({
        constraints: { guardrails: [], constraints: [] },
        values: { age: 15, country: 'US' },
      });
      const violation: ConstraintCheckInfo = {
        type: 'constraint',
        condition: 'age >= 18',
        passed: false,
        action: { type: 'block' },
      };
      handleConstraintViolation(session, violation, undefined, (e) => traceEvents.push(e));

      const ctx = traceEvents[0].data.relevantContext as Record<string, unknown>;
      expect(ctx.age).toBe(15);
      expect(ctx.country).toBe('US');
    });

    test('does not emit trace event when onTraceEvent is not provided', () => {
      const session = createMockSession({ values: {} });
      const violation: ConstraintCheckInfo = {
        type: 'constraint',
        condition: 'x > 0',
        passed: false,
        action: { type: 'respond', message: 'Nope' },
      };
      // Should not throw
      const result = handleConstraintViolation(session, violation);
      expect(result).toBeDefined();
    });
  });

  // =========================================================================
  // Combined: onChunk + onTraceEvent
  // =========================================================================

  describe('combined onChunk and onTraceEvent', () => {
    test('both callbacks fire for respond action', () => {
      const chunks: string[] = [];
      const traceEvents: Array<{ type: string; data: Record<string, unknown> }> = [];
      const session = createMockSession({ values: {} });
      const violation: ConstraintCheckInfo = {
        type: 'constraint',
        condition: 'x > 0',
        passed: false,
        action: { type: 'respond', message: 'Blocked by constraint.' },
      };
      handleConstraintViolation(
        session,
        violation,
        (c) => chunks.push(c),
        (e) => traceEvents.push(e),
      );
      expect(chunks).toEqual(['Blocked by constraint.']);
      expect(traceEvents).toHaveLength(1);
    });

    test('both callbacks fire for escalate action', () => {
      const chunks: string[] = [];
      const traceEvents: Array<{ type: string; data: Record<string, unknown> }> = [];
      const session = createMockSession({ values: {} });
      const violation: ConstraintCheckInfo = {
        type: 'constraint',
        condition: 'x > 0',
        passed: false,
        action: { type: 'escalate', reason: 'Urgent' },
      };
      handleConstraintViolation(
        session,
        violation,
        (c) => chunks.push(c),
        (e) => traceEvents.push(e),
      );
      expect(chunks).toHaveLength(1);
      // 2 trace events: constraint_violation + escalation
      expect(traceEvents).toHaveLength(2);
      expect(traceEvents[0].type).toBe('constraint_violation');
      expect(traceEvents[1].type).toBe('escalation');
      expect(traceEvents[1].data.source).toBe('constraint_violation');
    });

    test('both callbacks fire for block action', () => {
      const chunks: string[] = [];
      const traceEvents: Array<{ type: string; data: Record<string, unknown> }> = [];
      const session = createMockSession({ values: {} });
      const violation: ConstraintCheckInfo = {
        type: 'constraint',
        condition: 'x > 0',
        passed: false,
        action: { type: 'block', message: 'Hard block.' },
      };
      handleConstraintViolation(
        session,
        violation,
        (c) => chunks.push(c),
        (e) => traceEvents.push(e),
      );
      expect(chunks).toEqual(['Hard block.']);
      expect(traceEvents).toHaveLength(1);
    });
  });

  // =========================================================================
  // Session state mutations
  // =========================================================================

  describe('session state mutations', () => {
    test('respond does not set isEscalated', () => {
      const session = createMockSession({ values: {} });
      const violation: ConstraintCheckInfo = {
        type: 'constraint',
        condition: 'x > 0',
        passed: false,
        action: { type: 'respond', message: 'Nope' },
      };
      handleConstraintViolation(session, violation);
      expect(session.isEscalated).toBe(false);
    });

    test('escalate sets isEscalated to true', () => {
      const session = createMockSession({ values: {} });
      const violation: ConstraintCheckInfo = {
        type: 'constraint',
        condition: 'x > 0',
        passed: false,
        action: { type: 'escalate', reason: 'test' },
      };
      handleConstraintViolation(session, violation);
      expect(session.isEscalated).toBe(true);
    });

    test('block does not set isEscalated', () => {
      const session = createMockSession({ values: {} });
      const violation: ConstraintCheckInfo = {
        type: 'constraint',
        condition: 'x > 0',
        passed: false,
        action: { type: 'block' },
      };
      handleConstraintViolation(session, violation);
      expect(session.isEscalated).toBe(false);
    });

    test('handoff does not set isEscalated', () => {
      const session = createMockSession({ values: {} });
      const violation: ConstraintCheckInfo = {
        type: 'constraint',
        condition: 'x > 0',
        passed: false,
        action: { type: 'handoff', target: 'other' },
      };
      handleConstraintViolation(session, violation);
      expect(session.isEscalated).toBe(false);
    });

    test('conversation history accumulates across multiple violations', () => {
      const session = createMockSession({ values: {} });
      const violation1: ConstraintCheckInfo = {
        type: 'constraint',
        condition: 'a > 0',
        passed: false,
        action: { type: 'respond', message: 'First violation' },
      };
      const violation2: ConstraintCheckInfo = {
        type: 'constraint',
        condition: 'b > 0',
        passed: false,
        action: { type: 'block', message: 'Second violation' },
      };
      handleConstraintViolation(session, violation1);
      handleConstraintViolation(session, violation2);
      expect(session.conversationHistory).toHaveLength(2);
      expect(session.conversationHistory[0].content).toBe('First violation');
      expect(session.conversationHistory[1].content).toBe('Second violation');
    });
  });

  // =========================================================================
  // Return value structure
  // =========================================================================

  describe('return value structure', () => {
    test('respond returns ExecutionResult with response and action', () => {
      const session = createMockSession({ values: {} });
      const violation: ConstraintCheckInfo = {
        type: 'constraint',
        condition: 'x > 0',
        passed: false,
        action: { type: 'respond', message: 'msg' },
      };
      const result: ExecutionResult = handleConstraintViolation(session, violation);
      expect(result).toHaveProperty('response');
      expect(result).toHaveProperty('action');
      expect(result.action).toHaveProperty('type');
    });

    test('escalate returns reason in both response and action', () => {
      const session = createMockSession({ values: {} });
      const violation: ConstraintCheckInfo = {
        type: 'constraint',
        condition: 'trust < 3',
        passed: false,
        action: { type: 'escalate', reason: 'Low trust' },
      };
      const result = handleConstraintViolation(session, violation);
      expect(result.action.reason).toBe('Low trust');
      expect(result.response).toContain('Low trust');
    });

    test('handoff returns target in action', () => {
      const session = createMockSession({ values: {} });
      const violation: ConstraintCheckInfo = {
        type: 'constraint',
        condition: 'x > 0',
        passed: false,
        action: { type: 'handoff', target: 'billing_agent' },
      };
      const result = handleConstraintViolation(session, violation);
      expect(result.action.target).toBe('billing_agent');
    });

    test('block returns condition as reason in action', () => {
      const session = createMockSession({ values: {} });
      const violation: ConstraintCheckInfo = {
        type: 'constraint',
        condition: 'verified == true',
        passed: false,
        action: { type: 'block' },
      };
      const result = handleConstraintViolation(session, violation);
      expect(result.action.reason).toBe('verified == true');
    });
  });
});

describe('executeConstraintViolation', () => {
  test('executes real handoff callbacks when provided', async () => {
    const session = createMockSession({ values: { issue: 'billing' } });
    const violation: ConstraintCheckInfo = {
      type: 'constraint',
      condition: 'issue == "billing"',
      passed: false,
      action: { type: 'handoff', target: 'billing_agent', message: 'Escalate {{issue}}' },
    };
    const executeHandoff = vi.fn().mockResolvedValue({
      success: true,
      response: 'Billing agent joined.',
    });

    const result = await executeConstraintViolation(session, violation, {
      executeHandoff,
    });

    expect(executeHandoff).toHaveBeenCalledWith(
      {
        target: 'billing_agent',
        message: 'Escalate billing',
        reason: 'Escalate billing',
        context: { issue: 'billing' },
      },
      undefined,
      undefined,
    );
    expect(result).toEqual({
      response: 'Billing agent joined.',
      action: { type: 'handoff', target: 'billing_agent' },
      stateUpdates: {
        activeAgent: undefined,
        context: { issue: 'billing' },
        conversationPhase: 'start',
        gatherProgress: {},
      },
    });
  });

  test('can suppress response side effects for reasoning loop callers', async () => {
    const session = createMockSession({ values: {} });
    const violation: ConstraintCheckInfo = {
      type: 'constraint',
      condition: 'amount <= 100',
      passed: false,
      action: { type: 'respond', message: 'Need a smaller amount.' },
    };

    const result = await executeConstraintViolation(session, violation, {
      applyResponseSideEffects: false,
    });

    expect(result.response).toBe('Need a smaller amount.');
    expect(session.conversationHistory).toHaveLength(0);
  });
});
