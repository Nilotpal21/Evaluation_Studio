# Phase 4: LLD (Low-Level Design) Playbook

Plan the implementation in exact detail — files, phases, exit criteria. This is the final planning artifact before code is written, and the highest-risk planning document (5 review rounds minimum).

## Prerequisites

- Feature spec at `docs/features/<slug>.md` — **required**
- HLD at `docs/specs/<slug>.hld.md` — **required**
- Test spec at `docs/testing/<slug>.md` — recommended (can be created in parallel)
- For bugfix or regression work, `docs/sdlc-logs/<slug>/characterization.md` with reproduction artifact, target seam, and negative proof — **required before expanding the plan**
- For critical auth/isolation/compliance/privacy/retention/encryption work, verify the critical-feature gate is already satisfied in the Feature Spec and Test Spec before planning broad implementation phases

## Workflow

### Step 1: Read Prerequisites

1. Read the feature spec: `docs/features/<slug>.md`
2. Read the HLD: `docs/specs/<slug>.hld.md`
3. Read the test spec: `docs/testing/<slug>.md`
4. Read the previous phase's `## Phase Handoff Packet` from `docs/sdlc-logs/<slug>/hld.log.md`
5. Read the previous phase's `## Phase Handoff Packet` from `docs/sdlc-logs/<slug>/test-spec.log.md`
6. Read the characterization artifact if this is a bugfix/regression: `docs/sdlc-logs/<slug>/characterization.md`
7. Read relevant source code — identify exact files, functions, and types that will be modified
8. Check `docs/plans/` for related implementation plans

### Step 2: Ask Clarifying Questions

Ask 3-5 questions per area. Use the [Decision Classification Protocol](pipeline.md#decision-classification-protocol) (ANSWERED/INFERRED/DECIDED/AMBIGUOUS) to handle answers. Log all classifications to `docs/sdlc-logs/<slug>/lld.log.md`.

**Implementation Strategy**

- Preferred implementation order (data layer first? API first? UI first)?
- Existing codebase patterns to follow?
- Should this be behind a feature flag?
- Acceptable scope for phase 1 vs later phases?
- Hard deadlines driving the phasing?

**Technical Details**

- Which specific files need modification vs creation?
- Testing strategy — test-first or test-after?
- Type definitions or interfaces that need to change?
- Database migration strategy (if applicable)?
- Performance-sensitive paths that need special attention?
- If the feature imports or references assets, which standard list pages, contextual authoring surfaces, and runtime materialization paths must be updated or intentionally left alone?

**Risk & Dependencies**

- Other ongoing changes that could conflict?
- Biggest implementation risk?
- Team dependencies (who needs to review/approve)?
- Monitoring/alerting needed before rollout?
- Definition of done for the whole feature?

**Activation, Reachability & Wiring**

- Which production entry point, mount path, import chain, or caller path must be updated?
- What is the narrowest wiring proof that will show the feature is reachable after implementation?
- Which files enforce runtime materialization versus design-time visibility?
- What should remain intentionally unwired or local-only?

### Step 3: Generate the LLD

Create `docs/plans/<date>-<slug>-impl-plan.md` with this structure:

#### 1. Design Decisions

- **Decision log**: Table with decision, rationale, alternatives rejected
- **Key interfaces & types**: TypeScript interfaces/types being created or modified
- **Module boundaries**: Modules, responsibilities, dependencies

#### 2. File-Level Change Map

**New Files:**

| File                  | Purpose     | LOC Estimate |
| --------------------- | ----------- | ------------ |
| `path/to/new-file.ts` | Description | ~100         |

**Modified Files:**

| File                  | Change Description | Risk         |
| --------------------- | ------------------ | ------------ |
| `path/to/existing.ts` | What changes       | Low/Med/High |

**Deleted Files** (if any):

| File | Reason |
| ---- | ------ |

**Rules:**

- File paths must be exact (not "somewhere in packages/database")
- Every file must map to an implementation phase
- For imported/referenced asset features, enumerate both the design-time caller surfaces and the runtime materialization / resolution files that enforce the documented semantics

#### 3. Implementation Phases

Each phase MUST be independently deployable and testable.

For each phase:

```markdown
### Phase N: <Name>

**Goal**: <one sentence>

**Tasks**:
N.1. <specific task — completable in one session>
N.2. <specific task>
N.3. <specific task>

**Files Touched**:

- `path/to/file.ts` — <what changes>

**Exit Criteria**:

- [ ] <measurable condition — NOT "it works">
- [ ] <e.g., "All 5 unit tests for FooRepository pass">
- [ ] <e.g., "pnpm build --filter=@abl/database succeeds with 0 errors">

**Test Strategy**:

- Unit: <what gets unit tested>
- Integration: <what gets integration tested>

**Rollback**: <how to revert this phase>
```

**Rules:**

- Minimum 2 phases (even small features benefit from data-then-API layering)
- Exit criteria must be measurable (not "it works" or "tests pass")
- Every task must be completable in one session
- Every phase must have a rollback strategy

#### 4. Wiring Checklist & Reachability Evidence

This prevents the #1 failure mode: writing code that nothing calls.

Every checked item must cite planned proof: mount trace, import trace, caller path, build entry, runtime registration, or equivalent evidence. A checked box without planned proof is incomplete.

- [ ] New service registered in DI container / module exports
- [ ] New routes registered in router file
- [ ] New models added to package index
- [ ] New types exported from package index
- [ ] New middleware added to middleware chain
- [ ] New workers registered in worker startup
- [ ] UI components imported and rendered in parent components
- [ ] New API endpoints documented
- [ ] Imported / referenced assets appear in the intended contextual authoring surfaces
- [ ] Standard inventory pages intentionally include or exclude imported / referenced assets, and that behavior is documented
- [ ] Deploy / runtime materialization path for imported / referenced assets is explicitly wired (resolver, snapshot, registry, cache, etc.)

#### 5. Cross-Phase Concerns

- Database migrations across phases
- Feature flags (if applicable)
- Configuration changes (new env vars, config keys)

#### 6. Acceptance Criteria (Whole Feature)

- [ ] All phases complete with exit criteria met
- [ ] E2E tests from test spec passing
- [ ] Integration tests from test spec passing
- [ ] No regressions in existing tests
- [ ] Feature spec updated with implementation details
- [ ] Testing matrix updated with actual coverage

#### 7. Open Questions

### Step 4: Validate

1. Every FR from the feature spec maps to at least one implementation task
2. Every phase has measurable exit criteria
3. Wiring checklist is complete
4. E2E and integration scenarios from test spec are coverable after all phases
5. If the feature imports or references assets, the plan covers both control-plane visibility and runtime materialization paths
6. Production reachability thinking is explicit: intended entry point, caller chain, and proof obligations are named
7. Bugfix characterization and the critical-feature gate remain reflected when applicable

### Step 5: Review (5 Rounds — Highest Risk)

The LLD directly drives what gets built. It needs the most review.

| Round | Focus                   | What to Check                                             |
| ----- | ----------------------- | --------------------------------------------------------- |
| 1     | Architecture compliance | Isolation, auth, stateless, traceability patterns         |
| 2     | Pattern consistency     | Matches existing code, no reinvention                     |
| 3     | Completeness            | Every FR covered, file paths verified, signatures checked |
| 4     | Cross-phase consistency | LLD implements HLD, covers test spec scenarios            |
| 5     | Final sweep             | Task independence, wiring checklist, domain rules         |

**Rules:**

- Fix ALL CRITICAL findings per round
- Fix HIGH findings where feasible
- After round 5: proceed even if MEDIUM findings remain (log them)
- If CRITICAL findings persist after round 5: STOP and escalate
- Every round emits the standard review output contract from [pipeline.md — Review Round Output Contract](pipeline.md#review-round-output-contract)

**For AI agents**: Clear context after round 3 to prevent quality degradation in rounds 4-5.

### Step 6: Commit & Log

1. Commit: `[ABLP-2] docs(<scope>): add <feature-name> LLD + implementation plan`
2. Log to `docs/sdlc-logs/<slug>/lld.log.md`:
   - All review findings per round with resolutions
3. Append the standard `## Phase Handoff Packet` to `docs/sdlc-logs/<slug>/lld.log.md` using the template from [pipeline.md — Phase Handoff Packet](pipeline.md#phase-handoff-packet)
4. Update `<package>/agents.md` for each package touched — append learnings (file-level surprises, signatures differing from docs, technical debt found). See [pipeline.md — Package Learnings](pipeline.md#package-learnings-agentsmd) for details.
   - If a package has no `agents.md`, create one with a heading and the first entry
   - If learnings span multiple packages, also append to `docs/sdlc-logs/agents.md`

## Context Management

See [pipeline.md — Context Management](pipeline.md#context-management) for the full rules. Key points for this phase:

- After writing the LLD to disk, re-read it if you need to reference it — don't rely on memory
- Spawn oracle and auditor as separate operations with fresh context
- LLD has 5 review rounds — **clear context after round 3** to prevent degradation in rounds 4-5
- Summarize fixes in 3-5 bullets between each round
- After committing, clear/compress context before implementation begins

## Quality Principles

This phase is governed by the [Quality Principles](pipeline.md#quality-principles) defined in the pipeline reference. In particular:

- **No Shortcuts**: Exit criteria must be measurable (not "it works"). File paths must be exact (not "somewhere in packages/"). Every task must be implementable in one session. The wiring checklist must be complete — unwired code is unshipped code. No TODO stubs — if something is deferred, it goes in the LLD with a phase assignment.
- **Test Integrity**: The test strategy per phase must specify real service boundaries, not mocked layers. E2E test tasks must require real servers with full middleware, not mocked infrastructure. Integration test tasks must test actual service-to-service interactions, not stubbed responses.

## Output Checklist

- [ ] LLD at `docs/plans/<date>-<slug>-impl-plan.md`
- [ ] 2+ implementation phases with exit criteria
- [ ] File-level change map with exact paths
- [ ] Wiring checklist filled
- [ ] Acceptance criteria defined
- [ ] 5 review rounds completed
- [ ] Phase Handoff Packet appended to the phase log
- [ ] `agents.md` updated for each package touched
- [ ] Committed to version control

## Next Phase

Proceed to [Phase 5: Implementation](implement-playbook.md).
