import { describe, expect, it } from 'vitest';
import { buildResumeSnapshot } from '../../session/resume-snapshot.js';
import { createDefaultSpecification } from '../../types/specification.js';
import type { ArchSession } from '../../types/session.js';

function makeSession(overrides?: Partial<ArchSession['metadata']>): ArchSession {
  return {
    id: 'sess-1',
    tenantId: 'tenant-1',
    userId: 'user-1',
    state: 'IDLE',
    metadata: {
      phase: 'BUILD',
      mode: 'IN_PROJECT',
      specification: createDefaultSpecification(),
      pendingInteraction: null,
      messages: [],
      projectId: 'proj-1',
      files: {},
      buildProgress: null,
      approvedAgents: [],
      activeSpecialist: null,
      pendingMutation: null,
      ...overrides,
    },
    createdAt: '2026-04-22T06:00:00.000Z',
    updatedAt: '2026-04-22T06:00:00.000Z',
  };
}

describe('buildResumeSnapshot with integration draft pointer', () => {
  it('routes the user back to the unfinished integration draft', () => {
    const snapshot = buildResumeSnapshot(
      makeSession({
        activeIntegrationDraftId: 'draft-123',
      }),
    );

    expect(snapshot.nextAction).toEqual({
      type: 'send_message',
      reason: 'Resume the unfinished integration draft.',
    });
    expect(snapshot.artifacts.integrationDraft).toEqual({ id: 'draft-123' });
  });
});
