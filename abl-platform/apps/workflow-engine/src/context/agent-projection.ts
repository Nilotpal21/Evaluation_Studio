/**
 * Agent projection materializers.
 *
 * The runtime (`workflow-tool-executor.ts`) builds an initial projection from
 * `Session` data and forwards it as `triggerMetadata.agentSession` /
 * `.agentContext`. When the workflow-engine receives the trigger, we MUST
 * re-project — the inbound payload is untrusted and may carry extra fields
 * (older runtime versions, malformed JSON, deliberate exfiltration).
 *
 * Both materializers:
 *  1. Construct a NEW object using ONLY the positive-list TOP-LEVEL fields
 *     from §1.2 of the LLD. Top-level wrappers (sessionId, agentName,
 *     channel, source, caller, invocation, attachments) are reconstructed
 *     field-by-field — spread (`{...input}`) is FORBIDDEN at this layer so
 *     extras on the inbound payload never appear as agentSession/agentContext
 *     keys in workflow scope. Each attachment is also field-by-field.
 *  2. Two intentionally OPEN-ENDED sub-objects are passed through with
 *     spread: `invocation.args` (LLM-tool-call arguments — open by design)
 *     and `agentContext.messageMetadata` (channel/transport metadata —
 *     forwarded as-is). These are documented as transparent pass-throughs
 *     in the feature spec; do not assume positive-list filtering inside
 *     them.
 *  3. Recursively `Object.freeze` every nested object/array up to depth 4
 *     (sufficient for the schema). Frozen objects throw on assignment in
 *     strict mode (which the function-node isolate runs in).
 *
 * Returning `undefined` is a valid outcome — agent-less webhook/cron runs
 * have no agent session.
 */

import type { AgentContextProjection, AgentSessionProjection } from './expression-resolver.js';

const MAX_DEPTH = 4;

/**
 * Hard cap on `messageMetadata` size (bytes of JSON-serialized form).
 *
 * `messageMetadata` is intentionally pass-through (channel/transport metadata
 * forwarded as-is from the runtime). It can carry channel-specific PII —
 * voice-channel phone numbers, email subject/Message-Id, web SDK headers, etc.
 * The HLD (`docs/specs/workflow-first-class-memory-and-context.hld.md` §10.2,
 * Concern 12) accepts the privacy pass-through with the expectation that the
 * runtime emits only what the channel adapter authorized at the trigger
 * boundary. Without an upper bound, however, an oversize payload propagated
 * across the trigger boundary would be deep-frozen, copied into every isolate
 * for every function-node execution, and re-frozen on each entry — turning
 * a single bad call into recurring isolate-boundary work.
 *
 * 16 KiB is comfortably above any realistic channel header set we ship today
 * (web SDK ≈ 1 KiB, voice ≈ 0.5 KiB, A2A ≈ 2 KiB) and well below the projection
 * payload cap. Oversized messageMetadata is dropped (not truncated) so the
 * workflow author sees an empty `messageMetadata` rather than a partial /
 * silently-corrupted record.
 */
const MAX_MESSAGE_METADATA_BYTES = 16 * 1024;

/**
 * Returns true when the JSON-serialized form of the metadata fits within
 * `MAX_MESSAGE_METADATA_BYTES`. Failure modes (circular reference, BigInt,
 * non-serializable value) are treated as oversized — the projection drops
 * the field rather than crash the workflow run.
 */
function fitsMetadataCap(metadata: Record<string, unknown>): boolean {
  let serialized: string;
  try {
    serialized = JSON.stringify(metadata);
  } catch {
    return false;
  }
  if (typeof serialized !== 'string') return false;
  return Buffer.byteLength(serialized, 'utf8') <= MAX_MESSAGE_METADATA_BYTES;
}

/**
 * Recursively freeze an object/array up to MAX_DEPTH. Stops at primitives,
 * already-frozen values, and depth limit. Mutates in place AND returns the
 * input for chaining. Safe on null/undefined.
 */
export function deepFreeze<T>(value: T, depth = 0): T {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;
  if (Object.isFrozen(value)) return value;
  if (depth >= MAX_DEPTH) {
    Object.freeze(value);
    return value;
  }
  Object.freeze(value);
  for (const key of Object.keys(value as Record<string, unknown>)) {
    const v = (value as Record<string, unknown>)[key];
    if (v !== null && typeof v === 'object') deepFreeze(v, depth + 1);
  }
  return value;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function asArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

/**
 * Project untrusted input into an AgentSessionProjection. Returns undefined
 * when required fields (sessionId, agentName, channel, source) are missing —
 * a partial projection would mislead workflow code into thinking it has a
 * real session when fields are silently undefined.
 */
export function materializeAgentSession(
  input: unknown,
): Readonly<AgentSessionProjection> | undefined {
  const obj = asRecord(input);
  if (!obj) return undefined;
  const sessionId = asString(obj.sessionId);
  const agentName = asString(obj.agentName);
  const channel = asString(obj.channel);
  const source = asString(obj.source);
  const startedAt = asString(obj.startedAt);
  const lastActivityAt = asString(obj.lastActivityAt);
  if (!sessionId || !agentName || !channel) return undefined;
  if (source !== 'public' && source !== 'channel' && source !== 'studio-debug') return undefined;
  if (!startedAt || !lastActivityAt) return undefined;
  const projection: AgentSessionProjection = {
    sessionId,
    agentName,
    channel,
    source,
    endUserId: asString(obj.endUserId),
    locale: asString(obj.locale),
    startedAt,
    lastActivityAt,
  };
  return deepFreeze(projection) as Readonly<AgentSessionProjection>;
}

/**
 * Project untrusted input into an AgentContextProjection. Returns undefined
 * when caller or invocation are unrecognizable. Each attachment is
 * reconstructed field-by-field, so unknown attachment keys are dropped.
 * `invocation.args` and `messageMetadata` are intentionally passed through
 * via spread — they are open-ended payloads forwarded as-is from the
 * trigger boundary (see file-level docstring above).
 */
export function materializeAgentContext(
  input: unknown,
): Readonly<AgentContextProjection> | undefined {
  const obj = asRecord(input);
  if (!obj) return undefined;
  const caller = asRecord(obj.caller);
  const invocation = asRecord(obj.invocation);
  if (!caller || !invocation) return undefined;
  const callerType = asString(caller.type);
  const callerId = asString(caller.id);
  const tool = asString(invocation.tool);
  if (!callerType || !callerId || !tool) return undefined;
  const args = asRecord(invocation.args) ?? {};
  const attachmentsRaw = asArray(obj.attachments) ?? [];
  const attachments = attachmentsRaw
    .map((a) => {
      const ar = asRecord(a);
      if (!ar) return undefined;
      const id = asString(ar.id);
      const mimeType = asString(ar.mimeType);
      const sizeBytes = typeof ar.sizeBytes === 'number' ? ar.sizeBytes : undefined;
      const name = asString(ar.name);
      if (!id || !mimeType || sizeBytes === undefined || !name) return undefined;
      return { id, mimeType, sizeBytes, name };
    })
    .filter((a): a is NonNullable<typeof a> => a !== undefined);
  const messageMetadataRaw = asRecord(obj.messageMetadata);
  // Drop oversize messageMetadata at the projection boundary. See
  // MAX_MESSAGE_METADATA_BYTES docstring above for the privacy/perf rationale.
  const messageMetadata =
    messageMetadataRaw && fitsMetadataCap(messageMetadataRaw)
      ? { ...messageMetadataRaw }
      : undefined;
  const projection: AgentContextProjection = {
    caller: { type: callerType, id: callerId },
    invocation: { tool, args: { ...args } },
    attachments,
    messageMetadata,
  };
  return deepFreeze(projection) as Readonly<AgentContextProjection>;
}
