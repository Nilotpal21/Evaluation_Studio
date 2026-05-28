# Bruce Feedback — Partially Addressed Items Slice Plan

**Created:** 2026-04-18
**JIRA parent:** [ABLP-409](https://koredotai.atlassian.net/browse/ABLP-409) — Bruce ABL spec feedback — partially-addressed items remediation (6 slices)
**Slice tickets:**

- Slice 1 (ON_ERROR completion): [ABLP-412](https://koredotai.atlassian.net/browse/ABLP-412)
- Slice 2 (Reask retry loop): [ABLP-413](https://koredotai.atlassian.net/browse/ABLP-413)
- Slice 3 (Guardrail Tier 1 severity + dedup): [ABLP-410](https://koredotai.atlassian.net/browse/ABLP-410)
- Slice 4 (REMEMBER dedup): [ABLP-411](https://koredotai.atlassian.net/browse/ABLP-411)
- Slice 5 (PII_TYPE hints): [ABLP-414](https://koredotai.atlassian.net/browse/ABLP-414)
- Slice 6 (enum_set + ON_INPUT docs): [ABLP-415](https://koredotai.atlassian.net/browse/ABLP-415)

**Scope:** 10 partially-addressed items from Bruce Wilcox ABL spec review
**Source audit:** conversation on 2026-04-18; per-item verification in current `develop` branch
**Approach:** Test-locked, slice-by-slice execution with mandatory audit per slice

---

## User Decisions Locked (2026-04-18)

### Not-Addressed group (follow-up plan)

| #   | Item                                | Decision                                                                             |
| --- | ----------------------------------- | ------------------------------------------------------------------------------------ |
| 1   | 5.5 Streaming evaluator full buffer | **PARKED** — one-chunk eval acceptable for now                                       |
| 2   | 10.1 Handoff `ON_FAILURE`           | **MIRROR DelegateConfig** — same enum, same semantics                                |
| 3   | 3.2 `tool:*:before` recall events   | **BLOCKING** — recall may mutate context used in tool dispatch                       |
| 4   | 1.2 Tool confirmation lint          | **WARNING ONLY** — no auto-default of `confirmation.require`                         |
| 5   | HANDOFF `EXPECT_RETURN` rename      | **DUAL-KEY COMPATIBILITY** — both keys work; prefer `EXPECT_RETURN` in new authoring |
| 6   | 5.6 Provider registry TTL           | **DB-loaded = session-permanent** — explicit invalidation only                       |

### Partially-Addressed execution decisions (this plan)

| #   | Question                     | Decision                                                                                                                                   |
| --- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| A   | Slice 1 classifier source    | **Local re-implement in `apps/runtime/src/services/execution/tool-error-classifier.ts`** — no cross-package coupling to `packages/arch-ai` |
| B   | Slice 2 `maxReasks` default  | **2** (worst case 3× baseline LLM cost), hard schema cap at 5                                                                              |
| C   | Slice 2 streaming + reask    | **Compile-time warning** + silent fallback to block behavior                                                                               |
| D   | Slice 4 deep-equal depth cap | **Project setting** — `projectSettings.memory.dedupMaxDepth` (default 8, min 1, max 32). Not a hardcoded constant.                         |
| E   | Slice 5 Kore entity mapping  | **Separate follow-up slice** — not in scope for Slice 5 base PII_TYPE feature                                                              |

---

## Partially Addressed Items — Scope

| #                          | Item                                  | Criticality                                                              | Current state                                                                |
| -------------------------- | ------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| 5.1                        | Reask action never regenerated        | HIGH                                                                     | Types/precedence wired; no retry loop in reasoning-executor                  |
| 2.1                        | `RESPOND` in `ON_ERROR` reaches user  | HIGH                                                                     | Works in reasoning-executor; flow-step-executor lacks `onChunk`              |
| 2.3                        | `HANDOFF` in error handlers executes  | HIGH                                                                     | Types + metadata plumbed; no caller checks `resolution.action === 'handoff'` |
| 2.4                        | Error type classification             | HIGH                                                                     | `classifyToolError` lives in `packages/arch-ai`, not wired into runtime      |
| 5.4                        | Action applier severity resolution    | MEDIUM                                                                   | Tier 2/3 resolve severity; Tier 1 still uses default action                  |
| 5.2                        | Dual input guardrail eval             | MEDIUM                                                                   | `checkFlatConstraints` strips; `checkConstraints` still duplicates           |
| 3.1                        | Remember trigger dedup                | MEDIUM                                                                   | `evaluateRememberAfterStateChange` writes every turn; no read-before-write   |
| 8.1                        | PII redaction on non-canonical fields | MEDIUM                                                                   | `sensitive` flag exists; no `pii_type` hint for non-canonical names          |
| GATHER semantics `enumSet` | LOW                                   | Lives on parent `GatherField.enum_values`; not in `GatherFieldSemantics` |
| 6.1                        | ON_INPUT deterministic-only docs      | LOW                                                                      | Implied in events table; no explicit constraint callout                      |

---

## Slice Breakdown

Slices are grouped by **coupling of files touched**, not by severity. Items that touch the same executors ship together to avoid merge churn and keep commits under the 40-file / 3-package guardrail.

### Slice 1 — ON_ERROR Completion (HIGH)

**Items:** 2.1, 2.3, 2.4
**Why grouped:** All three are runtime wiring gaps in `reasoning-executor.ts` + `flow-step-executor.ts` + `error-handler-router.ts`. They share the same control-flow context and test harness.

**Files to modify:**

- `apps/runtime/src/services/execution/flow-step-executor.ts` — add `onChunk` param to `executeToolWithErrorHandling`, call on `resolution.respond`
- `apps/runtime/src/services/execution/reasoning-executor.ts` — handle `resolution.action === 'handoff'` via `routing.handleHandoff()`; replace hardcoded `type: 'tool_error'` with classifier result
- `apps/runtime/src/services/execution/error-handler-router.ts` — already exports correct types; may need classifier integration
- `apps/runtime/src/services/execution/tool-error-classifier.ts` — **NEW** — extracted pure function (import from `packages/arch-ai` requires a cross-package port; we'll duplicate the logic locally since arch-ai is a different execution surface)

**Impact analysis:**

- **Blast radius:** every tool call in every flow with an `ON_ERROR` block. Roughly 40% of production flows per grep of compiled IR.
- **Behavior change visible to users:**
  - Flow mode: users now see `RESPOND` message streamed during tool retries instead of dead air
  - DSL `THEN: HANDOFF X` in `ON_ERROR` actually fires routing (previously no-op)
  - `TYPE: rate_limit` / `auth_failure` / `network_error` / `tool_timeout` handlers match for the first time
- **Cost impact:** zero — no new LLM calls
- **Latency impact:** `onChunk` call adds ~0ms (sync); handoff path may add one routing decision roundtrip if an ON_ERROR handler actually fires
- **Security impact:** error classifier must NOT leak server-side error detail into `resolution.respond`. Sanitizer already lives in `user-facing-error-sanitizer.ts` — we reuse it.

**Regression risks:**

1. Streaming deadlock if `onChunk` called after stream close → add guard + test
2. Handoff loop: `ON_ERROR → HANDOFF A → A errors → HANDOFF B → B errors → ...` — cap via existing handoff depth guard (reasoning-executor already has `MAX_HANDOFF_DEPTH`); add regression test
3. Error classifier false-positive: HTTP 429 from a tool that _isn't_ rate-limited (some APIs abuse 429). Classifier must be conservative; fall through to `tool_error` when ambiguous.
4. `DEFAULT` handler fallthrough still works — verify by unit test
5. Existing trace events (`error_handler_response`, `tool_error`) must not double-emit

**Tests to lock (TDD — these get written and committed before implementation):**

- `apps/runtime/src/__tests__/on-error-respond-streaming.test.ts` — RESPOND streams via onChunk in flow mode
- `apps/runtime/src/__tests__/on-error-handoff-routing.test.ts` — THEN: HANDOFF triggers real routing
- `apps/runtime/src/__tests__/on-error-handoff-depth-guard.test.ts` — handoff loop caps
- `apps/runtime/src/__tests__/tool-error-classifier.test.ts` — pure function: timeout / 401 / 429 / ECONNRESET / ambiguous fallthrough
- `apps/runtime/src/__tests__/on-error-handler-precedence.test.ts` — explicit type beats DEFAULT; subtype beats type
- `apps/runtime/src/__tests__/on-error-trace-emission.test.ts` — no duplicate trace events
- `apps/runtime/src/__tests__/on-error-sanitized-response.test.ts` — error classifier output is user-safe

**Exit criteria:**

- All 7 lock tests green
- `pnpm test:report` clean for `apps/runtime` and `packages/compiler`
- No regression in existing `flow-step-executor` tests
- `pr-reviewer` audit: minimum 5 rounds per CLAUDE.md SDLC rules
- Trace event inventory unchanged for happy path

**Commit plan:** 1 commit, `[ABLP-2] feat(runtime): complete ON_ERROR wiring — RESPOND streaming, HANDOFF routing, error classification`. Expect ~6 files, ~300 LOC.

---

### Slice 2 — Reask Retry Loop (HIGH)

**Items:** 5.1

**Files to modify:**

- `packages/compiler/src/platform/guardrails/action-applier.ts` — add `reask` to `CONTENT_MODIFYING_ACTIONS` (or keep terminal but mark regenerable)
- `packages/compiler/src/platform/guardrails/types.ts` — add `maxReasks?: number` to pipeline config
- `apps/runtime/src/services/execution/reasoning-executor.ts` — add `reask` branch with regeneration prompt injection + retry counter
- `apps/runtime/src/services/execution/reask-executor.ts` — **NEW** — pure function that builds the regeneration prompt from the violation

**Impact analysis:**

- **Blast radius:** any output guardrail with `action: reask` or `severityActions.X = reask`. Currently compiles and silently no-ops. This is a _behavior gain_ — no existing agent relies on reask being a no-op because the type system marks it terminal.
- **Cost impact:** up to `maxReasks` additional LLM roundtrips per guardrail hit. Default `maxReasks: 2` keeps worst case bounded at 3× baseline.
- **Latency impact:** proportional to reask count. Add P95 latency trace `guardrail_reask_latency_ms`.
- **Security impact:** regeneration prompt must NOT embed raw violation details that could help LLM bypass the guardrail. Prompt builder uses abstract categories (e.g., "the previous response contained disallowed content — regenerate avoiding that category") — verified via test.

**Regression risks:**

1. Infinite loop if `maxReasks` misconfigured — hard cap at 5, enforced in schema validation
2. Reask on tool call output vs assistant message output — only assistant messages should reask; tool outputs follow existing `redact`/`filter` path
3. Streaming + reask: if a reask fires mid-stream, need to cancel the stream cleanly. Per user decision #1, streaming eval is parked, so this is scoped to non-streaming only.
4. Reask interaction with other terminal actions: if a guardrail returns `escalate` AND `reask`, precedence table decides. Current precedence has `reask: 4`, `block: 6`, `escalate: 7`. Test: reask loses to block/escalate.
5. Telemetry: `reask_count` per session must land in trace store for cost tracking

**Tests to lock:**

- `packages/compiler/.../guardrails/__tests__/reask-action-applier.test.ts` — reask in CONTENT_MODIFYING or equivalent handling
- `apps/runtime/src/__tests__/reask-retry-loop.test.ts` — regenerates, terminates after N retries, emits traces
- `apps/runtime/src/__tests__/reask-precedence.test.ts` — block/escalate win
- `apps/runtime/src/__tests__/reask-prompt-builder.test.ts` — regeneration prompt safe (no bypass hints)
- `apps/runtime/src/__tests__/reask-config-validation.test.ts` — `maxReasks > 5` rejected at compile time
- `apps/runtime/src/__tests__/reask-non-streaming-only.test.ts` — skipped path documented for streaming (deferred)

**Exit criteria:**

- Lock tests green
- `pnpm test:report` clean
- `pr-reviewer` 5 rounds
- Trace event `guardrail_reask_attempt` visible in session traces

**Commit plan:** 2 commits — (a) `refactor(guardrails): extract reask prompt builder + schema`, (b) `feat(runtime): wire reask regeneration loop`. Keeps each under 20 files.

---

### Slice 3 — Guardrail Pipeline Correctness (MEDIUM)

**Items:** 5.4, 5.2

**Files to modify:**

- `packages/compiler/src/platform/guardrails/tier1-evaluator.ts` — call `resolveAction(guardrail, severity)` like Tier 2/3
- `packages/compiler/src/platform/guardrails/tier1-evaluator.ts` — factor out `resolveAction` to shared helper (currently duplicated in tier2/tier3)
- `packages/compiler/src/platform/guardrails/severity-resolver.ts` — **NEW** — shared helper
- `apps/runtime/src/services/execution/constraint-checker.ts` — skip guardrail violations in `checkConstraints` when pipeline ran already (track via `ctx.pipelineRan` flag)

**Impact analysis:**

- **Blast radius:** every Tier 1 guardrail with `severityActions` (CEL/regex checks). Audit says Tier 1 has 9 tests passing but severity paths are unused. Small real-world blast radius but correctness-critical.
- **Behavior change:** Tier 1 severity-specific `redact`/`fix`/`filter` now actually applies. Previously silently fell through to default action.
- **Cost / latency:** zero change.
- **Security impact:** guardrail violations that should redact severity=high now redact (previously leaked default action output). Slight security posture improvement.

**Regression risks:**

1. Existing Tier 1 tests assume default-action fallthrough — need to read those tests and confirm they test the default-path explicitly, not rely on severity-less config
2. Dedup skip-flag must propagate through nested calls (pipeline → checkConstraints). Wrong flag = guardrail never fires.
3. Metrics: we had 2× trace events per input guardrail previously; switch to 1× is a metric-dashboard-visible change. Note in release notes.

**Tests to lock:**

- `packages/compiler/.../__tests__/tier1-severity-resolution.test.ts` — severity-specific action wins over default
- `packages/compiler/.../__tests__/severity-resolver-shared.test.ts` — shared helper parity across tiers
- `apps/runtime/src/__tests__/guardrail-no-duplicate-eval.test.ts` — input guardrail fires once, not twice
- `apps/runtime/src/__tests__/guardrail-trace-event-count.test.ts` — trace event count stable

**Exit criteria:** lock tests green; `pr-reviewer` 5 rounds; trace event dashboard note.

**Commit plan:** 1 commit, `[ABLP-2] fix(guardrails): Tier 1 severity resolution + skip duplicate input eval`. ~4 files.

---

### Slice 4 — Remember Trigger Dedup (MEDIUM)

**Items:** 3.1

**Files to modify:**

- `apps/runtime/src/services/execution/memory-integration.ts` — batch `getMany()` before writes; skip `set()` when value unchanged
- `packages/compiler/src/platform/memory/memory-executor.ts` — expose `computeWritesWithDedup(triggers, currentValues)` helper
- `apps/runtime/src/services/execution/memory-integration.ts` — instrument write-skip trace

**Impact analysis:**

- **Blast radius:** every turn of every session with REMEMBER triggers. Per memory audit, this currently causes 2-4 redundant writes per turn.
- **Behavior change:** semantically zero — same end state, fewer writes
- **Cost / latency:** DB write amplification reduction ~70%. Latency per turn -5ms at p95.
- **Security impact:** none

**Regression risks:**

1. Value-equality edge cases: `{ a: 1 }` vs `{ a: 1 }` (different references, same value). Use deep equal, not reference equal.
2. `undefined` vs `null` vs missing — treat all three as "not set"; any transition to a defined value writes
3. PII-encrypted values: comparison must happen on decrypted form or on ciphertext-stable form. Verify via test.
4. Trace event still emits on _decision_ (skip vs write), so observability unaffected.
5. Tests that assert write count (if any) need updating — audit first.
6. Deep-equal depth cap is a project setting (`projectSettings.memory.dedupMaxDepth`, default 8, min 1, max 32). Beyond depth, treat as "changed" (safe fallback — writes).

**Tests to lock:**

- `apps/runtime/src/__tests__/remember-dedup-no-write-on-same-value.test.ts`
- `apps/runtime/src/__tests__/remember-dedup-write-on-change.test.ts`
- `apps/runtime/src/__tests__/remember-dedup-batch-getmany.test.ts` — verify one `getMany` call, not N individual gets
- `apps/runtime/src/__tests__/remember-dedup-deep-equal.test.ts` — object/array equality
- `apps/runtime/src/__tests__/remember-dedup-trace-emission.test.ts` — skip and write both traced

**Exit criteria:** DB write count metric drops in test fixture; lock tests green; `pr-reviewer` 5 rounds.

**Commit plan:** 1 commit, `[ABLP-2] perf(memory): dedup REMEMBER writes via read-before-write`. ~3 files.

---

### Slice 5 — PII Type Hints on GatherField (MEDIUM)

**Items:** 8.1

**Files to modify:**

- `packages/compiler/src/platform/ir/schema.ts` — add `pii_type?: 'email' | 'phone' | 'ssn' | 'credit_card' | 'address' | 'name' | 'custom'` to `GatherField`
- `packages/compiler/src/parser/` — parse `PII_TYPE:` key on gather field
- `packages/compiler/src/platform/security/pii-vault.ts` — honor hint on redact path
- `packages/compiler/src/platform/security/pii-detector.ts` — field name → pii_type resolution respects explicit hint first
- `docs/reference/ABL_SPEC.md` — document `PII_TYPE:` attribute

**Impact analysis:**

- **Blast radius:** any GATHER field with non-canonical name. Common in XO11 migration (e.g., `contact_info`, `customer_number`, `dob`). Bruce flagged this as migration blocker.
- **Behavior change:** redaction format now matches semantic type (phone format for phone, email format for email) even when field name is non-canonical
- **Security impact:** **positive** — prevents leaking partial-email-format phone numbers (e.g., `+14***@***` nonsense) in logs
- **Compile-time:** additive schema; existing DSL unaffected

**Regression risks:**

1. Canonical field names without explicit hint: preserve existing inference behavior (field `email` → email-shape redact)
2. `pii_type: 'custom'` — must have a validator or it's a no-op. Decision: `custom` requires `custom_redactor: <expression>`. Out of scope for this slice — reject `custom` without expression at compile time.
3. Telemetry: add `pii_hint_source: 'explicit' | 'inferred'` to redaction trace events for observability
4. XO migration: map Kore entity types → pii_type. Out of scope; follow-up slice can add alias table.

**Tests to lock:**

- `packages/compiler/src/__tests__/gather-field-pii-type-schema.test.ts`
- `packages/compiler/src/__tests__/gather-field-pii-type-parse.test.ts`
- `packages/compiler/src/__tests__/pii-vault-explicit-hint.test.ts`
- `packages/compiler/src/__tests__/pii-detector-hint-precedence.test.ts` — explicit > inferred
- `apps/runtime/src/__tests__/gather-non-canonical-field-redaction-e2e.test.ts` — E2E: `contact_info: PII_TYPE: email` → email-format redacted in session values

**Exit criteria:** lock tests green; `ABL_SPEC.md` section updated; `pr-reviewer` 5 rounds.

**Commit plan:** 2 commits — (a) `feat(compiler): add pii_type hint on GatherField`, (b) `docs(spec): document PII_TYPE attribute with migration notes`.

---

### Slice 6 — Semantics Polish + Docs (LOW)

**Items:** GATHER `enumSet` placement, 6.1 ON_INPUT deterministic doc

**Files to modify:**

- `packages/compiler/src/platform/ir/schema.ts` — add `enum_set?: string[]` to `GatherFieldSemantics` (alias to existing `GatherField.enum_values`) with deprecation note
- `docs/reference/ABL_SPEC.md` — add explicit "ON_INPUT must be deterministic — do not depend on LLM reasoning" callout (§ events)

**Impact analysis:**

- Schema additive; no behavior change
- Doc clarifies existing behavior — no code change

**Regression risks:** none (pure additive schema + doc)

**Tests to lock:**

- `packages/compiler/src/__tests__/gather-semantics-enumset-alias.test.ts` — `enum_set` in semantics resolves to `enum_values`

**Exit criteria:** schema compiles; spec section exists; `phase-auditor` on doc.

**Commit plan:** 1 commit, `[ABLP-2] feat(compiler,docs): enum_set semantics alias + ON_INPUT determinism doc`.

---

## Execution Protocol

### TDD Test-Lock Cycle (per slice)

1. **Draft tests** — write the 4–7 lock tests named above
2. **Run tests** — confirm all fail with expected error shape
3. **Commit lock** — `test(runtime|compiler): lock Slice N acceptance tests` — tests fail, lock baseline recorded
4. **Implement** — minimum code to pass locked tests, no scope creep
5. **Green** — run `pnpm test:report` for affected packages; fix regressions
6. **Audit** — spawn `pr-reviewer` agent (5 rounds, per CLAUDE.md SDLC rules)
7. **Fix audit findings** — CRITICAL must resolve before commit; HIGH should resolve
8. **Commit implementation** — `[ABLP-2] <type>(<scope>): <desc>` — reference slice number in body
9. **Cross-slice audit** — after every 2 slices, spawn `phase-auditor` for integration consistency
10. **`/post-impl-sync`** — update feature spec, test spec, HLD status

### Audit Gates

| Gate       | Tool                        | Blocks     | When           |
| ---------- | --------------------------- | ---------- | -------------- |
| Pre-commit | `npx prettier --write`      | Commit     | Every commit   |
| Pre-commit | `pnpm build --filter=<pkg>` | Commit     | Every commit   |
| Pre-commit | `pnpm test --filter=<pkg>`  | Commit     | Every commit   |
| Audit      | `pr-reviewer` (5 rounds)    | Merge      | Every slice    |
| Audit      | `phase-auditor`             | Next slice | Every 2 slices |

### Rollback Plan

Each slice is an independent commit. Any slice can be reverted with `git revert <sha>` without affecting later slices, because:

- Slice 1 (ON_ERROR) — additive behavior; revert = return to silent dead-air mode
- Slice 2 (reask) — additive runtime branch; revert = return to silent no-op
- Slice 3 (Tier 1 severity) — fixes a correctness bug; revert = restore broken-but-not-crashing behavior
- Slice 4 (memory dedup) — perf-only; revert = extra writes
- Slice 5 (PII hints) — additive schema; revert = drop `pii_type` field (schema is loose, safe)
- Slice 6 — additive semantics + doc

---

## Proposed Slice Order (ship order)

1. **Slice 3 — Guardrail Correctness** (smallest, unblocks trace-count metrics)
2. **Slice 4 — Memory Dedup** (isolated, perf win)
3. **Slice 1 — ON_ERROR Completion** (largest HIGH item)
4. **Slice 2 — Reask Retry Loop** (depends on trace infra from Slice 3)
5. **Slice 5 — PII Hints** (XO migration unblocker)
6. **Slice 6 — Semantics + Docs** (cleanup)

Rationale: smaller / safer slices first to build audit confidence; highest-blast-radius slice (1) in middle when we're warm; largest dependency chain (2 depends on 3's trace infra) respects order.

---

## Open Questions Before Execution

1. **Slice 1 — classifier source:** port `classifyToolError()` from `packages/arch-ai/src/types/errors.ts` or re-implement locally in `apps/runtime`? arch-ai lives under a different executor and import would create runtime→arch-ai coupling. Recommendation: **re-implement locally** in `apps/runtime/src/services/execution/tool-error-classifier.ts` using the same logic shape. Confirm?
2. **Slice 2 — reask default `maxReasks`:** propose **2** (so worst case is 3× baseline cost, bounded). Approve or pick a different default?
3. **Slice 2 — reask on streaming:** streaming reask is deferred per decision #1. Should we emit a compile-time warning when a streaming agent declares a guardrail with `action: reask`, or just let it fall back to block behavior silently? Recommendation: **compile-time warning** + trace event at runtime.
4. **Slice 4 — equality depth cap:** deep-equal on arbitrarily nested session values could OOM on malicious input. Recommendation: cap comparison depth at 8 levels; beyond that, treat as "changed" (safe fallback). Approve?
5. **Slice 5 — Kore entity type mapping:** in scope for this slice or separate slice? Recommendation: **separate slice** — don't bundle XO-specific migration logic with the base `pii_type` feature.
6. **Commit scope:** CLAUDE.md guardrail is 40 non-doc files / 3 packages. Slice 1 might push 6 files across 1 package. Slice 5 touches 2 packages. All fine. Just flagging.

---

## Success Metric

All 10 partially-addressed items transition to fully ADDRESSED status per the same verification methodology used in the 2026-04-18 audit, with tracked test coverage and clean `pr-reviewer` reports per slice.
