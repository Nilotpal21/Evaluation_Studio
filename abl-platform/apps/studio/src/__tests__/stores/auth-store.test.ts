/**
 * Auth Store Tests
 *
 * Comprehensive tests for the Zustand auth store: login/logout flows,
 * token management, JWT tenantId extraction, user state transitions,
 * selectors, and persist behavior.
 *
 * @vitest-environment happy-dom
 */

import { describe, test, expect, beforeEach } from 'vitest';
import {
  useAuthStore,
  selectIsAuthenticated,
  selectUser,
  selectAccessToken,
  selectTenantId,
} from '../../store/auth-store';
import type { User } from '../../store/auth-store';

// =============================================================================
// HELPERS
// =============================================================================

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: 'user-1',
    email: 'test@example.com',
    name: 'Test User',
    ...overrides,
  };
}

/**
 * Create a fake JWT with a given payload (base64-encoded, not signed).
 */
function fakeJWT(payload: Record<string, unknown>): string {
  const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = btoa(JSON.stringify(payload));
  const sig = 'fake-signature';
  return `${header}.${body}.${sig}`;
}

// =============================================================================
// TESTS
// =============================================================================

describe('Auth Store', () => {
  beforeEach(() => {
    // Reset to clean unauthenticated state
    useAuthStore.setState({
      user: null,
      accessToken: null,
      tenantId: null,
      isAuthenticated: false,
      isLoading: true,
    });
  });

  // ---------------------------------------------------------------------------
  // 1. Initial state
  // ---------------------------------------------------------------------------
  describe('initial state', () => {
    test('has correct default values', () => {
      const state = useAuthStore.getState();

      expect(state.user).toBeNull();
      expect(state.accessToken).toBeNull();
      expect(state.tenantId).toBeNull();
      expect(state.isAuthenticated).toBe(false);
      expect(state.isLoading).toBe(true);
    });

    test('all action functions are defined', () => {
      const state = useAuthStore.getState();

      expect(typeof state.setAuth).toBe('function');
      expect(typeof state.setTenantId).toBe('function');
      expect(typeof state.setTokens).toBe('function');
      expect(typeof state.setUser).toBe('function');
      expect(typeof state.clearAuth).toBe('function');
      expect(typeof state.setLoading).toBe('function');
    });
  });

  // ---------------------------------------------------------------------------
  // 2. setAuth()
  // ---------------------------------------------------------------------------
  describe('setAuth()', () => {
    test('sets user, accessToken, and isAuthenticated', () => {
      const user = makeUser();
      const token = fakeJWT({ sub: 'user-1' });

      useAuthStore.getState().setAuth(user, token);

      const state = useAuthStore.getState();
      expect(state.user).toEqual(user);
      expect(state.accessToken).toBe(token);
      expect(state.isAuthenticated).toBe(true);
      expect(state.isLoading).toBe(false);
    });

    test('uses explicit tenantId when provided', () => {
      const user = makeUser();
      const token = fakeJWT({ tenantId: 'jwt-tenant' });

      useAuthStore.getState().setAuth(user, token, 'explicit-tenant');

      expect(useAuthStore.getState().tenantId).toBe('explicit-tenant');
    });

    test('extracts tenantId from JWT when not provided explicitly', () => {
      const user = makeUser();
      const token = fakeJWT({ tenantId: 'from-jwt' });

      useAuthStore.getState().setAuth(user, token);

      expect(useAuthStore.getState().tenantId).toBe('from-jwt');
    });

    test('sets tenantId to null when not in JWT and not provided explicitly', () => {
      const user = makeUser();
      const token = fakeJWT({ sub: 'user-1' }); // No tenantId

      useAuthStore.getState().setAuth(user, token);

      expect(useAuthStore.getState().tenantId).toBeNull();
    });

    test('handles malformed JWT payload gracefully', () => {
      const user = makeUser();
      const malformedToken = 'not.valid-base64.token';

      // Should not throw
      useAuthStore.getState().setAuth(user, malformedToken);

      const state = useAuthStore.getState();
      expect(state.user).toEqual(user);
      expect(state.isAuthenticated).toBe(true);
      expect(state.tenantId).toBeNull();
    });

    test('sets isLoading to false', () => {
      useAuthStore.setState({ isLoading: true });

      useAuthStore.getState().setAuth(makeUser(), fakeJWT({}));

      expect(useAuthStore.getState().isLoading).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // 3. setTenantId()
  // ---------------------------------------------------------------------------
  describe('setTenantId()', () => {
    test('sets tenantId', () => {
      useAuthStore.getState().setTenantId('tenant-123');

      expect(useAuthStore.getState().tenantId).toBe('tenant-123');
    });

    test('overwrites existing tenantId', () => {
      useAuthStore.getState().setTenantId('tenant-old');
      useAuthStore.getState().setTenantId('tenant-new');

      expect(useAuthStore.getState().tenantId).toBe('tenant-new');
    });
  });

  // ---------------------------------------------------------------------------
  // 4. setTokens()
  // ---------------------------------------------------------------------------
  describe('setTokens()', () => {
    test('sets accessToken', () => {
      const token = fakeJWT({ sub: 'user-1' });
      useAuthStore.getState().setTokens(token);

      expect(useAuthStore.getState().accessToken).toBe(token);
    });

    test('extracts tenantId from new token', () => {
      const token = fakeJWT({ tenantId: 'rotated-tenant' });
      useAuthStore.getState().setTokens(token);

      expect(useAuthStore.getState().tenantId).toBe('rotated-tenant');
    });

    test('does not clear existing tenantId when new token has no tenantId', () => {
      useAuthStore.setState({ tenantId: 'existing-tenant' });

      const token = fakeJWT({ sub: 'user-1' }); // No tenantId
      useAuthStore.getState().setTokens(token);

      // When token has no tenantId, spread is empty so tenantId stays
      expect(useAuthStore.getState().tenantId).toBe('existing-tenant');
    });

    test('handles malformed token gracefully', () => {
      useAuthStore.setState({ tenantId: 'keep-this' });

      useAuthStore.getState().setTokens('broken.token');

      // Should not throw, tenantId stays unchanged
      expect(useAuthStore.getState().tenantId).toBe('keep-this');
    });
  });

  // ---------------------------------------------------------------------------
  // 5. setUser()
  // ---------------------------------------------------------------------------
  describe('setUser()', () => {
    test('sets user and marks as authenticated', () => {
      const user = makeUser({ id: 'user-new', name: 'New User' });
      useAuthStore.getState().setUser(user);

      const state = useAuthStore.getState();
      expect(state.user).toEqual(user);
      expect(state.isAuthenticated).toBe(true);
      expect(state.isLoading).toBe(false);
    });

    test('overwrites existing user', () => {
      useAuthStore.getState().setUser(makeUser({ name: 'First' }));
      useAuthStore.getState().setUser(makeUser({ name: 'Second' }));

      expect(useAuthStore.getState().user!.name).toBe('Second');
    });

    test('does not affect accessToken or tenantId', () => {
      useAuthStore.setState({
        accessToken: 'existing-token',
        tenantId: 'existing-tenant',
      });

      useAuthStore.getState().setUser(makeUser());

      expect(useAuthStore.getState().accessToken).toBe('existing-token');
      expect(useAuthStore.getState().tenantId).toBe('existing-tenant');
    });
  });

  // ---------------------------------------------------------------------------
  // 6. clearAuth()
  // ---------------------------------------------------------------------------
  describe('clearAuth()', () => {
    test('resets all auth state to defaults', () => {
      // Set up full auth state
      useAuthStore.getState().setAuth(makeUser(), fakeJWT({ tenantId: 'tenant-1' }), 'tenant-1');

      useAuthStore.getState().clearAuth();

      const state = useAuthStore.getState();
      expect(state.user).toBeNull();
      expect(state.accessToken).toBeNull();
      expect(state.tenantId).toBeNull();
      expect(state.isAuthenticated).toBe(false);
      expect(state.isLoading).toBe(false);
    });

    test('sets isLoading to false (not back to initial true)', () => {
      useAuthStore.setState({ isLoading: true });
      useAuthStore.getState().clearAuth();

      expect(useAuthStore.getState().isLoading).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // 7. setLoading()
  // ---------------------------------------------------------------------------
  describe('setLoading()', () => {
    test('sets isLoading to true', () => {
      useAuthStore.setState({ isLoading: false });
      useAuthStore.getState().setLoading(true);
      expect(useAuthStore.getState().isLoading).toBe(true);
    });

    test('sets isLoading to false', () => {
      useAuthStore.getState().setLoading(false);
      expect(useAuthStore.getState().isLoading).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // 8. Selectors
  // ---------------------------------------------------------------------------
  describe('selectors', () => {
    test('selectIsAuthenticated returns isAuthenticated', () => {
      expect(selectIsAuthenticated(useAuthStore.getState())).toBe(false);

      useAuthStore.getState().setAuth(makeUser(), fakeJWT({}));
      expect(selectIsAuthenticated(useAuthStore.getState())).toBe(true);
    });

    test('selectUser returns user', () => {
      expect(selectUser(useAuthStore.getState())).toBeNull();

      const user = makeUser({ name: 'Alice' });
      useAuthStore.getState().setUser(user);
      expect(selectUser(useAuthStore.getState())).toEqual(user);
    });

    test('selectAccessToken returns accessToken', () => {
      expect(selectAccessToken(useAuthStore.getState())).toBeNull();

      const token = fakeJWT({});
      useAuthStore.getState().setTokens(token);
      expect(selectAccessToken(useAuthStore.getState())).toBe(token);
    });

    test('selectTenantId returns tenantId', () => {
      expect(selectTenantId(useAuthStore.getState())).toBeNull();

      useAuthStore.getState().setTenantId('tenant-sel');
      expect(selectTenantId(useAuthStore.getState())).toBe('tenant-sel');
    });
  });

  // ---------------------------------------------------------------------------
  // 9. User state transitions
  // ---------------------------------------------------------------------------
  describe('user state transitions', () => {
    test('full login flow: setLoading -> setAuth -> authenticated', () => {
      useAuthStore.getState().setLoading(true);
      expect(useAuthStore.getState().isLoading).toBe(true);
      expect(useAuthStore.getState().isAuthenticated).toBe(false);

      const user = makeUser();
      const token = fakeJWT({ tenantId: 'my-tenant' });
      useAuthStore.getState().setAuth(user, token);

      const state = useAuthStore.getState();
      expect(state.isLoading).toBe(false);
      expect(state.isAuthenticated).toBe(true);
      expect(state.user).toEqual(user);
      expect(state.tenantId).toBe('my-tenant');
    });

    test('full logout flow: clearAuth -> unauthenticated', () => {
      useAuthStore.getState().setAuth(makeUser(), fakeJWT({ tenantId: 't1' }));
      expect(useAuthStore.getState().isAuthenticated).toBe(true);

      useAuthStore.getState().clearAuth();

      const state = useAuthStore.getState();
      expect(state.isAuthenticated).toBe(false);
      expect(state.user).toBeNull();
      expect(state.accessToken).toBeNull();
      expect(state.tenantId).toBeNull();
    });

    test('token rotation flow: setTokens updates token and re-extracts tenantId', () => {
      const user = makeUser();
      useAuthStore.getState().setAuth(user, fakeJWT({ tenantId: 'tenant-v1' }));
      expect(useAuthStore.getState().tenantId).toBe('tenant-v1');

      // Token rotates to new tenant
      useAuthStore.getState().setTokens(fakeJWT({ tenantId: 'tenant-v2' }));
      expect(useAuthStore.getState().tenantId).toBe('tenant-v2');
      // User stays unchanged
      expect(useAuthStore.getState().user).toEqual(user);
    });
  });

  // ---------------------------------------------------------------------------
  // 10. Persist behavior
  // ---------------------------------------------------------------------------
  describe('persist behavior', () => {
    test('store uses persist middleware', () => {
      // The persist middleware adds a .persist property to the store
      const persistApi = (useAuthStore as any).persist;
      expect(persistApi).toBeDefined();
    });
  });

  // ---------------------------------------------------------------------------
  // 11. Edge cases
  // ---------------------------------------------------------------------------
  describe('edge cases', () => {
    test('setAuth with empty string token', () => {
      useAuthStore.getState().setAuth(makeUser(), '');

      const state = useAuthStore.getState();
      expect(state.accessToken).toBe('');
      expect(state.isAuthenticated).toBe(true);
      expect(state.tenantId).toBeNull();
    });

    test('user with optional fields', () => {
      const minimalUser: User = { id: 'user-min', email: 'min@test.com' };
      useAuthStore.getState().setUser(minimalUser);

      const user = useAuthStore.getState().user;
      expect(user!.id).toBe('user-min');
      expect(user!.name).toBeUndefined();
      expect(user!.avatarUrl).toBeUndefined();
    });

    test('user with all optional fields', () => {
      const fullUser: User = {
        id: 'user-full',
        email: 'full@test.com',
        name: 'Full User',
        avatarUrl: 'https://example.com/avatar.png',
      };
      useAuthStore.getState().setUser(fullUser);

      const user = useAuthStore.getState().user;
      expect(user!.avatarUrl).toBe('https://example.com/avatar.png');
    });
  });
});
