import type { ArchSession, ChatMessage } from './types';

const PHASE_OWNED_WIDGET_TYPES = new Set([
  'BlueprintConfirm',
  'TopologyApproval',
  'TopologyRevision',
  'BuildComplete',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function hasCreateProjectResultMessage(messages: ChatMessage[]): boolean {
  return messages.some(
    (message) => message.toolCall?.toolName === 'create_project' && !!message.toolCall?.result,
  );
}

export function hasCreatedProject(
  messages: ChatMessage[],
  createdProjectId: string | null,
): boolean {
  return createdProjectId !== null || hasCreateProjectResultMessage(messages);
}

export function shouldPreserveCreateProjectState(
  nextSession: ArchSession | null,
  createdProjectId: string | null,
  messages: ChatMessage[],
): boolean {
  if (nextSession) {
    return false;
  }

  return hasCreatedProject(messages, createdProjectId);
}

export function shouldSuppressFooterActionForPendingWidget(
  phase: string | null | undefined,
  pendingWidgetType: string | null,
  projectCreated: boolean,
): boolean {
  if (!pendingWidgetType || !PHASE_OWNED_WIDGET_TYPES.has(pendingWidgetType)) {
    return false;
  }

  // Recovery lane: stale BuildComplete widgets in CREATE must not hide the
  // deterministic footer create action.
  if (phase === 'CREATE' && pendingWidgetType === 'BuildComplete' && !projectCreated) {
    return false;
  }

  return true;
}

export function canTriggerManualCreateProject(
  phase: string | null | undefined,
  projectCreated: boolean,
  canCreateProject: boolean,
): boolean {
  return (phase === 'BUILD' || phase === 'CREATE') && !projectCreated && canCreateProject;
}

export function buildCompleteWidgetAllowsCreate(payload: unknown): boolean {
  if (!isRecord(payload) || payload.widgetType !== 'BuildComplete') {
    return false;
  }

  const options = payload.options;
  if (!Array.isArray(options)) {
    return false;
  }

  return options.some(
    (option) =>
      isRecord(option) &&
      typeof option.value === 'string' &&
      option.value.toLowerCase() === 'create',
  );
}
