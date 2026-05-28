/**
 * Theme Store
 *
 * Manages theme state (light/dark/system) with localStorage persistence.
 * Sets data-theme attribute on <html> element.
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type ThemeMode = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

interface ThemeStore {
  mode: ThemeMode;
  resolved: ResolvedTheme;

  setMode: (mode: ThemeMode) => void;
  toggle: () => void;
}

function resolveTheme(mode: ThemeMode): ResolvedTheme {
  if (mode === 'system') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return mode;
}

function applyTheme(resolved: ResolvedTheme) {
  const html = document.documentElement;
  // Add transition class briefly for smooth theme switch
  html.classList.add('theme-transition');
  html.setAttribute('data-theme', resolved);
  // Remove transition class after animation completes
  setTimeout(() => html.classList.remove('theme-transition'), 350);
}

export const useThemeStore = create<ThemeStore>()(
  persist(
    (set, get) => ({
      mode: 'system',
      resolved:
        typeof window !== 'undefined'
          ? window.matchMedia('(prefers-color-scheme: dark)').matches
            ? 'dark'
            : 'light'
          : 'light',

      setMode: (mode) => {
        const resolved = resolveTheme(mode);
        applyTheme(resolved);
        set({ mode, resolved });
      },

      toggle: () => {
        const current = get().resolved;
        const next: ThemeMode = current === 'dark' ? 'light' : 'dark';
        const resolved = resolveTheme(next);
        applyTheme(resolved);
        set({ mode: next, resolved });
      },
    }),
    {
      name: 'kore-theme-storage',
      partialize: (state) => ({ mode: state.mode }),
      onRehydrateStorage: () => (state) => {
        if (state) {
          const resolved = resolveTheme(state.mode);
          applyTheme(resolved);
          state.resolved = resolved;
        }
      },
    },
  ),
);

// Listen for system theme changes when in 'system' mode
if (typeof window !== 'undefined') {
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    const { mode } = useThemeStore.getState();
    if (mode === 'system') {
      const resolved = resolveTheme('system');
      applyTheme(resolved);
      useThemeStore.setState({ resolved });
    }
  });
}
