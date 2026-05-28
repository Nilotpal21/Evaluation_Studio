/**
 * Academy Store
 *
 * Manages Learning Academy state: config, user progress, loading, and error.
 * API calls route through Studio-owned Academy API routes (/api/academy/*).
 */

import { create } from 'zustand';
import { apiFetch } from '@/lib/api-client';

// ─── Types (mirrored from @agent-platform/academy for client-side use) ───────

export interface AcademyPersonaConfig {
  id: string;
  title: string;
  subtitle: string;
  description: string;
  icon: string;
  level: string;
  badge: string;
}

export interface AcademyPersonaCourseMapEntry {
  courses: string[];
  fastTrack: string[];
  estimatedHours: number;
}

export interface AcademySettings {
  quizPassThreshold: number;
  pointsFirstAttempt: number;
  pointsSecondAttempt: number;
  pointsThirdPlusAttempt: number;
  pointsLessonComplete: number;
  pointsCourseComplete: number;
  pointsPathComplete: number;
  questionsPerQuiz: number;
  mcqOptions: number;
}

export interface AcademyBadgeConfig {
  id: string;
  title: string;
  description: string;
  icon: string;
  trigger: string;
}

export interface AcademyRankConfig {
  level: number;
  title: string;
  minPoints: number;
  requirePaths?: number;
}

export interface AcademyConfig {
  title: string;
  version: string;
  settings: AcademySettings;
  personas: AcademyPersonaConfig[];
  personaCourseMap: Record<string, AcademyPersonaCourseMapEntry>;
  badges: AcademyBadgeConfig[];
  ranks: AcademyRankConfig[];
}

export interface CourseCertification {
  required: boolean;
  passCriteria: string;
  badge: string;
}

export interface StoreCourseConfig {
  id: string;
  title: string;
  description: string;
  level: string;
  estimatedMinutes: number;
  prerequisites: string[];
  modules: string[];
  certification: CourseCertification;
}

export interface AcademyModuleProgress {
  contentRead: boolean;
  quizAttempts: number;
  quizPassed: boolean;
  bestScore: number;
  lastAttemptDate: string | null;
  contentVersion: string | null;
}

export interface AcademyProgress {
  _id: string;
  userId: string;
  email: string;
  displayName: string | null;
  selectedPersona: string | null;
  /** Module progress keyed by moduleId. Serialized as plain object from JSON API. */
  modules?: Record<string, AcademyModuleProgress>;
  points: number;
  badges: string[];
  streakDays: string[];
  lastActiveDate: string | null;
}

// ─── Store ───────────────────────────────────────────────────────────────────

interface AcademyState {
  config: AcademyConfig | null;
  courses: StoreCourseConfig[] | null;
  progress: AcademyProgress | null;
  loading: boolean;
  error: string | null;

  // Actions
  fetchConfig: () => Promise<void>;
  fetchProgress: () => Promise<void>;
  setPersona: (persona: string) => Promise<void>;
  resetProgress: () => Promise<void>;
}

export const useAcademyStore = create<AcademyState>()((set) => ({
  config: null,
  courses: null,
  progress: null,
  loading: false,
  error: null,

  fetchConfig: async () => {
    set({ loading: true, error: null });
    try {
      const res = await apiFetch('/api/academy/config');
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const message =
          body?.error?.message ?? body?.error ?? `Failed to load config (${res.status})`;
        set({ loading: false, error: typeof message === 'string' ? message : String(message) });
        return;
      }
      const data = await res.json();
      // API returns { success, data: { config: AcademyConfig, courses: CourseConfig[] } }
      const payload = data.data ?? data;
      set({
        config: payload.config ?? payload,
        courses: payload.courses ?? [],
        loading: false,
      });
    } catch (err) {
      set({
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },

  fetchProgress: async () => {
    set({ loading: true, error: null });
    try {
      const res = await apiFetch('/api/academy/progress');
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const message =
          body?.error?.message ?? body?.error ?? `Failed to load progress (${res.status})`;
        set({ loading: false, error: typeof message === 'string' ? message : String(message) });
        return;
      }
      const data = await res.json();
      set({ progress: data.data ?? data, loading: false });
    } catch (err) {
      set({
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },

  setPersona: async (persona: string) => {
    set({ loading: true, error: null });
    try {
      const res = await apiFetch('/api/academy/progress/persona', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ persona }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const message =
          body?.error?.message ?? body?.error ?? `Failed to set persona (${res.status})`;
        set({ loading: false, error: typeof message === 'string' ? message : String(message) });
        return;
      }
      const data = await res.json();
      set({ progress: data.data ?? data, loading: false });
    } catch (err) {
      set({
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },

  resetProgress: async () => {
    set({ loading: true, error: null });
    try {
      const res = await apiFetch('/api/academy/progress/reset', {
        method: 'POST',
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const message =
          body?.error?.message ?? body?.error ?? `Failed to reset progress (${res.status})`;
        set({ loading: false, error: typeof message === 'string' ? message : String(message) });
        return;
      }
      set({ progress: null, loading: false });
    } catch (err) {
      set({
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },
}));

// ─── Selectors ───────────────────────────────────────────────────────────────

export const selectAcademyConfig = (state: AcademyState) => state.config;
export const selectAcademyCourses = (state: AcademyState) => state.courses;
export const selectAcademyProgress = (state: AcademyState) => state.progress;
export const selectAcademyLoading = (state: AcademyState) => state.loading;
export const selectAcademyError = (state: AcademyState) => state.error;
