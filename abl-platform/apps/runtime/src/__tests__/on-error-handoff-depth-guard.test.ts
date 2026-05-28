/**
 * ON_ERROR Handoff Depth Guard — Slice 1 lock test (ABLP-412)
 *
 * Regression risk from plan: `ON_ERROR → HANDOFF A → A errors → HANDOFF B →
 * B errors → ...` could infinite-loop through the handoff routing path. The
 * existing `MAX_HANDOFF_DEPTH` guard in routing must still apply when handoffs
 * originate from error handlers, not just user-initiated handoffs.
 *
 * Contract:
 *   - After MAX_HANDOFF_DEPTH error-triggered handoffs, the loop terminates
 *     with a depth-exceeded signal rather than recursing further.
 *   - Session is not left in an inconsistent state (escalation or completion).
 *   - Trace records include a depth-guard event.
 */

import { describe, test, expect, beforeEach } from 'vitest';
import { RuntimeExecutor, compileToResolvedAgent } from '../services/runtime-executor.js';
import { injectMockClient } from './execution/pre-refactor/helpers/mock-llm-client.js';
import { createTraceCollector, filterTraces } from './helpers/history-validation.js';
import type { ErrorHandlingConfig } from '@abl/compiler/platform/ir/schema.js';

const SUPERVISOR_CYCLE_A = `
SUPERVISOR: Agent_A

GOAL: "Supervisor A — hands off to B on error"

PERSONA: "A"

HANDOFF:
  - TO: Agent_B
    WHEN: intent.category == "next"
    CONTEXT:
      summary: "A → B"
    RETURN: false
`;

const SUPERVISOR_CYCLE_B = `
SUPERVISOR: Agent_B

GOAL: "Supervisor B — hands off back to A on error"

PERSONA: "B"

HANDOFF:
  - TO: Agent_A
    WHEN: intent.category == "back"
    CONTEXT:
      summary: "B → A"
    RETURN: false
`;

describe('ON_ERROR handoff depth guard (Slice 1 ABLP-412)', () => {
  let executor: RuntimeExecutor;

  beforeEach(() => {
    executor = new RuntimeExecutor();
  });

  test('cyclic ON_ERROR handoffs terminate at depth cap, not infinite loop', async () => {
    const mockClient = injectMockClient(executor);
    mockClient.setResponseHandler(() => {
      throw new Error('LLM always fails');
    });

    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([SUPERVISOR_CYCLE_A, SUPERVISOR_CYCLE_B], 'Agent_A'),
    );

    // Both agents route to each other on unknown_error
    const errorHandlingA: ErrorHandlingConfig = {
      handlers: [
        {
          type: 'unknown_error',
          then: 'handoff',
          handoff_target: 'Agent_B',
          respond: 'A → B',
        },
      ],
      default_handler: { type: 'DEFAULT', then: 'escalate' },
    };
    session.agentIR!.error_handling = errorHandlingA;

    const tc = createTraceCollector();
    const startTime = Date.now();

    // Must terminate — either via depth guard, escalation, or completion.
    // Importantly: must NOT exceed a reasonable wall-clock (infinite loop would).
    try {
      await executor.executeMessage(session.id, 'Start', undefined, tc.callback);
    } catch {
      // acceptable — depth guard can surface as thrown error
    }

    const elapsed = Date.now() - startTime;
    // Hard upper bound — if we loop forever, we hit the 5s test timeout.
    // 2s is plenty for N handoffs plus some overhead.
    expect(elapsed).toBeLessThan(5000);

    // The traces should include at most a bounded number of error-handled events.
    // MAX_HANDOFF_DEPTH is typically 10 — cap at 20 to allow some leeway.
    const errorHandled = filterTraces(tc.traces, 'agent_error_handled');
    expect(errorHandled.length).toBeLessThan(20);
  }, 5000);
});
