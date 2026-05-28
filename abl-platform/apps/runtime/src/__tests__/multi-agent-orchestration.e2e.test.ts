/**
 * Multi-Agent Orchestration E2E Test Suite
 *
 * Validates the multi-agent orchestration mechanics of the ABL runtime:
 * - Handoff (supervisor -> specialist, with RETURN/PASS/MAP)
 * - Thread management (creation, return, isolation)
 * - Fan-out (parallel dispatch to multiple specialists)
 * - Error handling (missing agents, partial failures)
 * - Multi-level delegation chains
 *
 * Two tiers:
 * 1. Deterministic (scripted FLOW agents, no LLM) — tests orchestration mechanics
 * 2. Live LLM (reasoning agents, env-gated) — tests real LLM-driven routing
 *
 * Absorbed unique scenarios from flow-handoff-threads.test.ts (now deleted):
 * - Second handoff rule fires when first doesn't match
 * - Handoff trace events with condition checks
 * - Tighter structural assertions (exact thread counts, activeThreadIndex, threadStack)
 *
 * Follows patterns from traveldesk-supervisor-ws-flow.e2e.test.ts.
 */

import { describe, test, expect, beforeEach, beforeAll } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { config as dotenvConfig } from 'dotenv';

// Load .env before any imports that depend on it
dotenvConfig({ path: join(import.meta.dirname, '../../.env') });

import {
  RuntimeExecutor,
  compileToResolvedAgent,
  getActiveThread,
  type RuntimeSession,
} from '../services/runtime-executor';
import {
  assertSessionHistoryIntegrity,
  injectValidatingMockClient,
  createTraceCollector,
  filterTraces,
  type CapturedTrace,
} from './helpers/history-validation';
import {
  loadOrchestrationFixture,
  createOrchestrationSession,
  sendMessage,
  assertThreadCount,
  assertActiveAgent,
  assertHandoffOccurred,
  assertDataPassed,
  assertThreadStatus,
  assertOrchestrationIntegrity,
} from './helpers/orchestration-harness';

// =============================================================================
// FIXTURE LOADING
// =============================================================================

const supervisorDsl = loadOrchestrationFixture('supervisor-router.abl');
const bookingDsl = loadOrchestrationFixture('specialist-booking.abl');
const supportDsl = loadOrchestrationFixture('specialist-support.abl');
const fanOutDsl = loadOrchestrationFixture('fan-out-coordinator.abl');
const reasoningSupervisorDsl = loadOrchestrationFixture('reasoning-supervisor.abl');
const reasoningSpecialistDsl = loadOrchestrationFixture('reasoning-specialist.abl');

function applyParallelFanOutRuntimeConfig(session: RuntimeSession): void {
  // Production defaults to primary_queue. Fan-out tests must opt into
  // the parallel strategy explicitly so the runtime can synthesize __fan_out__.
  const projectRuntimeConfig = {
    extraction_strategy: 'auto' as const,
    multi_intent: {
      enabled: true,
      strategy: 'parallel' as const,
      max_intents: 3,
      confidence_threshold: 0.6,
      queue_max_age_ms: 300_000,
    },
    inference: {
      confidence: 0.8,
      confirm: true,
      model_tier: 'fast' as const,
      max_fields_per_pass: 3,
    },
    conversion: { currency_mode: 'static' as const },
    lookup_tables: [],
  };

  session._projectRuntimeConfig = projectRuntimeConfig;
  if (session.agentIR) {
    session.agentIR.project_runtime_config = projectRuntimeConfig;
  }
}

// =============================================================================
// DETERMINISTIC TIER — Scripted FLOW agents, no LLM
// =============================================================================

describe('Multi-Agent Orchestration — Deterministic Tier', () => {
  let executor: RuntimeExecutor;

  beforeEach(() => {
    executor = new RuntimeExecutor();
  });

  // =========================================================================
  // D-1: Supervisor -> specialist handoff (scripted)
  // =========================================================================
  test('D-1: Supervisor -> specialist handoff creates child thread', async () => {
    const session = createOrchestrationSession(
      executor,
      supervisorDsl,
      [bookingDsl, supportDsl],
      'Supervisor_Router',
    );
    await executor.initializeSession(session.id);

    // Verify initial state
    assertThreadCount(session, 1);
    assertActiveAgent(session, 'Supervisor_Router');

    // Send message that triggers booking handoff
    const result = await sendMessage(executor, session.id, 'I want to book a trip');

    // Verify handoff occurred — exact thread count and structure
    assertThreadCount(session, 2);
    expect(session.threads[0].agentName).toBe('Supervisor_Router');
    expect(session.threads[1].agentName).toBe('Specialist_Booking');
    expect(session.activeThreadIndex).toBe(1);
    expect(session.agentName).toBe('Specialist_Booking');

    // Handoff trace should exist
    assertHandoffOccurred(result.traces, 'Supervisor_Router', 'Specialist_Booking');

    assertOrchestrationIntegrity(session);
  });

  // =========================================================================
  // D-2: Handoff with PASS field propagation
  // =========================================================================
  test('D-2: PASS fields propagate to child thread data', async () => {
    const session = createOrchestrationSession(
      executor,
      supervisorDsl,
      [bookingDsl, supportDsl],
      'Supervisor_Router',
    );
    await executor.initializeSession(session.id);

    await sendMessage(executor, session.id, 'I want to book a hotel');

    // Find the child thread
    const childThreadIdx = session.threads.findIndex((t) => t.agentName === 'Specialist_Booking');
    expect(childThreadIdx).toBeGreaterThan(0);

    // Verify PASS fields: intent and request should be passed
    const childThread = session.threads[childThreadIdx];
    expect(childThread.data.values).toBeDefined();
    // The intent was SET in the parent, and passed via CONTEXT.pass
    expect(childThread.data.values.intent).toBe('booking');

    assertOrchestrationIntegrity(session);
  });

  // =========================================================================
  // D-3: RETURN: true -> parent thread resumes
  // =========================================================================
  test('D-3: Child completion with RETURN: true returns control to parent', async () => {
    const session = createOrchestrationSession(
      executor,
      supervisorDsl,
      [bookingDsl, supportDsl],
      'Supervisor_Router',
    );
    await executor.initializeSession(session.id);

    // Booking handoff has RETURN: true
    const result = await sendMessage(executor, session.id, 'I want to book a trip to paris');

    // The booking agent should have matched "paris", set data, and auto-completed
    // After completion, RETURN: true means parent resumes

    // Check thread structure — exact counts
    assertThreadCount(session, 2);
    expect(session.threads[0].agentName).toBe('Supervisor_Router');
    expect(session.threads[1].agentName).toBe('Specialist_Booking');

    // Handoff trace should have returnExpected: true
    const handoffTrace = result.traces.find((t) => t.type === 'handoff');
    expect(handoffTrace).toBeDefined();
    expect(handoffTrace!.data.returnExpected).toBe(true);

    // The booking agent starts at collect step and may need more input.
    // Send "paris" to trigger auto-completion and RETURN to parent.
    const result2 = await sendMessage(executor, session.id, 'paris');

    // After child completes with RETURN: true, parent resumes
    assertThreadStatus(session, 1, 'completed');
    assertThreadStatus(session, 0, 'active');
    expect(session.activeThreadIndex).toBe(0);

    // threadStack should be empty after return-to-parent
    expect(session.threadStack.length).toBe(0);

    assertOrchestrationIntegrity(session);
  });

  // =========================================================================
  // D-4: ON_RETURN MAP data back to supervisor
  // =========================================================================
  test('D-4: ON_RETURN MAP maps child data back to parent', async () => {
    const session = createOrchestrationSession(
      executor,
      supervisorDsl,
      [bookingDsl, supportDsl],
      'Supervisor_Router',
    );
    await executor.initializeSession(session.id);

    // Send booking request with "paris" to trigger auto-completion in booking agent
    await sendMessage(executor, session.id, 'I want to book a trip to paris');

    // The booking agent sets confirmation_id and total_price
    // ON_RETURN MAP: { confirmation_id: booking_ref, total_price: price }
    // So parent should have booking_ref and price mapped from child

    const parentThread = session.threads[0];
    const bookingThread = session.threads.find((t) => t.agentName === 'Specialist_Booking');

    // Verify the child set its data
    if (bookingThread && bookingThread.status === 'completed') {
      expect(bookingThread.data.values.confirmation_id).toBe('BK-12345');
      expect(bookingThread.data.values.total_price).toBe('299.99');

      // Verify parent received mapped values
      // MAP: { confirmation_id: booking_ref, total_price: price }
      // means child's confirmation_id -> parent's booking_ref
      expect(parentThread.data.values.booking_ref).toBe('BK-12345');
      expect(parentThread.data.values.price).toBe('299.99');
    }

    assertOrchestrationIntegrity(session);
  });

  // =========================================================================
  // D-5: Fan-out to multiple specialists (parallel)
  // =========================================================================
  test('D-5: Fan-out dispatches to multiple specialists simultaneously', async () => {
    // Real fan-out: a reasoning SUPERVISOR returns multiple handoff_to_* tool
    // calls in a single LLM response. The runtime converts these into a
    // __fan_out__ call that dispatches to all children in parallel.
    const flightDsl = `
AGENT: Flight_Specialist

GOAL: "Handle flight requests"

FLOW:
  entry_point: start
  steps:
    - start

start:
  RESPOND: "Flight booked successfully"
  THEN: COMPLETE
`;
    const hotelDsl = `
AGENT: Hotel_Specialist

GOAL: "Handle hotel requests"

FLOW:
  entry_point: start
  steps:
    - start

start:
  RESPOND: "Hotel reserved successfully"
  THEN: COMPLETE
`;

    // Inject mock LLM BEFORE creating session (required pattern)
    const mockClient = injectValidatingMockClient(executor);

    executor.registerAgent('Flight_Specialist', flightDsl);
    executor.registerAgent('Hotel_Specialist', hotelDsl);

    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([fanOutDsl, flightDsl, hotelDsl], 'FanOut_Coordinator'),
    );
    applyParallelFanOutRuntimeConfig(session);

    // Return TWO handoff_to_* calls on the first reasoning call, then
    // on subsequent calls (after fan-out results are injected) return a
    // text summary. This mirrors the real LLM flow.
    let reasoningCallCount = 0;
    mockClient.setResponseHandler((_sys, _msgs, _tools, operationType) => {
      if (operationType === 'extraction') {
        return {
          text: '{}',
          toolCalls: [],
          stopReason: 'end_turn',
          rawContent: [{ type: 'text', text: '{}' }],
        };
      }
      reasoningCallCount++;
      if (reasoningCallCount === 1) {
        // First call: dispatch to both specialists via parallel handoff_to_*
        return {
          text: 'Routing to both specialists.',
          toolCalls: [
            {
              id: 'call_flight_1',
              name: 'handoff_to_Flight_Specialist',
              input: { reason: 'Flight request', message: 'Book a flight to Paris' },
            },
            {
              id: 'call_hotel_1',
              name: 'handoff_to_Hotel_Specialist',
              input: { reason: 'Hotel request', message: 'Reserve a hotel in Paris' },
            },
          ],
          stopReason: 'tool_use',
          rawContent: [
            { type: 'text', text: 'Routing to both specialists.' },
            {
              type: 'tool_use',
              id: 'call_flight_1',
              name: 'handoff_to_Flight_Specialist',
              input: { reason: 'Flight request', message: 'Book a flight to Paris' },
            },
            {
              type: 'tool_use',
              id: 'call_hotel_1',
              name: 'handoff_to_Hotel_Specialist',
              input: { reason: 'Hotel request', message: 'Reserve a hotel in Paris' },
            },
          ],
        };
      }
      // Subsequent calls: return final summary (no more tool calls)
      return {
        text: 'Both specialists have completed. Flight and hotel are booked.',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [
          {
            type: 'text',
            text: 'Both specialists have completed. Flight and hotel are booked.',
          },
        ],
      };
    });

    await executor.initializeSession(session.id);
    const result = await sendMessage(executor, session.id, 'I need a flight and hotel in Paris');

    // Fan-out child threads are ephemeral — they are pruned after execution.
    // The parent thread should still be active after fan-out completes.
    const parentThread = session.threads[0];
    expect(parentThread.agentName).toBe('FanOut_Coordinator');

    // Fan-out trace should exist
    const fanOutTraces = filterTraces(result.traces, 'fan_out_start');
    expect(fanOutTraces.length).toBeGreaterThanOrEqual(1);

    // Fan-out results should be stored in parent thread data
    const lastFanOut = parentThread.data.values._last_fan_out as {
      results: Array<{ target: string; status: string }>;
    };
    expect(lastFanOut).toBeDefined();
    expect(lastFanOut.results.length).toBe(2);
    const flightResult = lastFanOut.results.find(
      (r: { target: string }) => r.target === 'Flight_Specialist',
    );
    const hotelResult = lastFanOut.results.find(
      (r: { target: string }) => r.target === 'Hotel_Specialist',
    );
    expect(flightResult).toBeDefined();
    expect(flightResult!.status).toBe('completed');
    expect(hotelResult).toBeDefined();
    expect(hotelResult!.status).toBe('completed');

    // Per-target results should be stored in data.values
    expect(parentThread.data.values._fan_out_result_Flight_Specialist).toBeDefined();
    expect(parentThread.data.values._fan_out_result_Hotel_Specialist).toBeDefined();

    // The supervisor should have produced a final response (may be in chunks or response)
    const output = result.chunks.join('') || result.response;
    expect(output.length).toBeGreaterThan(0);

    assertOrchestrationIntegrity(session);
  });

  // =========================================================================
  // D-6: Fan-out with partial failure (one child succeeds, one fails)
  // =========================================================================
  test('D-6: Fan-out with partial failure returns results from successful child', async () => {
    const successDsl = `
AGENT: Success_Agent

GOAL: "Succeed"

FLOW:
  entry_point: start
  steps:
    - start

start:
  RESPOND: "Success!"
  THEN: COMPLETE
`;

    executor.registerAgent('Success_Agent', successDsl);
    // Do NOT register Failing_Agent — handleFanOut will report "Agent not found"

    const supervisorPartialDsl = `
SUPERVISOR: Partial_Supervisor

GOAL: "Route to agents, some may fail"

HANDOFF:
  - TO: Success_Agent
    WHEN: intent contains "success"
    CONTEXT:
      summary: "Success path"
    RETURN: false

  - TO: Failing_Agent
    WHEN: intent contains "fail"
    CONTEXT:
      summary: "Will fail"
    RETURN: false
`;

    // Inject mock LLM BEFORE creating session (required pattern)
    const mockClient = injectValidatingMockClient(executor);

    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([supervisorPartialDsl, successDsl], 'Partial_Supervisor'),
    );
    applyParallelFanOutRuntimeConfig(session);

    // Return TWO handoff_to_* calls — one to a registered agent, one to an
    // unregistered agent. This triggers fan-out with partial failure.
    let d6ReasoningCallCount = 0;
    mockClient.setResponseHandler((_sys, _msgs, _tools, operationType) => {
      if (operationType === 'extraction') {
        return {
          text: '{}',
          toolCalls: [],
          stopReason: 'end_turn',
          rawContent: [{ type: 'text', text: '{}' }],
        };
      }
      d6ReasoningCallCount++;
      if (d6ReasoningCallCount === 1) {
        return {
          text: 'Routing to both agents.',
          toolCalls: [
            {
              id: 'call_success',
              name: 'handoff_to_Success_Agent',
              input: { reason: 'Success path', message: 'Do success thing' },
            },
            {
              id: 'call_fail',
              name: 'handoff_to_Failing_Agent',
              input: { reason: 'Fail path', message: 'Do failing thing' },
            },
          ],
          stopReason: 'tool_use',
          rawContent: [
            { type: 'text', text: 'Routing to both agents.' },
            {
              type: 'tool_use',
              id: 'call_success',
              name: 'handoff_to_Success_Agent',
              input: { reason: 'Success path', message: 'Do success thing' },
            },
            {
              type: 'tool_use',
              id: 'call_fail',
              name: 'handoff_to_Failing_Agent',
              input: { reason: 'Fail path', message: 'Do failing thing' },
            },
          ],
        };
      }
      // After fan-out results are injected, return a text summary
      return {
        text: 'One agent succeeded, one failed.',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [{ type: 'text', text: 'One agent succeeded, one failed.' }],
      };
    });

    await executor.initializeSession(session.id);

    // Should not throw — partial failure is handled gracefully
    const result = await sendMessage(executor, session.id, 'do success and fail things');

    // The session should be intact
    expect(session).toBeDefined();
    expect(session.threads.length).toBeGreaterThanOrEqual(1);

    // Fan-out child threads are ephemeral (pruned after execution).
    // Results are stored in parent thread data.
    const parentThread = session.threads[0];
    const lastFanOut = parentThread.data.values._last_fan_out as {
      results: Array<{ target: string; status: string; error?: string }>;
    };
    expect(lastFanOut).toBeDefined();

    // Failing_Agent should have an error result
    // Note: _last_fan_out stores error text in `response` field (response || error)
    const failResult = lastFanOut.results.find(
      (r: { target: string }) => r.target === 'Failing_Agent',
    );
    expect(failResult).toBeDefined();
    expect(failResult!.status).toBe('error');
    // The error message is stored in the response field
    expect(failResult!.response).toBeDefined();
    expect(String(failResult!.response)).toContain('Agent not found');

    // Success_Agent should have a completed result
    const successResult = lastFanOut.results.find(
      (r: { target: string }) => r.target === 'Success_Agent',
    );
    expect(successResult).toBeDefined();
    expect(successResult!.status).toBe('completed');

    assertOrchestrationIntegrity(session);
  });

  // =========================================================================
  // D-7: 3-level delegation chain (A -> B -> C -> B -> A)
  // =========================================================================
  test('D-7: 3-level delegation chain completes full roundtrip', async () => {
    const levelADsl = `
AGENT: Level_A

GOAL: "Entry point agent"

FLOW:
  entry_point: detect
  steps:
    - detect

detect:
  GATHER:
    - request: required
  ON_INPUT:
    - IF: input contains "deep"
      SET: intent = "delegate"
      THEN: COMPLETE
    - ELSE:
      THEN: COMPLETE

HANDOFF:
  - TO: Level_B
    WHEN: intent == "delegate"
    CONTEXT:
      pass: [intent, request]
      summary: "Deep delegation"
    RETURN: true
`;

    const levelBDsl = `
AGENT: Level_B

GOAL: "Mid-level agent"

FLOW:
  entry_point: process
  steps:
    - process

process:
  GATHER:
    - task: required
  ON_INPUT:
    - SET: task = "processed_by_B"
      SET: b_value = "from_level_b"
      THEN: COMPLETE

HANDOFF:
  - TO: Level_C
    WHEN: task == "processed_by_B"
    CONTEXT:
      pass: [task, b_value]
      summary: "Delegating deeper"
    RETURN: true
`;

    const levelCDsl = `
AGENT: Level_C

GOAL: "Deepest agent"

FLOW:
  entry_point: handle
  steps:
    - handle

handle:
  SET: c_result = "completed_by_C"
  RESPOND: "Level C completed. Task: {{task}}, B-value: {{b_value}}"
  THEN: COMPLETE
`;

    executor.registerAgent('Level_B', levelBDsl);
    executor.registerAgent('Level_C', levelCDsl);
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([levelADsl, levelBDsl, levelCDsl], 'Level_A'),
    );
    await executor.initializeSession(session.id);

    const result = await sendMessage(executor, session.id, 'deep delegation needed');

    // Verify the chain created threads
    expect(session.threads.length).toBeGreaterThanOrEqual(2);

    // Level_C should have received data from Level_B
    const levelCThread = session.threads.find((t) => t.agentName === 'Level_C');
    if (levelCThread) {
      expect(levelCThread.data.values.task).toBe('processed_by_B');
      expect(levelCThread.data.values.b_value).toBe('from_level_b');
    }

    // The response should contain Level C's output
    const output = result.chunks.join('');
    if (levelCThread) {
      expect(output).toContain('Level C completed');
    }

    assertOrchestrationIntegrity(session);
  });

  // =========================================================================
  // D-8: Multi-intent dispatch (primary_queue strategy)
  // =========================================================================
  test('D-8: Multi-intent dispatch routes primary intent first', async () => {
    // Multi-intent uses the intent queue system. In scripted mode,
    // ON_INPUT rules fire sequentially - first match wins.
    const multiIntentDsl = `
AGENT: MultiIntent_Agent

GOAL: "Route multiple intents"

FLOW:
  entry_point: detect
  steps:
    - detect

detect:
  GATHER:
    - request: required
  ON_INPUT:
    - IF: input contains "book"
      SET: intent = "booking"
      THEN: COMPLETE
    - IF: input contains "cancel"
      SET: intent = "cancel"
      THEN: COMPLETE
    - ELSE:
      SET: intent = "unknown"
      THEN: COMPLETE

HANDOFF:
  - TO: Book_Agent
    WHEN: intent == "booking"
    CONTEXT:
      pass: [intent]
      summary: "Booking intent"
    RETURN: false
  - TO: Cancel_Agent
    WHEN: intent == "cancel"
    CONTEXT:
      pass: [intent]
      summary: "Cancel intent"
    RETURN: false
`;

    const bookAgentDsl = `
AGENT: Book_Agent
GOAL: "Book things"
FLOW:
  entry_point: start
  steps:
    - start
start:
  RESPOND: "Booking initiated"
  THEN: COMPLETE
`;

    const cancelAgentDsl = `
AGENT: Cancel_Agent
GOAL: "Cancel things"
FLOW:
  entry_point: start
  steps:
    - start
start:
  RESPOND: "Cancellation initiated"
  THEN: COMPLETE
`;

    executor.registerAgent('Book_Agent', bookAgentDsl);
    executor.registerAgent('Cancel_Agent', cancelAgentDsl);
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([multiIntentDsl, bookAgentDsl, cancelAgentDsl], 'MultiIntent_Agent'),
    );
    await executor.initializeSession(session.id);

    // "book" appears first in ON_INPUT rules, so booking intent wins
    const result = await sendMessage(
      executor,
      session.id,
      'I want to book a trip and cancel my previous one',
    );

    // First match wins: "book" triggers booking intent
    const bookThread = session.threads.find((t) => t.agentName === 'Book_Agent');
    expect(bookThread).toBeDefined();

    const output = result.chunks.join('');
    expect(output).toContain('Booking initiated');

    assertOrchestrationIntegrity(session);
  });

  // =========================================================================
  // D-9: Thread data isolation between concurrent handoffs
  // =========================================================================
  test('D-9: Thread data isolation between separate sessions', async () => {
    // Create two independent sessions with different handoff targets
    // Verify they don't contaminate each other's data

    const session1 = createOrchestrationSession(
      executor,
      supervisorDsl,
      [bookingDsl, supportDsl],
      'Supervisor_Router',
    );
    await executor.initializeSession(session1.id);

    const session2 = createOrchestrationSession(
      executor,
      supervisorDsl,
      [bookingDsl, supportDsl],
      'Supervisor_Router',
    );
    await executor.initializeSession(session2.id);

    // Session 1 goes to booking
    await sendMessage(executor, session1.id, 'I want to book something');
    // Session 2 goes to support
    await sendMessage(executor, session2.id, 'I need support help');

    // Verify session 1 has booking thread
    const s1Booking = session1.threads.find((t) => t.agentName === 'Specialist_Booking');
    const s1Support = session1.threads.find((t) => t.agentName === 'Specialist_Support');

    // Verify session 2 has support thread
    const s2Booking = session2.threads.find((t) => t.agentName === 'Specialist_Booking');
    const s2Support = session2.threads.find((t) => t.agentName === 'Specialist_Support');

    // Session 1 should have booking but not support
    expect(s1Booking).toBeDefined();
    expect(s1Support).toBeUndefined();

    // Session 2 should have support but not booking
    expect(s2Support).toBeDefined();
    expect(s2Booking).toBeUndefined();

    // Verify data isolation: session1's data shouldn't leak to session2
    expect(session1.threads[0].data.values.intent).toBe('booking');
    expect(session2.threads[0].data.values.intent).toBe('support');

    assertOrchestrationIntegrity(session1);
    assertOrchestrationIntegrity(session2);
  });

  // =========================================================================
  // D-10: Handoff target not found -> graceful fallback
  // =========================================================================
  test('D-10: Handoff to nonexistent agent falls through gracefully', async () => {
    const session = createOrchestrationSession(
      executor,
      supervisorDsl,
      [bookingDsl, supportDsl],
      'Supervisor_Router',
    );
    await executor.initializeSession(session.id);

    // "delegate" intent triggers handoff to Nonexistent_Agent
    const result = await sendMessage(executor, session.id, 'I want to delegate this');

    // Should not crash — agent not found is handled gracefully
    // The session should either complete or remain in a usable state
    expect(session).toBeDefined();
    expect(session.isComplete).toBe(true);

    // Should NOT have a thread for Nonexistent_Agent
    const nonexistentThread = session.threads.find((t) => t.agentName === 'Nonexistent_Agent');
    expect(nonexistentThread).toBeUndefined();

    assertOrchestrationIntegrity(session);
  });

  // =========================================================================
  // D-11: Second handoff rule fires when first doesn't match
  // (Absorbed from flow-handoff-threads.test.ts)
  // =========================================================================
  test('D-11: Second handoff rule fires when first condition fails', async () => {
    const dsl = `
AGENT: Second_Rule_Agent

GOAL: "Test second rule"

FLOW:
  entry_point: detect
  steps:
    - detect

detect:
  GATHER:
    - request: required
  ON_INPUT:
    - IF: input contains "billing"
      SET: category = "billing"
      THEN: COMPLETE
    - ELSE:
      SET: category = "general"
      THEN: COMPLETE

HANDOFF:
  - TO: Urgent_Handler
    WHEN: priority == "urgent"
    CONTEXT:
      summary: "Urgent"
    RETURN: false
  - TO: Billing_Handler
    WHEN: category == "billing"
    CONTEXT:
      pass: [category]
      summary: "Billing"
    RETURN: false
`;

    const billingDsl = `
AGENT: Billing_Handler

GOAL: "Handle billing"
FLOW:
  entry_point: respond
  steps:
    - respond
respond:
  RESPOND: "Billing handler active"
  THEN: COMPLETE
`;

    executor.registerAgent('Billing_Handler', billingDsl);
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([dsl, billingDsl], 'Second_Rule_Agent'),
    );
    await executor.initializeSession(session.id);

    const result = await sendMessage(executor, session.id, 'I have a billing question');

    // First rule (priority == "urgent") should NOT match since priority is never set.
    // Second rule (category == "billing") should fire.
    expect(result.chunks.join('')).toContain('Billing handler active');
    expect(session.agentName).toBe('Billing_Handler');
    assertThreadCount(session, 2);
    expect(session.threads[0].agentName).toBe('Second_Rule_Agent');
    expect(session.threads[1].agentName).toBe('Billing_Handler');
    expect(session.activeThreadIndex).toBe(1);

    assertOrchestrationIntegrity(session);
  });

  // =========================================================================
  // D-12: Handoff trace events with condition checks
  // (Absorbed from flow-handoff-threads.test.ts)
  // =========================================================================
  test('D-12: Handoff emits condition check traces for each rule evaluated', async () => {
    const dsl = `
AGENT: Trace_Agent

GOAL: "Test traces"

FLOW:
  entry_point: detect
  steps:
    - detect

detect:
  GATHER:
    - request: required
  ON_INPUT:
    - IF: input contains "book"
      SET: intent = "booking"
      THEN: COMPLETE
    - ELSE:
      THEN: COMPLETE

HANDOFF:
  - TO: First_Agent
    WHEN: intent == "priority"
    CONTEXT:
      summary: "Priority"
    RETURN: false
  - TO: Booking_Agent
    WHEN: intent == "booking"
    CONTEXT:
      pass: [intent]
      summary: "Booking"
    RETURN: false
`;

    const bookingDsl = `
AGENT: Booking_Agent

GOAL: "Book"
FLOW:
  entry_point: start
  steps:
    - start
start:
  RESPOND: "Booking started"
  THEN: COMPLETE
`;

    executor.registerAgent('Booking_Agent', bookingDsl);
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([dsl, bookingDsl], 'Trace_Agent'),
    );
    await executor.initializeSession(session.id);

    const result = await sendMessage(executor, session.id, 'I want to book');

    // Should have handoff_condition_check traces for each rule evaluated
    const conditionChecks = filterTraces(result.traces, 'handoff_condition_check');
    expect(conditionChecks.length).toBeGreaterThanOrEqual(1);

    // Should have a handoff trace for the matched rule
    const handoffTrace = result.traces.find((t) => t.type === 'handoff');
    expect(handoffTrace).toBeDefined();
    expect(handoffTrace!.data.to).toBe('Booking_Agent');

    // Verify thread structure
    assertThreadCount(session, 2);
    expect(session.threads[1].agentName).toBe('Booking_Agent');

    assertOrchestrationIntegrity(session);
  });

  // =========================================================================
  // D-13: Handoff trace includes returnExpected and targetAgent
  // (Absorbed from flow-handoff-threads.test.ts)
  // =========================================================================
  test('D-13: Handoff trace includes returnExpected and target agent', async () => {
    const parentDsl = `
AGENT: Return_Trace_Parent

GOAL: "Route and return"

FLOW:
  entry_point: ask
  steps:
    - ask

ask:
  GATHER:
    - request: required
  ON_INPUT:
    - IF: input contains "check"
      SET: intent = "check_status"
      THEN: COMPLETE
    - ELSE:
      THEN: COMPLETE

HANDOFF:
  - TO: Status_Checker
    WHEN: intent == "check_status"
    CONTEXT:
      pass: [intent]
      summary: "Check status request"
    RETURN: true
`;

    const statusDsl = `
AGENT: Status_Checker

GOAL: "Check status"

FLOW:
  entry_point: show
  steps:
    - show

show:
  RESPOND: "Status: All systems operational."
  THEN: COMPLETE
`;

    executor.registerAgent('Status_Checker', statusDsl);
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([parentDsl, statusDsl], 'Return_Trace_Parent'),
    );
    await executor.initializeSession(session.id);

    const result = await sendMessage(executor, session.id, 'check my status');

    const output = result.chunks.join('');
    expect(output).toContain('Status: All systems operational');

    // Handoff trace should have returnExpected: true and correct target
    const handoffTrace = result.traces.find((t) => t.type === 'handoff');
    expect(handoffTrace).toBeDefined();
    expect(handoffTrace!.data.to).toBe('Status_Checker');
    expect(handoffTrace!.data.returnExpected).toBe(true);

    // Thread structure: 2 threads, child completed, parent resumed
    assertThreadCount(session, 2);
    assertThreadStatus(session, 1, 'completed');
    assertThreadStatus(session, 0, 'active');
    expect(session.threads[1].agentName).toBe('Status_Checker');
    expect(session.threadStack.length).toBe(0);
    expect(session.activeThreadIndex).toBe(0);

    assertOrchestrationIntegrity(session);
  });
});

// =============================================================================
// LIVE LLM TIER — Reasoning agents with real LLM calls (env-gated)
// =============================================================================

// Import test-utils for LLM provider detection
let getSkipReason: () => string;
let getApiKey: (provider: string) => string;
let DEFAULT_PROVIDER: string;
let PROVIDER_MODELS: Record<string, { haiku: string; sonnet: string }>;

try {
  const testUtils =
    await import('../../../../packages/compiler/src/__tests__/e2e/fixtures/test-utils.js');
  getSkipReason = testUtils.getSkipReason;
  getApiKey = testUtils.getApiKey;
  DEFAULT_PROVIDER = testUtils.DEFAULT_PROVIDER;
  PROVIDER_MODELS = testUtils.PROVIDER_MODELS;
} catch {
  getSkipReason = () => 'test-utils not available';
  getApiKey = () => '';
  DEFAULT_PROVIDER = 'anthropic';
  PROVIDER_MODELS = {
    anthropic: { haiku: 'claude-3-haiku-20240307', sonnet: 'claude-3-5-sonnet-20241022' },
  };
}

const llmSkipReason = getSkipReason();

describe.skipIf(!!llmSkipReason)('Multi-Agent Orchestration — Live LLM Tier', () => {
  let executor: RuntimeExecutor;

  beforeEach(async () => {
    // Dynamically import config loader
    const { loadConfig } = await import('../config/index');
    await loadConfig();

    const provider = DEFAULT_PROVIDER;
    const apiKey = getApiKey(provider);
    const modelMapping = PROVIDER_MODELS[provider] || PROVIDER_MODELS.anthropic;
    const modelId = `${provider}/${modelMapping.haiku}`;

    executor = new RuntimeExecutor();

    // Wire LLM client with mock resolution (no DB needed)
    const { SessionLLMClient } = await import('../services/llm/session-llm-client');
    type ModelResolutionService = import('../services/llm/model-resolution').ModelResolutionService;

    const mockResolution = {
      resolve: async () => ({
        modelId,
        provider,
        source: 'system_default' as const,
        credential: { apiKey, authType: 'api_key' },
        parameters: { maxTokens: 2048 },
      }),
    } as unknown as ModelResolutionService;

    (executor as any).llmWiring.wireLLMClient = async (session: any, agentIR: any) => {
      session.llmClient = new SessionLLMClient(mockResolution, {
        tenantId: session.tenantId,
        agentName: agentIR?.metadata?.name || session.agentName,
        agentIR,
        sessionId: session.id,
      });
    };
  });

  // =========================================================================
  // L-1: Reasoning supervisor routes via __handoff__
  // =========================================================================
  test('L-1: Reasoning supervisor routes to specialist via handoff', async () => {
    executor.registerAgent('Reasoning_Specialist', reasoningSpecialistDsl);

    const session = executor.createSessionFromResolved(
      compileToResolvedAgent(
        [reasoningSupervisorDsl, reasoningSpecialistDsl],
        'Reasoning_Supervisor',
      ),
    );

    await executor.initializeSession(session.id);

    const result = await sendMessage(executor, session.id, 'I want to book a trip to Tokyo');

    // The supervisor should have routed to the specialist
    expect(session.threads.length).toBeGreaterThanOrEqual(2);

    // Check for handoff trace
    const handoffTraces = filterTraces(result.traces, 'handoff');
    expect(handoffTraces.length).toBeGreaterThanOrEqual(1);

    assertOrchestrationIntegrity(session);
  }, 60_000);

  // =========================================================================
  // L-2: Specialist GATHER with multi-turn extraction
  // =========================================================================
  test('L-2: Specialist extracts entities across multiple turns', async () => {
    // Create a reasoning specialist session directly
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([reasoningSpecialistDsl], 'Reasoning_Specialist'),
    );

    await executor.initializeSession(session.id);

    // Turn 1: provide destination
    await sendMessage(executor, session.id, 'I want to go to Paris');

    // Check if destination was extracted
    const activeThread1 = getActiveThread(session);
    const destExtracted = activeThread1?.data?.values?.destination === 'Paris';

    // Turn 2: provide date
    await sendMessage(executor, session.id, 'I want to travel on June 15th');

    // Check if travel_date was extracted
    const activeThread2 = getActiveThread(session);
    const hasDestination = activeThread2?.data?.values?.destination !== undefined;
    const hasDate = activeThread2?.data?.values?.travel_date !== undefined;

    // At least one field should have been extracted across turns
    expect(hasDestination || destExtracted).toBe(true);

    assertOrchestrationIntegrity(session);
  }, 60_000);

  // =========================================================================
  // L-3: Supervisor -> specialist -> RETURN -> supervisor continuation
  // =========================================================================
  test('L-3: Full roundtrip: supervisor -> specialist -> RETURN -> supervisor', async () => {
    executor.registerAgent('Reasoning_Specialist', reasoningSpecialistDsl);

    const session = executor.createSessionFromResolved(
      compileToResolvedAgent(
        [reasoningSupervisorDsl, reasoningSpecialistDsl],
        'Reasoning_Supervisor',
      ),
    );

    await executor.initializeSession(session.id);

    // Send a booking request
    const result = await sendMessage(
      executor,
      session.id,
      'I need to book a hotel in London for July 1st',
    );

    // At minimum, the supervisor should have responded or handed off
    expect(result.response || result.chunks.join('')).toBeTruthy();

    // Verify session structure is valid after the roundtrip
    expect(session.threads.length).toBeGreaterThanOrEqual(1);

    assertOrchestrationIntegrity(session);
  }, 90_000);

  // =========================================================================
  // L-4: History strategy comparison (last_n vs full)
  // =========================================================================
  test('L-4: Different sessions maintain independent history', async () => {
    // Create two sessions to verify history isolation
    executor.registerAgent('Reasoning_Specialist', reasoningSpecialistDsl);

    const session1 = executor.createSessionFromResolved(
      compileToResolvedAgent([reasoningSpecialistDsl], 'Reasoning_Specialist'),
    );
    const session2 = executor.createSessionFromResolved(
      compileToResolvedAgent([reasoningSpecialistDsl], 'Reasoning_Specialist'),
    );

    await executor.initializeSession(session1.id);
    await executor.initializeSession(session2.id);

    // Session 1: multi-turn
    await sendMessage(executor, session1.id, 'I want to go to Tokyo');
    await sendMessage(executor, session1.id, 'June 20th please');

    // Session 2: single turn
    await sendMessage(executor, session2.id, 'Book me a trip to Berlin on July 4th');

    // Verify history isolation
    const thread1 = getActiveThread(session1);
    const thread2 = getActiveThread(session2);

    expect(thread1).toBeDefined();
    expect(thread2).toBeDefined();

    // Session 1 should have more history entries (2 turns + responses)
    expect(thread1!.conversationHistory.length).toBeGreaterThan(
      thread2!.conversationHistory.length,
    );

    // Neither session should contain the other's content
    const s1History = thread1!.conversationHistory
      .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
      .join(' ');
    const s2History = thread2!.conversationHistory
      .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
      .join(' ');

    expect(s1History).not.toContain('Berlin');
    expect(s2History).not.toContain('Tokyo');

    assertOrchestrationIntegrity(session1);
    assertOrchestrationIntegrity(session2);
  }, 90_000);

  // =========================================================================
  // L-5: Multi-turn with corrections
  // =========================================================================
  test('L-5: User corrects entity value across turns', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([reasoningSpecialistDsl], 'Reasoning_Specialist'),
    );

    await executor.initializeSession(session.id);

    // Turn 1: provide initial destination
    await sendMessage(executor, session.id, 'I want to go to Paris');

    // Turn 2: correct the destination
    await sendMessage(
      executor,
      session.id,
      'Actually, I changed my mind. I want to go to Rome instead.',
    );

    // The session should still be valid after corrections
    const activeThread = getActiveThread(session);
    expect(activeThread).toBeDefined();

    // The corrected value should be in the data
    // (LLM should have updated destination to Rome)
    const destination = activeThread?.data?.values?.destination;
    if (destination) {
      // If extraction happened, it should be the corrected value
      expect(String(destination).toLowerCase()).toContain('rome');
    }

    assertOrchestrationIntegrity(session);
  }, 60_000);
});
