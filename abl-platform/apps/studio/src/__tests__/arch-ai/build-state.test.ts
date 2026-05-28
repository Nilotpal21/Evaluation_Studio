import { beforeEach, describe, expect, it } from 'vitest';
import type { ArchSession } from '@agent-platform/arch-ai/types';
import { deriveBuildStateFromSession } from '@/lib/arch-ai/ui/build-state';

function makeSession(metadataOverrides: Partial<ArchSession['metadata']> = {}): ArchSession {
  return {
    id: 'sess-build-ready',
    tenantId: 'tenant-1',
    userId: 'user-1',
    state: 'IDLE',
    metadata: {
      phase: 'BUILD',
      mode: 'ONBOARDING',
      specification: {
        version: 1,
        projectName: 'ReservationHub',
        description: null,
        channels: [],
        language: 'English',
        uploadedFiles: [],
        conversationNotes: [],
      },
      pendingInteraction: null,
      messages: [],
      topologyApproved: true,
      topology: {
        agents: [{ name: 'ReservationRouter' }, { name: 'MedicalBookingSpecialist' }],
        edges: [],
        entryPoint: 'ReservationRouter',
      },
      files: {},
      ...metadataOverrides,
    },
    createdAt: '2026-04-19T14:00:00.000Z',
    updatedAt: '2026-04-19T14:05:00.000Z',
  };
}

describe('deriveBuildStateFromSession', () => {
  beforeEach(() => {});

  it('maps initialized BUILD sessions to the ready state with queued agents', () => {
    const buildState = deriveBuildStateFromSession(
      makeSession({
        buildProgress: {
          stage: 'initialized',
          agentStatuses: {
            ReservationRouter: 'pending',
            MedicalBookingSpecialist: 'pending',
          },
          toolStatuses: {},
        },
      }),
    );

    expect(buildState.phase).toBe('ready');
    expect(buildState.summary).toBeNull();
    expect(buildState.agents).toMatchObject({
      ReservationRouter: { status: 'queued' },
      MedicalBookingSpecialist: { status: 'queued' },
    });
  });

  it('treats a persisted BuildComplete widget as authoritative completion', () => {
    const buildState = deriveBuildStateFromSession(
      makeSession({
        pendingInteraction: {
          kind: 'widget',
          id: 'build-complete-1',
          payload: {
            widgetType: 'BuildComplete',
            question: 'All agents compiled successfully.',
          },
          createdAt: '2026-04-19T14:05:10.000Z',
        },
        buildProgress: {
          stage: 'generating',
          agentStatuses: {
            ReservationRouter: 'compiled',
            MedicalBookingSpecialist: 'warning',
          },
          toolStatuses: {},
        },
      }),
    );

    expect(buildState.phase).toBe('complete');
    expect(buildState.summary).toMatchObject({
      total: 2,
      compiled: 2,
      warnings: 1,
      errors: 0,
    });
  });

  it('uses topology agents as the canonical build set when persisted statuses drift', () => {
    const buildState = deriveBuildStateFromSession(
      makeSession({
        pendingInteraction: {
          kind: 'widget',
          id: 'build-complete-2',
          payload: {
            widgetType: 'BuildComplete',
            question: 'All agents compiled successfully.',
          },
          createdAt: '2026-04-19T14:05:10.000Z',
        },
        buildProgress: {
          stage: 'agents_complete',
          agentStatuses: {
            ReservationRouter: 'compiled',
            MedicalBookingSpecialist: 'compiled',
            LegacySupportAgent: 'compiled',
          },
          toolStatuses: {},
        },
      }),
    );

    expect(Object.keys(buildState.agents)).toEqual([
      'ReservationRouter',
      'MedicalBookingSpecialist',
    ]);
    expect(buildState.summary).toMatchObject({
      total: 2,
      compiled: 2,
      warnings: 0,
      errors: 0,
    });
  });
});
