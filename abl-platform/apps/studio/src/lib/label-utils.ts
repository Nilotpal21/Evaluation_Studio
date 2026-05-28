// apps/studio/src/lib/label-utils.ts

const HEX_16_PLUS = /^[0-9a-f]{16,}$/i;
const TRACE_SPAN_COMPOSITE = /^[0-9a-f]{8,}:[0-9a-f]{4,}$/i;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-/i;

/** Returns true if the value looks like a raw trace/span ID rather than a human label. */
export function isRawId(value: string): boolean {
  if (!value || value.length < 12) return false;
  return HEX_16_PLUS.test(value) || TRACE_SPAN_COMPOSITE.test(value) || UUID_PATTERN.test(value);
}

function safeLabel(value: unknown, fallback: string): string {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  return isRawId(value) ? fallback : value;
}

function lastSegment(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1] || path;
}

export function resolveAgentLabel(
  data: Record<string, unknown>,
  sessionAgentName?: string,
): string {
  const fromName = safeLabel(data.agentName, '');
  if (fromName) return fromName;

  const fromSnakeCaseName = safeLabel(data.agent_name, '');
  if (fromSnakeCaseName) return fromSnakeCaseName;

  if (typeof data.agent === 'string' && data.agent) {
    const seg = lastSegment(data.agent);
    const safe = safeLabel(seg, '');
    if (safe) return safe;
  }

  if (sessionAgentName) {
    const safe = safeLabel(sessionAgentName, '');
    if (safe) return safe;
  }

  return 'Agent';
}

export function resolveLLMLabel(data: Record<string, unknown>): string {
  const model = typeof data.model === 'string' && data.model ? data.model : '';
  return model ? `LLM → ${model}` : 'LLM Call';
}

export function resolveToolLabel(data: Record<string, unknown>): string {
  const name =
    typeof data.toolName === 'string' && data.toolName
      ? data.toolName
      : typeof data.tool_name === 'string' && data.tool_name
        ? data.tool_name
        : typeof data.tool === 'string' && data.tool
          ? data.tool
          : typeof data.name === 'string' && data.name
            ? data.name
            : '';
  return name ? `tool: ${name}` : 'Tool Call';
}

export function resolveDecisionLabel(data: Record<string, unknown>): string {
  const kind = typeof data.decisionKind === 'string' ? data.decisionKind : '';
  const outcome = typeof data.outcome === 'string' ? data.outcome : '';
  if (!kind && !outcome) return 'decision';
  const full = outcome ? `${kind}: ${outcome}` : kind;
  return full.length > 80 ? full.slice(0, 77) + '…' : full;
}

export function resolveHandoffLabel(data: Record<string, unknown>): string {
  const target =
    typeof data.toAgent === 'string' && data.toAgent
      ? data.toAgent
      : typeof data.agentName === 'string' && data.agentName
        ? data.agentName
        : '';
  return target ? `handoff → ${target}` : 'Handoff';
}

export function resolveDelegateLabel(data: Record<string, unknown>): string {
  const target = typeof data.targetAgent === 'string' && data.targetAgent ? data.targetAgent : '';
  return target ? `delegate → ${target}` : 'Delegate';
}
