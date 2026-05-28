/**
 * Studio status row / surface tint helpers.
 *
 * `STATUS_ROW_TINT_CLASS` is the canonical map of row- and surface-level
 * background tints applied when a record's status is non-healthy. The
 * tint is intentionally subtle (very low opacity) so the eye reads it as
 * a hint rather than a foreground color — a row a user can glance over,
 * not a Christmas-tree of saturated rectangles.
 *
 * Pattern:
 *   - healthy   → '' (no tint)
 *   - warning   → 'bg-warning/[0.03]' (~3% opacity warning hue)
 *   - critical  → 'bg-error/[0.04]'  (~4% opacity error hue, marginally
 *                 stronger so critical rows still draw the eye first)
 *
 * Use cases:
 *   - InsightKPICard surfaces with status=warning|critical
 *   - Future Sessions/Eval-run list rows that map a record's health to
 *     a row tint
 *
 * Audit reference: Track 1.5 (Studio polish plan, 2026-04-25).
 */

export type RowStatus = 'healthy' | 'warning' | 'critical';

export const STATUS_ROW_TINT_CLASS: Record<RowStatus, string> = {
  healthy: '',
  warning: 'bg-warning/[0.03]',
  critical: 'bg-error/[0.04]',
};
