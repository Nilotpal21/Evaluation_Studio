# Phase 5: Implementation Playbook

Execute the LLD implementation plan phase-by-phase. Write code, verify exit criteria, review, and commit.

## Prerequisites

- LLD at `docs/plans/<date>-<slug>-impl-plan.md` — **required** (run Phase 4 first if missing)
- Feature spec, HLD, and test spec should all exist
- Clean working tree (`git status` shows no uncommitted changes)

## Workflow

### Step 1: Read the Plan

Read everything fresh from disk. Do NOT rely on memory from prior phases.

1. Read the LLD and extract:
   - All implementation phases with tasks
   - Exit criteria for each phase
   - File-level change map (new files, modified files)
   - Wiring checklist
   - Acceptance criteria
2. Read the feature spec, test spec, and HLD for context
3. Read the previous phase's `## Phase Handoff Packet` from `docs/sdlc-logs/<slug>/lld.log.md`
4. Run `git status` and `git log --oneline -5` to confirm clean state
5. Create the log file: `docs/sdlc-logs/<slug>/implementation.log.md`

### Step 2: Preflight Validation

Before writing any code, verify the LLD is still current:

1. **Verify file paths**: Confirm files listed in the LLD change map exist at those paths
2. **Verify signatures**: For modified files, read the functions/types the LLD plans to change and confirm they match
3. **Check for recent changes**: `git log --oneline --since="1 week ago" -- <paths from LLD>` to detect conflicts
4. **If stale**: Log discrepancies and decide whether to proceed with adjustments or update the LLD

Log preflight results to `docs/sdlc-logs/<slug>/implementation.log.md`.

### Step 3: Execute LLD Phases

Execute each phase sequentially. For each phase:

#### 3a. Start the Phase

1. Log phase start to `docs/sdlc-logs/<slug>/implementation.log.md`
2. Re-read the phase tasks from the LLD (don't rely on memory)
3. Announce: "Starting Phase N: <name> — <goal>"

#### 3b. Implement

For each task within the phase:

1. **Read before writing**: Before using any existing component/function/type, READ its source file to verify the actual signature. Never guess prop names or parameter types.
2. **Implement the task** following the LLD specification
3. **Follow codebase conventions**: Read CLAUDE.md for project-specific rules (logging patterns, error handling, Zod validation, etc.)
4. **Build incrementally**: After creating/modifying files, run `pnpm build --filter=<package>` to catch type errors immediately
5. **Run relevant tests**: If the phase has a test strategy, run those tests
6. **No shortcuts**: Implement the architecturally correct solution. No TODO stubs.

#### 3c. Finish the Phase

1. **Verify exit criteria**: Check every exit criterion from the LLD
   - Run the specific build commands listed
   - Run the specific test commands listed
   - Verify any other measurable conditions
2. **If exit criteria fail**: Fix the issues. Do not move to the next phase.
3. **Format changed files**: `npx prettier --write <files>`
4. **Commit**: One commit per LLD phase:
   `[ABLP-2] <type>(<scope>): <feature> phase N - <phase description>`
5. **Log completion** to `docs/sdlc-logs/<slug>/implementation.log.md`:
   - Tasks completed, files changed, exit criteria results, deviations from LLD

#### 3d. Repeat

Continue with the next LLD phase. Re-read the LLD from disk between phases.

**For AI agents**: Clear context between phases — the code is committed, the LLD is on disk, nothing needs to stay in memory.

### Step 4: Wiring Verification

After all LLD phases are complete:

1. Read the LLD wiring checklist from disk
2. Verify every wiring item:
   - New services registered in DI / module exports
   - New routes registered in router files
   - New models added to index files
   - New types exported from package index
   - UI components imported and rendered in parent components
   - New API endpoints documented
3. Fix any missing wiring — this is the #1 failure mode
4. Commit wiring fixes separately if needed

### Step 5: Code Review (5 Rounds)

After all phases + wiring are complete, run 5 rounds of code review:

| Round | Focus                | What to Check                                                                        |
| ----- | -------------------- | ------------------------------------------------------------------------------------ |
| 1     | Code quality         | Types correct, error handling present, logging follows conventions, style consistent |
| 2     | HLD compliance       | Implementation matches the architecture, isolation patterns, auth middleware         |
| 3     | Test coverage        | E2E and integration scenarios from test spec covered in actual test files            |
| 4     | Security & isolation | Tenant/project/user isolation, auth checks, input validation, no injection           |
| 5     | Production readiness | Performance under load, observability hooks, failure modes, edge cases               |

**Every review round must emit the standard output contract from [pipeline.md — Review Round Output Contract](pipeline.md#review-round-output-contract):**

- Blocking Findings
- Why They Matter
- Exact Fixes Required
- Retry Packet

**Review process:**

1. Emit the review output contract for the round
2. After each round: fix ALL CRITICAL findings, fix HIGH findings where feasible
3. Format and commit fixes: `[ABLP-2] fix(<scope>): address review round N findings`
4. Summarize what was fixed (3-5 bullets) before the next round
5. Each review round reads the code fresh — don't carry forward prior findings
6. After round 5: proceed even if MEDIUM findings remain (log them)
7. If CRITICAL findings persist after round 5: STOP and escalate to the user

**For AI agents**: Clear context after round 3.

### Step 6: Acceptance Verification

After reviews pass:

1. Read the LLD acceptance criteria from disk
2. Verify each criterion:
   - All phases complete with exit criteria met
   - E2E tests from test spec passing
   - Integration tests from test spec passing
   - No regressions: `pnpm build && pnpm test` (or scoped to affected packages)
   - Feature spec implementation files are accurate
3. Log results to `docs/sdlc-logs/<slug>/implementation.log.md`
4. If any criterion fails: fix and re-verify

### Step 7: Final Commit & Log

1. Final commit if any remaining changes (format with prettier)
2. Update `docs/sdlc-logs/<slug>/implementation.log.md` with:
   - Summary: phases completed, total commits, files changed
   - Deviations from LLD
   - Review findings summary (rounds, resolved, deferred)
   - Acceptance criteria results
3. Append the standard `## Phase Handoff Packet` to `docs/sdlc-logs/<slug>/implementation.log.md` using the template from [pipeline.md — Phase Handoff Packet](pipeline.md#phase-handoff-packet)
4. Append learnings to `<package>/agents.md` for each package touched

## Context Management

See [pipeline.md — Context Management](pipeline.md#context-management) for the full rules. Key points for this phase:

- **Between LLD phases**: Re-read the LLD from disk after each phase — the code is committed, nothing needs to stay in memory
- **Between review rounds**: Each reviewer reads the code fresh. Summarize fixes in 3-5 bullets between rounds. **Clear context after round 3.**
- **When spawning parallel workers**: Each worker reads all inputs from disk. Include: "Read all inputs fresh from disk. Do not assume any prior context."
- After the final commit, clear/compress context before post-impl-sync

## Quality Principles

This phase is governed by the [Quality Principles](pipeline.md#quality-principles) defined in the pipeline reference. In particular:

- **No Shortcuts**: Implement the architecturally correct solution, not the easy path. If the correct solution requires setting up encryption, key generation, or concurrency harnesses, do it properly. No TODO stubs in committed code. No skipped validation. No hard-coded values where config should be used. Follow established patterns — read existing code before writing new code.
- **Test Integrity**: E2E tests must NOT mock any codebase components (`vi.mock()`/`jest.mock()` are forbidden). Only external third-party services may be mocked, and only via dependency injection. Integration tests must NOT mock the components under test. Use real servers on random ports with full middleware chain. Seed data via API, assert via API — never import DB models directly. Include structured content types in test data, not just plain strings. No TODO stubs in test files.

## Implementation Log Template

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

## Output Checklist

- [ ] All LLD phases implemented and committed (one commit per phase)
- [ ] Wiring verification complete
- [ ] 5 review rounds completed
- [ ] All acceptance criteria met
- [ ] Implementation log complete at `docs/sdlc-logs/<slug>/implementation.log.md`
- [ ] Phase Handoff Packet appended to the phase log
- [ ] Package `agents.md` files updated

## Next Phase

Proceed to [Phase 6: Post-Impl Sync](post-impl-sync-playbook.md).
