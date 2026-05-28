/**
 * Chart Color Resolution
 *
 * Chart libraries (Recharts, Chart.js, D3) require runtime color values
 * (hex, rgb, hsl strings) — they cannot consume Tailwind classes.
 *
 * This module provides:
 *   1. A runtime resolver that reads CSS variable values from the DOM
 *   2. A static semantic color map using hsl(var()) for SSR-safe usage
 *   3. A React hook for components that need resolved colors
 *
 * Usage in Recharts:
 *   import { SEMANTIC_CHART_COLORS } from '@agent-platform/design-tokens';
 *   <Bar fill={SEMANTIC_CHART_COLORS.success} />
 *
 * Usage with resolved hex (client-side only):
 *   import { useChartColors } from '@agent-platform/design-tokens';
 *   const colors = useChartColors();
 *   <Bar fill={colors.success} />
 */

import { useMemo, useSyncExternalStore } from 'react';
import type { SemanticIntent } from './intents';

// =============================================================================
// STATIC CHART COLORS — SSR-safe, uses hsl(var()) syntax
// =============================================================================

/**
 * Semantic chart colors using CSS variable references.
 * These work in any context where `hsl(var(--xxx))` is valid,
 * including SVG fill/stroke attributes rendered by Recharts.
 *
 * Prefer these over resolved colors unless you need actual hex values
 * (e.g., for canvas 2D context or external libraries that parse colors).
 */
export const SEMANTIC_CHART_COLORS: Record<SemanticIntent, string> = {
  accent: 'hsl(var(--accent))',
  success: 'hsl(var(--success))',
  warning: 'hsl(var(--warning))',
  error: 'hsl(var(--error))',
  info: 'hsl(var(--info))',
  purple: 'hsl(var(--purple))',
  orange: 'hsl(var(--orange))',
  muted: 'hsl(var(--foreground-subtle))',
  neutral: 'hsl(var(--foreground-muted))',
};

/**
 * Ordered chart color palette for series data.
 * Use when you need N colors for N data series and the series
 * don't have inherent semantic meaning.
 */
export const CHART_COLOR_PALETTE: string[] = [
  SEMANTIC_CHART_COLORS.accent,
  SEMANTIC_CHART_COLORS.success,
  SEMANTIC_CHART_COLORS.warning,
  SEMANTIC_CHART_COLORS.purple,
  SEMANTIC_CHART_COLORS.info,
  SEMANTIC_CHART_COLORS.error,
  SEMANTIC_CHART_COLORS.orange,
];

// =============================================================================
// NAMESPACE COLOR TOKENS — persisted-intent palette
// =============================================================================

/**
 * Token names users may persist (e.g. variable namespace color choice).
 * Values are resolved at render time via {@link resolveNamespaceColor}, so the
 * database stores intent ('accent') and the theme picks the concrete color.
 */
export const NAMESPACE_COLOR_TOKENS = [
  'accent',
  'success',
  'warning',
  'purple',
  'info',
  'error',
  'orange',
] as const;

export type NamespaceColorToken = (typeof NAMESPACE_COLOR_TOKENS)[number];

export function isNamespaceColorToken(value: unknown): value is NamespaceColorToken {
  return typeof value === 'string' && (NAMESPACE_COLOR_TOKENS as readonly string[]).includes(value);
}

/**
 * Resolve a persisted namespace color to a CSS color string.
 * Accepts a semantic token name (preferred) or a legacy 6-digit hex string.
 * Returns null for null/unknown input so callers can fall back to a neutral swatch.
 */
export function resolveNamespaceColor(value: string | null | undefined): string | null {
  if (!value) return null;
  if (isNamespaceColorToken(value)) return SEMANTIC_CHART_COLORS[value];
  if (/^#[0-9a-fA-F]{6}$/.test(value)) return value;
  return null;
}

// =============================================================================
// RUNTIME COLOR RESOLVER — client-side only
// =============================================================================

/**
 * Resolve a CSS variable to its computed hsl() string.
 * Returns the value in `hsl(H S% L%)` format.
 *
 * This is a client-side only function. Returns fallback on server.
 *
 * @param tokenName - CSS variable name without -- prefix (e.g., 'success', 'error')
 * @param fallback - Fallback color if variable is not defined
 */
export function resolveTokenColor(tokenName: string, fallback = 'hsl(0 0% 50%)'): string {
  if (typeof document === 'undefined') return fallback;

  const value = getComputedStyle(document.documentElement)
    .getPropertyValue(`--${tokenName}`)
    .trim();

  return value ? `hsl(${value})` : fallback;
}

/**
 * Resolve all semantic intents to runtime hsl() strings.
 * Client-side only — returns SEMANTIC_CHART_COLORS on server.
 */
export function resolveAllChartColors(): Record<SemanticIntent, string> {
  if (typeof document === 'undefined') return { ...SEMANTIC_CHART_COLORS };

  return {
    accent: resolveTokenColor('accent'),
    success: resolveTokenColor('success'),
    warning: resolveTokenColor('warning'),
    error: resolveTokenColor('error'),
    info: resolveTokenColor('info'),
    purple: resolveTokenColor('purple'),
    orange: resolveTokenColor('orange'),
    muted: resolveTokenColor('foreground-subtle'),
    neutral: resolveTokenColor('foreground-muted'),
  };
}

// =============================================================================
// REACT HOOK — reactive chart colors that update on theme change
// =============================================================================

/**
 * External store for theme change detection.
 * Subscribes to mutations on the <html> element's data-theme attribute.
 */
let themeVersion = 0;
const listeners = new Set<() => void>();
let observer: MutationObserver | null = null;

function subscribeToThemeChanges(callback: () => void): () => void {
  listeners.add(callback);

  if (listeners.size === 1 && typeof document !== 'undefined') {
    observer = new MutationObserver(() => {
      themeVersion++;
      listeners.forEach((fn) => fn());
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'class'],
    });
  }

  return () => {
    listeners.delete(callback);
    if (listeners.size === 0 && observer) {
      observer.disconnect();
      observer = null;
    }
  };
}

function getThemeSnapshot(): number {
  return themeVersion;
}

function getServerSnapshot(): number {
  return 0;
}

/**
 * React hook that returns resolved chart colors.
 * Automatically re-resolves when the theme changes (light/dark toggle).
 *
 * @example
 *   function MyChart() {
 *     const colors = useChartColors();
 *     return <Bar fill={colors.success} />;
 *   }
 */
export function useChartColors(): Record<SemanticIntent, string> {
  const version = useSyncExternalStore(
    subscribeToThemeChanges,
    getThemeSnapshot,
    getServerSnapshot,
  );

  return useMemo(() => resolveAllChartColors(), [version]);
}
