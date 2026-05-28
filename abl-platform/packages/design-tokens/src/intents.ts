/**
 * Semantic Color Intent System
 *
 * This module defines the typed semantic color intent system that replaces
 * hardcoded Tailwind palette classes (bg-blue-500, text-red-400, etc.)
 * with theme-aware, semantic abstractions.
 *
 * Architecture:
 *   SemanticIntent → IntentStyles → Tailwind class strings
 *
 * Every domain color mapping (status, event type, pipeline stage, etc.)
 * resolves to a SemanticIntent, which then resolves to the correct
 * Tailwind classes backed by CSS variables.
 *
 * Usage:
 *   import { getIntentStyles } from '@agent-platform/design-tokens';
 *   const styles = getIntentStyles('success');
 *   <div className={styles.bgSubtle}>...</div>
 */

// =============================================================================
// SEMANTIC INTENT — the core abstraction
// =============================================================================

/**
 * The 9 semantic color intents available in the design system.
 * Each intent maps to a CSS variable group (e.g., --success, --success-foreground, etc.)
 *
 * These are the ONLY colors that should appear in component code.
 * Domain-specific meanings (status, event type, pipeline stage) are mapped
 * to these intents via the color-maps module.
 */
export type SemanticIntent =
  | 'accent'
  | 'success'
  | 'warning'
  | 'error'
  | 'info'
  | 'purple'
  | 'orange'
  | 'muted'
  | 'neutral';

// =============================================================================
// INTENT STYLES — the class name sets for each intent
// =============================================================================

/**
 * Complete set of Tailwind class names for a semantic intent.
 * Each property provides a specific usage pattern (background, text, border, etc.)
 *
 * These classes are backed by CSS variables from globals.css and work
 * correctly in both light and dark themes.
 */
export interface IntentStyles {
  /** Solid background: bg-success, bg-error, etc. */
  bg: string;
  /** Subtle/muted background: bg-success-subtle, bg-error-subtle, etc. */
  bgSubtle: string;
  /** Primary text color: text-success, text-error, etc. */
  text: string;
  /** Foreground on solid bg: text-success-foreground, text-error-foreground, etc. */
  textForeground: string;
  /** Border color: border-success, border-error, etc. */
  border: string;
  /** Muted/dimmed variant: bg-success-muted, text-warning-muted, etc. */
  bgMuted: string;
}

/**
 * Compact badge style set for inline status indicators.
 * Combines bg, text, and border into ready-to-use class strings.
 */
export interface BadgeIntentStyles {
  /** Combined classes for the badge container: bg + text + border */
  badge: string;
  /** Class for the status dot indicator */
  dot: string;
}

// =============================================================================
// INTENT STYLE REGISTRY — the single source of truth
// =============================================================================

const INTENT_STYLES: Record<SemanticIntent, IntentStyles> = {
  accent: {
    bg: 'bg-accent',
    bgSubtle: 'bg-accent-subtle',
    text: 'text-accent',
    textForeground: 'text-accent-foreground',
    border: 'border-accent',
    bgMuted: 'bg-accent-muted',
  },
  success: {
    bg: 'bg-success',
    bgSubtle: 'bg-success-subtle',
    text: 'text-success',
    textForeground: 'text-success-foreground',
    border: 'border-success',
    bgMuted: 'bg-success-muted',
  },
  warning: {
    bg: 'bg-warning',
    bgSubtle: 'bg-warning-subtle',
    text: 'text-warning',
    textForeground: 'text-warning-foreground',
    border: 'border-warning',
    bgMuted: 'bg-warning-muted',
  },
  error: {
    bg: 'bg-error',
    bgSubtle: 'bg-error-subtle',
    text: 'text-error',
    textForeground: 'text-error-foreground',
    border: 'border-error',
    bgMuted: 'bg-error-muted',
  },
  info: {
    bg: 'bg-info',
    bgSubtle: 'bg-info-subtle',
    text: 'text-info',
    textForeground: 'text-info-foreground',
    border: 'border-info',
    bgMuted: 'bg-info-muted',
  },
  purple: {
    bg: 'bg-purple',
    bgSubtle: 'bg-purple-subtle',
    text: 'text-purple',
    textForeground: 'text-purple-foreground',
    border: 'border-purple',
    bgMuted: 'bg-purple-muted',
  },
  orange: {
    bg: 'bg-orange',
    bgSubtle: 'bg-orange-subtle',
    text: 'text-orange',
    textForeground: 'text-orange-foreground',
    border: 'border-orange',
    bgMuted: 'bg-orange-muted',
  },
  muted: {
    bg: 'bg-background-muted',
    bgSubtle: 'bg-background-subtle',
    text: 'text-foreground-muted',
    textForeground: 'text-foreground',
    border: 'border-muted',
    bgMuted: 'bg-background-muted',
  },
  neutral: {
    bg: 'bg-background-elevated',
    bgSubtle: 'bg-background-muted',
    text: 'text-foreground-subtle',
    textForeground: 'text-foreground',
    border: 'border-muted',
    bgMuted: 'bg-background-muted',
  },
};

/**
 * Badge-specific style presets derived from the intent styles.
 * These combine bg-subtle + text + border into compact class strings
 * suitable for status badges, tags, and inline indicators.
 */
const BADGE_INTENT_STYLES: Record<SemanticIntent, BadgeIntentStyles> = {
  accent: {
    badge: 'bg-accent-subtle text-accent border-accent',
    dot: 'bg-accent',
  },
  success: {
    badge: 'bg-success-subtle text-success border-success',
    dot: 'bg-success',
  },
  warning: {
    badge: 'bg-warning-subtle text-warning border-warning',
    dot: 'bg-warning',
  },
  error: {
    badge: 'bg-error-subtle text-error border-error',
    dot: 'bg-error',
  },
  info: {
    badge: 'bg-info-subtle text-info border-info',
    dot: 'bg-info',
  },
  purple: {
    badge: 'bg-purple-subtle text-purple border-purple',
    dot: 'bg-purple',
  },
  orange: {
    badge: 'bg-orange-subtle text-orange border-orange',
    dot: 'bg-orange',
  },
  muted: {
    badge: 'bg-background-muted text-foreground-muted border-muted',
    dot: 'bg-foreground-muted',
  },
  neutral: {
    badge: 'bg-background-elevated text-foreground-subtle border-muted',
    dot: 'bg-foreground-subtle',
  },
};

// =============================================================================
// PUBLIC API
// =============================================================================

/**
 * Get the full IntentStyles for a semantic intent.
 *
 * @example
 *   const styles = getIntentStyles('success');
 *   <div className={styles.bgSubtle}>
 *     <span className={styles.text}>All good</span>
 *   </div>
 */
export function getIntentStyles(intent: SemanticIntent): IntentStyles {
  return INTENT_STYLES[intent];
}

/**
 * Get badge-specific styles for a semantic intent.
 *
 * @example
 *   const styles = getBadgeIntentStyles('error');
 *   <span className={cn('rounded-full border px-2 py-0.5 text-xs', styles.badge)}>
 *     <span className={cn('h-1.5 w-1.5 rounded-full', styles.dot)} />
 *     Error
 *   </span>
 */
export function getBadgeIntentStyles(intent: SemanticIntent): BadgeIntentStyles {
  return BADGE_INTENT_STYLES[intent];
}

/**
 * Get a specific style property for an intent.
 * Convenience for single-property access.
 *
 * @example
 *   <span className={intentClass('error', 'text')}>Something failed</span>
 */
export function intentClass(intent: SemanticIntent, property: keyof IntentStyles): string {
  return INTENT_STYLES[intent][property];
}
