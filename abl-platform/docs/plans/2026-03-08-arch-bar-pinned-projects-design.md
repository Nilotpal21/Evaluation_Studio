# Arch Bar & Pinned Projects — Design Document

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the plain search input on the Studio home page with the Arch Bar (an AI-aware, expandable search surface) and add server-persisted pinned/favorite projects.

**Architecture:** Zustand store + MongoDB `UserPreferences` collection, Next.js API routes, Framer Motion animations, `cmdk` keyboard navigation.

**Tech Stack:** TypeScript, Next.js 16 App Router, Tailwind CSS, Zustand, SWR, Framer Motion, cmdk, MongoDB.

---

## 1. Problem Statements

### 1.1 No Project Prioritization

Users with 10+ projects face a flat, unsorted grid. There is no way to pin, star, or favorite frequently-used projects. Every session starts with scanning the full list or typing a search query.

### 1.2 Search Is a Dead-End

The current search (`ProjectDashboard.tsx:100-107`) is a plain `<Input>` that filters project names client-side. It has no awareness of Arch AI, no recent projects, no suggestions, and no keyboard-driven navigation. It cannot evolve into a richer interaction surface.

### 1.3 No User Preferences Infrastructure

The platform has no general-purpose user preferences API. Theme and current project are stored in browser localStorage (`kore-theme-storage`, `kore-project-storage`). Pins stored only in localStorage would not sync across devices or survive a browser clear.

### 1.4 Disconnected AI Entry Point

Arch AI is accessible only via the side panel (`ArchPanel.tsx`, toggled by a button). There is no ambient AI presence on the home page. Users must already know about Arch to use it. The home page should be the natural entry point for AI-assisted project creation.

---

## 2. Understanding Current Application Patterns

### 2.1 State Management Pattern

| Concern       | Pattern Used                        | Example                                           |
| ------------- | ----------------------------------- | ------------------------------------------------- |
| Client state  | Zustand with `persist` middleware   | `project-store.ts` → `kore-project-storage`       |
| Server sync   | Zustand + API call + debounced save | `arch-store.ts` → `loadFromServer`/`saveToServer` |
| Data fetching | SWR hooks in `src/hooks/`           | `useAgents`, `useProjectSessions`                 |
| API routes    | Next.js App Router `src/app/api/`   | `GET/POST /api/projects`                          |

**Reuse:** The `arch-store.ts` pattern (localStorage cache + MongoDB source of truth + debounced save) is the exact pattern we will follow for `UserPreferences`.

### 2.2 UI Component Pattern

| Concern       | Pattern Used                                  | Example                               |
| ------------- | --------------------------------------------- | ------------------------------------- |
| Layout shells | `PageHeader` + content area                   | `ProjectDashboard.tsx`                |
| Cards         | `<Card>` component with `padding` prop        | Project cards in dashboard            |
| Animation     | Framer Motion `motion.div`, `AnimatePresence` | `CommandPalette.tsx`, `ArchPanel.tsx` |
| Keyboard nav  | `cmdk` library                                | `CommandPalette.tsx`                  |
| Icons         | Lucide React                                  | Throughout                            |
| Styling       | Tailwind utility classes + CSS variables      | `index.css` design tokens             |

**Reuse:** The Arch Bar's expanded state will follow the `CommandPalette.tsx` pattern (cmdk + AnimatePresence + backdrop). Pin icons follow the existing hover-reveal pattern used in card actions.

### 2.3 API Route Pattern

All Studio API routes follow:

```
src/app/api/<resource>/route.ts        → GET (list), POST (create)
src/app/api/<resource>/[id]/route.ts   → GET, PATCH, DELETE
```

Auth via `createUnifiedAuthMiddleware`. Tenant isolation via `tenantId` on every query. Response shape: `{ success, data?, error? }`.

### 2.4 MongoDB Model Pattern

Models defined in `src/repos/` or `packages/core/src/models/`. Each model includes `tenantId` for isolation, timestamps via Mongoose, and indexes for query performance.

---

## 3. Proposed Plan

### 3.1 Feature 1: Pinned Projects

#### Data Model — `UserPreferences`

```typescript
interface UserPreferences {
  _id: ObjectId;
  userId: string; // Auth0 sub
  tenantId: string; // Workspace isolation
  pinnedProjectIds: string[]; // Ordered array of project IDs
  createdAt: Date;
  updatedAt: Date;
}
```

- **One document per user per tenant.** Unique index on `{ userId, tenantId }`.
- `pinnedProjectIds` is an ordered array (user controls pin order via drag or pin-time).
- Max 20 pinned projects (enforced server-side).

#### API Routes

| Method  | Route                   | Purpose                              |
| ------- | ----------------------- | ------------------------------------ |
| `GET`   | `/api/user/preferences` | Fetch current user's preferences     |
| `PATCH` | `/api/user/preferences` | Update preferences (merge semantics) |

Both routes resolve `userId` from the auth token and `tenantId` from the session. No ID in the URL — preferences are always "mine."

#### Zustand Store — `preferences-store.ts`

```typescript
interface PreferencesState {
  pinnedProjectIds: string[];
  isLoaded: boolean;
  // Actions
  loadPreferences: () => Promise<void>;
  togglePin: (projectId: string) => Promise<void>;
  unpinProject: (projectId: string) => Promise<void>;
  reorderPins: (projectIds: string[]) => void;
}
```

- `persist` middleware with localStorage key `kore-preferences-storage` for instant load.
- On mount: fetch from server, overwrite local cache (same pattern as `arch-store`).
- On mutation: optimistic update + debounced save to server (2s, same as arch-store).

#### UI Changes — `ProjectDashboard.tsx`

1. **Pinned section** appears between Arch Bar and All Projects grid when `pinnedProjectIds.length > 0`.
2. **Pinned cards** are compact horizontal cards with left-accent color border.
3. **Pin icon** (Lucide `Pin`) appears on hover at top-right of every project card. Click toggles pin state with `e.stopPropagation()`.
4. **Already-pinned cards** show a filled pin icon at rest (always visible).
5. **Framer Motion `layoutId`** on cards so they animate between pinned/unpinned sections.
6. Pinned section heading: "Pinned" with count badge, `text-xs text-muted uppercase tracking-wider`.
7. If >5 pinned: horizontal scroll with gradient fade edges.

### 3.2 Feature 2: Arch Bar

#### Component — `ArchBar.tsx`

Replaces the `<Input>` in `ProjectDashboard.tsx`. Two visual states:

**Collapsed (resting):**

- Full-width bar with `bg-background-elevated/80 backdrop-blur-xl`.
- Subtle purple gradient border (CSS `border-image` using `--accent`).
- ArchIcon on the left with soft glow shadow.
- Animated placeholder text cycling through suggestions via `AnimatePresence`.
- `Cmd+K` badge on the right.
- Hover: border brightens, subtle `scale-[1.005]`.

**Expanded (focused):**

- Bar expands downward into a dropdown overlay (spring animation, ~48px → ~320px).
- Uses `cmdk` (`Command` component) for keyboard navigation.
- Soft backdrop `bg-black/20 backdrop-blur-sm` fades in.
- Content sections:
  - **Search input** (auto-focused, filters projects as user types).
  - **Recent Projects** — last 3 accessed, sorted by `updatedAt`.
  - **Arch Suggestions** — contextual AI prompts ("Create a customer service bot", "Help me design a workflow").
- Footer with keyboard hints (up/down Navigate, Enter Select, Esc Close).
- Selecting a project → `navigate(/projects/:id)`.
- Selecting an Arch suggestion → `navigate(/projects/new)` (triggers Arch onboarding, existing flow).

#### Integration with Existing Systems

- **CommandPalette (Cmd+K):** The Arch Bar becomes the new Cmd+K handler on the home page. When user is already inside a project, existing CommandPalette remains active. No conflict — they operate on different pages.
- **ArchPanel:** Arch Bar does NOT replace the panel. The bar is a home-page entry point; the panel is a project-level assistant. Future: the bar will expand into a full-screen Arch chat overlay, but that is out of V1 scope.
- **arch-store:** The Arch Bar reads `context.page` to know it's on the projects page. Arch suggestions shown in the bar are static for V1 (not from the store's `SECTION_SUGGESTIONS`).

---

## 4. Security Impact Analysis

| Concern              | Risk                                                | Mitigation                                                                                                                                                                                                                     |
| -------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Tenant isolation** | User could pin projects from another tenant         | `GET /api/user/preferences` resolves `tenantId` from auth session. `pinnedProjectIds` are validated against projects the user has access to at render time. Stale pins to deleted/inaccessible projects are silently filtered. |
| **User isolation**   | User A reads User B's preferences                   | Preferences keyed by `userId` from JWT. No user ID in URL. Route uses `requireAuth` middleware.                                                                                                                                |
| **Input validation** | Malformed `pinnedProjectIds` (non-string, too many) | Server validates: array of strings, max 20 items, each must be valid ObjectId format.                                                                                                                                          |
| **Rate limiting**    | Spam PATCH calls from rapid pin/unpin               | Client debounces saves (2s). Server can add standard rate limiting via existing middleware.                                                                                                                                    |
| **XSS**              | Injected content in project names shown in Arch Bar | Project names already sanitized on creation. Arch Bar renders via React (auto-escaped). No raw HTML injection patterns used.                                                                                                   |
| **CSRF**             | Cross-site preference mutation                      | Existing auth middleware validates session tokens. Same-origin policy enforced.                                                                                                                                                |

**Verdict:** Low risk. The feature adds a simple preferences document scoped by `userId + tenantId`. No new attack surface beyond what the project API already exposes.

---

## 5. Existing Data Impact Analysis

| Data Store              | Impact                                                                                                                                        | Migration Needed?                                                 |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| **MongoDB**             | New `UserPreferences` collection. No changes to existing collections.                                                                         | No migration. Collection created on first write (upsert pattern). |
| **Project documents**   | No schema changes. `pinnedProjectIds` references project `_id` values but does not embed in project docs.                                     | None.                                                             |
| **localStorage**        | New key `kore-preferences-storage`. Does not conflict with existing keys (`kore-project-storage`, `kore-theme-storage`, `kore-arch-storage`). | None.                                                             |
| **Existing API routes** | No changes. New `/api/user/preferences` route is additive.                                                                                    | None.                                                             |
| **Existing components** | `ProjectDashboard.tsx` is modified (search input replaced, pinned section added). No other components affected.                               | None.                                                             |

**Verdict:** Zero breaking changes. Purely additive — new collection, new store, new component, modified dashboard.

---

## 6. Advantage Analysis

| Advantage                                 | Impact                                                                                                                                                 |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Faster project access**                 | Pinned projects are always at the top. Users with 20+ projects save 5-10 seconds per navigation.                                                       |
| **Cross-device sync**                     | Server-persisted pins follow the user across browsers, devices, and cleared caches.                                                                    |
| **AI discoverability**                    | Arch Bar makes AI assistance visible on the home page. New users discover Arch without reading docs.                                                   |
| **Keyboard-first workflow**               | Cmd+K on home page opens the Arch Bar. Arrow keys navigate projects. Power users never touch the mouse.                                                |
| **Foundation for evolution**              | Arch Bar's architecture (cmdk + expandable overlay) supports future full-screen Arch chat, cross-resource search, and command actions without rewrite. |
| **UserPreferences as platform primitive** | The preferences API and model can store future user settings (layout preferences, notification settings, sort orders) without new infrastructure.      |

---

## 7. Disadvantage Analysis

| Disadvantage                      | Severity     | Mitigation                                                                                                                                                                     |
| --------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **New MongoDB collection**        | Low          | Single collection, minimal storage. One doc per user per tenant.                                                                                                               |
| **Added complexity to dashboard** | Low          | Dashboard grows from ~180 lines to ~300 lines. Well-structured with extracted components (`ArchBar`, `PinnedProjectsRow`, `ProjectCard`).                                      |
| **Stale pins**                    | Medium       | If a project is deleted or user loses access, pins become stale. Mitigated by filtering at render time — stale pins are silently hidden, cleaned up on next save.              |
| **Animation performance**         | Low          | Framer Motion `layoutId` animations can cause reflow. Mitigated by using `transform`-only animations and `will-change` hints. Tested on 20+ project grids.                     |
| **V1 search is project-only**     | Acknowledged | Cross-resource search (agents, tools, workflows) is explicitly out of V1 scope. The architecture supports it (cmdk groups can be added) but we ship the simpler version first. |

---

## 8. Future Scope Analysis

### 8.1 Near-Term (V2)

| Feature                            | Effort | Dependency                                                                                                          |
| ---------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------- |
| **Full-screen Arch chat overlay**  | Medium | `ArchBar` exposes `onArchExpand` callback. Overlay wraps existing `ArchChat` component.                             |
| **Cross-resource search**          | Medium | Add cmdk groups for agents, tools, workflows. Requires new search API endpoint with aggregation across collections. |
| **Recent projects tracking**       | Low    | Add `lastAccessedAt` to preferences or use project `updatedAt`. Already partially supported.                        |
| **Pin reordering (drag-and-drop)** | Low    | `pinnedProjectIds` is already an ordered array. Add `dnd-kit` or similar.                                           |

### 8.2 Mid-Term (V3)

| Feature                       | Effort | Dependency                                                                                                                                                |
| ----------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Universal command palette** | Medium | Merge Arch Bar + CommandPalette into one unified surface. Arch Bar handles home page, CommandPalette handles project pages, shared `cmdk` infrastructure. |
| **Personalized suggestions**  | Medium | Arch suggestions based on user's recent activity, project state, and common patterns. Requires analytics pipeline integration.                            |
| **UserPreferences expansion** | Low    | Store layout preferences, sort orders, notification settings, sidebar collapse state in the same collection.                                              |

### 8.3 Long-Term (V4+)

| Feature                               | Effort | Dependency                                                                                                                                                                                    |
| ------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **AI-generated project summaries**    | High   | Arch Bar shows AI-generated one-line summaries of pinned projects (last activity, health status). Requires async summarization pipeline.                                                      |
| **Natural language project creation** | High   | Arch Bar expands to full-screen overlay where users describe what they want in natural language. Arch creates the project, agents, tools, and workflows. Requires full Arch chat integration. |

---

## 9. Impact on Existing Apps

| App                             | Impact                          | Changes Required                                                                                                                    |
| ------------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| **Studio (`apps/studio`)**      | Direct — this is the target app | New components, store, API routes, modified dashboard                                                                               |
| **Runtime (`apps/runtime`)**    | None                            | No runtime changes. Preferences are a Studio-only concern.                                                                          |
| **SearchAI (`apps/search-ai`)** | None                            | No search service changes. V1 search is client-side filtering.                                                                      |
| **Admin (`apps/admin`)**        | None                            | No admin changes. Preferences are user-facing, not admin-managed.                                                                   |
| **Shared packages**             | Minimal                         | `UserPreferences` model could live in `packages/core` if other apps need it later. For V1, model lives in `apps/studio/src/repos/`. |
| **Dockerfiles**                 | None                            | No new packages added. All dependencies (`cmdk`, `framer-motion`, `zustand`) already in Studio's `package.json`.                    |
| **CI/CD**                       | None                            | No pipeline changes. Standard build/test/deploy.                                                                                    |
| **Database**                    | Additive                        | New `userpreferences` collection auto-created on first write. No migration scripts needed.                                          |

---

## 10. Component Architecture

```
ProjectDashboard (modified)
  ArchBar (new)
    ArchBarCollapsed — resting state with animated placeholder
    ArchBarExpanded — cmdk dropdown with search + results
      Command.Input
      Command.Group "Recent Projects"
      Command.Group "Suggestions"
      Footer (keyboard hints)
  PinnedProjectsRow (new)
    PinnedProjectCard (new) — compact horizontal card
  ProjectGrid (extracted from existing)
    ProjectCard (modified) — pin icon on hover
```

**New files:**

- `src/components/projects/ArchBar.tsx`
- `src/components/projects/PinnedProjectsRow.tsx`
- `src/store/preferences-store.ts`
- `src/api/preferences.ts` (client-side API functions)
- `src/app/api/user/preferences/route.ts` (server-side API route)
- `src/repos/preferences-repo.ts` (MongoDB model)

**Modified files:**

- `src/components/projects/ProjectDashboard.tsx`

---

## 11. Wireframes

### Home Page Layout

```
+------------------------------------------------------------------+
|  PageHeader: "Projects" + count                    [+ New v]     |
+------------------------------------------------------------------+
|                                                                   |
|  +--------------------------------------------------------------+|
|  |  A  Ask Arch anything... create, search...            Cmd+K  ||
|  +--------------------------------------------------------------+|
|                                                                   |
|  Pinned (3)                                                       |
|  +-----------+ +-----------+ +-----------+                       |
|  | * Proj A  | | * Proj B  | | * Proj C  |  <- compact row      |
|  | 3 agents  | | 5 agents  | | 2 agents  |                      |
|  +-----------+ +-----------+ +-----------+                       |
|                                                                   |
|  All Projects                                                     |
|  +--------------+ +--------------+ +--------------+              |
|  |  F  Proj D   | |  F  Proj E   | |  F  Proj F   |              |
|  |  desc...     | |  desc...     | |  desc...     |              |
|  |  3 agents    | |  1 agent     | |  7 agents    |              |
|  +--------------+ +--------------+ +--------------+              |
+------------------------------------------------------------------+
```

### Arch Bar — Expanded

```
+------------------------------------------------------------------+
|  A  |  type to search projects...                        Cmd+K   |
+------------------------------------------------------------------+
|  Recent Projects                                                  |
|    F  Project Alpha                              2 hours ago     |
|    F  Project Beta                               yesterday       |
|                                                                   |
|  Suggestions                                                      |
|    A  "Create a new customer service bot"                        |
|    A  "Help me design a workflow"                                |
|  ----------------------------------------------------------------|
|  Up/Down Navigate    Enter Select    Esc Close                    |
+------------------------------------------------------------------+
```

### Pin Interaction

```
  Resting:                            Hovered:
  +----------------------+           +----------------------+
  | F  Project D         |           | F  Project D    [pin]|
  | description...       |    ->     | description...       |
  | 3 agents - Mar 5     |           | 3 agents - Mar 5     |
  +----------------------+           +----------------------+
```
