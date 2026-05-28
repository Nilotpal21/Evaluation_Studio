import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { InProjectSessionResumeCard } from '@/lib/arch-ai/components/arch/overlay/InProjectSessionResumeCard';
import type { ArchSession } from '@/lib/arch-ai/ui/types';
import type { ResumeSnapshot } from '@agent-platform/arch-ai/types';

function makeSession(): ArchSession {
  return {
    id: 'sess-1',
    tenantId: 'tenant-1',
    userId: 'user-1',
    state: 'ACTIVE',
    metadata: {
      phase: 'BUILD',
      mode: 'IN_PROJECT',
      projectId: 'proj-1',
      specification: {
        version: 1,
        projectName: 'Agent Workspace',
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
      messages: [
        {
          id: 'msg-1',
          role: 'user',
          content: 'Review the generated agents.',
          timestamp: '2026-04-20T10:05:00.000Z',
        },
      ],
      files: {},
    },
    createdAt: '2026-04-20T10:00:00.000Z',
    updatedAt: '2026-04-20T10:30:00.000Z',
  } as ArchSession;
}

function makeResume(): ResumeSnapshot {
  return {
    phase: 'BUILD',
    state: 'ACTIVE',
    canSendMessage: true,
    pending: {
      kind: 'widget',
      interaction: {
        kind: 'widget',
        id: 'tool-1',
        payload: {
          widgetType: 'Confirmation',
          question: 'Apply these changes?',
        },
        createdAt: '2026-04-20T10:30:00.000Z',
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
        createdAt: '2026-04-20T10:30:00.000Z',
      },
    },
    interruption: {
      wasInterrupted: false,
      lastDurableCheckpoint: 'artifact_persisted',
      canContinueByMessage: true,
    },
    artifacts: {
      topology: {
        exists: true,
        approved: true,
        locked: true,
        agentCount: 2,
        edgeCount: 1,
      },
      files: {
        count: 2,
        names: ['spec.md', 'diagram.png'],
        mockFileCount: 0,
        mockFilePaths: [],
      },
      buildProgress: null,
      pendingMutation: {
        target: 'LeadIntake',
        reviewStatus: 'pending',
      },
    },
  } as ResumeSnapshot;
}

describe('InProjectSessionResumeCard', () => {
  it('shows resume metadata and actions for a pending in-project session', () => {
    render(
      <InProjectSessionResumeCard
        session={makeSession()}
        resume={makeResume()}
        onResume={vi.fn()}
        onStartNew={vi.fn()}
      />,
    );

    expect(screen.getByText('Session in progress')).toBeInTheDocument();
    expect(screen.getByText('Agent Workspace')).toBeInTheDocument();
    expect(screen.getByText('Waiting for your review')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Resume session' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start new session' })).toBeInTheDocument();
    expect(screen.getByText('2 files in context')).toBeInTheDocument();
  });
});
