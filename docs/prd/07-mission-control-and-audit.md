# 07 — Mission Control + Audit

**Implements BRD §8.6, §9.16 Mission Control Runtime, §9.17 Post-Deployment Assistance, plus the platform's audit trail across §12.**

Two routes:
1. **Mission Control** (`/mission-control`) — live ops + continuous evaluation surface
2. **Audit log** (`/audit`)

## Mission Control (`/mission-control`)

### Header

- H1: *"Mission Control"*
- Sub: *"Live operations across 3 deployed apps · continuous evaluation surfaces · drift & regression alerts"*
- Right side:
  - Range selector: `Live` `Last 1h` `Last 24h` `Last 7d` (default: Last 24h)
  - "Refresh" icon button
  - Kill switch shortcut (Lucide `Power`, error tint) — opens a Sheet listing all deployed apps with per-app kill toggles

### Top band: Status strip

A single row showing platform-wide status:

```
● 3 apps deployed     ● 1,652 conversations / 24h     ● 96.4% success rate (live)
● 0 drift alerts       ● 4 guardrail triggers / 24h    ● Avg latency 814ms (p95: 1.42s)
```

(Bullets are status dots, color-coded.)

### Per-app cards

A grid of cards (one per deployed app). Each card spans roughly 1/3 of the width on lg screens.

#### Card contents

- Top row: app name (mono) + status pill + kill switch toggle (icon button)
- KPI row: Conversations · Success rate · Avg latency · Escalations (4 small stats)
- Mini sparkline (Recharts area chart, 24 hourly points) for conversations volume
- Mini sparkline overlay or below: Continuous Eval score line (single line, y-axis 0–100), colored per current health (≥90 success, 75–89 warning, <75 error)
- "View details →" link → `/mission-control/[appId]` (treat as a sub-route; for prototype, can be a Sheet instead)

### Continuous evaluation surface (lower panel)

Title: *"Continuous evaluation"* + sub: *"Latest scheduled run: 14 min ago"*

A panel with:
- A line chart, x-axis = time (last 7 days), y-axis = score, three lines (one per deployed app), legend by color
- Below the chart, a "Findings" list (alerts/regressions):
  - *"`card-dispute-triage` Reg E disclosure category dropped 4 points in last run."* — `Open in Helper` button
  - *"`account-opening-assistant` citation coverage trending down (96 → 92 over 7d)."* — `Open in Helper`
  - (If empty: *"No regressions detected in the last run."* with a green dot)

### Drift / alerts panel

Right rail or separate panel below. Lists drift alerts with severity tiers (`Critical` · `Warning` · `Info`). Each item: app + category + delta + "View details" / "Acknowledge".

Alert fatigue note (per BRD §16): *"You're seeing alerts above your tenant's threshold. Adjust thresholds in Settings."* (decorative link)

### Live conversations stream (collapsible, on by default)

A streaming-style log of recent conversations.

- Each row: timestamp, app name (mono), outcome chip (Completed / Escalated / Failed / Task created), member id (anon), duration, "View transcript →"
- Adds a new row every 4–6 seconds while the page is open (use a setInterval that prepends a random mock event).
- Cap at 50 rows visible; older rolls off.

Click "View transcript" → opens a Sheet with the conversation turns from `transcripts.ts`. Show:
- Member ↔ agent turns with sub-agent attribution chips
- Citation footnote markers
- Tool calls rendered as compact JSON blocks
- "Open in Helper" CTA: *"Why did this conversation escalate?"*

### Kill switch behavior

Clicking the kill switch icon on any app card:
- Confirmation Dialog: *"Pause `card-dispute-triage`? It will stop serving members within seconds."*
- On confirm: toast, app's status flips to `paused`, card visually dims, kill switch icon becomes a "Resume" icon.

## Audit log (`/audit`)

### Header

- H1: *"Audit log"*
- Sub: *"Immutable record of every action across SOPs, apps, approvals, deployments, evaluations, Helper, guardrails, knowledge, models, and access."*
- Right side: filter row.

### Filter row

- Date range picker
- Category multi-select chips: `SOP` `App` `Approval` `Deployment` `Evaluation` `Helper` `Guardrail` `Knowledge` `Model` `Access`
- Actor filter (free text + persona suggestions)
- "Export" button (Lucide `Download`) — toasts "Audit log exported" (decorative)

### Audit table

Columns:
- Timestamp (mono)
- Actor (avatar + name; "system" gets a small gear icon)
- Category (chip)
- Action (e.g., "Submitted for approval," "Acknowledged Warning flag," "Confirmed Helper edit," "Deployed v3")
- Target (e.g., "app: card-dispute-triage", "sop: Card_Disputes_v3.2.pdf")
- Summary (1 line)
- Actions column: small kebab → "View details" (opens Sheet with full entry + JSON-ish payload)

Sort: most recent first.

Pagination: simple "Load more" button at the bottom (decorative — preloads more from the mock list).

### Row hover detail

Hovering a row shows a small tooltip with the full entry's metadata (app id, session id if relevant, before/after deltas where applicable).

## Click model summary

| Element | Action |
|---|---|
| Mission Control range selector | Re-renders charts with mock data for that range |
| App card "View details" | Opens a Sheet (or routes to a future sub-page) |
| Kill switch | Confirmation Dialog → pause + visual state change |
| Continuous eval findings "Open in Helper" | Opens Helper sheet with the finding as context |
| Live stream row "View transcript" | Sheet with conversation turns |
| Audit filter chips | Filter the table client-side |
| Audit row kebab → "View details" | Sheet with full entry |
| Audit "Export" | Toast |

## States to render

- **Healthy mission control** (default): all green, 0 drift alerts.
- **With regressions**: at least 2 findings visible; one drift alert visible in the alerts panel.
- **App paused**: one app card shown in paused state.
- **Audit log populated**: 25+ entries.
- **Audit log filtered to one category**: show only that category's entries.

## Out of scope

- Real-time streaming (use mock interval-based prepending of events).
- Real transcript rendering of arbitrary conversations (use the 1–2 hardcoded ones in `transcripts.ts`).
- Per-app drill-down sub-page (a Sheet is sufficient for the prototype).
- CSV / PDF export.

## Acceptance criteria

- Mission Control header status strip renders with correct mock metrics.
- Per-app cards render with sparklines and kill switches.
- Continuous evaluation chart renders 3 series cleanly.
- Findings list renders and each finding opens Helper.
- Live conversation stream auto-prepends events while the page is open.
- Kill switch toggles app status and visually dims the card.
- Audit log filters work client-side.
- "View details" sheets render the full entry's mock payload.
