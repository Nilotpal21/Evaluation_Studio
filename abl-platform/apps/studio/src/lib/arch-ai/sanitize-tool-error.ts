const MAX_MESSAGE_LENGTH = 500;
const UUID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const URL_WITH_CREDS = /https?:\/\/[^:]+:[^@]+@/gi;
const URL_WITH_QUERY = /(https?:\/\/[^\s]+)\?[^\s]*/gi;
const INTERNAL_HOST = /\b[\w.-]+\.(?:svc\.cluster\.local|internal|consul|local)\b/gi;
const STACK_TRACE_LINE = /\n\s+at\s+[^\n]+/g;
const FILE_PATH = /\/[\w./-]+\.(?:ts|js|tsx|jsx)(?::\d+)?/g;

export interface SanitizedError {
  code: string;
  message: string;
  hint?: string;
}

export function sanitizeToolError(input: unknown): SanitizedError {
  const status = extractStatus(input);
  const rawMessage = extractMessage(input);

  let message = rawMessage
    .replace(URL_WITH_CREDS, 'https://***@')
    .replace(URL_WITH_QUERY, '$1?…')
    .replace(INTERNAL_HOST, '<internal>')
    .replace(UUID_PATTERN, '<id>')
    .replace(STACK_TRACE_LINE, '')
    .replace(FILE_PATH, '<file>');

  if (message.length > MAX_MESSAGE_LENGTH) {
    message = message.slice(0, MAX_MESSAGE_LENGTH) + '…';
  }

  return {
    code: buildCode(status),
    message: message.trim() || 'Tool execution failed.',
    hint: buildHint(status),
  };
}

function extractStatus(input: unknown): number | null {
  if (typeof input === 'object' && input !== null && 'status' in input) {
    const s = (input as { status: unknown }).status;
    if (typeof s === 'number') return s;
  }
  return null;
}

function extractMessage(input: unknown): string {
  if (input instanceof Error) {
    return input.stack ? `${input.message}\n${input.stack}` : input.message;
  }
  if (typeof input === 'string') return input;
  if (typeof input === 'object' && input !== null && 'message' in input) {
    const m = (input as { message: unknown }).message;
    if (typeof m === 'string') return m;
  }
  return 'Unknown error';
}

function buildCode(status: number | null): string {
  if (status !== null) return `HTTP_${status}`;
  return 'TOOL_ERROR';
}

function buildHint(status: number | null): string | undefined {
  if (status === 401 || status === 403) {
    return 'The credentials may be expired or revoked. Try re-authorizing the auth profile.';
  }
  if (status === 404) {
    return 'The resource was not found. Verify the endpoint URL or resource ID is correct.';
  }
  if (status === 429) {
    return 'The provider is rate-limiting requests. Wait a moment and retry.';
  }
  if (status !== null && status >= 500) {
    return 'The provider returned a server error. Retry, or check the provider status page.';
  }
  return undefined;
}
