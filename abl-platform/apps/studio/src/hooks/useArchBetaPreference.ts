/**
 * useArchBetaPreference
 *
 * Standalone localStorage hook for Arch AI beta toggle.
 * Kept outside Zustand stores to avoid corrupting existing persisted state.
 */

import { useState, useCallback, useSyncExternalStore } from 'react';

const BETA_KEY = 'arch-ai-beta-enabled';
const BANNER_KEY = 'arch-ai-beta-banner-dismissed';

function getStorageValue(key: string, fallback: boolean): boolean {
  if (typeof window === 'undefined') return fallback;
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : raw === 'true';
  } catch {
    return fallback;
  }
}

function setStorageValue(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, String(value));
    window.dispatchEvent(new StorageEvent('storage', { key }));
  } catch {
    // localStorage full or unavailable — degrade gracefully
  }
}

/** Subscribe to localStorage changes for SSR-safe external store */
function subscribe(callback: () => void): () => void {
  const handler = (e: StorageEvent) => {
    if (e.key === BETA_KEY || e.key === BANNER_KEY) callback();
  };
  window.addEventListener('storage', handler);
  return () => window.removeEventListener('storage', handler);
}

export function useArchBetaPreference() {
  const betaEnabled = useSyncExternalStore(
    subscribe,
    () => getStorageValue(BETA_KEY, false),
    () => false,
  );

  const bannerDismissed = useSyncExternalStore(
    subscribe,
    () => getStorageValue(BANNER_KEY, false),
    () => false,
  );

  const setBetaEnabled = useCallback((enabled: boolean) => {
    setStorageValue(BETA_KEY, enabled);
  }, []);

  const dismissBanner = useCallback(() => {
    setStorageValue(BANNER_KEY, true);
  }, []);

  return { betaEnabled, setBetaEnabled, bannerDismissed, dismissBanner };
}
