import { describe, expect, it } from 'vitest';
import type { PlatformEvent } from '../schema/platform-event.js';
import { ClickHouseRowMapper } from '../stores/clickhouse/clickhouse-row-mapper.js';

function makeEvent(overrides: Partial<PlatformEvent> = {}): PlatformEvent {
  return {
    event_id: 'evt-1',
    event_type: 'message.user.received',
    category: 'message',
    tenant_id: 'tenant-1',
    project_id: 'project-1',
    session_id: 'session-1',
    timestamp: new Date('2026-05-11T00:00:00.000Z'),
    data: {},
    ...overrides,
  };
}

describe('ClickHouseRowMapper known_source', () => {
  it('defaults production when no source is present', () => {
    const mapper = new ClickHouseRowMapper();

    expect(mapper.toRow(makeEvent()).known_source).toBe('production');
  });

  it.each(['eval', 'synthetic', 'production'] as const)(
    'writes top-level known_source=%s',
    (knownSource) => {
      const mapper = new ClickHouseRowMapper();

      expect(mapper.toRow(makeEvent({ known_source: knownSource })).known_source).toBe(knownSource);
    },
  );

  it('falls back to legacy custom_dimensions known_source', () => {
    const mapper = new ClickHouseRowMapper();

    expect(
      mapper.toRow(
        makeEvent({
          metadata: { custom_dimensions: { known_source: 'eval' } },
        }),
      ).known_source,
    ).toBe('eval');
  });

  it('hydrates known_source from ClickHouse rows', () => {
    const mapper = new ClickHouseRowMapper();
    const row = mapper.toRow(makeEvent({ known_source: 'synthetic' }));

    expect(mapper.fromRow(row).known_source).toBe('synthetic');
  });

  it('round-trips dedicated causal columns', () => {
    const mapper = new ClickHouseRowMapper();
    const row = mapper.toRow(
      makeEvent({
        turn_id: 'turn-1',
        execution_id: 'exec-1',
        parent_execution_id: 'exec-parent',
        agent_run_id: 'agent-run-1',
        decision_id: 'decision-1',
        parent_decision_id: 'decision-parent',
        cause_event_id: 'evt-cause',
        phase: 'llm',
        reason_code: 'llm_call',
      }),
    );

    expect(row).toMatchObject({
      turn_id: 'turn-1',
      execution_id: 'exec-1',
      parent_execution_id: 'exec-parent',
      agent_run_id: 'agent-run-1',
      decision_id: 'decision-1',
      parent_decision_id: 'decision-parent',
      cause_event_id: 'evt-cause',
      phase: 'llm',
      reason_code: 'llm_call',
    });
    expect(mapper.fromRow(row)).toMatchObject({
      turn_id: 'turn-1',
      execution_id: 'exec-1',
      parent_execution_id: 'exec-parent',
      agent_run_id: 'agent-run-1',
      decision_id: 'decision-1',
      parent_decision_id: 'decision-parent',
      cause_event_id: 'evt-cause',
      phase: 'llm',
      reason_code: 'llm_call',
    });
  });
});
