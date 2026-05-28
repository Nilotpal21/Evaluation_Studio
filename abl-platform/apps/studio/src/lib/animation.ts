/**
 * Shared Framer Motion transition presets.
 *
 * Usage:
 *   <motion.div transition={springs.snappy} />
 *   <motion.div transition={transitions.pageEnter} />
 */

// Spring physics — 4 standard presets
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

// Ease curve matching globals.css --ease-spring
export const EASE_SPRING = [0.22, 1, 0.36, 1] as const;

// Duration-based transitions (non-spring)
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

// Stagger delay per child (seconds)
export const STAGGER_DELAY = 0.05;
