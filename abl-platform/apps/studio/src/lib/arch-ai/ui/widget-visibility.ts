import type { ArchSession, ChatMessage } from './types';

const INTERACTIVE_TOOL_NAMES = new Set([
  'ask_user',
  'collect_file',
  'collect_secret',
  'gate_request',
]);

const RENDERABLE_NON_INTERACTIVE_TOOL_NAMES = new Set(['recommend_model', 'analyze_constraints']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBuildCompleteResumeWidget(
  toolCall: NonNullable<ChatMessage['toolCall']>,
  session: ArchSession | null,
): boolean {
  if (toolCall.toolName !== 'ask_user' || !isRecord(toolCall.input)) {
    return false;
  }
  if (toolCall.input.widgetType !== 'BuildComplete') {
    return false;
  }

  const buildStage = isRecord(session?.metadata.buildProgress)
    ? session?.metadata.buildProgress.stage
    : undefined;
  return (
    (session?.metadata.phase === 'BUILD' || session?.metadata.phase === 'CREATE') &&
    (buildStage === 'agents_complete' || buildStage === 'complete')
  );
}

export function shouldRenderToolCallMessage(
  toolCall: NonNullable<ChatMessage['toolCall']>,
  session: ArchSession | null,
): boolean {
  if (toolCall.toolName === 'create_project') {
    return true;
  }

  if (RENDERABLE_NON_INTERACTIVE_TOOL_NAMES.has(toolCall.toolName)) {
    return toolCall.result !== undefined && toolCall.result !== null;
  }

  if (!INTERACTIVE_TOOL_NAMES.has(toolCall.toolName)) {
    return false;
  }

  // Answered widgets always render (compacted summary).
  if (toolCall.result !== undefined && toolCall.result !== null) {
    return true;
  }

  // Unanswered: render if it's the active pending widget. BuildComplete is the
  // only allowed phase-resume widget without pendingInteraction because a
  // completed build can be resumed from durable buildProgress after reload.
  const pendingId = session?.metadata.pendingInteraction?.id;
  if (!pendingId) {
    return isBuildCompleteResumeWidget(toolCall, session);
  }
  return pendingId === toolCall.toolCallId;
}
