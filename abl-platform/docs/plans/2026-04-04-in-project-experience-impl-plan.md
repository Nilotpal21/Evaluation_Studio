# LLD: In-Project Experience (3-Layer Design)

**Feature Spec**: `docs/arch/design/2026-04-04-in-project-experience-design.md`
**HLD**: (design spec serves as combined HLD — approved with review findings)
**Test Spec**: (to be generated post-implementation per milestone)
**Status**: DRAFT
**Date**: 2026-04-04
**Runtime Target**: Vercel AI SDK path (`/api/arch-ai/chat` + `context.ts`)

---

## 1. Design Decisions

### Decision Log

| #    | Decision                                                                                          | Rationale                                                                                                                                        | Alternatives Rejected                                                       |
| ---- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| D-1  | Single compound `platform_context` tool with actions                                              | Matches established pattern (agent_ops, session_ops, tools_ops all use compound actions). ACTION_TO_PERMISSION map requires this structure.      | Separate tools per endpoint — inconsistent with codebase pattern            |
| D-2  | Overlay state in `arch-ai-store.ts` as `overlayState: 'closed' \| 'chat' \| 'artifacts' \| 'ide'` | v3-specific state belongs with v3 store. Replaces both `archV3Open` boolean and `showArtifactPanel` boolean. Enables sparkle button integration. | Local useState in AppShell — blocks future cross-component access           |
| D-3  | New `InProjectArtifactPanel` component (not mode prop on OnboardingArtifactPanel)                 | Only 2/4 tabs overlap; onboarding props are entirely different. Reuse shared sub-components (JournalPanel, TopologyGraph).                       | Mode prop on OnboardingArtifactPanel — pervasive conditionals               |
| D-4  | `ProposedChange[]` type in `apps/studio/src/types/arch.ts`                                        | Type flows only within apps/studio. packages/arch-ai is onboarding-only path.                                                                    | Shared package — misleading dependency                                      |
| D-5  | Health check calls `compileAgent` function directly (not HTTP endpoints)                          | Server-side executor has direct repo/compiler access. `agent-ops.ts:268-341` already implements this.                                            | New batch compile endpoint — unnecessary HTTP overhead                      |
| D-6  | `get_project_summary` uses repo/service layer (direct DB access)                                  | All data in MongoDB. Same Next.js process. Pattern from `session-ops.ts`.                                                                        | HTTP fetch — auth complexity, unnecessary network hop                       |
| D-7  | Module-level Map with TTL/maxSize for server-side caching                                         | Follows CLAUDE.md rule: "Every in-memory Map needs max size, TTL, and eviction." 100 entries max, LRU eviction.                                  | Zustand (client-side, wrong runtime) or Redis (overkill for session-scoped) |
| D-8  | `get_project_summary` called both on mount (frontend fetch) AND available as LLM tool action      | Mount call populates Smart Welcome instantly. LLM tool call provides fresh data during conversation.                                             | LLM-only — welcome screen delays waiting for LLM round-trip                 |
| D-9  | CSS `transition: width 200ms ease-out` with `right: 0` anchoring                                  | Simple, no animation library. Right-anchored growth is natural CSS. Instant fallback if jank.                                                    | Framer Motion — overkill for width transition                               |
| D-10 | `archV3Open` promoted to `arch-ai-store.ts` as part of `overlayState`                             | Consolidates v3 overlay visibility + expansion into single state.                                                                                | Keep as useState — blocks sparkle button migration                          |

### Key Interfaces & Types

```typescript
// apps/studio/src/types/arch.ts — NEW ADDITIONS

/** Construct types for card-based diff rendering */
export type ABLConstructType =
  | 'AGENT'
  | 'PERSONA'
  | 'GOAL'
  | 'LIMITATIONS'
  | 'GATHER'
  | 'TOOLS'
  | 'FLOW'
  | 'HANDOFFS'
  | 'CONSTRAINTS'
  | 'GUARDRAILS'
  | 'EXECUTION'
  | 'MEMORY'
  | 'ON_INPUT'
  | 'ON_FAIL'
  | 'RESPOND';

/** Single proposed change for card-based diff */
export interface ProposedChange {
  construct: ABLConstructType;
  before: string | null; // null if new construct
  after: string | null; // null if removed
  rationale: string; // "Why" insight for the change
}

/** Full modification proposal from propose_modification */
export interface ModificationProposal {
  agentName: string;
  changes: ProposedChange[];
  compilationStatus?: { success: boolean; errors: string[]; warnings: string[] };
}

/** Health check result per agent */
export interface AgentHealthResult {
  agentName: string;
  checks: {
    compilation: 'PASS' | 'WARN' | 'FAIL';
    handoffs: 'PASS' | 'WARN' | 'FAIL';
    toolBindings: 'PASS' | 'WARN' | 'FAIL';
    modelConfig: 'PASS' | 'WARN' | 'FAIL';
    guardrails: 'PASS' | 'WARN' | 'FAIL';
    entryPoint: 'PASS' | 'WARN' | 'FAIL';
  };
  details: Array<{
    check: string;
    status: 'PASS' | 'WARN' | 'FAIL';
    message: string;
    suggestedFix?: string;
  }>;
}

/** Full health check report */
export interface HealthCheckReport {
  overall: 'Healthy' | 'Warning' | 'Critical';
  agents: AgentHealthResult[];
  summary: string; // e.g. "4 agents checked: 3 healthy, 1 warning"
}

/** Project summary for Smart Welcome */
export interface ProjectSummary {
  agentCount: number;
  toolCount: number;
  channelCount: number;
  guardrailCount: number;
  agentNames: string[];
  recentActivity?: { sessions24h: number; errors24h: number };
}

/** Overlay expansion state */
export type OverlayState = 'closed' | 'chat' | 'artifacts' | 'ide';
```

### Module Boundaries

| Module                                                                 | Responsibility                                                                                                 | Depends On                                                |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `apps/studio/src/lib/arch-ai/tools/platform-context.ts`                | NEW: Platform data tool (get_summary, list_agents, list_models, list_tools, list_channels, list_auth_profiles) | guards.ts, @agent-platform/database/models, project repos |
| `apps/studio/src/lib/arch-ai/tools/health-check.ts`                    | NEW: Health check tool (batch compile, handoff validation, tool binding, model config, guardrail coverage)     | agent-ops.ts (compileAgent), guards.ts, project repos     |
| `apps/studio/src/lib/arch-ai/tools/agent-ops.ts`                       | MODIFIED: Add `propose_modification` action returning ProposedChange[]                                         | existing deps + ProposedChange type                       |
| `apps/studio/src/lib/arch-ai/context.ts`                               | MODIFIED: Add platform_context and health_check to project context tools                                       | new tool files                                            |
| `apps/studio/src/lib/arch-ai/system-prompt.ts`                         | MODIFIED: Add platform awareness, widget guidance, project context injection sections                          | existing deps                                             |
| `apps/studio/src/components/arch-v3/overlay/ArchOverlay.tsx`           | MODIFIED: Expandable shell with 3 states, Smart Welcome                                                        | arch-ai-store, InProjectArtifactPanel                     |
| `apps/studio/src/components/arch-v3/panels/InProjectArtifactPanel.tsx` | NEW: Artifact panel for in-project mode (diff, topology, health, journal tabs)                                 | JournalPanel, arch-ai-store                               |
| `apps/studio/src/components/arch-v3/panels/InProjectDiffCard.tsx`      | NEW: Card-based diff renderer with Visual/Code toggle + insight badges                                         | ProposedChange type                                       |
| `apps/studio/src/components/arch-v3/panels/HealthReportCard.tsx`       | NEW: Per-agent health report card with PASS/WARN/FAIL badges                                                   | HealthCheckReport type                                    |
| `apps/studio/src/components/arch-v3/overlay/SmartWelcome.tsx`          | NEW: Stats card + entity-aware suggestion chips                                                                | ProjectSummary, ArchSuggestionChips, navigation-store     |
| `apps/studio/src/store/arch-ai-store.ts`                               | MODIFIED: Add overlayState, openOverlay, closeOverlay, setOverlayState                                         | existing deps                                             |
| `apps/studio/src/components/navigation/AppShell.tsx`                   | MODIFIED: Rewire header icon, remove FAB, remove v2 panel rendering                                            | arch-ai-store                                             |

---

## 2. File-Level Change Map

### New Files

| File                                                                   | Purpose                                                                       | LOC Estimate |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------ |
| `apps/studio/src/lib/arch-ai/tools/platform-context.ts`                | Platform context compound tool (6 actions)                                    | ~350         |
| `apps/studio/src/lib/arch-ai/tools/health-check.ts`                    | Health check tool (batch compile + validation)                                | ~300         |
| `apps/studio/src/lib/arch-ai/tools/cache.ts`                           | TTL cache utility (Map with maxSize, TTL, LRU eviction)                       | ~60          |
| `apps/studio/src/components/arch-v3/overlay/SmartWelcome.tsx`          | Stats card + entity-aware chips                                               | ~120         |
| `apps/studio/src/components/arch-v3/panels/InProjectArtifactPanel.tsx` | In-project artifact panel (diff, topology, health, journal tabs)              | ~200         |
| `apps/studio/src/components/arch-v3/panels/InProjectDiffCard.tsx`      | Card-based diff renderer (Visual/Code toggle)                                 | ~180         |
| `apps/studio/src/components/arch-v3/panels/HealthReportCard.tsx`       | Per-agent health report card                                                  | ~150         |
| `apps/studio/src/app/api/arch-ai/project-summary/route.ts`             | Lightweight API for Smart Welcome (frontend direct fetch on mount)            | ~80          |
| `apps/studio/src/services/arch-project-service.ts`                     | Shared `getProjectSummary()` function (DRY: used by tool + HTTP route)        | ~60          |
| `apps/studio/src/lib/diff-utils.ts`                                    | Extracted LCS diff utility (shared by DynamicTabRenderer + InProjectDiffCard) | ~50          |

### Modified Files

| File                                                         | Change Description                                                                                                           | Risk |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- | ---- |
| `apps/studio/src/lib/arch-ai/context.ts`                     | Add `platform_context` and `health_check` to project tools object (lines 55-73)                                              | Low  |
| `apps/studio/src/lib/arch-ai/system-prompt.ts`               | Add platform awareness section + widget guidance to PROJECT_CONTEXT_PROMPT (lines 51-95)                                     | Low  |
| `apps/studio/src/lib/arch-ai/guards.ts`                      | Add `platform_context` and `health_check` to ACTION_TO_PERMISSION map (lines 7-64)                                           | Low  |
| `apps/studio/src/store/arch-ai-store.ts`                     | Add `overlayState`, `openOverlay`, `closeOverlay`, `setOverlayState`; add `'health'` to ArtifactTabType                      | Low  |
| `apps/studio/src/components/arch-v3/overlay/ArchOverlay.tsx` | Rewrite to support 3-state expansion with ArchShell integration                                                              | Med  |
| `apps/studio/src/components/navigation/AppShell.tsx`         | Rewire header icon (line 358), remove FAB (lines 474-482), remove v2 panel (line 462), remove ArchMinimizedButton (line 471) | Low  |
| `apps/studio/src/components/arch-v3/panels/JournalPanel.tsx` | Add `IN_PROJECT` to PHASE_COLORS (line ~100)                                                                                 | Low  |
| `apps/studio/src/types/arch.ts`                              | Add ProposedChange, ModificationProposal, HealthCheckReport, ProjectSummary, OverlayState, ABLConstructType types            | Low  |
| `apps/studio/src/lib/arch-ai/tools/agent-ops.ts`             | Add `propose_modification` action to modifyAgent flow returning ProposedChange[]                                             | Med  |

### Deprecated Files (mark @deprecated, do not delete)

| File                                                                           | Reason                 |
| ------------------------------------------------------------------------------ | ---------------------- |
| `apps/studio/src/components/arch/ArchPanel.tsx`                                | Replaced by v3 overlay |
| `apps/studio/src/components/arch/ArchPanel.tsx` (`ArchMinimizedButton` export) | No longer rendered     |

---

## 3. Implementation Phases

### Phase 1a: Overlay Shell + Static Welcome (Frontend Only)

**Goal**: Rewire entry point, build expandable overlay shell, show static Smart Welcome — zero backend changes.

**Tasks**:

1a.1. **Add types to `apps/studio/src/types/arch.ts`**

- Add `OverlayState`, `ProjectSummary`, `ABLConstructType`, `ProposedChange`, `ModificationProposal`, `HealthCheckReport`, `AgentHealthResult` types
- Add `'health'` to `ArtifactTabType` union (line 10)

1a.2. **Update `apps/studio/src/store/arch-ai-store.ts`**

- Add state: `overlayState: OverlayState` (default: `'closed'`)
- Add actions: `openOverlay: () => set({ overlayState: 'chat' })`, `closeOverlay: () => set({ overlayState: 'closed' })`, `setOverlayState: (state: OverlayState) => set({ overlayState: state })`
- KEEP `showArtifactPanel` boolean — onboarding flow still uses it. `overlayState` is NEW and independent (in-project overlay only). Document: "showArtifactPanel = onboarding artifact panel; overlayState = in-project overlay expansion"

1a.3. **Create `apps/studio/src/components/arch-v3/overlay/SmartWelcome.tsx`**

- Props: `{ projectId: string; onChipSelect: (suggestion: ArchSuggestion) => void }`
- Uses `useNavigationStore` to read `page` and `subPage` for context
- Uses `useTranslations('arch_in_project')` for all user-visible strings
- Renders: stats card (2x2 grid, hardcoded zeros for now) + entity-aware suggestion chips
- Chip generation: function mapping `(page, subPage)` → `ArchSuggestion[]` (returns full ArchSuggestion objects with id, label, description, category, prompt, icon)
- Uses `ArchSuggestionChips` component imported from `@/components/arch/ArchSuggestionChips` (v2 directory, acceptable cross-dependency — shared component)
- onChipSelect receives full `ArchSuggestion` object (matching ArchSuggestionChips.onSelect signature), caller extracts `.prompt` to send to chat
- NOTE: Existing `SuggestionCategory` type (`error-handling`, `escalation`, `testing`, `optimization`, `feature`, `security`) doesn't cover in-project concepts. Extend the union in `types/arch.ts` with: `'modify'`, `'health'`, `'topology'`, `'trace'`. Add corresponding entries to `categoryIcons` and `categoryStyles` maps in `ArchSuggestionChips.tsx`

1a.4. **Create `apps/studio/src/components/arch-v3/panels/InProjectArtifactPanel.tsx`**

- Props: `{ sessionId: string | null }`
- Tab bar with 4 persistent tabs: Changes, Topology, Health, Journal
- Uses `useArchAIStore` for tab management (same pattern as OnboardingArtifactPanel)
- Tab content: Journal renders `JournalPanel`, others show placeholder "No data yet"
- No onboarding-specific props (no `onContinue`, `onSpecUpdate`, `onCreateProject`)

1a.5. **Rewrite `apps/studio/src/components/arch-v3/overlay/ArchOverlay.tsx`**

- New props interface: `{ projectId: string }` (remove `onClose` — close is now `closeOverlay()` from store)
- Update AppShell.tsx:466 callsite: `<ArchV3Overlay projectId={projectId} />` (remove onClose prop)
- Replace fixed `w-[400px]` with dynamic width based on `overlayState` from store
- Width map: `chat: 'w-[400px]'`, `artifacts: 'w-[60vw]'`, `ide: 'w-[90vw]'`
- CSS: `fixed right-0 top-0 h-screen transition-[width] duration-200 ease-out`
- When `overlayState === 'chat'`: render chat only (current behavior)
- When `overlayState === 'artifacts'`: render `InProjectArtifactPanel` + chat using `ArchShell` layout (artifact left, chat right 400px)
- When `overlayState === 'ide'`: render file tree + artifact + chat using `ArchShell` (20/40/40)
- Collapse/expand button in header for IDE mode
- No background dimming — no backdrop div
- Show `SmartWelcome` when messages array is empty (first open)
- Escape key and X button call `closeOverlay()`

1a.6. **Rewire `apps/studio/src/components/navigation/AppShell.tsx`**

- Line 358: Change `onClick={togglePanel}` → `onClick={() => { const s = useArchAIStore.getState(); s.overlayState === 'closed' ? s.openOverlay() : s.closeOverlay(); }}`
- Lines 474-482: Delete "Ask Arch" FAB block entirely
- Line 471: Delete `<ArchMinimizedButton />` rendering
- Line 462: Delete `{showArchPanel && <ArchPanel />}` rendering
- Line 465: Change `archV3Open && projectId &&` condition to read from `useArchAIStore((s) => s.overlayState !== 'closed')`
- Remove `archV3Open` useState and `setArchV3Open` (replaced by store)

1a.7. **Update `apps/studio/src/components/arch-v3/panels/JournalPanel.tsx`**

- Add to `PHASE_COLORS`: `IN_PROJECT: 'bg-info'`

1a.8. **Add i18n keys for all new components**

- Add namespace `arch_in_project` to `packages/i18n/locales/en/studio.json`
- Keys: `welcome_greeting`, `stats_agents`, `stats_tools`, `stats_channels`, `stats_guardrails`, `tab_changes`, `tab_topology`, `tab_health`, `tab_journal`, `chip_modify`, `chip_health_check`, `chip_review_agents`, `chip_add_agent`, `chip_view_topology`, `chip_run_tests`, `chip_view_traces`, `accept`, `reject`, `modify`, `why_insight`, `healthy`, `warning`, `critical`, `fix_this`, `no_data_yet`
- All new components use `useTranslations('arch_in_project')`

1a.9. **Mark v2 components deprecated**

- Add `/** @deprecated Use ArchOverlay (v3) instead */` to `ArchPanel` component
- Add `/** @deprecated Removed — overlay uses header A icon */` to `ArchMinimizedButton`

**Files Touched**:

- `apps/studio/src/types/arch.ts` — add types
- `apps/studio/src/store/arch-ai-store.ts` — add overlayState
- `apps/studio/src/components/arch-v3/overlay/SmartWelcome.tsx` — new
- `apps/studio/src/components/arch-v3/panels/InProjectArtifactPanel.tsx` — new
- `apps/studio/src/components/arch-v3/overlay/ArchOverlay.tsx` — rewrite
- `apps/studio/src/components/navigation/AppShell.tsx` — rewire + cleanup
- `apps/studio/src/components/arch-v3/panels/JournalPanel.tsx` — add phase color
- `apps/studio/src/components/arch/ArchPanel.tsx` — deprecation comment

**Exit Criteria**:

- [ ] Header "A" icon opens v3 overlay in project view
- [ ] "Ask Arch" FAB no longer renders
- [ ] ArchMinimizedButton no longer renders
- [ ] ArchPanel v2 no longer renders
- [ ] Overlay shows SmartWelcome with stats card (hardcoded zeros) and suggestion chips on first open
- [ ] Suggestion chips are page-context-aware (different chips on agents page vs sessions page)
- [ ] Chat messages work (send/receive via existing `/api/arch-ai/chat`)
- [ ] Journal tab shows entries in artifact panel
- [ ] Overlay expands/collapses (chat → artifacts → IDE states) via store actions
- [ ] Escape key closes overlay
- [ ] Project page remains fully interactive behind overlay (no dimming)
- [ ] `pnpm build --filter=studio` succeeds with 0 errors

**Test Strategy**:

- Manual: Open overlay via header icon, verify all 3 states, test chip navigation, verify project page interaction
- Unit: SmartWelcome chip generation function (page context → chips mapping)

**Rollback**: Revert the AppShell changes to restore v2 panel + FAB. ArchOverlay reverts to fixed 400px.

---

### Phase 1b: Live Platform Context (Backend + Integration)

**Goal**: Connect Smart Welcome to real data, implement platform_context tool, enrich system prompt.

**Tasks**:

1b.1. **Create `apps/studio/src/lib/arch-ai/tools/cache.ts`**

- Export `createTTLCache<T>(maxSize: number, defaultTTLMs: number)`
- Methods: `get(key)`, `set(key, value, ttlMs?)`, `invalidate(key)`, `clear()`
- LRU eviction when maxSize exceeded
- Returns undefined for expired entries (lazy eviction)

1b.2. **Create `apps/studio/src/lib/arch-ai/tools/platform-context.ts`**

- Compound tool following `agent-ops.ts` pattern
- Actions: `get_summary`, `list_agents`, `list_models`, `list_tools`, `list_channels`, `list_auth_profiles`
- Input schema:
  ```
  z.object({
    action: z.enum(['get_summary', 'list_agents', 'list_models', 'list_tools', 'list_channels', 'list_auth_profiles']),
    agentName: z.string().optional(), // filter for list_agents
    toolType: z.string().optional(),  // filter for list_tools
  })
  ```
- Permission mapping: all actions → `'project:read'` (read-only data access)
- Export: `executePlatformContext(input, ctx)` — context.ts contains factory `createPlatformContextTool(ctx)` wrapping this (same pattern as agent-ops.ts + context.ts:76-96)
- ALL DB queries MUST include `tenantId` from `ctx.user.tenantId` (Resource Isolation invariant)
- Use repo/service layer (NOT direct Mongoose model imports) for consistency with agent-ops.ts, session-ops.ts
- Each action implementation:
  - `get_summary`: Call shared `getProjectSummary(projectId, tenantId)` function (see task 1b.3). Parallel `Promise.allSettled` with 5s total timeout. Return `ProjectSummary`.
  - `list_agents`: Use `getProjectAgents(projectId, tenantId)` from project-service or equivalent repo function. Return agent names + metadata.
  - `list_models`: `fetch` to internal `/api/tenant-models` with `Authorization: Bearer ${ctx.authToken}`. Parses `{ models }` response. Returns model list with `displayName`, `tier`, `provider`, `capabilities`. (HTTP fetch acceptable here — tenant models live in runtime, not Studio DB)
  - `list_tools`: Use `findProjectTools({ projectId, tenantId })` from project-tool repo. Return tool names + types.
  - `list_channels`: Use `ChannelConnection.find({ projectId, tenantId })` via `await import('@agent-platform/database/models')`. (Note: model is `ChannelConnection`, NOT `Connection`). Return channel list.
  - `list_auth_profiles`: Use `AuthProfile` model or service if available; if not, use internal fetch to `/api/projects/${projectId}/auth-profiles` with auth headers. Verify at implementation time which approach is available.
- Error handling: try/catch per action, `err instanceof Error ? err.message : String(err)`, return `{ success: false, error: { code: 'PLATFORM_CONTEXT_ERROR', message } }`
- Cache: use `createTTLCache` with 5min for project data, 15min for tenant models
- Cache is **advisory-only** — a miss triggers fresh fetch. No correctness dependency on cache state. Pod restart = empty cache = all data re-fetched. Acceptable in serverless (cold start = fresh data).

1b.3. **Create shared function + API route**

- **Create `apps/studio/src/services/arch-project-service.ts`**: Export `getProjectSummary(projectId: string, tenantId: string): Promise<ProjectSummary>`. This is the single source of truth for project summary aggregation. Both the tool action and the HTTP route call this function. Uses repo/service layer for agent count, tool count, channel count. Parallel `Promise.allSettled` with 5s timeout. Partial results on failure (return 0 for failed counts).
- **Create `apps/studio/src/app/api/arch-ai/project-summary/route.ts`**: Lightweight GET endpoint for Smart Welcome.
  - Auth: `const user = await requireTenantAuth(req); const { project } = await requireProjectAccess(projectId, user);` (matching pattern from chat/route.ts)
  - Zod validation: `z.object({ projectId: z.string().min(1) }).safeParse(queryParams)` — return structured error `{ success: false, error: { code: 'VALIDATION_ERROR', message } }` on failure
  - Calls `getProjectSummary(projectId, user.tenantId)`
  - Returns `{ summary: ProjectSummary }`

1b.4. **Update `apps/studio/src/lib/arch-ai/context.ts`**

- Line 55-73 (project context tools): Add `platform_context: createPlatformContextTool(ctx)`
- Import `createPlatformContextTool` from `./tools/platform-context`

1b.5. **Update `apps/studio/src/lib/arch-ai/guards.ts`**

- Add to `ACTION_TO_PERMISSION` (line 7-64):
  ```
  platform_context: {
    get_summary: 'project:read',
    list_agents: 'agent:read',
    list_models: 'project:read',
    list_tools: 'tool:read',
    list_channels: 'connection:read',
    list_auth_profiles: 'auth_profile:read',
  }
  ```

1b.6. **Update `apps/studio/src/lib/arch-ai/system-prompt.ts`**

- Add to `PROJECT_CONTEXT_PROMPT` (after line 95):

  ```
  ## Platform Awareness
  You have access to `platform_context` tool that fetches real platform data.
  ALWAYS use platform_context to fetch available options before asking the user to choose.
  NEVER ask the user to type values that exist in the platform (model names, tool names, channel names, agent names).

  ## Widget Selection Rules
  - Known list (models, tools, channels, agents): use ask_user with SingleSelect or MultiSelect, populate options from platform_context results
  - Yes/No decision: use ask_user with Confirmation widget
  - Creative/novel input only: use ask_user with TextInput (persona text, goal descriptions, custom names)
  - File needed: use collect_file
  ```

- Add project summary injection: if `context.projectId`, prepend project summary to prompt (fetched and cached server-side)

1b.7. **Connect Smart Welcome to live data**

- In `SmartWelcome.tsx`: fetch from `/api/arch-ai/project-summary?projectId=...` on mount
- Replace hardcoded zeros with real counts
- Loading state while fetching

**Files Touched**:

- `apps/studio/src/lib/arch-ai/tools/cache.ts` — new
- `apps/studio/src/lib/arch-ai/tools/platform-context.ts` — new
- `apps/studio/src/app/api/arch-ai/project-summary/route.ts` — new
- `apps/studio/src/lib/arch-ai/context.ts` — add tool
- `apps/studio/src/lib/arch-ai/guards.ts` — add permissions
- `apps/studio/src/lib/arch-ai/system-prompt.ts` — add sections
- `apps/studio/src/components/arch-v3/overlay/SmartWelcome.tsx` — connect to API

**Exit Criteria**:

- [ ] Smart Welcome stats card shows real agent/tool/channel/guardrail counts
- [ ] `platform_context.list_models` returns available tenant models
- [ ] `platform_context.list_tools` returns project tools
- [ ] `platform_context.list_channels` returns project connections
- [ ] When user asks "what models are available?", Arch calls `platform_context.list_models` and presents a SingleSelect widget (not text)
- [ ] System prompt includes platform awareness and widget guidance sections
- [ ] Cache prevents repeated API calls within TTL window
- [ ] `pnpm build --filter=studio` succeeds with 0 errors

**Test Strategy**:

- Integration: Call `/api/arch-ai/project-summary` with a real project, verify counts match
- Manual: Open overlay, verify stats, ask model question, verify SingleSelect widget appears

**Rollback**: Remove platform-context.ts from context.ts tools object. SmartWelcome falls back to zeros.

---

### Phase 2: Modify Agent with Card-Based Diffs (IP-F01)

**Prerequisite**: Phase 1b complete (platform_context tool available — system prompt references it for list_agents/list_models).

**Goal**: Implement the core edit loop — user asks to modify, Arch reads agent, generates structured diff, shows in artifact panel, user accepts/rejects.

**Tasks**:

2.1a. **Extract LCS diff utility**

- Extract `computeLineDiff()` from `apps/studio/src/components/arch-ai/tabs/DynamicTabRenderer.tsx` into `apps/studio/src/lib/diff-utils.ts`
- Export as `computeLineDiff(before: string, after: string): DiffLine[]`
- Pure computation utility — no React hooks, no i18n (labels belong in consuming components)
- Import from both DynamicTabRenderer.tsx (update existing import) and new InProjectDiffCard.tsx

  2.1b. **Create `apps/studio/src/components/arch-v3/panels/InProjectDiffCard.tsx`**

- Props: `{ changes: ProposedChange[]; onAccept: () => void; onReject: () => void; onModify: (feedback: string) => void }`
- Construct color map using **semantic design tokens**: `{ PERSONA: 'border-l-purple', GATHER: 'border-l-info', TOOLS: 'border-l-success', HANDOFFS: 'border-l-warning', FLOW: 'border-l-info', CONSTRAINTS: 'border-l-error', GUARDRAILS: 'border-l-error', ... }` (uses existing semantic tokens: purple, info, success, warning, error)
- Per-change card: colored left border, construct badge, Visual/Code toggle (local useState per card)
- Visual view: strikethrough old (`line-through text-foreground-muted`) + green new (`text-success`)
- Code view: monospace font, `- old` / `+ new` format using extracted `computeLineDiff` from `lib/diff-utils.ts`
- "Why" insight badge: `rationale` field rendered as small annotation with lightbulb icon
- Accept/Reject/Modify buttons at bottom
- Uses `useTranslations('arch_in_project')` for all labels ("Accept", "Reject", "Modify", "Why")

  2.2. **Update `apps/studio/src/lib/arch-ai/tools/agent-ops.ts`**

- Add `'propose_modification'` to BOTH: (1) `AgentOpsInput.action` TypeScript union (agent-ops.ts:7), (2) Zod enum in context.ts:81 (`z.enum([..., 'propose_modification'])`)
- Add to guards.ts ACTION_TO_PERMISSION: `agent_ops.propose_modification: 'agent:read'`
- Input: `{ action: 'propose_modification', agentName: string, modification: string, changes: ProposedChange[] }`
- **Contract decision:** The tool receives `ProposedChange[]` FROM the LLM (as structured tool input, not free text). The LLM generates the changes based on its understanding of the current DSL + the modification request. The tool validates and returns the typed result. This is more reliable than parsing JSON from free text.
- Implementation:
  1. Call existing `readAgent()` (line 85-108) to get current DSL
  2. Receive `changes: ProposedChange[]` from the LLM's tool call input
  3. Validation: for each change where `change.after !== null`, call `parseDsl()` (line 364-383, parse-only, no compile — allows unbound tool refs in partial sections) to verify syntax
  4. Return `{ success: true, data: { proposal: { agentName, changes, compilationStatus? } } }`
- The tool result contains the typed `ModificationProposal`. The frontend renders this directly — no free-text JSON parsing needed.

  2.2b. **Wire propose_modification result to artifact tab**

- In the SSE message handler (useArchChat or ArchOverlay), when a tool_result for `agent_ops.propose_modification` arrives with `data.proposal`, create an artifact tab of type `'diff'` with `data: proposal`
- Call `useArchAIStore.getState().addTab({ type: 'diff', label: proposal.agentName, data: proposal })`
- This triggers the auto-expand logic from task 2.4

  2.3. **Update `apps/studio/src/components/arch-v3/panels/InProjectArtifactPanel.tsx`**

- Add diff tab content renderer: when active tab type is `'diff'`, render `InProjectDiffCard` with tab's data (which is `ModificationProposal`)
- Wire Accept/Reject/Modify callbacks to chat actions

  2.4. **Wire artifact panel auto-open in ArchOverlay**

- When `arch-ai-store` receives a new tab of type `'diff'`, auto-set `overlayState` to `'artifacts'`
- useEffect watching `artifactTabs` — if new diff tab added and overlayState is `'chat'`, promote to `'artifacts'`

  2.5. **Update system prompt with modification workflow**

- In `system-prompt.ts` PROJECT_CONTEXT_PROMPT, update AGENT MODIFICATION WORKFLOW section:
  ```
  AGENT MODIFICATION WORKFLOW:
  1. Call platform_context.list_agents to show available agents (if user hasn't specified one)
  2. Call agent_ops.read to get current agent definition
  3. If modification involves models: call platform_context.list_models, present SingleSelect
  4. If modification involves tools: call platform_context.list_tools, present SingleSelect
  5. Generate proposed changes as structured ProposedChange[] with construct, before, after, rationale
  6. Present changes for user approval (Accept/Modify/Reject)
  7. On Accept: call agent_ops.modify with dryRun:false
  ```

**Files Touched**:

- `apps/studio/src/components/arch-v3/panels/InProjectDiffCard.tsx` — new
- `apps/studio/src/lib/arch-ai/tools/agent-ops.ts` — add propose_modification action
- `apps/studio/src/components/arch-v3/panels/InProjectArtifactPanel.tsx` — add diff tab content
- `apps/studio/src/components/arch-v3/overlay/ArchOverlay.tsx` — auto-expand on diff tab
- `apps/studio/src/lib/arch-ai/guards.ts` — add permission
- `apps/studio/src/lib/arch-ai/system-prompt.ts` — update modification workflow

**Exit Criteria**:

- [ ] User asks "modify Greeter persona" → Arch reads agent, proposes changes as structured ProposedChange[]
- [ ] Artifact panel auto-opens with card-based diff (per-construct colored cards)
- [ ] Visual view shows strikethrough old / green new
- [ ] Code view toggle shows raw ABL diff
- [ ] "Why" insight badge shows rationale per change
- [ ] Accept button triggers `agent_ops.modify` with dryRun:false → saves to DB
- [ ] Reject button discards proposal, shows suggestion chips
- [ ] When modification involves models, user sees SingleSelect with available models (not text input)
- [ ] Journal entry recorded for accepted modifications
- [ ] `pnpm build --filter=studio` succeeds with 0 errors

**Test Strategy**:

- Manual: Modify an agent's persona via Arch, verify diff cards render correctly, accept and verify save
- Integration: Call agent_ops.propose_modification via test harness, verify ProposedChange[] structure

**Rollback**: Remove propose_modification action from agent-ops. InProjectDiffCard becomes unused.

---

### Phase 3: Health Check (IP-F06)

**Goal**: Implement health check with report card.

**Tasks**:

3.1. **Create `apps/studio/src/lib/arch-ai/tools/health-check.ts`**

- Compound tool with single action: `run_check`
- Input: `{ action: z.literal('run_check'), scope: z.enum(['project', 'agent']).optional(), agentName: z.string().optional() }`
- Export: `executeHealthCheck(input, ctx)` — context.ts contains factory `createHealthCheckTool(ctx)` (same pattern as other tools)
- ALL DB queries MUST include `tenantId` from `ctx.user.tenantId`
- Implementation:
  1. Load all agents (or single agent if scoped) using repo/service layer: `getProjectAgents(projectId, tenantId)` (same as platform-context list_agents)
  2. Cap at 20 agents. If more, return partial + warning.
  3. Per-agent checks (parallel `Promise.allSettled`, 5s timeout each):
     a. **Compilation**: Import and call compile logic from agent-ops.ts `compileAgent` function pattern (parse DSL + compile)
     b. **Handoff validity**: Parse all agents' HANDOFFS sections, verify targets exist in project agent list, detect circular paths
     c. **Tool bindings**: Parse TOOLS sections, check each tool name exists in `ProjectTool.find({ projectId })`
     d. **Model config**: Check if agent has model config via `AgentModelConfig.findOne({ agentId })` or project-level default
     e. **Guardrail coverage**: Check CONSTRAINTS/GUARDRAILS sections exist for agents with compliance keywords
     f. **Entry point**: Verify at least one agent is configured as entry point via `Project.findOne({ _id: projectId, tenantId }).select('entryAgentName')`
  4. Aggregate: overall status (Critical if any FAIL, Warning if any WARN, Healthy if all PASS)
  5. Return `HealthCheckReport`

  3.2. **Create `apps/studio/src/components/arch-v3/panels/HealthReportCard.tsx`**

- Props: `{ report: HealthCheckReport }`
- Overall status badge at top (green/yellow/red)
- Per-agent row: agent name + 5 colored badges (one per check)
- Expand row to see details + suggested fixes
- Suggestion chip per WARN/FAIL finding: "Fix this" triggers modification flow

  3.3. **Update `apps/studio/src/components/arch-v3/panels/InProjectArtifactPanel.tsx`**

- Add health tab content renderer: when active tab type is `'health'`, render `HealthReportCard` with tab's data

  3.4. **Update `apps/studio/src/lib/arch-ai/context.ts`**

- Add `health_check: createHealthCheckTool(ctx)` to project context tools

  3.5. **Update `apps/studio/src/lib/arch-ai/guards.ts`**

- Add to ACTION_TO_PERMISSION: `health_check: { run_check: 'agent:read' }`

  3.6. **Update system prompt with health check workflow**

- In `system-prompt.ts`: Add HEALTH CHECK WORKFLOW section

  ```
  HEALTH CHECK WORKFLOW:
  1. Call health_check.run_check
  2. Present summary in chat: "N agents checked: X healthy, Y warnings, Z failures"
  3. Show detailed report in artifact panel
  4. For each WARN/FAIL: explain what's wrong, why it matters, suggest fix
  5. Offer suggestion chips: "Fix [issue]" for each actionable finding
  ```

  3.7. **Wire health check "Fix" button to Modify Agent flow**

- In HealthReportCard: "Fix this" chip onClick dispatches a prefilled message to chat (e.g., "Fix Router's missing guardrail")
- This triggers the Modify Agent flow from Phase 2

**Files Touched**:

- `apps/studio/src/lib/arch-ai/tools/health-check.ts` — new
- `apps/studio/src/components/arch-v3/panels/HealthReportCard.tsx` — new
- `apps/studio/src/components/arch-v3/panels/InProjectArtifactPanel.tsx` — add health tab
- `apps/studio/src/lib/arch-ai/context.ts` — add tool
- `apps/studio/src/lib/arch-ai/guards.ts` — add permissions
- `apps/studio/src/lib/arch-ai/system-prompt.ts` — add workflow

**Exit Criteria**:

- [ ] User asks "health check" → Arch runs all checks and shows summary in chat
- [ ] Artifact panel shows report card with per-agent PASS/WARN/FAIL badges
- [ ] Expanding a finding shows details + suggested fix
- [ ] "Fix this" chip triggers Modify Agent flow for the specific issue
- [ ] Health check completes within 30s for projects with up to 20 agents
- [ ] Partial results returned if individual agent checks timeout
- [ ] `pnpm build --filter=studio` succeeds with 0 errors

**Test Strategy**:

- Integration: Run health check against a project with known issues (missing handoff target, unbound tool), verify correct WARN/FAIL detection
- Manual: Full flow — health check → review report → click "Fix" → modify agent → re-check

**Rollback**: Remove health-check.ts from context.ts tools object. HealthReportCard becomes unused.

---

## 3b. Deferred to Future Milestones

These tools from the design spec gap analysis are NOT covered by this LLD:

| Tool                        | Reason                                                                                | When                                             |
| --------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `query_traces` (span-level) | Sessions API returns metadata, not trace spans. Needs new runtime proxy or endpoint.  | Post-MVP — depends on runtime trace API          |
| `run_test` enhancement      | Already exists as `testing_ops.run_test`. Enhancement for structured output deferred. | Post-MVP — works today, just needs better output |
| `generate_topology`         | Onboarding-only tool. Not needed for in-project modify/health flows.                  | When IP-F02 (Agent Addition) is implemented      |
| `suggest_guardrails`        | Onboarding-only tool. Not needed for in-project flows.                                | When governance features are prioritized         |

## 4. Wiring Checklist

- [ ] `platform_context` tool registered in `context.ts` project tools (Phase 1b)
- [ ] `health_check` tool registered in `context.ts` project tools (Phase 3)
- [ ] Both tools added to `ACTION_TO_PERMISSION` map in `guards.ts`
- [ ] `OverlayState` type exported from `types/arch.ts`
- [ ] `overlayState` actions exported from `arch-ai-store.ts`
- [ ] `SmartWelcome` component imported and rendered in `ArchOverlay`
- [ ] `InProjectArtifactPanel` imported and rendered in `ArchOverlay` (artifacts state)
- [ ] `InProjectDiffCard` imported and rendered in `InProjectArtifactPanel` (diff tab)
- [ ] `HealthReportCard` imported and rendered in `InProjectArtifactPanel` (health tab)
- [ ] `JournalPanel` rendered in `InProjectArtifactPanel` (journal tab)
- [ ] `/api/arch-ai/project-summary` route file created and accessible
- [ ] Header "A" icon onClick reads from `arch-ai-store` (not `arch-store`)
- [ ] `'health'` added to `ArtifactTabType` union in `arch-ai-store.ts`
- [ ] `IN_PROJECT` added to `PHASE_COLORS` in `JournalPanel.tsx`
- [ ] System prompt updated with platform awareness + widget guidance + workflows
- [ ] `propose_modification` added to Zod enum in context.ts (Phase 2 task 2.2)
- [ ] `arch-project-service.ts` imported by both platform-context.ts AND project-summary/route.ts
- [ ] i18n namespace `arch_in_project` added to `packages/i18n/locales/en/studio.json` (Phase 1a task 1a.8)
- [ ] `SuggestionCategory` union extended with `'modify'`, `'health'`, `'topology'`, `'trace'`
- [ ] `computeLineDiff` extracted to `lib/diff-utils.ts` and imported by both consumers
- [ ] Note: `'diff'` already exists in `ArtifactTabType` — no change needed for it

---

## 5. Cross-Phase Concerns

### Database Migrations

None required. All data accessed through existing models and endpoints.

### Feature Flags

None. The entry point change (header icon rewire) is the implicit flag — old v2 panel is simply no longer rendered.

### Configuration Changes

No new env vars. All APIs accessed through existing auth and project context.

### Deprecated Components

| Component             | File                            | Replaced By        |
| --------------------- | ------------------------------- | ------------------ |
| `ArchPanel`           | `components/arch/ArchPanel.tsx` | `ArchOverlay` (v3) |
| `ArchMinimizedButton` | `components/arch/ArchPanel.tsx` | Header "A" icon    |
| "Ask Arch" FAB        | `AppShell.tsx:474-482`          | Header "A" icon    |

---

## 6. Acceptance Criteria (Whole Feature)

- [ ] All 4 phases complete with exit criteria met
- [ ] Smart Welcome shows real project stats on overlay open
- [ ] Arch uses SingleSelect/MultiSelect widgets for platform data (models, tools, channels) — never text input
- [ ] Modify Agent flow: read → propose → diff cards → accept/reject → save
- [ ] Health Check: batch checks → chat summary → report card → "Fix" triggers modification
- [ ] Overlay expands/collapses across 3 states, chat always 400px
- [ ] Project page fully interactive behind overlay (no dimming)
- [ ] Journal tab shows entries in all overlay states
- [ ] No regressions in existing chat functionality (`/api/arch-ai/chat` still works for all existing tools)
- [ ] `pnpm build && pnpm test` passes
- [ ] Feature specs updated: IP-F01, IP-F06, IP-F09

---

## 7. Open Questions

1. **Topology tab**: InProjectArtifactPanel includes a Topology tab — should it render the existing `TopologyGraph` component or a new visualization? (Deferred to post-MVP)
2. **File tab in IDE mode**: When overlayState is `'ide'`, what populates the file tree? Agent ABL files from `read_agent`? (Deferred to post-MVP)
3. **Streaming diff rendering**: Should ProposedChange[] be streamed as the LLM generates each change, or delivered as a complete batch? (Start with batch, consider streaming later)
4. **Error recovery**: If `platform_context` fails mid-conversation, should Arch fall back to text-based input or show an error? (Show error + retry chip)
