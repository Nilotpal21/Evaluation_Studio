---
name: post-impl-sync
description: After feature implementation or major changes, sync all documentation — update feature spec, testing matrix, test spec coverage status, and HLD/LLD status. Run after commits.
---

# Post-Implementation Doc Sync

> **Playbook**: [`docs/sdlc/post-impl-sync-playbook.md`](docs/sdlc/post-impl-sync-playbook.md) | **Pipeline**: [`docs/sdlc/pipeline.md`](docs/sdlc/pipeline.md)

## Purpose

After a feature is implemented or a major change is committed, this skill synchronizes all documentation artifacts. Ensures feature specs, test specs, testing matrices, and design docs reflect the actual state of the code.

## Trigger

User invokes `/post-impl-sync <feature-name>` after implementation work.

## Workflow

### Phase 1: Inventory

1. **Identify what changed**: Run `git diff --name-only HEAD~<N>..HEAD` (or compare against main) to see all changed files
2. **Find all related docs** for this feature:
   - Feature spec: `docs/features/<slug>.md`
   - Test spec: `docs/testing/<slug>.md`
   - HLD: `docs/specs/<slug>.hld.md`
   - LLD/Plan: `docs/plans/*<slug>*`
3. **Read each doc** to understand what was planned vs what was implemented

### Phase 2: Feature Spec Sync

Update `docs/features/<slug>.md`:

- **§8 How to Consume**: Update API endpoints, UI routes, admin pages to reflect actual implementation
- **§9 Data Model**: Update collections, fields, indexes to match actual schema
- **§10 Key Implementation Files**: Update file paths and purposes — add new files, remove deleted ones
- **§11 Configuration**: Update env vars, runtime config, DSL references
- **§16 Gaps, Known Issues**: Move completed items to "Mitigated", add any new gaps discovered during implementation
- **§17 Testing & Validation**: Update test coverage status based on actual tests written
- **Status field**: Evaluate transition criteria from `docs/features/AUTHORING_GUIDE.md` §6 and update:
  - PLANNED → ALPHA: if implementation phases complete, core happy path works, at least 1 E2E or manual walkthrough
  - ALPHA → BETA: if E2E tests passing (3+), integration tests passing (3+), all CRITICAL gaps resolved, PR review done
  - BETA → STABLE: if full test coverage (5+ E2E, 5+ integration), no CRITICAL/HIGH gaps, security tests passing, production soak
  - Never skip a status level (PLANNED → STABLE is not allowed)

### Phase 3: Test Spec Sync

Update `docs/testing/<slug>.md`:

- **Coverage Matrix**: Update ✅/❌ for each FR based on actual test files
- **E2E scenarios**: Mark which ones have actual test files, which are still planned
- **Integration scenarios**: Same — mark actual coverage vs planned
- **Test File Mapping**: Update with actual test file paths
- **Status**: Update to match feature status (PLANNED → IN PROGRESS for ALPHA features, PARTIAL for BETA, STABLE for STABLE)
- **Last Updated**: Set to today's date

### Phase 4: Testing Index Sync

Update `docs/testing/README.md`:

- Update "Coverage Status" column for this feature
- Update "Last Updated" column

### Phase 5: Design Doc Sync

Update `docs/specs/<slug>.hld.md` and `docs/plans/*<slug>*`:

- **Status**: Update from DRAFT → APPROVED or IN PROGRESS → DONE
- **Open Questions**: Resolve any that were answered during implementation
- Add a "Post-Implementation Notes" section if significant deviations from the plan occurred

### Phase 6: Summary Report

Output a summary:

```
## Post-Implementation Sync: <Feature Name>

### Documents Updated
- [ ] Feature spec: `docs/features/<slug>.md` — <what changed>
- [ ] Test spec: `docs/testing/<slug>.md` — <what changed>
- [ ] Testing index: `docs/testing/README.md` — <what changed>
- [ ] HLD: `docs/specs/<slug>.hld.md` — <what changed>
- [ ] LLD: `docs/plans/<slug>` — <what changed>

### Coverage Delta
| Type | Before | After |
|------|--------|-------|
| Unit tests | X | Y |
| Integration tests | X | Y |
| E2E tests | X | Y |

### Remaining Gaps
- <any gaps that still need attention>

### Deviations from Plan
- <any significant differences between plan and implementation>
```

### Phase 6b: Audit (1 round — verification pass)

Spawn the **phase-auditor** agent:

```
Audit this post-implementation sync.
Phase: POST-IMPL-SYNC
Feature spec: docs/features/<slug>.md
Test spec: docs/testing/<slug>.md
HLD: docs/specs/<slug>.hld.md
LLD: docs/plans/*<slug>*
Round: 1 of 1
```

The auditor verifies:

- Coverage matrix ✅/❌ matches actual test files
- File paths in feature spec actually exist
- Status fields are consistent across all docs
- Deviations from plan are documented

If NEEDS_REVISION: fix findings before committing. This is the last gate before the feature is marked complete.

### Phase 7: Commit & Log

1. **Commit all doc updates**: `git add docs/features/ docs/testing/ docs/specs/ docs/plans/` and commit with message: `[ABLP-2] docs(<scope>): post-impl sync for <feature-name>`
2. **Log the sync** to `docs/sdlc-logs/<slug>/post-impl-sync.log.md`:
   - What was updated, coverage delta, deviations from plan
3. **Update agents.md** for EACH package touched during implementation:
   - Append to `<package>/agents.md` with package-specific learnings:
     - Patterns that worked well or failed in that package
     - Architectural decisions that changed during implementation
     - Testing gaps discovered
     - Gotchas for future agents working in this package
   - If learnings span multiple packages, also append to `docs/sdlc-logs/agents.md`
   - If a package has no `agents.md`, create one using the standard template

## Context Management

CRITICAL: Post-impl-sync reads many files (feature spec, test spec, HLD, LLD, git diffs, test files). Manage context actively.

**During this skill:**

- Read files on demand — do NOT read all docs upfront. Read each doc just before updating it.
- Spawn the phase-auditor as a **separate Agent tool invocation** with fresh context.
- After writing updates to each doc, the content is persisted on disk. Do not keep full file contents in working memory.

**After this skill completes:**

- This is the final SDLC phase. Run `/compact` after committing to clean up for the next task.
- The conversation will have accumulated context from implementation + doc sync — compacting prevents stale context from influencing future work.

## Quality Gates

> Governed by the [Quality Principles](docs/sdlc/pipeline.md#quality-principles). No shortcuts — robust & architecturally sound. Test integrity — no mocking codebase components.

- MUST read git diff to understand what actually changed — don't guess
- MUST update ALL related docs (feature spec, test spec, testing index, design docs)
- MUST update test coverage matrix with actual ✅/❌ based on real test files
- MUST update implementation file paths to reflect actual file locations
- MUST update status fields (PLANNED → IN PROGRESS → STABLE)
- MUST report deviations from the original plan
- MUST NOT invent coverage that doesn't exist — if a test file isn't there, mark ❌
- Docs must reflect reality, not aspirations — if implementation was partial, document what actually shipped
- A test that mocks the component under test does NOT count as coverage — mark it ❌, not ✅
- Only tests that exercise real service boundaries (integration) or real HTTP API with full middleware (E2E) count toward their respective coverage columns
