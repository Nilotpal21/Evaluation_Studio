/**
 * @agent-platform/ui — Design Tokens (JS)
 *
 * Programmatic access to design system values.
 * Re-exports Framer Motion spring presets from the shared animation library.
 */

// ─── Color tokens ────────────────────────────────────────────────────────────

export const colors = {
  background: 'hsl(var(--background))',
  backgroundSubtle: 'hsl(var(--background-subtle))',
  backgroundMuted: 'hsl(var(--background-muted))',
  backgroundElevated: 'hsl(var(--background-elevated))',
  foreground: 'hsl(var(--foreground))',
  foregroundMuted: 'hsl(var(--foreground-muted))',
  foregroundSubtle: 'hsl(var(--foreground-subtle))',
  border: 'hsl(var(--border))',
  borderMuted: 'hsl(var(--border-muted))',
  borderFocus: 'hsl(var(--border-focus))',
  accent: 'hsl(var(--accent))',
  accentForeground: 'hsl(var(--accent-foreground))',
  accentMuted: 'hsl(var(--accent-muted))',
  accentSubtle: 'hsl(var(--accent-subtle))',
  success: 'hsl(var(--success))',
  successSubtle: 'hsl(var(--success-subtle))',
  warning: 'hsl(var(--warning))',
  warningSubtle: 'hsl(var(--warning-subtle))',
  error: 'hsl(var(--error))',
  errorSubtle: 'hsl(var(--error-subtle))',
  info: 'hsl(var(--info))',
  infoSubtle: 'hsl(var(--info-subtle))',
  purple: 'hsl(var(--purple))',
  purpleSubtle: 'hsl(var(--purple-subtle))',
} as const;

// ─── Duration tokens ─────────────────────────────────────────────────────────

export const duration = {
  fast: 150,
  normal: 200,
  slow: 300,
  slower: 500,
} as const;

// ─── Radius tokens ───────────────────────────────────────────────────────────

export const radius = {
  sm: '4px',
  md: '6px',
  lg: '8px',
  xl: '12px',
  '2xl': '16px',
  full: '9999px',
} as const;

// ─── Framer Motion spring presets ────────────────────────────────────────────

/** Spring physics — 4 standard presets */
export const springs = {
  /** Tab underlines, layout indicators — fast and crisp */
  snappy: { type: 'spring' as const, stiffness: 500, damping: 30 },
  /** Modals, pill switchers — responsive but smooth */
  default: { type: 'spring' as const, stiffness: 400, damping: 30 },
  /** Sidebars, panels, drawers — smooth slide */
  gentle: { type: 'spring' as const, stiffness: 300, damping: 30 },
  /** Staggered node entrances — slow and organic */
  soft: { type: 'spring' as const, stiffness: 200, damping: 20 },
} as const;

/** Ease curve matching CSS --ease-spring */
export const EASE_SPRING = [0.22, 1, 0.36, 1] as const;

/** Duration-based transitions (non-spring) */
export const transitions = {
  /** Page/route enter — fade + slide Y */
  pageEnter: { duration: 0.2, ease: EASE_SPRING },
  /** Stage/wizard horizontal slide */
  stageSlide: { duration: 0.25, ease: EASE_SPRING },
  /** Backdrop fade */
  backdrop: { duration: 0.15 },
  /** Icon swap */
  iconSwap: { duration: 0.15 },
} as const;

/** Stagger delay per child (seconds) */
export const STAGGER_DELAY = 0.05;
