import { describe, expect, it } from 'vitest';
import { buildAuthLifecycleTraceEvent } from '../../services/auth-profile/auth-trace-events.js';

describe('buildAuthLifecycleTraceEvent', () => {
  const pendingRequirement = {
    connector: 'google',
    authProfileRef: 'google-creds',
    connectionMode: 'per_user' as const,
    requirementKey: 'google:user',
  };

  const satisfiedRequirement = {
    connector: 'salesforce',
    authProfileRef: 'salesforce-creds',
    connectionMode: 'shared' as const,
    requirementKey: 'salesforce:shared',
  };

  it('builds a preflight_required trace with canonical auth code', () => {
    const event = buildAuthLifecycleTraceEvent({
      sessionId: 'runtime-session-1',
      decision: 'preflight_required',
      pending: [pendingRequirement],
      satisfied: [],
      traceId: 'trace-1',
      agentName: 'TravelDesk_Supervisor',
    });

    expect(event.type).toBe('decision');
    expect(event.sessionId).toBe('runtime-session-1');
    expect(event.traceId).toBe('trace-1');
    expect(event.agentName).toBe('TravelDesk_Supervisor');
    expect(event.data).toEqual(
      expect.objectContaining({
        source: 'auth_contract',
        category: 'auth',
        code: 'AUTH_PREFLIGHT_REQUIRED',
        decisionKind: 'auth_gate',
        decision: 'preflight_required',
        pendingCount: 1,
        satisfiedCount: 0,
      }),
    );
  });

  it('builds a gate_updated trace with pending and satisfied requirement summaries', () => {
    const event = buildAuthLifecycleTraceEvent({
      sessionId: 'runtime-session-2',
      decision: 'gate_updated',
      pending: [pendingRequirement],
      satisfied: [satisfiedRequirement],
    });

    expect(event.data).toEqual(
      expect.objectContaining({
        code: 'AUTH_PREFLIGHT_REQUIRED',
        decision: 'gate_updated',
        pendingCount: 1,
        satisfiedCount: 1,
      }),
    );
    expect(event.data.pendingRequirements).toEqual([
      expect.objectContaining({
        authProfileRef: 'google-creds',
        requirementKey: 'google:user',
      }),
    ]);
    expect(event.data.satisfiedRequirements).toEqual([
      expect.objectContaining({
        authProfileRef: 'salesforce-creds',
        requirementKey: 'salesforce:shared',
      }),
    ]);
  });

  it('builds a gate_satisfied trace with the satisfied auth code', () => {
    const event = buildAuthLifecycleTraceEvent({
      sessionId: 'runtime-session-3',
      decision: 'gate_satisfied',
      queuedMessageCount: 2,
    });

    expect(event.data).toEqual(
      expect.objectContaining({
        code: 'AUTH_PREFLIGHT_SATISFIED',
        decision: 'gate_satisfied',
        queuedMessageCount: 2,
      }),
    );
  });

  it('builds a message_queued trace with queue metadata', () => {
    const event = buildAuthLifecycleTraceEvent({
      sessionId: 'runtime-session-4',
      decision: 'message_queued',
      reason: 'auth_gate_active',
      textLength: 19,
      attachmentCount: 2,
    });

    expect(event.data).toEqual(
      expect.objectContaining({
        code: 'AUTH_PREFLIGHT_REQUIRED',
        decision: 'message_queued',
        reason: 'auth_gate_active',
        textLength: 19,
        attachmentCount: 2,
      }),
    );
  });
});
