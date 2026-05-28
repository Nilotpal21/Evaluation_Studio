# 05 — Evaluation Report

**Implements BRD §8.3, §9.6 (FR-EVL-01 through FR-EVL-13).**

The Evaluation Report is the product's *"does it work?"* answer made concrete. It's score-based, three-test-source-combined, runs pre-deploy and continuously after, and is core to both authoring trust and reviewer judgment.

**Route:** `/apps/[appId]/evaluation`

## Page header

- Breadcrumb: `Apps > card-dispute-triage > Evaluation`
- H1: *"Evaluation Report"*
- Sub: *"Run #14 · ran 14 minutes ago · triggered by: auto-on-edit"*
- Right side:
  - **Re-run evaluation** button (primary)
  - Kebab menu: "Compare to previous run," "Download report" (decorative), "Open in Helper"

## Top band: Overall score + trend

Large hero card spanning the full canvas width.

**Left (1/3):** the score itself.
- Huge number: `94` (Geist Mono, 72px+, centered)
- Sub-label: *"Overall Evaluation Score"*
- Trend pill: `↑ +2.4 vs previous run` (success)
- Tiny: *"Updated 14 min ago"*

**Right (2/3):** a thin 30-day trend chart.
- Recharts line chart, 30 data points (one per day), y-axis 0–100.
- Tooltip on hover shows date + score + trigger.
- A faint horizontal line at `80` labeled *"Pilot baseline"*.

## Three-source breakdown band

A three-column row showing how each test source contributed.

| Source | Count | Passed | Failed | Pass rate |
|---|---|---|---|---|
| Pre-built CU scenarios | 412 | 392 | 20 | 95.1% |
| SOP-derived tests | 87 | 81 | 6 | 93.1% |
| User-defined tests | 14 | 13 | 1 | 92.9% |

Each card has a tiny donut chart visualizing pass rate. Below the table, a "View all 513 tests →" link (opens a Sheet listing tests with filter chips).

## Category scores

A panel titled *"Performance by category"*.

For each category (5–7 from `evaluations.ts`), render a row:
- Category name + trend icon (`↑` / `→` / `↓`)
- Big score (right-aligned)
- A horizontal bar showing score 0–100 (use semantic color thresholds: ≥90 success, 75–89 warning-tinted (amber), <75 error-tinted (red))
- Sub-line: *"X passed · Y failed"*
- Expand chevron (right): clicking expands to show 2–3 representative failing examples inline (see Failing Examples below).

Sort: lowest-scoring at top, highest at bottom.

## Failing Examples panel

A panel titled *"Top failing examples"* with note: *"Examples where the app's response didn't meet the evaluation criteria."*

List of 3–5 failing examples (from `evaluations.ts:topFailingExamples`). Each example:

```
┌──────────────────────────────────────────────────────────────────┐
│ Intent: "Member requests hardship plan after missed 2 payments"  │
├──────────────────────────────────────────────────────────────────┤
│  Expected: collect income-loss docs before drafting plan         │
│  Actual:   drafted plan without documentation step               │
│  Why:      SOP §4 calls for the documentation step, but the      │
│            account-services sub-agent's flow skipped it.         │
├──────────────────────────────────────────────────────────────────┤
│  [Discuss with Helper]   [Add to user-defined tests]             │
└──────────────────────────────────────────────────────────────────┘
```

- "Discuss with Helper" → opens Helper sheet with this example as context
- "Add to user-defined tests" → toast confirmation (decorative)

## Citation coverage band

A row at the bottom of the report:
- *"Citation coverage: 96% of member-impacting responses cited a source."*
- *"Knowledge sources used most: Reg E playbook (412), Card dispute disclosures (310), Cornerstone FAQ (98)."*
- *"Source health: 4 active · 0 stale · 0 deprecated."*

A small "View Knowledge Library →" link if the persona is CU Admin (Process Owner sees the line but no link).

## Compare panel (collapsible at bottom)

Title: *"Compare to previous run"*. Expands to show a diff-style table:

| Category | Run #13 | Run #14 | Δ |
|---|---|---|---|
| Member authentication | 96 | 96 | — |
| Reg E disclosure | 89 | 94 | +5 |
| Hardship eligibility logic | 75 | 78 | +3 |
| Citation accuracy | 95 | 96 | +1 |
| Escalation timing | 90 | 88 | −2 |

Hover any row to highlight the corresponding row in the main category breakdown.

## Helper integration

Two affordances throughout the page:
- The kebab menu "Open in Helper" opens the Helper sheet with the full report as context. The Helper offers: *"Want me to explain why the Hardship category dropped 2 points?"*
- Per-example "Discuss with Helper" buttons open the Helper anchored to that specific failing example.

## Re-run evaluation interaction

Clicking **Re-run evaluation**:
1. Header button shows a spinner; main score card greys out slightly.
2. A subtle progress row appears under the trend chart: *"Running 513 tests…"* with a thin progress bar that fills over ~6 seconds.
3. Progress text cycles through: *"Pre-built scenarios…"* → *"SOP-derived tests…"* → *"User-defined tests…"* → *"Scoring categories…"* → *"Generating report…"*.
4. When complete, score animates from current to the new value (e.g., 94 → 95). Trend pill updates. Toast: *"Re-run complete. Score improved by 1 point."*

The new score is a hardcoded delta for the prototype.

## Click model

| Element | Action |
|---|---|
| Re-run evaluation | Animated fake re-run as described |
| Category row chevron | Expands to show inline failing examples |
| "View all 513 tests" | Opens Sheet listing test scenarios (mocked) |
| "Discuss with Helper" (per example) | Opens Helper sheet with example as context |
| "Add to user-defined tests" | Toast confirmation |
| Trend chart hover | Tooltip |
| Compare table row hover | Highlights main category row |
| Kebab → Compare | Scrolls / expands the Compare panel |
| Kebab → Download | Toast: "Report copied to clipboard" (decorative) |
| Kebab → Open in Helper | Opens Helper with full report context |

## States to render

- **Normal populated** (default)
- **Score regressed** — for a different app (`hardship-assist`), show overall trend pill in warning tint: `↓ −3.1 vs previous run`. Also surface a small banner at the top: *"Score dropped this run. Helper has a suggestion."* with an inline Helper CTA.
- **No previous run** — for a fresh app (`loan-application-intake`), show the trend pill as `— first run` and hide the Compare panel.

## Out of scope

- Real evaluation execution.
- Real test scenario library (just a populated Sheet with mocked rows).
- Real comparison logic (Compare panel hardcoded).
- Custom test-creation flow (creation is reachable from the Sandbox in Review Studio per `03-review-studio.md`, but the prototype's creation flow can be a single Dialog with title + prompt + expected behavior fields, no persistence).
- Continuous-eval timeline view (covered in `07-mission-control-and-audit.md`).

## Acceptance criteria

- Hero card renders with correct score, trend, and 30-day chart.
- Three-source breakdown renders with correct counts and donut visuals.
- Categories sort lowest-first.
- Expanding a category reveals 2–3 failing examples.
- Failing examples render with expected/actual/why fields and action buttons.
- Re-run interaction plays through its animation sequence and updates the score visibly.
- Helper can be opened with report-level and example-level context.
- All three app states (normal, regressed, first-run) display correctly.
