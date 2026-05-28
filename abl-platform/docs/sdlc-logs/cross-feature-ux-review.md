# Cross-Feature UX & Design System Review

**Date**: 2026-04-09
**Scope**: Project RBAC LLD + Custom Project Roles + Workspace Management + User Lifecycle Management specs
**Reviewer**: UX Engineer (Opus 4.6)

## Verdict: CONDITIONAL PASS

The four features collectively deliver strong admin-facing functionality, and the specs demonstrate good awareness of existing UI patterns. However, the features suffer from **fragmented information architecture** (member management scattered across 3 separate surfaces), **inconsistent component patterns** across features, and **missing cross-feature UX flows**. With the recommended simplifications, the set can ship cleanly.

---

## Information Architecture Map

```
Studio Navigation (current + proposed)
========================================

WORKSPACE LEVEL (admin area, /admin/*)
  |
  +-- Members (/admin/members)         <-- EXISTING: MembersPage.tsx
  |   |                                    ENHANCED: User Lifecycle adds status badges,
  |   |                                    summary cards, search, filter, pagination,
  |   |                                    bulk ops, CSV invite
  |   |
  |   (User Lifecycle Management lives here)
  |
  +-- Roles (/admin/roles)             <-- NEW: Custom Project Roles management
  |   |                                    Tenant-scoped custom role CRUD
  |   |                                    Permission matrix editor
  |   |
  |   (Custom Project Roles lives here)
  |
  +-- Settings (/admin/settings)       <-- NEW: User Lifecycle adds settings section
  |   |                                    (defaultRole, inviteExpiryDays, emailNotifications)
  |   |
  |   (User Lifecycle configurable settings live here)
  |
  +-- [existing: Models, Security, Secrets, KMS, Billing, Connectors, ...]
  |
  +-- Workspace Settings               <-- NEW: Workspace Management adds this
      (/settings/workspace)                (rename, slug, retention, deletion)

PROJECT LEVEL (settings area, /project/settings/*)
  |
  +-- Members (settings-members)       <-- EXISTING: ProjectMembersTab.tsx (stub)
  |   |                                    REPLACED: Project RBAC adds full CRUD,
  |   |                                    bulk ops, permission matrix panel
  |   |
  |   (Project RBAC Management lives here)
  |
  +-- [existing: API Keys, Models, Config Vars, Git, Advanced, Runtime, ...]

USER MENU (top-right dropdown)
  |
  +-- Workspace Switcher               <-- EXISTING: UserMenu.tsx
      |                                    ENHANCED: Workspace Management adds favorites,
      |                                    search, default indicator, member count,
      |                                    create-workspace button
```

---

## CRITICAL UX Findings

### C-1. Fragmented Member Management -- Three Separate Surfaces

**Severity**: CRITICAL
**Location**: All four specs

A workspace admin managing team access must navigate three distinct surfaces:

1. **Workspace Members** (`/admin/members`) -- invite, role change, remove, lock/suspend (User Lifecycle)
2. **Project Members** (`/project/settings/members`) -- add to project, assign project role, remove from project (Project RBAC)
3. **Custom Roles** (`/admin/roles`) -- create roles, edit permissions, assign via project members (Custom Roles)

**The mental model is broken.** A common admin task -- "Add Alice to the team, give her a custom QA role, and add her to 3 projects" -- requires visiting 3 different pages in 3 different navigation areas. There is no unified "member management" experience.

**Recommended Fix**: Consider a unified "People" section at the workspace level that combines workspace members + a "Projects" column showing which projects each member belongs to + quick-assign for project roles. At minimum, add cross-links: the workspace members page should show a "Projects" column or expandable row showing which projects each member is in; the project members page should link back to the workspace member profile.

### C-2. Workspace Settings Route Collision

**Severity**: CRITICAL
**Location**: Workspace Management spec (Section 6) vs User Lifecycle spec (Section 8)

Workspace Management specifies a new page at `/settings/workspace` for rename, slug, retention, deletion. User Lifecycle specifies workspace-level settings at `/admin/settings` for defaultRole, inviteExpiryDays, emailNotifications. These are **different routes in different navigation areas** for what should be a single "Workspace Settings" page.

- Workspace Management uses a project-level `settings` area prefix (`/settings/workspace`)
- User Lifecycle uses the admin area (`/admin/settings`)
- The existing `NavigationArea` type (`navigation-store.ts:15`) has `'admin'` and `'settings'` as separate areas

**Recommended Fix**: Consolidate all workspace-level settings into a single page. The natural home is the admin area, e.g., `/admin/workspace-settings` or add a "Workspace" tab to the existing admin area. The `/settings/workspace` path is confusing because `/settings/*` in the codebase is project-scoped (`ProjectSettingsPage.tsx`).

### C-3. Locked User Experience Undefined

**Severity**: CRITICAL
**Location**: User Lifecycle spec (FR-2, FR-3)

The spec defines that locked/suspended users get HTTP 403 with `MEMBER_SUSPENDED` or `MEMBER_LOCKED`, but **no spec describes what the locked user sees in the UI**. Current codebase (`UserMenu.tsx`, auth flows) has no locked-user screen.

Questions unaddressed:

- Does the user see a generic "Access Denied" page or a specific "Your account has been suspended by your workspace admin" message?
- Can they still switch to other workspaces where they are active?
- Does the workspace switcher still show the locked workspace (with a "locked" indicator) or hide it?
- If locked across ALL workspaces (via failed login trigger), what is the landing page?

**Recommended Fix**: Add a "Restricted Access" screen specification. When auth middleware returns 403 with `MEMBER_SUSPENDED`/`MEMBER_LOCKED`, Studio should show a specific page explaining the restriction, with workspace switcher access preserved (so users can switch to workspaces where they are active).

---

## HIGH UX Findings

### H-1. Inconsistent Role Badge Color Mapping

**Severity**: HIGH
**Location**: `ProjectMembersTab.tsx` vs `MembersPage.tsx` vs Custom Project Roles spec

The existing codebase has two different badge color mappings for roles:

**ProjectMembersTab.tsx (line 77-82)**:

```
OWNER: 'success' (green)
ADMIN: 'info' (blue)
OPERATOR: 'warning' (amber)
VIEWER: 'default' (gray)
```

**MembersPage.tsx (line 59-65)**:

```
OWNER: 'accent' (brand)
ADMIN: 'purple'
OPERATOR: 'warning' (amber)
MEMBER: 'default' (gray)
VIEWER: 'info' (blue)
```

The LLD (Phase 3, task 3.2) proposes yet another mapping: `admin=info, developer=warning, tester=secondary, viewer=default`.

Three different color schemes for role badges across three surfaces is a design system violation. Users will associate colors with roles inconsistently.

**Recommended Fix**: Define a single canonical `ROLE_BADGE_VARIANT` mapping in a shared location (e.g., a `role-display-utils.ts` in the Studio lib) and use it everywhere. The tenant-level `MembersPage.tsx` mapping is the most complete (covers all 5 workspace roles) -- extend it to cover the 4 project roles (admin, developer, tester, viewer) using the same design intent: most-privileged = accent, least-privileged = default.

### H-2. Project RBAC "Add Member" UX Not Specified Clearly

**Severity**: HIGH
**Location**: Project RBAC LLD, Phase 3, Task 3.2

The LLD says "Button opens a dropdown/modal that shows available tenant members" but does not specify which approach. The codebase has both patterns:

- `SearchableSelect` -- dropdown with search (good for selecting from a list)
- `SlidePanel` -- side drawer (good for complex forms)
- `Dialog` -- centered modal (good for focused tasks)

For adding project members, the admin needs to:

1. See available members (with name, email, workspace role)
2. Select one or more
3. Assign a role (default: developer)
4. Confirm

This is too complex for a dropdown but overkill for a full SlidePanel. A `Dialog` with a `SearchableSelect` for member selection + role dropdown is the right pattern (matches the existing invite form in `MembersPage.tsx`).

**Recommended Fix**: Specify a Dialog-based "Add Member" flow. Use the existing `Dialog` component with a `SearchableSelect` for member selection (populated from the `/available` endpoint). Include role selector with default `developer`. Include an "Add another" button for batch. This is consistent with the invite form pattern in `MembersPage.tsx`.

### H-3. Bulk Action Bar is a New Pattern -- Not Established in Studio

**Severity**: HIGH
**Location**: Project RBAC LLD (Phase 3, D-13), User Lifecycle spec (Section 6)

Both specs call for multi-select checkboxes with a floating bulk action toolbar (select rows, toolbar appears at bottom with "Change Role", "Remove", etc.). This pattern does **not exist anywhere in the current Studio codebase**. The existing `DataTable` component has no checkbox/selection support. The existing `Checkbox` component exists but has never been used in table rows.

Introducing this pattern in TWO features simultaneously (project members + workspace members) risks inconsistent implementations.

**Recommended Fix**: Build a reusable `SelectableDataTable` component (extending `DataTable` with selection state and bulk action bar) BEFORE implementing either feature. Define the component contract once, then both features use it identically. The bulk action bar should be a sticky bottom bar with selected count, action buttons, and a "Deselect all" control. This is the pattern used by Linear, Notion, and GitHub -- a well-established convention.

### H-4. Workspace Deletion Confirmation Uses `TypeToConfirmInput` But Spec Doesn't Reference It

**Severity**: HIGH
**Location**: Workspace Management spec (FR-10)

FR-10 says "the user must re-type the workspace name in a confirmation dialog before archiving." The codebase already has `TypeToConfirmInput.tsx` -- a purpose-built component for exactly this pattern (type-to-confirm destructive actions). The spec does not reference this component.

Meanwhile, the Project RBAC LLD (Phase 3, task 3.2) references a "Confirmation dialog before removal" for member removal, which should use the existing `ConfirmDialog.tsx` component (simpler yes/no confirmation).

**Recommended Fix**: Workspace deletion should explicitly use `TypeToConfirmInput` (for type-to-confirm the workspace name) inside a `Dialog`. Member removal should use `ConfirmDialog`. Custom role deletion (if members assigned, blocked; if no members, simple `ConfirmDialog`). Standardize: `TypeToConfirmInput` for irreversible destructive actions (workspace delete), `ConfirmDialog` for reversible actions (remove member, delete unassigned role).

### H-5. No Cross-Feature Status Propagation in UI

**Severity**: HIGH
**Location**: User Lifecycle + Project RBAC interaction

When a workspace member is locked/suspended (User Lifecycle), none of the specs address what happens in the Project Members UI:

- Does the locked user appear in the project members list with a "locked" badge?
- Can a project admin still change a locked member's role?
- Does the "available members" endpoint for project member addition include locked members?
- When adding a member to a project, should suspended/locked workspace members be excluded?

**Recommended Fix**: The project members list should show a status indicator (via Badge with `error` variant for locked, `warning` for suspended) next to any member whose workspace status is not `active`. The "available members" endpoint should exclude non-active workspace members. Project role changes should still be allowed for locked/suspended members (they take effect when the member is reactivated).

### H-6. Custom Roles Permission Matrix -- Large Grid at Small Viewports

**Severity**: HIGH
**Location**: Custom Project Roles spec (Section 6)

The spec defines a permission matrix with 11 modules x 4 access levels (Full/Custom/View/No Access). This is a 44-cell grid. At small viewports (< 768px), this matrix becomes unusable.

The existing Studio `DataTable` handles horizontal overflow via `overflow-x-auto`, but the permission matrix is not a standard table -- it is a specialized grid where rows are modules and columns are access levels.

**Recommended Fix**: Use a responsive pattern for the permission matrix:

- Desktop (>= 1024px): Full grid layout (modules as rows, access levels as segmented buttons per row)
- Tablet (768-1023px): Collapsible accordion per module, each expanding to show the 4 access level options
- Mobile (< 768px): Vertical stack -- each module as a card with radio buttons for access level

The existing `SegmentedControl` component is ideal for the access level selector per module.

---

## MEDIUM UX Findings

### M-1. Workspace Switcher Search Threshold Hardcoded

**Severity**: MEDIUM
**Location**: Workspace Management spec (FR-3, Section 11)

The spec defines `SWITCHER_SEARCH_THRESHOLD = 5` (show search when user has 5+ workspaces). The current switcher (`UserMenu.tsx`) uses a compact `max-h-48` scrollable area. Adding a search input at the top of an already-small dropdown (within a 264px-wide menu) will compress the visible workspace list to ~3 items.

**Recommended Fix**: When the search input is shown, increase the `max-h` to `max-h-64` or `max-h-72` to maintain visibility of at least 5 workspace items after the search input. Consider expanding the entire workspace section into a `Dialog` or `SlidePanel` when the user has 10+ workspaces, rather than cramming everything into the dropdown.

### M-2. Dashboard Summary Cards -- MetricCard vs Custom Component

**Severity**: MEDIUM
**Location**: User Lifecycle spec (Section 6, Section 10)

The spec calls for "Summary cards at top: Total Members, Active, Suspended, Locked (with counts and color-coded indicators)." The existing `MetricCard` component (`components/ui/MetricCard.tsx`) is designed for exactly this -- it supports `label`, `value`, `icon`, `context`, and `trend`.

The spec proposes creating a new `MemberSummaryCards.tsx` component. This should reuse `MetricCard` rather than building custom cards.

**Recommended Fix**: Use `MetricCard` for the summary cards. Map statuses to semantic intents: Active = success icon, Suspended = warning icon, Locked = error icon. Total = default. This is consistent with the existing analytics dashboard cards.

### M-3. Missing Keyboard Shortcuts

**Severity**: MEDIUM
**Location**: All four specs

The existing Studio has keyboard shortcuts (the user menu shows "G A" for admin). None of the four specs define keyboard shortcuts for common operations:

- Select all members (Ctrl/Cmd+A when in member list)
- Deselect all (Escape)
- Open add-member dialog (Ctrl/Cmd+I for "invite" or Ctrl/Cmd+K for command palette)
- Navigate between workspace members and project members

**Recommended Fix**: Add keyboard shortcut support in Phase 2 (after core functionality works). Minimum: Escape to deselect, Ctrl/Cmd+A to select all visible, keyboard navigation in tables (arrow keys).

### M-4. No Empty State for Custom Roles

**Severity**: MEDIUM
**Location**: Custom Project Roles spec (Section 6)

The spec describes the role list table view but does not address the empty state when no custom roles exist yet (only system roles). The existing `EmptyState` component provides a consistent pattern for this.

**Recommended Fix**: When no custom roles exist, show an `EmptyState` component below the system roles table: "No custom roles yet. Create a custom role to define granular permissions beyond the built-in roles." with a "Create Role" primary action button.

### M-5. Screen Reader Announcement for Status Transitions

**Severity**: MEDIUM
**Location**: User Lifecycle spec (Section 6)

Status changes (lock, suspend, activate, unlock) are visual-only in the current specs. No ARIA live region or screen reader announcement is specified.

**Recommended Fix**: When a status transition succeeds, the success banner should use `role="alert"` or `aria-live="polite"` to announce the change to screen readers. The existing success banner in `MembersPage.tsx` (line 364-368) does not have this attribute -- it should be added globally.

### M-6. Workspace Favorite Star Toggle Missing from Design Spec

**Severity**: MEDIUM
**Location**: Workspace Management spec (Section 6)

The spec says "Favorites section should appear above a visual divider, with a star/pin icon toggle per workspace" but does not specify the interaction pattern. Is the star toggle:

- Always visible on hover? (like Gmail star)
- Always visible? (clutters the compact switcher)
- A right-click context menu action?

**Recommended Fix**: Show the star toggle on hover for non-favorite workspaces, and always show a filled star for favorited workspaces. Use `lucide-react` `Star` (outline) / `Star` (filled with `fill="currentColor"`). The star should be positioned to the right of the workspace name, replacing the current `Check` icon position for the active workspace. A workspace can be both "current" (Check) and "favorite" (Star) -- show both icons.

---

## Per-Feature Complexity Assessment

### Project RBAC Management

- **New components**: 3 (ProjectMembersTab rewrite, PermissionMatrixPanel, API client)
- **New routes**: 8 (members CRUD, available, 3 bulk ops, permissions)
- **Complexity**: High -- most new API surface area, bulk operations, multi-select UI
- **Simplification opportunities**:
  - Defer bulk operations to Phase 2. Single add/remove/role-change covers 80% of use cases. Bulk is important but can land 2 weeks later.
  - Defer the PermissionMatrixPanel (read-only informational) -- it is nice-to-have and does not gate any workflow.
  - The `tester` role addition (D-12) could be deferred since custom roles will subsume it.

### Custom Project Roles

- **New components**: 3 (role list page, create/edit form with permission matrix, role dropdown in member editor)
- **New routes**: 6 (CRUD + duplicate, all tenant-scoped)
- **Complexity**: Medium -- the permission matrix editor is the most complex UI element
- **Simplification opportunities**:
  - Defer the `Custom` access level. Start with only Full/View/No Access per module (3 levels instead of 4). "Custom" (selected operations) requires a nested UI for picking individual operations -- significant complexity.
  - Defer parent role inheritance (`parentRoleId`). Start with flat custom roles. Inheritance adds cycle-guard complexity and parent-chain resolution UX.
  - Defer the duplicate-role API. Copy-paste of permission sets can be done manually in v1; the API adds marginal value.

### Workspace Management v1.0 Parity

- **New components**: 2 (workspace settings page, enhanced switcher)
- **New routes**: 4 (preferences, workspace PATCH/DELETE, restore)
- **Complexity**: Medium -- the switcher enhancement is UI-heavy but the settings page is straightforward
- **Simplification opportunities**:
  - Defer the 30-day grace period permanent deletion cascade. Start with archive-only (soft delete). The permanent deletion job and its 100+ collection cascade is a separate infrastructure concern.
  - Defer favorites. Default workspace + search covers the primary pain point. Favorites add state management complexity for marginal benefit when search exists.
  - Defer slug editing. Name editing is low-risk; slug editing triggers URL changes, requires confirmation dialogs, and has downstream implications (bookmarks, API integrations).

### User Lifecycle Management

- **New components**: 4 (MemberSummaryCards, BulkInviteDialog, MemberStatusBadge, settings section)
- **New routes**: 10 (suspend/activate/lock/unlock per member, bulk invite, bulk role/remove, settings GET/PATCH)
- **Complexity**: High -- email infrastructure (7 new templates), Redis caching, auth middleware changes, CSV parsing
- **Simplification opportunities**:
  - Defer CSV bulk invite. JSON bulk invite covers the API use case; CSV is a UI convenience that adds parsing, validation, and error-reporting complexity.
  - Defer email notifications entirely for v1. Status changes + audit logging provide the traceability. Email templates for 7 event types is significant scope.
  - Defer `lastActiveAt` tracking. It adds write amplification on every authenticated request (even throttled to 1/min) for a field that is only used for informational display.
  - Defer configurable workspace settings (defaultRole, inviteExpiryDays, emailNotifications). Use hardcoded defaults for v1. Configuration adds a settings UI, API endpoints, and Tenant model changes.

---

## Cross-Feature UX Flows

### Flow 1: "Onboard a New Team Member" (current plan: 7+ steps across 3 features)

```
Step 1: /admin/members      -- Invite Alice via email (User Lifecycle)
Step 2: (email)             -- Alice accepts invitation
Step 3: /admin/members      -- Verify Alice is active (User Lifecycle)
Step 4: /admin/roles        -- Create "QA Lead" custom role (Custom Roles) [if needed]
Step 5: /project/settings   -- Navigate to project settings
Step 6: /project/settings   -- Add Alice as project member (Project RBAC)
Step 7: /project/settings   -- Assign custom role to Alice (Project RBAC + Custom Roles)
```

**Click count**: 12-15 clicks minimum. The admin must navigate between workspace admin area and project settings area twice.

**Recommendation**: After accepting an invitation, show a "Quick Setup" dialog: "Alice has joined. Add her to projects now?" with a multi-project selector and role assignment. This reduces the flow to 3 steps.

### Flow 2: "Investigate and Restrict a Compromised Account" (3+ steps)

```
Step 1: /admin/members      -- Find the user (search by name)
Step 2: /admin/members      -- Lock the user
Step 3: (automatic)         -- Refresh tokens revoked, 403 on next request
Step 4: /admin/members      -- Verify the user is locked
```

**Click count**: 4-5 clicks. This flow is well-designed -- single surface, immediate effect (within 30s cache TTL).

### Flow 3: "Create a New Project with a Team" (7+ steps)

```
Step 1: /projects           -- Create new project
Step 2: /project/settings   -- Navigate to project settings > members
Step 3: /project/settings   -- Add member 1 (from available workspace members)
Step 4: /project/settings   -- Add member 2
Step 5: /project/settings   -- Add member 3
Step 6: (optional)          -- Bulk add remaining members
Step 7: /project/settings   -- Assign custom roles
```

**Recommendation**: After project creation, show a "Team Setup" step: "Add team members now?" with the available-members picker and role selector. Auto-created admin membership for the creator is already handled (D-2).

### Flow 4: "Delete a Workspace" (5 steps)

```
Step 1: /settings/workspace  -- Navigate to workspace settings
Step 2: /settings/workspace  -- Scroll to danger zone
Step 3: /settings/workspace  -- Click "Delete workspace"
Step 4: Dialog               -- Type workspace name to confirm
Step 5: Dialog               -- Confirm deletion
```

**Click count**: 5 clicks. Well-designed -- single surface with proper destructive action safeguards using `TypeToConfirmInput`.

---

## Design System Recommendations

### New Shared Components Needed

1. **`SelectableDataTable`** -- Extends `DataTable` with checkbox selection, select-all, and a sticky bulk action bar. Both Project RBAC and User Lifecycle need this.

2. **`StatusBadge`** -- Semantic wrapper around `Badge` for user/member statuses. Maps `active` to `success` variant, `suspended` to `warning`, `locked` to `error`. Both User Lifecycle (workspace members) and Project RBAC (project members showing cross-feature status) need this.

3. **`RoleBadge`** -- Semantic wrapper around `Badge` for role display. Defines the canonical role-to-variant mapping once. Both workspace and project member surfaces need this.

4. **`PermissionGrid`** -- Specialized grid component for the permission matrix. Used by both Custom Project Roles (editable) and Project RBAC PermissionMatrixPanel (read-only, with a `readonly` prop).

### Tokens to Define

- No new design tokens needed. All four features can use existing semantic tokens (`success`, `warning`, `error`, `info`, `accent`, `purple`).
- Consider adding `locked` and `suspended` as intent aliases in `packages/design-tokens/src/intents.ts` mapping to `error` and `warning` respectively, for semantic clarity.

### Reusable Patterns to Establish

- **Member Row Pattern**: Avatar (using existing `Avatar` component) + name + email + role badge + status badge + action buttons. This pattern appears in `MembersPage.tsx`, `ProjectMembersTab.tsx`, and the custom roles "members using this role" display. Extract as a `MemberRow` sub-component.

- **Summary Bar Pattern**: A horizontal row of `MetricCard` components at the top of a list page, showing aggregate counts. Used by both User Lifecycle (active/suspended/locked counts) and Project RBAC (by-role counts). Establish as a `SummaryBar` layout component that wraps N `MetricCard` instances in a responsive grid.

---

## Recommended UX Simplifications

### Tier 1 -- Cut for v1 (significant complexity, low user value)

1. **CSV bulk invite** (User Lifecycle) -- JSON bulk is sufficient. CSV adds parsing, validation, error UX, and drag-and-drop complexity.
2. **Custom access level in permission matrix** (Custom Roles) -- Full/View/No Access covers 90% of use cases. "Custom" requires a nested operation picker.
3. **Parent role inheritance** (Custom Roles) -- Flat roles first. Inheritance adds cycle guards, parent-chain UX, and cascading change complexity.
4. **Permanent deletion cascade job** (Workspace Management) -- Archive (soft delete) is sufficient for v1. The 30-day cascade job touching 100+ collections is infrastructure, not UX.
5. **Email notification templates** (User Lifecycle) -- Defer all 7 new email templates. Status changes + audit logging provide traceability. Emails can be added later without any data model changes.
6. **Slug editing** (Workspace Management) -- URL changes have downstream implications. Defer to v2.

### Tier 2 -- Defer to v1.1 (nice-to-have, clean enhancement later)

1. **Workspace favorites** (Workspace Management) -- Default workspace + search cover the primary pain point.
2. **PermissionMatrixPanel read-only display** (Project RBAC) -- Informational only, does not gate any workflow.
3. **Duplicate role API** (Custom Roles) -- Manual copy of permission sets works for the small number of custom roles expected in v1.
4. **`lastActiveAt` tracking** (User Lifecycle) -- Write amplification concern for informational data.
5. **Configurable workspace settings** (User Lifecycle) -- Use hardcoded defaults (7-day invite expiry, MEMBER default role, notifications on).

### Tier 3 -- Must have for v1

1. Project member CRUD (single add/remove/role-change) with listing filter
2. Workspace member lock/suspend/activate/unlock with status badges
3. Custom role CRUD with Full/View/No Access permission levels (flat, no inheritance)
4. Workspace default designation + enhanced switcher with search + member count
5. Workspace archive (soft delete) with type-to-confirm
6. Workspace settings page (name edit, retention edit)
7. Backfill existing project owners to ProjectMember records

This tier 3 set is achievable as a coherent, ship-ready v1 without the complexity of tiers 1 and 2.
