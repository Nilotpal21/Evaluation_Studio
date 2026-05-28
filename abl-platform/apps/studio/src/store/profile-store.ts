/**
 * Profile Store
 *
 * Manages behavior profile state with Zustand.
 * Profiles define context-driven overrides for agent behavior.
 */

import { create } from 'zustand';

// =============================================================================
// TYPES
// =============================================================================

export interface ProfileSummary {
  name: string;
  priority: number;
  whenExpression: string;
  dslContent: string;
  overrideCategories: string[]; // e.g., ['instructions', 'tools', 'constraints']
  usedByAgents: string[];
  updatedAt: string;
}

interface ProfileStore {
  profiles: ProfileSummary[];
  loading: boolean;
  error: string | null;
  selectedProfile: string | null;

  // Actions
  setProfiles: (profiles: ProfileSummary[]) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  selectProfile: (name: string | null) => void;
  addProfile: (profile: ProfileSummary) => void;
  removeProfile: (name: string) => void;
  updateProfile: (name: string, updates: Partial<ProfileSummary>) => void;
}

// =============================================================================
// STORE
// =============================================================================

export const useProfileStore = create<ProfileStore>((set) => ({
  profiles: [],
  loading: false,
  error: null,
  selectedProfile: null,

  setProfiles: (profiles) => set({ profiles }),

  setLoading: (loading) => set({ loading }),

  setError: (error) => set({ error }),

  selectProfile: (name) => set({ selectedProfile: name }),

  addProfile: (profile) =>
    set((state) => ({
      profiles: [profile, ...state.profiles],
    })),

  removeProfile: (name) =>
    set((state) => ({
      profiles: state.profiles.filter((p) => p.name !== name),
      selectedProfile: state.selectedProfile === name ? null : state.selectedProfile,
    })),

  updateProfile: (name, updates) =>
    set((state) => ({
      profiles: state.profiles.map((p) => (p.name === name ? { ...p, ...updates } : p)),
    })),
}));

// =============================================================================
// SELECTORS
// =============================================================================

export const selectProfiles = (state: ProfileStore) => state.profiles;
export const selectSelectedProfile = (state: ProfileStore) =>
  state.profiles.find((p) => p.name === state.selectedProfile) || null;
export const selectLoading = (state: ProfileStore) => state.loading;
