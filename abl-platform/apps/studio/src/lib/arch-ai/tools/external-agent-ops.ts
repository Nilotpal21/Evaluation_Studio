import { z } from 'zod';
import { createLogger } from '@abl/compiler/platform/logger.js';
import { assertUrlSafeForSSRF } from '@agent-platform/shared-kernel/security';
import { checkToolPermission, isDangerousAction, type ToolPermissionContext } from '../guards';
import { consumeFlowSecrets } from './secret-store';

/**
 * external_agent_ops — arch-ai tool for managing external A2A agent configs.
 *
 * Mirrors `mcp-server-ops.ts` structure. Owned by `integration-methodologist`.
 * Proxies CRUD to `${NEXTAUTH_URL}/api/projects/:projectId/external-agents/...`,
 * which forwards to runtime `apps/runtime/src/routes/external-agents.ts`.
 *
 * `discover_preview` is implemented natively (no SDK dep) — fetches the
 * `/.well-known/agent-card.json` URI directly with SSRF validation, redirect
 * rejection, and a 256KB payload cap. The Zod safety-net schema (D-11)
 * guards against malformed responses.
 *
 * Pure helpers exported for unit testing:
 *   - `parseAndValidateAgentCard` — Zod safety-net
 *   - `synthesizeHandoffBlock`    — DSL preview generator
 *   - `validateExternalAgentEndpoint` — SSRF wrapper
 */

const log = createLogger('arch-ai:external-agent-ops');

// ─── Constants ───────────────────────────────────────────────────────────

const EXTERNAL_AGENT_AUTH_TYPES = ['none', 'bearer', 'api_key'] as const;
type ExternalAgentAuthType = (typeof EXTERNAL_AGENT_AUTH_TYPES)[number];

type ExternalAgentAction =
  | 'list'
  | 'read'
  | 'discover_preview'
  | 'create'
  | 'update'
  | 'delete'
  | 'test_connection';

const DISCOVER_TIMEOUT_MS = 5_000;
const DISCOVER_MAX_BYTES = 256 * 1024;
const API_TIMEOUT_MS = 30_000;
const AGENT_CARD_PATH = '/.well-known/agent-card.json';

// ─── Input/Output Types ──────────────────────────────────────────────────

interface ExternalAgentOpsInput {
  action: ExternalAgentAction;
  agentId?: string;
  // create/update fields:
  name?: string;
  displayName?: string | null;
  endpoint?: string;
  protocol?: 'a2a' | 'rest';
  authType?: ExternalAgentAuthType;
  /** Non-secret fields like `header` (for api_key custom header name). Secrets enter via flowId. */
  authConfig?: Record<string, unknown>;
  // secret flow:
  flowId?: string;
  // delete:
  confirmed?: boolean;
}

export interface ExternalAgentOpsResult {
  success?: boolean;
  data?: unknown;
  error?: { code: string; message: string };
  needsSecrets?: boolean;
  flowId?: string;
  requiredSecrets?: string[];
  message?: string;
  needsConfirmation?: boolean;
  warning?: string;
}

// ─── Zod safety-net schema for AgentCard responses (D-11) ────────────────

const SkillSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  inputSchema: z.unknown().optional(),
  outputSchema: z.unknown().optional(),
});

const AgentCardSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  url: z.string().optional(),
  protocolVersion: z.string().optional(),
  skills: z.array(SkillSchema).optional(),
  capabilities: z.record(z.unknown()).optional(),
});

export type DiscoveredCardPreview = z.infer<typeof AgentCardSchema>;

// ─── Pure Helpers (exported for unit testing) ────────────────────────────

/**
 * Parse + validate a discovered AgentCard payload (D-11 safety net).
 *
 * The schema is a SUBSET of `@a2a-js/sdk`'s `AgentCard` — only the fields
 * downstream consumers (UI card, handoff synthesizer) actually rely on.
 * Unknown future fields are stripped, not rejected.
 */
export function parseAndValidateAgentCard(
  json: unknown,
): { ok: true; card: DiscoveredCardPreview } | { ok: false; error: string } {
  const result = AgentCardSchema.safeParse(json);
  if (!result.success) {
    // Include the field path so callers can match on the missing/invalid
    // field name (e.g. "name: Required") instead of just the bare Zod
    // message — needed by both LLM error feedback and unit tests.
    const error = result.error.issues
      .map((i) => {
        const path = i.path.length > 0 ? i.path.join('.') : 'card';
        return `${path}: ${i.message}`;
      })
      .join('; ');
    return { ok: false, error };
  }
  return { ok: true, card: result.data };
}

/**
 * Generate a HANDOFF DSL block from a discovered AgentCard.
 *
 * Output is a server-side text descriptor — no HTML, no script evaluation.
 * Credentials, raw `inputSchema` payloads, and capability sub-fields are NOT
 * emitted — the runtime resolves auth/endpoint at handoff time from the
 * ExternalAgentConfig record.
 */
/**
 * Strip script/markup-like content and control characters from a free-text
 * field that originated from a discovered AgentCard before embedding it in
 * a server-side DSL block. The DSL is text-only (not HTML), but the same
 * value flows into LLM prompts and Studio renders, so we eliminate
 * obvious injection vectors at the synthesis boundary.
 */
function sanitizeFreeText(input: string, maxLen = 500): string {
  return input
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<\/?[a-zA-Z][^>]*>/g, '')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
}

export function synthesizeHandoffBlock(card: DiscoveredCardPreview, agentName?: string): string {
  const name = agentName ?? card.name;
  const lines = [`HANDOFF: ${name}`, `  - method: a2a`];
  if (card.url) {
    lines.push(`  - endpoint: ${card.url}`);
  }
  const skillNames =
    card.skills && card.skills.length > 0
      ? card.skills.map((s) => sanitizeFreeText(s.name, 80)).join(', ')
      : undefined;
  const rawDesc = card.description ?? skillNames;
  const desc = rawDesc ? sanitizeFreeText(rawDesc) : undefined;
  if (desc) {
    lines.push(`  - description: ${desc}`);
  }
  return lines.join('\n');
}

/**
 * SSRF-safe endpoint guard. Wraps `assertUrlSafeForSSRF` with:
 *  - explicit userinfo rejection (credential-leak vector)
 *  - structured `{ ok, error }` envelope (no thrown exceptions)
 *
 * R7 RISK #2 deferred items (out of Spec 1 scope, tracked as shared-kernel
 * follow-ups):
 *  - DNS rebinding pinning (custom undici dispatcher)
 *  - These deferrals are documented in `url-ssrf-validator.test.ts`.
 */
export function validateExternalAgentEndpoint(
  url: string,
  allowPrivate: boolean,
): { ok: true } | { ok: false; error: { code: string; message: string } } {
  if (!url || typeof url !== 'string') {
    return { ok: false, error: { code: 'SSRF_REJECTED', message: 'URL is required' } };
  }
  try {
    const parsed = new URL(url);
    if (parsed.username || parsed.password) {
      return {
        ok: false,
        error: { code: 'SSRF_REJECTED', message: 'URL must not contain userinfo' },
      };
    }
  } catch {
    return { ok: false, error: { code: 'SSRF_REJECTED', message: 'URL is malformed' } };
  }
  try {
    assertUrlSafeForSSRF(
      url,
      allowPrivate ? { allowLocalhost: true, allowPrivateRanges: true } : {},
    );
    return { ok: true };
  } catch (err: unknown) {
    return {
      ok: false,
      error: {
        code: 'SSRF_REJECTED',
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

// ─── Internal helpers ────────────────────────────────────────────────────

function getStudioBaseUrl(): string {
  return process.env.NEXTAUTH_URL ?? 'http://localhost:5173';
}

function isExternalAgentDevMode(): boolean {
  return process.env.NODE_ENV !== 'production';
}

function missing(param: string, action: string): ExternalAgentOpsResult {
  return {
    success: false,
    error: { code: 'MISSING_PARAM', message: `${param} is required for ${action}` },
  };
}

function isSupportedAuthType(value: string): value is ExternalAgentAuthType {
  return (EXTERNAL_AGENT_AUTH_TYPES as readonly string[]).includes(value);
}

function requiredSecretFields(authType: ExternalAgentAuthType): string[] {
  switch (authType) {
    case 'bearer':
    case 'api_key':
      return ['value'];
    default:
      return [];
  }
}

interface BuildAuthOutcome {
  result?: ExternalAgentOpsResult;
  authConfig?: { value: string; header?: string } | null;
}

async function buildAuthConfig(input: ExternalAgentOpsInput): Promise<BuildAuthOutcome> {
  if (!input.authType || input.authType === 'none') {
    return { authConfig: null };
  }
  if (!isSupportedAuthType(input.authType)) {
    return {
      result: {
        success: false,
        error: {
          code: 'UNSUPPORTED_AUTH_TYPE',
          message: `External agent authType "${input.authType}" is not supported. Use: ${EXTERNAL_AGENT_AUTH_TYPES.join(', ')}`,
        },
      },
    };
  }
  const required = requiredSecretFields(input.authType);
  if (required.length > 0 && !input.flowId) {
    const flowId = crypto.randomUUID();
    return {
      result: {
        success: false,
        needsSecrets: true,
        flowId,
        requiredSecrets: required,
        message: `Use collect_secret with flowId "${flowId}" for each required field, then call external_agent_ops again with the flowId.`,
      },
    };
  }
  let secrets: Record<string, string> = {};
  if (input.flowId) {
    const consumed = await consumeFlowSecrets(input.flowId);
    if (!consumed) {
      return {
        result: {
          success: false,
          error: {
            code: 'SECRETS_EXPIRED',
            message:
              'Secrets for this flow have expired or were already consumed. Start a new external-agent auth flow.',
          },
        },
      };
    }
    secrets = consumed;
  }
  for (const field of required) {
    if (!secrets[field]) {
      return {
        result: {
          success: false,
          error: {
            code: 'MISSING_SECRET',
            message: `Missing collected external-agent secret field "${field}".`,
          },
        },
      };
    }
  }
  // Caller-supplied non-secret fields (e.g., custom header name) survive.
  const supplied = input.authConfig ?? {};
  if (input.authType === 'bearer') {
    return { authConfig: { value: secrets.value } };
  }
  // api_key
  const headerName =
    typeof supplied.header === 'string' && supplied.header.trim()
      ? supplied.header.trim()
      : undefined;
  return {
    authConfig: { value: secrets.value, ...(headerName ? { header: headerName } : {}) },
  };
}

function buildCreatePayload(
  input: ExternalAgentOpsInput,
  authConfig: BuildAuthOutcome['authConfig'],
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    name: input.name,
    endpoint: input.endpoint,
    protocol: input.protocol ?? 'a2a',
    authType: input.authType ?? 'none',
  };
  if (input.displayName !== undefined) payload.displayName = input.displayName;
  if (authConfig) payload.authConfig = authConfig;
  return payload;
}

function buildUpdatePayload(
  input: ExternalAgentOpsInput,
  authConfig: BuildAuthOutcome['authConfig'] | undefined,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (input.displayName !== undefined) patch.displayName = input.displayName;
  if (input.endpoint !== undefined) patch.endpoint = input.endpoint;
  if (input.protocol !== undefined) patch.protocol = input.protocol;
  if (input.authType !== undefined) patch.authType = input.authType;
  if (authConfig !== undefined) patch.authConfig = authConfig;
  return patch;
}

async function apiFetch(
  path: string,
  ctx: ToolPermissionContext,
  options?: RequestInit,
): Promise<Response> {
  const url = `${getStudioBaseUrl()}/api/projects/${encodeURIComponent(ctx.projectId)}${path}`;
  return fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${ctx.authToken}`,
      'X-Tenant-Id': ctx.user.tenantId,
      'X-Project-Id': ctx.projectId,
      'X-User-Id': ctx.user.userId,
      ...(options?.headers ?? {}),
    },
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
}

async function parseApiResult(
  res: Response,
  fallbackCode: string,
): Promise<ExternalAgentOpsResult> {
  // 204 No Content has no JSON body — encode as success: true with deletion sentinel.
  if (res.status === 204) {
    return { success: true, data: { deleted: true } };
  }
  const body = await res.json().catch((err) => {
    log.warn('parseApiResult JSON decode failed', {
      status: res.status,
      error: err instanceof Error ? err.message : String(err),
    });
    return {};
  });
  if (!res.ok) {
    const error = (body as { error?: { code?: string; message?: string } }).error;
    return {
      success: false,
      error: {
        code: error?.code ?? fallbackCode,
        message: error?.message ?? `External agent API failed: ${res.status}`,
      },
    };
  }
  return { success: true, data: body };
}

// ─── Action handlers ─────────────────────────────────────────────────────

async function discoverPreview(
  input: ExternalAgentOpsInput,
  ctx: ToolPermissionContext,
): Promise<ExternalAgentOpsResult> {
  if (!input.endpoint) return missing('endpoint', input.action);
  const allowPrivate = isExternalAgentDevMode();
  const ssrf = validateExternalAgentEndpoint(input.endpoint, allowPrivate);
  if (!ssrf.ok) {
    return { success: false, error: ssrf.error };
  }
  const cardUrl = input.endpoint.replace(/\/$/, '') + AGENT_CARD_PATH;
  try {
    const res = await fetch(cardUrl, {
      // R7 RISK #2 (b) — refuse to follow redirects (could land on 127.0.0.1).
      redirect: 'manual',
      signal: AbortSignal.timeout(DISCOVER_TIMEOUT_MS),
      headers: { Accept: 'application/json' },
    });
    if (res.status >= 300 && res.status < 400) {
      return {
        success: false,
        error: {
          code: 'REDIRECT_REJECTED',
          message: `Agent card endpoint returned redirect status ${res.status}; refusing to follow.`,
        },
      };
    }
    if (!res.ok) {
      return {
        success: false,
        error: {
          code: 'DISCOVER_FAILED',
          message: `Agent card fetch returned HTTP ${res.status}`,
        },
      };
    }
    // R1 MED-5 — payload cap. Prefer Content-Length; verify after read as well.
    const contentLength = res.headers.get('content-length');
    if (contentLength && Number(contentLength) > DISCOVER_MAX_BYTES) {
      return {
        success: false,
        error: {
          code: 'CARD_TOO_LARGE',
          message: `Agent card exceeds ${DISCOVER_MAX_BYTES}-byte cap (Content-Length: ${contentLength})`,
        },
      };
    }
    // R1 MED-5 hardening — stream the body and abort once the cap is reached
    // so a malicious endpoint omitting Content-Length cannot OOM the Studio
    // pod by serving a multi-GB payload (round-5 H-4).
    const reader = res.body?.getReader();
    if (!reader) {
      return {
        success: false,
        error: {
          code: 'DISCOVER_FAILED',
          message: 'Agent card response had no body',
        },
      };
    }
    const decoder = new TextDecoder();
    const chunks: string[] = [];
    let totalBytes = 0;
    let aborted = false;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        totalBytes += value.byteLength;
        if (totalBytes > DISCOVER_MAX_BYTES) {
          aborted = true;
          await reader.cancel().catch((err: unknown) => {
            log.warn('reader cancel failed', {
              error: err instanceof Error ? err.message : String(err),
            });
          });
          break;
        }
        chunks.push(decoder.decode(value, { stream: true }));
      }
    } finally {
      reader.releaseLock();
    }
    if (aborted) {
      return {
        success: false,
        error: {
          code: 'CARD_TOO_LARGE',
          message: `Agent card exceeds ${DISCOVER_MAX_BYTES}-byte cap`,
        },
      };
    }
    chunks.push(decoder.decode());
    const text = chunks.join('');
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err: unknown) {
      return {
        success: false,
        error: {
          code: 'CARD_INVALID',
          message: `Agent card is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
        },
      };
    }
    const validated = parseAndValidateAgentCard(parsed);
    if (!validated.ok) {
      return {
        success: false,
        error: { code: 'CARD_INVALID', message: validated.error },
      };
    }
    const handoffPreview = synthesizeHandoffBlock(validated.card, input.name);
    return {
      success: true,
      data: {
        card: validated.card,
        handoffPreview,
      },
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('discover_preview failed', {
      action: input.action,
      projectId: ctx.projectId,
      error: message,
    });
    return {
      success: false,
      error: { code: 'DISCOVER_FAILED', message },
    };
  }
}

async function createAgent(
  input: ExternalAgentOpsInput,
  ctx: ToolPermissionContext,
): Promise<ExternalAgentOpsResult> {
  if (!input.name) return missing('name', input.action);
  if (!input.endpoint) return missing('endpoint', input.action);
  // Pre-flight SSRF on the endpoint — short-circuits before HTTP.
  const ssrf = validateExternalAgentEndpoint(input.endpoint, isExternalAgentDevMode());
  if (!ssrf.ok) return { success: false, error: ssrf.error };

  const auth = await buildAuthConfig(input);
  if (auth.result) return auth.result;

  const res = await apiFetch('/external-agents', ctx, {
    method: 'POST',
    body: JSON.stringify(buildCreatePayload(input, auth.authConfig)),
  });
  return parseApiResult(res, 'CREATE_FAILED');
}

async function updateAgent(
  input: ExternalAgentOpsInput,
  ctx: ToolPermissionContext,
): Promise<ExternalAgentOpsResult> {
  if (!input.agentId) return missing('agentId', input.action);

  // Re-validate SSRF only when the endpoint is being changed.
  if (input.endpoint !== undefined) {
    const ssrf = validateExternalAgentEndpoint(input.endpoint, isExternalAgentDevMode());
    if (!ssrf.ok) return { success: false, error: ssrf.error };
  }

  // authConfig only when authType is being changed.
  let auth: BuildAuthOutcome = {};
  if (input.authType !== undefined) {
    auth = await buildAuthConfig(input);
    if (auth.result) return auth.result;
  }

  const res = await apiFetch(`/external-agents/${encodeURIComponent(input.agentId)}`, ctx, {
    method: 'PATCH',
    body: JSON.stringify(buildUpdatePayload(input, auth.authConfig)),
  });
  return parseApiResult(res, 'UPDATE_FAILED');
}

// ─── Main entry ─────────────────────────────────────────────────────────

export async function executeExternalAgentOps(
  input: ExternalAgentOpsInput,
  ctx: ToolPermissionContext,
): Promise<ExternalAgentOpsResult> {
  const action = input.action;

  const perm = await checkToolPermission('external_agent_ops', action, ctx);
  if (!perm.allowed) {
    return {
      success: false,
      error: { code: 'FORBIDDEN', message: perm.error ?? 'Permission denied' },
    };
  }

  if (!ctx.authToken) {
    return {
      success: false,
      error: {
        code: 'AUTH_REQUIRED',
        message: 'Auth token required for external agent operations',
      },
    };
  }

  if (isDangerousAction('external_agent_ops', action) && !input.confirmed) {
    if (!input.agentId) return missing('agentId', action);
    return {
      needsConfirmation: true,
      warning: `Delete external agent "${input.agentId}"? This breaks any agents currently routing handoffs to it.`,
    };
  }

  try {
    switch (action) {
      case 'list':
        return parseApiResult(await apiFetch('/external-agents', ctx), 'LIST_FAILED');
      case 'read':
        if (!input.agentId) return missing('agentId', action);
        return parseApiResult(
          await apiFetch(`/external-agents/${encodeURIComponent(input.agentId)}`, ctx),
          'READ_FAILED',
        );
      case 'discover_preview':
        return discoverPreview(input, ctx);
      case 'create':
        return createAgent(input, ctx);
      case 'update':
        return updateAgent(input, ctx);
      case 'delete': {
        if (!input.agentId) return missing('agentId', action);
        return parseApiResult(
          await apiFetch(`/external-agents/${encodeURIComponent(input.agentId)}`, ctx, {
            method: 'DELETE',
          }),
          'DELETE_FAILED',
        );
      }
      case 'test_connection':
        if (!input.agentId) return missing('agentId', action);
        return parseApiResult(
          await apiFetch(
            `/external-agents/${encodeURIComponent(input.agentId)}/test-connection`,
            ctx,
            { method: 'POST', body: '{}' },
          ),
          'TEST_CONNECTION_FAILED',
        );
      default:
        return {
          success: false,
          error: { code: 'INVALID_ACTION', message: `Unknown action: ${action}` },
        };
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('external_agent_ops action failed', {
      action,
      projectId: ctx.projectId,
      error: message,
    });
    return { success: false, error: { code: 'INTERNAL_ERROR', message } };
  }
}
