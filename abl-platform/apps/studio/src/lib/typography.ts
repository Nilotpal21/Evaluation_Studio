/**
 * Studio typography rhythm helpers.
 *
 * `SECTION_LABEL_CLASS` is the canonical pattern for the small header
 * label that introduces a logical section: a metric card label, a
 * settings group title, a table column header. Today these labels use
 * five different combinations of size/weight/color/tracking across the
 * codebase. This constant is the single source of truth so adoption can
 * land incrementally without each surface drifting again.
 *
 * Pattern: `text-xs font-medium uppercase tracking-wider text-muted`
 *
 *   - text-xs       12px — small enough to subordinate to the value, large
 *                   enough to remain readable next to body copy.
 *   - font-medium   500 — adds weight without competing with bold body text.
 *   - uppercase     Pure caps. Pairs with the wider tracking to feel
 *                   intentional rather than shouty.
 *   - tracking-wider 0.05em — opens up the caps slightly for legibility.
 *   - text-muted    Secondary text token. The label sits visually behind
 *                   the value it introduces. Higher contrast than
 *                   `text-subtle` (which we previously used in some
 *                   surfaces); audits flagged subtle as too dim to read
 *                   at this size.
 *
 * Audit reference: Track 1.3 (Studio polish plan, 2026-04-25).
 */

export const SECTION_LABEL_CLASS = 'text-xs font-medium uppercase tracking-wider text-muted';

/**
 * Canonical Studio type scale — the only sizes UI code should reach for.
 *
 * The audit found 310+ usages of arbitrary pixel sizes (`text-[10px]`,
 * `text-[11px]`, `text-[13px]`) sprinkled across the codebase, breaking
 * vertical rhythm and complicating dark/light readability tuning. The
 * scale below is the documented Tailwind step set; new surfaces and
 * polish slices SHOULD pick from these instead of bespoke pixel values.
 *
 * Existing arbitrary sizes are intentionally NOT mass-converted by this
 * slice — that is a deliberate adoption sweep, slice by slice, where
 * the visual impact of each step change can be eyeballed against the
 * canary baseline. The lock tests (Track 0.2) prevent new arbitrary
 * sizes from creeping into the canary surfaces.
 *
 *   TYPE_SCALE.body            text-sm   (14px)  — default body copy
 *   TYPE_SCALE.bodyLarge       text-base (16px)  — denser body / dialog
 *   TYPE_SCALE.label           text-xs   (12px)  — labels, captions, chips
 *   TYPE_SCALE.kpi             text-2xl  (24px)  — current KPI value
 *   TYPE_SCALE.heroKpi         text-4xl  (36px)  — Track 1.10 hero KPI
 *   TYPE_SCALE.sectionHeading  text-base font-semibold (16px) — section titles
 *   TYPE_SCALE.pageTitle       text-xl   (20px)  — page <h1>
 *
 * Audit reference: Track 1.9 (Studio polish plan, 2026-04-25).
 */
export const TYPE_SCALE = {
  body: 'text-sm',
  bodyLarge: 'text-base',
  label: 'text-xs',
  kpi: 'text-2xl',
  heroKpi: 'text-4xl',
  sectionHeading: 'text-base font-semibold',
  pageTitle: 'text-xl',
} as const;

export type TypeScaleKey = keyof typeof TYPE_SCALE;
