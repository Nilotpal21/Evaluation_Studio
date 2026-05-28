/**
 * Overlay / Backdrop Constants
 *
 * Centralizes the overlay backdrop class used across all modals,
 * slide-overs, dialogs, and panels. Replaces the ~49 hardcoded
 * `bg-black/60` instances scattered across the codebase.
 */

/**
 * Standard overlay backdrop class for modals, slide-overs, and panels.
 * Provides a semi-transparent dark backdrop that works in both themes.
 */
export const OVERLAY_BACKDROP = 'fixed inset-0 z-40 bg-overlay backdrop-blur-[1px]';

/**
 * Lighter overlay for non-modal contexts (tooltips, dropdowns).
 */
export const OVERLAY_BACKDROP_LIGHT = 'fixed inset-0 z-40 bg-black/40';

/**
 * Overlay backdrop classes only (without positioning).
 * Use when the parent already handles positioning.
 */
export const OVERLAY_BG = 'bg-overlay';
