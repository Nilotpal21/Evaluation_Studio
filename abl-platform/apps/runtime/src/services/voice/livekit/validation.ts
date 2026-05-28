/**
 * Shared validation patterns for LiveKit IDs and names.
 * Used by both routes/livekit.ts and agent-worker.ts.
 */

export const ID_PATTERN = /^[a-zA-Z0-9_\-]{1,128}$/;
export const AGENT_NAME_PATTERN = /^[a-zA-Z0-9_\-]{1,64}$/;

export function isValidId(value: unknown): value is string {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

export function isValidAgentName(value: unknown): value is string {
  return typeof value === 'string' && AGENT_NAME_PATTERN.test(value);
}
