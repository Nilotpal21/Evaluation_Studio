# 01 — App Shell + Process Owner Dashboard

**Implements BRD §6, §8 (lifecycle anchor), §14 (roles). Replaces the existing minimal shell in `components/Topbar.tsx`, `components/Sidebar.tsx`, `app/page.tsx`.**

## Goal

A consistent shell wrapping every screen: top bar, left sidebar, main panel. The Process Owner's dashboard is the default landing screen and gives an at-a-glance view of their SOPs, Apps, evaluation health, recent activity, and entry points to upload a new SOP or open the AI Helper.

## App shell

### Topbar (height: 48px, full width)

Left-to-right contents:
1. **Logo + product mark** — small monochrome "S" tile + "Studio" wordmark. (Reuse existing.)
2. **Workspace / org switcher** — small pill button: "Cornerstone FCU" with a chevron. On click, opens a Popover listing 1 org (just the one tenant; this is decorative). Includes a small "CU" badge styled as a purple chip.
3. **Global search** — center-anchored input, max-width ~400px. Placeholder: *"Search SOPs, apps, evaluations, knowledge…"*. Cmd+K hint on the right side of the input. Search itself is decorative — pressing Enter opens a Popover with mocked hits grouped by category (SOPs, Apps, Knowledge Sources).
4. **Upload SOP** button — primary action (light/monochrome accent, dark text). Lucide `Plus` icon + "Upload SOP". Routes to `/sops/new`.
5. **Persona switcher** — circular avatar (initials in colored chip). On click, opens a DropdownMenu listing the three personas (Process Owner, Compliance Reviewer, CU Admin). Selecting one routes to that persona's "home":
   - Process Owner → `/`
   - Reviewer → `/queue`
   - CU Admin → `/mission-control`
   Active persona has a check mark. Below the persona list, a small "Sign out" item (decorative).
6. **Bell** icon (small) — unread dot indicates 1+ notifications. Click opens a Popover listing recent items from `audit.ts` filtered to current persona.

### Sidebar (width: 224px, fixed)

Contents depend on persona. All items use Lucide icons + label + optional count badge.

**Process Owner sidebar:**
```
Home               LayoutDashboard
SOPs       [4]     FileText
Apps       [5]     Bot
Evaluations        LineChart
Helper             Sparkles
Marketplace        Store
─────────────────────────
Docs               BookOpen
Settings           Settings
```

**Reviewer sidebar:**
```
Queue      [3]     Inbox
Decided            CheckCircle2
Audit              FileSearch
─────────────────────────
Docs               BookOpen
Settings           Settings
```

**CU Admin sidebar:**
```
Mission Control    Activity
Audit              FileSearch
Knowledge  [12]    Database
Models     [7]     Cpu
Marketplace        Store
─────────────────────────
Users & Roles      Users
Tenant Settings    Settings2
```

Item style:
- 32px height, 12px horizontal padding, 6px vertical padding, 6px radius.
- Active item: `bg-background-elevated text-foreground`.
- Inactive: `text-foreground-muted hover:bg-background-elevated/60 hover:text-foreground`.
- Count badge: small mono numeric, right-aligned, `text-foreground-subtle`.

At the bottom of the sidebar, a small system-status card (already exists in the current Sidebar):
- Green pulsing dot + "System" label
- "All systems operational"
- "Updated 2 min ago"

### Main panel

- `flex: 1`, scrolls vertically with custom thin scrollbar (`.scrollbar-thin` already in globals.css).
- Max content width: 1400px, centered, with 24px horizontal padding.
- Subtle `animate-fade-in` on screen mount.

### Floating Helper button

Persistent across all authenticated routes. See `05-ai-helper.md` — referenced here only to note its presence at every screen.

### Footer

A thin row at the bottom of every screen's main panel:
- Left: `Studio prototype · mock data`
- Right: `v0.1.0 · 2026` (font-mono, text-foreground-subtle)

## Process Owner Dashboard (`/`)

### Header band

- H1: *"Welcome back, Nilotpal"* (using the active persona's first name).
- Subhead: *"Cornerstone Federal Credit Union · 3 deployments in the last 7 days · 1 app awaiting your action"*
- Right side: a purple-tinted button **"Ask Helper"** (Lucide `Sparkles` icon). Click opens the AI Helper panel anchored to "dashboard context."

### KPI cards (4-column grid, 12px gap)

| Card | Mock value | Delta line |
|---|---|---|
| Active apps | `3` | `+1 this week` (success tint) |
| Conversations · 24h | `1,652` | `+8.2% vs yesterday` (success tint) |
| Avg evaluation score | `92.3` | `+0.6 vs 7d avg` (info tint) |
| Tasks completed · 24h | `1,482` | `94.0% of started` (neutral) |

Cards: subtle bordered, `bg-background-subtle`, hover lifts border to `border-border`.

### Action row — 3-up

Three large cards spanning the row, each is a CTA tile (clickable, navigates):

1. **Upload a new SOP** — Lucide `FileText`. *"Start a new app from a Standard Operating Procedure. The platform reads it, the Helper guides you, the Evaluation Harness scores it."* → `/sops/new`.
2. **Review your apps** — Lucide `Bot`. *"3 apps deployed · 1 in review · 1 draft. Open Review Studio."* → `/apps`.
3. **Open Mission Control** — Lucide `Activity`. *"See live conversations, continuous evaluation, drift alerts."* → `/mission-control`. (Even though the link belongs to CU Admin, Process Owners get a read-only entry.)

### Two-column row

**Left (3/5 width): Conversations chart**
- Title: *"Conversations · last 12 hours"*
- Subtitle: *"All deployed apps · success / escalated / failed"*
- Stacked area chart (Recharts) with three series (success, escalated, failed) using semantic colors.
- Use `runsByHour`-style mock data, expanded to three series.
- Tooltip styled per design tokens.

**Right (2/5 width): Recent activity feed**
- Title: *"Recent activity"*
- Subtitle: *"Last 8 events across your apps"*
- List of 8 events from `activity.ts`. Each row:
  - Icon (CheckCircle2 / XCircle / AlertTriangle / Sparkles etc.) tinted per severity.
  - Mono font: agent/app name.
  - Muted text: brief summary.
  - Right side: "Xm ago".
- "Open audit log →" link at the bottom (Process Owner: navigates to `/apps` since they don't have audit; or just non-functional).

### Apps grid (3-up, lg:6-up)

Title: *"Your apps"* with right-aligned link "View all →" to `/apps`.

Render up to 6 apps from `apps.ts` (the most recently updated). Each card (see `02-sop-to-app-flow.md` for the App Card spec, which is reused across multiple screens):
- App name (mono), status pill (color per status), evaluation score badge (color-coded), channels icons row, source SOP citation ("from `card_disputes_v3.2.pdf`"), conversation count, last updated, owner avatar.

Card is clickable → routes to `/apps/[appId]`.

### Quick stats footer

Below the apps grid, a single row of subtle text:
> *"Continuous evaluation last ran 14 minutes ago · 0 active drift alerts · 1 Helper suggestion pending acknowledgment"*

(Decorative; the "1 Helper suggestion" is what the Helper panel surfaces when opened from the dashboard.)

## Click model summary

| Element | Action |
|---|---|
| Logo | → `/` |
| Workspace switcher | Popover (decorative) |
| Search | Popover with grouped mocked hits |
| Cmd+K | Opens the same search popover |
| Upload SOP (topbar) | → `/sops/new` |
| Persona avatar | DropdownMenu, selecting routes to that persona's home |
| Bell | Popover listing recent notifications |
| Sidebar item | Navigate to corresponding route |
| Helper FAB | Opens Helper sheet (see 05) |
| Dashboard "Ask Helper" button | Opens Helper sheet with dashboard context |
| KPI cards | Static (non-interactive) |
| Action row cards | Navigate as described |
| Chart tooltip | Show hourly breakdown |
| Activity row | Static (non-clickable for prototype; or could navigate to `/apps/[appId]` if `appId` is present) |
| App card | → `/apps/[appId]` |

## States to render

- **Populated** (always — never show empty state for dashboard).
- Loading state on initial mount: skeleton shimmer for KPI values and chart for ~600ms, then real mock data appears. Use `animate-shimmer`.

## Out of scope

- No real search backend.
- No notification persistence (bell dot is static).
- No real "switch workspace" — only one CU.
- No persona-specific dashboards beyond persona-aware sidebar and topbar (the Reviewer and Admin home screens are separately specified).

## Acceptance criteria

- All shell elements render at 1280px width with no overflow.
- Active sidebar item highlights based on current route.
- Persona switching changes the sidebar contents and routes to the persona's home.
- Helper FAB renders on every authenticated route.
- Dashboard renders KPI row, chart, activity feed, apps grid without console errors.
- `pnpm build` succeeds.
