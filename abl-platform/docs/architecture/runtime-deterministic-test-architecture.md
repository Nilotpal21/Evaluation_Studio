# Runtime Deterministic Test Architecture

**Status:** Validated reference implementation, not a blanket mandate. Proven for already-pure decision logic (ABLP-938) and for one I/O-coupled orchestrator with an extractable decision graph (spike 3, `flow-step-executor.detectParentSupervisorRoute`). **Side-effect-order coverage for the I/O-coupled extraction:** success-path polarity (M6a), catch-path polarity (M6b), temporal ordering of `recordSuccess` vs. `await classify()` (M6c), and temporal ordering of `recordSuccess` before `finalizeParentSupervisorRoute` (M6d) are all mutation-tested by the ABLP-996 wiring sentinels. **Generality beyond these shapes is an adoption-time question** — future I/O-coupled adoptions justify fit independently using the worksheet and audits below. Failed extraction is a valid outcome; document the finding and stop.

**Scope:** already-pure decision logic, or I/O-coupled orchestrators where a specific pain trigger (see "When to reach for this") justifies extracting a bounded decision graph. **Not** the default architecture for decision-heavy runtime work; absence of a trigger means no action.

**Origin:** Spikes ABLP-938 (multi-intent router), ABLP-944 (ABLP-930 E2E conversion), spike 3 (parent supervisor route extraction).

**Audience:** Engineers extending the runtime; AI agents implementing tests for new subsystems; reviewers approving extraction PRs.

---

## The principle

**One core, two harnesses.** Production code and tests call the same pure decision functions. There is no parallel "test runtime." There are no `if (testMode)` branches. Pure functions are the seam; production wraps them with real I/O adapters, tests wrap them with deterministic data.

The win materializes as the scenario corpus grows: per-scenario marginal cost approaches zero. Tier 3 acceptance tests shrink to wire-boundary proof; decision-logic variants live in Tier 1 scenarios.

---

## The three tiers

Every subsystem in scope has three layers of test coverage. Each tier has one job. Mixing jobs is what creates the cost problem in the first place.

### Tier 1 — Scenarios (deterministic decision invariants)

- **Tests:** pure decision functions. Given inputs, the right outputs and effect data.
- **Infra:** none. In-memory only.
- **Speed:** milliseconds per scenario.
- **DSL:** typed TypeScript builder + runner. No YAML/JSON until the action vocabulary is stable.
- **Lives in:** `apps/<service>/src/__tests__/<subsystem>-scenarios/`.
- **Authored by:** the engineer making the production change, in the same PR.

### Tier 2 — Wiring (production runtime → pure core integration)

- **Tests:** the orchestrator actually reaches the pure decision core with production-shaped inputs. Catches integration bugs scenarios can't see.
- **Infra:** live production class (e.g. `RuntimeExecutor`), real DSL compilation, real session construction. External I/O DI-injected.
- **Speed:** tens of milliseconds per test.
- **Count:** **1–2 sentinel paths.** Add a third only when there are distinct orchestration paths (e.g. normal-path + early-return-path + side-effect-ordering-path).
- **Lives in:** `apps/<service>/src/__tests__/execution/<feature>.integration.test.ts`.

### Tier 3 — Acceptance (HTTP transport + middleware + persistence)

- **Tests:** the wire boundary. Auth, validation, happy path with expected envelope, isolation 404s, persistence GET. **Boundary behavior only, not internal decision branches.**
- **Infra:** full `RuntimeApiHarness` (HTTP + `MongoMemoryServer` + mock LLM).
- **Speed:** seconds per test.
- **Lives in:** `apps/<service>/src/__tests__/e2e/<feature>-acceptance.e2e.test.ts`.

---

## When to reach for this

Adopt the pattern only when at least one of these symptoms is present in the candidate subsystem. Absence of a trigger means leave the subsystem alone — the pattern is not free, and forcing the shape into a subsystem that doesn't need it is the dominant failure mode.

1. **Recurring side-effect-order, polarity, or fallback-semantics bugs** in an async orchestrator. (Spike 3 trigger: parent-supervisor-route had M5/M6-family faults that packed E2E couldn't localize.)
2. **A slow/flaky E2E or integration file carrying many internal decision branches** that are decidable from stable inputs without I/O. (The 582-line ABLP-930 E2E was the canonical example.) Use length as a smell, not a gate.
3. **Classifier, breaker, retry, routing, or fallback policy logic embedded between I/O calls** such that branch coverage requires mocks, spies, sleeps, or a packed E2E.
4. **Mutation or review finds existing tests vacuous** — they assert boundary success but cannot localize decision faults to a specific branch.

If a candidate passes a trigger, complete the worksheet below before any code change. Trigger + worksheet + audit is the minimum bar. Without all three, do not adopt.

## Fit-assessment worksheet (required only when adopting the pattern)

Once a trigger has fired and you've decided to adopt, start by filling out this worksheet. Concrete tables, not narrative. If you can't fill a row, the subsystem isn't ready and adoption is a finding, not a refactor.

### A. Target entrypoint

| Field      | Value           |
| ---------- | --------------- |
| File       | `<path>`        |
| Function   | `<name>`        |
| Line range | `<start>-<end>` |
| Caller(s)  | `<call sites>`  |

### B. Candidate pure function signature(s)

```ts
// Function 1
export function evaluate<X>(input: <InputType>): <ResultUnion> { ... }

// Function 2 (if applicable)
export function evaluate<Y>(input: <InputType>): <ResultUnion> { ... }
```

### C. PURE / I/O / SIDE-EFFECT map

| Line range | Classification | Notes                                          |
| ---------- | -------------- | ---------------------------------------------- |
| L1–LN      | PURE           | What it does                                   |
| LN+1–LM    | I/O            | What network/persistence call, what dependency |
| LM+1–LK    | SIDE-EFFECT    | Mutation/log/trace, what state                 |

### D. I/O outcome union table

For each I/O dependency the pure function consumes:

| Kind             | Triggered by                                 | Pure function's downstream behavior |
| ---------------- | -------------------------------------------- | ----------------------------------- |
| `not_attempted`  | When does the orchestrator skip the I/O?     | What does pure function do?         |
| `unavailable`    | When does the dependency report unavailable? | ...                                 |
| `failed`         | When does the dependency throw?              | ...                                 |
| `succeeded(...)` | Successful payload shape                     | ...                                 |

### E. Impossible-state table

States that the pure function MUST NEVER see because the orchestrator returns earlier:

| Impossible state              | Why it can't occur                       | Orchestrator branch that prevents it     |
| ----------------------------- | ---------------------------------------- | ---------------------------------------- |
| e.g. `classified_with_target` | Orchestrator finalizes route immediately | Lines X-Y of detectParentSupervisorRoute |

### F. Tier 1 scenario matrix

Discriminated-union exhaustiveness: **every state in every input union gets a scenario.** No "happy path covers it."

| Scenario ID | Input state                                                                    | Expected output kind                                       | Expected effect data |
| ----------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------- | -------------------- |
| S1          | `outcome.kind === 'not_attempted'` + lexical match + policy=`when_unavailable` | `route`                                                    | trace event X        |
| S2          | `outcome.kind === 'classified'` + target found                                 | early return (orchestrator-level; pure fn never sees this) | impossible — see E   |
| ...         | ...                                                                            | ...                                                        | ...                  |

Use TypeScript exhaustiveness at the API level so a missing scenario is a compile error:

```ts
type ScenarioCoverage = Record<ClassifierOutcome['kind'], string>; // scenario ID per kind
const COVERED: ScenarioCoverage satisfies Record<ClassifierOutcome['kind'], string> = {
  not_attempted: 'S1',
  model_unavailable: 'S5',
  failed: 'S4',
  classified: 'S2',
};
```

Or `assertNever` in the runner.

### G. Tier 2 wiring assertion(s)

What sentinel paths the wiring test must prove the orchestrator covers:

| Path                 | What it asserts                                  | Required mutations it catches |
| -------------------- | ------------------------------------------------ | ----------------------------- |
| Normal               | Orchestrator invokes core with right inputs      | Field-mapping deletion        |
| Early-return         | Orchestrator returns before invoking core when X | Forgetting early-return       |
| Side-effect ordering | `recordSuccess` runs only on classifier success  | Misplaced side-effects        |

### H. Tier 3 acceptance/deletion matrix

For each wire-level assertion in any existing E2E being replaced:

| Old assertion | Replacement tier        | Replacement file/test |
| ------------- | ----------------------- | --------------------- |
| ...           | Tier 3                  | ...                   |
| ...           | Tier 1 (decision logic) | ...                   |
| ...           | Tier 2 (orchestration)  | ...                   |

Existing E2E deletion requires: all rows have a replacement; mutation matrix has been rerun; three green CI cycles; owner approval; rollback plan. See ABLP-944 template at `<path>` (TBD when ABLP-944 ships its execution PR).

---

## The extraction pattern

After the worksheet is complete:

### Step 1 — Implement the extraction (production code change)

Rules:

**1a. Typed slice inputs.** Pure functions take stable derived facts, NOT live session/IR/thread objects. The orchestrator extracts the facts before calling the pure function.

**1b. Discriminated union outcomes for I/O state.** Don't drop state distinctions with option types. Explicit kinds for `not_attempted`, `unavailable`, `failed`, `succeeded(payload)`.

**1c. Don't include impossible states.** If the orchestrator returns early on a state, the pure function never sees it. Document it in the impossible-state table.

**1d. Effects as data.** Pure cores return deterministic effects/audit records as data. The orchestrator maps those to trace events / metrics / logs. This is the rule — not "every trace source is pulled into the pure return shape." For subsystems with many trace sources, only pull in the **decision-local** effects; other trace sources stay in the orchestrator.

**1e. Orchestrator stays in production.** The async function becomes thinner but is still the production entry point. Tests don't replace the orchestrator — they test the pure cores it calls, plus 1–2 sentinel wiring tests for the orchestrator itself.

### Step 2 — Author scenarios

Per pure function:

- **Every input-union state gets a scenario** (see worksheet F).
- **Trace/effect payload semantics, not just count/order.**
- **Idempotence helper** (`expectDeterministic`) on at least one scenario per pure function.

Use the typed scenario DSL pattern from `apps/runtime/src/__tests__/spike-deterministic-dsl/`:

```ts
// scenario-dsl.ts — per-subsystem
export interface RunScenarioInput { ... }
export function runScenario(input: RunScenarioInput): ScenarioContext { ... }
export const expect = { ... };  // typed assertions
export function expectDeterministic(input: RunScenarioInput): void { ... }
```

### Step 3 — Author wiring sentinel(s)

1–2 sentinel paths per worksheet table G. Live production class, DI'd external I/O, asserts on session state and effects.

### Step 4 — Author/shrink acceptance E2E

If the subsystem ships at a wire boundary, 4–8 thin tests. Assert boundary behavior ONLY. Internal decision branches live in Tier 1.

### Step 5 — Mutation matrix

Seed each fault category and declare expected catching tier (T1/T2/T3) BEFORE running:

| Fault category         | Example                                         | Expected catching tier |
| ---------------------- | ----------------------------------------------- | ---------------------- |
| Branch inversion       | Flip condition in pure core                     | T1                     |
| Field-mapping deletion | Drop a field in the input mapping               | T2                     |
| Outcome conflation     | Treat `failed` as `unavailable`                 | T1                     |
| Trace omission         | Drop a returned effect record                   | T1                     |
| Early-return inversion | Orchestrator runs core when it shouldn't        | T2                     |
| Side-effect ordering   | `recordSuccess` runs before classifier succeeds | T2                     |
| Wire transport         | 401 returns 200 instead                         | T3                     |

Run each mutation, verify the declared tier catches. If any mutation is uncaught by its declared tier, your test in that tier is vacuous.

---

## Guardrails (not laws)

Default guardrails — if any is exceeded, an explicit reviewer approval is required in the PR description.

- **>3 production functions changed** in one extraction
- **>150 net lines** of production code change
- **More than one pure function per orchestrator extraction** (B-full territory; split into multiple PRs)
- **Median scenario >20 semantic lines** after DSL extraction; p90 >40 should trigger a fixture refactor discussion
- **>1 hour audit cadence** between phases

These are warning signs, not kill criteria.

## Kill conditions (architectural, not numeric)

If any of these holds, stop and write up the finding. Do not work around them.

- **Extraction changes behavior instead of isolating behavior** (refactor scope drift).
- **Pure core needs live session mutation** to do its work (it's not actually pure).
- **Scenario DSL must emulate production orchestration** to make scenarios pass (DSL is recreating the production code under test).
- **Old and new paths coexist in production** (no single-source-of-truth).
- **Wiring test cannot prove production calls the core** (you've shipped a parallel implementation).
- **A `testMode` parameter is required in production code** (the seam isn't real).

---

## Anti-patterns (block in code review)

1. **Parallel implementation** — `decideXForTests()` that production never calls. Drift within a quarter.
2. **`testMode` branches** in production. The test path differs from production.
3. **Vacuous assertions** — assert cleanup of state that was never set. Always seed or don't assert.
4. **Live `RuntimeSession` casts everywhere** outside one audited fixture boundary. Drift undetected.
5. **Untyped YAML scenarios first.** Looks like progress; lacks refactoring support; accumulates rot.
6. **DI as the win.** Fast tests without architectural change. If you can't extract the pure core, the subsystem isn't ready.
7. **Including impossible states in the pure input.** Over-specifies the API; brittle tests.
8. **Conflating "not_attempted" with "failed".** Different downstream consequences; both states need scenarios.
9. **Trace event callbacks inside pure functions.** Function becomes impure; idempotence breaks.
10. **Deleting old E2E without parity criteria.** Guaranteed coverage regression.
11. **Pure core mutates input objects.** Inputs are immutable contract. Mutate and return a new value.
12. **Pure core reads globals** — `Date.now()`, `Math.random()`, `process.env`, singleton registries, module-level caches. Inject these as inputs or as a `clock`/`rng` parameter.
13. **Scenario fixture factory encodes the same decision logic as production.** The fixture is now the test (bug-for-bug match).
14. **Wiring test mocks or spies on the pure core** instead of observing observable behavior. Wiring proves invocation by observable result, not by spy state.
15. **Wiring test becomes a packed E2E** with many decision variants. Decision variants belong in Tier 1; wiring is sentinel-only.
16. **Trace assertions check count/order only**, not payload semantics. A trace event with the wrong target is still emitted; count assertions miss it.
17. **DSL becomes a second production abstraction layer** rather than a test fixture. If the DSL has its own state machine, it's outgrown its scope.
18. **Acceptance tests assert internal decision branches** instead of boundary behavior. Push those to Tier 1.

---

## When the pattern wins big

Concrete runtime subsystem fits:

- Multi-intent routing (proven — ABLP-938)
- Lexical fallback / routing resolver decisions
- Retry / throttling / circuit-breaker policy decisions
- Handoff target resolution
- Gather validation decision logic
- Tool dispatch selection (which tool, given constraints)

Common shape: decision-heavy, combinatorial state space, subtle correctness invariants, current E2E slow + author cost high.

---

## When NOT to apply

**Subsystem-level out-of-scope.** Tier 1 scenarios should NOT certify these subsystems. They may have extractable pure sub-decisions, but the subsystem itself is best tested at Tier 2/Tier 3:

- Runtime HTTP auth, validation, permission enforcement
- Tenant / project isolation queries
- Session persistence semantics and migrations
- WebSocket streaming / token streaming / backpressure
- Distributed locks, BullMQ queue worker timing, retries under real clocks
- Provider protocol adapters and SDK clients (OpenAI, Anthropic, etc.)
- Encryption / key-management boundaries
- Performance / resource saturation behavior
- Nondeterministic LLM output quality
- Whole `flow-step-executor` execution loop (only extracted transition/route decisions may fit)

**Sub-system-level out-of-scope.**

- Already-pure subsystems with adequate unit-test coverage — leave them alone.
- Pure data access layers — use integration tests with real infra mocks.
- Subsystems where extraction fails any kill condition — finding, not blocker. Document and move on.

---

## Continuous audit (minimum viable cadence)

**Required for every adoption:**

1. **Fit/plan audit** — before any production code change. Sharp critic on the worksheet (sections A–H). Catches design mistakes when cost of change is small.
2. **Pre-merge audit** — after scenarios + wiring + mutation matrix complete. Catches false-confidence tests, biased mutations, claims that don't match data.

**Required additionally for I/O-coupled extraction OR high-risk runtime paths:** 3. **Code audit** — after extraction is written, before scenarios. Catches signature mistakes, false purity claims, hidden coupling. 4. **Findings audit** — after mutation matrix. Catches "the seeded faults were cherry-picked."

**Required additionally when any default guardrail is exceeded** — explicit reviewer narrative in the PR description AND an audit on the deviation.

Audits use a second model (GPT-5.5 high-effort via `codex review`) or a second human reviewer. Each audit produces specific corrections; apply BEFORE the next phase.

---

## Adoption operations

### Rollback if extraction destabilizes production

- Extraction PRs MUST be revertable in a single PR. Verify by ensuring the extraction does not touch unrelated production code in the same change.
- If a regression surfaces post-merge, the path is: revert the extraction PR; restore the old packed E2E temporarily; file a finding on the extraction's gap; re-attempt with corrections.
- The deletion PR for the old E2E is a separate revertable PR.

### Debugging failed tests

- **Failed Tier 1 scenario** → the pure function's behavior changed OR the scenario is wrong. Read the production change diff and the scenario input together. Should the input still produce the asserted output? If yes, production has a real bug. If no, the scenario was over-asserting.
- **Failed Tier 2 wiring test** → orchestration changed. Check: is the orchestrator still invoking the pure core? Are the production-shaped inputs still being constructed correctly? Did a side-effect site move?
- **Failed Tier 3 acceptance** → wire-level regression. Check: route mounting, middleware, request/response shape, status code mapping. Don't go hunting for decision-logic bugs — Tier 1 would have caught those first if they existed.

### Handling `RuntimeSession` / `AgentIR` shape evolution

- Typed slice inputs to pure functions insulate them from full-shape evolution. When a new field is added to `RuntimeSession`, the pure function's typed-slice input may not need to change at all.
- When the typed slice DOES need to expand (the pure function genuinely needs the new field), do it in one PR: update the slice type, update the orchestrator's mapping, update existing scenarios to provide a default for the new field.
- The fixture builders in the DSL (e.g. `newSession(ir)`) are the single audited boundary. Update them once when the underlying type changes; scenarios inherit the update.

### Evolving the DSL

- The DSL is a fixture/builder layer, NOT a production abstraction. Resist adding features unless multiple scenarios need them.
- Adding a new typed action (e.g., a new kind of supervisor decision) is the right reason to extend. Adding a "smart" helper that infers state is the wrong reason.
- DSL extension PRs should be paired with scenarios that USE the new feature; never extend the DSL speculatively.

### Ownership and maintenance

- Each scenario DSL has an owner team (whoever owns the production code it tests). When the production code moves owners, the DSL moves with it.
- Scenarios are runtime tests; runtime team owns the DSL and reviews PRs that touch it.
- Cross-team scenarios (e.g., search-ai scenarios that need supervisor IR fixtures) reuse the existing DSL via imports; they don't fork.

### CI commands

### PR changed-test and mock-drift lane

The PR changed-test lane is a fast regression detector, not a replacement for the
tiered runtime architecture above. It catches stale assertions and many
mock-drift failures when the changed production file is in the affected
dependency graph. Run it with:

```bash
pnpm test:changed:pr
```

The lane resolves its comparison base from the branch upstream first, with
`origin/develop` as the fallback. Do not hard-code `origin/main` in PR test
commands, CI examples, or local instructions for this repository. The lane must
run the affected build before tests; Turbo can otherwise execute tests against
stale compiled output.

The companion static detector is:

```bash
pnpm lint:mock-export-drift
```

This checker is deliberately diff-scoped and low-noise. It reports only two
classes of newly introduced risk:

- a changed production module adds a new runtime value export, and an affected
  test already mocks that exact module but omits the new value
- a changed production or test file introduces a new named runtime import from
  an internal module, and an affected test mocks that module but omits the
  imported value

Type-only exports and type-only imports are ignored. Existing full mocks are not
treated as full-repo export snapshots; the detector should not fail just because
a mock omits an unrelated pre-existing value. When the detector flags an
internal mock drift, treat that as a refactor/testability signal first. Prefer
dependency injection or pure-function extraction over patching more behavior
into the mock factory.

Timing, async scheduling, and WebSocket handler regressions are outside the
static detector's claim. Diagnose those with focused Vitest reproduction,
runtime traces, or the relevant Tier 2/Tier 3 harness rather than expecting the
mock-export drift checker to identify them.

```bash
# Tier 1 scenarios — fast lane, run on every PR
pnpm --filter @agent-platform/runtime exec vitest run src/__tests__/<subsystem>-scenarios/

# Tier 2 wiring — fast lane, run on every PR
pnpm --filter @agent-platform/runtime exec vitest run --config vitest.integration.config.ts src/__tests__/execution/<feature>.integration.test.ts

# Tier 3 acceptance — E2E lane, runs on every PR but sequentially
pnpm --filter @agent-platform/runtime exec vitest run --config vitest.e2e.config.ts src/__tests__/e2e/<feature>-acceptance.e2e.test.ts
```

Tier 1 and Tier 2 belong in the default fast lane. Tier 3 belongs in the E2E lane (sequential, MongoMemoryServer).

### Old E2E deletion template

Use the ABLP-944 deletion criteria template (parity matrix, six deletion criteria, evidence-emission disposition, harness-reset parity, rollback plan, owner, review-by date). When ABLP-944 ships its execution PR, link the template here.

### Reviewer checklist (for extraction PRs)

- [ ] Worksheet (A–H) attached to PR description or linked in a sibling doc
- [ ] No guardrail exceedances without explicit reviewer narrative
- [ ] No kill condition triggered (or PR is a "finding" PR, not a "ship" PR)
- [ ] No anti-pattern present
- [ ] Discriminated-union exhaustiveness type-enforced (`satisfies` or `assertNever`)
- [ ] Mutation matrix run; each fault category catches in its declared tier
- [ ] One audit conducted (fit/plan); a second audit conducted (pre-merge); for I/O-coupled extraction, two more audits (code, findings)
- [ ] Build green; existing tests green; new tests green
- [ ] PR is revertable as a single unit

---

## Measurement targets

| Metric                    | Target                                 | Notes                                                     |
| ------------------------- | -------------------------------------- | --------------------------------------------------------- |
| Tier 1 wall time          | <5s for 20+ scenarios                  | Dominated by module import                                |
| Tier 1 test execution     | <50ms for 20+ scenarios                | Actual decision work                                      |
| Median scenario authoring | <20 semantic lines                     | After DSL extraction matures                              |
| p90 scenario authoring    | <40 semantic lines                     | p90 above this → refactor fixtures                        |
| Tier 2 wiring count       | 1–2 sentinel paths                     | Third only for distinct orchestration paths               |
| Tier 3 acceptance count   | 4–8 thin tests                         | Wire boundary only                                        |
| `as unknown as X` casts   | ≤2 per subsystem                       | One audited fixture boundary                              |
| Mutation matrix           | Each fault declares tier; tier catches | If a tier misses its declared fault, that tier is vacuous |

Honest framing for spike write-ups:

- Total wall-clock for the new tiered structure may be **higher** than the old packed-E2E for current coverage. The win is in marginal cost as the scenario corpus grows AND in coverage-shape (boundary vs decision separation).
- Scenarios catch decision-logic faults cheaply and directly. The architecture doesn't make wire-level catches impossible — it just makes decision-level catches cheap.
- The wiring tier is essential. Without it, orchestration faults slip through.
- Pattern proven for already-pure subsystems and validated on one I/O-coupled orchestrator (spike 3). **Generality beyond these shapes is an adoption-time question** — each new adoption justifies fit independently via the worksheet + audits.

---

## Reference implementations

**Already-pure decision logic (ABLP-938):**

- **Multi-intent router DSL:** `apps/runtime/src/__tests__/spike-deterministic-dsl/scenario-dsl.ts`
- **Scenario examples:** `apps/runtime/src/__tests__/spike-deterministic-dsl/scenarios.test.ts`

**I/O-coupled orchestrator extraction (spike 3, `detectParentSupervisorRoute`):**

- **Production extraction:** `apps/runtime/src/services/execution/flow-step-executor.ts` (`evaluateParentSupervisorRoutePrecheck`, `evaluateParentSupervisorRouteAfterClassifier`)
- **Tier 1 scenario DSL + scenarios (20 tests):** `apps/runtime/src/__tests__/spike-3-parent-supervisor-route-dsl/`
- **Tier 2 wiring sentinel (5 tests, M6a–d):** `apps/runtime/src/__tests__/execution/parent-supervisor-route-classifier-path.wiring.test.ts`
- **Tier 3 thin acceptance E2E (7 tests):** `apps/runtime/src/__tests__/e2e/ablp-930-acceptance.e2e.test.ts`
- **Adjacent supervisor-routing wiring:** `apps/runtime/src/__tests__/execution/ablp-930-supervisor-tool-call-routing.integration.test.ts`

**Old E2E deletion template:** ABLP-944 (Jira) — landed at `eb113886e6`.

---

## Provenance

| Spike    | Subsystem                                        | Result                                                              | Commits                                                   |
| -------- | ------------------------------------------------ | ------------------------------------------------------------------- | --------------------------------------------------------- |
| ABLP-938 | Multi-intent router                              | GO (already-pure)                                                   | `899b44bd9c`, `f1030f61e5`, `5b14102811`                  |
| ABLP-944 | ABLP-930 E2E conversion                          | GO — landed                                                         | `eb113886e6` (deletion of old 582-line E2E)               |
| Spike 3  | `flow-step-executor.detectParentSupervisorRoute` | **GO as reference implementation; not proof of universal transfer** | spike-3 extraction + ABLP-996 M6 sentinels (`085fcf0066`) |

Spike 3 is a worked example of I/O-coupled extraction, not a generalization. The pattern's reach for other I/O-coupled orchestrators is established subsystem-by-subsystem at adoption time — see "When to reach for this." Failed extraction in a new subsystem is a finding to document, not a defect in the pattern.

---

## How to use this document

1. **Deciding whether to adopt for a concrete pain point:** read "When to reach for this" first. If no trigger fires, do not adopt — the pattern is not free and forcing fit is the dominant failure mode. If a trigger fires, also read "When NOT to apply" — explicit out-of-scope subsystems use Tier 2/Tier 3 directly even if a trigger fires.
2. **Adopting for a new subsystem (trigger confirmed):** complete the worksheet (sections A–H). Run fit/plan audit. Implement per "The extraction pattern." Run pre-merge audit. Ship.
3. **Reviewing an in-flight extraction:** check guardrails, kill conditions, anti-patterns. Reviewer checklist at the bottom of "Adoption operations."
4. **Mentoring an engineer or AI agent:** point them at this doc + the reference implementations. Require a documented trigger AND the worksheet before any code change.
