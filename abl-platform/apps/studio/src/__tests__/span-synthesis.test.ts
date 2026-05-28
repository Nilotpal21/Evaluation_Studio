/**
 * Span Synthesis Tests (T4.1–T4.8)
 *
 * Tests the synthesizeTurnSpans / getAgentName behavior inside
 * replayTraceEventsIntoObservatory by feeding crafted TraceEvent arrays
 * and inspecting the observatory store's spans and events afterward.
 *
 * synthesizeTurnSpans is a private function, so we exercise it indirectly
 * through the public replayTraceEventsIntoObservatory entry point.
 */

import { describe, test, expect, beforeEach } from 'vitest';
import { useObservatoryStore } from '../store/observatory-store';
import { replayTraceEventsIntoObservatory } from '../utils/replay-trace-events';
import type { TraceEvent } from '../types';

// =============================================================================
// HELPERS
// =============================================================================

const SESSION_ID = 'test-session-1';
let eventCounter = 0;

function makeTraceEvent(overrides: Partial<Record<string, unknown>> = {}): TraceEvent {
  eventCounter++;
  return {
    id: `evt-${eventCounter}`,
    type: 'llm_call',
    timestamp: new Date('2025-01-01T00:00:01.000Z'),
    data: {},
    sessionId: SESSION_ID,
    ...overrides,
  } as unknown as TraceEvent;
}

/**
 * After calling replayTraceEventsIntoObservatory, retrieve all events
 * that were added to the store. We read the store's events array.
 */
function getStoreEvents() {
  return useObservatoryStore.getState().events;
}

/**
 * Get all spans from the observatory store.
 */
function getStoreSpans() {
  return useObservatoryStore.getState().spans;
}

/**
 * Filter store events to only synthetic ones (those with IDs starting with 'synth-').
 */
function getSyntheticEvents() {
  return getStoreEvents().filter((e) => e.id.startsWith('synth-'));
}

/**
 * Filter store events to only synthetic agent_enter events.
 */
function getSyntheticEnterEvents() {
  return getStoreEvents().filter((e) => e.id.startsWith('synth-enter-'));
}

/**
 * Filter store events to only synthetic agent_exit events.
 */
function getSyntheticExitEvents() {
  return getStoreEvents().filter((e) => e.id.startsWith('synth-exit-'));
}

// =============================================================================
// TESTS
// =============================================================================

describe('Span Synthesis (synthesizeTurnSpans via replayTraceEventsIntoObservatory)', () => {
  beforeEach(() => {
    eventCounter = 0;
    const store = useObservatoryStore.getState();
    store.clearEvents();
    store.clearFlow();
    store.resetMetrics();
    store.clearLogs();
    store.clearExecutionState();
    store.clearAppExecutionState();
  });

  // ---------------------------------------------------------------------------
  // T4.1 — No lifecycle → all turns get synthetic spans
  // ---------------------------------------------------------------------------
  test('T4.1: no lifecycle events → all turns get synthetic agent_enter + agent_exit', () => {
    // 3 user_messages, 0 agent_enter/exit → 3 synthetic pairs
    const events: TraceEvent[] = [
      makeTraceEvent({
        id: 'um-1',
        type: 'user_message',
        timestamp: new Date('2025-01-01T00:00:01.000Z'),
        data: { text: 'hello' },
      }),
      makeTraceEvent({
        id: 'llm-1',
        type: 'llm_call',
        timestamp: new Date('2025-01-01T00:00:02.000Z'),
        data: { model: 'claude' },
      }),
      makeTraceEvent({
        id: 'um-2',
        type: 'user_message',
        timestamp: new Date('2025-01-01T00:00:03.000Z'),
        data: { text: 'second' },
      }),
      makeTraceEvent({
        id: 'llm-2',
        type: 'llm_call',
        timestamp: new Date('2025-01-01T00:00:04.000Z'),
        data: { model: 'claude' },
      }),
      makeTraceEvent({
        id: 'um-3',
        type: 'user_message',
        timestamp: new Date('2025-01-01T00:00:05.000Z'),
        data: { text: 'third' },
      }),
      makeTraceEvent({
        id: 'llm-3',
        type: 'llm_call',
        timestamp: new Date('2025-01-01T00:00:06.000Z'),
        data: { model: 'claude' },
      }),
    ];

    replayTraceEventsIntoObservatory(events, SESSION_ID);

    const syntheticEnters = getSyntheticEnterEvents();
    const syntheticExits = getSyntheticExitEvents();

    expect(syntheticEnters).toHaveLength(3);
    expect(syntheticExits).toHaveLength(3);

    // Each turn should have a span created in the store
    const spans = getStoreSpans();
    expect(spans.has('synth-span-turn-1')).toBe(true);
    expect(spans.has('synth-span-turn-2')).toBe(true);
    expect(spans.has('synth-span-turn-3')).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // T4.2 — All turns have real lifecycle → no synthetic injected
  // ---------------------------------------------------------------------------
  test('T4.2: all turns have real agent_enter/exit → 0 synthetic events', () => {
    // synthesizeTurnSpans determines turn boundaries at user_message positions.
    // An agent_enter/exit is attributed to the turn whose user_message boundary
    // it falls at or after. So lifecycle events must appear AFTER the user_message
    // in sorted order (or at the same turn boundary position) to be counted.
    const events: TraceEvent[] = [
      // Turn 1
      makeTraceEvent({
        id: 'um-1',
        type: 'user_message',
        timestamp: new Date('2025-01-01T00:00:01.000Z'),
        data: { text: 'hello' },
      }),
      makeTraceEvent({
        id: 'ae-1',
        type: 'agent_enter',
        timestamp: new Date('2025-01-01T00:00:01.100Z'),
        spanId: 'real-span-1',
        data: { agentName: 'AgentA' },
      }),
      makeTraceEvent({
        id: 'llm-1',
        type: 'llm_call',
        timestamp: new Date('2025-01-01T00:00:02.000Z'),
        data: { model: 'claude' },
      }),
      makeTraceEvent({
        id: 'ax-1',
        type: 'agent_exit',
        timestamp: new Date('2025-01-01T00:00:02.500Z'),
        spanId: 'real-span-1',
        data: { result: 'completed' },
      }),
      // Turn 2
      makeTraceEvent({
        id: 'um-2',
        type: 'user_message',
        timestamp: new Date('2025-01-01T00:00:03.000Z'),
        data: { text: 'second' },
      }),
      makeTraceEvent({
        id: 'ae-2',
        type: 'agent_enter',
        timestamp: new Date('2025-01-01T00:00:03.100Z'),
        spanId: 'real-span-2',
        data: { agentName: 'AgentA' },
      }),
      makeTraceEvent({
        id: 'llm-2',
        type: 'llm_call',
        timestamp: new Date('2025-01-01T00:00:04.000Z'),
        data: { model: 'claude' },
      }),
      makeTraceEvent({
        id: 'ax-2',
        type: 'agent_exit',
        timestamp: new Date('2025-01-01T00:00:04.500Z'),
        spanId: 'real-span-2',
        data: { result: 'completed' },
      }),
      // Turn 3
      makeTraceEvent({
        id: 'um-3',
        type: 'user_message',
        timestamp: new Date('2025-01-01T00:00:05.000Z'),
        data: { text: 'third' },
      }),
      makeTraceEvent({
        id: 'ae-3',
        type: 'agent_enter',
        timestamp: new Date('2025-01-01T00:00:05.100Z'),
        spanId: 'real-span-3',
        data: { agentName: 'AgentA' },
      }),
      makeTraceEvent({
        id: 'llm-3',
        type: 'llm_call',
        timestamp: new Date('2025-01-01T00:00:06.000Z'),
        data: { model: 'claude' },
      }),
      makeTraceEvent({
        id: 'ax-3',
        type: 'agent_exit',
        timestamp: new Date('2025-01-01T00:00:06.500Z'),
        spanId: 'real-span-3',
        data: { result: 'completed' },
      }),
    ];

    replayTraceEventsIntoObservatory(events, SESSION_ID);

    const syntheticEnters = getSyntheticEnterEvents();
    const syntheticExits = getSyntheticExitEvents();

    expect(syntheticEnters).toHaveLength(0);
    expect(syntheticExits).toHaveLength(0);

    // Real spans should exist
    const spans = getStoreSpans();
    expect(spans.has('real-span-1')).toBe(true);
    expect(spans.has('real-span-2')).toBe(true);
    expect(spans.has('real-span-3')).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // T4.3 — Partial lifecycle → only missing turns get synthetic
  // ---------------------------------------------------------------------------
  test('T4.3: 5 turns, 2 with real lifecycle → 3 synthetic pairs, 2 turns untouched', () => {
    // Lifecycle events are placed AFTER their turn's user_message so
    // synthesizeTurnSpans attributes them to the correct turn.
    const events: TraceEvent[] = [
      // Turn 1 — has real lifecycle (after user_message)
      makeTraceEvent({
        id: 'um-1',
        type: 'user_message',
        timestamp: new Date('2025-01-01T00:00:01.000Z'),
        data: { text: 'hello' },
      }),
      makeTraceEvent({
        id: 'ae-1',
        type: 'agent_enter',
        timestamp: new Date('2025-01-01T00:00:01.100Z'),
        spanId: 'real-span-1',
        data: { agentName: 'AgentA' },
      }),
      makeTraceEvent({
        id: 'llm-1',
        type: 'llm_call',
        timestamp: new Date('2025-01-01T00:00:02.000Z'),
      }),
      makeTraceEvent({
        id: 'ax-1',
        type: 'agent_exit',
        timestamp: new Date('2025-01-01T00:00:02.500Z'),
        spanId: 'real-span-1',
        data: { result: 'completed' },
      }),
      // Turn 2 — NO lifecycle
      makeTraceEvent({
        id: 'um-2',
        type: 'user_message',
        timestamp: new Date('2025-01-01T00:00:03.000Z'),
        data: { text: 'second' },
      }),
      makeTraceEvent({
        id: 'llm-2',
        type: 'llm_call',
        timestamp: new Date('2025-01-01T00:00:04.000Z'),
      }),
      // Turn 3 — NO lifecycle
      makeTraceEvent({
        id: 'um-3',
        type: 'user_message',
        timestamp: new Date('2025-01-01T00:00:05.000Z'),
        data: { text: 'third' },
      }),
      makeTraceEvent({
        id: 'llm-3',
        type: 'llm_call',
        timestamp: new Date('2025-01-01T00:00:06.000Z'),
      }),
      // Turn 4 — has real lifecycle (after user_message)
      makeTraceEvent({
        id: 'um-4',
        type: 'user_message',
        timestamp: new Date('2025-01-01T00:00:07.000Z'),
        data: { text: 'fourth' },
      }),
      makeTraceEvent({
        id: 'ae-4',
        type: 'agent_enter',
        timestamp: new Date('2025-01-01T00:00:07.100Z'),
        spanId: 'real-span-4',
        data: { agentName: 'AgentA' },
      }),
      makeTraceEvent({
        id: 'llm-4',
        type: 'llm_call',
        timestamp: new Date('2025-01-01T00:00:08.000Z'),
      }),
      makeTraceEvent({
        id: 'ax-4',
        type: 'agent_exit',
        timestamp: new Date('2025-01-01T00:00:08.500Z'),
        spanId: 'real-span-4',
        data: { result: 'completed' },
      }),
      // Turn 5 — NO lifecycle
      makeTraceEvent({
        id: 'um-5',
        type: 'user_message',
        timestamp: new Date('2025-01-01T00:00:09.000Z'),
        data: { text: 'fifth' },
      }),
      makeTraceEvent({
        id: 'llm-5',
        type: 'llm_call',
        timestamp: new Date('2025-01-01T00:00:10.000Z'),
      }),
    ];

    replayTraceEventsIntoObservatory(events, SESSION_ID);

    const syntheticEnters = getSyntheticEnterEvents();
    const syntheticExits = getSyntheticExitEvents();

    // Turns 2, 3, 5 are missing lifecycle → 3 synthetic enter + 3 synthetic exit
    expect(syntheticEnters).toHaveLength(3);
    expect(syntheticExits).toHaveLength(3);

    // Real spans should exist for turns 1 and 4
    const spans = getStoreSpans();
    expect(spans.has('real-span-1')).toBe(true);
    expect(spans.has('real-span-4')).toBe(true);

    // Synthetic spans should exist for turns 2, 3, 5
    expect(spans.has('synth-span-turn-2')).toBe(true);
    expect(spans.has('synth-span-turn-3')).toBe(true);
    expect(spans.has('synth-span-turn-5')).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // T4.4 — Synthetic agent_enter is -1ms before user_message
  // ---------------------------------------------------------------------------
  test('T4.4: synthetic agent_enter timestamp is -1ms before user_message', () => {
    const userMsgTimestamp = new Date('2025-01-01T00:00:01.000Z');

    const events: TraceEvent[] = [
      makeTraceEvent({
        id: 'um-1',
        type: 'user_message',
        timestamp: userMsgTimestamp,
        data: { text: 'hello' },
      }),
      makeTraceEvent({
        id: 'llm-1',
        type: 'llm_call',
        timestamp: new Date('2025-01-01T00:00:02.000Z'),
      }),
    ];

    replayTraceEventsIntoObservatory(events, SESSION_ID);

    const syntheticEnters = getSyntheticEnterEvents();
    expect(syntheticEnters).toHaveLength(1);

    // The synthetic agent_enter should be at T=999 (userMsg.getTime() - 1)
    const enterTimestamp = syntheticEnters[0].timestamp;
    const expectedTimestamp = new Date(userMsgTimestamp.getTime() - 1);
    expect(enterTimestamp.getTime()).toBe(expectedTimestamp.getTime());
  });

  // ---------------------------------------------------------------------------
  // T4.5 — Synthetic agent_exit is +1ms after last event in turn
  // ---------------------------------------------------------------------------
  test('T4.5: synthetic agent_exit timestamp is +1ms after last event in turn', () => {
    const lastEventTimestamp = new Date('2025-01-01T00:00:02.000Z');

    const events: TraceEvent[] = [
      makeTraceEvent({
        id: 'um-1',
        type: 'user_message',
        timestamp: new Date('2025-01-01T00:00:01.000Z'),
        data: { text: 'hello' },
      }),
      makeTraceEvent({
        id: 'llm-1',
        type: 'llm_call',
        timestamp: lastEventTimestamp,
        data: { model: 'claude' },
      }),
    ];

    replayTraceEventsIntoObservatory(events, SESSION_ID);

    const syntheticExits = getSyntheticExitEvents();
    expect(syntheticExits).toHaveLength(1);

    // The synthetic agent_exit should be at lastEventTimestamp + 1ms
    const exitTimestamp = syntheticExits[0].timestamp;
    const expectedTimestamp = new Date(lastEventTimestamp.getTime() + 1);
    expect(exitTimestamp.getTime()).toBe(expectedTimestamp.getTime());
  });

  // ---------------------------------------------------------------------------
  // T4.6 — Real events keep original spanIds (not overwritten)
  // ---------------------------------------------------------------------------
  test('T4.6: events with existing spanIds in turns with real lifecycle keep original spanIds', () => {
    // Lifecycle events placed after user_message so they fall in the same turn
    const events: TraceEvent[] = [
      // Turn 1 — real lifecycle with custom spanIds on all events
      makeTraceEvent({
        id: 'um-1',
        type: 'user_message',
        timestamp: new Date('2025-01-01T00:00:01.000Z'),
        spanId: 'custom-span-msg',
        data: { text: 'hello' },
      }),
      makeTraceEvent({
        id: 'ae-1',
        type: 'agent_enter',
        timestamp: new Date('2025-01-01T00:00:01.100Z'),
        spanId: 'real-span-1',
        data: { agentName: 'AgentA' },
      }),
      makeTraceEvent({
        id: 'llm-1',
        type: 'llm_call',
        timestamp: new Date('2025-01-01T00:00:02.000Z'),
        spanId: 'custom-span-llm',
        data: { model: 'claude' },
      }),
      makeTraceEvent({
        id: 'ax-1',
        type: 'agent_exit',
        timestamp: new Date('2025-01-01T00:00:02.500Z'),
        spanId: 'real-span-1',
        data: { result: 'completed' },
      }),
    ];

    replayTraceEventsIntoObservatory(events, SESSION_ID);

    // Find the events in the store and verify their spanIds are preserved
    const storeEvents = getStoreEvents();

    // The user_message event should keep its custom-span-msg spanId
    const userMsgEvent = storeEvents.find((e) => e.id === 'um-1');
    expect(userMsgEvent).toBeDefined();
    expect(userMsgEvent!.spanId).toBe('custom-span-msg');

    // The llm_call event should keep its custom-span-llm spanId
    const llmEvent = storeEvents.find((e) => e.id === 'llm-1');
    expect(llmEvent).toBeDefined();
    expect(llmEvent!.spanId).toBe('custom-span-llm');

    // No synthetic events should exist
    const syntheticEvents = getSyntheticEvents();
    expect(syntheticEvents).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // T4.7 — agentName extracted safely via helper (tested indirectly)
  // ---------------------------------------------------------------------------
  test('T4.7: agentName extraction — from data.agentName, data.agent, or fallback to unknown', () => {
    // Events with agentName on data, on root, or missing
    const events: TraceEvent[] = [
      // Turn 1 — agentName in data.agentName
      makeTraceEvent({
        id: 'um-1',
        type: 'user_message',
        timestamp: new Date('2025-01-01T00:00:01.000Z'),
        data: { agentName: 'AgentFromData', text: 'hello' },
      }),
      makeTraceEvent({
        id: 'llm-1',
        type: 'llm_call',
        timestamp: new Date('2025-01-01T00:00:02.000Z'),
        data: { agentName: 'AgentFromData' },
      }),
      // Turn 2 — agentName in data.agent
      makeTraceEvent({
        id: 'um-2',
        type: 'user_message',
        timestamp: new Date('2025-01-01T00:00:03.000Z'),
        data: { agent: 'AgentFromAgent', text: 'second' },
      }),
      makeTraceEvent({
        id: 'llm-2',
        type: 'llm_call',
        timestamp: new Date('2025-01-01T00:00:04.000Z'),
        data: { agent: 'AgentFromAgent' },
      }),
      // Turn 3 — no agentName → should fall back to 'unknown'
      makeTraceEvent({
        id: 'um-3',
        type: 'user_message',
        timestamp: new Date('2025-01-01T00:00:05.000Z'),
        data: { text: 'third' },
      }),
      makeTraceEvent({
        id: 'llm-3',
        type: 'llm_call',
        timestamp: new Date('2025-01-01T00:00:06.000Z'),
      }),
    ];

    // Should NOT throw — verifying safe extraction
    replayTraceEventsIntoObservatory(events, SESSION_ID);

    // 3 turns with no lifecycle → 3 synthetic enter + 3 synthetic exit
    const syntheticEnters = getSyntheticEnterEvents();
    expect(syntheticEnters).toHaveLength(3);

    // Verify agent names in synthetic events via the store
    // Turn 1 synthetic enter should carry 'AgentFromData'
    const enter1 = syntheticEnters.find((e) => e.id === 'synth-enter-1');
    expect(enter1).toBeDefined();
    expect(enter1!.agentName).toBe('AgentFromData');

    // Turn 2 synthetic enter should carry 'AgentFromAgent'
    const enter2 = syntheticEnters.find((e) => e.id === 'synth-enter-2');
    expect(enter2).toBeDefined();
    expect(enter2!.agentName).toBe('AgentFromAgent');

    // Turn 3 synthetic enter should carry 'unknown' (fallback)
    const enter3 = syntheticEnters.find((e) => e.id === 'synth-enter-3');
    expect(enter3).toBeDefined();
    expect(enter3!.agentName).toBe('unknown');
  });

  // ---------------------------------------------------------------------------
  // T4.8 — Single-turn session gets one span
  // ---------------------------------------------------------------------------
  test('T4.8: 1 user_message + 2 llm_call events → 1 synthetic enter + 1 synthetic exit', () => {
    const events: TraceEvent[] = [
      makeTraceEvent({
        id: 'um-1',
        type: 'user_message',
        timestamp: new Date('2025-01-01T00:00:01.000Z'),
        data: { text: 'hello' },
      }),
      makeTraceEvent({
        id: 'llm-1',
        type: 'llm_call',
        timestamp: new Date('2025-01-01T00:00:02.000Z'),
        data: { model: 'claude' },
      }),
      makeTraceEvent({
        id: 'llm-2',
        type: 'llm_call',
        timestamp: new Date('2025-01-01T00:00:03.000Z'),
        data: { model: 'claude' },
      }),
    ];

    replayTraceEventsIntoObservatory(events, SESSION_ID);

    const syntheticEnters = getSyntheticEnterEvents();
    const syntheticExits = getSyntheticExitEvents();

    expect(syntheticEnters).toHaveLength(1);
    expect(syntheticExits).toHaveLength(1);

    // A single span should be created
    const spans = getStoreSpans();
    expect(spans.has('synth-span-turn-1')).toBe(true);

    // No other synthetic spans should exist
    const synthSpanIds = [...spans.keys()].filter((k) => k.startsWith('synth-'));
    expect(synthSpanIds).toHaveLength(1);
  });
});
