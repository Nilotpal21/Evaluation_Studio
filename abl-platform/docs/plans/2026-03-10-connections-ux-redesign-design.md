# Connections UX Redesign — Design Document

**Date**: 2026-03-10
**Status**: Approved
**Persona**: Hybrid (progressive disclosure)
**Scale**: Small (5–15 connections per project)
**Visual**: Vercel/Linear — minimal, monochrome, micro-interactions

## Problem

The current connections UI is generic (looks like a CRUD admin panel) and confusing (hard to understand what's connected, what's broken, what to do next). Specific pain points:

1. No edit flow — must delete and recreate to change credentials
2. Hidden actions on mobile — edit/delete only on card hover
3. No usage visibility — can't see which agents use a connection
4. No dependency warning on disconnect
5. Asymmetric credential handling (OAuth vs API key)
6. No connection health indication
7. Minimal detail page — just name, type, test button
8. No search/filter on the browse page
9. No onboarding empty state
10. No OAuth token renewal visibility

## Design

### Page Layout — Connection Hub

Single-page hub. No separate detail page — everything happens inline.

Three zones, top to bottom:

1. **Status bar**: Aggregate health summary ("8 connected · 1 expiring") + "New Connection" button (right-aligned)
2. **Categorized card grid**: Cards grouped by category, each category has a heading. Click a card to expand inline detail panel below the row.
3. **Empty category prompts**: Categories with no connections show "Add your first X connection" with suggested connectors.

#### Categories

Auto-grouped by connector metadata:

| Category      | Connectors                                            |
| ------------- | ----------------------------------------------------- |
| Communication | Slack, Discord, Teams, Gmail, Twilio, SendGrid        |
| Productivity  | Notion, Asana, ClickUp, Jira, Linear, Google Calendar |
| Storage       | Google Drive, S3, Google Sheets, Airtable, Postgres   |
| CRM & Sales   | HubSpot, Salesforce, Pipedrive, Shopify, Stripe       |
| AI & Dev      | OpenAI, Claude, GitHub                                |
| Custom        | HTTP                                                  |

Categories with connections sort by last activity. Empty categories appear at the bottom with subtle add prompts.

### Connection Card

Compact, information-dense, monochrome with one accent.

```
┌─────────────────────────────────┐
│  [Logo]  Slack               ●  │  ← health dot
│          slack.com              │  ← type hint
│                                 │
│  3 agents · 2m ago              │  ← usage + recency
└─────────────────────────────────┘
```

- **Size**: ~200×120px, `rounded-xl`, `border border-default`
- **Logo**: 32×32, grayscale by default, full color on hover
- **Health dot**: 8px. Green = connected, amber = expiring (<7 days), red = failed, gray = never tested
- **Typography**: Name `text-sm font-medium`, subtitle `text-xs text-muted`, bottom `text-xs text-muted`
- **Hover**: `translateY(-2px)`, border → accent, logo colorizes (150ms ease-out)
- **No visible action buttons** — all actions in expand panel

#### Empty Suggestion Card

Within a category, shows suggested connectors:

- Dashed border, `text-muted`
- "+ Add {Connector Name}"
- Click opens creation flow

### Inline Expand Panel

Slides open below the card row (200ms ease-out). One panel open at a time.

**Layout:**

| Section           | Content                                                                                       |
| ----------------- | --------------------------------------------------------------------------------------------- |
| Info grid (2-col) | Left: Status + health dot, Last tested, Created date/by. Right: Auth type, Token expiry       |
| Used by           | List of agents with tool counts. Empty: "Not used by any agents yet"                          |
| Actions           | Test Connection (primary), Edit Credentials (ghost), Disconnect (ghost, destructive on hover) |

**Test Connection**: Async — button shows spinner → checkmark/X. Result appears as inline status update.

**Edit Credentials**: Replaces actions row with inline credential form. API key: text input with visibility toggle. OAuth: "Reconnect" button triggers OAuth popup.

**Disconnect**: Inline confirmation with dependency warning — "This will break 3 agents: Travel Bot, Support Bot, Notify Bot. Are you sure?" Two buttons: "Disconnect" (destructive) and "Cancel".

### Creation Flow

Centered modal overlay with backdrop blur. No route change.

**Step 1 — Pick a connector:**

- Search input at top (instant client-side filter)
- "Popular" row: top 4 most-used in project (or platform defaults)
- Category-grouped mini cards (64×64, logo + name)
- Keyboard: type to filter, arrow keys, Enter to select

**Step 2 — Configure (slides in from right):**

- Back arrow (preserves search state)
- Connector logo + name + action/trigger counts
- Connection name field (auto-fills "My {Connector}")
- Auth section adapts: OAuth → branded "Connect with {Name}" button; API key → input field
- "What you'll get" preview: lists available actions/triggers

**Step 3 — Success (replaces content):**

- Animated checkmark (SVG stroke draw, 400ms)
- "{Connector} connected" + verification status
- "Done" closes modal, new card appears in hub with highlight animation
- Auto-tests connection on creation

### Empty State (No Connections)

```
        ◇
Connect your tools

Link the services your agents need —
CRMs, messaging, storage, and more.

Popular integrations
[Slack] [Gmail] [Sheets] [GitHub]

[Browse all connectors →]
```

- Geometric diamond icon (not illustration)
- Popular cards clickable — jump to step 2
- "Browse all" opens creation modal at step 1

### Micro-interactions

| Interaction             | Animation                                                 | Duration       |
| ----------------------- | --------------------------------------------------------- | -------------- |
| Card hover              | translateY(-2px), border → accent, logo grayscale → color | 150ms ease-out |
| Card click → panel open | Height 0→auto, content fade in                            | 200ms ease-out |
| Panel close             | Height → 0, content fade out                              | 150ms ease-in  |
| Health dot pulse        | Scale 1→1.3→1 on test result                              | 300ms          |
| Test button spinner     | Text fades, spinner fades in                              | 100ms          |
| Test result             | Spinner → ✓/✕, holds 2s, reverts                          | 300ms + 2s     |
| New card appears        | Scale 0.95→1, opacity 0→1, ring highlight                 | 300ms ease-out |
| Modal open              | Backdrop blur fades, modal scales 0.98→1                  | 200ms ease-out |
| Modal step transition   | Current slides left, next from right                      | 200ms ease-out |
| Disconnect confirm      | Button expands to inline warning                          | 200ms          |
| Creation success ✓      | SVG stroke draw animation                                 | 400ms          |

### Toast Notifications

- Bottom-right position, auto-dismiss 3s for success
- Error toasts persist until dismissed, include retry action
- Examples: "Slack connected successfully", "Connection test failed: Invalid token"

### Keyboard Shortcuts

Progressive — available but not advertised:

- `/` — focus search in creation modal
- `Escape` — close panel or modal
- `Enter` on focused card — expand panel

## Technical Notes

- Reuses existing `useAvailableConnectors` SWR hook for connector catalog
- Category mapping added as metadata in connector registry or client-side mapping
- Inline expand uses Framer Motion `AnimatePresence` + `motion.div` with `layout` prop
- Modal uses existing Dialog primitive from design system
- Health status requires new `lastTestedAt` + `lastTestResult` fields on Connection model
- "Used by" requires a reverse lookup: query agents in project for connection references
- Brand logos: SVG icon set per connector (can start with colored initials fallback)

## Out of Scope

- Bulk operations (not needed at 5–15 scale)
- Table/list view toggle
- Connection sharing across projects
- Webhook/trigger management UI
- OAuth token auto-refresh (backend concern, not UX)
