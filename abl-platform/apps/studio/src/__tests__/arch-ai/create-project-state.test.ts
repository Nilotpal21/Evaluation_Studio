import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@/lib/arch-ai/ui/types';
import {
  buildCompleteWidgetAllowsCreate,
  canTriggerManualCreateProject,
  hasCreateProjectResultMessage,
  hasCreatedProject,
  shouldPreserveCreateProjectState,
  shouldSuppressFooterActionForPendingWidget,
} from '@/lib/arch-ai/ui/create-project-state';

function makeMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'msg-1',
    role: 'assistant',
    content: '',
    timestamp: '2026-04-20T00:00:00.000Z',
    ...overrides,
  };
}

describe('create-project-state helpers', () => {
  it('detects successful create_project tool results in chat history', () => {
    expect(
      hasCreateProjectResultMessage([
        makeMessage({
          toolCall: {
            toolCallId: 'create_project',
            toolName: 'create_project',
            input: {},
            result: { success: true, projectId: 'proj-123' },
          },
        }),
      ]),
    ).toBe(true);
  });

  it('treats createdProjectId as canonical success even without the terminal message', () => {
    expect(hasCreatedProject([], 'proj-123')).toBe(true);
  });

  it('preserves create success state when refresh returns no onboarding session', () => {
    expect(shouldPreserveCreateProjectState(null, 'proj-123', [])).toBe(true);
    expect(
      shouldPreserveCreateProjectState(null, null, [
        makeMessage({
          toolCall: {
            toolCallId: 'create_project',
            toolName: 'create_project',
            input: {},
            result: { success: true, projectId: 'proj-123' },
          },
        }),
      ]),
    ).toBe(true);
  });

  it('keeps BUILD phase widgets authoritative but allows stale CREATE build widgets to expose recovery CTA', () => {
    expect(shouldSuppressFooterActionForPendingWidget('BUILD', 'BuildComplete', false)).toBe(true);
    expect(shouldSuppressFooterActionForPendingWidget('CREATE', 'BuildComplete', false)).toBe(
      false,
    );
    expect(shouldSuppressFooterActionForPendingWidget('BLUEPRINT', 'TopologyApproval', false)).toBe(
      true,
    );
  });

  it('allows manual create only in BUILD or CREATE when the build is ready and project is not created', () => {
    expect(canTriggerManualCreateProject('BUILD', false, true)).toBe(true);
    expect(canTriggerManualCreateProject('CREATE', false, true)).toBe(true);
    expect(canTriggerManualCreateProject('CREATE', true, true)).toBe(false);
    expect(canTriggerManualCreateProject('BLUEPRINT', false, true)).toBe(false);
  });

  it('detects when a persisted BuildComplete widget still offers create', () => {
    expect(
      buildCompleteWidgetAllowsCreate({
        widgetType: 'BuildComplete',
        options: [{ label: 'Create project', value: 'create' }],
      }),
    ).toBe(true);
    expect(
      buildCompleteWidgetAllowsCreate({
        widgetType: 'BuildComplete',
        options: [{ label: 'Retry', value: 'retry' }],
      }),
    ).toBe(false);
  });
});
