import type { ArchSession, SessionService } from '@agent-platform/arch-ai';
import { formatToolAnswerForHistory } from './build-llm-messages';

export async function appendDeterministicToolAnswerMessage(params: {
  sessionService: SessionService;
  ctx: { tenantId: string; userId: string };
  session: ArchSession;
  toolCallId: string;
  answer: unknown;
  pendingPayload?: Record<string, unknown> | null;
}): Promise<void> {
  const { sessionService, ctx, session, toolCallId, answer, pendingPayload } = params;

  await sessionService.appendMessage(ctx, session.id, {
    id: crypto.randomUUID(),
    role: 'user',
    content: formatToolAnswerForHistory(toolCallId, answer, pendingPayload),
    timestamp: new Date().toISOString(),
    messageMetadata: {
      source: 'deterministic_tool_answer',
      toolCallId,
    },
    phase: session.metadata.phase,
  });
}
