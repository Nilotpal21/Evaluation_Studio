import { describe, expect, it } from 'vitest';

import {
  inferSessionSelector,
  parseDiagnosisTimeRange,
  resolveTraceDiagnosisInput,
} from '../../lib/arch-ai/tools/trace-diagnosis-resolver';

const NOW = new Date('2026-04-21T12:00:00.000Z');

describe('trace diagnosis resolver', () => {
  it('parses numeric relative hour windows', () => {
    const range = parseDiagnosisTimeRange({ timeRange: 'last 24 hours' }, NOW);

    expect(range).toEqual({
      from: '2026-04-20T12:00:00.000Z',
      to: '2026-04-21T12:00:00.000Z',
      label: 'last 24 hours',
      source: 'relative',
    });
  });

  it('parses word-based day windows from the user query', () => {
    const range = parseDiagnosisTimeRange({ query: 'show me failures from two days' }, NOW);

    expect(range).toEqual({
      from: '2026-04-19T12:00:00.000Z',
      to: '2026-04-21T12:00:00.000Z',
      label: 'last 2 days',
      source: 'relative',
    });
  });

  it('parses today as a bounded relative window', () => {
    const range = parseDiagnosisTimeRange({ query: 'why are sessions failing today?' }, NOW);
    const localStartOfDay = new Date(NOW);
    localStartOfDay.setHours(0, 0, 0, 0);

    expect(range).toEqual({
      from: localStartOfDay.toISOString(),
      to: '2026-04-21T12:00:00.000Z',
      label: 'today',
      source: 'relative',
    });
  });

  it('parses today using the provided IANA timezone', () => {
    const range = parseDiagnosisTimeRange(
      { query: 'why are sessions failing today?' },
      NOW,
      'America/Los_Angeles',
    );

    expect(range).toEqual({
      from: '2026-04-21T07:00:00.000Z',
      to: '2026-04-21T12:00:00.000Z',
      label: 'today',
      source: 'relative',
    });
  });

  it('uses the local month in the provided timezone for last month', () => {
    const range = parseDiagnosisTimeRange(
      { query: 'show me failures from last month' },
      new Date('2026-04-01T01:00:00.000Z'),
      'America/Los_Angeles',
    );

    expect(range).toEqual({
      from: '2026-02-01T08:00:00.000Z',
      to: '2026-03-01T07:59:59.999Z',
      label: 'last month',
      source: 'relative',
    });
  });

  it('uses explicit timestamps when present', () => {
    const range = parseDiagnosisTimeRange(
      {
        from: '2026-04-01T00:00:00.000Z',
        to: '2026-04-10T00:00:00.000Z',
      },
      NOW,
    );

    expect(range).toEqual({
      from: '2026-04-01T00:00:00.000Z',
      to: '2026-04-10T00:00:00.000Z',
      label: 'explicit window',
      source: 'explicit',
    });
  });

  it('resolves current-session references from page context', () => {
    const selection = inferSessionSelector({
      action: 'deep_dive',
      query: 'what went wrong in this session?',
      pageContext: {
        area: 'project',
        page: 'sessions',
        entity: { type: 'session', id: 'sess-123', name: 'sess-123' },
      },
    });

    expect(selection).toEqual({
      sessionSelector: 'current',
      pageContextSessionId: 'sess-123',
    });
  });

  it('inherits the current agent from page context and infers mine for my last session', () => {
    const resolved = resolveTraceDiagnosisInput(
      {
        action: 'deep_dive',
        query: 'show me my last session',
      },
      {
        area: 'project',
        page: 'agents',
        entity: { type: 'agent', id: 'Billing_Agent', name: 'Billing_Agent' },
      },
      NOW,
    );

    expect(resolved.agentName).toBe('Billing_Agent');
    expect(resolved.mine).toBe(true);
    expect(resolved.sessionSelector).toBe('last');
    expect(resolved.limit).toBe(20);
  });

  it('uses page-context timezone when resolving calendar ranges', () => {
    const resolved = resolveTraceDiagnosisInput(
      {
        action: 'errors',
        query: 'show me failures today',
      },
      {
        area: 'project',
        page: 'dashboard',
        timeZone: 'America/Los_Angeles',
      },
      NOW,
    );

    expect(resolved.timeRange).toEqual({
      from: '2026-04-21T07:00:00.000Z',
      to: '2026-04-21T12:00:00.000Z',
      label: 'today',
      source: 'relative',
    });
  });

  it('infers a single environment filter from natural language', () => {
    const resolved = resolveTraceDiagnosisInput(
      {
        action: 'aggregate',
        query: 'show me production health for the last 24 hours',
      },
      undefined,
      NOW,
    );

    expect(resolved.environment).toBe('production');
    expect(resolved.compareWithEnvironment).toBeUndefined();
    expect(resolved.groupByEnvironment).toBeUndefined();
  });

  it('infers environment-vs-environment comparison from natural language', () => {
    const resolved = resolveTraceDiagnosisInput(
      {
        action: 'compare',
        query: 'compare staging vs prod for the last 7 days',
      },
      undefined,
      NOW,
    );

    expect(resolved.environment).toBe('staging');
    expect(resolved.compareWithEnvironment).toBe('production');
    expect(resolved.groupByEnvironment).toBeUndefined();
  });

  it('infers today-vs-yesterday time-window comparisons from natural language', () => {
    const resolved = resolveTraceDiagnosisInput(
      {
        action: 'compare',
        query: 'compare today vs yesterday for Billing_Agent',
        agentName: 'Billing_Agent',
      },
      {
        area: 'project',
        page: 'sessions',
        timeZone: 'America/Los_Angeles',
      },
      NOW,
    );

    expect(resolved.timeRange).toEqual({
      from: '2026-04-21T07:00:00.000Z',
      to: '2026-04-21T12:00:00.000Z',
      label: 'today',
      source: 'relative',
    });
    expect(resolved.compareTimeRange).toEqual({
      from: '2026-04-20T07:00:00.000Z',
      to: '2026-04-21T06:59:59.999Z',
      label: 'yesterday',
      source: 'relative',
    });
  });

  it('preserves requested ordering for yesterday-vs-today comparisons', () => {
    const resolved = resolveTraceDiagnosisInput(
      {
        action: 'compare',
        query: 'compare yesterday versus today',
      },
      {
        area: 'project',
        page: 'sessions',
        timeZone: 'America/Los_Angeles',
      },
      NOW,
    );

    expect(resolved.timeRange?.label).toBe('yesterday');
    expect(resolved.compareTimeRange?.label).toBe('today');
  });

  it('resolves an explicit comparison time window', () => {
    const resolved = resolveTraceDiagnosisInput(
      {
        action: 'compare',
        timeRange: 'last 24 hours',
        compareWithTimeRange: 'last week',
      },
      undefined,
      NOW,
    );

    expect(resolved.timeRange?.label).toBe('last 24 hours');
    expect(resolved.compareTimeRange?.label).toBe('last week');
  });

  it('groups by environment when the user asks across environments', () => {
    const resolved = resolveTraceDiagnosisInput(
      {
        action: 'errors',
        query: 'show me recent failures across environments',
      },
      undefined,
      NOW,
    );

    expect(resolved.environment).toBeUndefined();
    expect(resolved.compareWithEnvironment).toBeUndefined();
    expect(resolved.groupByEnvironment).toBe(true);
  });

  it('normalizes explicit environment inputs', () => {
    const resolved = resolveTraceDiagnosisInput(
      {
        action: 'aggregate',
        environment: 'Prod',
        compareWithEnvironment: 'stage',
      },
      undefined,
      NOW,
    );

    expect(resolved.environment).toBe('production');
    expect(resolved.compareWithEnvironment).toBe('staging');
  });
});
