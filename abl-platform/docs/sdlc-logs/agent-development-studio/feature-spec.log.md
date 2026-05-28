# SDLC Log: agent-development-studio -- Feature Spec (Phase 1)

**Date**: 2026-03-22
**Phase**: Feature Spec
**Status**: Complete

## Clarifying Questions & Decisions

| #   | Question                                          | Classification | Answer                                                                                                                                                                                                                                                                                                                         |
| --- | ------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | What is the full scope of agent editing sections? | ANSWERED       | 17 section editors found in `AgentEditor.tsx` SECTION_EDITORS map: identity, execution, tools, gather, flow, constraints, guardrails, behavior, handoffs, delegates, escalation, memory, onStart, errorHandling, completion, templates, definition                                                                             |
| 2   | How does surgical editing work?                   | ANSWERED       | `useSectionEdit` hook batches edits with 500ms debounce, sends to `/api/projects/[id]/agents/[agentId]/edit` endpoint. Source: `apps/studio/src/hooks/useSectionEdit.ts`                                                                                                                                                       |
| 3   | What compilation pipeline is used?                | ANSWERED       | `useAgentIR` fetches DSL from runtime, compiles via `/api/abl/compile` using `parseAgentBasedABL` + `compileABLtoIR`. Rate limited 30 req/60s. Source: `apps/studio/src/hooks/useAgentIR.ts`, `apps/studio/src/app/api/abl/compile/route.ts`                                                                                   |
| 4   | How many project settings sub-tabs exist?         | ANSWERED       | 10 tabs in `ProjectSettingsPage.tsx`: members, api-keys, models, config-vars, git, advanced, runtime-config, trace-dimensions, agent-transfer, pii-protection                                                                                                                                                                  |
| 5   | What git providers are supported?                 | ANSWERED       | 4 providers: GitHub, GitLab, Bitbucket, generic. Source: `packages/project-io/src/git/` directory listing                                                                                                                                                                                                                      |
| 6   | What navigation pages exist?                      | ANSWERED       | 30+ pages in `NavigationStore` including overview, agents, tools, mcp-servers, sessions, deployments, search-ai, workflows, connections, inbox, evals, experiments, dashboard, agent-performance, quality-monitor, customer-insights, voice-analytics, pipelines, alerts, guardrails-config, governance, and 11 settings pages |
| 7   | What state stores exist?                          | ANSWERED       | 20+ Zustand stores in `apps/studio/src/store/` including editor-store, project-store, agent-detail-store, navigation-store, version-store, arch-store, lifecycle-store, tool-store, mcp-server-store, canvas-store, and more                                                                                                   |
| 8   | Does collaborative editing exist?                 | DECIDED        | No -- confirmed as an open gap (GAP-001 in existing spec). No presence or multi-user editing code found.                                                                                                                                                                                                                       |
| 9   | What is the agent locking mechanism?              | ANSWERED       | `/api/projects/[id]/agents/[agentId]/lock` endpoint exists. No automatic lease expiry found -- this is GAP-008.                                                                                                                                                                                                                |

## Files Created

- `docs/features/agent-development-studio.md` -- Full 18-section feature spec (re-generated, code-grounded)
- `docs/sdlc-logs/agent-development-studio/feature-spec.log.md` -- This log

## Review Summary

### Round 1 -- Completeness & Quality

- [x] All 18 TEMPLATE.md sections addressed
- [x] 10 user stories (exceeds minimum 3)
- [x] 14 functional requirements (exceeds minimum 4)
- [x] Integration matrix references 8 related features
- [x] Non-functional concerns address isolation (tenant, project, user)
- [x] Delivery plan has parent tasks with numbered subtasks
- [x] Open questions section has 5 items
- [x] Claims grounded in code evidence

### Round 2 -- Cross-Phase Consistency

- [x] FR numbering is consistent (FR-1 through FR-14)
- [x] Scope boundaries match non-goals
- [x] User stories align with functional requirements
- [x] Implementation files verified at stated paths

## Key Findings

- The agent editor has 17 discrete section editors, significantly more granular than the previous spec suggested
- Studio has 60+ API routes under `/api/projects/[id]/`, making it one of the most API-heavy surfaces in the platform
- 20+ Zustand stores manage client-side state, most ephemeral (not persisted)
- The `project-service.ts` uses `any` types for Project/ProjectAgent -- should be addressed
- Agent locking exists but lacks automatic lease expiry
