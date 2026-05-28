import { randomUUID } from 'crypto';
import type { EventBus } from '../../event-bus/types.js';
import {
  renderPayloadForPipelineEvent,
  type EventPIIContext,
} from '../../event-bus/pii-event-boundary.js';

export type VoiceSessionOutcome = 'completed' | 'escalated' | 'abandoned' | 'pending';

export interface VoiceSessionEndedParams {
  tenantId: string;
  projectId: string;
  sessionId: string;
  agentName: string;
  sessionOutcome: VoiceSessionOutcome;
  durationMs: number;
  turnCount: number;
}

/**
 * Maps voice session outcome to the SessionEndedPayload reason field.
 *
 * VoiceSessionOutcome values:
 *   completed  — AI resolved the issue, clean call end
 *   escalated  — call was transferred to a human agent (not a failure)
 *   abandoned  — caller hung up, dropped, or unknown disconnect
 *   pending    — never set at close time; falls through to user_left
 *
 * SessionEndedPayload.reason accepts: completed | timeout | error | user_left | user_exit | ...
 *   completed → completed
 *   escalated → user_exit  (transferred out, not abandoned)
 *   abandoned → user_left  (caller disconnected)
 */
function resolveReason(outcome: VoiceSessionOutcome): 'completed' | 'user_exit' | 'user_left' {
  if (outcome === 'completed') return 'completed';
  if (outcome === 'escalated') return 'user_exit';
  return 'user_left';
}

export interface VoiceMessageParams {
  tenantId: string;
  projectId: string;
  sessionId: string;
  agentName: string;
  content: string;
  messageIndex: number;
  piiContext: EventPIIContext;
}

/**
 * Fire-and-forget emit of message.user / message.agent to the EventBus.
 * Used by S2S voice paths that bypass executeMessage() and therefore
 * never hit the RuntimeExecutor's built-in emitEvent() call.
 */
export function emitVoiceMessage(
  bus: EventBus,
  role: 'user' | 'assistant',
  params: VoiceMessageParams,
): void {
  try {
    const type = role === 'user' ? 'message.user' : 'message.agent';
    bus.emit({
      eventId: randomUUID(),
      type,
      tenantId: params.tenantId,
      projectId: params.projectId,
      sessionId: params.sessionId,
      agentName: params.agentName,
      channel: 'voice',
      timestamp: new Date().toISOString(),
      payload: renderPayloadForPipelineEvent(
        { messageId: randomUUID(), content: params.content, messageIndex: params.messageIndex },
        params.piiContext,
        role,
      ),
    });
  } catch {
    // fire-and-forget: never block voice session
  }
}

/**
 * Fire-and-forget emit of session.ended to the EventBus.
 * Called from both voice session close paths (pipeline and S2S)
 * after the DB session write succeeds.
 */
export function emitVoiceSessionEnded(bus: EventBus, params: VoiceSessionEndedParams): void {
  try {
    bus.emit({
      eventId: randomUUID(),
      type: 'session.ended',
      tenantId: params.tenantId,
      projectId: params.projectId,
      sessionId: params.sessionId,
      agentName: params.agentName,
      channel: 'voice',
      timestamp: new Date().toISOString(),
      payload: {
        reason: resolveReason(params.sessionOutcome),
        durationMs: params.durationMs,
        turnCount: params.turnCount,
      },
    });
  } catch {
    // fire-and-forget: never block session close
  }
}
