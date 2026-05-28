---
name: implement
description: Execute an LLD implementation plan phase-by-phase. Reads the LLD, verifies exit criteria per phase, runs pr-reviewer audit, compacts between phases. Logs to docs/sdlc-logs/.
---

# Implementation Executor

> **Playbook**: [`docs/sdlc/implement-playbook.md`](docs/sdlc/implement-playbook.md) | **Pipeline**: [`docs/sdlc/pipeline.md`](docs/sdlc/pipeline.md)

## Purpose

Executes an LLD implementation plan phase-by-phase with structured review, context management, and progress logging. This is Phase 5 of the SDLC pipeline — the bridge between planning (LLD) and documentation (post-impl-sync).

## Trigger

User invokes `/implement <feature-name>`.

## Workflow

### Phase 0: Read Prerequisites

CRITICAL: Read everything fresh from disk. Do NOT rely on in-memory context from prior SDLC phases.

1. **Find the LLD**: Search `docs/plans/*<feature>*` for the implementation plan
2. **If no LLD exists**: STOP and tell the user to run `/lld` first. Implementation without a plan produces drift.
3. **Find the feature spec**: Read `docs/features/<feature>.md`
4. **Find the test spec**: Read `docs/testing/<feature>.md`
5. **Find the HLD**: Read `docs/specs/<feature>.hld.md` (if it exists)
6. **Read the LLD thoroughly** — extract:
   - All implementation phases with their tasks
   - Exit criteria for each phase
   - File-level change map (new files, modified files)
   - Wiring checklist
   - Acceptance criteria for the whole feature
7. **Check for conflicts**: Run `git status` and `git log --oneline -5` to ensure the working tree is clean and the branch is current
8. **Create the implementation log**: `docs/sdlc-logs/<slug>/implementation.log.md`

### Phase 1: Preflight Validation

Before writing any code, validate the LLD is still current:

1. **Verify file paths**: Glob/Grep to confirm files listed in the LLD change map still exist at those paths
2. **Verify signatures**: For modified files, read the functions/types the LLD plans to change and confirm they still match what the LLD describes
3. **Check for recent changes**: `git log --oneline --since="1 week ago" -- <paths from LLD>` to detect if someone else modified the target files
4. **If stale**: Log the discrepancies and ask the user whether to proceed with adjustments or re-run `/lld`

**Spawn a product-oracle agent** to answer any ambiguities:

- Pass: "Validate the LLD at <path> is still current. Check file paths exist, function signatures match, no recent conflicting changes."
- If AMBIGUOUS items found: present to user and wait
- If all clear: proceed

**Log preflight results** to `docs/sdlc-logs/<slug>/implementation.log.md`.

### Phase 2: Execute LLD Phases

Execute each LLD phase sequentially. For each phase:

#### 2a. Phase Start

1. **Log phase start** to `docs/sdlc-logs/<slug>/implementation.log.md`
2. **Read the phase tasks** from the LLD fresh (re-read the file — context may have been compacted)
3. **Announce** to the user: "Starting Phase N: <name> — <goal>"

#### 2b. Implementation

For each task within the phase:

1. **Read before writing**: BEFORE using any existing component/function/type, READ its source file to verify the actual signature. Never guess prop names or parameter types.
2. **Implement the task**: Write code following the LLD specification
3. **Follow AGENTS.md rules**: No console.log, no `any`, no `.catch(() => {})`, Zod `z.string().min(1)` for IDs, error envelope format, etc.
4. **Run builds incrementally**: After creating or modifying files, run `pnpm build --filter=<package>` to catch type errors immediately
5. **Run relevant tests**: If the phase has a test strategy, run those tests
6. **No shortcuts**: Implement the architecturally correct solution, not the easy path. No TODO stubs.

**When spawning implementer agents** for parallel subtasks, include:

- "Read all inputs fresh from disk. Do not assume any prior context."
- "BEFORE using any existing component/function/type, READ its source file to verify the actual signature."
- "Run `npx prettier --write <files>` on ALL changed files before finishing your task."
- "E2E tests must NOT mock existing components. See AGENTS.md E2E Test Standards."
- "Implement a robust, architecturally sound solution. No shortcuts, no quick hacks, no TODO stubs."

#### 2c. Phase Exit

1. **Verify exit criteria**: Check every exit criterion from the LLD for this phase
   - Run the specific build commands listed
   - Run the specific test commands listed
   - Verify any other measurable conditions
2. **If exit criteria fail**: Fix the issues. Do not move to the next phase with failures.
3. **Format all changed files**: `npx prettier --write <files>`
4. **Commit the phase**: One commit per LLD phase with message format:
   `[ABLP-2] <type>(<scope>): <feature> phase N - <phase description>`
5. **Log phase completion** to `docs/sdlc-logs/<slug>/implementation.log.md`:
   - Tasks completed, files changed, exit criteria results, any deviations from LLD
6. **Run `/compact`** to clear context before starting the next phase

#### 2d. Repeat

Continue with the next LLD phase. Re-read the LLD from disk after compact.

### Phase 3: Wiring Verification

After all LLD phases are complete:

1. **Read the LLD wiring checklist** from disk
2. **Verify every wiring item**:
   - New services registered in DI / module exports
   - New routes registered in router files
   - New models added to index files
   - New types exported from package index
   - UI components imported and rendered in parent components
   - New API endpoints documented
3. **Fix any missing wiring** — this is the #1 agent failure mode
4. **Commit wiring fixes** separately if needed

### Phase 4: Review Loop (5 rounds minimum)

Spawn the **pr-reviewer** agent for structured code review.

**Round structure:**

| Round | Focus                                                                        | Reviewer    |
| ----- | ---------------------------------------------------------------------------- | ----------- |
| 1     | Code quality — types, error handling, logging, style                         | pr-reviewer |
| 2     | HLD compliance — does the implementation match the architecture?             | pr-reviewer |
| 3     | Test coverage — are E2E and integration scenarios from test spec covered?    | pr-reviewer |
| 4     | Security & isolation — tenant/project/user isolation, auth, input validation | pr-reviewer |
| 5     | Production readiness — performance, observability, failure modes, edge cases | pr-reviewer |

**Review feedback loop:**

1. After each round: fix ALL CRITICAL findings, fix HIGH findings where feasible
2. Format and commit fixes: `[ABLP-2] fix(<scope>): address pr-review round N findings`
3. Briefly summarize what was fixed (3-5 bullet points) before spawning the next round
4. Each reviewer reads the code fresh from disk — do NOT pass prior round findings forward
5. **Run `/compact` after round 3** to prevent degradation in rounds 4-5
6. After round 5: proceed even if MEDIUM findings remain (log them)
7. If CRITICAL findings persist after round 5: STOP and escalate to user

**Log all review findings** to `docs/sdlc-logs/<slug>/implementation.log.md` — include round number, verdict, findings, and resolutions.

### Phase 5: Acceptance Verification

After reviews pass:

1. **Read the LLD acceptance criteria** from disk
2. **Verify each criterion**:
   - All phases complete with exit criteria met
   - E2E tests from test spec passing
   - Integration tests from test spec passing
   - No regressions: `pnpm build && pnpm test` (or scoped to affected packages)
   - Feature spec implementation files are accurate
3. **Log acceptance results** to `docs/sdlc-logs/<slug>/implementation.log.md`
4. **If any criterion fails**: Fix and re-verify. Do not proceed with failures.

### Phase 6: Commit & Log

1. **Final commit** (if any remaining changes): format with prettier, commit
2. **Update the implementation log** with:
   - Summary: phases completed, total commits, files changed
   - Deviations from LLD (if any)
   - Review findings summary (rounds, findings resolved, findings deferred)
   - Acceptance criteria results
3. **Update agents.md** for each package touched:
   - Append learnings to `<package>/agents.md`
   - If learnings span multiple packages, append to `docs/sdlc-logs/agents.md`
   - If a package has no `agents.md`, create one using the standard template
4. **Next phase**: Tell the user to run `/post-impl-sync <feature-name>` to update all documentation

## Context Management

CRITICAL: Implementation is the longest-running SDLC phase. Context management is essential.

**Between LLD phases:**

- Run `/compact` after committing each phase. The next phase re-reads the LLD from disk.
- Each phase starts fresh — the code changes are on disk, the LLD is on disk, nothing needs to stay in memory.

**Between review rounds (5 rounds):**

- Spawn every pr-reviewer as a **separate Agent tool invocation** with fresh context.
- After resolving findings from round N, summarize fixes in 3-5 bullets before spawning round N+1.
- Do NOT carry forward full review report text.
- **Run `/compact` after round 3** to prevent degradation in rounds 4-5.

**When spawning sub-agents for parallel implementation:**

- Each agent gets a single LLD task or small group of related tasks.
- Include: "Read all inputs fresh from disk. Do not assume any prior context."
- Agents return their results; the main conversation integrates and commits.

**General principles:**

- Artifacts on disk are the source of truth — re-read rather than recall.
- If context feels large (many file reads, long audit reports), compact proactively.
- A fresh read of a 200-line LLD is cheaper than degraded output from stale context.

## Quality Gates

> Governed by the [Quality Principles](docs/sdlc/pipeline.md#quality-principles). No shortcuts — robust & architecturally sound. Test integrity — no mocking codebase components.

- MUST read the LLD before implementing — never implement from description alone
- MUST execute phases in LLD order — phases may have dependencies
- MUST verify exit criteria for each phase before moving on — no skipping
- MUST run `pnpm build --filter=<package>` after modifying files — catch type errors immediately
- MUST run `npx prettier --write <files>` before every commit
- MUST complete the wiring checklist — unwired code is unshipped code
- MUST run 5 review rounds minimum — implementation is the highest-risk phase
- MUST verify whole-feature acceptance criteria after all phases
- MUST log progress to `docs/sdlc-logs/<slug>/implementation.log.md`
- MUST commit per-phase, not one giant commit at the end
- MUST implement the architecturally correct solution, not the easy path — if the correct solution requires encryption, key generation, or concurrency harnesses, do it properly
- No TODO stubs in committed code — implement it or defer it in the LLD
- E2E tests must NOT mock any codebase components — `vi.mock()` / `jest.mock()` are FORBIDDEN in E2E tests
- Integration tests must NOT mock the components under test — mock only external dependencies outside the service boundary
- Only external third-party services (OpenAI, Stripe, SendGrid, etc.) may be mocked, and only via dependency injection — not `vi.mock()`
- Test files must use real servers on random ports with full middleware chain — seed data via API, assert via API
- Test files must include structured content types (arrays, objects, ContentBlock[]), not just plain strings
- No TODO stubs in test files — committed tests must have working infrastructure and assertions

## Implementation Log Template

The implementation log at `docs/sdlc-logs/<slug>/implementation.log.md` should follow this structure:

```markdown
# SDLC Log: <Feature> — Implementation Phase

**Feature**: <slug>
**Phase**: IMPLEMENTATION
**LLD**: `docs/plans/<lld-file>.md`
**Date Started**: <date>
**Date Completed**: <date or IN PROGRESS>

---

## Preflight

- [ ] LLD file paths verified
- [ ] Function signatures current
- [ ] No conflicting recent changes
- Discrepancies: <none or list>

## Phase Execution

### LLD Phase 1: <name>

- **Status**: DONE / IN PROGRESS / BLOCKED
- **Commit**: <hash>
- **Exit Criteria**: all met / <which failed>
- **Deviations**: <none or description>
- **Files Changed**: <count>

### LLD Phase 2: <name>

(same structure)

## Wiring Verification

- [ ] All wiring checklist items verified
- Missing wiring found: <none or list>

## Review Rounds

| Round | Verdict | Critical | High | Medium | Low |
| ----- | ------- | -------- | ---- | ------ | --- |
| 1     |         |          |      |        |     |
| 2     |         |          |      |        |     |
| 3     |         |          |      |        |     |
| 4     |         |          |      |        |     |
| 5     |         |          |      |        |     |

### Deferred Findings

- <any MEDIUM findings not resolved>

## Acceptance Criteria

- [ ] All LLD phases complete
- [ ] E2E tests passing
- [ ] Integration tests passing
- [ ] No regressions (pnpm build && pnpm test)
- [ ] Feature spec files accurate

## Learnings

- <package-specific or cross-cutting learnings>
```
