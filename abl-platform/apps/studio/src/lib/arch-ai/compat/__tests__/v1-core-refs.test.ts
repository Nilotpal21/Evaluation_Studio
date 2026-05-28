import { describe, expect, it } from 'vitest';

import { TurnEventSchema } from '@agent-platform/arch-ai/types';

/**
 * Phase 3 / Task 3.1 — Verifies that the SSE plumbing (TurnEventSchema +
 * ArtifactUpdate widget variant union) recognizes the new
 * `integration_suggestion_card` variant emitted by the suggestion engine
 * landing in Phase 5. The compat dispatcher in v1-core-refs.ts forwards
 * `integration_suggestion_card` typed card events through
 * emitCompatWidgetArtifact, producing exactly this envelope shape.
 */
describe('integration_suggestion_card SSE plumbing', () => {
  const envelopeBase = {
    eventId: 'evt_test_01',
    schemaVersion: 2 as const,
    sessionId: 'sess_test',
    turnId: 'turn_test',
    seq: 0,
    timestamp: 1730000000000,
  };

  it('TurnEventSchema accepts an artifact_updated event with widget variant integration_suggestion_card', () => {
    const event = {
      ...envelopeBase,
      type: 'artifact_updated' as const,
      update: {
        artifact: 'widget' as const,
        variant: 'integration_suggestion_card' as const,
        payload: {
          title: 'Connect Slack',
          rationale: 'Your agent needs to post messages to channels.',
          providerOptions: [],
        },
      },
    };

    const result = TurnEventSchema.safeParse(event);
    expect(result.success).toBe(true);
  });

  it('TurnEventSchema rejects an unknown widget variant', () => {
    const event = {
      ...envelopeBase,
      type: 'artifact_updated' as const,
      update: {
        artifact: 'widget' as const,
        variant: 'not_a_real_card',
        payload: {},
      },
    };

    const result = TurnEventSchema.safeParse(event);
    expect(result.success).toBe(false);
  });

  it('TurnEventSchema accepts granular plan lifecycle events', () => {
    const event = {
      ...envelopeBase,
      type: 'plan_proposed' as const,
      planId: 'plan_123',
      status: 'proposed' as const,
      payload: {
        id: 'plan_123',
        projectId: 'project_123',
        status: 'proposed' as const,
        title: 'Fix delegate flow',
        goal: 'Analyze the topology and improve delegate handling.',
        summary: 'Read the related agents, inspect references, then propose a scoped flow change.',
        affectedAgents: ['TriageAgent', 'DelegateAgent'],
        createdAt: '2026-05-10T00:00:00.000Z',
        updatedAt: '2026-05-10T00:00:00.000Z',
      },
    };

    const result = TurnEventSchema.safeParse(event);
    expect(result.success).toBe(true);
  });
});
