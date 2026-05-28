const REDACTION = '[REDACTED]';
const TOOL_INPUT_NOT_ALLOWLISTED_REASON = 'tool_input_not_allowlisted';

const SENSITIVE_KEY_PATTERN =
  /(?:^|[_-])(authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|token|secret|client[_-]?secret|password|passwd|credential|cookie|session)(?:$|[_-])/i;

const PII_KEY_PATTERN =
  /(?:^|[_-])(email|phone|ssn|social[_-]?security|credit[_-]?card|card[_-]?number)(?:$|[_-])/i;

const STRING_REDACTION_PATTERNS: readonly [RegExp, string][] = [
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi, `Bearer ${REDACTION}`],
  [/\b(?:sk|rk|pk|abl_sk|xox[baprs]|gh[pousr])-[A-Za-z0-9_-]{12,}\b/g, REDACTION],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, REDACTION],
  [
    /\b((?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|token|secret|client[_-]?secret|password|authorization)\s*[:=]\s*["']?)[^"',\s}]{4,}/gi,
    `$1${REDACTION}`,
  ],
  [/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, REDACTION],
  [/\b\d{3}-\d{2}-\d{4}\b/g, REDACTION],
  [/\b(?:\d[ -]*?){13,19}\b/g, REDACTION],
  [/\+?\b\d{1,3}[-.\s]?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g, REDACTION],
];

export const AUDIT_PAYLOAD_TOOL_INPUT_ALLOWLIST = new Set<string>([
  'ask_user',
  'proceed_to_next_phase',
  'get_construct_spec',
  'list_valid_combinations',
  'get_cel_grammar',
  'lookup_validation_code',
  'read_agent',
  'read_topology',
  'read_journal',
  'find_memory_refs',
  'find_gather_field_refs',
  'find_tool_consumers',
  'find_agent_refs',
  'find_cel_var_refs',
  'get_topology_patterns',
  'health_check',
  'read_insights',
  'platform_context',
  'dismiss_proposal',
  'search_docs',
]);

export type AuditPayloadType = 'prompt' | 'response' | 'tool_input' | 'tool_output';

export interface AuditPayloadRedactionOptions {
  payloadType: AuditPayloadType;
  toolName?: string;
}

export function shouldCaptureToolInputPayload(toolName: string | undefined): boolean {
  if (!toolName) {
    return false;
  }
  return AUDIT_PAYLOAD_TOOL_INPUT_ALLOWLIST.has(toolName);
}

export function buildRedactedToolInputPayload(toolName: string, input: unknown): string {
  return JSON.stringify({
    _redacted: true,
    reason: TOOL_INPUT_NOT_ALLOWLISTED_REASON,
    toolName,
    inputKeys: getObjectKeys(input),
  });
}

export function redactAuditPayloadContent(
  content: string,
  options: AuditPayloadRedactionOptions,
): string {
  const parsed = parseJsonIfPossible(content);
  if (isAlreadyRedactedPayload(parsed)) {
    return JSON.stringify(parsed);
  }

  if (options.payloadType === 'tool_input' && !shouldCaptureToolInputPayload(options.toolName)) {
    return buildRedactedToolInputPayload(options.toolName ?? 'unknown', parsed);
  }

  if (parsed !== content) {
    return JSON.stringify(redactJsonValue(parsed));
  }

  return redactString(content);
}

function redactJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactJsonValue(item));
  }

  if (!value || typeof value !== 'object') {
    return typeof value === 'string' ? redactString(value) : value;
  }

  const redacted: Record<string, unknown> = {};
  for (const [key, childValue] of Object.entries(value)) {
    if (isSensitiveKey(key)) {
      redacted[key] = REDACTION;
      continue;
    }
    redacted[key] = redactJsonValue(childValue);
  }
  return redacted;
}

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(key) || PII_KEY_PATTERN.test(key);
}

function redactString(value: string): string {
  let redacted = value;
  for (const [pattern, replacement] of STRING_REDACTION_PATTERNS) {
    redacted = redacted.replace(pattern, replacement);
  }
  return redacted;
}

function parseJsonIfPossible(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    return content;
  }
}

function getObjectKeys(value: unknown): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return [];
  }
  return Object.keys(value);
}

function isAlreadyRedactedPayload(value: unknown): boolean {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (value as { _redacted?: unknown })._redacted === true
  );
}
