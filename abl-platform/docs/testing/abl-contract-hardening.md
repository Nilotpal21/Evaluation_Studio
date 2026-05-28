# Test Specification: ABL Contract Hardening

**Feature Spec**: `docs/features/abl-contract-hardening.md`
**HLD**: `docs/specs/abl-contract-hardening.hld.md`
**LLD**: `docs/plans/2026-04-18-abl-contract-hardening-impl-plan.md`
**Status**: BETA
**Last Updated**: 2026-04-19

---

## 1. Coverage Matrix

| FR    | Description                             | Current Type                                | Target Type                                 | Status | Notes                                                                                                                                                                                                            |
| ----- | --------------------------------------- | ------------------------------------------- | ------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FR-1  | Canonical contract registry             | integration + build check                   | integration + build check                   | DONE   | Phase 1 landed the registry, generated manifest, and freshness checks                                                                                                                                            |
| FR-2  | Reasoning vs FLOW parity                | unit + integration + regression             | unit + integration + regression             | DONE   | Shared execution regressions now cover CALL normalization, SET-path semantics, filtered templates, terminal-target normalization, and the public orchestration paths that exercise the same semantics end to end |
| FR-3  | Canonical `ON_RETURN`                   | unit + integration + regression             | unit + integration + regression             | DONE   | Named handlers, shorthand compatibility, and runtime return dispatch are covered end-to-end                                                                                                                      |
| FR-4  | Lookup ownership                        | partial integration                         | unit + integration + e2e                    | DONE   | Lookup ownership is enforced through compiler/runtime/docs and Studio/runtime-config alignment, with parity checks on the governed authoring surfaces                                                            |
| FR-5  | Stability tiers                         | partial integration                         | unit + integration                          | DONE   | Registry stability metadata now drives generated contract facts, governed long-form surfaces, and compiler-owned validation/gating coverage                                                                      |
| FR-6  | Memory contract                         | unit + integration + regression             | unit + integration + regression             | DONE   | Memory scopes, recall normalization, and runtime grant/writeback behavior are now covered                                                                                                                        |
| FR-7  | `HANDOFF` vs `ESCALATE` split           | partial integration                         | unit + integration + e2e                    | DONE   | Runtime behavior, public docs/examples, and long-form governed surfaces now consistently keep machine handoffs separate from human/system escalation                                                             |
| FR-8  | FLOW execution order                    | unit + integration + regression             | unit + integration + regression             | DONE   | Runtime-order warnings and step-entry mutation regressions are locked with dedicated tests                                                                                                                       |
| FR-9  | BankNexus reference quality             | example validation + smoke                  | example validation + smoke                  | DONE   | BankNexus now compiles and is checked as a hardened reference example                                                                                                                                            |
| FR-10 | Generated docs + build gating           | build/integration                           | build/integration                           | DONE   | `abl:docs:generate` and `abl:docs:check` are wired and validated                                                                                                                                                 |
| FR-11 | Round-trip & example validation         | integration + build gate                    | integration + build gate                    | DONE   | Contract docs/examples, BankNexus smoke, and guardrail round-trip checks are all wired into gates                                                                                                                |
| FR-12 | Migration & compatibility               | unit + integration                          | unit + integration                          | DONE   | Supported compatibility lanes are regression-covered, and the temporary authoring shorthands for `ON_RETURN`, `grant_memory`, and legacy recall aliases are now explicitly retired                               |
| FR-13 | Project guardrail round-trip            | integration + round-trip regression         | integration + round-trip regression         | DONE   | Export/import now preserves canonical guardrail assets with rebinding coverage                                                                                                                                   |
| FR-14 | `grant_memory` enforcement              | unit + integration + regression             | unit + integration + regression             | DONE   | Legacy shorthand lowers into explicit grants and runtime state is updated/enforced                                                                                                                               |
| FR-15 | `execution_tree` memory scope           | unit + integration + restore regression     | unit + integration + restore regression     | DONE   | Durable workflow memory now survives handoffs and restore paths with deny-path coverage                                                                                                                          |
| FR-16 | Reasoning context projection            | integration + regression                    | integration + regression                    | DONE   | Pre-turn execution view now surfaces session, granted, gather, and policy state into reasoning turns                                                                                                             |
| FR-17 | Dynamic pre-turn tool / prompt shaping  | integration + regression + perf guard       | integration + regression + perf guard       | DONE   | Functional reshaping now has a dedicated hot-path performance guard plus trace-level latency visibility                                                                                                          |
| FR-18 | Async handoff / background completion   | integration + resume/timeout regression     | integration + resume/timeout regression     | DONE   | Async remote resume, timeout, and shared return-dispatch behavior are covered                                                                                                                                    |
| FR-19 | Canonical trace event contract          | unit + integration + type-parity regression | unit + integration + type-parity regression | DONE   | Shared-kernel, observatory, runtime, and Studio now consume one parity-tested contract                                                                                                                           |
| FR-20 | Cross-agent memory & policy composition | integration + scenario smoke + e2e          | integration + scenario smoke + e2e          | DONE   | Runtime integration proof is now backed by public E2E coverage for named returns, execution-tree memory grants, policy shaping, and guardrail blocks                                                             |
| FR-21 | Curated long-form contract governance   | build/integration                           | build/integration                           | DONE   | Curated academy, Arch-AI, and static anatomy surfaces are now gated by contract-backed text + snippet checks                                                                                                     |

### Existing Coverage Baseline

Relevant existing suites already in repo:

- `packages/compiler/src/__tests__/ir/abl-spec-examples-validation.test.ts`
- `packages/compiler/src/__tests__/validate-coordination-config.test.ts`
- `packages/compiler/src/__tests__/compiler-output-contract.test.ts`
- `packages/compiler/src/__tests__/handoff-expect-return.test.ts`
- `packages/compiler/src/__tests__/memory-enhanced.test.ts`
- `packages/compiler/src/__tests__/lookup-compilation.test.ts`
- `packages/project-io/src/__tests__/core-direct-apply-orchestrator.test.ts`
- `packages/project-io/src/__tests__/core-direct-apply.test.ts`
- `packages/project-io/src/__tests__/folder-reader-diagnostics.test.ts`
- `packages/shared-kernel/src/__tests__/trace-event-contract.test.ts`
- `apps/runtime/src/__tests__/execution/handoff-return-propagation-regression.test.ts`
- `apps/runtime/src/__tests__/execution/cross-agent-memory-policy.test.ts`
- `apps/runtime/src/__tests__/execution/flow-set-remember-regressions.test.ts`
- `apps/runtime/src/__tests__/execution/reasoning-gather-handoff.test.ts`
- `apps/runtime/src/__tests__/execution/value-resolution.test.ts`
- `apps/runtime/src/__tests__/memory-integration.test.ts`
- `apps/runtime/src/__tests__/memory-scope-runtime.test.ts`
- `apps/runtime/src/__tests__/lookup-table-merger.test.ts`
- `apps/runtime/src/__tests__/project-io-routes.test.ts`
- `apps/runtime/src/__tests__/sessions/chat-routes.test.ts`
- `apps/runtime/src/__tests__/import-idempotent.e2e.test.ts`
- `apps/studio/src/__tests__/api-routes/api-project-io-roundtrip.test.ts`
- `apps/studio/src/__tests__/stores/trace-store.test.ts`
- `apps/runtime/src/__tests__/behavior-profiles.e2e.test.ts`

Current gap: no blocking coverage gap remains for the shipped contract-hardening program. Future work is optional product expansion only, such as a fully authored ABL guardrail source surface beyond the current canonical asset model plus JSON/YAML bundle projections.

---

## 2. Primary Risks

| Risk                                                      | Severity | Why It Matters                                                  | Minimum Proof Required                                                     |
| --------------------------------------------------------- | -------- | --------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Shared contract drifts again after landing                | CRITICAL | Recreates the current problem within one release                | generated-doc freshness gate + contract snapshot tests                     |
| Reasoning/FLOW parity regresses                           | HIGH     | Same construct behaves differently by execution mode            | paired parity tests exercising both paths                                  |
| Guardrail assets round-trip lossy or stop being canonical | HIGH     | Cross-agent project policy becomes impossible to ship cleanly   | import/export round-trip tests + schema validation + runtime binding proof |
| `ON_RETURN` / `grant_memory` compatibility breaks agents  | HIGH     | Existing examples and customer agents may stop working          | compatibility tests for shorthand + new typed forms                        |
| Memory semantics stay ambiguous across workflows          | HIGH     | Session, `execution_tree`, and user/project scopes can leak     | parser normalization tests + runtime scope tests + deny-path isolation     |
| Dynamic pre-turn shaping becomes static or inconsistent   | HIGH     | Auth/policy/tool gating failures leak capabilities or prompts   | per-turn policy/tool projection tests + fail-closed deny paths             |
| Async handoff resume paths stay partial                   | HIGH     | Long-running work can hang or return to the wrong parent        | suspend/resume timeout tests + completion routing regression               |
| Trace contract remains fragmented                         | HIGH     | Studio/observatory lose type safety and exhaustiveness checking | shared-kernel parity tests + downstream consumer map coverage              |
| BankNexus remains non-reference quality                   | MEDIUM   | Public examples continue teaching broken patterns               | compile/smoke validation and README assertions                             |

---

## 3. Mandatory Test Scenarios

### Contract Registry & Generated Docs

1. **INT-1: Contract registry generates stable manifest**
   - Compile/load the canonical registry and generate `docs/reference/generated/abl-contract.json`.
   - Assert deterministic ordering and stable field structure.
   - Regression: any new public construct must appear in the registry with stability metadata.

2. **INT-2: Generated quick reference stays in sync with the registry**
   - Run the generator and compare emitted quick-reference sections against checked-in artifacts.
   - Assert built-in function count, event list, system-variable table, and legal action lists match the manifest.

3. **INT-3: Mirrored app docs are stale-check protected**
   - `abl:docs:check` fails when `apps/docs-internal/content/abl-reference/` or `apps/studio/content/abl-reference/` differ from generated outputs.
   - This is a build/CI gate, not a runtime test.

4. **REG-1: Spec examples, quick-ref examples, and canonical examples all validate against the same contract**
   - Extend the existing example validation test to cover the generated/mirrored docs and selected example folders.
   - Fail on mismatched syntax or unsupported constructs.

### Reasoning vs FLOW Semantic Parity

5. **INT-4: Explicit result binding behaves the same in reasoning and FLOW**
   - Use paired fixtures that lower into each execution mode.
   - Assert result visibility, state updates, and follow-up branching are identical where the contract says they should be.

6. **INT-5: Computed state mutation is parity-tested**
   - Verify both reasoning and FLOW can compute/assign state in the supported public form.
   - If any difference remains, assert a documented validation warning/error instead of silent divergence.

7. **REG-2: FLOW evaluation order is frozen**
   - Create a regression suite around `GATHER`, `ON_INPUT`, `SET/CLEAR`, and completion checks.
   - Assert mutation visibility and branch resolution follow the documented order.

8. **REG-3: `COMPLETE_WHEN` lint / warning fires on dangerous FLOW usage**
   - Unit or integration coverage in compiler validation/language service.
   - Assert warning codes and help text remain stable.

### `ON_RETURN`, Handoff, Escalation, and History

9. **INT-6: Named return handlers execute correctly**
   - Compile a handoff using `RETURN_HANDLERS` plus `ON_RETURN.handler` and `map`.
   - Assert mapped values, handler execution, and trace behavior all occur in the correct order.

10. **REG-4: Legacy `ON_RETURN` shorthand remains compatible during migration**
    - Verify legacy shorthand is accepted only for supported compatibility forms.
    - Assert unsupported free-form actions produce deterministic diagnostics.

11. **INT-7: Default history strategy is `auto`, resolving to summary-only when safe and bounded raw history when summary-only would be lossy**
    - Validate runtime history resolution and child-thread behavior.
    - Assert duplicate-message prevention on handoff forwarding remains intact.

12. **REG-5: `HANDOFF` to human targets is rejected or rewritten according to the new contract**
    - Compiler/runtime validation must not silently accept human escalation disguised as handoff.

### Lookup Ownership, Stability Tiers, and Memory

13. **INT-8: Project lookup references resolve without agent-local duplication**
    - Studio/serializer/compiler path asserts `semantics.lookup` or equivalent reference form survives round-trip.
    - Runtime validates the referenced project-owned table.

14. **REG-6: Agent-table and project-table name conflicts fail closed**
    - Unit coverage for lookup merge/conflict helper.
    - Integration coverage that surfaces a clear diagnostic to the user/operator.

15. **INT-9: Stability tier metadata surfaces warnings for experimental constructs**
    - Language-service/compiler validation should mark experimental constructs distinctly.
    - Docs generator must include the same tier.

16. **INT-10: Canonical recall events normalize correctly**
    - Parser tests cover legacy aliases.
    - Generated docs and compiler diagnostics emit `ON: session:start` as canonical output.

17. **REG-7: Reserved `user_id` is immutable in public authoring**
    - Validation rejects user-authored mutation of reserved system identifiers unless explicitly system-populated.

18. **REG-8: Advanced memory forms are either documented beta or warned experimental**
    - Tests assert the declared support tier, not undocumented parser acceptance.

### Project Guardrails, Grants, and Cross-Agent Policy

19. **INT-11: Project guardrails round-trip through import/export without loss**

- Export a project containing guardrails, re-import it, and assert canonical guardrail-asset fidelity plus ownership rebinding across both the default `guardrails/*.guardrail.json` bundle projection and the alternate `guardrails/*.guardrail.yaml` projection.

20. **REG-9: Any authored guardrail projection compiles to the same canonical asset**

- Verify that all supported guardrail projections compile to the same canonical asset payload. Today that means JSON and YAML bundle projections emit equivalent guardrail objects; any future authored ABL surface must satisfy the same proof.

21. **INT-12: Legacy `grant_memory` lowers into explicit memory-grant metadata**

- Compiler tests verify shorthand parsing and lowering.
- Runtime tests verify the receiving agent sees the granted scope according to the canonical access rules.

22. **INT-13: `execution_tree` memory persists across a handoff chain but not across unrelated workflows**

- Create a multi-agent chain, write to `execution_tree`, and assert the data is visible to descendants and invisible to sibling sessions or later unrelated sessions.

23. **REG-10: Cross-workflow memory leakage fails closed**

- Deny-path tests prove one execution tree cannot read or overwrite another execution tree’s durable state.

24. **INT-14: Reasoning context projection includes session memory and granted memory**

- Runtime prompt/tool-builder tests assert `state.memory.session`, granted memory, and gather progress all feed the canonical pre-turn projection.

25. **INT-15: Tool availability is recalculated before each LLM turn**

- Change auth/policy state or guardrail state mid-session and assert the next turn sees the filtered toolset and prompt overlays.

26. **REG-11: Denied tools fail closed after policy/auth changes**

- Verify a tool available on one turn is removed on the next when policy changes, with no stale cached exposure.

27. **INT-16: Async handoff suspend/resume path completes deterministically**

- Start an async handoff, persist wait state, resume on completion, and assert the correct parent handler runs.

28. **REG-12: Async timeout and background failure paths route deterministically**

- Verify timeouts and failures hit the documented return/failure handlers and emit the expected traces.

### Trace Contract & Downstream Consumers

29. **INT-17: Shared-kernel, observatory, and Studio consume the same trace event contract**

- Parity tests compare canonical registry types to observatory schema and Studio presentation maps.

30. **REG-13: Valid runtime events require no local string casts downstream**

- Regression coverage proves events like `constraint_backtrack`, `dsl_on_input`, and `correction_invalidation` are typed end-to-end.

### Curated Long-Form Governance

31. **INT-18: Curated long-form/manual ABL surfaces stay on canonical coordination and memory terminology**

- Validate selected academy modules, Arch-AI knowledge cards, and static Studio anatomy assets against contract-backed must-have / must-not-have assertions.
- Fail on stale terms such as `grant_memory`, `ON_RETURN_MAP`, `Human_Agent` handoffs, or “four strategies” history guidance that omits `auto`.

32. **INT-19: Curated long-form ABL snippets remain parseable**

- Extract representative fenced/preformatted ABL snippets from the curated surfaces.
- Wrap fragment-only blocks in minimal scaffold docs where needed and assert the parser still accepts the examples.

33. **INT-20: Named `ON_RETURN` handlers referenced in curated long-form examples are actually defined**

- Scan curated long-form snippets for scalar `ON_RETURN` handler references.
- Fail when a handler is referenced without a matching `RETURN_HANDLERS` definition in the same snippet/surface.

### End-to-End Composition

34. **SMOKE-4: Cross-agent memory + policy scenario works end-to-end**

- Example or fixture flow: auth agent verifies identity, billing agent resumes via return handler, granted memory survives, `execution_tree` state persists, and project guardrails shape the available tools.

### BankNexus & Reference Examples

35. **SMOKE-1: BankNexus compiles as a self-consistent example**
    - Validate all referenced agents exist or are explicitly marked external.
    - Assert required bootstrap variables are established before specialist handoff.

36. **SMOKE-2: BankNexus transfer flow collects all required fields**
    - Example-driven runtime or compile-time smoke to prove `customer_id` and `from_account` are available before transfer execution.

37. **SMOKE-3: BankNexus human escalation path uses `ESCALATE`, not pseudo-human handoff**
    - Compile/runtime smoke verifies the example teaches the correct primitive.

---

## 4. Deny-Path & Failure-Path Coverage

- Unsupported `ON_RETURN` actions fail with stable diagnostics.
- Lookup conflicts fail closed with explicit errors or warnings; no silent precedence.
- Guardrail asset/schema mismatches fail import/export validation instead of silently dropping policy.
- Reserved system variables reject unsafe mutation.
- Cross-workflow access to `execution_tree` scope fails closed.
- Missing or revoked memory grants do not silently fall back to ambient persistent-memory access.
- Per-turn tool gating failures default to the smaller allowed toolset, not the larger cached one.
- Experimental constructs fail or warn consistently across compiler, LSP, and generated docs.
- Unknown or uncategorized trace events fail parity tests before downstream UI drift ships.
- Stale generated docs fail build/CI.
- BankNexus smoke fails if missing agents or broken bootstrap assumptions are reintroduced.

---

## 5. Reachability & Wiring Verification

The feature is not test-complete without wiring proof for these paths:

- registry-driven docs generation is invoked by an explicit repo script
- Turbo/build graph depends on docs freshness checks
- Studio and docs-internal surfaces consume generated content or validated mirrored artifacts
- project-io import/export paths round-trip guardrail assets using the canonical schema
- runtime executors actually use the finalized contract for `ON_RETURN`, history, lookup resolution, and flow order
- pre-turn prompt/tool shaping runs on each real execution turn, not only at session initialization
- async handoff completion routes are reachable from the production executor path
- shared-kernel trace contracts are imported by observatory and Studio instead of mirrored local unions
- BankNexus smoke is wired into the same example-validation pipeline or dedicated example-smoke path
- curated long-form validators read the shipped academy, Arch-AI, and static anatomy surfaces instead of detached fixtures

---

## 6. Suggested Test File Additions / Updates

| Area                     | File(s)                                                                                                                                                             |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Contract registry        | `packages/compiler/src/__tests__/contracts/abl-contract-registry.test.ts`                                                                                           |
| Generated docs freshness | `tools/abl-docs/check.ts` plus repo-level test/check script                                                                                                         |
| Reasoning/FLOW parity    | `packages/compiler/src/__tests__/ir/reasoning-flow-parity.test.ts`, `apps/runtime/src/__tests__/execution/reasoning-flow-parity.test.ts`                            |
| `ON_RETURN` handlers     | extend `packages/compiler/src/__tests__/validate-coordination-config.test.ts`, `apps/runtime/src/__tests__/execution/handoff-return-propagation-regression.test.ts` |
| Memory contract          | extend `packages/compiler/src/__tests__/memory-enhanced.test.ts`, `apps/runtime/src/__tests__/memory-integration.test.ts`                                           |
| Lookup ownership         | extend `apps/runtime/src/__tests__/lookup-table-merger.test.ts`, `apps/studio/src/__tests__/stores/` or serializer/store tests                                      |
| Guardrail round-trip     | `packages/project-io/src/__tests__/guardrail-roundtrip.test.ts`, import/export validator suites                                                                     |
| Pre-turn policy shaping  | `apps/runtime/src/__tests__/execution/pre-turn-policy-resolution.test.ts`, prompt/tool builder regression suites                                                    |
| Async handoff            | `apps/runtime/src/__tests__/execution/async-handoff-resume.test.ts`                                                                                                 |
| Trace contract           | extend `packages/shared-kernel/src/__tests__/trace-event-contract.test.ts`, `apps/studio/src/__tests__/stores/trace-store.test.ts`                                  |
| BankNexus smoke          | `packages/compiler/src/__tests__/examples/banknexus-smoke.test.ts` or shared example-validation extension                                                           |

---

## 7. Exit Criteria

This test spec is satisfied when:

- every approved workstream has at least one regression or integration proof at the correct boundary
- generated docs freshness is enforced in build/CI
- reasoning/FLOW shared semantics have paired tests
- project guardrails, `grant_memory`, `execution_tree`, and per-turn policy shaping all have boundary-level proof
- async handoff suspend/resume is covered by deterministic regression tests
- trace contract parity is enforced across shared-kernel, observatory, and Studio
- compatibility lanes for legacy forms are explicitly tested
- BankNexus is covered by automated smoke validation
- docs/examples sync is no longer a manual trust exercise
