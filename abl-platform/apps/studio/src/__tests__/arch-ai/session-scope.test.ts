import { describe, expect, it } from 'vitest';
import type { ArchSession, SessionMetadata } from '@agent-platform/arch-ai/types';
import { deriveSessionScope, resolveSessionScope } from '@/lib/arch-ai/ui/session-scope';

function makeSession(
  mode: 'ONBOARDING' | 'IN_PROJECT',
  projectId?: string,
  metadata?: Partial<SessionMetadata>,
): ArchSession {
  return {
    id: `sess-${mode.toLowerCase()}`,
    tenantId: 'tenant-1',
    userId: 'user-1',
    state: 'IDLE',
    metadata: {
      phase: mode === 'IN_PROJECT' ? 'IN_PROJECT' : 'INTERVIEW',
      mode,
      specification: {
        version: 1,
        projectName: '',
        description: null,
        channels: [],
        language: 'English',
        uploadedFiles: [],
        conversationNotes: [],
      },
      pendingInteraction: null,
      pendingMutation: null,
      activeSpecialist: null,
      topology: null,
      messages: [],
      files: {},
      ...(projectId ? { projectId } : {}),
      ...metadata,
    },
    createdAt: '2026-04-20T08:00:00.000Z',
    updatedAt: '2026-04-20T08:00:00.000Z',
  } as ArchSession;
}

describe('session scope helpers', () => {
  it('derives IN_PROJECT scope from session metadata.projectId', () => {
    expect(deriveSessionScope(makeSession('IN_PROJECT', 'proj-123'))).toEqual({
      mode: 'IN_PROJECT',
      projectId: 'proj-123',
    });
  });

  it('preserves the backend-owned onboarding thread id', () => {
    expect(
      deriveSessionScope(makeSession('ONBOARDING', undefined, { threadId: 'thread-server-1' })),
    ).toEqual({
      mode: 'ONBOARDING',
      threadId: 'thread-server-1',
    });
  });

  it('preserves project, surface, agent, and thread scope for agent editor sessions', () => {
    expect(
      deriveSessionScope(
        makeSession('IN_PROJECT', 'proj-123', {
          surface: 'agent-editor',
          agentName: 'BookingRequestAgent',
          threadId: 'thread-editor-1',
        }),
      ),
    ).toEqual({
      mode: 'IN_PROJECT',
      projectId: 'proj-123',
      surface: 'agent-editor',
      agentName: 'BookingRequestAgent',
      threadId: 'thread-editor-1',
    });
  });

  it('trims and omits blank thread ids from derived scope', () => {
    expect(deriveSessionScope(makeSession('ONBOARDING', undefined, { threadId: '   ' }))).toEqual({
      mode: 'ONBOARDING',
    });
  });

  it('rejects IN_PROJECT sessions that do not carry a projectId', () => {
    expect(deriveSessionScope(makeSession('IN_PROJECT'))).toBeNull();
  });

  it('ignores projectId when the caller explicitly requests onboarding scope', () => {
    expect(
      resolveSessionScope(makeSession('IN_PROJECT', 'proj-123'), 'ONBOARDING', 'proj-999'),
    ).toEqual({
      mode: 'ONBOARDING',
    });
  });

  it('uses an explicit thread id when creating an onboarding scope without a session', () => {
    expect(
      resolveSessionScope(null, 'ONBOARDING', undefined, { threadId: 'thread-new-1' }),
    ).toEqual({
      mode: 'ONBOARDING',
      threadId: 'thread-new-1',
    });
  });

  it('uses explicit agent editor thread scope when loading an in-project session', () => {
    expect(
      resolveSessionScope(null, 'IN_PROJECT', 'proj-123', {
        surface: 'agent-editor',
        agentName: 'BookingRequestAgent',
        threadId: 'thread-editor-1',
      }),
    ).toEqual({
      mode: 'IN_PROJECT',
      projectId: 'proj-123',
      surface: 'agent-editor',
      agentName: 'BookingRequestAgent',
      threadId: 'thread-editor-1',
    });
  });

  it('reuses the current in-project session scope when refresh callers omit projectId', () => {
    expect(resolveSessionScope(makeSession('IN_PROJECT', 'proj-123'), 'IN_PROJECT')).toEqual({
      mode: 'IN_PROJECT',
      projectId: 'proj-123',
    });
  });

  it('refuses to broaden an explicit IN_PROJECT reload without a projectId source', () => {
    expect(resolveSessionScope(makeSession('ONBOARDING'), 'IN_PROJECT')).toBeNull();
  });
});
