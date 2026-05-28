/**
 * useKBShortcuts Hook
 *
 * Registers keyboard shortcuts for KB detail page navigation:
 *   Alt+1 → Home (setTab(null))
 *   Alt+2 → Data (setTab('data'))
 *   Alt+3 → Intelligence (setTab('intelligence'))
 *   Alt+4 → Search (setTab('search'))
 *   Alt+, → Toggle settings panel
 *
 * Shortcuts are suppressed when focus is inside form elements, contentEditable,
 * or when a dialog/modal is open.
 */

import { useEffect } from 'react';
import { useNavigationStore } from '../../../store/navigation-store';

const IGNORED_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

function shouldSuppressShortcuts(): boolean {
  const el = document.activeElement;
  if (el) {
    if (IGNORED_TAGS.has(el.tagName)) return true;
    if (el instanceof HTMLElement && el.isContentEditable) return true;
  }
  // Suppress when a dialog or modal overlay is open (e.g. SettingsPanel, confirmation dialogs)
  if (document.querySelector('[role="dialog"], [aria-modal="true"]')) return true;
  return false;
}

export function useKBShortcuts(onToggleSettings: () => void): void {
  useEffect(() => {
    const setTab = useNavigationStore.getState().setTab;

    function handleKeyDown(e: KeyboardEvent) {
      if (!e.altKey) return;
      if (shouldSuppressShortcuts()) return;

      switch (e.key) {
        case '1':
          e.preventDefault();
          setTab(null);
          break;
        case '2':
          e.preventDefault();
          setTab('data');
          break;
        case '3':
          e.preventDefault();
          setTab('intelligence');
          break;
        case '4':
          e.preventDefault();
          setTab('search');
          break;
        case ',':
          e.preventDefault();
          onToggleSettings();
          break;
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onToggleSettings]);
}
