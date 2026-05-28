/**
 * Auth API Client
 *
 * Functions for authentication-related API calls.
 */

import { useArchUIStore } from '../lib/arch-ai/ui/store';
import {
  BROWSER_IDLE_TIMEOUT_MS,
  getTokenRemainingLifetimeSeconds,
} from '../lib/session-timeout-config';
import { useSessionStore } from '../store/session-store';
import { signalLogout, useAuthStore, type User } from '../store/auth-store';
import { AppError, ErrorCodes } from '@agent-platform/shared/errors';

// =============================================================================
// TYPES
// =============================================================================

interface TokenResponse {
  accessToken: string;
  expiresIn: number;
}

interface UserResponse {
  id: string;
  email: string;
  name?: string;
  avatarUrl?: string;
  isSuperAdmin?: boolean;
  canCreateWorkspace?: boolean;
  role?: string | null;
  permissions?: string[];
  createdAt: string;
  lastLoginAt: string | null;
}

export interface AuthInitializationResult {
  authenticated: boolean;
  accessToken: string | null;
  expiresIn: number | null;
  source: 'existing-token' | 'refreshed-token' | 'none';
}

// =============================================================================
// API FUNCTIONS
// =============================================================================

/**
 * Get login URL for Google OAuth
 */
export function getGoogleLoginUrl(): string {
  return `/api/auth/google`;
}

/**
 * Fetch current user info
 */
export async function fetchCurrentUser(accessToken: string): Promise<User> {
  const response = await fetch(`/api/auth/me`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
    credentials: 'same-origin',
  });

  if (!response.ok) {
    throw new AppError('Failed to fetch user', { ...ErrorCodes.INTERNAL_ERROR });
  }

  const data: UserResponse = await response.json();
  const user: User = {
    id: data.id,
    email: data.email,
    name: data.name,
    avatarUrl: data.avatarUrl,
    role: data.role ?? null,
    permissions: data.permissions ?? [],
  };
  if (data.isSuperAdmin) {
    user.isSuperAdmin = true;
  }
  if (data.canCreateWorkspace === false) {
    user.canCreateWorkspace = false;
  }
  return user;
}

/**
 * Refresh access token using refresh token.
 * The server reads the refresh token from the httpOnly cookie.
 * Concurrent calls are deduplicated — the server rotates the refresh token
 * on each call, so a second in-flight request with the old token would 401.
 */
let refreshPromise: Promise<TokenResponse> | null = null;

export function refreshAccessToken(): Promise<TokenResponse> {
  if (refreshPromise) return refreshPromise;
  refreshPromise = doRefreshAccessToken().finally(() => {
    refreshPromise = null;
  });
  return refreshPromise;
}

async function doRefreshAccessToken(): Promise<TokenResponse> {
  const { tenantId } = useAuthStore.getState();
  const response = await fetch(`/api/auth/refresh`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    credentials: 'same-origin',
    body: JSON.stringify(tenantId ? { tenantId } : {}),
  });

  if (!response.ok) {
    throw new AppError('Failed to refresh token', { ...ErrorCodes.INTERNAL_ERROR });
  }

  return response.json();
}

/**
 * Logout - revoke refresh token and clear local auth state
 */
export async function logout(): Promise<void> {
  cancelTokenRefresh();
  stopIdleTimeout();
  signalLogout('explicit-logout');
  useAuthStore.getState().clearAuth();

  // Try to revoke token on server (best effort) — httpOnly cookie carries the refresh token
  try {
    await fetch(`/api/auth/logout`, {
      method: 'POST',
      credentials: 'same-origin',
    });
  } catch {
    // Ignore errors on logout
  }
}

/**
 * Exchange result includes token data plus optional metadata.
 */
interface ExchangeResult extends TokenResponse {
  needsOnboarding?: boolean;
  pendingInvitations?: number;
  pendingInvitationChoice?: boolean;
  inviteToken?: string;
}

/**
 * Handle OAuth callback - exchange one-time auth code for tokens via POST.
 * The auth code is extracted from the URL and exchanged server-side.
 * Tokens are never exposed in the URL.
 */
export async function handleOAuthCallback(
  searchParams: URLSearchParams,
): Promise<ExchangeResult | null> {
  const code = searchParams.get('code');

  if (!code) {
    return null;
  }

  const response = await fetch('/api/sso/exchange', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ code }),
  });

  if (!response.ok) {
    throw new AppError('Failed to exchange auth code', { ...ErrorCodes.SERVICE_UNAVAILABLE });
  }

  const data = await response.json();

  return {
    accessToken: data.accessToken,
    expiresIn: data.expiresIn || 900,
    needsOnboarding: data.needsOnboarding,
    pendingInvitations: data.pendingInvitations,
    pendingInvitationChoice: data.pendingInvitationChoice,
    inviteToken: data.inviteToken,
  };
}

/**
 * Initialize auth state from stored tokens.
 * If authenticated but no tenantId, redirects to onboarding.
 * The refresh token is stored as an httpOnly cookie, so we don't need it in memory.
 */
export async function initializeAuth(): Promise<AuthInitializationResult> {
  const { accessToken, setAuth, setLoading, clearAuth } = useAuthStore.getState();

  if (!accessToken) {
    // No access token in memory — try a cookie-based refresh (best effort)
    try {
      const tokens = await refreshAccessToken();
      const user = await fetchCurrentUser(tokens.accessToken);
      setAuth(user, tokens.accessToken);
      startIdleTimeout();
      scheduleTokenRefresh(tokens.expiresIn);
      checkOnboardingRedirect(tokens.accessToken);
      return {
        authenticated: true,
        accessToken: tokens.accessToken,
        expiresIn: tokens.expiresIn,
        source: 'refreshed-token',
      };
    } catch {
      cancelTokenRefresh();
      setLoading(false);
      return {
        authenticated: false,
        accessToken: null,
        expiresIn: null,
        source: 'none',
      };
    }
  }

  try {
    const user = await fetchCurrentUser(accessToken);
    const expiresIn = getTokenRemainingLifetimeSeconds(accessToken);
    setAuth(user, accessToken);
    startIdleTimeout();
    if (expiresIn !== null) {
      scheduleTokenRefresh(expiresIn);
    } else {
      cancelTokenRefresh();
    }
    checkOnboardingRedirect(accessToken);
    return {
      authenticated: true,
      accessToken,
      expiresIn,
      source: 'existing-token',
    };
  } catch {
    // Token might be expired, try to refresh (cookie-based)
    try {
      const tokens = await refreshAccessToken();
      const user = await fetchCurrentUser(tokens.accessToken);
      setAuth(user, tokens.accessToken);
      startIdleTimeout();
      scheduleTokenRefresh(tokens.expiresIn);
      checkOnboardingRedirect(tokens.accessToken);
      return {
        authenticated: true,
        accessToken: tokens.accessToken,
        expiresIn: tokens.expiresIn,
        source: 'refreshed-token',
      };
    } catch {
      cancelTokenRefresh();
      clearAuth();
      return {
        authenticated: false,
        accessToken: null,
        expiresIn: null,
        source: 'none',
      };
    }
  }
}

/**
 * If authenticated but no tenantId in JWT, redirect to onboarding.
 */
function checkOnboardingRedirect(accessToken: string): void {
  try {
    const payload = JSON.parse(atob(accessToken.split('.')[1]));
    // Super admins may not have a tenant — skip onboarding redirect
    if (payload.isSuperAdmin) return;
    if (
      !payload.tenantId &&
      typeof window !== 'undefined' &&
      !window.location.pathname.startsWith('/onboarding') &&
      !window.location.pathname.startsWith('/auth') &&
      !window.location.pathname.startsWith('/invite') &&
      !window.location.pathname.startsWith('/invitations')
    ) {
      window.location.href = '/onboarding';
    }
  } catch {
    // Ignore decode errors
  }
}

// =============================================================================
// TOKEN REFRESH SCHEDULER
// =============================================================================

let refreshTimeoutId: ReturnType<typeof setTimeout> | null = null;
let refreshRetryAttempts = 0;
let idleListenersAttached = false;

const TOKEN_REFRESH_BUFFER_SECONDS = 60;
const MIN_REFRESH_DELAY_MS = 10_000;
const TOKEN_REFRESH_RETRY_BASE_MS = 30_000;
const TOKEN_REFRESH_RETRY_MAX_MS = 5 * 60_000;

function scheduleRefreshAttempt(delayMs: number): void {
  if (refreshTimeoutId) {
    clearTimeout(refreshTimeoutId);
  }

  refreshTimeoutId = setTimeout(() => {
    void runScheduledTokenRefresh();
  }, delayMs);
}

function scheduleRefreshRetry(): void {
  const retryDelay = Math.min(
    TOKEN_REFRESH_RETRY_BASE_MS * 2 ** refreshRetryAttempts,
    TOKEN_REFRESH_RETRY_MAX_MS,
  );
  refreshRetryAttempts += 1;
  scheduleRefreshAttempt(retryDelay);
}

async function runScheduledTokenRefresh(): Promise<void> {
  const { accessToken, setTokens } = useAuthStore.getState();
  if (!accessToken) {
    return;
  }

  try {
    const tokens = await refreshAccessToken();
    refreshRetryAttempts = 0;
    setTokens(tokens.accessToken);
    scheduleTokenRefresh(tokens.expiresIn);
  } catch {
    scheduleRefreshRetry();
  }
}

/**
 * Schedule token refresh before expiry
 */
export function scheduleTokenRefresh(expiresIn: number): void {
  // Refresh 1 minute before expiry
  refreshRetryAttempts = 0;
  const refreshTime = Math.max(
    (expiresIn - TOKEN_REFRESH_BUFFER_SECONDS) * 1000,
    MIN_REFRESH_DELAY_MS,
  );

  scheduleRefreshAttempt(refreshTime);
}

/**
 * Cancel scheduled token refresh
 */
export function cancelTokenRefresh(): void {
  if (refreshTimeoutId) {
    clearTimeout(refreshTimeoutId);
    refreshTimeoutId = null;
  }
  refreshRetryAttempts = 0;
}

// =============================================================================
// IDLE SESSION TIMEOUT (30 minutes)
// =============================================================================

let idleTimerId: ReturnType<typeof setTimeout> | null = null;

function hasRecoverableSession(): boolean {
  const { sessionId } = useSessionStore.getState();
  if (sessionId) {
    return true;
  }

  const { session, resume } = useArchUIStore.getState();
  return Boolean(session?.id || resume);
}

function resetIdleTimer(): void {
  if (idleTimerId) clearTimeout(idleTimerId);
  idleTimerId = setTimeout(() => {
    const { isAuthenticated, clearAuth, setIdleLock } = useAuthStore.getState();
    if (!isAuthenticated) return;

    if (hasRecoverableSession()) {
      setIdleLock('recoverable_session');
      return;
    }

    cancelTokenRefresh();
    signalLogout('browser_idle_logout');
    clearAuth();
    if (typeof window !== 'undefined') {
      window.location.href = '/auth/login';
    }
  }, BROWSER_IDLE_TIMEOUT_MS);
}

export function startIdleTimeout(): void {
  if (typeof window === 'undefined') return;
  const events = ['mousedown', 'keydown', 'touchstart', 'scroll'] as const;
  if (!idleListenersAttached) {
    events.forEach((evt) => window.addEventListener(evt, resetIdleTimer, { passive: true }));
    idleListenersAttached = true;
  }
  resetIdleTimer();
}

export function stopIdleTimeout(): void {
  if (typeof window === 'undefined') return;
  if (idleTimerId) {
    clearTimeout(idleTimerId);
    idleTimerId = null;
  }
  const events = ['mousedown', 'keydown', 'touchstart', 'scroll'] as const;
  if (idleListenersAttached) {
    events.forEach((evt) => window.removeEventListener(evt, resetIdleTimer));
    idleListenersAttached = false;
  }
}
