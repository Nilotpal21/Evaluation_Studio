/**
 * Authentication Store
 *
 * Manages user authentication state with Zustand.
 * Only tenantId is persisted; access tokens are re-obtained via httpOnly
 * refresh cookie on page load (initializeAuth).
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export const LOGOUT_SIGNAL_EVENT = 'studio-auth:logout';

export type LogoutSignalReason =
  | 'explicit-logout'
  | 'browser_idle_logout'
  | 'cross-tab-sync'
  | 'access_token_refresh_failed';

export type IdleLockReason = 'recoverable_session';

export function signalLogout(reason: LogoutSignalReason): void {
  if (typeof window === 'undefined') {
    return;
  }

  window.dispatchEvent(
    new CustomEvent<LogoutSignalReason>(LOGOUT_SIGNAL_EVENT, {
      detail: reason,
    }),
  );
}

// =============================================================================
// TYPES
// =============================================================================

export interface User {
  id: string;
  email: string;
  name?: string;
  avatarUrl?: string;
  isSuperAdmin?: boolean;
  /** Workspace role for the active tenant (e.g. OWNER, ADMIN, MEMBER). */
  role?: string | null;
  /** Resolved RBAC permissions for the active tenant (e.g. ['billing:read']). */
  permissions?: string[];
  /** Workspace creation permission — absent or true = can create; false = restricted. */
  canCreateWorkspace?: boolean;
}

interface AuthState {
  user: User | null;
  accessToken: string | null;
  tenantId: string | null;
  isSuperAdmin: boolean;
  isAuthenticated: boolean;
  isLoading: boolean;
  idleLockReason: IdleLockReason | null;

  // Actions
  setAuth: (user: User, accessToken: string, tenantId?: string) => void;
  setTenantId: (tenantId: string) => void;
  setTokens: (accessToken: string) => void;
  setUser: (user: User) => void;
  clearAuth: () => void;
  setLoading: (loading: boolean) => void;
  setIdleLock: (reason: IdleLockReason | null) => void;
  clearIdleLock: () => void;
}

// =============================================================================
// STORE
// =============================================================================

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      user: null,
      accessToken: null,
      tenantId: null,
      isSuperAdmin: false,
      isAuthenticated: false,
      isLoading: true,
      idleLockReason: null,

      setAuth: (user, accessToken, tenantId?) => {
        // Extract tenantId from JWT payload if not provided explicitly
        let resolvedTenantId = tenantId ?? null;
        const enrichedUser = { ...user };
        if (accessToken) {
          try {
            const payload = JSON.parse(atob(accessToken.split('.')[1]));
            if (!resolvedTenantId && payload.tenantId) resolvedTenantId = payload.tenantId;
            if (payload.canCreateWorkspace === false) {
              enrichedUser.canCreateWorkspace = false;
            }
          } catch {
            // Ignore decode errors
          }
        }
        set({
          user: enrichedUser,
          accessToken,
          tenantId: resolvedTenantId,
          isSuperAdmin: !!enrichedUser.isSuperAdmin,
          isAuthenticated: true,
          isLoading: false,
          idleLockReason: null,
        });
      },

      setTenantId: (tenantId) => set({ tenantId }),

      setTokens: (accessToken) => {
        // Re-extract tenantId and canCreateWorkspace when tokens rotate
        let tenantId: string | null = null;
        let canCreateWorkspace: boolean | undefined;
        if (accessToken) {
          try {
            const payload = JSON.parse(atob(accessToken.split('.')[1]));
            if (payload.tenantId) tenantId = payload.tenantId;
            if (payload.canCreateWorkspace === false) canCreateWorkspace = false;
          } catch {
            // Ignore decode errors
          }
        }
        set((state) => ({
          accessToken,
          ...(tenantId ? { tenantId } : {}),
          ...(canCreateWorkspace !== undefined && state.user
            ? { user: { ...state.user, canCreateWorkspace } }
            : {}),
        }));
      },

      setUser: (user) =>
        set({
          user,
          isSuperAdmin: !!user.isSuperAdmin,
          isAuthenticated: true,
          isLoading: false,
          idleLockReason: null,
        }),

      clearAuth: () =>
        set({
          user: null,
          accessToken: null,
          tenantId: null,
          isSuperAdmin: false,
          isAuthenticated: false,
          isLoading: false,
          idleLockReason: null,
        }),

      setLoading: (isLoading) => set({ isLoading }),
      setIdleLock: (idleLockReason) => set({ idleLockReason }),
      clearIdleLock: () => set({ idleLockReason: null }),
    }),
    {
      name: 'kore-auth-storage',
      // Only persist tenantId. Access tokens stay in memory only — the
      // httpOnly refresh cookie re-obtains them on page load.
      partialize: (state) => ({
        tenantId: state.tenantId,
      }),
    },
  ),
);

// =============================================================================
// CROSS-TAB SESSION SYNC
// =============================================================================

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key !== 'kore-auth-storage') return;
    if (!event.newValue) {
      signalLogout('cross-tab-sync');
      useAuthStore.getState().clearAuth();
      return;
    }
    try {
      const parsed = JSON.parse(event.newValue);
      if (!parsed?.state?.tenantId) {
        signalLogout('cross-tab-sync');
        useAuthStore.getState().clearAuth();
      }
    } catch {
      signalLogout('cross-tab-sync');
      useAuthStore.getState().clearAuth();
    }
  });
}

// =============================================================================
// SELECTORS
// =============================================================================

export const selectIsAuthenticated = (state: AuthState) => state.isAuthenticated;
export const selectUser = (state: AuthState) => state.user;
export const selectAccessToken = (state: AuthState) => state.accessToken;
export const selectTenantId = (state: AuthState) => state.tenantId;
export const selectIsSuperAdmin = (state: AuthState) => state.isSuperAdmin;
