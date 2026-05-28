# 10 — Marketplace

**Implements BRD §8.8, §9.14 Marketplace.**

The Marketplace is the platform-curated discovery surface for reusable building blocks: Templates, Sub-Agents, Skills, Knowledge Packs, Guardrail Packs, and Evaluation Scenario Packs. At launch the Marketplace is **curated by the platform team only** (FR-MKT-04) — no user / partner publishing.

**Route:** `/marketplace`

Visible to Process Owners and CU Admins.

## Page header

- H1: *"Marketplace"*
- Sub: *"Platform-curated building blocks for credit-union AI apps. Templates, sub-agents, knowledge packs, guardrail packs, and evaluation scenario packs."*
- Right side:
  - Search input (max-width 320px): *"Search the Marketplace…"*
  - View toggle: Grid (default) · List

## Filter / category band

A horizontal scrollable band of category chips with item counts.

`All (47)` · `Templates (14)` · `Sub-Agents (7)` · `Skills (9)` · `Knowledge Packs (8)` · `Guardrail Packs (5)` · `Evaluation Scenario Packs (4)`

Below, a secondary filter row for domain:

`All domains` · `Card Services` · `Member Services` · `Loans` · `Fraud` · `Account Opening` · `Collections` · `Compliance` · `Financial Wellness`

## Featured strip

A 3-up large card row at the top of the canvas titled *"Featured by the Platform Team"*:

1. **Card Dispute Resolution Template** — a full app template for Reg E disputes, including SOP-derived eval scenarios.
2. **Member Hardship Guardrail Pack** — TCPA-compliant outreach, no-threats, no-financial-advice, escalation triggers.
3. **Fraud Triage Evaluation Pack** — 80 pre-built scenarios for fraud detection patterns.

Each featured card:
- Large icon (per kind)
- Name (bold)
- 1–2 line description
- Footer row: kind chip · version · "Installed by 32 CUs" · star rating (decorative, e.g., 4.7)
- Primary CTA: **Install** (or **Installed ✓** if `installed: true`)

## Grid of items

Below the featured strip, a responsive grid (3-up on lg, 2-up on md) of `MarketplaceItem` cards.

Each card:
- Kind chip (color-coded per kind):
  - Template → purple
  - Sub-Agent → blue/info
  - Skill → neutral
  - Knowledge Pack → green/success
  - Guardrail Pack → amber/warning
  - Evaluation Scenario Pack → orange
- Name (mono for sub-agents/skills, regular for packs and templates)
- Short description (2 lines max)
- Metadata row: version · last updated · "Installed by N CUs"
- Curator: *"Curated by Platform Team"* (subtle)
- CTA: **Install** / **Installed ✓** / **Update available**

## Item detail Sheet

When a card is clicked, a Sheet opens with detail.

### Identity panel
- Large icon + name + kind + version
- Long description (paragraph or two)
- Curated by: Platform Team
- Last updated: date
- Compatible with: app types or sub-agent domains

### What's included panel
Depends on kind:
- **Template**: SOP template (preview), pre-attached knowledge, default guardrails, default channels, default sub-agents, included evaluation scenarios
- **Sub-Agent**: capabilities, tools used, knowledge requirements, guardrails applied
- **Skill**: function description, inputs, outputs, when invoked
- **Knowledge Pack**: list of documents/FAQ entries included, sample content
- **Guardrail Pack**: list of guardrails with plain-language descriptions
- **Evaluation Scenario Pack**: count of scenarios, sample scenarios, intent coverage

### Compatibility / requirements panel
- Required platform version
- Required sub-agents (if pack depends on them)
- Conflicts with: other installed items (if any)

### Reviews (decorative, not in initial scope)
*Skip a reviews section — items are curated only. Just show the curator's metadata.*

### Audit / changelog panel
- Recent versions with changelog entries (e.g., *"v1.3 — Added 12 scenarios covering joint-account disputes."*)

### Install action

If not installed:
- Primary button: **Install**
- On click → confirmation Dialog showing what will be added to the tenant
- 2s loader → success state with: *"Installed. You can attach it to apps from the Review Studio."*

If installed:
- Primary button reads **Installed ✓** (disabled visual)
- Secondary actions: "Update to v1.3" (if update available), "Uninstall"

### Helper integration

A small Helper card at the bottom of the Sheet:
- *"Want me to walk you through how this fits into your existing apps?"* with a "Open in Helper" link.

## Click model

| Element | Action |
|---|---|
| Search input | Client-side filter by name and description |
| Category chips | Filter the grid by kind |
| Domain chips | Filter the grid by domain |
| Featured / grid item card | Opens detail Sheet |
| Install (in card or Sheet) | Confirmation Dialog → 2s loader → success state |
| Installed ✓ / Update / Uninstall | Decorative state changes |
| Helper card | Opens Helper sheet with item context |

## States to render

- **Default browse** — 20+ items spread across all kinds.
- **One category filtered** — show only that kind.
- **Installed item** — at least 4 items shown with `installed: true`, displaying the Installed ✓ state.
- **Update available** — at least 1 item shows the "Update available" state with a small badge.
- **Empty search** — friendly empty state if the search matches nothing.

## Out of scope

- Real installation (just visual state changes).
- Real third-party publishing (curated-only at launch per FR-MKT-04).
- Real ratings / reviews.
- Cross-tenant install statistics (the "Installed by N CUs" number is mocked).
- Marketplace search across content of packs (search filters by name/description only).

## Acceptance criteria

- Header, search, category band, domain band all render.
- Featured strip renders 3 large cards with mock content.
- Grid renders 20+ items across all 6 kinds with correct kind-color coding.
- Filter chips and search filter the grid client-side.
- Item detail Sheet renders all panels for at least one example item per kind.
- Install action produces a confirmation Dialog and updates the visual state.
- Helper context-opening works from item detail.
