/**
 * Agent Assist V1 Compatibility Facade — constants.
 */

/** Max request body bytes accepted by the facade. */
export const AGENT_ASSIST_MAX_BODY_BYTES = 512 * 1024;

/** Max characters allowed per V1 `input[].content` text payload. */
export const AGENT_ASSIST_MAX_INPUT_CHARS = 16_000;

/** Max history messages accepted via `metadata.aa_uamsgs`. */
export const AGENT_ASSIST_MAX_AA_HISTORY_MSGS = 50;

/** Reserved transport/credential keys stripped from V1 metadata before forwarding (FR-21). */
export const AGENT_ASSIST_RESERVED_METADATA_KEYS = new Set([
  'history',
  'token',
  'credentials',
  'apiKey',
  'apiKeyId',
  'authorization',
  'sessionId',
  'runId',
  'bindingId',
  'tenantId',
  'projectId',
  'orgId',
  'userId',
  '_agentAssist',
]);

/** SSE heartbeat interval for the V1 facade stream (ms). Kept short enough for proxies. */
export const AGENT_ASSIST_SSE_HEARTBEAT_MS = 15_000;

/** Canonical V1 source tag stamped on session metadata for Observatory / billing filtering. */
export const AGENT_ASSIST_SOURCE_TAG = 'agent_suggestions';

/** `callerContext.facade` identifier for V1 compat traffic. */
export const AGENT_ASSIST_FACADE_TAG = 'agent_assist_v1';
