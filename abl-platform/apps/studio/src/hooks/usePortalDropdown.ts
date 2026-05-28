/**
 * usePortalDropdown — calculates fixed-position coordinates for a portal-rendered
 * dropdown, escaping any ancestor overflow:hidden constraints (e.g. sidebar containers).
 *
 * Usage:
 *   const { coords, updateCoords } = usePortalDropdown(triggerRef, { align: 'right' });
 *   // render via createPortal(<div style={coords} />, document.body)
 */

import { useState, useCallback } from 'react';

type Align = 'left' | 'right';

interface DropdownCoords {
  position: 'fixed';
  top?: number;
  bottom?: number;
  left?: number;
  right?: number;
  zIndex: number;
}

interface UsePortalDropdownOptions {
  /** Which edge of the trigger to anchor the dropdown to. Default: 'right'. */
  align?: Align;
  /** Gap between trigger bottom and dropdown top (px). Default: 8. */
  gap?: number;
  /** z-index for the portal element. Default: 9999. */
  zIndex?: number;
  /** Estimated dropdown height used for viewport boundary check. Default: 340. */
  estimatedHeight?: number;
}

export function usePortalDropdown(
  triggerRef: React.RefObject<HTMLElement | null>,
  { align = 'right', gap = 8, zIndex = 9999, estimatedHeight = 340 }: UsePortalDropdownOptions = {},
) {
  const [coords, setCoords] = useState<DropdownCoords | null>(null);

  const updateCoords = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;

    const rect = el.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom;
    const openUpward = spaceBelow < estimatedHeight;

    const vertical = openUpward
      ? { bottom: window.innerHeight - rect.top + gap }
      : { top: rect.bottom + gap };

    if (align === 'right') {
      setCoords({ position: 'fixed', ...vertical, right: window.innerWidth - rect.right, zIndex });
    } else {
      setCoords({ position: 'fixed', ...vertical, left: rect.left, zIndex });
    }
  }, [triggerRef, align, gap, zIndex, estimatedHeight]);

  return { coords, updateCoords };
}
