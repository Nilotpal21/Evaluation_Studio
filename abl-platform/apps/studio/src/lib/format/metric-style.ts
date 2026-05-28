/**
 * Metric value styling helpers.
 *
 * The `tabular-nums` font feature locks digits to a uniform advance width
 * so numeric values stay column-aligned across rows of a list, table, or
 * KPI grid. Without it, "1,234" and "9,999" render at slightly different
 * widths and the eye sees a wobbly column.
 *
 * Use `METRIC_NUMBER_CLASS` wherever a numeric value is rendered in a
 * comparison context (KPI cards, table cells, lists). Pair it with the
 * existing typography classes (`text-2xl font-semibold`, etc.); this
 * helper is a SUFFIX, not a replacement.
 *
 * Audit reference: Track 1.1 (Studio polish plan, 2026-04-25).
 */

export const METRIC_NUMBER_CLASS = 'tabular-nums';
