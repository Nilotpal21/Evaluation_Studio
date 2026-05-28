---
name: lld
description: Generate a Low-Level Design and implementation plan in docs/plans/. Phased breakdown with exit criteria per phase. Asks 3-5 clarifying questions. Reads feature spec, test spec, and HLD as input.
---

# LLD (Low-Level Design) & Implementation Plan Generator

> **Playbook**: [`docs/sdlc/lld-playbook.md`](docs/sdlc/lld-playbook.md) | **Pipeline**: [`docs/sdlc/pipeline.md`](docs/sdlc/pipeline.md)

## Purpose

Generates a Low-Level Design with phased implementation plan in `docs/plans/`. Every phase has measurable exit criteria and a test strategy. This is the final planning artifact before code is written.

## Trigger

User invokes `/lld <feature-name>`.

## Workflow

### Phase 1: Read Prerequisites

1. **Find the feature spec**: Read `docs/features/<feature>.md`
2. **Find the HLD**: Read `docs/specs/<feature>.hld.md`
3. **Find the test spec**: Read `docs/testing/<feature>.md`
4. **If feature spec OR HLD is missing**: STOP and tell the user which prerequisite is missing:
   - No feature spec → run `/feature-spec` first
   - No HLD → run `/hld` first
   - No test spec → recommend `/test-spec` but don't block (test spec can be created in parallel)
5. **Read relevant source code**: Identify exact files, functions, and types that will be modified
6. **Read related plans**: Check `docs/plans/` for related implementation plans

### Phase 2: Clarifying Questions

Ask 3-5 clarifying questions for EACH area:

**Implementation Strategy (3-5 questions)**

- What's the preferred implementation order (data layer first? API first? UI first?)?
- Are there existing patterns in the codebase we should follow?
- Should this be behind a feature flag for phased rollout?
- What's the acceptable scope for phase 1 vs later phases?
- Are there hard deadlines driving the phasing?

**Technical Details (3-5 questions)**

- Which specific files need modification vs creation?
- What's the testing strategy — test-first or test-after?
- Are there type definitions or interfaces that need to change?
- What's the database migration strategy (if applicable)?
- Are there performance-sensitive paths that need special attention?

**Risk & Dependencies (3-5 questions)**

- Are there other ongoing changes that could conflict?
- What's the biggest implementation risk?
- Are there team dependencies (who needs to review/approve)?
- What monitoring/alerting needs to be in place before rollout?
- What's the definition of done for the whole feature?

**Spawn the product-oracle agent** to answer these questions autonomously:

- Pass ALL questions grouped by section as the prompt
- Include: "Answer these clarifying questions for the LLD: <feature-name>. Read the feature spec at docs/features/<slug>.md, the HLD at docs/specs/<slug>.hld.md, and relevant source code."
- The oracle will return ANSWERED, INFERRED, DECIDED, or AMBIGUOUS classifications
- **If ANY questions are AMBIGUOUS**: Present ONLY those to the user and wait
- **If ALL questions are ANSWERED/INFERRED/DECIDED**: Proceed immediately

**Log the oracle decisions** to `docs/sdlc-logs/<slug>/lld.log.md`.

### Phase 3: Generation

Generate the LLD + Implementation Plan:

````markdown
# LLD: <Feature Name>

**Feature Spec**: `docs/features/<slug>.md`
**HLD**: `docs/specs/<slug>.hld.md`
**Test Spec**: `docs/testing/<slug>.md`
**Status**: DRAFT | IN PROGRESS | DONE
**Date**: <today>

---

## 1. Design Decisions

### Decision Log

| #   | Decision | Rationale | Alternatives Rejected |
| --- | -------- | --------- | --------------------- |
| D-1 | ...      | ...       | ...                   |

### Key Interfaces & Types

```typescript
// New or modified interfaces
interface Foo {
  // ...
}
```
````

### Module Boundaries

| Module | Responsibility | Depends On |
| ------ | -------------- | ---------- |
| ...    | ...            | ...        |

## 2. File-Level Change Map

### New Files

| File | Purpose | LOC Estimate |
| ---- | ------- | ------------ |
| ...  | ...     | ...          |

### Modified Files

| File | Change Description | Risk         |
| ---- | ------------------ | ------------ |
| ...  | ...                | Low/Med/High |

### Deleted Files (if any)

| File | Reason |
| ---- | ------ |
| ...  | ...    |

## 3. Implementation Phases

CRITICAL: Each phase must be independently deployable and testable.
No phase should leave the system in a broken state.

### Phase 1: <Name> (e.g., "Data Layer")

**Goal**: <one sentence>

**Tasks**:
1.1. <specific task — completable in one session>
1.2. <specific task>
1.3. <specific task>

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

---

### Phase 2: <Name> (e.g., "API Layer")

(same structure as Phase 1)

---

### Phase N: <Name>

(same structure)

## 4. Wiring Checklist

CRITICAL: Every new component must be wired into its callers.
This section prevents the #1 agent failure mode: writing code that nothing calls.

- [ ] New service registered in DI container / module exports
- [ ] New routes registered in router file
- [ ] New models added to `packages/database/src/models/index.ts`
- [ ] New types exported from package index
- [ ] New middleware added to middleware chain
- [ ] New workers registered in worker startup
- [ ] UI components imported and rendered in parent components
- [ ] New API endpoints documented in OpenAPI spec

**Studio UI (if feature touches apps/studio/):**

- [ ] Each form's onSubmit/mutation has error handling (try/catch or onError) that displays error to user
- [ ] Each `useMutation` call has `onError` callback OR every `mutateAsync` is in a try/catch
- [ ] Submit buttons have `disabled={isPending}` or equivalent loading guard
- [ ] Each new Studio API route (`apps/studio/src/app/api/`) is called from a UI component (has a caller — not dead code)
- [ ] Each new Studio API route proxies to runtime or calls a real service (not stub data)
- [ ] Each new UI component is imported and rendered in its parent page/section (not orphaned)
- [ ] No native `<select>` elements — use `<Select>` from `components/ui/Select.tsx`
- [ ] No `bg-accent text-foreground` — use `bg-accent text-accent-foreground`

## 5. Cross-Phase Concerns

### Database Migrations

<Migration scripts or schema changes across phases>

### Feature Flags (if applicable)

<Flag names, default values, rollout plan>

### Configuration Changes

<New env vars, config keys>

## 6. Acceptance Criteria (Whole Feature)

- [ ] All phases complete with exit criteria met
- [ ] E2E tests from test spec passing
- [ ] Integration tests from test spec passing
- [ ] No regressions in existing tests (`pnpm build && pnpm test`)
- [ ] Feature spec updated with implementation details
- [ ] Testing matrix updated with actual coverage

## 7. Open Questions

1. ...

```

### Phase 4: Validation

1. Verify every FR from the feature spec maps to at least one implementation task
2. Verify every phase has measurable exit criteria (not just "tests pass")
3. Verify the wiring checklist is complete
4. Cross-reference with test spec — E2E and integration scenarios should be coverable after all phases

### Phase 4b: Audit Suite (8 rounds minimum — this is an implementation plan)

The LLD/implementation plan is the highest-risk document — it directly drives what gets built.
Rounds 1-5 use specialized architecture reviewers; rounds 6-8 check against external context
and can run in parallel after round 5.

**Rounds 1-5: Architecture & Completeness (sequential)**

| Round | Focus | Auditor |
|-------|-------|---------|
| 1 | Architecture compliance — isolation, auth, stateless, traceability | lld-reviewer |
| 2 | Pattern consistency — matches existing code, no reinvention | lld-reviewer |
| 3 | Completeness — every FR covered, file paths verified, signatures checked | lld-reviewer |
| 4 | Cross-phase consistency — LLD implements HLD, covers test spec scenarios | phase-auditor |
| 5 | Final sweep — task independence, wiring checklist, domain rules | lld-reviewer |

**Audit feedback loop (rounds 1-5):**
1. After each round: fix ALL CRITICAL findings, fix HIGH findings where feasible
2. Each subsequent round focuses on NEW issues + verifying prior fixes stuck
3. Round 4 uses **phase-auditor** (not lld-reviewer) for cross-phase consistency
4. After round 5: proceed to rounds 6-8 even if MEDIUM findings remain (log them)
5. If still CRITICAL after round 5: STOP and escalate to user before proceeding

**Ralph-loop integration:** If `.claude/ralph-loop.local.md` exists and is active, each loop iteration counts as an audit round — skip internal loops.

**Rounds 6-8: External Context Audits (run in parallel after round 5)**

Spawn all three agents in a single message:

**Round 6 — Platform Audit** (general-purpose agent, reads local files):
```

Platform audit for LLD at: docs/plans/<date>-<slug>-impl-plan.md
Feature spec: docs/features/<slug>.md

Read the LLD, then check:

1. Read CLAUDE.md — does any implementation task contradict platform invariants? (tenant
   isolation in every DB query, centralized auth only, stateless distributed, traceability via
   TraceEvents, no sync I/O, no console.log, structured error envelopes)
2. Read .claude/skills/platform-principles/SKILL.md — do the proposed patterns match?
3. Check the file-level change map: do the listed files still exist at those exact paths?
   Grep for the functions/types the LLD plans to modify — do their signatures still match?
4. Does the wiring checklist cover all new components? Is anything constructed but never
   passed through the DI chain to its consumers?
5. Does any implementation task propose custom infrastructure that already exists in the
   platform? (e.g., re-implementing caching, re-implementing distributed locking, re-implementing
   error envelopes)

Return: APPROVED or NEEDS_REVISION. For each finding: [CRITICAL|HIGH|MEDIUM] + exact
LLD section/task + recommended change.

```

**Round 7 — Industry Research Expert Audit** (general-purpose agent, uses WebSearch/WebFetch):
```

Industry research audit for LLD at: docs/plans/<date>-<slug>-impl-plan.md

Read the LLD first. Then research:

1. For the core algorithmic or protocol choices in this LLD, what does industry experience say?
   Find at least 2 authoritative sources (engineering blogs from companies at scale, IETF/W3C
   standards, academic papers, or well-known conference talks).
2. Are there known performance cliffs or consistency traps for this class of implementation?
   (e.g., Redis cache invalidation races, Mongoose lean() gotchas, distributed locking pitfalls)
3. What operational concerns does industry experience flag for this implementation pattern?
   (deployment sequencing, backward compatibility, data migration risks)
4. Is the phasing order (data layer → API → UI) aligned with how comparable systems are
   typically rolled out? Are there ordering risks the LLD hasn't considered?
5. What does industry experience say about the test strategy — are the exit criteria for each
   phase sufficient to catch the failure modes this class of feature typically encounters?

Return: list of findings tagged [IMPROVEMENT], [RISK], or [GAP] with specific LLD
phase/task references and the source that informed each finding.

```

**Round 8 — OSS Library Audit** (general-purpose agent, uses WebSearch/WebFetch):
```

Open-source library audit for LLD at: docs/plans/<date>-<slug>-impl-plan.md

Read the LLD first. Then research:

1. For each new utility, algorithm, or integration the LLD proposes implementing from scratch,
   search for existing OSS libraries that provide it.
2. For each candidate: name, license (MIT/Apache preferred — flag GPL as incompatible with
   commercial SaaS), last release, weekly npm downloads or GitHub stars, open issue count,
   maintenance status.
3. Recommend: (a) adopt as-is, (b) vendor/fork, (c) use for design reference only,
   (d) avoid — with one-line justification per recommendation.
4. For any adopted library: estimate the integration cost vs. the custom-implementation cost
   in the LLD. Flag if adoption would simplify or remove entire LLD phases.
5. For any library already used in the monorepo that could cover a new use case in this LLD,
   call it out explicitly — don't add a new dependency when an existing one suffices.

Return: OSS candidates table (name | license | stars | status | recommendation) + one
sentence per item on integration impact.

```

**Integrate findings after all three round 6-8 agents return:**

1. Fix any CRITICAL or HIGH **platform-audit** findings — these block proceeding to implementation
2. Update the LLD's Open Questions and Design Decisions table with key **industry research** insights; revise implementation tasks where a finding changes the approach
3. Update the LLD's file-level change map and wiring checklist if an **OSS library** replaces a custom task; remove or simplify tasks accordingly
4. All round 6-8 MEDIUM findings are non-blocking but must be logged

**Log all 8 round findings** to `docs/sdlc-logs/<slug>/lld.log.md` — include round number, verdict, findings, and resolutions per round.

## Naming Convention

File: `docs/plans/<date>-<feature-slug>-impl-plan.md`
Example: `docs/plans/2026-03-22-reusable-modules-impl-plan.md`

### Phase 5: Commit & Log

1. **Commit the LLD**: `git add docs/plans/<date>-<slug>-impl-plan.md` and commit with message: `[ABLP-2] docs(<scope>): add <feature-name> LLD + implementation plan`
2. **Log progress** to `docs/sdlc-logs/<slug>/lld.log.md`
3. **Update agents.md** for each package touched — append learnings (file-level surprises, signatures differing from docs, technical debt found) to `<package>/agents.md`. See [`docs/sdlc/pipeline.md` — Package Learnings](docs/sdlc/pipeline.md#package-learnings-agentsmd) for what to log. Cross-cutting → `docs/sdlc-logs/agents.md`.
4. **Next phase**: Tell the user to run `/implement <feature-name>` next

## Context Management

CRITICAL: The LLD has 5 mandatory audit rounds — the longest audit loop in the SDLC pipeline. Without active context management, quality will degrade by round 3-4.

**Between phases within this skill:**
- After Phase 3 (Generation) completes and the file is written, the LLD content is persisted on disk. You do NOT need to keep it in working memory — re-read the file if needed.
- Always spawn the product-oracle, lld-reviewer, and phase-auditor as **separate Agent tool invocations**. They start with fresh context and return only their findings. Never inline oracle/auditor work in the main conversation.

**Between audit rounds (5 rounds for LLD):**
- After resolving findings from audit round N, briefly summarize what was fixed (3-5 bullet points) before spawning round N+1. Do NOT carry forward the full audit report text.
- Each audit agent reads the artifact fresh from disk — it does not need the prior round's full findings passed in.
- **After round 3**: run `/compact` mid-skill if context is growing large. The remaining rounds (4-5) should start with fresh reads of the artifact.

**After this skill completes:**
- Once the commit succeeds, run `/compact` to compress conversation context before implementation begins.
- If the user starts implementation in the same conversation, the architect/implementer agent should read the LLD fresh from disk — never rely on in-memory context from the LLD generation.

## Quality Gates

> Governed by the [Quality Principles](docs/sdlc/pipeline.md#quality-principles). No shortcuts — robust & architecturally sound. Test integrity — no mocking codebase components.

- MUST read feature spec and HLD before generating — never generate from description alone
- MUST have at least 2 implementation phases (even small features benefit from data-then-API layering)
- Every phase MUST have measurable exit criteria (not "it works" or "tests pass")
- Every phase MUST have a rollback strategy
- Every task MUST be completable in one session (if it's too big, break it down further)
- Wiring checklist MUST be filled — this is the #1 failure mode for agent-written code
- File-level change map MUST list exact file paths (not "somewhere in packages/database")
- MUST include acceptance criteria for the whole feature
- No TODO stubs — if something is deferred, assign it to a phase or track it in the feature spec gaps table
- Test strategy per phase must specify real service boundaries, not mocked layers
- E2E test tasks must require real servers with full middleware — not mocked infrastructure
- Integration test tasks must test actual service-to-service interactions — not stubbed responses
- Only external third-party services may be mocked, and only via dependency injection
```
