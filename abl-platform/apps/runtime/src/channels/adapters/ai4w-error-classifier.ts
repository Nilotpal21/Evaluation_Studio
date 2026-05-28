/**
 * AI4W Stream Error Classifier
 *
 * Classifies runtime execution errors into structured error codes that AI4W
 * clients can use to render differentiated UX per failure mode.
 */

export type AI4WStreamErrorCode =
  | 'NO_ACTIVE_DEPLOYMENT'
  | 'AGENT_CONFIG_CHANGED'
  | 'MODEL_CREDENTIAL_MISSING'
  | 'EXECUTION_TIMEOUT'
  | 'COMPILATION_ERROR'
  | 'TOOL_RESOLUTION_ERROR'
  | 'EMPTY_RESPONSE'
  | 'SESSION_BUSY'
  | 'INTERNAL_ERROR';

export interface AI4WStreamError {
  errorCode: AI4WStreamErrorCode;
  message: string;
  retryable: boolean;
}

export interface OutcomeStatusHint {
  status: 'ok' | 'auth_required' | 'timeout' | 'empty_response' | 'error';
}

export function classifyStreamError(
  error: unknown,
  outcomeHint?: OutcomeStatusHint,
): AI4WStreamError {
  const errMsg = error instanceof Error ? error.message : String(error);
  const lowered = errMsg.toLowerCase();

  if (outcomeHint?.status === 'timeout') {
    return {
      errorCode: 'EXECUTION_TIMEOUT',
      message: 'The agent took too long to respond. Please try again.',
      retryable: true,
    };
  }

  if (outcomeHint?.status === 'empty_response') {
    return {
      errorCode: 'EMPTY_RESPONSE',
      message: "I'm having trouble completing that request. Please try again.",
      retryable: true,
    };
  }

  if (lowered.includes('no active deployment') || lowered.includes('deployment not found')) {
    return {
      errorCode: 'NO_ACTIVE_DEPLOYMENT',
      message:
        'No active deployment found for the configured environment. Please publish a deployment.',
      retryable: false,
    };
  }

  if (
    (lowered.includes('config') && lowered.includes('changed')) ||
    lowered.includes('config hash mismatch') ||
    lowered.includes('stale')
  ) {
    return {
      errorCode: 'AGENT_CONFIG_CHANGED',
      message:
        'The agent configuration has changed since this session started. Please start a new conversation.',
      retryable: false,
    };
  }

  if (
    lowered.includes('credential') ||
    lowered.includes('model not configured') ||
    lowered.includes('api key')
  ) {
    return {
      errorCode: 'MODEL_CREDENTIAL_MISSING',
      message: 'The agent model credentials are not configured. Please check the agent setup.',
      retryable: false,
    };
  }

  if (lowered.includes('tool') && lowered.includes('not found')) {
    return {
      errorCode: 'TOOL_RESOLUTION_ERROR',
      message:
        'One or more tools referenced by the agent are not available in the project. Please check the Tool Library.',
      retryable: false,
    };
  }

  if (
    lowered.includes('compilation') ||
    lowered.includes('dsl') ||
    lowered.includes('parse error')
  ) {
    return {
      errorCode: 'COMPILATION_ERROR',
      message:
        'The agent definition has errors and cannot be executed. Please fix the agent configuration.',
      retryable: false,
    };
  }

  return {
    errorCode: 'INTERNAL_ERROR',
    message: 'An error occurred while processing your request.',
    retryable: true,
  };
}
