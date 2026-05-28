# Git Integration UI Redesign — Design Spec

**Date:** 2026-03-25
**Status:** Draft
**Scope:** `apps/studio/src/components/settings/GitIntegrationTab.tsx` and related components, API client types, two new backend endpoints

## Problem Statement

The current Git Integration UI is a monolithic 657-line component with flat layout that lacks:

- **Diff previews** — users push/pull blindly without seeing what will change
- **Per-entity sync status** — no visibility into which agents/tools are ahead, behind, conflicted, or untracked relative to the remote
- **Conflict resolution UI** — only strategy selection at setup time; no inline resolution when conflicts occur
- **Branch awareness** — locked to the initially configured branch; no environment promotion visibility
- **Editable settings** — `updateGitIntegration` API exists but is unused in the UI
- **Rich history** — minimal information (direction, SHA, status, count, date) with no expandable detail
- **Type mismatches** — frontend types are out of sync with backend (missing `'conflict'` status, wrong field names for credential type and conflict strategy)

## Target Users

Two personas served equally:

1. **Developers / Agent builders** — write ABL DSL, iterate on agent logic, use git for version control (branch, PR, review, merge)
2. **Team leads / DevOps** — manage promotion across environments (dev to staging to prod), concerned with deployment governance and audit trails

## Design Overview

**Layout:** Tabbed interface using Studio's existing `Tabs` component, with a persistent header always visible.

**Structure:**

- Persistent Header (connection info + sync status bar + push/pull actions)
- Tab 1: Changes (per-entity sync status with diffs and conflict resolution)
- Tab 2: Promotion (visual environment pipeline with promotion history)
- Tab 3: History (rich audit log with expandable detail rows)
- Tab 4: Settings (editable sync config, webhook management, disconnect)

---

## Section 1: Persistent Header & Sync Status Bar

Always visible at the top regardless of active tab.

### Connection Row

- **Left:** Provider icon (GitHub/GitLab/Bitbucket) + repository URL (clickable, opens in new tab) + branch badge (e.g., `main`) + sync path (if not `/`)
- **Right:** Status badge (Connected/Error/Disconnected) + Push button (primary variant) + Pull button (secondary variant)

### Sync Status Bar

Compact summary strip below the connection row with 4 metrics:

| Metric      | Display                                           | Details                                                                                       |
| ----------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Last Sync   | Relative time (e.g., "3 hours ago")               | Tooltip: full timestamp + direction (push/pull)                                               |
| Commit      | Last sync commit SHA (7 chars)                    | Clickable: opens commit on git provider                                                       |
| Changes     | Count summary: "2 ahead - 1 behind - 0 conflicts" | Color-coded dots (success/warning/error)                                                      |
| Sync Health | Badge                                             | "In Sync" (success), "Changes Pending" (warning), "Conflicts" (error), "Never Synced" (muted) |

### Push Action

Clicking Push opens a **Push Preview Dialog**:

- List of files that will be pushed, grouped by status (added/modified/deleted) with color coding
- Per-file "View Diff" action opening inline diff
- Commit message input field
- Toggle: "Create Pull Request instead of direct push" with target branch selector
- Confirm button to execute push

### Pull Action

Clicking Pull opens a **Pull Preview Dialog**:

- Triggers a `dryRun: true` API call first
- Shows what will change: agents added/modified/removed
- Syntax validation warnings (if any from `importProject()`)
- Confirm button to execute pull

---

## Section 2: Changes Tab (Default Tab)

Per-entity sync status comparing local state against the last known remote state.

### Summary Filter Bar

Segmented filter pills at the top with counts:

- All (N) | Ahead (N) | Behind (N) | Conflicts (N) | Untracked (N) | In Sync (N)
- Clicking a pill filters the table below

### Changes Table

| Column      | Content                      |
| ----------- | ---------------------------- |
| Icon        | Bot (agent) or Wrench (tool) |
| Name        | Entity name                  |
| Type        | "Agent" or "Tool" badge      |
| Status      | Colored badge (see below)    |
| Local Hash  | First 8 chars of source hash |
| Last Edited | Relative time                |
| Actions     | Context-dependent buttons    |

**Status badges:**

| Status       | Badge   | Dot Color | Meaning                            |
| ------------ | ------- | --------- | ---------------------------------- |
| In Sync      | success | green     | Local and remote match             |
| Local Ahead  | info    | blue      | Unpushed local changes             |
| Remote Ahead | warning | amber     | Remote has changes not yet pulled  |
| Conflict     | error   | red       | Both sides changed since last sync |
| Untracked    | muted   | gray      | Exists locally, never synced       |
| Remote Only  | purple  | purple    | Exists on remote, not locally      |

**Actions per status:**

| Status                    | Action      | Behavior                                 |
| ------------------------- | ----------- | ---------------------------------------- |
| Local Ahead, Untracked    | "View Diff" | Opens DiffPanel (SlidePanel)             |
| Remote Ahead, Remote Only | "Preview"   | Opens DiffPanel showing incoming content |
| Conflict                  | "Resolve"   | Opens ConflictResolutionPanel            |

### Diff Panel (SlidePanel)

- Opens from the right using Studio's `SlidePanel` component
- Uses the existing `DiffViewer` component (`apps/studio/src/components/ui/DiffViewer.tsx`)
- Header: file path + entity name + status badge
- Body: unified or side-by-side diff of DSL content (local vs remote)
- Footer: contextual action buttons — "Include in Push" / "Accept Remote" / etc.

### Conflict Resolution Panel (SlidePanel)

When user clicks "Resolve" on a conflicted entity:

1. SlidePanel opens with three-pane view: **Base** (content at last sync commit) | **Local** (current) | **Remote** (current remote)
2. Per-file action buttons:
   - "Keep Local" — resolves with local content
   - "Accept Remote" — resolves with remote content
   - "Open in Git Provider" — creates a PR branch and opens the conflict in the git provider's UI for complex manual resolution
3. Once all conflicts in the entity are resolved, push/pull can proceed

### Empty State

When all entities are in sync: centered CheckCircle icon with "All entities are in sync with remote" message.

---

## Section 3: Promotion Tab

Visual environment pipeline for promoting changes across branches.

### Pipeline Visualization

Horizontal flow of three cards connected by directional arrows:

```
[ Main ] ——> [ Staging ] ——> [ Production ]
```

Each environment card shows:

- Branch name + environment label
- HEAD commit SHA (7 chars) + commit message preview (truncated)
- Status dot: green (up to date with previous stage), amber (behind previous stage), gray (branch doesn't exist yet)
- "X commits ahead/behind" relative to the previous stage

**Promote Button:** Appears on the arrow between cards when the source is ahead of the target. Clicking opens a PromoteDialog.

### Promote Dialog

- Shows: Source branch -> Target branch
- Number of commits being promoted
- Note: "This will create a Pull Request on {provider} for review"
- Confirm button: creates PR via `BranchManager.promoteBranch()`, displays clickable PR URL on success

### Missing Branch State

If staging or production branches don't exist yet:

- Card shows dashed border with muted styling
- "Create Branch" button inside the card
- One-click creation via `BranchManager.createEnvironmentBranch()`

### Promotion History

Below the pipeline visualization, a timeline/activity list of past promotions:

- Direction arrow (e.g., "main -> staging"), relative timestamp, triggered by (user name)
- PR link (clickable, opens on git provider), status badge (merged/open/closed)
- Commit SHA of the promotion point
- Paginated, 10 entries per page (smaller page size than the History tab's 25 because this is a focused view filtered to `direction: 'promote'` only)

---

## Section 4: History Tab

Rich audit log of all sync operations with expandable detail rows.

### Filters Bar

- **Direction:** SegmentedControl — All | Push | Pull
- **Status:** Filter pills — All | Success | Failed | Conflict
- **Time range:** Select dropdown — Last 7 days | Last 30 days | All time

### History Table

| Column          | Content                                                                             |
| --------------- | ----------------------------------------------------------------------------------- |
| Direction       | Arrow-up icon (push, accent color) or Arrow-down icon (pull, info color) with label |
| Timestamp       | Relative time with full date tooltip                                                |
| Branch          | Branch name badge                                                                   |
| Commit SHA      | 7 chars, clickable (opens on git provider)                                          |
| Status          | Badge: success (green), failed (red), conflict (amber)                              |
| Agents Affected | Count badge, e.g., "3 agents"                                                       |
| Triggered By    | User name or "webhook" label                                                        |

### Expandable Row Detail

Clicking a row expands to show:

- **Changes Summary:** Three columns — Added (green file list) | Modified (amber file list) | Deleted (red file list) — showing file paths
- **Conflict Details** (if status is conflict): Table of conflicted files with resolution outcome (local/remote/merged/unresolved)
- **Error Message** (if status is failed): `ErrorAlert` component with the error string

### Empty State

"No sync history yet. Push or pull to get started."

### Pagination

25 entries per page using Studio's `Pagination` component.

---

## Section 5: Settings Tab

Editable integration settings, exposing the existing `updateGitIntegration` API.

### Repository Section (Read-Only)

`InfoCard` variant `info` showing:

- Provider icon + provider name
- Repository URL (link)
- Connected date

Not editable — to change provider/repo, user must disconnect and reconnect.

### Sync Configuration Section

Editable form using `Section` component:

| Field             | Component          | Notes                                                                  |
| ----------------- | ------------------ | ---------------------------------------------------------------------- |
| Default Branch    | `Select`           | Options: main, staging, production                                     |
| Sync Path         | `Input`            | Subdirectory in repo for ABL files (default `/`)                       |
| Conflict Strategy | `SegmentedControl` | Manual / Local Wins / Remote Wins — with brief description per option  |
| Auto-Sync         | `Toggle`           | "Automatically pull changes when remote branch is updated via webhook" |

When Auto-Sync is enabled, show an `InfoCard` (variant: info): "Requires a webhook to be configured. Changes will be pulled automatically when pushes are detected on the sync branch."

### Webhook Section (Collapsible)

- **Status:** Configured (green `StatusDot`) or Not Configured (gray `StatusDot`)
- **Webhook URL:** Displayed as copyable text field (the callback URL for the git provider)
- **Webhook Secret:** Masked with "Regenerate" button
- **Setup Instructions:** Brief text per provider — "Add this URL as a webhook in your {provider} repository settings"

### Danger Zone

Red-bordered `Section` at the bottom:

- "Disconnect Repository" button (danger variant)
- Opens `ConfirmDialog` explaining: sync history will be preserved but the integration will be removed
- No `TypeToConfirmInput` — disconnecting is reversible (can reconnect)

### Save Action

Inline save button at the bottom of the sync configuration section. Calls `updateGitIntegration()` with changed fields only. `toast.success()` on save.

---

## Section 6: Component Architecture

### Component Tree

```
GitIntegrationTab (orchestrator — tabs, data loading)
+-- GitHeader
|   +-- ConnectionInfo (provider icon, repo URL, branch badge)
|   +-- SyncStatusBar (last sync, commit, changes count, health)
|   +-- PushPreviewDialog (diff list, commit message, PR option)
|   +-- PullPreviewDialog (dry-run preview, validation warnings)
+-- ChangesTab
|   +-- ChangesFilterBar (status filter pills with counts)
|   +-- ChangesTable (per-entity sync status rows)
|   +-- DiffPanel (SlidePanel wrapping DiffViewer)
|   +-- ConflictResolutionPanel (SlidePanel with base/local/remote panes)
+-- PromotionTab
|   +-- PromotionPipeline (3-card horizontal flow with promote buttons)
|   +-- PromoteDialog (confirmation with commit count, PR creation)
|   +-- PromotionHistory (timeline of past promotions)
+-- HistoryTab
|   +-- HistoryFilterBar (direction + status + date filters)
|   +-- HistoryTable (expandable rows with changes/conflict/error detail)
+-- GitSettingsTab
    +-- SyncConfigForm (branch, path, conflict strategy, auto-sync)
    +-- WebhookSection (URL, secret, setup instructions)
    +-- DangerZone (disconnect)
```

### State Management

- New custom hook: `useGitIntegration(projectId)` — manages integration data, loading, refetch triggers
- No Zustand store — hook-based with local state (consistent with Studio's existing settings pattern)
- Push/pull operations return fresh data that triggers refetch of status + history

### Data Flow

1. `GitIntegrationTab` mounts -> `useGitIntegration` fetches integration config
2. If connected -> fetches status (populates sync bar counts)
3. Tab switch -> lazy-loads tab data (history fetched on History tab activation, promotion status on Promotion tab activation)
4. After push/pull -> refetch status + history, update sync bar metrics

### Frontend Type Fixes

The following type mismatches between frontend (`apps/studio/src/api/project-io.ts`) and backend must be corrected:

| Frontend (Current)                                             | Backend (Actual)                                                   | Fix                                                                   |
| -------------------------------------------------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------- |
| `credentials.type: 'pat'`                                      | `credentials.type: 'token'`                                        | Change to `'token'`                                                   |
| `conflictStrategy: 'ours' \| 'theirs'`                         | `conflictStrategy: 'local_wins' \| 'remote_wins'`                  | Change to `'local_wins' \| 'remote_wins'`                             |
| `lastSyncStatus` missing `'conflict'`                          | Backend returns `'conflict'`                                       | Add `'conflict'` to union                                             |
| `GitSyncHistoryEntry.status` missing `'conflict'`              | Backend returns `'conflict'`                                       | Add `'conflict'` to union                                             |
| `GitStatusResponse` only has `localAgents`                     | Backend Task 2 adds `entityStatus[]`, `summary`, `remoteAvailable` | Add new fields to type; `entityStatus` includes both agents and tools |
| `pushToGit` return missing `commitSha`, `changes`              | Backend returns both                                               | Add to return type                                                    |
| `pullFromGit` return missing `commitSha`, `changes`, `preview` | Backend returns all three                                          | Add to return type                                                    |

Note: `pullFromGit` already accepts `dryRun?: boolean` in the request — no change needed there.

**Cascading type changes:** The credential type change from `'pat'` to `'token'` must also be applied to:

- `createGitIntegration()` input type in `project-io.ts`
- The `CREDENTIAL_TYPE_OPTIONS` constant and labels in the setup dialog
- The `SegmentedControl` option values for conflict strategy must change from `'ours'`/`'theirs'` to `'local_wins'`/`'remote_wins'`

### New API Endpoints Required

**1. `GET /api/projects/:id/git/branches/status`** (hosted in Studio, route: `apps/studio/src/app/api/projects/[id]/git/branches/status/route.ts`)

Returns ahead/behind counts for each environment branch relative to its upstream stage. Uses `BranchManager.getBranchStatus()` and `BranchManager.listBranches()` from `packages/project-io/src/git/branch-manager.ts`.

```typescript
// Response
{
  branches: Array<{
    name: string; // 'main' | 'staging' | 'production'
    exists: boolean;
    headSha: string | null;
    headMessage: string | null;
    aheadOf: string | null; // which branch this is compared against
    aheadCount: number;
    behindCount: number;
  }>;
}
```

**2. `POST /api/projects/:id/git/branches/create`** (hosted in Studio)

Creates an environment branch. Uses `BranchManager.createEnvironmentBranch()`.

```typescript
// Request
{ environment: 'staging' | 'production', fromBranch?: string }
// Response
{ success: true, branch: { name: string, sha: string } }
```

**3. Extend sync history with `promote` direction**

Extend the existing `GitSyncHistory` model and `GET /api/projects/:id/git/history` endpoint:

- Add `'promote'` to the `direction` enum in both backend `SyncDirection` type (`packages/project-io/src/types.ts`) and the Mongoose schema (`packages/database/src/models/git-sync-history.model.ts`)
- This is a backward-compatible schema change — existing records only have `'push'`/`'pull'`
- When a promotion occurs, record a history entry with `direction: 'promote'` and metadata about source/target branches and PR URL
- The History tab and Promotion History both query the same endpoint, filtered by direction
- Add `'promote'` to the frontend `GitSyncHistoryEntry.direction` type and the history direction filter

**4. Extend history endpoint with `status` and time-range filters**

Add query parameters to `GET /api/projects/:id/git/history`:

```typescript
// Additional query params (all optional)
?status=success|failed|conflict    // filter by sync status
&since=2026-03-01T00:00:00Z       // filter by start date (ISO 8601)
&until=2026-03-25T23:59:59Z       // filter by end date (ISO 8601)
```

**5. New frontend API client functions** (in `apps/studio/src/api/project-io.ts`):

```typescript
fetchBranchStatus(projectId: string): Promise<BranchStatusResponse>
createEnvironmentBranch(projectId: string, data: { environment: string; fromBranch?: string }): Promise<{ success: boolean; branch: { name: string; sha: string } }>
promoteBranch(projectId: string, data: { from: string; to: string }): Promise<{ success: boolean; data: { fromBranch: string; toBranch: string; commitSha: string } }>
```

The existing `pushToGit`, `pullFromGit`, and `fetchGitHistory` functions need their types updated to match the corrected backend shapes. The existing `promoteBranch` call (`POST /api/projects/:id/git/promote`) already exists in the backend but needs a corresponding frontend API client function added.

### Backend Dependencies

The existing LLD plan (`docs/plans/2026-03-12-git-versioning-sync.md`) Tasks 1-3 must be implemented for the Changes tab to show accurate per-entity status:

- **Task 1:** Add `lastSyncCommit` and `lastSyncSourceHash` fields to `ProjectAgent` and `ProjectTool` models
- **Task 2:** Lockfile comparator + enriched `/git/status` response returning `entityStatus[]` with per-entity sync state and `summary` counts
- **Task 3:** Update sync state on push/pull via `bulkWrite` to `ProjectAgent` and `ProjectTool`

Additionally, the following backend changes are required for this UI redesign:

- **New route:** `GET /api/projects/:id/git/branches/status` — uses `BranchManager` to return environment branch state for the Promotion tab
- **New route:** `POST /api/projects/:id/git/branches/create` — uses `BranchManager` to create environment branches
- **Schema migration:** Add `'promote'` to `SyncDirection` type and `GitSyncHistory` Mongoose schema enum (backward-compatible — existing records unaffected)
- **History endpoint extension:** Add `status` and time-range query parameters to `GET /api/projects/:id/git/history`
- **Enriched status response:** The enriched `/git/status` response (Task 2) must include both agents AND tools in `entityStatus[]`, not just agents

### Existing Components Reused

| Component          | Usage                                                          |
| ------------------ | -------------------------------------------------------------- |
| `Tabs`             | Main tab navigation with Framer Motion animated underline      |
| `Card`             | Connection card, environment branch cards                      |
| `Badge`            | Status badges throughout (sync status, entity status, history) |
| `StatusDot`        | Sync health indicator, webhook status, branch status           |
| `Button`           | Push/Pull actions, promote, save, create branch                |
| `Dialog`           | Push preview, pull preview, promote confirmation               |
| `ConfirmDialog`    | Disconnect repository                                          |
| `SlidePanel`       | Diff viewer, conflict resolution                               |
| `DiffViewer`       | DSL file diffs (local vs remote)                               |
| `DataTable`        | Changes table, history table                                   |
| `Input`            | Commit message, sync path                                      |
| `Select`           | Branch selection, time range filter                            |
| `SegmentedControl` | Conflict strategy, direction filter                            |
| `Toggle`           | Auto-sync switch                                               |
| `Section`          | Settings groupings                                             |
| `InfoCard`         | Auto-sync info, repository info                                |
| `EmptyState`       | No integration, all in sync, no history                        |
| `Pagination`       | History pagination                                             |
| `Skeleton`         | Loading states for each tab                                    |
| `ErrorAlert`       | Failed sync error display                                      |

---

## File Structure

New files to create:

```
apps/studio/src/components/settings/git/
  GitIntegrationTab.tsx       (orchestrator — replaces current monolith)
  GitHeader.tsx               (connection row + sync status bar)
  PushPreviewDialog.tsx       (push dry-run + commit message + PR option)
  PullPreviewDialog.tsx       (pull dry-run preview + confirm)
  ChangesTab.tsx              (per-entity sync status table)
  ChangesFilterBar.tsx        (filter pills with counts)
  DiffPanel.tsx               (SlidePanel wrapping DiffViewer)
  ConflictResolutionPanel.tsx (3-pane base/local/remote)
  PromotionTab.tsx            (pipeline viz + promotion history)
  PromotionPipeline.tsx       (3-card horizontal flow)
  PromoteDialog.tsx           (confirmation dialog)
  HistoryTab.tsx              (audit log table)
  HistoryFilterBar.tsx        (direction + status + date filters)
  GitSettingsTab.tsx          (sync config + webhook + danger zone)
  useGitIntegration.ts        (custom hook for git state management)
  types.ts                    (local types, aligned with backend)
```

The original `GitIntegrationTab.tsx` in `apps/studio/src/components/settings/` will be replaced with a thin re-export from the new `git/` subdirectory.

---

## Out of Scope

- **Auto-sync background execution** — the webhook handler's TODO for BullMQ-based auto-pull remains a backend concern outside this UI redesign
- **Generic git provider** — the stub provider is not surfaced in the UI (provider picker only shows GitHub/GitLab/Bitbucket)
- **Arbitrary branch creation** — users work with predefined environment branches (main/staging/production) and auto-created PR branches only
- **Inline DSL editing in conflict resolution** — users can pick local/remote or open in git provider; no in-browser merge editor
- **Setup dialog redesign** — the existing `SetupDialog` for initial repository connection is retained as-is; only the post-connection experience is redesigned
