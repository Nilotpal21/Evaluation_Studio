/**
 * Gradient Token System
 *
 * Typed gradient tokens that mirror the CSS custom properties defined in
 * globals.css. Provides class name lookups and CSS variable references for
 * programmatic/canvas use.
 *
 * Architecture:
 *   GradientToken → GradientTokenEntry → class names / CSS var references
 *
 * Usage:
 *   import { getGradientStyles, getGradientValue } from '@agent-platform/design-tokens';
 *   const styles = getGradientStyles('brand');
 *   <div className={styles.bg}>...</div>
 *
 *   const canvasStyle = { background: getGradientValue('glow-ambient') };
 */

// =============================================================================
// GRADIENT TOKEN — the core type
// =============================================================================

/**
 * The four semantic gradient categories.
 */
export type GradientCategory = 'brand' | 'surface' | 'status' | 'glow' | 'utility';

/**
 * All gradient token names. Each maps to a CSS custom property
 * `--gradient-<token>` defined in globals.css.
 */
export type GradientToken =
  | 'brand'
  | 'brand-subtle'
  | 'brand-text'
  | 'brand-fade'
  | 'surface-panel'
  | 'surface-sidebar'
  | 'surface-page'
  | 'surface-accent'
  | 'status-success'
  | 'status-warning'
  | 'status-error'
  | 'glow-accent'
  | 'glow-ambient'
  | 'shimmer';

// =============================================================================
// GRADIENT STYLES — the class name sets
// =============================================================================

/**
 * Style information for a gradient token.
 * Provides class names for background, text, and border applications,
 * plus the raw CSS variable reference for inline styles.
 */
export interface GradientStyles {
  /** Background gradient class: `bg-gradient-brand`, `bg-gradient-surface-panel`, etc. */
  bg: string;
  /** Text gradient class (background-clip: text). Only meaningful for brand tokens. */
  text: string;
  /** Border gradient class (pseudo-element technique). Only meaningful for brand tokens. */
  border: string;
  /** CSS variable reference: `var(--gradient-brand)` — for inline styles / canvas use */
  cssVar: string;
}

/**
 * Registry entry for a single gradient token.
 */
interface GradientTokenEntry {
  /** CSS custom property name: `--gradient-brand` */
  cssVar: string;
  /** Primary CSS class name: `bg-gradient-brand` */
  className: string;
  /** Gradient category for filtering/grouping */
  category: GradientCategory;
}

// =============================================================================
// GRADIENT TOKEN REGISTRY — single source of truth
// =============================================================================

/**
 * Complete registry of all gradient tokens.
 * Keys are GradientToken names, values contain the CSS variable name,
 * primary class name, and category.
 */
export const GRADIENT_TOKENS: Record<GradientToken, GradientTokenEntry> = {
  brand: {
    cssVar: '--gradient-brand',
    className: 'bg-gradient-brand',
    category: 'brand',
  },
  'brand-subtle': {
    cssVar: '--gradient-brand-subtle',
    className: 'bg-gradient-brand-subtle',
    category: 'brand',
  },
  'brand-text': {
    cssVar: '--gradient-brand-text',
    className: 'text-gradient-brand',
    category: 'brand',
  },
  'brand-fade': {
    cssVar: '--gradient-brand-fade',
    className: 'bg-gradient-brand-fade',
    category: 'brand',
  },
  'surface-panel': {
    cssVar: '--gradient-surface-panel',
    className: 'bg-gradient-surface-panel',
    category: 'surface',
  },
  'surface-sidebar': {
    cssVar: '--gradient-surface-sidebar',
    className: 'bg-gradient-surface-sidebar',
    category: 'surface',
  },
  'surface-page': {
    cssVar: '--gradient-surface-page',
    className: 'bg-gradient-surface-page',
    category: 'surface',
  },
  'surface-accent': {
    cssVar: '--gradient-surface-accent',
    className: 'bg-gradient-surface-accent',
    category: 'surface',
  },
  'status-success': {
    cssVar: '--gradient-status-success',
    className: 'bg-gradient-status-success',
    category: 'status',
  },
  'status-warning': {
    cssVar: '--gradient-status-warning',
    className: 'bg-gradient-status-warning',
    category: 'status',
  },
  'status-error': {
    cssVar: '--gradient-status-error',
    className: 'bg-gradient-status-error',
    category: 'status',
  },
  'glow-accent': {
    cssVar: '--gradient-glow-accent',
    className: 'gradient-glow-accent',
    category: 'glow',
  },
  'glow-ambient': {
    cssVar: '--gradient-glow-ambient',
    className: 'gradient-glow-ambient',
    category: 'glow',
  },
  shimmer: {
    cssVar: '--gradient-shimmer',
    className: 'bg-gradient-shimmer',
    category: 'utility',
  },
};

// =============================================================================
// PUBLIC API
// =============================================================================

/**
 * Get the full GradientStyles for a gradient token.
 *
 * Returns class names for bg, text, and border applications,
 * plus the CSS variable reference for inline styles.
 *
 * @example
 *   const styles = getGradientStyles('brand');
 *   <button className={styles.bg}>Deploy</button>
 *   <h2 className={styles.text}>Arch AI</h2>
 */
export function getGradientStyles(token: GradientToken): GradientStyles | undefined {
  const entry = GRADIENT_TOKENS[token];
  if (!entry) return undefined;

  return {
    bg: `bg-gradient-${token}`,
    text: `text-gradient-${token}`,
    border: `border-gradient-${token}`,
    cssVar: `var(${entry.cssVar})`,
  };
}

/**
 * Get the CSS variable reference for a gradient token.
 * Returns a `var(--gradient-<token>)` string suitable for inline styles.
 *
 * @example
 *   const canvasStyle = { background: getGradientValue('glow-ambient') };
 */
export function getGradientValue(token: GradientToken): string | undefined {
  const entry = GRADIENT_TOKENS[token];
  if (!entry) return undefined;

  return `var(${entry.cssVar})`;
}
