# 03 — Review Studio

**Implements BRD §9.5 Review Studio, §8.5. References §9.2, §9.3, §9.4, §9.6, §9.10, §9.10.1, §9.11, §9.12, §9.13, §9.19.**

The Review Studio is the single most important authoring screen in the product. A Process Owner opens it after auto-generation and reviews, edits, and submits their app. Every section is in plain language; nothing exposes prompts, models, or agent internals.

**Route:** `/apps/[appId]`

## Layout

Three-column structure:

```
┌──────────────────────────────────────────────────────────────────────────┐
│  App header bar                                                          │
├───────────────────────────────────┬──────────────────────────────────────┤
│  Main canvas (panels)             │  Right rail (eval + sandbox + helper)│
│  scrollable                       │  sticky, scrollable                  │
│                                   │                                      │
│  ◦ What this app does             │  Evaluation Report card              │
│  ◦ Who it serves                  │   (score, trend, breakdown)          │
│  ◦ What it knows                  │   "Re-run evaluation"                │
│  ◦ What it won't do               │                                      │
│  ◦ What it can touch              │  Sandbox preview                     │
│  ◦ What it remembers              │   "Test as member" / "as employee"   │
│  ◦ SOP issues to address          │   Chat-style test conversation       │
│  ◦ Channels                       │                                      │
│  ◦ Submit for approval            │  Helper card                         │
│                                   │   Quick suggestions                  │
│                                   │                                      │
└───────────────────────────────────┴──────────────────────────────────────┘
```

- Main canvas: `flex: 1`, scrolls.
- Right rail: 360px wide, sticky on lg+ screens, collapses to a tab below the canvas on smaller widths (not required for prototype).

## App header bar (full width, below shell topbar)

Left side:
- Mono app name (e.g., `card-dispute-triage`) with version pill (`v3`)
- Status pill (color per status)
- Sub-line: *"from SOP: Card_Disputes_v3.2.pdf · last evaluated 14 min ago"*

Right side:
- "Discard changes" link (muted, no-op for prototype)
- **Submit for approval** primary button (light/monochrome accent)
  - If app has unresolved Blocker flags → disabled with tooltip *"Resolve all Blocker flags before submitting."*
  - If app is already deployed → button reads "Re-submit for approval" with a small "v4 draft" annotation.

## Main canvas panels

Each panel is a bordered card (`border-border-muted bg-background-subtle rounded-lg p-5`) with:
- Panel title (small, semi-bold)
- Right side of title: "Edit" button (Lucide `PencilLine`) — opens an in-place editor or a Sheet
- Optional Helper button (Lucide `Sparkles`, small) — opens Helper anchored to this panel

The panel order matches BRD §8.5.

### Panel 1: What this app does

A short editable paragraph (default = `apps[].description`). Hover state shows "Edit" affordance. Below the paragraph:
- *"Sourced from: §1 of `Card_Disputes_v3.2.pdf`"* (subtle link styling, decorative)

### Panel 2: Who it serves

Two horizontal pill rows:
- **Audience:** `Members` (always present), optional `Employees` chip
- **Channels:** chips for selected channels (`Digital`, `Voice`, `SMS`, `Email`). Click toggles in/out (visual only).

### Panel 3: What it knows (Knowledge)

- Top-row stat: *"4 knowledge sources attached"*
- List of attached sources, each row:
  - Source icon (Lucide `FileText` / `Globe` / `Database` / `Cloud` based on mode)
  - Source name + provider tag
  - Tags chips (e.g., `reg-e`, `pii`)
  - "View" button (opens Sheet with mock content preview)
  - "Remove" button (no-op in prototype)
- "+ Attach more from Knowledge Library" button (opens a Dialog listing 8–10 sources from `knowledge.ts` — checkbox per source, "Attach" action)
- A small *"Citation coverage: 96% in last evaluation"* line at the bottom (info tint)

### Panel 4: What it won't do (Guardrails)

- Headline note: *"Baseline credit-union guardrails are applied automatically and cannot be removed."*
- List of guardrails: each as a row with:
  - Lock icon if non-disable-able (baseline) — read-only chip
  - Pencil icon if custom — editable
  - Plain-language description (e.g., *"Never quote final rates."*)
- "+ Add a custom guardrail" button (opens a Dialog with a textarea, "Write a rule in plain English…")
- Below the list, a small italic note: *"7 baseline guardrails active · 3 derived from your SOP"*

### Panel 5: What it can touch (Tools)

- Headline: *"Tools and connectors this app can use"*
- Two sub-sections:
  - **Transactional connectors** (those that move/read state): Core banking, LOS, CRM, etc. — chips with green dot if connected, gray if available.
  - **Knowledge connectors** (read-only): Confluence, SharePoint, etc. — shown only if attached.
- Each connector row:
  - Provider icon
  - Connector name
  - Data access in plain language (e.g., *"Reads: account balance, transaction history. Does not write."*)
- Money-moving tools (`tool_payments`) get a small ⚠️ chip: *"Requires dual approval to enable."*

### Panel 6: What it remembers (Memory)

- Radio group with three options: **None** · **Session** · **Long-term**
- Long-term option shows a sub-line: *"Requires explicit member consent. Long-term memory follows GLBA disclosure rules."*
- Helper hint below: *"For card-dispute-triage, session memory is the recommended default. Long-term memory is rarely needed for transactional workflows."*

### Panel 7: SOP issues to address

Lists the SOP Quality Check flags (from earlier auto-gen) inline here for active management:
- Each flag row:
  - Severity icon + color
  - Title
  - Quoted SOP passage (mono, muted)
  - State buttons: `Acknowledge` / `Open in Helper` / (for warnings/suggestions) `Mark resolved`
- Acknowledged flags collapse into a "Acknowledged (2)" expandable section at the bottom.
- A summary line at the top: *"0 Blockers · 1 Warning · 5 Suggestions · 1 Acknowledged"*

### Panel 8: Channels & deployment target

- Channel chips (same as Panel 2 but repeated for explicit deployment context)
- Audience picker: *"This app will be deployed to:"* — Radio: `All members`, `Members in segment…` (segment selection opens a Sheet with mocked segments)
- *"Estimated audience size: 47,200 members"*

### Panel 9: Submission summary (sticky at bottom)

Not editable. A pre-flight checklist:

```
✓ All 7 baseline guardrails active
✓ 4 knowledge sources attached (96% citation coverage)
✓ 0 Blocker flags
⚠ 1 Warning flag not yet acknowledged
✓ Evaluation Score: 94 (well above pilot baseline of 80)
✓ All required approvers identified (2 of 2)
```

Below the checklist, the same **Submit for approval** button as in the header.

## Right rail

### Evaluation Report card (top)

Sticky card. Compact view:
- Big number: `94` (centered, large, mono)
- Sub-label: *"Evaluation Score"*
- Trend pill: `↑ +2.4 vs last run` (success tint)
- Mini-bars showing scores by category (5–7 categories, each a thin horizontal bar)
- "Open full report →" link → `/apps/[appId]/evaluation`
- "Re-run evaluation" button (Lucide `RefreshCw`) — clicking triggers a fake loader on the card for ~3 seconds, then refreshes the score (visual only)

### Sandbox preview card (middle)

- Title: *"Test conversation"*
- Toggle: **Test as member** / **Test as employee**
- A chat-style mini-conversation surface (read-only for prototype):
  - Show a pre-scripted exchange of 4–6 turns (member intent → agent response with citation → member follow-up → agent task creation).
  - Each agent turn shows a small "via Account Services" chip indicating the sub-agent that handled it.
  - Citations rendered as superscript footnote markers.
- "New test conversation" button — replays the conversation from the top with a slight stagger animation.
- "Save this as an evaluation test" button (visual only — toasts a success confirmation).

### Helper card (bottom)

- Title: *"Helper suggestions"* with purple tint
- 3 suggestion chips:
  - *"Walk me through Reg E disclosures in this app"*
  - *"Explain why I chose Account Services for this workflow"*
  - *"Suggest one improvement based on my last evaluation"*
- Clicking any chip opens the Helper sheet with that prompt pre-filled.

## Click model

| Element | Action |
|---|---|
| "Edit" on any panel | Opens an inline editor or Sheet — visual only |
| Panel Helper button | Opens Helper sheet, context = current panel |
| Sub-agent chip | Hover shows tooltip with sub-agent description |
| Knowledge "Attach" | Opens Knowledge picker Dialog |
| Knowledge "View" | Opens Sheet with mocked content preview |
| Guardrail "Add custom" | Opens Dialog with textarea |
| Tool row | Hover shows data-access detail |
| Memory radio | Updates local state, shows the selected option's hint |
| SOP flag "Acknowledge" | Moves flag to acknowledged section |
| SOP flag "Open in Helper" | Opens Helper sheet anchored to this flag |
| Re-run evaluation | Loader for ~3s, then animates the score change |
| Sandbox "New test conversation" | Replays the scripted conversation |
| Helper suggestion chip | Opens Helper sheet with prefilled prompt |
| Submit for approval | If valid: routes to a confirmation Sheet then to `/queue/[appId]` (read-only view from Process Owner's perspective). If Blocker exists: shake animation + tooltip. |

## States to render

- **Default (`card-dispute-triage`)** — deployed app, in re-edit mode.
- **In review (`hardship-assist`)** — Submit button shows "Submission pending review" with a muted state.
- **Draft with Blocker (`loan-application-intake`)** — Submit button disabled with tooltip.

## Out of scope

- Real edit persistence across page navigation.
- Real evaluation re-run (just visual loader + score animation).
- Real sandbox LLM (scripted exchange only).
- Real tool data-access policy enforcement.
- Real submission to queue (visual only; navigates to reviewer queue read-only view).

## Acceptance criteria

- All 9 panels render in correct order.
- Right rail sticks correctly on scroll.
- Sandbox conversation plays through smoothly.
- Submit button correctly disabled for Blocker state.
- Helper opens with the correct context label for each panel-specific Helper button.
- Re-run evaluation animation completes and updates score visually.
- No console errors on tab toggle, panel edit, or sandbox playback.
