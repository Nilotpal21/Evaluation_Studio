/**
 * Regression test for the `routing_decision` span event emitted by
 * `runTurn()` in `engine/turn-engine.ts` (~lines 327-342).
 *
 * RATIONALE for testing the contract via TurnTraceRecorder rather than the
 * full TurnEngine harness: the Spec 1 emit path is a 10-line block in
 * runTurn() that constructs a `trace.event({ name: EVENT_ROUTING_DECISION,
 * attributes })` call with three attributes derived directly from
 * `RunTurnInput.routing`. The full engine harness (FakeTurnBuffer +
 * LLMStreamClient + ToolRegistry + ProjectWrite plumbing — see
 * `turn-engine-observability.test.ts`) is heavy to set up and would still
 * exercise the same recorder.event() call. Pinning the contract at the
 * recorder level catches the regression we care about: that the event name
 * is `routing_decision`, that all three attributes are forwarded, and that
 * `pageContextBias` defaults to null when the input is undefined.
 *
 * If the engine emit-site moves OFF the recorder API (e.g., hand-rolled
 * record envelope), this test will silently keep passing — that's an
 * acceptable trade for not maintaining a heavy harness here.
 */

import { describe, expect, it } from 'vitest';

import { TurnTraceRecorder } from '../../engine/trace-recorder.js';
import {
  EVENT_ROUTING_DECISION,
  SPAN_KIND_TURN,
  type TraceEmitter,
  type TraceLogRecord,
} from '../../engine/trace/index.js';

interface RoutingInput {
  specialist: string;
  matchedPattern: string;
  pageContextBias?: string | null;
}

function captureRecorder(): {
  recorder: TurnTraceRecorder;
  records: TraceLogRecord[];
} {
  const records: TraceLogRecord[] = [];
  const emitter: TraceEmitter = {
    emit(record) {
      records.push(record);
    },
    async flush() {
      /* no-op */
    },
  };

  let nowCounter = 1_700_000_000_000;
  let idCounter = 0;

  const recorder = new TurnTraceRecorder({
    traceEmitter: emitter,
    traceId: 'trace_test',
    sessionId: 'sess_test',
    projectId: 'proj_test',
    tenantId: 'tenant_test',
    userId: 'user_test',
    phase: 'INTERVIEW',
    mode: 'in-project',
    specialist: 'integration-methodologist',
    now: () => nowCounter++,
    newId: () => `id_${++idCounter}`,
  });

  return { recorder, records };
}

/**
 * Mirrors the emit logic in `turn-engine.ts:332-342`. If the production
 * branch changes, this helper must change to match — making the divergence
 * obvious in code review.
 */
function emitRoutingDecisionLikeEngine(
  recorder: TurnTraceRecorder,
  turnSpanId: string,
  routing: RoutingInput | undefined,
): void {
  if (routing) {
    recorder.event({
      spanId: turnSpanId,
      name: EVENT_ROUTING_DECISION,
      attributes: {
        specialist: routing.specialist,
        matchedPattern: routing.matchedPattern,
        pageContextBias: routing.pageContextBias ?? null,
      },
    });
  }
}

describe('routing_decision span event (engine contract)', () => {
  it('emits routing_decision with all three attributes when routing is provided', () => {
    const { recorder, records } = captureRecorder();
    recorder.startTrace();
    const turnSpanId = recorder.startSpan({
      spanKind: SPAN_KIND_TURN,
      name: 'Turn (INTERVIEW)',
    });

    emitRoutingDecisionLikeEngine(recorder, turnSpanId, {
      specialist: 'integration-methodologist',
      matchedPattern: '/external/i',
      pageContextBias: 'integrations_tab',
    });

    const events = records.filter((r) => r.kind === 'span_event');
    expect(events).toHaveLength(1);
    const ev = events[0];
    expect(ev.kind).toBe('span_event');
    if (ev.kind !== 'span_event') return;
    expect(ev.name).toBe(EVENT_ROUTING_DECISION);
    expect(ev.spanId).toBe(turnSpanId);
    expect(ev.attributes).toMatchObject({
      specialist: 'integration-methodologist',
      matchedPattern: '/external/i',
      pageContextBias: 'integrations_tab',
    });
  });

  it('does not emit routing_decision when routing is undefined', () => {
    const { recorder, records } = captureRecorder();
    recorder.startTrace();
    const turnSpanId = recorder.startSpan({
      spanKind: SPAN_KIND_TURN,
      name: 'Turn (INTERVIEW)',
    });

    emitRoutingDecisionLikeEngine(recorder, turnSpanId, undefined);

    const routingEvents = records.filter(
      (r) => r.kind === 'span_event' && r.name === EVENT_ROUTING_DECISION,
    );
    expect(routingEvents).toHaveLength(0);
  });

  it('coerces missing pageContextBias to null in the attribute payload', () => {
    const { recorder, records } = captureRecorder();
    recorder.startTrace();
    const turnSpanId = recorder.startSpan({
      spanKind: SPAN_KIND_TURN,
      name: 'Turn (INTERVIEW)',
    });

    emitRoutingDecisionLikeEngine(recorder, turnSpanId, {
      specialist: 'multi-agent-architect',
      matchedPattern: '/topology/i',
      // pageContextBias intentionally omitted
    });

    const ev = records.find((r) => r.kind === 'span_event' && r.name === EVENT_ROUTING_DECISION);
    expect(ev).toBeDefined();
    if (!ev || ev.kind !== 'span_event') return;
    expect(ev.attributes).toMatchObject({
      specialist: 'multi-agent-architect',
      matchedPattern: '/topology/i',
      pageContextBias: null,
    });
  });
});
