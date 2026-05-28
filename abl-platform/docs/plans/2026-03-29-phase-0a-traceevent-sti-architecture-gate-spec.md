# Phase 0A: TraceEvent and STI Architecture Gate Spec

**Date:** 2026-03-29
**Status:** Proposed
**Scope:** `TraceEvent` ownership and naming policy, STI coverage policy, architecture-fitness test logic, scorecard/reporting alignment, verification design, and CI enforcement design

## Objective

Design strict, semantically correct architecture-fitness checks for trace schema ownership and STI coverage, and define how they will be verified and enforced in CI.

This phase improves the checks and enforcement logic. It also includes the supporting architecture test/reporting artifacts needed to make those checks understandable and reviewable. It does not remediate existing violations yet.

## Scope

### Included

- `TraceEvent` ownership and naming policy
- STI coverage policy
- Architecture-fitness test logic in `packages/shared-kernel/src/__tests__/architecture-fitness.test.ts`
- Architecture reporting and scorecard alignment in `tools/architecture-scorecard.sh`
- Boundary-check and CI wiring where needed to support strict production enforcement
- Executable check design
- Verification design
- CI enforcement design

### Excluded

- Renaming existing trace types
- Adding new STI boundaries in production code
- Route/service/repo refactors
- Package decomposition
- Dockerfile coverage gating
- General architecture debt remediation outside the gate/reporting layer

## Primary Artifacts

- `packages/shared-kernel/src/__tests__/architecture-fitness.test.ts`
- `tools/architecture-scorecard.sh`
- `.dependency-cruiser.cjs`
- CI workflow/config for the architecture gate

## Deliverables

### 1. Test-file changes

Primary artifact:

- `packages/shared-kernel/src/__tests__/architecture-fitness.test.ts`

Deliverable details:

- Replace broad baseline-style `TraceEvent` counting with stricter classification-based checks
- Add explicit `TraceEvent` rule separation for canonical uniqueness, non-canonical naming, and honest alias handling
- Redesign STI enforcement so required critical paths and family minima are primary, with total count only as a secondary backstop
- Keep test names, policy text, scorecard/header text, and failure messages aligned with the implemented rules
- Make failure output specific enough to support review and future remediation without additional reverse-engineering

### 2. Scorecard changes

Primary artifact:

- `tools/architecture-scorecard.sh`

Deliverable details:

- Keep human-facing architecture reporting aligned with the enforcement logic introduced in the fitness suite
- Improve scorecard output where needed so reviewers can understand current hotspots and gate context without contradictory or misleading summaries
- Ensure scorecard/reporting remains informational and review-oriented rather than becoming a second source of gate semantics

### 3. Boundary-check changes

Primary artifact:

- `.dependency-cruiser.cjs`

Deliverable details:

- Separate production architecture signal from test-only signal where needed to support strict production enforcement
- Keep boundary-check output consistent with the Phase 0A principle that strict enforcement should focus on semantically meaningful production architecture violations
- Ensure boundary-check/fitness outputs do not contradict each other at the policy level

### 4. CI changes

Primary artifacts:

- CI workflow/config for the architecture gate
- Related package scripts if needed

Deliverable details:

- Introduce an explicit `architecture-gate` CI stage
- Make Phase 0A strict rules blocking once verification is complete
- Keep scorecard/reporting summaries informational in CI
- Preserve a clear split between blocking architecture invariants and non-blocking architecture visibility/reporting

## Invariants

### Invariant 1: Canonical `TraceEvent` Ownership

There must be exactly one canonical platform `TraceEvent` schema in the repo.

Canonical owner:

- `@agent-platform/shared-kernel`

Allowed:

- The canonical exported schema in `shared-kernel`
- Honest aliases or re-exports of the canonical type
- Local specialized trace shapes with role-specific names

Disallowed:

- Any second package defining its own canonical `TraceEvent` schema
- Any non-canonical local type exported as `TraceEvent`
- Local schema redefinition under the same generic name instead of aliasing/importing canonical ownership

Architectural intent:

- One source of truth
- No ambiguous trace-schema ownership
- No misleading generic naming for local specialized types

### Invariant 2: STI Must Enforce Meaningful Coverage

Tracing must cover:

1. Required critical execution boundaries
2. All major execution families

The STI policy must not rely primarily on raw wrapper count.

Allowed:

- Additional useful trace boundaries
- A total-count backstop as a secondary regression guard

Disallowed:

- Satisfying the gate through count inflation without improving coverage shape
- Missing critical execution paths
- Weak or absent coverage in a major execution family

Architectural intent:

- Observability should reflect execution structure
- Tracing blind spots should be surfaced by category, not hidden behind totals

## Executable Check Design

### `TraceEvent` Checks

#### Check A1: Canonical definition uniqueness

Purpose:

- Ensure only one canonical exported `TraceEvent` schema exists

Detection model:

- Scan source files
- Find exported `TraceEvent` declarations with schema bodies
- Exclude `.d.ts`
- Exclude direct aliases/re-exports
- Fail unless the only canonical definition is in `shared-kernel`

Failure meaning:

- Duplicate canonical ownership

#### Check A2: Non-canonical `TraceEvent` naming

Purpose:

- Block local specialized types from masquerading as canonical `TraceEvent`

Detection model:

- Scan exported `TraceEvent` definitions outside canonical owner
- If not an honest alias/re-export, classify as naming/ownership violation

Failure meaning:

- Local debug, bridge, storage, runtime, or studio-specific shapes are exported under ambiguous canonical naming

#### Check A3: Honest alias allowance

Purpose:

- Avoid false positives on direct aliases/re-exports

Detection model:

- Classify alias-only cases separately
- Do not count these as duplication or naming violations

Failure meaning:

- None directly; this supports A1 and A2 classification

Implementation rules:

- `TraceEvent` checks must use classification logic, not one broad regex count
- Existing architecture-fitness scorecard text in `architecture-fitness.test.ts` must be kept aligned with the actual assertions that implement these rules

### STI Checks

#### Check B1: Required critical paths

Purpose:

- Ensure core execution blind spots do not exist

Detection model:

- Scan source files for unique `tracePath()` strings
- Compare against a curated required path list

Expected required set includes current critical boundaries such as:

- `runtime/executor/llm-call`
- `runtime/executor/tool-call`
- `runtime/executor/constraint-check`
- `runtime/executor/handoff`
- `runtime/executor/agent-exit`
- `runtime/executor/decision`
- `runtime/executor/delegate`
- `runtime/executor/flow/step-exit`
- `runtime/executor/flow/transition`

Failure meaning:

- A required execution boundary is not instrumented

#### Check B2: Family coverage minima

Purpose:

- Enforce meaningful observability shape across execution concerns

Execution families:

- `llm_tool`
- `flow_routing`
- `lifecycle`
- `decision_constraints`

Detection model:

- Map discovered `tracePath()` values into explicit families
- Assert minimum distinct coverage per family

Failure meaning:

- One execution concern remains under-instrumented even if total coverage looks acceptable

#### Check B3: Secondary total-count backstop

Purpose:

- Detect broad regression in total STI coverage

Detection model:

- Count total unique trace paths
- Enforce a modest minimum

Failure meaning:

- Overall instrumentation regressed sharply

Implementation rules:

- Total count is secondary
- Critical-path and family-based coverage are primary
- `architecture-fitness.test.ts` should expose the required path set and family policy clearly enough that reviewers can validate the logic without reverse-engineering regexes

## Verification Design

The checks are only ready for strict enforcement if they satisfy all of these conditions.

### `TraceEvent`

- A known allowed alias case passes
- A known non-canonical local naming case fails
- Canonical owner remains uniquely accepted
- Unknown declaration patterns are surfaced, not silently ignored

Reference anchors:

- Allowed alias candidate:
  - `packages/compiler/src/platform/core/types.ts`
- Likely non-canonical naming candidates:
  - `packages/mcp-debug/src/types.ts`
  - `packages/eventstore/src/migration/trace-bridge.ts`

### STI

- Required critical paths pass or fail explicitly
- Family imbalance can fail even when total count passes
- Total count cannot mask missing critical/family coverage
- Failure output identifies exact missing boundaries or under-covered families

Likely calibration point:

- Lifecycle coverage is expected to be the most sensitive family

Verification standard:

A check is not ready for strict CI blocking unless all of the following are true:

1. At least one known allowed case passes
2. At least one known disallowed case fails
3. Failure output is actionable
4. Classification logic is not known to be noisy

Verification also includes artifact-level review:

- `architecture-fitness.test.ts` names, messages, and policy text match the implemented logic
- `tools/architecture-scorecard.sh` remains a readable human-facing companion to the gate rather than drifting into contradictory reporting

## CI Enforcement Design

CI stage name:

- `architecture-gate`

Blocking in this phase:

- `TraceEvent` canonical uniqueness
- Non-canonical `TraceEvent` naming
- STI required critical paths
- STI family minima

Informational only in this phase:

- Total STI path summary
- Scorecard/reporting output
- Future Dockerfile coverage

Enforcement policy:

- Immediate blocking once verification is complete
- No warn-only mode for the Phase 0A strict rules

Reason:

- These are core architectural mechanism rules, not soft metrics

Failure output requirements:

- Rule name
- Violation type
- File paths or missing paths
- High-level remediation direction

## Explicit Non-Goals

This phase does not:

- Fix current violating files
- Rename trace types in app/package code
- Add missing trace boundaries in runtime logic
- Change route or package architecture
- Tune Dockerfile gates
- Perform broad scorecard UX redesign beyond what is needed to keep reporting aligned with the architecture gate

Those may follow later, but they are not part of this phase.

## Decision Lock

The phase proceeds with these policy decisions fixed:

1. Exactly one canonical `TraceEvent` schema is allowed.
2. Non-canonical local types must not be exported as `TraceEvent`.
3. STI enforcement is based on critical boundaries plus family coverage.
4. Total `tracePath()` count is only a secondary guard.
5. Phase 0A is about checks and enforcement only, not remediation.
