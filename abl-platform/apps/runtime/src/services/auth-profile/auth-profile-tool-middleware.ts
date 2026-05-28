/**
 * Auth Profile Tool Middleware
 *
 * ToolMiddleware that intercepts tool calls for tools with `auth_profile_ref`,
 * resolves credentials via resolveToolAuth(), and applies resolved headers
 * to the tool's http_binding before the HttpToolExecutor runs.
 *
 * Phase 5 addition: When `jit_auth: true` and credentials are missing,
 * pauses execution and sends an `auth_challenge` to the client, waiting
 * for the user to complete OAuth before retrying.
 */

import type {
  ToolMiddleware,
  ToolCallContext,
  ToolCallResult,
  ToolMiddlewareNext,
} from '@abl/compiler';
import { createLogger } from '@abl/compiler/platform';
import { ToolExecutionError } from '@agent-platform/shared';
import {
  getAuthProfileSupportDecision,
  isPhase2CoreAuthType,
} from '@agent-platform/shared/validation';
import {
  resolveToolAuth,
  AuthProfileNotFoundError,
  AuthProfileTokenRequiredError,
  resolveAuthProfileRef,
  type ConfigVarStoreLike,
  type AwsSigV4Context,
} from './resolve-tool-auth.js';
import { sanitizeAuthProfileError } from '@agent-platform/shared/services/auth-profile';
import {
  getPausedExecutionStore,
  AuthTimeoutError,
  AuthCancelledError,
  SessionDisconnectedError,
} from './paused-execution-store.js';
import { AUTH_JIT_UNSUPPORTED_CODE } from './auth-contract.js';

/**
 * Discriminate workflow-context rejection errors by their `code` field
 * rather than `instanceof`. The runtime production path always throws the
 * concrete classes from resolve-tool-auth.ts, but checking by code keeps
 * the middleware decoupled from the class import — useful for tests that
 * stub the resolver and for any future refactor that relocates the
 * exception classes.
 */
function isErrorWithCode(err: unknown, code: string): boolean {
  return err !== null && typeof err === 'object' && (err as { code?: unknown }).code === code;
}

const log = createLogger('auth-profile-tool-middleware');

export interface AuthProfileToolMiddlewareConfig {
  tenantId: string;
  environment?: string;
  projectId?: string;
  userId?: string;
  sessionPrincipalId?: string;
  authScope?: 'session' | 'user';
  configVarStore?: ConfigVarStoreLike;
  /**
   * Set true when the middleware is invoked from a workflow tool_call path
   * (FR-9). Workflows lack an end-user identity and an interactive auth
   * channel, so per_user / jit profiles are rejected with a structured
   * error envelope rather than attempting token resolution.
   */
  workflowContext?: boolean;
  /** Session ID for JIT auth pause/resume (required for JIT auth) */
  sessionId?: string;
  /** Current agent name — used for tool_auth_resolved trace events */
  agentName?: string;
  /** Callback to emit a trace event when tool auth is resolved */
  onToolAuthResolved?: (params: {
    agentName: string;
    toolName: string;
    profileName: string;
    scope: 'project' | 'tenant';
    moduleAlias?: string;
  }) => void;
  /**
   * Callback to send an auth_challenge message to the client.
   * Provided by the runtime when wiring the middleware.
   */
  sendAuthChallenge?: (params: {
    sessionId: string;
    toolCallId: string;
    authType: string;
    authUrl?: string;
    profileId: string;
    profileName: string;
    prompt: string;
    timeoutMs: number;
  }) => void;
  /**
   * Callback to initiate JIT OAuth and get an auth URL.
   * Returns the OAuth URL for the auth_challenge message.
   */
  initiateJitOAuth?: (params: {
    profileId: string;
    authProfileRef?: string;
    sessionId: string;
    toolCallId: string;
    projectId?: string;
    environment?: string;
    scopes?: string[];
    connectionMode?: 'per_user' | 'shared';
  }) => Promise<string | undefined>;
}

/**
 * Create a ToolMiddleware that resolves auth_profile_ref credentials
 * and injects them as custom headers into the tool's http_binding.
 *
 * When a tool has auth_profile_ref, the resolved headers are merged
 * into the tool's http_binding.headers, taking precedence over inline auth.
 *
 * Phase 5: If jit_auth is true and credentials cannot be resolved,
 * pauses execution and sends an auth_challenge to the client.
 */
export function createAuthProfileToolMiddleware(
  config: AuthProfileToolMiddlewareConfig,
): ToolMiddleware {
  return async (ctx: ToolCallContext, next: ToolMiddlewareNext): Promise<ToolCallResult> => {
    const tool = ctx.tool;

    // Only process tools with auth_profile_ref
    if (!tool?.auth_profile_ref) {
      return next(ctx);
    }

    try {
      const authResult = await resolveToolAuth(tool, config.tenantId, config.environment, {
        projectId: config.projectId,
        userId: config.userId,
        sessionPrincipalId: config.sessionPrincipalId,
        authScope: config.authScope,
        configVarStore: config.configVarStore,
        workflowContext: config.workflowContext,
      });

      if (authResult.source === 'auth_profile') {
        validateResolvedAuthSupport(tool, authResult);

        const patchedTool = patchToolWithResolvedAuth(tool, {
          headers: authResult.headers,
          queryParams: authResult.queryParams,
          tlsOptions: authResult.tlsOptions,
          wsSecurityCredentials: authResult.wsSecurityCredentials,
          signRequest: authResult.signRequest,
          digestCredentials: authResult.digestCredentials,
          awsSigV4: getPatchedAwsSigV4Context(authResult),
        });

        log.debug('Auth profile credentials applied to tool', {
          toolName: tool.name,
          source: authResult.source,
          authType: authResult.authType,
          headerCount: Object.keys(authResult.headers).length,
          queryParamCount: Object.keys(authResult.queryParams ?? {}).length,
          hasTlsOptions: !!authResult.tlsOptions,
        });

        // Emit tool_auth_resolved trace event for observability
        if (config.onToolAuthResolved && config.agentName) {
          const toolProv = (tool as { _moduleProvenance?: { alias: string } })._moduleProvenance;
          config.onToolAuthResolved({
            agentName: config.agentName,
            toolName: tool.name,
            profileName: tool.auth_profile_ref!,
            scope: config.projectId ? 'project' : 'tenant',
            moduleAlias: toolProv?.alias,
          });
        }

        return next({ ...ctx, tool: patchedTool });
      }
    } catch (err) {
      // FR-9: workflow tool_calls reject per_user / JIT profiles with a
      // structured envelope so the workflow engine can surface a clean
      // error rather than a 500 from the route's outer catch.
      if (isErrorWithCode(err, 'AUTH_PROFILE_PER_USER_IN_WORKFLOW')) {
        const sanitized = sanitizeAuthProfileError(err);
        log.info('Rejected per_user profile in workflow context', {
          toolName: tool.name,
          authProfileRef: tool.auth_profile_ref,
        });
        return {
          result: JSON.stringify({
            error: sanitized.userMessage,
            code: sanitized.code,
          }),
        };
      }
      if (isErrorWithCode(err, 'JIT_AUTH_NOT_SUPPORTED')) {
        log.info('Rejected JIT profile in workflow context', {
          toolName: tool.name,
          authProfileRef: tool.auth_profile_ref,
        });
        return {
          result: JSON.stringify({
            error: 'JIT auth profiles are not supported for workflow tool calls.',
            code: 'JIT_AUTH_NOT_SUPPORTED',
            authCode: AUTH_JIT_UNSUPPORTED_CODE,
          }),
        };
      }

      // Phase 5: JIT auth — if tool has jit_auth and profile not found,
      // pause execution and send auth_challenge to client
      if (
        (err instanceof AuthProfileNotFoundError || err instanceof AuthProfileTokenRequiredError) &&
        tool.jit_auth
      ) {
        if (config.sessionId && config.sendAuthChallenge) {
          return handleJitAuth(ctx, next, config, tool);
        }

        log.info('JIT auth requested on a non-interactive channel', {
          toolName: tool.name,
          authProfileRef: tool.auth_profile_ref,
          sessionId: config.sessionId,
        });

        return {
          result: JSON.stringify({
            error:
              `JIT auth is not supported for auth profile "${tool.auth_profile_ref}". ` +
              'This channel cannot deliver an interactive authorization challenge. ' +
              'Complete consent ahead of time or retry through an interactive client.',
            code: 'JIT_AUTH_NOT_SUPPORTED',
            authCode: AUTH_JIT_UNSUPPORTED_CODE,
          }),
        };
      }

      log.error('Failed to resolve auth profile for tool', {
        toolName: tool.name,
        authProfileRef: tool.auth_profile_ref,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }

    return next(ctx);
  };
}

/**
 * Handle JIT auth: pause execution, send challenge, await response, retry.
 */
async function handleJitAuth(
  ctx: ToolCallContext,
  next: ToolMiddlewareNext,
  config: AuthProfileToolMiddlewareConfig,
  tool: NonNullable<ToolCallContext['tool']>,
): Promise<ToolCallResult> {
  const store = getPausedExecutionStore();
  const timeoutMs = store.getTimeoutMs();
  const toolCallId = `jit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const sessionId = config.sessionId!;
  let profileName = tool.auth_profile_ref ?? 'unknown';

  if (tool.auth_profile_ref?.includes('{{') && config.projectId) {
    const resolvedProfileName = await resolveAuthProfileRef(
      tool.auth_profile_ref,
      config.tenantId,
      config.projectId,
      config.configVarStore,
      tool.variable_namespace_ids,
    );

    if (!resolvedProfileName) {
      return {
        result: JSON.stringify({
          error: `Interactive authorization could not be started because auth_profile_ref "${tool.auth_profile_ref}" could not be resolved for tool "${tool.name}".`,
          code: 'AUTH_SETUP_ERROR',
        }),
      };
    }

    profileName = resolvedProfileName;
  }

  log.info('JIT auth triggered — pausing tool execution', {
    toolName: tool.name,
    toolCallId,
    sessionId,
    authProfileRef: profileName,
  });

  // Try to get OAuth URL for the challenge message
  let authUrl: string | undefined;
  let initiationFailed = false;
  const requestedScopes = extractRequestedOAuthScopes(tool);
  const connectionMode = tool.connection_mode ?? 'per_user';
  if (config.initiateJitOAuth) {
    try {
      authUrl = await config.initiateJitOAuth({
        profileId: profileName,
        authProfileRef: profileName,
        sessionId,
        toolCallId,
        projectId: config.projectId,
        environment: config.environment,
        scopes: requestedScopes,
        connectionMode,
      });
    } catch (oauthErr) {
      initiationFailed = true;
      log.warn('Failed to initiate JIT OAuth', {
        error: oauthErr instanceof Error ? oauthErr.message : String(oauthErr),
        toolCallId,
      });
    }
  }

  if (!config.initiateJitOAuth) {
    log.warn('JIT auth not supported — no OAuth initiation available for this profile', {
      toolName: tool.name,
      profileName,
    });
    return {
      result: JSON.stringify({
        error: `JIT auth is not supported for auth profile "${profileName}". Only OAuth-type profiles support interactive authorization.`,
        code: 'JIT_AUTH_NOT_SUPPORTED',
        authCode: AUTH_JIT_UNSUPPORTED_CODE,
      }),
    };
  }

  if (!authUrl) {
    const error = initiationFailed
      ? 'Interactive authorization could not be started for this profile. Check the OAuth provider setup and try again.'
      : `JIT auth is not supported for auth profile "${profileName}". Only OAuth-type profiles support interactive authorization.`;
    const code = initiationFailed ? 'AUTH_SETUP_ERROR' : 'JIT_AUTH_NOT_SUPPORTED';
    return {
      result: JSON.stringify({
        error,
        code,
        ...(initiationFailed ? {} : { authCode: AUTH_JIT_UNSUPPORTED_CODE }),
      }),
    };
  }

  const pauseWaiter = store.pause({
    sessionId,
    toolCallId,
    authProfileRef: profileName,
    toolName: tool.name,
    pausedAt: Date.now(),
    timeoutMs,
  });
  let challengeSent = false;

  try {
    await pauseWaiter.ready;

    // Send auth_challenge only after the paused execution is registered locally
    // and visible through Redis to avoid callback/response races.
    try {
      config.sendAuthChallenge!({
        sessionId,
        toolCallId,
        authType: 'oauth2',
        authUrl,
        profileId: profileName,
        profileName,
        prompt: `This tool requires authorization for ${profileName}`,
        timeoutMs,
      });
      challengeSent = true;
    } catch (challengeErr) {
      const deliveryError =
        challengeErr instanceof Error ? challengeErr : new Error(String(challengeErr));
      store.reject(toolCallId, deliveryError);
      return {
        result: JSON.stringify({
          error:
            'Interactive authorization challenge could not be delivered to the client. Retry the tool call.',
          code: 'AUTH_SETUP_ERROR',
        }),
      };
    }

    // Pause execution — this Promise resolves when auth_response is received
    await pauseWaiter;
  } catch (pauseErr) {
    if (pauseErr instanceof AuthTimeoutError) {
      log.warn('JIT auth timed out', { toolCallId, toolName: tool.name });
      return {
        result: JSON.stringify({
          error: pauseErr.message,
          code: 'AUTH_TIMEOUT',
        }),
      };
    }
    if (pauseErr instanceof AuthCancelledError) {
      log.info('JIT auth cancelled by user', { toolCallId, toolName: tool.name });
      return {
        result: JSON.stringify({
          error: pauseErr.message,
          code: 'AUTH_CANCELLED',
        }),
      };
    }
    if (pauseErr instanceof SessionDisconnectedError) {
      return {
        result: JSON.stringify({
          error: pauseErr.message,
          code: 'AUTH_CANCELLED',
        }),
      };
    }
    return {
      result: JSON.stringify({
        error: pauseErr instanceof Error ? pauseErr.message : String(pauseErr),
        code: challengeSent ? 'AUTH_ERROR' : 'AUTH_SETUP_ERROR',
      }),
    };
  }

  // Auth completed — retry tool call with fresh credentials
  log.info('JIT auth completed — retrying tool call', {
    toolCallId,
    toolName: tool.name,
  });

  try {
    const freshResult = await resolveToolAuth(tool, config.tenantId, config.environment, {
      projectId: config.projectId,
      userId: config.userId,
      sessionPrincipalId: config.sessionPrincipalId,
      authScope: config.authScope,
      configVarStore: config.configVarStore,
    });

    if (freshResult.source === 'auth_profile') {
      validateResolvedAuthSupport(tool, freshResult);

      const patchedTool = patchToolWithResolvedAuth(tool, {
        headers: freshResult.headers,
        queryParams: freshResult.queryParams,
        tlsOptions: freshResult.tlsOptions,
        wsSecurityCredentials: freshResult.wsSecurityCredentials,
        signRequest: freshResult.signRequest,
        digestCredentials: freshResult.digestCredentials,
        awsSigV4: getPatchedAwsSigV4Context(freshResult),
      });
      return next({ ...ctx, tool: patchedTool });
    }
  } catch (retryErr) {
    log.error('Failed to resolve credentials after JIT auth', {
      toolName: tool.name,
      error: retryErr instanceof Error ? retryErr.message : String(retryErr),
    });
    return {
      result: JSON.stringify({
        error: 'Credentials could not be resolved after authorization. Please try again.',
        code: 'AUTH_RETRY_FAILED',
      }),
    };
  }

  // Fall through — credentials resolved but no headers (shouldn't happen often)
  return next(ctx);
}

function validateResolvedAuthSupport(
  tool: NonNullable<ToolCallContext['tool']>,
  authResult: Awaited<ReturnType<typeof resolveToolAuth>>,
): void {
  if (!authResult.authType || !isPhase2CoreAuthType(authResult.authType)) {
    return;
  }

  if (!tool.http_binding) {
    throw new ToolExecutionError({
      code: 'TOOL_AUTH_FAILED',
      message:
        `Auth profile type "${authResult.authType}" is only honored on supported HTTP tool paths. ` +
        `Tool "${tool.name}" does not define an HTTP binding, so execution was blocked.`,
      toolName: tool.name,
      toolType: tool.tool_type,
      retryable: false,
    });
  }

  const supportDecision = getAuthProfileSupportDecision(authResult.authType, 'http_tool');
  if (supportDecision.level !== 'supported' || !supportDecision.runtimeHonored) {
    throw new ToolExecutionError({
      code: 'TOOL_AUTH_FAILED',
      message: supportDecision.message,
      toolName: tool.name,
      toolType: tool.tool_type,
      retryable: false,
    });
  }

  if (authResult.authType === 'mtls' && isPlainHttpEndpoint(tool.http_binding.endpoint)) {
    throw new ToolExecutionError({
      code: 'TOOL_AUTH_FAILED',
      message:
        'mTLS auth requires an https:// endpoint on the HTTP tool path. Update the tool endpoint to HTTPS or use a different auth profile.',
      toolName: tool.name,
      toolType: tool.tool_type,
      retryable: false,
    });
  }

  if (
    authResult.authType === 'aws_iam' &&
    (!authResult.awsSigV4?.region || !authResult.awsSigV4.service)
  ) {
    throw new ToolExecutionError({
      code: 'TOOL_AUTH_FAILED',
      message:
        'AWS IAM auth requires both region and service before a request can be signed. Update the auth profile configuration and retry.',
      toolName: tool.name,
      toolType: tool.tool_type,
      retryable: false,
    });
  }
}

function patchToolWithResolvedAuth(
  tool: NonNullable<ToolCallContext['tool']>,
  opts: {
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
    awsSigV4?: AwsSigV4Context & { service: string };
  },
): NonNullable<ToolCallContext['tool']> {
  const {
    headers,
    queryParams,
    tlsOptions,
    wsSecurityCredentials,
    signRequest,
    digestCredentials,
    awsSigV4,
  } = opts;
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
          ...(awsSigV4 ? { sigv4_auth: awsSigV4 } : {}),
          auth: { type: 'none' as const },
        }
      : tool.http_binding,
  };
}

function getPatchedAwsSigV4Context(
  authResult: Awaited<ReturnType<typeof resolveToolAuth>>,
): (AwsSigV4Context & { service: string }) | undefined {
  if (authResult.authType !== 'aws_iam' || !authResult.awsSigV4?.service) {
    return undefined;
  }

  return {
    ...authResult.awsSigV4,
    service: authResult.awsSigV4.service,
  };
}

function isPlainHttpEndpoint(endpoint: string): boolean {
  return endpoint.trim().toLowerCase().startsWith('http://');
}

function extractRequestedOAuthScopes(
  tool: Pick<NonNullable<ToolCallContext['tool']>, 'http_binding'>,
): string[] {
  const scopes = tool.http_binding?.auth?.config?.oauth?.scopes;
  if (!Array.isArray(scopes)) {
    return [];
  }

  return Array.from(
    new Set(
      scopes
        .filter((scope): scope is string => typeof scope === 'string')
        .map((scope) => scope.trim())
        .filter((scope) => scope.length > 0),
    ),
  );
}
