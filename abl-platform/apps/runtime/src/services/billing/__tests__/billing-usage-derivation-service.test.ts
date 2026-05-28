import { describe, expect, it } from 'vitest';
import { DEFAULT_BILLING_UNIT_POLICY, cloneBillingUnitPolicy } from '../billing-policy-service.js';
import { BillingUsageDerivationService } from '../billing-usage-derivation-service.js';

function minutesAfter(base: Date, minutes: number): Date {
  return new Date(base.getTime() + minutes * 60 * 1000);
}

describe('BillingUsageDerivationService', () => {
  it('explains excluded debug sessions and splits base units into billable intervals', () => {
    const service = new BillingUsageDerivationService();
    const start = new Date('2026-03-30T00:00:00.000Z');

    const result = service.derive({
      policy: cloneBillingUnitPolicy(DEFAULT_BILLING_UNIT_POLICY),
      sessions: [
        {
          sessionId: 'sess-chat-1',
          channel: 'web_chat',
          startedAt: start,
          endedAt: minutesAfter(start, 10),
          usage: {
            llmCallCount: 2,
            toolCallCount: 1,
          },
        },
        {
          sessionId: 'sess-voice-1',
          channel: 'voice',
          startedAt: start,
          endedAt: minutesAfter(start, 31),
          usage: {
            llmCallCount: 1,
            toolCallCount: 4,
          },
        },
        {
          sessionId: 'sess-debug-1',
          channel: 'web_debug',
          startedAt: start,
          endedAt: minutesAfter(start, 45),
          usage: {
            llmCallCount: 8,
            toolCallCount: 8,
          },
        },
      ],
      windowStart: start,
      windowEnd: minutesAfter(start, 60),
    });

    expect(result.materializationBasis).toBe('time_window');
    expect(result.completedSessionCount).toBe(3);
    expect(result.includedSessionCount).toBe(2);
    expect(result.excludedSessionCount).toBe(1);
    expect(result.baseUnits).toBe(4);
    expect(result.llmAddonUnits).toBe(3);
    expect(result.toolAddonUnits).toBe(5);
    expect(result.totalUnits).toBe(12);

    expect(result.decisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sessionId: 'sess-chat-1',
          included: true,
          baseUnits: 1,
          llmAddonUnits: 2,
          toolAddonUnits: 1,
        }),
        expect.objectContaining({
          sessionId: 'sess-voice-1',
          included: true,
          baseUnits: 3,
          llmAddonUnits: 1,
          toolAddonUnits: 4,
        }),
        expect.objectContaining({
          sessionId: 'sess-debug-1',
          included: false,
          exclusionReasons: ['excluded_channel:web_debug'],
          baseUnits: 0,
          llmAddonUnits: 0,
          toolAddonUnits: 0,
        }),
      ]),
    );
  });

  it('excludes proactive sessions that stay below the configured interaction threshold', () => {
    const service = new BillingUsageDerivationService();
    const policy = cloneBillingUnitPolicy(DEFAULT_BILLING_UNIT_POLICY);
    const start = new Date('2026-03-30T01:00:00.000Z');

    const result = service.derive({
      policy,
      sessions: [
        {
          sessionId: 'sess-proactive-idle',
          channel: 'web_chat',
          startedAt: start,
          endedAt: minutesAfter(start, 8),
          interactionType: 'proactive',
          userMessageCount: 0,
          interactiveTurnCount: 0,
          engagedSeconds: 0,
          usage: {
            llmCallCount: 3,
            toolCallCount: 2,
          },
        },
        {
          sessionId: 'sess-proactive-engaged',
          channel: 'web_chat',
          startedAt: start,
          endedAt: minutesAfter(start, 8),
          interactionType: 'proactive',
          userMessageCount: 2,
          interactiveTurnCount: 2,
          engagedSeconds: 120,
          usage: {
            llmCallCount: 1,
            toolCallCount: 1,
          },
        },
      ],
    });

    expect(result.includedSessionCount).toBe(1);
    expect(result.excludedSessionCount).toBe(1);
    expect(result.baseUnits).toBe(1);
    expect(result.llmAddonUnits).toBe(1);
    expect(result.toolAddonUnits).toBe(1);

    const excluded = result.decisions.find(
      (decision) => decision.sessionId === 'sess-proactive-idle',
    );
    const included = result.decisions.find(
      (decision) => decision.sessionId === 'sess-proactive-engaged',
    );

    expect(excluded).toMatchObject({
      included: false,
      exclusionReasons: ['proactive_below_interaction_threshold'],
      baseUnits: 0,
      llmAddonUnits: 0,
      toolAddonUnits: 0,
    });
    expect(included).toMatchObject({
      included: true,
      exclusionReasons: [],
      baseUnits: 1,
      llmAddonUnits: 1,
      toolAddonUnits: 1,
    });
  });

  it('supports completed-session materialization and excluded session-type rules', () => {
    const service = new BillingUsageDerivationService();
    const policy = cloneBillingUnitPolicy(DEFAULT_BILLING_UNIT_POLICY);
    policy.materialization.basis = 'completed_sessions';
    policy.materialization.completedSessionsCount = 25;
    policy.materialization.timeWindowMinutes = null;
    policy.excludedSessionTypes = ['campaign'];
    policy.addons.llm.mode = 'off';
    policy.addons.tool.mode = 'off';

    const start = new Date('2026-03-30T02:00:00.000Z');
    const result = service.derive({
      policy,
      sessions: [
        {
          sessionId: 'sess-campaign',
          channel: 'web_chat',
          sessionType: 'campaign',
          startedAt: start,
          endedAt: minutesAfter(start, 12),
        },
        {
          sessionId: 'sess-standard',
          channel: 'web_chat',
          sessionType: 'standard',
          startedAt: start,
          endedAt: minutesAfter(start, 16),
        },
      ],
    });

    expect(result.materializationBasis).toBe('completed_sessions');
    expect(result.completedSessionCount).toBe(2);
    expect(result.includedSessionCount).toBe(1);
    expect(result.excludedSessionCount).toBe(1);
    expect(result.baseUnits).toBe(2);
    expect(result.llmAddonUnits).toBe(0);
    expect(result.toolAddonUnits).toBe(0);
    expect(result.totalUnits).toBe(2);

    expect(result.decisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sessionId: 'sess-campaign',
          included: false,
          exclusionReasons: ['excluded_session_type:campaign'],
        }),
        expect.objectContaining({
          sessionId: 'sess-standard',
          included: true,
          exclusionReasons: [],
          baseUnits: 2,
        }),
      ]),
    );
  });

  it('supports configurable per-call and bucketed addon unit modes', () => {
    const service = new BillingUsageDerivationService();
    const policy = cloneBillingUnitPolicy(DEFAULT_BILLING_UNIT_POLICY);
    policy.addons.llm.mode = 'bucketed';
    policy.addons.llm.bucketSize = 3;
    policy.addons.tool.mode = 'bucketed';
    policy.addons.tool.bucketSize = 2;

    const start = new Date('2026-03-30T03:00:00.000Z');
    const result = service.derive({
      policy,
      sessions: [
        {
          sessionId: 'sess-bucketed',
          channel: 'voice',
          startedAt: start,
          endedAt: minutesAfter(start, 5),
          usage: {
            llmCallCount: 7,
            toolCallCount: 5,
          },
        },
      ],
    });

    expect(result.baseUnits).toBe(1);
    expect(result.llmAddonUnits).toBe(3);
    expect(result.toolAddonUnits).toBe(3);
    expect(result.totalUnits).toBe(7);
    expect(result.decisions[0]).toMatchObject({
      sessionId: 'sess-bucketed',
      included: true,
      llmAddonUnits: 3,
      toolAddonUnits: 3,
    });
  });

  it('excludes eval sessions from billing with reason eval_session', () => {
    const service = new BillingUsageDerivationService();
    const start = new Date('2026-03-30T04:00:00.000Z');

    const result = service.derive({
      policy: cloneBillingUnitPolicy(DEFAULT_BILLING_UNIT_POLICY),
      sessions: [
        {
          sessionId: 'sess-eval-1',
          channel: 'api',
          startedAt: start,
          endedAt: minutesAfter(start, 5),
          knownSource: 'eval',
          usage: { llmCallCount: 3, toolCallCount: 1 },
        },
        {
          sessionId: 'sess-production-1',
          channel: 'web_chat',
          startedAt: start,
          endedAt: minutesAfter(start, 5),
          knownSource: 'production',
          usage: { llmCallCount: 2, toolCallCount: 0 },
        },
      ],
    });

    expect(result.includedSessionCount).toBe(1);
    expect(result.excludedSessionCount).toBe(1);

    const evalDecision = result.decisions.find((d) => d.sessionId === 'sess-eval-1');
    expect(evalDecision).toMatchObject({
      included: false,
      exclusionReasons: ['eval_session'],
      baseUnits: 0,
      llmAddonUnits: 0,
      toolAddonUnits: 0,
    });

    const prodDecision = result.decisions.find((d) => d.sessionId === 'sess-production-1');
    expect(prodDecision).toMatchObject({
      included: true,
      exclusionReasons: [],
    });
  });

  it('excludes synthetic sessions from billing with reason synthetic_session', () => {
    const service = new BillingUsageDerivationService();
    const start = new Date('2026-03-30T05:00:00.000Z');

    const result = service.derive({
      policy: cloneBillingUnitPolicy(DEFAULT_BILLING_UNIT_POLICY),
      sessions: [
        {
          sessionId: 'sess-synthetic-1',
          channel: 'api',
          startedAt: start,
          endedAt: minutesAfter(start, 3),
          knownSource: 'synthetic',
          usage: { llmCallCount: 10, toolCallCount: 5 },
        },
      ],
    });

    expect(result.includedSessionCount).toBe(0);
    expect(result.excludedSessionCount).toBe(1);

    const decision = result.decisions[0];
    expect(decision).toMatchObject({
      sessionId: 'sess-synthetic-1',
      included: false,
      exclusionReasons: ['synthetic_session'],
      baseUnits: 0,
    });
  });

  it('includes sessions with null or undefined knownSource (treated as production)', () => {
    const service = new BillingUsageDerivationService();
    const start = new Date('2026-03-30T06:00:00.000Z');

    const result = service.derive({
      policy: cloneBillingUnitPolicy(DEFAULT_BILLING_UNIT_POLICY),
      sessions: [
        {
          sessionId: 'sess-null-source',
          channel: 'web_chat',
          startedAt: start,
          endedAt: minutesAfter(start, 5),
          knownSource: null,
          usage: { llmCallCount: 1, toolCallCount: 0 },
        },
        {
          sessionId: 'sess-undefined-source',
          channel: 'web_chat',
          startedAt: start,
          endedAt: minutesAfter(start, 5),
          // knownSource not set — undefined
          usage: { llmCallCount: 1, toolCallCount: 0 },
        },
      ],
    });

    expect(result.includedSessionCount).toBe(2);
    expect(result.excludedSessionCount).toBe(0);

    for (const decision of result.decisions) {
      expect(decision.included).toBe(true);
      expect(decision.exclusionReasons).toEqual([]);
    }
  });
});
