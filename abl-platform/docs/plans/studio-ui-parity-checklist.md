# Studio UI Parity Checklist

Last updated: 2026-04-01

## Scope

This checklist covers Studio parity gaps and broken management actions across:

- Agents
- Tools
- Knowledge Bases
- Workflows
- Shared UI primitives that block existing features from working

## Current Findings

### Resolved bug: entry-agent selection interaction and refresh hydration

The entry-agent selector interaction bug was fixed by hardening `FilterSelect` portal clicks, and the hard-refresh persistence bug was fixed by returning `entryAgentName` from the projects list response so `currentProject` rehydrates correctly after reload.

Primary code paths:

- `apps/studio/src/components/agents/AgentListPage.tsx`
- `apps/studio/src/components/ui/FilterSelect.tsx`
- `apps/studio/src/components/ui/ListPageShell.tsx`
- `apps/studio/src/app/api/projects/route.ts`
- `apps/studio/e2e/agents-list-parity.spec.ts`

Backend persistence for `entryAgentName` is already present:

- `apps/studio/src/app/api/projects/[id]/route.ts`
- `apps/studio/src/services/project-service.ts`
- `apps/studio/src/repos/project-repo.ts`
- `packages/database/src/models/project.model.ts`

### Cross-cutting impact

`FilterSelect` is reused by `ListPageShell`, so this likely affects other list-page filters beyond Agents, including pages such as:

- `apps/studio/src/components/operate/TransferSessionsPage.tsx`
- `apps/studio/src/components/search-ai/KnowledgeBaseDashboardPage.tsx`
- Any other `ListPageShell` page that passes `filters`

## Parity Checklist

### Shared UI

- [x] Fix `FilterSelect` portal interaction so selecting an option works reliably.
- [x] Add regression tests that exercise the real portal behavior instead of only mocked inline portals.
- [x] Add at least one browser/E2E smoke test for a `ListPageShell` filter and for entry-agent persistence.
- [x] Audit all `ListPageShell` consumers after the fix to confirm filters now work.

### Agents

- [x] Make the entry-agent selector reliably update and persist.
- [x] Keep entry-agent selection in the Agents list page and canvas toolbar only.
- [x] Move the list-page entry-agent control out of the filter bar into a dedicated toolbar/header placement.
- [x] Add the entry-agent selector to the canvas toolbar.
- [x] Expose agent delete in the agent detail page.
- [x] Expose safe agent metadata editing in the agent detail page for path/description updates.
- [x] Add confirmation and dependency messaging for destructive agent actions.
- [ ] Design a DSL-safe rename flow before exposing agent name edits in Studio.

Later release / deferred:

- [ ] Expose agent ownership transfer UI if per-agent ownership is still a supported concept.
- [ ] Expose agent permission management UI if per-agent permissions are still supported.

Relevant code:

- UI: `apps/studio/src/components/agents/AgentListPage.tsx`
- UI: `apps/studio/src/components/agents/AgentDetailPage.tsx`
- API: `apps/studio/src/app/api/projects/[id]/agents/[agentId]/route.ts`
- API: `apps/studio/src/app/api/projects/[id]/agents/[agentId]/ownership/route.ts`
- API: `apps/studio/src/app/api/projects/[id]/agents/[agentId]/permissions/route.ts`

### Tools

- [x] Keep tool version history out of Studio; the current tool model is single-document and no longer supports draft/publish history.
- [x] Clean up stale client/store/test references to deprecated tool-version routes.
- [x] Expose tool export.
- [x] Expose tool import.
- [x] Expose force-delete flow when a tool is referenced by agents.
- [x] Show impacted agents before forced deletion.
- [x] Add success/error UX around export/import/version actions.

Relevant code:

- UI: `apps/studio/src/components/tools/ToolCard.tsx`
- UI: `apps/studio/src/components/tools/ToolsListPage.tsx`
- UI: `apps/studio/src/components/tools/ToolDetailPage.tsx`
- API client: `apps/studio/src/api/tools.ts`
- Store: `apps/studio/src/store/tool-store.ts`
- API: `apps/studio/src/app/api/projects/[id]/tools/[toolId]/route.ts`
- E2E: `apps/studio/e2e/tool-api.spec.ts`

### Knowledge Bases

- [x] Re-enable rebuild in the currently mounted settings flow.
- [x] Migrate the old `KBOverviewTab` rebuild behavior into `SettingsPanel`.
- [x] Keep low-level index update/delete actions backend-only; no Studio surface is needed.
- [x] Add confirmation, progress, and completion feedback for rebuild.
- [x] Add tests covering rebuild from the current mounted KB detail path.

Relevant code:

- UI: `apps/studio/src/components/search-ai/layout/KBDetailLayout.tsx`
- UI: `apps/studio/src/components/search-ai/settings/SettingsPanel.tsx`
- UI: `apps/studio/src/components/search-ai/settings/DangerZoneSection.tsx`
- Legacy UI: `apps/studio/src/components/search-ai/KBOverviewTab.tsx`
- API: `apps/studio/src/app/api/search-ai/knowledge-bases/[id]/rebuild/route.ts`
- API: `apps/studio/src/app/api/search-ai/indexes/[id]/route.ts`

### Workflows

- [x] Expose trigger delete.
- [x] Expose trigger "fire now" / manual run.
- [x] Keep pause/resume where it is, but unify action layout so all trigger lifecycle actions are in one place.
- [x] Expose notification rule editing, not just create/delete.
- [x] Add confirmation for destructive trigger actions.
- [x] Add tests for trigger delete/fire and notification update flows.

Relevant code:

- UI: `apps/studio/src/components/workflows/tabs/WorkflowTriggersTab.tsx`
- UI: `apps/studio/src/components/workflows/tabs/WorkflowNotificationsTab.tsx`
- API: `apps/studio/src/app/api/projects/[id]/workflows/[workflowId]/notifications/[ruleId]/route.ts`
- Runtime proxy: `apps/runtime/src/middleware/workflow-engine-proxy.ts`

## Recommended Plan

### Phase 0: Unblock existing controls

Goal: make already-exposed controls actually work before adding more UI.

- Fix `FilterSelect` so portal menu clicks count as inside clicks.
- Add a focused component regression test for option selection with the real interaction path.
- Add an integration test that uses the real `FilterSelect` from `AgentListPage` instead of a mocked native `<select>`.
- Add one browser/E2E smoke test that changes the entry agent, refreshes, and verifies persistence.

Expected outcome:

- Entry-agent selector becomes usable.
- Other list filters built on `FilterSelect` become reliable.

### Phase 1: Close the most important parity gaps

Goal: expose the highest-value missing management actions with the lowest implementation risk.

- Agents: keep entry-agent selection in list and canvas only, move it out of the filter bar in list view, add it to the canvas toolbar, and add delete to agent detail.
- Tools: add export/import and surface force-delete when dependencies exist.
- Workflows: add notification edit.

Expected outcome:

- The most obvious "API exists but Studio cannot do it" gaps are removed.

### Phase 2: Finish advanced management surfaces

Goal: expose more advanced admin surfaces that may need stronger UX and authorization review.

- Agents: ownership transfer and per-agent permissions. Deferred to a later release.
- Tools: clean up stale client/test references to deprecated tool-version routes.
- Workflows: add trigger delete and trigger fire-now.
- Knowledge Bases: re-enable rebuild in the current settings surface.

Expected outcome:

- Studio reaches clearer parity with backend capabilities.
- Remaining hidden actions are hidden by product choice rather than accidental omission.

### Phase 3: Hardening and cleanup

Goal: prevent parity regressions.

- Add a lightweight parity inventory doc or test checklist for Studio pages vs backing routes.
- Add E2E smoke coverage for one action per area:
  - Agents: set entry agent
  - Tools: export or force delete
  - Knowledge Bases: rebuild
  - Workflows: fire trigger or edit notification
- Review mocks in component tests that currently hide real interaction bugs.

Expected outcome:

- We stop reintroducing "present in code, broken in UI" issues.

## Suggested Implementation Order

1. Fix `FilterSelect`.
2. Ship an entry-agent regression test.
3. Move the list-page entry-agent control out of the filter bar.
4. Add the entry-agent selector to the canvas toolbar.
5. Add tool export/import and force-delete UX.
6. Add agent delete to the agent detail page.
7. Add workflow notification edit.
8. Add workflow trigger delete/fire.
9. Re-enable KB rebuild.
10. Clean up stale client/test references to deprecated tool-version routes.
11. Pick up agent ownership/permissions in a later release.

## Acceptance Criteria

- Changing the entry agent from Studio updates `project.entryAgentName` and survives refresh.
- All `FilterSelect`-backed filters are click-selectable in browser testing.
- Every surfaced destructive action has confirmation UX and clear success/failure feedback.
- For each area, either:
  - the capability is exposed in Studio, or
  - it is explicitly documented as intentionally backend-only/admin-only.
