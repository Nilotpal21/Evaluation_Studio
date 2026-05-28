# Discovery Tree UX Redesign — High-Level Design

## What

Redesign the discovery tree from a developer debug view into a user-first experience. Remove all internal classification badges (HTTP, Global, Nav, leaf, etc.), make node exploration discoverable with always-visible buttons, group orphan nodes into an "Other Pages" section, add post-discovery guidance, and fix the global link misclassification bug. Zero backend changes — all improvements are frontend-only.

Reference: `docs/design/DISCOVERY-TREE-UX-SPEC.md`

## Architecture Approach

### Packages Changed

- `apps/studio` — all UI changes (components, i18n)
- `apps/crawler-mcp-server` — global link bug fix only (already applied)

### Data Flow (unchanged)

```
crawler-mcp-server (BFS engine)
    │ SSE: tree-snapshot, progress, activity, phase, complete
    ▼
search-ai (SSE proxy)
    │ EventSource
    ▼
studio: useDiscovery hook
    │ onTreeSnapshot → treeSnapshotToUnifiedTree()
    ▼
UnifiedDiscoveryPanel (owns tree state + mode)
    │ tree, mode, callbacks
    ▼
UnifiedTree (header + virtualized body + footer)
    │ node, depth, mode
    ▼
UnifiedTreeNodeRow (REDESIGNED — simplified row)
```

### Key Integration Points

- `tree-merge.ts::treeSnapshotToUnifiedTree()` — add orphan grouping here
- `UnifiedDiscoveryPanel` — add guidance state between live→select transition
- `UnifiedTree` — wire new GuidanceBanner, QuickFilters, NodeDetailPanel
- `UnifiedTreeNodeRow` — the biggest change: remove 11 badge types, add status area

## Decisions & Tradeoffs

1. **No ContextMenu (right-click)**: Radix context-menu not installed. Using DropdownMenu with "..." trigger instead — simpler, achieves same goal. Can add context-menu later if needed.

2. **Orphan grouping on frontend, not backend**: Backend already returns orphans as extra root nodes. Frontend wraps them in a synthetic "Other Pages" group. Zero backend changes.

3. **SegmentedControl for QuickFilters**: Single-select (All/Selected/Suggested/Unexplored/Errors) using existing SegmentedControl component. Simpler than multi-select ToggleChips.

4. **SlidePanel (nonBlocking) for NodeDetailPanel**: Standard pattern (18 consumers in codebase). Panel sits alongside tree without blocking interaction.

5. **Skip Phase 0 heartbeat fix**: Backend change for `navigateWithRetry` progress is out of scope for this UX task. Will log as a follow-up.

6. **Guidance banner uses InfoCard**: Has built-in dismiss button. Action buttons passed as children.

7. **i18n all new strings**: Every user-visible string uses `useTranslations`. ~20 new keys.

## Task Decomposition

| Task                                      | Package(s)           | Independent?                 | Est. Files                              | Complexity    |
| ----------------------------------------- | -------------------- | ---------------------------- | --------------------------------------- | ------------- |
| T-1: Clean up UnifiedTreeNodeRow          | studio               | Yes                          | 2 (component + i18n)                    | Major rewrite |
| T-2: Redesign UnifiedTreeHeader           | studio               | Yes                          | 2 (component + i18n)                    | Major rewrite |
| T-3: Add QuickFilters                     | studio               | Yes                          | 2 (new component + i18n)                | Simple        |
| T-4: Add orphan grouping ("Other Pages")  | studio               | Yes                          | 1 (tree-merge.ts)                       | Moderate      |
| T-5: Add GuidanceBanner                   | studio               | Yes                          | 2 (new component + i18n)                | Simple        |
| T-6: Add NodeDetailPanel                  | studio               | Yes                          | 2 (new component + i18n)                | Moderate      |
| T-7: Wire everything in UnifiedTree       | studio               | No (T-1,T-2,T-3,T-4,T-5,T-6) | 2 (UnifiedTree + UnifiedDiscoveryPanel) | Moderate      |
| T-8: i18n consolidation + global link fix | studio + crawler-mcp | Yes                          | 2 (studio.json + hybrid-tree-builder)   | Simple        |

### Execution Plan

**Wave 1 (parallel — no dependencies):** T-1, T-2, T-3, T-4, T-5, T-6, T-8

- All independent, touching different files

**Wave 2 (sequential — depends on Wave 1):** T-7

- Wires all Wave 1 components together in UnifiedTree + UnifiedDiscoveryPanel

## What Each Task Does

### T-1: Clean up UnifiedTreeNodeRow (MAJOR)

Remove 11 badge types (HTTP, Browser, Nav, BFS, Seed, Primary, Global, leaf, hub, virtual, link frequency, visited dot, childPageCount). Replace with single right-aligned status area showing ONE of: `[Explore]` button / "N pages" / "Suggested" / spinner + "Exploring..." / "Could not reach" + Retry. Make Explore button always visible (not hover-only). Keep: chevron, icon, checkbox, label, status area. Max 6 elements per row.

### T-2: Redesign UnifiedTreeHeader (MAJOR)

Rename "Discovery Tree" → "Site Structure". Remove "N nodes" badge → plain text "(484)". Rename view toggles: hybrid→"Smart", crawl-path→"As Discovered", url-path→"By URL". Restructure to 3 rows: title+search, quick filters slot, actions+view toggle. Add "Select suggested" button replacing "Select All".

### T-3: Add QuickFilters (SIMPLE)

New component using SegmentedControl. Options: All / Selected / Suggested / Unexplored / Errors. Each shows count badge. Single-select. Composes with existing search filter.

### T-4: Add orphan grouping (MODERATE)

In `treeSnapshotToUnifiedTree`, after conversion, identify non-primary root nodes and wrap them in a synthetic "Other Pages" group node. Collapsed by default when >5 items. Alphabetically sorted.

### T-5: Add GuidanceBanner (SIMPLE)

New component using InfoCard. Shows after discovery completes, before user starts selecting. Two actions: "Select suggested sections" and "I'll pick manually". Dismissible, state in localStorage.

### T-6: Add NodeDetailPanel (MODERATE)

New component using SlidePanel (nonBlocking). Shows all developer info: URL, status, render method, discovery source, foundOn list, link frequency, page role, error details. Triggered by "..." menu on each row or keyboard shortcut.

### T-7: Wire everything in UnifiedTree + UnifiedDiscoveryPanel (MODERATE)

Add GuidanceBanner slot between header and tree body. Add QuickFilters state and filtering logic. Add NodeDetailPanel state (selected node). Update footer copy. Add guidance state to UnifiedDiscoveryPanel mode transition. Update "Stop" button label.

### T-8: i18n + global link fix (SIMPLE)

Add ~20 new i18n keys. Commit the already-applied global link fix (MIN_VISITED_FOR_GLOBAL_LINKS + primary URL exclusion).

## Out of Scope

- Phase 0 heartbeat/progress during `navigateWithRetry` (backend change — follow-up)
- SSE reconnection indicator (Gap 9 from V2)
- Explore Branch post-completion (Gap 4 — backend 409)
- Right-click context menu (need to install Radix primitive — future)
- Keyboard navigation (Arrow keys, Enter/Space) — follow-up accessibility pass
- Page count estimates from sitemap before exploration
- Auto-trigger exploration on "Select suggested" checkbox click
