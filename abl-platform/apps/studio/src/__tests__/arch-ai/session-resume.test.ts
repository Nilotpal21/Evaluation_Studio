import { describe, expect, it } from 'vitest';
import type { ArchSession } from '@/lib/arch-ai/ui/types';
import type { ResumeSnapshot } from '@agent-platform/arch-ai/types';
import {
  formatRelativeTime,
  getResumeNextActionTone,
  hasInProjectResumeContent,
} from '@/lib/arch-ai/components/arch/overlay/session-resume';

function makeSession(overrides?: Partial<ArchSession>): ArchSession {
  return {
    id: 'sess-1',
    tenantId: 'tenant-1',
    userId: 'user-1',
    state: 'IDLE',
    metadata: {
      phase: 'INTERVIEW',
      mode: 'IN_PROJECT',
      projectId: 'proj-1',
      specification: {
        version: 1,
        projectName: 'Demo Project',
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
    },
    createdAt: '2026-04-20T10:00:00.000Z',
    updatedAt: '2026-04-20T10:00:00.000Z',
    ...overrides,
  } as ArchSession;
}

function makeResume(overrides?: Partial<ResumeSnapshot>): ResumeSnapshot {
  return {
    phase: 'INTERVIEW',
    state: 'IDLE',
    canSendMessage: true,
    pending: null,
    nextAction: { type: 'send_message', reason: 'continue' },
    interruption: {
      wasInterrupted: false,
      lastDurableCheckpoint: 'message_appended',
      canContinueByMessage: true,
    },
    artifacts: {
      topology: {
        exists: false,
        approved: false,
        locked: false,
        agentCount: 0,
        edgeCount: 0,
      },
      files: {
        count: 0,
        names: [],
        mockFileCount: 0,
        mockFilePaths: [],
      },
      buildProgress: null,
      pendingMutation: null,
    },
    ...overrides,
  } as ResumeSnapshot;
}

describe('in-project session resume helpers', () => {
  it('does not surface a blank in-project session as resumable work', () => {
    expect(hasInProjectResumeContent(makeSession(), makeResume())).toBe(false);
  });

  it('surfaces resumable work when prior messages exist', () => {
    expect(
      hasInProjectResumeContent(
        makeSession({
          metadata: {
            ...makeSession().metadata,
            messages: [
              {
                id: 'msg-1',
                role: 'user',
                content: 'Check this project',
                timestamp: '2026-04-20T10:01:00.000Z',
              },
            ],
          },
        }),
        makeResume(),
      ),
    ).toBe(true);
  });

  it('surfaces resumable work when files or topology are still part of session context', () => {
    expect(
      hasInProjectResumeContent(
        makeSession(),
        makeResume({
          artifacts: {
            ...makeResume().artifacts,
            files: {
              count: 2,
              names: ['notes.md', 'diagram.png'],
              mockFileCount: 0,
              mockFilePaths: [],
            },
          },
        }),
      ),
    ).toBe(true);
  });

  it('maps confirmation widgets to a waiting-for-review tone', () => {
    expect(
      getResumeNextActionTone(
        makeResume({
          pending: {
            kind: 'widget',
            interaction: {
              kind: 'widget',
              id: 'tool-1',
              payload: {
                widgetType: 'Confirmation',
                question: 'Apply these changes?',
              },
              createdAt: '2026-04-20T10:02:00.000Z',
            },
          },
          nextAction: {
            type: 'answer_widget',
            interaction: {
              kind: 'widget',
              id: 'tool-1',
              payload: {
                widgetType: 'Confirmation',
                question: 'Apply these changes?',
              },
              createdAt: '2026-04-20T10:02:00.000Z',
            },
          },
        }),
      ),
    ).toBe('waiting_review');
  });

  it('maps secret collection widgets to a waiting-for-secret tone', () => {
    expect(
      getResumeNextActionTone(
        makeResume({
          nextAction: {
            type: 'answer_widget',
            interaction: {
              kind: 'widget',
              id: 'tool-2',
              payload: {
                flowId: 'oauth-1',
                field: 'apiKey',
                label: 'API key',
              },
              createdAt: '2026-04-20T10:02:00.000Z',
            },
          },
        }),
      ),
    ).toBe('waiting_secret');
  });

  it('formats relative timestamps for overlay metadata', () => {
    expect(
      formatRelativeTime('2026-04-20T09:59:30.000Z', Date.parse('2026-04-20T10:00:00.000Z')),
    ).toBe('just now');
    expect(
      formatRelativeTime('2026-04-20T08:00:00.000Z', Date.parse('2026-04-20T10:00:00.000Z')),
    ).toBe('2h ago');
  });
});
