import { useEffect, useRef, type RefObject } from 'react';

/**
 * Calls `handler` when a click occurs outside the referenced element.
 * Replaces the 4 hand-rolled implementations in UserMenu, NewProjectDropdown,
 * ProjectSidebar, and ProjectSwitcher.
 */
export function useOutsideClick<T extends HTMLElement = HTMLElement>(
  handler: () => void,
  active = true,
): RefObject<T | null> {
  const ref = useRef<T | null>(null);

  useEffect(() => {
    if (!active) return;

    const listener = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        handler();
      }
    };

    document.addEventListener('mousedown', listener);
    return () => document.removeEventListener('mousedown', listener);
  }, [handler, active]);

  return ref;
}
