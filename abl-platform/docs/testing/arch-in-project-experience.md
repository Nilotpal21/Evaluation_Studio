# Feature Test Guide: Arch In-Project Experience

**Feature**: 3-layer in-project experience — expandable overlay, platform-aware tools, health check
**Owner**: Arch AI team
**Branch**: Archv03
**First tested**: 2026-04-05
**Last updated**: 2026-04-05
**Overall status**: IN PROGRESS

---

## Current State (as of 2026-04-05)

Core backend is working end-to-end. The `platform_context.list_models` tool returns real tenant models (6 models from 3 providers) when the LLM asks. The `health_check` tool runs all 6 checks across all agents and returns structured PASS/WARN/FAIL results. The `project-summary` API returns real agent/tool/channel counts. The overlay UI was verified in dev preview (opens/expands/collapses/closes with zero errors). Full live UI testing with browser automation is pending (PM2 production mode requires `next build`).

### Quick Health Dashboard

| Area                              | Status  | Last Verified | Notes                                              |
| --------------------------------- | ------- | ------------- | -------------------------------------------------- |
| Project Summary API               | PASS    | 2026-04-05    | Returns real counts, Zod validation, auth check    |
| platform_context.list_models      | PASS    | 2026-04-05    | LLM calls it correctly, returns 6 real models      |
| platform_context.list_agents      | PASS    | 2026-04-05    | Via project summary aggregation                    |
| health_check.run_check            | PASS    | 2026-04-05    | All 6 checks per agent, correct PASS/WARN/FAIL     |
| Overlay UI (open/close/expand)    | PASS    | 2026-04-05    | Verified via Claude Preview dev server             |
| SmartWelcome (stats + chips)      | PARTIAL | 2026-04-05    | Renders, but live data connection needs prod build |
| Card-based diff rendering         | --      | Not tested    | Needs LLM to call propose_modification             |
| HealthReportCard rendering        | --      | Not tested    | Needs browser with auth + health check result      |
| Modify Agent flow (Accept/Reject) | --      | Not tested    | Accept/Reject callbacks are placeholder stubs      |

---

## Test Coverage Map

### API Tests

- [x] GET /api/arch-ai/project-summary with valid project — `Iteration 1 PASS`
- [x] GET /api/arch-ai/project-summary without projectId — `Iteration 1 PASS (400 validation)`
- [x] GET /api/arch-ai/project-summary without auth — `Iteration 1 PASS (401)`
- [x] POST /api/arch-ai/chat with platform_context.list_models — `Iteration 1 PASS`
- [x] POST /api/arch-ai/chat with health_check.run_check — `Iteration 1 PASS`
- [ ] POST /api/arch-ai/chat with agent_ops.propose_modification — Not tested
- [ ] platform_context.list_tools — Not tested directly
- [ ] platform_context.list_channels — Not tested directly
- [ ] platform_context.list_auth_profiles — Not tested directly

### UI Tests

- [x] Overlay opens via header A icon — `Iteration 1 PASS (dev preview)`
- [x] Overlay expands to artifacts state — `Iteration 1 PASS`
- [x] Overlay collapses back to chat — `Iteration 1 PASS`
- [x] Overlay closes via X button — `Iteration 1 PASS`
- [x] No "Ask Arch" FAB rendered — `Iteration 1 PASS`
- [x] No background dimming — `Iteration 1 PASS`
- [x] Zero console errors — `Iteration 1 PASS`
- [ ] SmartWelcome shows live project stats — Not tested (prod build needed)
- [ ] Card-based diff cards render — Not tested
- [ ] HealthReportCard renders — Not tested
- [ ] Page-context-aware chips change per page — Not tested

### Security

- [x] Auth required for project-summary — `Iteration 1 PASS (401 without token)`
- [x] tenantId in all DB queries — `Verified via code review (5 rounds)`
- [x] Cache keys include tenantId — `Fixed in review round 3`
- [ ] Cross-tenant isolation test — Not tested

---

## Open Gaps

- **GAP-001**: Accept/Reject/Modify callbacks in InProjectDiffCard are placeholder stubs
  - Severity: Medium
  - Blocked by: Needs deeper wiring from diff card → agent_ops.modify in chat

- **GAP-002**: SmartWelcome live data not verified in production mode
  - Severity: Low
  - Blocked by: PM2 production mode requires `next build` which failed on dep package

- **GAP-003**: Card-based diff rendering not verified end-to-end
  - Severity: Medium
  - Blocked by: Requires LLM to generate ProposedChange[] via propose_modification

---

## Iteration Log

### Iteration 1 — 2026-04-05

**Scope**: Backend tools (project-summary, platform_context, health_check) + overlay UI basics
**Branch**: Archv03
**Tested by**: Claude Code (agent)

#### Results

| #   | Test                  | Method                           | Expected                   | Actual                                   | Status |
| --- | --------------------- | -------------------------------- | -------------------------- | ---------------------------------------- | ------ |
| 1   | Project summary API   | GET /api/arch-ai/project-summary | JSON with counts           | 6 agents, 0 tools, correct names         | PASS   |
| 2   | Missing projectId     | GET without param                | 400 validation             | 400 VALIDATION_ERROR                     | PASS   |
| 3   | No auth               | GET without token                | 401                        | 401 UNAUTHORIZED                         | PASS   |
| 4   | list_models via chat  | POST /api/arch-ai/chat           | LLM calls platform_context | Called list_models, got 6 real models    | PASS   |
| 5   | health_check via chat | POST /api/arch-ai/chat           | LLM calls health_check     | 6 agents checked, correct PASS/WARN/FAIL | PASS   |
| 6   | Overlay open          | Click A icon (dev preview)       | 400px panel opens          | Opens correctly                          | PASS   |
| 7   | Overlay expand        | Click expand button              | Artifact panel appears     | Expands to 60vw                          | PASS   |
| 8   | Overlay collapse      | Click collapse button            | Returns to 400px           | Collapses correctly                      | PASS   |
| 9   | Overlay close         | Click X                          | Overlay hidden             | Closes, project page visible             | PASS   |

#### Bugs Found and Fixed

- **BUG-001**: `@/lib/db` import path in arch-project-service.ts
  - File: `apps/studio/src/services/arch-project-service.ts:47`
  - Root Cause: Wrong import path — should be `@/lib/ensure-db`
  - Fix: Changed import to `@/lib/ensure-db`
  - Commit: `9eada3e09`

---

## Test Environment

Studio: localhost:5173 (PM2, Next.js dev mode)
Runtime: localhost:3112 (PM2, fork mode)
MongoDB: localhost:27017/abl_platform
Test project: 019d53cb-644d-7339-97ce-a639ede61c9b (6 agents)
