import type { V1ExecuteResponse, V1OutputBlock, V1SessionInfo } from './types.js';

export interface BuildEnvelopeInput {
  messageId: string;
  runId: string;
  sessionId: string;
  appId: string;
  sessionReference?: string;
  userReference?: string;
  userId?: string;
  source?: string;
  outputText: string;
  richContent?: V1OutputBlock['richContent'];
  actions?: V1OutputBlock['actions'];
  voiceConfig?: V1OutputBlock['voiceConfig'];
  contentEnvelope?: V1OutputBlock['contentEnvelope'];
  metadata?: Record<string, unknown>;
  status?: V1SessionInfo['status'];
}

function buildOutputBlock(input: BuildEnvelopeInput): V1OutputBlock {
  return {
    type: 'text',
    content: input.outputText,
    ...(input.richContent ? { richContent: input.richContent } : {}),
    ...(input.actions ? { actions: input.actions } : {}),
    ...(input.voiceConfig ? { voiceConfig: input.voiceConfig } : {}),
    ...(input.contentEnvelope ? { contentEnvelope: input.contentEnvelope } : {}),
  };
}

/**
 * Build the V1 sync response envelope Kore.ai Agent Assist's widget parses.
 *
 * The widget reads:
 *   - `output[0].content` for the answer text
 *   - `sessionInfo.sessionId`, `sessionInfo.runId` for session tracking
 *   - `sessionInfo.status` for completion semantics
 *   - `metadata` is echoed back when the caller provided any
 */
export function buildV1Envelope(input: BuildEnvelopeInput): V1ExecuteResponse {
  const sessionInfo: V1SessionInfo = {
    sessionId: input.sessionId,
    runId: input.runId,
    status: input.status ?? 'completed',
    appId: input.appId,
  };
  if (input.sessionReference) sessionInfo.sessionReference = input.sessionReference;
  if (input.userReference) sessionInfo.userReference = input.userReference;
  if (input.userId) sessionInfo.userId = input.userId;
  if (input.source) sessionInfo.source = input.source;

  const envelope: V1ExecuteResponse = {
    messageId: input.messageId,
    output: [buildOutputBlock(input)],
    sessionInfo,
  };

  if (input.metadata && Object.keys(input.metadata).length > 0) {
    envelope.metadata = input.metadata;
  }

  return envelope;
}

/**
 * Build a V1 error envelope. V1 clients parse `sessionInfo.status === 'error'`
 * as the failure signal rather than HTTP codes for runtime errors (the legacy
 * contract Kore.ai Agent Assist's widget depends on — see FR-23 of the feature spec).
 */
export function buildV1ErrorEnvelope(input: BuildEnvelopeInput): V1ExecuteResponse {
  return buildV1Envelope({ ...input, status: 'error' });
}
