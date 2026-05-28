# Phase 6: Post-Implementation Sync Playbook

After implementation, sync all documentation to reflect what was actually built. This is the final SDLC phase — it ensures docs match reality.

## Prerequisites

- Implementation committed (Phase 5 complete)
- Feature spec, test spec, HLD, and LLD exist
- Git history showing what changed during implementation

## Workflow

### Step 1: Inventory

1. **Identify what changed**: Run `git diff --name-only main..HEAD` (or compare against the base branch) to see all changed files
2. **Find all related docs**:
   - Feature spec: `docs/features/<slug>.md`
   - Test spec: `docs/testing/<slug>.md`
   - HLD: `docs/specs/<slug>.hld.md`
   - LLD: `docs/plans/*<slug>*`
3. **Read the previous phase's `## Phase Handoff Packet`** from `docs/sdlc-logs/<slug>/implementation.log.md`
4. **Verify every referenced file path** with `rg --files` before copying it into inventories, gap tables, or implementation-file sections
5. **Read each doc** to understand what was planned vs what was implemented

### Step 2: Update Feature Spec

Update `docs/features/<slug>.md`:

| Section                      | What to Update                                                                                                                               |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| §8 How to Consume            | API endpoints, UI routes, admin pages, supported asset/entity surfaces, and design-time vs runtime behavior to reflect actual implementation |
| §9 Data Model                | Collections, fields, indexes to match actual schema                                                                                          |
| §10 Key Implementation Files | File paths and purposes — add new files, remove deleted ones                                                                                 |
| §11 Configuration            | Env vars, runtime config, DSL references                                                                                                     |
| §16 Gaps & Known Issues      | Move completed items to "Mitigated", add new gaps discovered during implementation                                                           |
| §17 Testing & Validation     | Update test coverage status based on actual tests written                                                                                    |

If the feature spec has API, route, or UI-surface tables, distinguish **implemented** from **wired/reachable**. A route file existing in source or a harness mounting a router is not enough if the production entry point still cannot reach it.

**Update the Status field** using the transition criteria from [pipeline.md](pipeline.md):

- **PLANNED → ALPHA**: Implementation phases complete, core happy path works, at least 1 E2E or manual walkthrough, `pnpm build` passes
- **ALPHA → BETA**: E2E tests passing (3+), integration tests passing (3+), all CRITICAL gaps resolved, review done
- **BETA → STABLE**: Full test coverage (5+ E2E, 5+ integration), no CRITICAL/HIGH gaps, security tests passing, production soak

Never skip a status level.

### Step 3: Update Test Spec

Update `docs/testing/<slug>.md`:

- **Coverage Matrix**: Update ✅/❌ for each FR based on actual test files
- **E2E Scenarios**: Mark which have actual test files, which are still planned
- **Integration Scenarios**: Same — mark actual coverage vs planned
- **Surface Semantics**: When the feature imports/reuses/references assets, document which asset types are visible where, which remain local-only, and how design-time bindings map to runtime behavior
- **Production Wiring Verification**: Add or refresh a section that checks the production entry point can reach the implemented behavior (router mounted, build/export surfaced, production caller exists)
- **Test File Mapping**: Update with actual test file paths
- **Coverage Claims**: If one deterministic public-API regression now exists, stop claiming "zero E2E coverage", but keep the overall guide status honest (`PARTIAL`) until the broader scenario family is covered
- **Status**: Match to feature status:
  - ALPHA feature → IN PROGRESS
  - BETA feature → PARTIAL
  - STABLE feature → STABLE
- **Last Updated**: Set to today's date

### Step 4: Update Testing Index

Update `docs/testing/README.md`:

- Update "Coverage Status" column for this feature
- Update "Last Updated" column

### Step 5: Update Design Docs

Update `docs/specs/<slug>.hld.md` and `docs/plans/*<slug>*`:

- **Status**: DRAFT → APPROVED, IN PROGRESS → DONE
- **Open Questions**: Resolve any that were answered during implementation
- **Wiring Evidence**: For any checklist item about mounting/registering/exporting, include evidence (mount trace, import trace, caller path, build entry) rather than "file exists"
- Add "Post-Implementation Notes" if there were significant deviations from the plan

### Step 6: Produce Summary Report

```markdown
## Post-Implementation Sync: <Feature Name>

### Documents Updated

- [ ] Feature spec: `docs/features/<slug>.md` — <what changed>
- [ ] Test spec: `docs/testing/<slug>.md` — <what changed>
- [ ] Testing index: `docs/testing/README.md` — <what changed>
- [ ] HLD: `docs/specs/<slug>.hld.md` — <what changed>
- [ ] LLD: `docs/plans/<slug>` — <what changed>

### Coverage Delta

| Type              | Before | After |
| ----------------- | ------ | ----- |
| Unit tests        | X      | Y     |
| Integration tests | X      | Y     |
| E2E tests         | X      | Y     |

### Remaining Gaps

- <any gaps that still need attention>

### Deviations from Plan

- <any significant differences between plan and implementation>
```

### Step 7: Verify

Run 1 verification round:

- [ ] Coverage matrix ✅/❌ matches actual test files
- [ ] File paths in feature spec actually exist (`rg --files`)
- [ ] API/UI tables distinguish implemented vs wired/reachable where relevant
- [ ] Surface semantics match the implementation: supported asset types, read-only vs editable states, local-only surfaces, and runtime materialization paths are explicit where relevant
- [ ] Production Wiring Verification is documented when reachability is a real risk
- [ ] Status fields are consistent across all docs
- [ ] Targeted public-API regressions are not overstated as full E2E coverage
- [ ] Deviations from plan are documented

### Step 8: Commit & Log

1. Commit: `[ABLP-2] docs(<scope>): post-impl sync for <feature-name>`
2. Log to `docs/sdlc-logs/<slug>/post-impl-sync.log.md`:
   - What was updated, coverage delta, deviations from plan
3. Append the standard `## Phase Handoff Packet` to `docs/sdlc-logs/<slug>/post-impl-sync.log.md` using the template from [pipeline.md — Phase Handoff Packet](pipeline.md#phase-handoff-packet)
4. Append learnings to `<package>/agents.md` for each package touched

## Context Management

See [pipeline.md — Context Management](pipeline.md#context-management) for the full rules. Key points for this phase:

- Read files on demand — do NOT read all docs upfront. Read each doc just before updating it.
- Spawn the auditor as a separate operation with fresh context
- This is the final SDLC phase — clear/compress context after committing

## Quality Principles

This phase is governed by the [Quality Principles](pipeline.md#quality-principles) defined in the pipeline reference. In particular:

- **No Shortcuts**: Docs must reflect reality, not aspirations. If a feature was partially implemented, document what actually shipped — don't claim completeness. If implementation deviated from the plan, document the deviations explicitly.
- **Production reachability is separate from code existence**: A green harness E2E or a route file on disk does not prove the feature is wired from the production entry point. Document unwired code as unwired until that reachability is verified.
- **Test Integrity**: Coverage matrix must be honest. A test that mocks the component under test does not count as coverage — mark it ❌, not ✅. Only tests that exercise real service boundaries (integration) or real HTTP API with full middleware (E2E) count toward their respective columns.

## Output Checklist

- [ ] Feature spec updated (status, implementation files, gaps)
- [ ] Test spec updated (coverage matrix, test file mapping, status)
- [ ] Testing README updated (coverage status, last updated)
- [ ] HLD updated (status, open questions resolved)
- [ ] LLD updated (status)
- [ ] Summary report produced
- [ ] Verification pass complete
- [ ] Phase Handoff Packet appended to the phase log
- [ ] Committed to version control

## Feature Complete

After this phase, the feature is at ALPHA status (at minimum). To progress to BETA and STABLE, see the transition criteria in [pipeline.md](pipeline.md).
