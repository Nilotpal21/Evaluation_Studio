# Feature Test Guide: Arch AI In-Project Operations

**Feature**: In-project Arch AI overlay — read agents, modify agents, add agents, health check, topology
**Owner**: Arch AI team
**Branch**: features/arch-ai
**First tested**: 2026-04-08
**Last updated**: 2026-04-08
**Overall status**: STABLE (after fix)

---

## Current State (as of 2026-04-08)

The Arch AI in-project mode is **working** after one critical bug fix. Users can open the Arch overlay from within a project, ask about agents, view topology, run health checks, modify existing agents via the proposal system (propose → accept/reject), and add new agents. The proposal accept flow was broken because `pendingMutation` was not persisted to MongoDB (missing from the Mongoose schema). After fixing the schema, all operations work correctly.

### Quick Health Dashboard

| Area                          | Status | Last Verified | Notes                                             |
| ----------------------------- | ------ | ------------- | ------------------------------------------------- |
| Overlay opens from project    | PASS   | 2026-04-08    | Purple "A" icon in header                         |
| Session creation (IN_PROJECT) | PASS   | 2026-04-08    | Auto-creates on overlay open                      |
| read_topology tool            | PASS   | 2026-04-08    | Shows agents, types, handoffs with visual diagram |
| read_agent tool               | PASS   | 2026-04-08    | Reads and explains agent DSL code                 |
| health_check tool             | PASS   | 2026-04-08    | Shows compilation status per agent                |
| propose_modification tool     | PASS   | 2026-04-08    | Generates diff, stores pendingMutation            |
| Proposal accept flow          | PASS   | 2026-04-08    | After pendingMutation schema fix                  |
| apply_modification tool       | PASS   | 2026-04-08    | Updates agent in DB after accept                  |
| generate_agent tool           | PASS   | 2026-04-08    | Creates new agent (with LLM retry on bad syntax)  |
| Topology after changes        | PASS   | 2026-04-08    | Shows updated 6-agent topology                    |
| Changes/diff tab              | PASS   | 2026-04-08    | Visual diff with FULL/Visual/Code toggle          |

---

## Test Coverage Map

### Session & Overlay

- [x] Open overlay from project header — `Iteration 1 PASS`
- [x] IN_PROJECT session auto-created — `Iteration 1 PASS`
- [x] SmartWelcome shows project stats (agents, tools, health) — `Iteration 1 PASS`
- [x] Workflow chips (Add Agent, Debug Issue) — `Iteration 1 PASS`

### read_topology

- [x] Shows all agents with type/mode columns — `Iteration 1 PASS`
- [x] Visual topology diagram rendered — `Iteration 1 PASS`
- [x] Topology tab auto-opened — `Iteration 1 PASS`
- [x] Updated topology shows after adding agent — `Iteration 1 PASS`

### read_agent

- [x] Reads agent DSL code and explains configuration — `Iteration 1 PASS`
- [x] Shows correct agent name and goal — `Iteration 1 PASS`

### health_check

- [x] Batch compiles all agents — `Iteration 1 PASS`
- [x] Reports overall health percentage — `Iteration 1 PASS`
- [x] Shows per-agent compilation status — `Iteration 1 PASS`
- [x] Expandable rows for compilation details — `Iteration 1 PASS`

### propose_modification + accept

- [x] propose_modification reads current agent from DB — `Iteration 1 PASS`
- [x] Stores pendingMutation in session — `Iteration 1 PASS (after fix)`
- [x] Returns diff for UI rendering — `Iteration 1 PASS`
- [x] Changes tab opens with Visual diff — `Iteration 1 PASS`
- [x] Accept applies changes to DB — `Iteration 1 PASS`
- [x] Confirmation message after apply — `Iteration 1 PASS`
- [ ] Modify sends feedback to LLM — `Not tested`
- [ ] Reject discards changes — `Not tested`

### generate_agent

- [x] Creates new agent with valid ABL syntax — `Iteration 1 PASS (with LLM retry)`
- [x] Agent appears in project agent list — `Iteration 1 PASS`
- [x] Agent count updates from 5 to 6 — `Iteration 1 PASS`
- [x] Post-creation fix proposal accepted — `Iteration 1 PASS`

### compile_abl

- [x] Validates ABL YAML against real compiler — `Iteration 1 PASS (via health_check)`
- [ ] Direct compile_abl call — `Not tested separately`

---

## Open Gaps

- **GAP-001**: Proposal Modify flow (send feedback, LLM re-proposes) not tested
  - **Severity**: Medium

- **GAP-002**: Proposal Reject flow not tested
  - **Severity**: Low

- **GAP-003**: run_test tool not tested (test agent with message)
  - **Severity**: Medium

- **GAP-004**: query_traces tool not tested
  - **Severity**: Low

---

## Iteration Log

### Iteration 1 — 2026-04-08

**Scope**: All core in-project operations on Fitness Coach Bot 05
**Branch**: features/arch-ai
**Duration**: ~45min (including bug fix)
**Tested by**: Claude Code (agent)

#### Results

| #   | Test                             | Tool Used                     | Status           |
| --- | -------------------------------- | ----------------------------- | ---------------- |
| 1   | Read topology                    | read_topology                 | PASS             |
| 2   | Read agent (WorkoutPlanner)      | read_agent                    | PASS             |
| 3   | Health check                     | health_check                  | PASS             |
| 4   | Modify agent (add LIMITATIONS)   | propose_modification + accept | PASS (after fix) |
| 5   | Add new agent (InjuryPrevention) | generate_agent                | PASS (LLM retry) |
| 6   | Verify updated topology          | read_topology                 | PASS             |

#### Bugs Fixed

- **BUG-003**: `pendingMutation` not persisted — "There is no reviewed proposal waiting for a decision"
  - **File**: `packages/database/src/models/arch-session.model.ts`
  - **Root Cause**: The Mongoose `MetadataSchema` did not include a `pendingMutation` field. Mongoose strict mode (default) silently strips fields not in the schema during `$set` operations. So `sessionService.setPendingMutation()` wrote to MongoDB but the value was stripped, resulting in `null` when the session was read back for the `proposal_response` handler.
  - **Fix**: Added `pendingMutation: { type: Schema.Types.Mixed, default: null }` to `MetadataSchema` and `pendingMutation?: Record<string, unknown> | null` to `IArchSession` interface.
  - **Verified**: After rebuild + restart, propose_modification → accept flow works correctly.

#### Observations

- **LLM agent generation quality**: First `generate_agent` attempt produced invalid ABL syntax (wrong section names). The LLM detected the compiler error and self-corrected on retry. This is acceptable behavior — the compiler validation catches bad syntax, and the multi-turn loop allows recovery.
- **Health shows 0%**: All agents have compilation warnings (missing handoff targets). This is expected for agents generated during project creation — they don't have proper cross-agent handoff wiring.
- **SearchAI proxy errors**: `ECONNREFUSED` on port 3005 (SearchAI not running). Not relevant to Arch AI testing.

---

## Test Environment

Runtime: localhost:3112 (PM2, fork mode)
Studio: localhost:5173 (preview_start via .claude/launch.json)
MongoDB: localhost:27017/abl_platform (local, no auth)
Test project: Fitness Coach Bot 05 (6 agents after test)
Test method: Browser automation via Claude Preview tools
