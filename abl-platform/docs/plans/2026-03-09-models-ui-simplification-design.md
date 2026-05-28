# Models UI Simplification — Progressive Disclosure Design

**Date:** 2026-03-09
**Status:** Approved
**Scope:** `apps/studio/src/components/admin/ModelsPage.tsx`, `apps/studio/src/components/settings/ModelConfigTab.tsx`

## Problem

1. **Silent failures** — Default model has no credentials → chat fails with no visible error
2. **Default model unclear** — Small badge (tenant) or star icon (project), neither prominent
3. **Tier system adds cognitive load** — fast/balanced/powerful grouping gates basic setup, but 95% of users want "one model that works"

## Design: Progressive Disclosure

Keep existing backend/API routes unchanged. Redesign both tenant and project model pages with a shared pattern.

### 1. Hero Default Model Card

Prominent card at the top of both pages showing the active default model with connection health.

**States:**

- **Healthy** — green indicator, "Ready to use"
- **No credentials** — amber warning + action button: "Add a connection to use this model"
- **Connection error** — red, "Connection failed — check credentials"
- **No default set** — empty state: "No default model configured. Select one below."

**Project-level inheritance:** If no project default is set, show inherited tenant default with label: "Using workspace default — [Set project override]"

### 2. Simplified Model List

Flat list (no tier grouping). Each row shows:

- **Default indicator** — filled star (default) / outline star (click to set)
- **Model name, provider, model ID**
- **Connection status** — primary visual: Ready (green) / No Keys (amber) / Error (red) / Inactive (gray)
- **Connection count**
- **Actions menu** — Set as default, Edit, Manage connections, Deactivate, Delete

Rows expand on click to show connections + settings (existing behavior preserved).

### 3. Tier Routing (Advanced, Collapsed)

Below model list, a collapsible "Advanced: Operation Routing" section. Hidden by default. Only rendered when 2+ active models exist. Contains existing operation-tier mapping table — no changes to the mapping UI itself.

### 4. Setup Guidance

**Empty state** (no models): Step-by-step guide with action buttons (Add Credential, Browse Catalog).

**Warning banner** (default model has broken connection): Amber banner above hero card with "Fix Now" action link.

## Files Changed

| File                                                     | Change                                                  |
| -------------------------------------------------------- | ------------------------------------------------------- |
| `apps/studio/src/components/admin/ModelsPage.tsx`        | Hero card, flat list, collapsed tiers, warning banner   |
| `apps/studio/src/components/settings/ModelConfigTab.tsx` | Hero card, flat list, inherited default, warning banner |

## Not Changed

- Backend API routes (no changes)
- AddModelDialog, AddConnectionDialog, HyperParameterForm (reused as-is)
- Agent-level AgentModelTab (no changes)
- Data model / database schema (no changes)
