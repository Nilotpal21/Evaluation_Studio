import crypto from 'node:crypto';
import { z } from 'zod';
import type { NextResponse } from 'next/server';

export const AUTH_PROFILE_OAUTH_CSRF_COOKIE = 'auth_profile_oauth_csrf';

const OAUTH_STATE_KEY_PREFIX = 'auth-profile:oauth-state:';
const OAUTH_STATE_TTL_SECONDS = 600;

const OAuthStatePayloadSchema = z
  .object({
    tenantId: z.string().min(1),
    projectId: z.string().min(1).nullable(),
    userId: z.string().min(1),
    authProfileId: z.string().min(1),
    scope: z.enum(['project', 'workspace']),
    csrfNonce: z.string().min(1),
    redirectUri: z.string().min(1),
    authProfileRef: z.string().min(1).optional(),
    environment: z.string().min(1).nullable().optional(),
    authProfileScope: z.enum(['tenant', 'project']).optional(),
    authProfileVisibility: z.enum(['shared', 'personal']).optional(),
    connectorName: z.string().min(1).optional(),
    sessionId: z.string().min(1).optional(),
    codeVerifier: z.string().min(1).optional(),
    isUserConsent: z.boolean().optional(),
    targetVisibility: z.enum(['shared', 'personal']).optional(),
    scopes: z.array(z.string()).optional(),
    connectionConfig: z.record(z.string()).optional(),
    createdAt: z.number().int().nonnegative().optional(),
  })
  .strict();

export type OAuthStatePayload = z.infer<typeof OAuthStatePayloadSchema>;

interface RedisStateClient {
  set(key: string, value: string, mode: 'EX', ttl: number): Promise<unknown>;
  getdel?: (key: string) => Promise<string | null>;
  get?: (key: string) => Promise<string | null>;
  del?: (key: string) => Promise<number>;
}

export interface CreateOAuthStateInput {
  tenantId: string;
  projectId: string | null;
  userId: string;
  authProfileId: string;
  scope: 'project' | 'workspace';
  redirectUri: string;
  authProfileRef?: string;
  environment?: string | null;
  authProfileScope?: 'tenant' | 'project';
  authProfileVisibility?: 'shared' | 'personal';
  connectorName?: string;
  sessionId?: string;
  codeVerifier?: string;
  isUserConsent?: boolean;
  targetVisibility?: 'shared' | 'personal';
  scopes?: string[];
  connectionConfig?: Record<string, string>;
}

export interface OAuthStateVerificationFailure {
  reason:
    | 'tenant_binding_mismatch'
    | 'project_binding_mismatch'
    | 'scope_mismatch'
    | 'user_binding_mismatch'
    | 'csrf_mismatch'
    | 'redirect_uri_mismatch';
  message: string;
}

function buildStateKey(state: string): string {
  return `${OAUTH_STATE_KEY_PREFIX}${state}`;
}

export async function createOAuthState(
  redis: RedisStateClient,
  payload: CreateOAuthStateInput,
): Promise<{ state: string; csrfNonce: string }> {
  const state = crypto.randomBytes(32).toString('hex');
  const csrfNonce = crypto.randomBytes(24).toString('hex');

  const statePayload: OAuthStatePayload = {
    tenantId: payload.tenantId,
    projectId: payload.projectId,
    userId: payload.userId,
    authProfileId: payload.authProfileId,
    scope: payload.scope,
    csrfNonce,
    redirectUri: payload.redirectUri,
    ...(payload.authProfileRef ? { authProfileRef: payload.authProfileRef } : {}),
    ...(payload.environment !== undefined ? { environment: payload.environment } : {}),
    ...(payload.authProfileScope ? { authProfileScope: payload.authProfileScope } : {}),
    ...(payload.authProfileVisibility
      ? { authProfileVisibility: payload.authProfileVisibility }
      : {}),
    ...(payload.connectorName ? { connectorName: payload.connectorName } : {}),
    ...(payload.sessionId ? { sessionId: payload.sessionId } : {}),
    ...(payload.codeVerifier ? { codeVerifier: payload.codeVerifier } : {}),
    ...(payload.isUserConsent !== undefined ? { isUserConsent: payload.isUserConsent } : {}),
    ...(payload.targetVisibility ? { targetVisibility: payload.targetVisibility } : {}),
    ...(payload.scopes ? { scopes: payload.scopes } : {}),
    ...(payload.connectionConfig ? { connectionConfig: payload.connectionConfig } : {}),
    createdAt: Date.now(),
  };

  await redis.set(
    buildStateKey(state),
    JSON.stringify(statePayload),
    'EX',
    OAUTH_STATE_TTL_SECONDS,
  );

  return { state, csrfNonce };
}

export async function consumeOAuthState(
  redis: RedisStateClient,
  state: string,
): Promise<OAuthStatePayload | null> {
  const key = buildStateKey(state);
  let raw: string | null = null;

  if (typeof redis.getdel === 'function') {
    raw = await redis.getdel(key);
  } else {
    if (typeof redis.get !== 'function') return null;
    raw = await redis.get(key);
    if (raw && typeof redis.del === 'function') {
      await redis.del(key);
    }
  }

  if (!raw) {
    return null;
  }

  return parseOAuthStatePayload(raw);
}

export async function peekOAuthState(
  redis: RedisStateClient,
  state: string,
): Promise<OAuthStatePayload | null> {
  if (typeof redis.get !== 'function') {
    return null;
  }

  const raw = await redis.get(buildStateKey(state));
  return parseOAuthStatePayload(raw);
}

function parseOAuthStatePayload(raw: string | null): OAuthStatePayload | null {
  if (!raw) {
    return null;
  }

  let parsedRaw: unknown;
  try {
    parsedRaw = JSON.parse(raw);
  } catch {
    return null;
  }

  const parsed = OAuthStatePayloadSchema.safeParse(parsedRaw);
  if (!parsed.success) {
    return null;
  }

  return parsed.data;
}

export function verifyOAuthStateBindings(params: {
  state: OAuthStatePayload;
  tenantId: string;
  userId: string;
  scope: 'project' | 'workspace';
  projectId: string | null;
  csrfNonce: string | undefined;
  redirectUri: string;
}): OAuthStateVerificationFailure | null {
  const { state, tenantId, userId, scope, projectId, csrfNonce, redirectUri } = params;

  if (state.tenantId !== tenantId) {
    return {
      reason: 'tenant_binding_mismatch',
      message: 'OAuth state tenant mismatch',
    };
  }

  if (state.scope !== scope) {
    return {
      reason: 'scope_mismatch',
      message: 'OAuth state scope mismatch',
    };
  }

  if (scope === 'project' && state.projectId !== projectId) {
    return {
      reason: 'project_binding_mismatch',
      message: 'OAuth state project mismatch',
    };
  }

  if (scope === 'workspace' && state.projectId !== null) {
    return {
      reason: 'project_binding_mismatch',
      message: 'OAuth state project mismatch',
    };
  }

  if (state.userId !== userId) {
    return {
      reason: 'user_binding_mismatch',
      message: 'OAuth state user mismatch',
    };
  }

  if (!csrfNonce || csrfNonce !== state.csrfNonce) {
    return {
      reason: 'csrf_mismatch',
      message: 'OAuth CSRF verification failed',
    };
  }

  if (state.redirectUri !== redirectUri) {
    return {
      reason: 'redirect_uri_mismatch',
      message: 'OAuth redirect URI mismatch',
    };
  }

  return null;
}

export function setOAuthCsrfCookie(response: NextResponse, csrfNonce: string): void {
  response.cookies.set(AUTH_PROFILE_OAUTH_CSRF_COOKIE, csrfNonce, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: OAUTH_STATE_TTL_SECONDS,
    path: '/',
  });
}

export function clearOAuthCsrfCookie(response: NextResponse): void {
  response.cookies.set(AUTH_PROFILE_OAUTH_CSRF_COOKIE, '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 0,
    path: '/',
  });
}
