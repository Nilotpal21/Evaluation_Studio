import crypto from 'node:crypto';
import type {
  AgentAssistBinding,
  V1CreateSessionResponse,
  V1FileUploadConfig,
  V1SessionObject,
  V1TerminateSessionResponse,
} from './types.js';

/**
 * Kore.ai Agentic-Apps sessions contract returns `sessionId` / `userId`
 * in a specific `<prefix>-<uuid>` shape. Matching that shape keeps the
 * widget's regex-based parsing happy.
 */
const SESSION_ID_PREFIX = 's-';
const USER_ID_PREFIX = 'u-';

const NAMESPACE_SESSION = '6a2b5f3d-1e47-4f9c-88a7-5b1f2e3d8a10';
const NAMESPACE_USER = '92e1b56c-9a42-4b4d-be76-7e8d6f1a2c34';

function stableId(prefix: string, namespace: string, name: string): string {
  // SHA-1-derived UUIDv5-shaped string: deterministic per (namespace, name).
  // Node's crypto module has no native v5 helper; if the caller needs strict
  // RFC-4122 v5 semantics, swap in the `uuid` package's `v5` here.
  const hash = crypto
    .createHash('sha1')
    .update(namespace + name)
    .digest('hex');
  return (
    prefix +
    `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`
  );
}

function bindingKey(binding: AgentAssistBinding): string {
  return binding.apiKeyId ?? `${binding.tenantId}:${binding.appId}:${binding.environment}`;
}

/** Resolve a stable V1 sessionId from (binding, sessionReference | userReference). */
export function sessionIdFor(binding: AgentAssistBinding, sessionReference: string): string {
  return stableId(
    SESSION_ID_PREFIX,
    NAMESPACE_SESSION,
    `${bindingKey(binding)}:${sessionReference}`,
  );
}

/** Resolve a stable V1 userId from (binding, userReference | fallback). */
export function userIdFor(
  binding: AgentAssistBinding,
  userReference: string | undefined,
  fallbackSeed: string,
): string {
  const seed = userReference && userReference.trim() ? userReference : fallbackSeed;
  return stableId(USER_ID_PREFIX, NAMESPACE_USER, `${bindingKey(binding)}:${seed}`);
}

/** Default file-upload config returned to the widget when attachments are off. */
const INERT_FILE_UPLOAD_CONFIG: V1FileUploadConfig = {
  maxFileCount: 0,
  maxFileSize: 0,
  maxTokens: 0,
  isAttachmentsEnabled: false,
};

/** Conservative MIME allowlist matching what Kore.ai's widget displays. */
const DEFAULT_ALLOWED_MIME_TYPES = ['pdf', 'docx', 'doc', 'txt', 'json', 'csv', 'png', 'jpg'];

export interface CreateSessionInput {
  binding: AgentAssistBinding;
  sessionReference: string | null;
  userReference: string;
  source: string;
  /**
   * Controls the Welcome_Event slot per FR-8:
   *   - `undefined` → omit (caller did not request a welcome);
   *   - `""`        → emit Welcome_Event with empty `messageToUser` (caller requested one);
   *   - non-empty   → emit with that text (reserved for future wiring to AgentIR.on_start.respond).
   */
  welcomeText?: string;
  apiKeyIdSeed?: string;
}

/**
 * Build the V1 `POST /sessions` response envelope. Local synthesis only — the
 * underlying HydratedSession is NOT created here; it is lazily created on the
 * first `runs/execute` turn. See feature spec FR-7.
 */
export function buildCreateSessionResponse(input: CreateSessionInput): V1CreateSessionResponse {
  const sessionId = sessionIdFor(input.binding, input.sessionReference ?? input.userReference);
  const userId = userIdFor(
    input.binding,
    input.userReference,
    input.apiKeyIdSeed ?? bindingKey(input.binding),
  );

  const session: V1SessionObject = {
    sessionId,
    sessionReference: input.sessionReference ?? null,
    userReference: input.userReference,
    status: 'idle',
    userId,
    createdAt: new Date().toISOString(),
    source: input.source,
  };

  const welcomeRequested = input.welcomeText !== undefined;
  const welcomeText = input.welcomeText ?? '';

  const response: V1CreateSessionResponse = {
    session,
    events: welcomeRequested
      ? [{ type: 'Welcome_Event', content: { messageToUser: welcomeText } }]
      : [],
    output: welcomeRequested ? [{ type: 'text', content: welcomeText }] : [],
    allowedMimeTypes: DEFAULT_ALLOWED_MIME_TYPES,
    fileUploadConfig: INERT_FILE_UPLOAD_CONFIG,
  };

  return response;
}

export interface TerminateSessionInput {
  binding: AgentAssistBinding;
  /** Raw identity from the terminate body: may be sessionId or sessionReference. */
  sessionId?: string;
  sessionReference?: string;
  userReference?: string;
  apiKeyIdSeed?: string;
}

export function buildTerminateSessionResponse(
  input: TerminateSessionInput,
): V1TerminateSessionResponse {
  // Resolve the canonical sessionId — if the caller passed `sessionId`, echo it;
  // otherwise derive from sessionReference like create.
  const resolvedSessionId =
    input.sessionId ??
    sessionIdFor(input.binding, input.sessionReference ?? input.userReference ?? 'unknown');
  const resolvedSessionReference = input.sessionReference ?? '';
  const resolvedUserReference = input.userReference ?? '';
  const resolvedUserId = userIdFor(
    input.binding,
    input.userReference,
    input.apiKeyIdSeed ?? bindingKey(input.binding),
  );

  return {
    status: 'terminated',
    userReference: resolvedUserReference,
    sessionReference: resolvedSessionReference,
    userId: resolvedUserId,
    sessionId: resolvedSessionId,
    appId: input.binding.appId,
    attachments: [],
  };
}
