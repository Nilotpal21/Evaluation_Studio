import type { ArchSession } from '@/lib/arch-ai/ui/types';
import type { ResumeSnapshot } from '@agent-platform/arch-ai/types';

export function getSessionMessageCount(session: ArchSession | null | undefined): number {
  return Array.isArray(session?.metadata.messages) ? session.metadata.messages.length : 0;
}

export function hasInProjectResumeContent(
  session: ArchSession | null | undefined,
  resume: ResumeSnapshot | null | undefined,
): boolean {
  if (!session) {
    return false;
  }

  if (getSessionMessageCount(session) > 0) {
    return true;
  }

  if (resume?.pending) {
    return true;
  }

  if (resume?.artifacts.pendingMutation) {
    return true;
  }

  if ((resume?.artifacts.files.count ?? 0) > 0) {
    return true;
  }

  if (resume?.artifacts.topology.exists) {
    return true;
  }

  return resume?.interruption.wasInterrupted ?? false;
}

export function formatRelativeTime(isoDate: string, now = Date.now()): string {
  const diffMs = now - new Date(isoDate).getTime();
  const minutes = Math.floor(diffMs / 60_000);

  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  return `${Math.floor(hours / 24)}d ago`;
}

export function getResumeNextActionTone(
  resume: ResumeSnapshot | null | undefined,
):
  | 'waiting_response'
  | 'waiting_review'
  | 'waiting_file'
  | 'waiting_secret'
  | 'continue_phase'
  | 'continue_conversation'
  | 'continue_create'
  | 'resume_available' {
  const nextAction = resume?.nextAction;

  if (!nextAction) {
    return 'resume_available';
  }

  if (nextAction.type === 'answer_widget') {
    const payload = nextAction.interaction.payload as
      | { widgetType?: string; flowId?: string; field?: string; label?: string; message?: string }
      | undefined;

    if (payload?.widgetType === 'Confirmation') {
      return 'waiting_review';
    }

    if (typeof payload?.flowId === 'string' && typeof payload.field === 'string') {
      return 'waiting_secret';
    }

    if (payload?.widgetType === 'FileUpload') {
      return 'waiting_file';
    }

    return 'waiting_response';
  }

  if (nextAction.type === 'review_mutation') {
    return 'waiting_review';
  }

  if (nextAction.type === 'continue_phase') {
    return 'continue_phase';
  }

  if (nextAction.type === 'create_project') {
    return 'continue_create';
  }

  if (nextAction.type === 'send_message') {
    return 'continue_conversation';
  }

  return 'resume_available';
}
