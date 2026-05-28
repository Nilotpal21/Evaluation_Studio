/**
 * Studio Tool Test Service
 *
 * Executes tool tests directly from Studio (no runtime dependency).
 * Uses ToolBindingExecutor from @abl/compiler for all tool types.
 *
 * Loads tools from the flat project_tools collection. Builds ToolDefinition
 * from dslContent via the resolver's compileProjectTool path (parse DSL
 * properties → build per-type IR binding).
 */

import { createSandboxRunner as createCompilerSandboxRunner } from '@abl/compiler/platform/constructs/executors/sandbox-runner-factory.js';
import type { SandboxRunnerConfig } from '@abl/compiler/platform/constructs/executors/sandbox-runner-factory.js';
import type { SandboxRunner } from '@abl/compiler/platform/constructs/executors/sandbox-tool-executor.js';
import type {
  ToolCallContext,
  ToolCallResult,
  ToolMiddleware,
  ToolMiddlewareNext,
} from '@abl/compiler/platform/constructs/executors/tool-middleware.js';
import { loggingMiddleware } from '@abl/compiler/platform/constructs/executors/builtin-middleware.js';
import { createSecretScrubberMiddleware } from '@abl/compiler/platform/constructs/executors/sanitizer-middleware.js';
import type {
  ToolDefinition,
  ToolParameter,
  HttpBindingIR,
  SandboxBindingIR,
  McpBindingIR,
} from '@abl/compiler/platform/ir/schema.js';
import type { SecretsProvider } from '@abl/compiler/platform/constructs/executors/secrets-provider.js';
import type { McpClientProvider } from '@abl/compiler/platform/constructs/executors/mcp-tool-executor.js';
import type { TraceContextManager } from '@abl/compiler/platform/stores/trace-store.js';
import { ToolExecutionError } from '@agent-platform/shared';
import { getDevSSRFOptions } from '@agent-platform/shared-kernel/security';
import { findProjectToolById } from '@agent-platform/shared/repos';
import { decryptForTenantAuto } from '@agent-platform/shared/encryption';
import {
  parseDslProperties,
  parseSignatureLine,
  buildHttpBindingFromProps,
  buildSandboxBindingFromProps,
  buildMcpBindingFromProps,
  parseDslParamMetadata,
  extractRequestedOAuthScopes,
  resolveAuthProfileRef,
  type ConfigVarStoreLike,
} from '@agent-platform/shared/tools';
import {
  applyAuth,
  buildAuthProfileOAuthProviderKey,
  refreshOAuth2Token,
  resolveClientCredentialsToken,
  resolveWithGracePeriod,
  sanitizeAuthProfileError,
} from '@agent-platform/shared/services/auth-profile';
import { createLogger } from '@abl/compiler/platform/logger.js';
import { getRedisClient } from '@/lib/redis-client';
import { getOrCreateDefaultVariableNamespaceIds } from '@/lib/default-variable-namespace';

const log = createLogger('tool-test-service');

// ─── Types ───────────────────────────────────────────────────────────────

export interface ToolTestInput {
  toolId: string;
  tenantId: string;
  userId: string;
  projectId: string;
  input?: Record<string, unknown>;
  timeoutMs?: number;
  /** When true, include rendered SOAP envelope in response for debugging */
  debug?: boolean;
}

export interface ToolTestOutput {
  output: unknown;
  latencyMs: number;
  logs: string[];
  error?: string;
  errorCode?: string;
  retryable?: boolean;
  /** True when the tool executed but received a non-2xx HTTP response (is_error: true in output) */
  httpError?: boolean;
  oauthReauth?: {
    authProfileId: string;
    profileName: string;
    connectorName: string;
    scope: 'project' | 'workspace';
  };
  /** Input parameters provided for the test execution */
  params?: Record<string, unknown>;
  /** HTTP tool: request details sent */
  request?: {
    method: string;
    url: string;
    headers?: Record<string, string>;
    body?: unknown;
  };
  /** HTTP tool: response received */
  response?: {
    status: number;
    statusText?: string;
    headers?: Record<string, string>;
    body?: unknown;
  };
  /** Sandbox tool: execution context */
  sandbox?: {
    runtime: string;
    timeoutMs: number;
    memoryMb: number;
  };
  /** MCP tool: server connection details */
  mcp?: {
    server: string;
    tool: string;
    transport?: string;
  };
}

function isHttpErrorResult(executionError: string | undefined, result: unknown): boolean {
  return (
    !executionError &&
    typeof result === 'object' &&
    result !== null &&
    (result as Record<string, unknown>).is_error === true
  );
}

const DEFAULT_TIMEOUT_MS = 30_000;
const GLOBAL_ENVIRONMENT = 'global';
const DEV_ENVIRONMENT = 'dev';
const PRODUCTION_ENVIRONMENT = 'production';
const TOOL_CONFIG_VARIABLE_PATTERN = /\{\{config\.(\w+)\}\}/g;
const TENANT_SHARED_OAUTH_GRANT_USER_ID = '__tenant__';
const OAUTH_REAUTH_REQUIRED_CODE = 'OAUTH_REAUTH_REQUIRED';
const OAUTH_REAUTH_REQUIRED_MESSAGE =
  'OAuth authorization is required for this auth profile. Reconnect Profile and retry the test.';
const BODY_TYPE_CONTENT_TYPES: Record<NonNullable<HttpBindingIR['body_type']>, string> = {
  json: 'application/json',
  form: 'application/x-www-form-urlencoded',
  xml: 'application/xml',
  text: 'text/plain',
};

function toPositiveNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return value;
}

function isAuthProfileErrorCode(code: string | undefined): boolean {
  if (!code) {
    return false;
  }
  return (
    code.startsWith('AUTH_') ||
    code.startsWith('OAUTH_') ||
    code === 'MCP_TRANSPORT_NOT_TLS_CAPABLE' ||
    code === 'AUTH_TYPE_NOT_MCP_COMPATIBLE' ||
    code === 'JIT_AUTH_NOT_SUPPORTED'
  );
}

interface ToolTestOAuthReauthContext {
  authProfileId: string;
  profileName: string;
  connectorName: string;
  scope: 'project' | 'workspace';
}

class StudioToolTestOAuthReauthError extends Error {
  readonly code = OAUTH_REAUTH_REQUIRED_CODE;
  readonly statusCode: number;
  readonly reauth: ToolTestOAuthReauthContext;

  constructor(
    message: string,
    reauth: ToolTestOAuthReauthContext,
    statusCode = 401,
    options?: { cause?: unknown },
  ) {
    super(message);
    this.name = 'StudioToolTestOAuthReauthError';
    this.reauth = reauth;
    this.statusCode = statusCode;
    if (options?.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

function findOAuthReauthCause(error: unknown): StudioToolTestOAuthReauthError | null {
  const visited = new Set<unknown>();
  let current: unknown = error;

  for (let depth = 0; depth < 6; depth += 1) {
    if (!current || typeof current !== 'object' || visited.has(current)) {
      return null;
    }

    if (current instanceof StudioToolTestOAuthReauthError) {
      return current;
    }

    visited.add(current);
    current = (current as { cause?: unknown }).cause;
  }

  return null;
}

function serializeDisplayFormBody(payload: Record<string, unknown>): string {
  const form = new URLSearchParams();

  for (const [key, value] of Object.entries(payload)) {
    if (value === undefined) continue;

    if (Array.isArray(value)) {
      for (const item of value) {
        if (item !== undefined) {
          form.append(
            key,
            item !== null && typeof item === 'object' ? JSON.stringify(item) : String(item),
          );
        }
      }
      continue;
    }

    form.append(
      key,
      value !== null && typeof value === 'object' ? JSON.stringify(value) : String(value),
    );
  }

  return form.toString();
}

function encodeDisplayFormTemplateValue(value: string): string {
  const form = new URLSearchParams();
  form.append('value', value);
  return form.toString().slice('value='.length);
}

// ─── Build ToolDefinition from project_tool ─────────────────────────────

function buildToolDefinition(tool: {
  name: string;
  toolType: string;
  description: string | null;
  dslContent: string;
  variableNamespaceIds?: string[];
}): ToolDefinition {
  const props = parseDslProperties(tool.dslContent);
  const { parameters: params } = parseSignatureLine(tool.dslContent);
  const paramMeta = parseDslParamMetadata(tool.dslContent);

  const toolDef: ToolDefinition = {
    name: tool.name,
    description: tool.description || props.description || '',
    parameters: params.map((p) => {
      const meta = paramMeta.get(p.name);
      const param: ToolParameter = {
        name: p.name,
        type: p.type,
        required: p.required,
        ...(meta?.description && { description: meta.description }),
        ...(meta?.enum && { enum: meta.enum }),
        ...(meta?.default !== undefined && { default: meta.default }),
      };
      // Parse objectSchema JSON into structured properties/items for IR
      if (meta?.schema) {
        try {
          const parsed = JSON.parse(meta.schema) as Record<string, unknown>;
          if (p.type === 'array') {
            param.items = parsed as { type: string; enum?: unknown[] };
          } else if (p.type === 'object' && typeof parsed === 'object') {
            param.properties = Object.entries(parsed).map(([name, rawProp]) => {
              const prop = rawProp as Record<string, unknown>;
              return {
                name,
                type: (prop.type as string) || 'string',
                required: false,
                ...(prop.description ? { description: prop.description as string } : {}),
              };
            });
          }
        } catch {
          // Skip invalid schema JSON
        }
      }
      return param;
    }),
    returns: { type: 'object' },
    hints: {
      cacheable: false,
      latency: 'medium',
      parallelizable: true,
      side_effects: tool.toolType === 'http',
      requires_auth: props.auth !== 'none' || Boolean(props.auth_profile),
      timeout: props.timeout ? Number(props.timeout) : undefined,
    },
    tool_type: tool.toolType as 'http' | 'mcp' | 'sandbox' | 'searchai' | 'workflow',
    ...(tool.variableNamespaceIds?.length
      ? { variable_namespace_ids: tool.variableNamespaceIds }
      : {}),
    ...(props.auth_profile ? { auth_profile_ref: props.auth_profile } : {}),
    ...(props.auth_jit === 'true' ? { jit_auth: true } : {}),
    ...(props.connection ? { connection_mode: props.connection as 'per_user' | 'shared' } : {}),
    ...(props.consent ? { consent_mode: props.consent as 'preflight' | 'inline' } : {}),
  };

  switch (tool.toolType) {
    case 'http': {
      toolDef.http_binding = buildHttpBindingFromProps(
        props,
        tool.dslContent,
      ) as unknown as HttpBindingIR;
      break;
    }
    case 'sandbox': {
      toolDef.sandbox_binding = buildSandboxBindingFromProps(
        props,
        tool.dslContent,
      ) as unknown as SandboxBindingIR;
      break;
    }
    case 'mcp': {
      toolDef.mcp_binding = buildMcpBindingFromProps(props, tool.name, {
        dslContent: tool.dslContent,
      }) as unknown as McpBindingIR;
      break;
    }
  }

  return toolDef;
}

function collectToolConfigVariableRefs(
  value: unknown,
  refs: Set<string> = new Set<string>(),
): Set<string> {
  if (typeof value === 'string') {
    for (const match of value.matchAll(TOOL_CONFIG_VARIABLE_PATTERN)) {
      refs.add(match[1]);
    }
    return refs;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectToolConfigVariableRefs(item, refs);
    }
    return refs;
  }

  if (value && typeof value === 'object') {
    for (const nestedValue of Object.values(value as Record<string, unknown>)) {
      collectToolConfigVariableRefs(nestedValue, refs);
    }
  }

  return refs;
}

// ─── Secrets Provider ────────────────────────────────────────────────────

/**
 * Studio-side secrets provider.
 * Resolution chain:
 * 1. DB-backed environment variables (encrypted, namespace-scoped)
 * 2. DB-backed config variables (plaintext, namespace-scoped)
 * 3. Process environment variables (KEY and KEY uppercase)
 */
function createSecretsProvider(
  tenantId: string,
  projectId: string,
  environment: string,
  variableNamespaceIds?: string[],
): SecretsProvider {
  // Strict namespace scoping: tools ONLY resolve variables from their linked namespaces.
  // If no namespaces are linked, the tool cannot resolve any DB-backed variables.
  const hasNamespaces = variableNamespaceIds && variableNamespaceIds.length > 0;

  return {
    async getSecret(key: string): Promise<string | undefined> {
      // No linked namespaces → no variable resolution (all resolution via DB)
      if (!hasNamespaces) {
        return undefined;
      }

      // 1. DB-backed encrypted environment variables (namespace-scoped)
      try {
        const { EnvironmentVariable, VariableNamespaceMembership } =
          await import('@agent-platform/database/models');

        let envVar = await EnvironmentVariable.findOne({
          tenantId,
          projectId,
          environment,
          key,
        })
          .select('_id encryptedValue')
          .lean();

        // Base fallback: if no environment-specific override, try global
        if (!envVar) {
          envVar = await EnvironmentVariable.findOne({
            tenantId,
            projectId,
            environment: GLOBAL_ENVIRONMENT,
            key,
          })
            .select('_id encryptedValue')
            .lean();
        }

        if (envVar) {
          // Only resolve if variable belongs to one of the tool's linked namespaces
          const membership = await VariableNamespaceMembership.findOne({
            tenantId,
            projectId,
            variableId: envVar._id,
            variableType: 'env',
            namespaceId: { $in: variableNamespaceIds },
          }).lean();

          if (membership) {
            return decryptForTenantAuto(envVar.encryptedValue, tenantId);
          }
          // Variable exists but not in tool's namespaces — blocked
        }
      } catch (err) {
        log.warn('Failed to resolve env var in Studio tool test', {
          key,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      // 2. DB-backed plaintext config variables (namespace-scoped)
      try {
        const { ProjectConfigVariable, VariableNamespaceMembership } =
          await import('@agent-platform/database/models');

        const configVar = await ProjectConfigVariable.findOne({
          tenantId,
          projectId,
          key,
        })
          .select('_id value')
          .lean();

        if (configVar) {
          const membership = await VariableNamespaceMembership.findOne({
            tenantId,
            projectId,
            variableId: configVar._id,
            variableType: 'config',
            namespaceId: { $in: variableNamespaceIds },
          }).lean();

          if (membership) {
            return configVar.value;
          }
        }
      } catch (err) {
        log.warn('Failed to resolve config var in Studio tool test', {
          key,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      // Backward-compatible fallback for older ToolSecret-backed configurations.
      try {
        const { findToolSecrets } = await import('@agent-platform/shared/repos');
        const secrets = await findToolSecrets({ tenantId, projectId, toolName: key, environment });
        if (secrets.length > 0) {
          return secrets[0].encryptedValue;
        }
      } catch (err) {
        log.warn('Failed to resolve tool secret in Studio tool test', {
          key,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      // No process.env fallback — all resolution via DB
      return undefined;
    },

    // {{env.X}} resolves identically to {{secrets.X}} — same DB-backed,
    // namespace-scoped resolution chain. Delegate to getSecret.
    async getEnvVar(key: string): Promise<string | undefined> {
      return this.getSecret(key);
    },

    async getConfigVar(key: string): Promise<string | undefined> {
      try {
        const configVarStore = createConfigVarStore(tenantId, projectId, variableNamespaceIds);
        const record = await configVarStore.findConfigVar({
          tenantId,
          projectId,
          key,
          variableNamespaceIds,
        });
        return record?.value;
      } catch (err) {
        log.warn('Failed to resolve config var in Studio tool test executor', {
          key,
          error: err instanceof Error ? err.message : String(err),
        });
        return undefined;
      }
    },
  };
}

interface StudioAuthProfileRecord {
  _id: string;
  tenantId: string;
  projectId: string | null;
  name: string;
  authType: string;
  visibility?: 'shared' | 'personal';
  createdBy?: string;
  connectionMode?: 'shared' | 'per_user';
  linkedAppProfileId?: string | null;
  connector?: string;
  /**
   * Monotonic-int version (Phase 0.4 field). Required for the CK-1 cache
   * key on `oauth2_client_credentials` token resolution. Falls back to 1
   * for legacy rows that predate the backfill.
   */
  profileVersion?: number;
  config: Record<string, unknown>;
  encryptedSecrets: string;
  previousEncryptedSecrets?: string;
  rotationGracePeriodMs?: number;
  updatedAt: Date;
  expiresAt?: Date | null;
}

interface StudioOAuthGrantRecord {
  tenantId: string;
  userId: string;
  encryptedAccessToken?: string | null;
  encryptedRefreshToken?: string | null;
  scope?: string | null;
  expiresAt?: Date | string | null;
  revokedAt?: Date | null;
}

interface StudioToolAuthResult {
  headers: Record<string, string>;
  queryParams?: Record<string, string>;
  tlsOptions?: { cert: string; key: string; ca?: string; rejectUnauthorized: true };
  wsSecurityCredentials?: {
    username: string;
    password: string;
    certificate?: string;
    mustUnderstand: boolean;
  };
  signRequest?: (assembled: {
    method: string;
    url: string;
    headers: Headers;
    body?: string;
  }) => Promise<Headers>;
  digestCredentials?: {
    username: string;
    password: string;
    realm: string;
  };
  authType: string;
}

function getStudioExecutionEnvironment(): string {
  return process.env.NODE_ENV === 'production' ? PRODUCTION_ENVIRONMENT : DEV_ENVIRONMENT;
}

function isStudioTestOAuthGrantEnabled(): boolean {
  return process.env.STUDIO_TEST_OAUTH_GRANT_ENABLED !== 'false';
}

function resolveOAuthConnectionMode(profile: StudioAuthProfileRecord): 'shared' | 'per_user' {
  if (profile.connectionMode === 'per_user' || profile.connectionMode === 'shared') {
    return profile.connectionMode;
  }
  return profile.visibility === 'personal' ? 'per_user' : 'shared';
}

function resolveEffectiveOAuthConnectionMode(
  tool: Pick<ToolDefinition, 'connection_mode'>,
  profile: StudioAuthProfileRecord,
): 'shared' | 'per_user' {
  if (tool.connection_mode === 'shared' || tool.connection_mode === 'per_user') {
    return tool.connection_mode;
  }
  return resolveOAuthConnectionMode(profile);
}

function resolveOAuthGrantAppProfileId(profile: StudioAuthProfileRecord): string | null {
  if (profile.authType === 'oauth2_app') {
    return profile._id;
  }

  if (
    profile.authType === 'oauth2_token' &&
    typeof profile.linkedAppProfileId === 'string' &&
    profile.linkedAppProfileId.trim().length > 0
  ) {
    return profile.linkedAppProfileId.trim();
  }

  return null;
}

function buildOAuthReauthContext(
  profile: StudioAuthProfileRecord,
  authProfileId: string,
): ToolTestOAuthReauthContext {
  const connectorName =
    typeof profile.connector === 'string' && profile.connector.trim().length > 0
      ? profile.connector.trim()
      : profile.name;

  return {
    authProfileId,
    profileName: profile.name,
    connectorName,
    scope: profile.projectId ? 'project' : 'workspace',
  };
}

function createOAuthReauthError(
  profile: StudioAuthProfileRecord,
  authProfileId: string,
  options?: { cause?: unknown },
): StudioToolTestOAuthReauthError {
  return new StudioToolTestOAuthReauthError(
    OAUTH_REAUTH_REQUIRED_MESSAGE,
    buildOAuthReauthContext(profile, authProfileId),
    401,
    options,
  );
}

function isGrantExpired(expiresAt: Date | string | null | undefined): boolean {
  if (!expiresAt) {
    return false;
  }

  const expiresAtMs =
    expiresAt instanceof Date ? expiresAt.getTime() : new Date(String(expiresAt)).getTime();
  if (!Number.isFinite(expiresAtMs)) {
    return false;
  }

  return Date.now() >= expiresAtMs;
}

async function findStudioOAuthGrant(params: {
  tenantId: string;
  appProfileId: string;
  principalUserId: string;
}): Promise<StudioOAuthGrantRecord | null> {
  const { EndUserOAuthToken } = await import('@agent-platform/database/models');
  return (await EndUserOAuthToken.findOne({
    tenantId: params.tenantId,
    provider: buildAuthProfileOAuthProviderKey(params.appProfileId),
    userId: params.principalUserId,
    revokedAt: null,
  })
    .select('tenantId userId encryptedAccessToken encryptedRefreshToken scope expiresAt revokedAt')
    .lean()) as StudioOAuthGrantRecord | null;
}

async function resolveStudioOAuthGrantAccessToken(
  profile: StudioAuthProfileRecord,
  params: { tenantId: string; userId: string; connectionMode: 'shared' | 'per_user' },
): Promise<string> {
  const appProfileId = resolveOAuthGrantAppProfileId(profile);
  if (!appProfileId) {
    throw createOAuthReauthError(profile, profile._id);
  }

  const principalCandidates: string[] = [];
  if (params.connectionMode === 'shared') {
    principalCandidates.push(TENANT_SHARED_OAUTH_GRANT_USER_ID);
  }
  if (
    typeof params.userId === 'string' &&
    params.userId.trim().length > 0 &&
    !principalCandidates.includes(params.userId.trim())
  ) {
    principalCandidates.push(params.userId.trim());
  }
  if (
    params.connectionMode === 'shared' &&
    typeof profile.createdBy === 'string' &&
    profile.createdBy.trim().length > 0 &&
    !principalCandidates.includes(profile.createdBy.trim())
  ) {
    principalCandidates.push(profile.createdBy.trim());
  }
  if (principalCandidates.length === 0) {
    throw createOAuthReauthError(profile, appProfileId);
  }

  let grant: StudioOAuthGrantRecord | null = null;
  for (const principalUserId of principalCandidates) {
    grant = await findStudioOAuthGrant({
      tenantId: params.tenantId,
      appProfileId,
      principalUserId,
    });
    if (grant) {
      if (
        params.connectionMode === 'shared' &&
        grant.userId !== TENANT_SHARED_OAUTH_GRANT_USER_ID
      ) {
        log.warn('Studio shared auth profile using compatibility grant principal', {
          tenantId: params.tenantId,
          authProfileId: appProfileId,
          profileName: profile.name,
          grantPrincipalId: grant.userId,
        });
      }
      break;
    }
  }

  if (
    !grant ||
    typeof grant.encryptedAccessToken !== 'string' ||
    grant.encryptedAccessToken.trim().length === 0
  ) {
    throw createOAuthReauthError(profile, appProfileId);
  }

  if (!isGrantExpired(grant.expiresAt)) {
    return grant.encryptedAccessToken;
  }

  try {
    const refreshed = await refreshOAuth2Token({
      profileId: appProfileId,
      tenantId: params.tenantId,
      authScope: grant.userId === TENANT_SHARED_OAUTH_GRANT_USER_ID ? 'tenant' : 'user',
      userId: grant.userId,
      connectionMode: params.connectionMode,
      redis: getRedisClient() ?? undefined,
    });

    if (typeof refreshed.accessToken !== 'string' || refreshed.accessToken.trim().length === 0) {
      throw new Error('OAuth refresh completed without an access token');
    }

    return refreshed.accessToken;
  } catch (err) {
    log.warn('Studio tool test OAuth grant refresh failed', {
      tenantId: params.tenantId,
      authProfileId: appProfileId,
      profileName: profile.name,
      grantPrincipalId: grant.userId,
      error: err instanceof Error ? err.message : String(err),
    });
    throw createOAuthReauthError(profile, appProfileId, { cause: err });
  }
}

function getActiveAuthProfileFilter(now: Date): Record<string, unknown> {
  return {
    status: 'active',
    $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }],
  };
}

function getAuthProfileLookupCandidates(params: {
  projectId: string;
  environment: string;
  userId: string;
}): Array<{
  scopeFilter: Record<string, unknown>;
  environmentFilter: Record<string, unknown>;
  visibilityFilter: Record<string, unknown>;
}> {
  const scopeFilters = [
    { projectId: params.projectId },
    { projectId: null },
    { projectId: { $exists: false } },
  ];
  const environmentFilters = [
    { environment: params.environment },
    { environment: null },
    { environment: { $exists: false } },
  ];
  const visibilityFilters = [
    { visibility: 'personal', createdBy: params.userId },
    { visibility: 'shared' },
  ];

  const candidates: Array<{
    scopeFilter: Record<string, unknown>;
    environmentFilter: Record<string, unknown>;
    visibilityFilter: Record<string, unknown>;
  }> = [];

  for (const scopeFilter of scopeFilters) {
    for (const environmentFilter of environmentFilters) {
      for (const visibilityFilter of visibilityFilters) {
        candidates.push({ scopeFilter, environmentFilter, visibilityFilter });
      }
    }
  }

  return candidates;
}

function createConfigVarStore(
  tenantId: string,
  projectId: string,
  variableNamespaceIds?: string[],
): ConfigVarStoreLike {
  return {
    async findConfigVar(params) {
      if (!variableNamespaceIds || variableNamespaceIds.length === 0) {
        return null;
      }

      const { ProjectConfigVariable, VariableNamespaceMembership } =
        await import('@agent-platform/database/models');

      const configVar = await ProjectConfigVariable.findOne({
        tenantId,
        projectId,
        key: params.key,
      })
        .select('_id value')
        .lean();

      if (!configVar) {
        return null;
      }

      const membership = await VariableNamespaceMembership.findOne({
        tenantId,
        projectId,
        variableId: configVar._id,
        variableType: 'config',
        namespaceId: { $in: params.variableNamespaceIds ?? variableNamespaceIds },
      }).lean();

      if (!membership) {
        return null;
      }

      return { value: configVar.value };
    },
  };
}

async function resolveEffectiveToolVariableNamespaceIds(params: {
  tenantId: string;
  projectId: string;
  createdBy: string;
  variableNamespaceIds?: string[];
}): Promise<string[]> {
  if (params.variableNamespaceIds && params.variableNamespaceIds.length > 0) {
    return params.variableNamespaceIds;
  }

  return getOrCreateDefaultVariableNamespaceIds({
    tenantId: params.tenantId,
    projectId: params.projectId,
    createdBy: params.createdBy,
    required: true,
  });
}

async function loadToolConfigVariablesMap(params: {
  tool: ToolDefinition;
  tenantId: string;
  projectId: string;
  variableNamespaceIds?: string[];
}): Promise<Record<string, string>> {
  const configKeys = new Set<string>();
  for (const [key, value] of Object.entries(params.tool as unknown as Record<string, unknown>)) {
    if (key === 'auth_profile_ref') {
      continue;
    }
    collectToolConfigVariableRefs(value, configKeys);
  }
  if (configKeys.size === 0) {
    return {};
  }

  const configVarStore = createConfigVarStore(
    params.tenantId,
    params.projectId,
    params.variableNamespaceIds ?? params.tool.variable_namespace_ids,
  );
  const configVariables: Record<string, string> = {};

  for (const key of configKeys) {
    try {
      const resolved = await configVarStore.findConfigVar({
        tenantId: params.tenantId,
        projectId: params.projectId,
        key,
        variableNamespaceIds: params.variableNamespaceIds ?? params.tool.variable_namespace_ids,
      });

      if (resolved?.value !== undefined) {
        configVariables[key] = resolved.value;
      }
    } catch (err) {
      log.warn('Failed to load Studio tool test config variable', {
        toolName: params.tool.name,
        key,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return configVariables;
}

function resolveToolConfigVariableTemplates(
  tool: ToolDefinition,
  configVariables: Record<string, string>,
): { errors: string[]; warnings: string[]; used: Set<string> } {
  const errors: string[] = [];
  const used = new Set<string>();

  function walkAndReplace(value: unknown): unknown {
    if (typeof value === 'string') {
      return value.replace(TOOL_CONFIG_VARIABLE_PATTERN, (match, key: string) => {
        if (key in configVariables) {
          used.add(key);
          return configVariables[key];
        }
        errors.push(`Undefined config variable "${key}" referenced in agent "${tool.name}"`);
        return match;
      });
    }

    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        value[index] = walkAndReplace(value[index]);
      }
      return value;
    }

    if (value !== null && typeof value === 'object') {
      for (const key of Object.keys(value as Record<string, unknown>)) {
        (value as Record<string, unknown>)[key] = walkAndReplace(
          (value as Record<string, unknown>)[key],
        );
      }
    }

    return value;
  }

  const toolRecord = tool as unknown as Record<string, unknown>;
  for (const key of Object.keys(toolRecord)) {
    if (key === 'auth_profile_ref') {
      continue;
    }
    toolRecord[key] = walkAndReplace(toolRecord[key]);
  }

  return { errors, warnings: [], used };
}

async function resolveStudioAuthProfileByName(params: {
  name: string;
  tenantId: string;
  projectId: string;
  userId: string;
  environment: string;
}): Promise<StudioAuthProfileRecord | null> {
  const { AuthProfile } = await import('@agent-platform/database/models');
  const now = new Date();
  const candidates = getAuthProfileLookupCandidates(params);

  for (const { scopeFilter, environmentFilter, visibilityFilter } of candidates) {
    const profile = (await AuthProfile.findOne({
      name: params.name,
      tenantId: params.tenantId,
      ...getActiveAuthProfileFilter(now),
      ...scopeFilter,
      ...environmentFilter,
      ...visibilityFilter,
    })
      .select(
        '_id tenantId projectId name visibility createdBy authType connectionMode linkedAppProfileId connector profileVersion config encryptedSecrets previousEncryptedSecrets rotationGracePeriodMs updatedAt expiresAt',
      )
      .lean()) as StudioAuthProfileRecord | null;

    if (profile) {
      return profile;
    }
  }

  return null;
}

async function resolveStudioAuthProfileSecrets(
  profile: StudioAuthProfileRecord,
  tenantId: string,
): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(profile.encryptedSecrets) as Record<string, unknown>;
  } catch {
    return resolveWithGracePeriod(
      {
        encryptedSecrets: profile.encryptedSecrets,
        previousEncryptedSecrets: profile.previousEncryptedSecrets,
        rotationGracePeriodMs: profile.rotationGracePeriodMs,
        updatedAt: profile.updatedAt,
      },
      (ciphertext) => decryptForTenantAuto(ciphertext, tenantId),
    );
  }
}

function toScopeList(scopes: unknown): string[] {
  if (Array.isArray(scopes)) {
    return scopes.filter((scope): scope is string => typeof scope === 'string' && scope.length > 0);
  }

  if (typeof scopes === 'string') {
    return scopes
      .split(/[\s,]+/u)
      .map((scope) => scope.trim())
      .filter((scope) => scope.length > 0);
  }

  return [];
}

function patchToolWithResolvedAuth(
  tool: NonNullable<ToolCallContext['tool']>,
  headers: Record<string, string>,
  queryParams?: Record<string, string>,
  tlsOptions?: { cert: string; key: string; ca?: string; rejectUnauthorized: true },
  wsSecurityCredentials?: {
    username: string;
    password: string;
    certificate?: string;
    mustUnderstand: boolean;
  },
  signRequest?: (assembled: {
    method: string;
    url: string;
    headers: Headers;
    body?: string;
  }) => Promise<Headers>,
  digestCredentials?: {
    username: string;
    password: string;
    realm: string;
  },
): NonNullable<ToolCallContext['tool']> {
  return {
    ...tool,
    http_binding: tool.http_binding
      ? {
          ...tool.http_binding,
          headers: {
            ...(tool.http_binding.headers ?? {}),
            ...headers,
          },
          query_params: {
            ...(tool.http_binding.query_params ?? {}),
            ...(queryParams ?? {}),
          },
          ...(tlsOptions ? { tls_options: tlsOptions } : {}),
          ...(wsSecurityCredentials ? { _wsSecurityCredentials: wsSecurityCredentials } : {}),
          ...(signRequest ? { _authSignRequest: signRequest } : {}),
          ...(digestCredentials ? { _digestCredentials: digestCredentials } : {}),
          auth: { type: 'none' as const },
        }
      : tool.http_binding,
  };
}

async function resolveStudioToolAuth(
  tool: Pick<
    ToolDefinition,
    'auth_profile_ref' | 'connection_mode' | 'http_binding' | 'name' | 'variable_namespace_ids'
  >,
  params: {
    tenantId: string;
    projectId: string;
    userId: string;
    environment: string;
  },
): Promise<StudioToolAuthResult> {
  if (!tool.auth_profile_ref) {
    throw new Error(`Tool "${tool.name}" is missing auth_profile_ref`);
  }

  const configVarStore = createConfigVarStore(
    params.tenantId,
    params.projectId,
    tool.variable_namespace_ids,
  );
  const profileName = await resolveAuthProfileRef(
    tool.auth_profile_ref,
    params.tenantId,
    params.projectId,
    configVarStore,
    tool.variable_namespace_ids,
  );

  if (!profileName) {
    throw new Error(
      `Config variable in auth_profile_ref "${tool.auth_profile_ref}" could not be resolved for tool "${tool.name}".`,
    );
  }

  const profile = await resolveStudioAuthProfileByName({
    name: profileName,
    tenantId: params.tenantId,
    projectId: params.projectId,
    userId: params.userId,
    environment: params.environment,
  });

  if (!profile) {
    throw new Error(`Auth profile "${profileName}" was not found or is not active.`);
  }

  const queryParams = new URLSearchParams();
  let appliedAuth: Awaited<ReturnType<typeof applyAuth>> | null = null;

  if (profile.authType === 'oauth2_app' || profile.authType === 'oauth2_token') {
    if (!isStudioTestOAuthGrantEnabled()) {
      throw new Error(
        `Studio tool testing does not yet support OAuth grant-backed auth profile "${profileName}".`,
      );
    }

    const connectionMode = resolveEffectiveOAuthConnectionMode(tool, profile);
    const accessToken = await resolveStudioOAuthGrantAccessToken(profile, {
      tenantId: params.tenantId,
      userId: params.userId,
      connectionMode,
    });

    appliedAuth = await applyAuth({
      authType: 'oauth2_token',
      config: profile.config,
      secrets: { accessToken },
      headers: {},
      queryParams,
      context: {
        tenantId: params.tenantId,
        profileId: profile._id,
        profileVersion: profile.profileVersion ?? 1,
        redis: getRedisClient() ?? undefined,
      },
    });
  } else {
    const secrets = await resolveStudioAuthProfileSecrets(profile, params.tenantId);
    if (profile.authType === 'oauth2_client_credentials') {
      const tokenUrl = typeof profile.config.tokenUrl === 'string' ? profile.config.tokenUrl : '';
      const clientId = typeof secrets.clientId === 'string' ? secrets.clientId : '';
      const clientSecret = typeof secrets.clientSecret === 'string' ? secrets.clientSecret : '';
      if (!tokenUrl || !clientId || !clientSecret) {
        throw new Error(
          `Auth profile "${profileName}" is missing client credentials configuration for tool testing.`,
        );
      }

      const requestedScopes = extractRequestedOAuthScopes(tool);
      const profileScopes = toScopeList(
        'scopes' in profile.config ? profile.config.scopes : profile.config.scope,
      );
      const profileAudience =
        typeof profile.config.audience === 'string' ? profile.config.audience.trim() : '';
      const tokenResult = await resolveClientCredentialsToken(
        profile._id,
        params.tenantId,
        profile.profileVersion ?? 1,
        tokenUrl,
        clientId,
        clientSecret,
        requestedScopes.length > 0 ? requestedScopes : profileScopes,
        {
          redis: getRedisClient() ?? undefined,
          ...(profileAudience ? { audience: profileAudience } : {}),
        },
      );

      appliedAuth = await applyAuth({
        authType: profile.authType,
        config: profile.config,
        secrets: { accessToken: tokenResult.accessToken },
        headers: {},
        queryParams,
        context: {
          tenantId: params.tenantId,
          profileId: profile._id,
          profileVersion: profile.profileVersion ?? 1,
          redis: getRedisClient() ?? undefined,
        },
      });
    } else {
      appliedAuth = await applyAuth({
        authType: profile.authType,
        config: profile.config,
        secrets,
        headers: {},
        queryParams,
        context: {
          tenantId: params.tenantId,
          profileId: profile._id,
          profileVersion: profile.profileVersion ?? 1,
          redis: getRedisClient() ?? undefined,
        },
      });
    }
  }

  const resolvedQueryParams =
    appliedAuth.queryParams && Array.from(appliedAuth.queryParams.keys()).length > 0
      ? Object.fromEntries(appliedAuth.queryParams.entries())
      : undefined;

  const tlsOptions =
    appliedAuth.tlsOptions?.cert && appliedAuth.tlsOptions?.key
      ? {
          cert: appliedAuth.tlsOptions.cert,
          key: appliedAuth.tlsOptions.key,
          ...(appliedAuth.tlsOptions.ca ? { ca: appliedAuth.tlsOptions.ca } : {}),
          rejectUnauthorized: true as const,
        }
      : undefined;

  return {
    headers: appliedAuth.headers,
    ...(resolvedQueryParams ? { queryParams: resolvedQueryParams } : {}),
    ...(tlsOptions ? { tlsOptions } : {}),
    ...(appliedAuth.wsSecurityCredentials
      ? { wsSecurityCredentials: appliedAuth.wsSecurityCredentials }
      : {}),
    ...(appliedAuth.signRequest ? { signRequest: appliedAuth.signRequest } : {}),
    ...(appliedAuth.digestCredentials ? { digestCredentials: appliedAuth.digestCredentials } : {}),
    authType: profile.authType,
  };
}

function createStudioAuthProfileToolMiddleware(config: {
  tenantId: string;
  projectId: string;
  userId: string;
  environment: string;
}): ToolMiddleware {
  return async (ctx: ToolCallContext, next: ToolMiddlewareNext): Promise<ToolCallResult> => {
    const tool = ctx.tool;
    if (!tool?.auth_profile_ref) {
      return next(ctx);
    }

    const authResult = await resolveStudioToolAuth(tool, config);
    const patchedTool = patchToolWithResolvedAuth(
      tool,
      authResult.headers,
      authResult.queryParams,
      authResult.tlsOptions,
      authResult.wsSecurityCredentials,
      authResult.signRequest,
      authResult.digestCredentials,
    );

    return next({ ...ctx, tool: patchedTool });
  };
}

// ─── Sandbox Runner Factory ──────────────────────────────────────────────

async function createSandboxRunner(
  tenantId: string,
  userId: string,
  toolId: string,
  codeContent?: string | null,
): Promise<SandboxRunner | undefined> {
  const backend: 'gvisor' | 'lambda' | 'mock' =
    process.env.SANDBOX_BACKEND === 'mock'
      ? 'mock'
      : process.env.SANDBOX_BACKEND === 'lambda'
        ? 'lambda'
        : 'gvisor';
  const pythonPodUrl = process.env.SANDBOX_PYTHON_POD_URL || 'http://kr-python-svc';
  const javascriptPodUrl = process.env.SANDBOX_JAVASCRIPT_POD_URL || 'http://kr-javascript-svc';
  const podPath = process.env.SANDBOX_POD_PATH || '/execute-script';
  const jwtSecret = process.env.SANDBOX_JWT_SECRET;
  const lambdaRegion = process.env.LAMBDA_RUNNER_REGION || 'us-east-1';
  const lambdaMemoryApiBaseUrl = process.env.LAMBDA_RUNNER_MEMORY_API_URL || '';
  const lambdaHealthTtlMs = parseInt(process.env.LAMBDA_RUNNER_HEALTH_TTL_MS || '300000', 10);

  log.info('Creating sandbox runner', {
    backend,
    pythonPodUrl,
    javascriptPodUrl,
    podPath,
    hasJwtSecret: !!jwtSecret,
    hasCodeContent: !!codeContent,
    codeContentLength: codeContent?.length ?? 0,
    toolId,
    envPythonPodUrl: process.env.SANDBOX_PYTHON_POD_URL ?? '(not set — using default)',
    envJavascriptPodUrl: process.env.SANDBOX_JAVASCRIPT_POD_URL ?? '(not set — using default)',
    envPodPath: process.env.SANDBOX_POD_PATH ?? '(not set — using default)',
  });

  let jwtSigner: ((claims: Record<string, unknown>) => Promise<string>) | undefined;
  if (jwtSecret) {
    try {
      const jwt = await import('jsonwebtoken');
      const expiresIn = 300;
      jwtSigner = async (claims) => jwt.default.sign(claims, jwtSecret, { expiresIn });
      log.debug('JWT signer created successfully');
    } catch (err) {
      log.error('Failed to create JWT signer', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  } else {
    log.warn('No SANDBOX_JWT_SECRET configured — JWT auth disabled');
  }

  const runnerConfig: SandboxRunnerConfig = {
    gvisor: {
      pythonPodUrl,
      javascriptPodUrl,
      podPath,
      timeoutMs: 60_000,
    },
    lambda: {
      region: lambdaRegion,
      memoryApiBaseUrl: lambdaMemoryApiBaseUrl,
      healthTtlMs: Number.isNaN(lambdaHealthTtlMs) ? 300_000 : lambdaHealthTtlMs,
    },
  };
  const sessionContext = {
    tenantId,
    sessionId: `studio-test-${toolId}`,
    userId,
  };

  if (backend === 'lambda') {
    const redis = getRedisClient();
    if (!redis) {
      log.warn('Redis unavailable — lambda sandbox backend disabled for Studio tool tests', {
        toolId,
      });
      return undefined;
    }

    const [{ RedisLambdaDeploymentStore }, { LambdaClient }] = await Promise.all([
      import('@agent-platform/shared/services/lambda'),
      import('@aws-sdk/client-lambda'),
    ]);

    return createCompilerSandboxRunner(
      'lambda',
      {
        ...runnerConfig,
        deploymentStore: new RedisLambdaDeploymentStore(redis),
        lambdaClient: new LambdaClient({ region: runnerConfig.lambda.region }),
      },
      sessionContext,
      jwtSigner,
    );
  }

  return createCompilerSandboxRunner(backend, runnerConfig, sessionContext, jwtSigner);
}

// ─── MCP Provider Factory ────────────────────────────────────────────────

/**
 * Creates a short-lived MCP provider for test execution.
 * Uses its own MCPServerManager instance (not the runtime singleton).
 * Connects → executes → disconnects within a single test.
 */
async function createMcpProvider(tenantId: string, projectId: string) {
  const { MCPServerRegistryService } = await import('@agent-platform/shared/services/mcp-registry');
  const { MCPServerManager } = await import('@abl/compiler/platform/studio-exports.js');

  const registry = new MCPServerRegistryService({
    decryptForTenant: (encrypted, scopedTenantId) =>
      decryptForTenantAuto(encrypted, scopedTenantId),
  });

  const manager = new MCPServerManager();
  const configs = await registry.getServerConfigs(tenantId, projectId);

  // Allow localhost/private ranges in non-production environments (matches mcp-discovery-service)
  const devOpts = getDevSSRFOptions();

  for (const config of configs) {
    try {
      if (devOpts.allowLocalhost || devOpts.allowPrivateRanges) {
        config.ssrfOptions = devOpts;
      }
      // Register by display name — DSL `server:` field references the name, not the DB _id
      manager.registerServer(config);
      await manager.connectServer(config.name);
    } catch (err) {
      console.warn(
        `[ToolTest] Failed to connect MCP server ${config.id}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  return {
    manager,
    provider: {
      async getClient(serverId: string) {
        return manager.getClient(serverId);
      },
    },
    async disconnect() {
      await manager.disconnectAll();
    },
  };
}

// ─── Display Placeholder Resolution ─────────────────────────────────────

/**
 * Resolve template placeholders for display in test results.
 *
 * - {{input.X}}  → substituted from test input params
 * - {{X}} / {X}  → substituted from test input params (bare path params)
 * - {{secrets.X}} → masked as "***" (never expose secrets in UI)
 * - {{env.X}}     → masked as "***" (server-side only)
 * - {{_context.X}} → shown as "[context.X]"
 *
 * Tracks consumed input keys so they can be excluded from the auto-body.
 */
function resolveDisplayPlaceholders(
  value: string,
  input: Record<string, unknown> | undefined,
  consumedKeys: Set<string>,
  urlEncode = false,
  formEncode = false,
): string {
  // 1. Mask secrets, env vars, and unresolved config vars (never display internal values)
  let result = value.replace(/\{\{secrets\.(\w+)\}\}/g, '***');
  result = result.replace(/\{\{env\.(\w+)\}\}/g, '***');
  result = result.replace(/\{\{config\.(\w+)\}\}/g, '***');

  // 2. Show context/session vars as readable labels
  result = result.replace(/\{\{_context\.(\w+)\}\}/g, (_, key) => {
    const label = `[context.${key}]`;
    return formEncode
      ? encodeDisplayFormTemplateValue(label)
      : urlEncode
        ? encodeURIComponent(label)
        : label;
  });
  result = result.replace(/\{\{session\.(\w+)\}\}/g, (_, key) => {
    const label = `[session.${key}]`;
    return formEncode
      ? encodeDisplayFormTemplateValue(label)
      : urlEncode
        ? encodeURIComponent(label)
        : label;
  });

  // 3. Resolve {{input.X}}, {{X}}, {X} from test input
  if (input) {
    result = result.replace(
      /\{\{input\.(\w+)\}\}|\{\{(\w+)\}\}|\{(\w+)\}/g,
      (match, inputKey, doubleKey, singleKey) => {
        const key = inputKey || doubleKey || singleKey;
        const val = input[key];
        if (val !== undefined && val !== null) {
          consumedKeys.add(key);
          const str = typeof val === 'object' ? JSON.stringify(val) : String(val);
          return formEncode
            ? encodeDisplayFormTemplateValue(str)
            : urlEncode
              ? encodeURIComponent(str)
              : str;
        }
        return match;
      },
    );
  }

  return result;
}

// ─── HTTP Status Helpers ──────────────────────────────────────────────────

const HTTP_STATUS_TEXTS: Record<number, string> = {
  200: 'OK',
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  408: 'Request Timeout',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
};

function httpStatusText(status: number): string {
  return HTTP_STATUS_TEXTS[status] ?? 'Unknown';
}

/**
 * Map a ToolExecutionError code to a meaningful HTTP status for display.
 * Prefer the real statusCode from the error when available (e.g. TOOL_HTTP_ERROR).
 */
function resolveDisplayStatus(
  errorCode: string | undefined,
  statusCode: number | undefined,
): number {
  if (statusCode) return statusCode;
  switch (errorCode) {
    case OAUTH_REAUTH_REQUIRED_CODE:
      return 401; // Unauthorized
    case 'TOOL_TIMEOUT':
      return 504; // Gateway Timeout
    case 'TOOL_NETWORK_ERROR':
      return 503; // Service Unavailable
    case 'TOOL_RATE_LIMITED':
      return 429; // Too Many Requests
    case 'TOOL_SSRF_BLOCKED':
      return 403; // Forbidden
    case 'TOOL_CIRCUIT_OPEN':
      return 503; // Service Unavailable
    case 'TOOL_SOAP_FAULT':
      return 200; // SOAP faults are application-level; HTTP was 200
    default:
      return 500; // Internal Server Error
  }
}

// ─── Shared Error Classification ─────────────────────────────────────────

interface ToolTestErrorResult {
  executionError: string;
  errorCode?: string;
  retryable?: boolean;
  httpStatusCode?: number;
  oauthReauth?: ToolTestOutput['oauthReauth'];
}

/**
 * Classify a tool execution error into a structured result.
 * Shared by executeToolTest and executeModuleToolTest to avoid duplication.
 */
function classifyToolExecutionError(error: unknown): ToolTestErrorResult {
  const oauthReauthCause = findOAuthReauthCause(error);
  if (oauthReauthCause) {
    const sanitized = sanitizeAuthProfileError(oauthReauthCause);
    return {
      executionError: sanitized.userMessage,
      errorCode: sanitized.code,
      httpStatusCode: oauthReauthCause.statusCode,
      oauthReauth: oauthReauthCause.reauth,
      retryable: error instanceof ToolExecutionError ? error.retryable : undefined,
    };
  }
  if (error instanceof ToolExecutionError) {
    if (isAuthProfileErrorCode(error.code)) {
      const sanitized = sanitizeAuthProfileError(error);
      return {
        executionError: sanitized.userMessage,
        errorCode: sanitized.code,
        retryable: error.retryable,
        httpStatusCode: error.statusCode,
      };
    }
    return {
      executionError: error.message,
      errorCode: error.code,
      retryable: error.retryable,
      httpStatusCode: error.statusCode,
    };
  }
  if (error instanceof StudioToolTestOAuthReauthError) {
    const sanitized = sanitizeAuthProfileError(error);
    return {
      executionError: sanitized.userMessage,
      errorCode: sanitized.code,
      httpStatusCode: error.statusCode,
      oauthReauth: error.reauth,
    };
  }
  return {
    executionError: error instanceof Error ? error.message : 'Unknown error',
  };
}

// ─── Main Test Execution ─────────────────────────────────────────────────

// ─── Module Tool Test Types ─────────────────────────────────────────────

export interface ModuleToolTestInput {
  /** Human-readable tool name (key from artifact.tools) */
  toolName: string;
  /** Tool DSL content from the module release artifact */
  dslContent: string;
  /** Tool type from the module release artifact */
  toolType: string;
  /** Consumer project context */
  tenantId: string;
  userId: string;
  projectId: string;
  input?: Record<string, unknown>;
  timeoutMs?: number;
  debug?: boolean;
}

/**
 * Execute a tool test for an imported module tool.
 *
 * Identical to `executeToolTest` except the tool definition is built from
 * the module release artifact instead of loaded from the project_tools
 * collection. Auth profiles, env vars, and config variables resolve from
 * the **consumer** project's credentials, matching runtime behavior.
 */
export async function executeModuleToolTest(params: ModuleToolTestInput): Promise<ToolTestOutput> {
  const { toolName, dslContent, toolType, tenantId, userId, projectId, input, timeoutMs } = params;
  const start = Date.now();
  const executionLogs: string[] = [];
  let result: unknown;
  let executionError: string | undefined;
  let errorCode: string | undefined;
  let retryable: boolean | undefined;
  let httpStatusCode: number | undefined;
  let oauthReauth: ToolTestOutput['oauthReauth'];

  log.debug('executeModuleToolTest called', {
    toolName,
    toolType,
    projectId,
    hasInput: !!input,
    inputKeys: input ? Object.keys(input) : [],
  });

  // Workflow tools require the runtime engine — cannot be tested directly from Studio
  if (toolType === 'workflow') {
    return {
      output: null,
      latencyMs: 0,
      logs: ['Workflow tools must be tested via the agent playground (requires runtime engine).'],
      error:
        'Workflow tools cannot be tested directly from Studio. Use the agent playground instead.',
    };
  }

  // Build ToolDefinition from the artifact DSL content
  const toolRecord = {
    name: toolName,
    toolType,
    description: null as string | null,
    dslContent,
  };
  const toolDef = buildToolDefinition(toolRecord);

  // Module tools use the consumer project's default variable namespace
  const effectiveVariableNamespaceIds = await resolveEffectiveToolVariableNamespaceIds({
    tenantId,
    projectId,
    createdBy: userId,
  });
  if (effectiveVariableNamespaceIds.length > 0) {
    toolDef.variable_namespace_ids = effectiveVariableNamespaceIds;
  }
  const configVariables = await loadToolConfigVariablesMap({
    tool: toolDef,
    tenantId,
    projectId,
    variableNamespaceIds: effectiveVariableNamespaceIds,
  });
  const configResolution = resolveToolConfigVariableTemplates(toolDef, configVariables);
  if (configResolution.errors.length > 0) {
    log.warn('Studio module tool test config variable resolution failed', {
      toolName,
      projectId,
      errors: configResolution.errors,
    });

    return {
      output: null,
      latencyMs: Date.now() - start,
      logs: [...executionLogs, ...configResolution.errors],
      error: configResolution.errors[0],
      ...(input && Object.keys(input).length > 0 && { params: input }),
    };
  }

  // Create secrets provider (namespace-scoped to consumer project's namespaces)
  const environment = getStudioExecutionEnvironment();
  const secrets = createSecretsProvider(
    tenantId,
    projectId,
    environment,
    effectiveVariableNamespaceIds,
  );

  // Synthetic tool ID for session context
  const syntheticToolId = `module-${toolName}`;

  // Create type-specific executors
  let sandboxRunner: SandboxRunner | undefined;
  let mcpProvider: Awaited<ReturnType<typeof createMcpProvider>> | undefined;

  try {
    if (toolType === 'sandbox') {
      const codeContent = toolDef.sandbox_binding?.code_content;
      sandboxRunner = await createSandboxRunner(tenantId, userId, syntheticToolId, codeContent);
    }

    if (toolType === 'mcp') {
      try {
        mcpProvider = await createMcpProvider(tenantId, projectId);
      } catch (err) {
        executionLogs.push(
          `MCP provider setup failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // Create trace stub to capture logs
    const trace = {
      logToolCall: async (event: { toolName: string; latencyMs: number }) => {
        executionLogs.push(`Tool call: ${event.toolName}, latency: ${event.latencyMs}ms`);
      },
      logError: async (errorType: string, message: string) => {
        executionLogs.push(`Error: ${errorType} - ${message}`);
      },
    } as unknown as TraceContextManager;

    const effectiveTimeout =
      toPositiveNumber(timeoutMs) ?? toPositiveNumber(toolDef.hints?.timeout) ?? DEFAULT_TIMEOUT_MS;

    // Create executor
    const { ToolBindingExecutor } = await import('@abl/compiler/platform/studio-exports.js');
    const executor = new ToolBindingExecutor({
      tools: [toolDef],
      secrets,
      sandboxRunner,
      mcpClients: mcpProvider?.provider as McpClientProvider,
      middleware: [
        createStudioAuthProfileToolMiddleware({
          tenantId,
          projectId,
          userId,
          environment,
        }),
        loggingMiddleware(trace),
        createSecretScrubberMiddleware(),
      ],
      trace,
      defaultTimeoutMs: effectiveTimeout,
      allowLocalhost: !!getDevSSRFOptions().allowLocalhost,
      projectId,
      sessionContext: {
        sessionId: `studio-test-${syntheticToolId}`,
        tenantId,
        userId,
        source: 'test',
      },
    });

    result = await executor.execute(toolName, input || {}, effectiveTimeout);
  } catch (error: unknown) {
    log.error('Module tool execution failed', {
      toolName,
      toolType,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack?.split('\n').slice(0, 5).join('\n') : undefined,
    });
    const classified = classifyToolExecutionError(error);
    executionError = classified.executionError;
    errorCode = classified.errorCode;
    retryable = classified.retryable;
    httpStatusCode = classified.httpStatusCode;
    oauthReauth = classified.oauthReauth;
  } finally {
    if (mcpProvider) {
      try {
        await mcpProvider.disconnect();
      } catch (disconnectErr) {
        log.warn('MCP provider disconnect failed during tool test cleanup', {
          error: disconnectErr instanceof Error ? disconnectErr.message : String(disconnectErr),
        });
      }
    }
  }

  const latencyMs = Date.now() - start;

  const isHttpErrorOutputModule = isHttpErrorResult(executionError, result);

  return {
    output: result,
    latencyMs,
    logs: executionLogs,
    error: executionError,
    errorCode,
    retryable,
    oauthReauth,
    ...(isHttpErrorOutputModule && { httpError: true }),
    ...(input && Object.keys(input).length > 0 && { params: input }),
  };
}

export async function executeToolTest(params: ToolTestInput): Promise<ToolTestOutput> {
  const { toolId, tenantId, userId, projectId, input, timeoutMs } = params;
  const start = Date.now();
  const executionLogs: string[] = [];
  let result: unknown;
  let executionError: string | undefined;
  let errorCode: string | undefined;
  let retryable: boolean | undefined;
  let httpStatusCode: number | undefined;
  let oauthReauth: ToolTestOutput['oauthReauth'];

  log.debug('executeToolTest called', {
    toolId,
    projectId,
    hasInput: !!input,
    inputKeys: input ? Object.keys(input) : [],
  });

  // Load project tool (single collection)
  const tool = await findProjectToolById(toolId, tenantId, projectId);
  if (!tool) {
    log.warn('Tool not found', { toolId, projectId });
    return {
      output: null,
      latencyMs: 0,
      logs: [],
      error: 'Tool not found',
      errorCode: 'NOT_FOUND',
    };
  }

  log.debug('Tool loaded', {
    name: tool.name,
    toolType: tool.toolType,
    hasDslContent: !!tool.dslContent,
    dslContentLength: tool.dslContent?.length ?? 0,
  });

  // Workflow tools require the runtime engine — cannot be tested directly from Studio
  if (tool.toolType === 'workflow') {
    return {
      output: null,
      latencyMs: 0,
      logs: ['Workflow tools must be tested via the agent playground (requires runtime engine).'],
      error:
        'Workflow tools cannot be tested directly from Studio. Use the agent playground instead.',
    };
  }

  // Build ToolDefinition from dslContent
  const toolDef = buildToolDefinition(tool);
  const effectiveVariableNamespaceIds = await resolveEffectiveToolVariableNamespaceIds({
    tenantId,
    projectId,
    createdBy: userId,
    variableNamespaceIds: tool.variableNamespaceIds,
  });
  if (effectiveVariableNamespaceIds.length > 0) {
    toolDef.variable_namespace_ids = effectiveVariableNamespaceIds;
  }
  const configVariables = await loadToolConfigVariablesMap({
    tool: toolDef,
    tenantId,
    projectId,
    variableNamespaceIds: effectiveVariableNamespaceIds,
  });
  const configResolution = resolveToolConfigVariableTemplates(toolDef, configVariables);
  if (configResolution.errors.length > 0) {
    log.warn('Studio tool test config variable resolution failed', {
      toolName: tool.name,
      projectId,
      errors: configResolution.errors,
    });

    return {
      output: null,
      latencyMs: Date.now() - start,
      logs: [...executionLogs, ...configResolution.errors],
      error: configResolution.errors[0],
      ...(input && Object.keys(input).length > 0 && { params: input }),
    };
  }

  // Create secrets provider (namespace-scoped to tool's linked namespaces)
  const environment = getStudioExecutionEnvironment();
  const secrets = createSecretsProvider(
    tenantId,
    projectId,
    environment,
    effectiveVariableNamespaceIds,
  );

  // Create type-specific executors
  let sandboxRunner: SandboxRunner | undefined;
  let mcpProvider: Awaited<ReturnType<typeof createMcpProvider>> | undefined;

  try {
    if (tool.toolType === 'sandbox') {
      const codeContent = toolDef.sandbox_binding?.code_content;
      log.debug('Sandbox tool detected', {
        hasSandboxBinding: !!toolDef.sandbox_binding,
        hasCodeContent: !!codeContent,
        runtime: toolDef.sandbox_binding?.runtime,
      });
      sandboxRunner = await createSandboxRunner(tenantId, userId, tool.id, codeContent);
      log.debug('Sandbox runner created', { hasRunner: !!sandboxRunner });
    }

    if (tool.toolType === 'mcp') {
      try {
        mcpProvider = await createMcpProvider(tenantId, projectId);
      } catch (err) {
        executionLogs.push(
          `MCP provider setup failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // Create trace stub to capture logs
    const trace = {
      logToolCall: async (event: { toolName: string; latencyMs: number }) => {
        executionLogs.push(`Tool call: ${event.toolName}, latency: ${event.latencyMs}ms`);
      },
      logError: async (errorType: string, message: string) => {
        executionLogs.push(`Error: ${errorType} - ${message}`);
      },
    } as unknown as TraceContextManager;

    const effectiveTimeout =
      toPositiveNumber(timeoutMs) ?? toPositiveNumber(toolDef.hints?.timeout) ?? DEFAULT_TIMEOUT_MS;

    // Create executor
    const { ToolBindingExecutor } = await import('@abl/compiler/platform/studio-exports.js');
    const executor = new ToolBindingExecutor({
      tools: [toolDef],
      secrets,
      sandboxRunner,
      mcpClients: mcpProvider?.provider as McpClientProvider,
      middleware: [
        createStudioAuthProfileToolMiddleware({
          tenantId,
          projectId,
          userId,
          environment,
        }),
        loggingMiddleware(trace),
        createSecretScrubberMiddleware(),
      ],
      trace,
      defaultTimeoutMs: effectiveTimeout,
      allowLocalhost: !!getDevSSRFOptions().allowLocalhost,
      projectId,
      sessionContext: {
        sessionId: `studio-test-${tool.id}`,
        tenantId,
        userId,
        source: 'test',
      },
    });

    log.debug('Executing tool via ToolBindingExecutor', {
      toolName: tool.name,
      toolType: tool.toolType,
      timeout: effectiveTimeout,
      hasSandboxRunner: !!sandboxRunner,
      hasMcpProvider: !!mcpProvider,
    });

    result = await executor.execute(tool.name, input || {}, effectiveTimeout);
    log.debug('Execution succeeded', {
      toolName: tool.name,
      resultType: typeof result,
      hasResult: result !== null && result !== undefined,
    });
  } catch (error: unknown) {
    log.error('Execution failed', {
      toolName: tool.name,
      toolType: tool.toolType,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack?.split('\n').slice(0, 5).join('\n') : undefined,
    });
    const classified = classifyToolExecutionError(error);
    executionError = classified.executionError;
    errorCode = classified.errorCode;
    retryable = classified.retryable;
    httpStatusCode = classified.httpStatusCode;
    oauthReauth = classified.oauthReauth;
  } finally {
    // Disconnect MCP provider if used (E5: guaranteed cleanup)
    if (mcpProvider) {
      try {
        await mcpProvider.disconnect();
      } catch (disconnectErr) {
        log.warn('MCP provider disconnect failed during tool test cleanup', {
          error: disconnectErr instanceof Error ? disconnectErr.message : String(disconnectErr),
        });
      }
    }
  }

  const latencyMs = Date.now() - start;

  // Build type-specific inspection data
  let request: ToolTestOutput['request'];
  let response: ToolTestOutput['response'];
  let sandbox: ToolTestOutput['sandbox'];
  let mcp: ToolTestOutput['mcp'];

  if (tool.toolType === 'http' && toolDef.http_binding) {
    const binding = toolDef.http_binding;
    const method = (binding.method || 'GET').toUpperCase();
    const bodyType = binding.body_type ?? 'json';
    const consumedParams = new Set<string>();

    // --- Endpoint URL: resolve {{input.X}}, {{X}}, {X}; mask {{secrets.X}} ---
    let displayUrl = resolveDisplayPlaceholders(
      binding.endpoint || '',
      input,
      consumedParams,
      true,
    );

    // --- Query params: resolve templates and append to URL ---
    if (binding.query_params) {
      const searchParams = new URLSearchParams();
      for (const [k, v] of Object.entries(binding.query_params)) {
        searchParams.append(k, resolveDisplayPlaceholders(v, input, consumedParams));
      }
      const separator = displayUrl.includes('?') ? '&' : '?';
      displayUrl = `${displayUrl}${separator}${searchParams.toString()}`;
    }

    // --- Headers: resolve {{input.X}}, mask {{secrets.X}} ---
    const displayHeaders: Record<string, string> = {};
    if (['POST', 'PUT', 'PATCH'].includes(method)) {
      displayHeaders['Content-Type'] = BODY_TYPE_CONTENT_TYPES[bodyType];
    }
    if (binding.headers) {
      for (const [k, v] of Object.entries(binding.headers)) {
        displayHeaders[k] = resolveDisplayPlaceholders(v, input, consumedParams);
      }
    }

    // --- SOAP protocol: override Content-Type and inject SOAPAction ---
    // The executor always generates these from soap_version/soap_action — user-defined
    // header overrides cannot change them. Show what will actually be sent on the wire.
    if (binding.protocol === 'soap') {
      const soapVersion = (binding.soap_version ?? '1.1') as '1.1' | '1.2';
      const rawAction = binding.soap_action
        ? resolveDisplayPlaceholders(binding.soap_action, input, consumedParams)
        : '';
      if (soapVersion === '1.1') {
        displayHeaders['Content-Type'] = 'text/xml; charset=utf-8';
        if (rawAction) {
          // Mirror executor: SOAPAction must be quoted per SOAP 1.1 spec
          const alreadyQuoted = rawAction.startsWith('"') && rawAction.endsWith('"');
          displayHeaders['SOAPAction'] = alreadyQuoted ? rawAction : `"${rawAction}"`;
        }
      } else {
        // SOAP 1.2: action is embedded in Content-Type, no separate SOAPAction header
        displayHeaders['Content-Type'] = rawAction
          ? `application/soap+xml; charset=utf-8; action="${rawAction}"`
          : 'application/soap+xml; charset=utf-8';
        delete displayHeaders['SOAPAction'];
      }
    }

    // --- Auth headers: show auth type with masked credentials ---
    if (binding.auth && binding.auth.type !== 'none') {
      switch (binding.auth.type) {
        case 'bearer':
          displayHeaders['Authorization'] = 'Bearer ***';
          break;
        case 'api_key': {
          const headerName = binding.auth.config?.headerName || 'X-API-Key';
          displayHeaders[headerName] = '***';
          break;
        }
        case 'oauth2_client':
          displayHeaders['Authorization'] = 'Bearer [oauth2_client ***]';
          break;
        case 'oauth2_user':
          displayHeaders['Authorization'] =
            `Bearer [oauth2_user:${binding.auth.config?.provider || 'default'} ***]`;
          break;
        case 'custom':
          if (binding.auth.config?.customHeaders) {
            for (const key of Object.keys(binding.auth.config.customHeaders)) {
              displayHeaders[key] = '***';
            }
          }
          break;
      }
    }

    // --- Body: resolve body_template or show remaining params ---
    const hasBody = ['POST', 'PUT', 'PATCH'].includes(method);
    let body: unknown;
    if (hasBody) {
      if (binding.body_template) {
        body = resolveDisplayPlaceholders(
          binding.body_template,
          input,
          consumedParams,
          false,
          bodyType === 'form',
        );
      } else if (input) {
        const remaining = Object.fromEntries(
          Object.entries(input).filter(([k]) => !consumedParams.has(k)),
        );
        if (Object.keys(remaining).length > 0) {
          body = bodyType === 'form' ? serializeDisplayFormBody(remaining) : remaining;
        }
      }
    }

    request = {
      method,
      url: displayUrl,
      ...(Object.keys(displayHeaders).length > 0 && { headers: displayHeaders }),
      ...(body !== undefined && { body }),
    };
    const httpErrorResult = isHttpErrorResult(executionError, result)
      ? (result as Record<string, unknown>)
      : null;
    const displayStatus = executionError
      ? resolveDisplayStatus(errorCode, httpStatusCode)
      : httpErrorResult
        ? Number(httpErrorResult.statusCode) || 200
        : 200;
    response = {
      status: displayStatus,
      statusText: httpStatusText(displayStatus),
      headers: {},
      body: result,
    };
  }

  if (tool.toolType === 'sandbox' && toolDef.sandbox_binding) {
    const binding = toolDef.sandbox_binding;
    sandbox = {
      runtime: binding.runtime,
      timeoutMs: toPositiveNumber(binding.timeout_ms) ?? DEFAULT_TIMEOUT_MS,
      memoryMb: toPositiveNumber(binding.memory_mb) ?? 128,
    };
  }

  if (tool.toolType === 'mcp' && toolDef.mcp_binding) {
    const binding = toolDef.mcp_binding;
    mcp = {
      server: binding.server,
      tool: binding.tool,
      ...(binding.server_config?.transport && { transport: binding.server_config.transport }),
    };
  }

  const isHttpErrorOutput = isHttpErrorResult(executionError, result);

  return {
    output: result,
    latencyMs,
    logs: executionLogs,
    error: executionError,
    errorCode,
    retryable,
    oauthReauth,
    ...(isHttpErrorOutput && { httpError: true }),
    ...(input && Object.keys(input).length > 0 && { params: input }),
    request,
    response,
    sandbox,
    mcp,
  };
}
