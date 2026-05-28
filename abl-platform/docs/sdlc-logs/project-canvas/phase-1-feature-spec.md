# SDLC Log: Project Canvas — Phase 1 (Feature Spec)

> **Date**: 2026-03-22
> **Phase**: Feature Spec
> **Artifact**: `docs/features/project-canvas.md`

## Context Gathered

- Read existing `ProjectCanvas.tsx` (852 lines) — ReactFlow-based topology with ELK layout, semantic zoom, edge editing, drag-and-drop, deep linking
- Read existing `ProjectOverviewPage.tsx` (725 lines) — adaptive dashboard with 3 phases (empty/building/live), metrics, agent list, activity timeline
- Read existing `ProjectDashboard.tsx` (263 lines) — project card grid landing page
- Read existing `AgentListPage.tsx` — mini-topology + agent card grid with canvas toggle
- Read `navigation-store.ts` — current ProjectPage types include 'overview' and 'agents'
- Read `project-store.ts` — Project type has id, name, slug, description, agentCount, sessionCount
- Read `canvas-store.ts` exports — viewport, selection, and data stores exist
- Read `api/projects.ts`, `api/usage.ts`, `api/deployments.ts` — existing API client functions

## Decisions Made

| #   | Decision                                                | Classification | Rationale                                                             |
| --- | ------------------------------------------------------- | -------------- | --------------------------------------------------------------------- |
| D1  | Canvas page is additive, not a replacement for overview | DECIDED        | Users who prefer list-based dashboards should not lose their workflow |
| D2  | Resources shown as badges, not satellite nodes          | DECIDED        | Satellite nodes add visual clutter; badges are scannable              |
| D3  | KPI bar is collapsible                                  | DECIDED        | Power users want maximum canvas space                                 |
| D4  | Mobile falls back to list view                          | DECIDED        | ReactFlow canvas is impractical on small screens                      |
| D5  | Context menu for agent actions                          | DECIDED        | Reduces navigation friction for power users                           |

## Key Findings

- **Existing canvas is feature-rich**: 852 lines with edge CRUD, deep linking, semantic zoom, keyboard shortcuts — minimal canvas work needed
- **ProjectOverviewPage has 3-phase logic**: empty/building/live — canvas page must replicate empty state handling
- **SWR data fetching pattern is established**: agents, deployments, tools, workflows, knowledge bases all have existing fetchers
- **15 functional requirements identified**: 8 at P0, 7 at P1
- **7 user stories** covering visual health, KPIs, view toggle, resource integration, quick actions, onboarding, and contextual detail

## Audit Notes

Self-audit findings:

- All 12 SDLC concerns addressable at this scope (Studio-only, no backend changes needed for MVP)
- No new API endpoints required — all data available through existing SWR endpoints
- Existing canvas-store pattern handles viewport persistence (NFR-07)
- i18n required for all new strings (NFR-05)
