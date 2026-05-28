/**
 * Profile Store Tests
 *
 * Verifies Zustand store actions for behavior profile management.
 */

import { describe, test, expect, beforeEach } from 'vitest';
import { useProfileStore, type ProfileSummary } from '../../store/profile-store';

// =============================================================================
// HELPERS
// =============================================================================

function makeProfile(overrides: Partial<ProfileSummary> = {}): ProfileSummary {
  return {
    name: 'vip_customer',
    priority: 10,
    whenExpression: 'context.customer_tier == "vip"',
    dslContent: 'BEHAVIOR_PROFILE: vip_customer\nPRIORITY: 10',
    overrideCategories: ['instructions', 'constraints'],
    usedByAgents: ['booking_agent', 'support_agent'],
    updatedAt: '2026-03-01T12:00:00Z',
    ...overrides,
  };
}

function resetStore(): void {
  useProfileStore.setState({
    profiles: [],
    loading: false,
    error: null,
    selectedProfile: null,
  });
}

// =============================================================================
// TESTS
// =============================================================================

describe('ProfileStore', () => {
  beforeEach(() => {
    resetStore();
  });

  // ---------------------------------------------------------------------------
  // setProfiles
  // ---------------------------------------------------------------------------

  describe('setProfiles', () => {
    test('replaces all profiles', () => {
      const profiles = [makeProfile({ name: 'a' }), makeProfile({ name: 'b' })];
      useProfileStore.getState().setProfiles(profiles);
      expect(useProfileStore.getState().profiles).toHaveLength(2);
      expect(useProfileStore.getState().profiles[0].name).toBe('a');
      expect(useProfileStore.getState().profiles[1].name).toBe('b');
    });

    test('replaces existing profiles entirely', () => {
      useProfileStore.getState().setProfiles([makeProfile({ name: 'old' })]);
      useProfileStore.getState().setProfiles([makeProfile({ name: 'new' })]);
      expect(useProfileStore.getState().profiles).toHaveLength(1);
      expect(useProfileStore.getState().profiles[0].name).toBe('new');
    });
  });

  // ---------------------------------------------------------------------------
  // addProfile
  // ---------------------------------------------------------------------------

  describe('addProfile', () => {
    test('prepends to the list', () => {
      useProfileStore.getState().setProfiles([makeProfile({ name: 'existing' })]);
      useProfileStore.getState().addProfile(makeProfile({ name: 'new' }));

      const { profiles } = useProfileStore.getState();
      expect(profiles).toHaveLength(2);
      expect(profiles[0].name).toBe('new');
      expect(profiles[1].name).toBe('existing');
    });

    test('adds to empty list', () => {
      useProfileStore.getState().addProfile(makeProfile({ name: 'first' }));
      expect(useProfileStore.getState().profiles).toHaveLength(1);
      expect(useProfileStore.getState().profiles[0].name).toBe('first');
    });
  });

  // ---------------------------------------------------------------------------
  // removeProfile
  // ---------------------------------------------------------------------------

  describe('removeProfile', () => {
    test('removes by name', () => {
      useProfileStore
        .getState()
        .setProfiles([makeProfile({ name: 'keep' }), makeProfile({ name: 'remove' })]);
      useProfileStore.getState().removeProfile('remove');

      const { profiles } = useProfileStore.getState();
      expect(profiles).toHaveLength(1);
      expect(profiles[0].name).toBe('keep');
    });

    test('clears selectedProfile when the selected profile is removed', () => {
      useProfileStore.getState().setProfiles([makeProfile({ name: 'sel' })]);
      useProfileStore.getState().selectProfile('sel');
      expect(useProfileStore.getState().selectedProfile).toBe('sel');

      useProfileStore.getState().removeProfile('sel');
      expect(useProfileStore.getState().selectedProfile).toBeNull();
    });

    test('preserves selectedProfile when a different profile is removed', () => {
      useProfileStore
        .getState()
        .setProfiles([makeProfile({ name: 'sel' }), makeProfile({ name: 'other' })]);
      useProfileStore.getState().selectProfile('sel');
      useProfileStore.getState().removeProfile('other');
      expect(useProfileStore.getState().selectedProfile).toBe('sel');
    });

    test('is a no-op for non-existent name', () => {
      useProfileStore.getState().setProfiles([makeProfile({ name: 'a' })]);
      useProfileStore.getState().removeProfile('nonexistent');
      expect(useProfileStore.getState().profiles).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------------------
  // updateProfile
  // ---------------------------------------------------------------------------

  describe('updateProfile', () => {
    test('updates specific fields by name', () => {
      useProfileStore.getState().setProfiles([makeProfile({ name: 'target', priority: 5 })]);
      useProfileStore.getState().updateProfile('target', { priority: 20 });

      const updated = useProfileStore.getState().profiles[0];
      expect(updated.priority).toBe(20);
      expect(updated.name).toBe('target');
    });

    test('does not affect other profiles', () => {
      useProfileStore
        .getState()
        .setProfiles([
          makeProfile({ name: 'a', priority: 1 }),
          makeProfile({ name: 'b', priority: 2 }),
        ]);
      useProfileStore.getState().updateProfile('a', { priority: 99 });

      const { profiles } = useProfileStore.getState();
      expect(profiles[0].priority).toBe(99);
      expect(profiles[1].priority).toBe(2);
    });

    test('is a no-op for non-existent name', () => {
      useProfileStore.getState().setProfiles([makeProfile({ name: 'a', priority: 1 })]);
      useProfileStore.getState().updateProfile('nonexistent', { priority: 99 });
      expect(useProfileStore.getState().profiles[0].priority).toBe(1);
    });

    test('updates multiple fields at once', () => {
      useProfileStore.getState().setProfiles([makeProfile({ name: 'multi' })]);
      useProfileStore.getState().updateProfile('multi', {
        priority: 50,
        whenExpression: 'context.is_premium == true',
        overrideCategories: ['tools', 'voice'],
      });

      const updated = useProfileStore.getState().profiles[0];
      expect(updated.priority).toBe(50);
      expect(updated.whenExpression).toBe('context.is_premium == true');
      expect(updated.overrideCategories).toEqual(['tools', 'voice']);
    });
  });

  // ---------------------------------------------------------------------------
  // selectProfile
  // ---------------------------------------------------------------------------

  describe('selectProfile', () => {
    test('sets selectedProfile', () => {
      useProfileStore.getState().selectProfile('my_profile');
      expect(useProfileStore.getState().selectedProfile).toBe('my_profile');
    });

    test('clears with null', () => {
      useProfileStore.getState().selectProfile('my_profile');
      useProfileStore.getState().selectProfile(null);
      expect(useProfileStore.getState().selectedProfile).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // setLoading / setError
  // ---------------------------------------------------------------------------

  describe('setLoading', () => {
    test('sets loading state', () => {
      useProfileStore.getState().setLoading(true);
      expect(useProfileStore.getState().loading).toBe(true);
      useProfileStore.getState().setLoading(false);
      expect(useProfileStore.getState().loading).toBe(false);
    });
  });

  describe('setError', () => {
    test('sets and clears error', () => {
      useProfileStore.getState().setError('Something went wrong');
      expect(useProfileStore.getState().error).toBe('Something went wrong');
      useProfileStore.getState().setError(null);
      expect(useProfileStore.getState().error).toBeNull();
    });
  });
});
