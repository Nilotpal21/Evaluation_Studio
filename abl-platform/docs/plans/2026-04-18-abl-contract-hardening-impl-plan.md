# LLD / Implementation Plan: ABL Contract Hardening

**Feature Spec**: `docs/features/abl-contract-hardening.md`
**Test Spec**: `docs/testing/abl-contract-hardening.md`
**HLD**: `docs/specs/abl-contract-hardening.hld.md`
**Status**: DONE
**Last Updated**: 2026-04-19

---

## 1. Objective

Implement the approved ABL hardening program as one governed set of workstreams without creating new drift between compiler, runtime, Studio, project import/export, docs, traces, and examples.

Success requires:

- one canonical registry for public contract metadata
- compatibility-safe execution and import/export changes
- canonical project-wide guardrail assets
- explicit cross-agent memory grants and `execution_tree` scope
- per-turn policy, prompt, and tool shaping
- durable async handoff/background completion
- one canonical trace-event contract across packages
- generated docs freshness in build/CI
- validated reference examples, including BankNexus
- curated long-form contract governance for active authored training/knowledge/demo surfaces

---

## 2. Change Classification

### Persona Swim Lanes Touched

- **End user**: receives corrected runtime behavior, safer human-escalation/history defaults, and more predictable long-running orchestration
- **Agent developer**: authors against clearer ABL semantics, support tiers, and cross-agent memory/policy rules
- **Project/builder operator**: owns shared lookup data and project-wide guardrails
- **Platform developer**: owns the contract registry, generators, validators, trace contract, and compatibility windows

### Cross-Cutting Gate

- Persona Boundaries & Swim Lanes

### Primary Review Concerns

- Execution & Orchestration
- Reasoning vs Flow Path Consistency
- Session State, Metadata & Memory
- Import / Export / Round-Trip Fidelity
- Traceability, Audit & Observability

### Secondary Review Concerns

- Contracts & Compatibility
- Activation, Deployment & Reachability
- Docs, Examples, Cross-Module Consistency & Code Sanity
- Test Integrity, Regression Coverage & Behavior Validation

---

## 3. Implementation Strategy

### Guiding Rules

1. Land contract metadata and build gates before broad behavior edits.
2. Every semantic slice must update validation, runtime behavior, docs metadata, and example coverage together.
3. No phase closes on code-only proof; it needs wiring proof, round-trip proof where applicable, and docs/example sync proof where applicable.
4. Compatibility shims must be isolated, documented, and tracked for removal.
5. Guardrails, memory grants, async handoff, and trace contracts are one cross-agent policy story and must not be implemented as disconnected one-offs.
6. BankNexus is a required slice, not a postscript.

### Execution Order

1. Foundation and inventory freeze
2. Registry + docs-generation plumbing
3. Project policy assets + coordination contract hardening
4. Execution parity + pre-turn policy shaping + async orchestration
5. Memory grants, `execution_tree`, lookup, and stability-tier hardening
6. Canonical trace contract + downstream consumer alignment
7. Studio/docs/import-export/example alignment, including BankNexus
8. Rollout hardening and post-implementation sync
9. Curated long-form governance for authored academy, Arch-AI, and static anatomy surfaces

---

## 4. Phase Plan

## Phase 0: Inventory Freeze & Failing Proofs

**Status**: DONE

### Scope

Capture current drift explicitly and create the failing/regression proof points that later phases must satisfy.

### Target Files

- `docs/reference/ABL_SPEC.md`
- `docs/reference/ABL_QUICK_REFERENCE.md`
- `apps/docs-internal/content/abl-reference/full-specification.mdx`
- `apps/studio/content/abl-reference/full-specification.mdx`
- `docs/enterprise/GRAPH_TO_ABL_FEATURE_MAPPING.md`
- `packages/compiler/src/__tests__/ir/abl-spec-examples-validation.test.ts`
- `examples/banknexus/agents/*.abl`

### Tasks

1. Enumerate current public-contract mismatches across docs, examples, runtime, and import/export.
2. Freeze the list of canonical examples and mirrored docs that must stay in sync.
3. Capture the newly raised gaps around guardrails, `grant_memory`, session memory projection, async handoff, and trace typing in the SDLC artifacts.

### Exit Criteria

- Drift inventory is committed to the planning artifacts and test backlog.
- Example-validation scope includes at least spec examples, quick-ref examples, and BankNexus.
- No implementation phase begins without a known baseline for generated-doc, import/export, and example surfaces.

---

## Phase 1: Contract Registry & Docs Build Foundation

**Status**: DONE

### Scope

Create the canonical registry and the generate/check pipeline that prevents new drift while later behavior changes land.

### Target Files

- `packages/compiler/src/platform/contracts/` (new)
- `packages/compiler/src/index.ts`
- `package.json`
- `turbo.json`
- `docs/reference/generated/` (new)
- `apps/docs-internal/content/abl-reference/`
- `apps/studio/content/abl-reference/`
- `tools/abl-docs/` (new)

### Tasks

1. Create typed registry definitions for:
   - constructs
   - stability tiers
   - legal action values
   - system variables
   - canonical events
   - compatibility metadata
2. Create generators for:
   - contract manifest
   - quick-reference tables
   - mirrored app content or validated mirror snapshots
3. Add repo scripts:
   - `pnpm abl:docs:generate`
   - `pnpm abl:docs:check`
4. Wire `abl:docs:check` into Turbo/build/CI without silently mutating files during normal builds.

### Exit Criteria

- Registry compiles and is exported.
- Generated manifest and quick-reference outputs are deterministic.
- Build/CI can fail on stale generated docs.
- Mirrored docs surfaces are no longer free-floating hand-maintained factual copies.

### Review Focus

- Contracts & Compatibility
- Activation, Deployment & Reachability
- Docs, Examples, Cross-Module Consistency & Code Sanity

---

## Phase 2: Project Policy Assets & Coordination Contract Hardening

### Scope

Finalize project-wide guardrail ownership plus `ON_RETURN`, `HANDOFF`, `ESCALATE`, and history semantics.

### Target Files

- `packages/project-io/src/import/layer-disassemblers/guardrails-disassembler.ts`
- `packages/project-io/src/export/layer-assemblers/guardrails-assembler.ts`
- `packages/project-io/src/import/entity-schemas.ts`
- `packages/project-io/src/import/import-validator.ts`
- `packages/compiler/src/platform/ir/schema.ts`
- `packages/compiler/src/platform/ir/compiler.ts`
- `packages/compiler/src/platform/ir/validate-coordination-config.ts`
- `packages/compiler/src/platform/ir/validate-field-refs.ts`
- `apps/runtime/src/services/runtime-executor.ts`
- `apps/runtime/src/__tests__/execution/handoff-return-propagation-regression.test.ts`
- `apps/runtime/src/__tests__/execution/handoff-resume-intent.test.ts`
- `apps/runtime/src/__tests__/sessions/session-threading-context.test.ts`

### Tasks

1. Define canonical project guardrail asset handling and schema-backed round-trip rules.
2. Reserve the compatibility lane for any future ABL-facing guardrail authoring projection so it lowers to the same canonical project asset.
3. Add canonical named return-handler model to compiler/IR validation.
4. Preserve safe legacy shorthand behind documented compatibility rules.
5. Restrict `HANDOFF` to machine targets and formalize `ESCALATE` for human/system flows.
6. Set and test `auto` as the default history strategy, with strict `summary_only` reserved for authored-summary cases.
7. Preserve runtime safeguards already learned in `apps/runtime/agents.md`, including handoff stack cleanup ordering and duplicate-message prevention.

### Exit Criteria

- Guardrail assets round-trip deterministically through project-io.
- `ON_RETURN` legality is deterministic and test-backed.
- Human escalation can no longer hide inside handoff examples/contracts.
- History defaults and overrides are explicitly tested.
- Existing regression learnings remain preserved in runtime tests.

### Review Focus

- Import / Export / Round-Trip Fidelity
- Execution & Orchestration
- Contracts & Compatibility

---

## Phase 3: Execution Parity, Pre-Turn Policy Shaping, & Async Orchestration

### Scope

Align the public semantics shared by reasoning and FLOW, add per-turn prompt/tool shaping, and make async handoff/background completion a real suspend/resume contract.

### Target Files

- `apps/runtime/src/services/runtime-executor.ts`
- `apps/runtime/src/services/execution/reasoning-executor.ts`
- `apps/runtime/src/services/execution/flow-step-executor.ts`
- `apps/runtime/src/services/execution/routing-executor.ts`
- `apps/runtime/src/services/execution/types.ts`
- `packages/compiler/src/platform/ir/compiler.ts`
- `packages/compiler/src/platform/ir/validate-field-refs.ts`
- `packages/compiler/src/__tests__/...` (new parity suites)
- `apps/runtime/src/__tests__/execution/` (new parity, policy-shaping, async suites)

### Tasks

1. Define the shared result/state/action semantic contract and where parity is mandatory.
2. Add one canonical pre-turn projection for session state, granted memory, guardrail policy, and auth-derived tool shaping.
3. Rebuild or filter available tools and prompt overlays before each LLM turn based on the current projected state.
4. Implement or validate computed state mutation parity across both paths.
5. Publish and test the numbered FLOW execution order.
6. Promote async handoff/background completion into a durable suspend/resume contract with timeout and completion routing.
7. Add warnings/lints for risky constructs:
   - ambiguous `GATHER + ON_INPUT`
   - unsafe `COMPLETE_WHEN`
   - hidden or ignored mutation timing

### Exit Criteria

- Shared semantics are covered by paired parity tests.
- Pre-turn policy/tool shaping is exercised on real executor paths.
- Async handoff resume/timeout behavior is deterministic and regression-tested.
- FLOW execution-order doc + tests match.
- Any intentional divergence is explicit in validation/docs, not implicit in code.

### Review Focus

- Execution & Orchestration
- Reasoning vs Flow Path Consistency
- Session State, Metadata & Memory

---

## Phase 4: Memory Grants, `execution_tree`, Lookup Ownership, and Stability Tiers

### Scope

Implement the ownership and memory decisions that make multi-agent workflows predictable.

### Target Files

- `packages/core/src/parser/agent-based-parser.ts`
- `packages/core/src/parser/yaml-parser.ts`
- `packages/core/src/schema/abl-schema.json`
- `packages/compiler/src/platform/ir/schema.ts`
- `packages/compiler/src/platform/ir/compiler.ts`
- `apps/runtime/src/services/execution/flow-step-executor.ts`
- `apps/runtime/src/services/runtime-executor.ts`
- `apps/studio/src/components/settings/RuntimeConfigTab.tsx`
- `apps/studio/src/store/agent-detail-store.ts`
- `packages/compiler/src/__tests__/memory-enhanced.test.ts`
- `packages/compiler/src/__tests__/lookup-compilation.test.ts`
- `apps/runtime/src/__tests__/lookup-table-merger.test.ts`
- `apps/runtime/src/__tests__/memory-integration.test.ts`

### Tasks

1. Enforce agent-local enum vs project-owned lookup-table contract.
2. Preserve explicit conflict detection and deny-path tests.
3. Convert `grant_memory` from parsed-only metadata into explicit memory-grant behavior with compatibility handling.
4. Add durable `execution_tree` scope and define its lifecycle, isolation, and restore semantics.
5. Canonicalize recall events and reserved system-variable behavior.
6. Classify currently parsed advanced memory forms and hidden constructs into `core`, `beta`, or `experimental`.
7. Expose stability metadata to validators/docs/Studio help.

### Exit Criteria

- Lookup ownership is consistent across runtime and Studio authoring.
- `grant_memory` compatibility is preserved while the explicit grant contract is enforced.
- `execution_tree` scope is isolateable, durable, and test-backed.
- Canonical recall syntax is the only generated/public form.
- Reserved identifiers and advanced memory forms have explicit validation behavior.
- Stability tiers are emitted consistently across generators and diagnostics.

### Review Focus

- Session State, Metadata & Memory
- Persona Boundaries & Swim Lanes
- Contracts & Compatibility

---

## Phase 5: Canonical Trace Contract & Downstream Consumer Alignment

### Scope

Unify runtime event typing so shared-kernel, observatory, and Studio consume one canonical trace contract without local drift.

### Target Files

- `packages/shared-kernel/src/constants/trace-event-registry.ts`
- `packages/shared-kernel/src/types/trace-event.ts`
- `packages/observatory/src/schema/trace-events.ts`
- `apps/studio/src/store/trace-store.ts`
- `apps/studio/src/utils/observatory-event-presentation.ts`
- `apps/studio/src/utils/configuration-trace-events.ts`
- `apps/studio/src/utils/replay-trace-events.ts`
- `packages/shared-kernel/src/__tests__/trace-event-contract.test.ts`
- `apps/studio/src/__tests__/stores/trace-store.test.ts`

### Tasks

1. Define the canonical trace event union, registry metadata, and categorization rules in shared-kernel.
2. Converge observatory schema and Studio presentation maps on the shared contract.
3. Remove local string-cast escape hatches for valid runtime events.
4. Add parity tests that fail when emitted runtime events are missing from downstream consumers.

### Exit Criteria

- Shared-kernel is the canonical source of trace event typing and metadata.
- Observatory and Studio consume the same event contract without duplicated local unions.
- Valid runtime events like `constraint_backtrack`, `dsl_on_input`, and `correction_invalidation` are typed end-to-end.
- Parity tests protect future drift.

### Review Focus

- Traceability, Audit & Observability
- Activation, Deployment & Reachability
- Docs, Examples, Cross-Module Consistency & Code Sanity

---

## Phase 6: Docs, Studio, Import/Export, and Example Alignment

### Scope

Promote the new contract into all public surfaces, remove contradictory docs/guides, and repair BankNexus.

### Target Files

- `docs/reference/ABL_SPEC.md`
- `docs/reference/ABL_QUICK_REFERENCE.md`
- `apps/docs-internal/content/abl-reference/full-specification.mdx`
- `apps/studio/content/abl-reference/full-specification.mdx`
- `apps/docs-internal/content/guides/multi-agent-orchestration.mdx`
- `apps/studio/content/guides/multi-agent-orchestration.mdx`
- `apps/docs-internal/content/abl-reference/multi-agent-and-supervisor.mdx`
- `apps/studio/content/abl-reference/multi-agent-and-supervisor.mdx`
- `apps/docs-internal/content/abl-reference/memory-and-constraints.mdx`
- `examples/banknexus/README.md`
- `examples/banknexus/agents/BankNexus_Supervisor.agent.abl`
- `examples/banknexus/agents/fund_transfer.agent.abl`
- `examples/banknexus/agents/get_balance.agent.abl`
- `examples/banknexus/agents/transaction_history.agent.abl`

### Tasks

1. Replace stale repeated factual content with generated outputs or generated sections.
2. Update authored long-form docs to explain the new public contract and migration notes.
3. Remove guide/spec contradictions for `grant_memory`, async handoff, trace contracts, and memory scopes.
4. Update Studio help and authoring assumptions to match ownership/stability rules.
5. Repair BankNexus:
   - bootstrap `user_id` / `customer_id` and account context in supervisor or dedicated bootstrap agent
   - ensure transfer flow establishes `from_account`
   - replace pseudo-human handoff with `ESCALATE`
   - make dependencies explicit and self-contained

### Exit Criteria

- Canonical docs and mirrored app content agree on repeated facts.
- Public guides no longer claim `grant_memory` or async-handoff behavior that the runtime does not yet support.
- BankNexus compiles and passes smoke validation.
- Studio no longer teaches duplicate lookup ownership or stale contract facts.

### Review Focus

- Docs, Examples, Cross-Module Consistency & Code Sanity
- Activation, Deployment & Reachability
- Import / Export / Round-Trip Fidelity

---

## Phase 7: Rollout Hardening, CI Gates, and Post-Impl Sync

**Status**: DONE

### Scope

Finalize compatibility, enforce build gates, and sync all SDLC artifacts to the implemented state.

### Target Files

- root `package.json`
- `turbo.json`
- feature/test/HLD/LLD docs from this plan
- relevant package `agents.md` files
- `docs/sdlc-logs/` entries if used during implementation

### Tasks

1. Add/verify CI hooks for generated docs, guardrail round-trip, and example validation.
2. Document compatibility windows and removal targets for legacy forms.
3. Run post-implementation sync so feature spec, test spec, HLD, and LLD reflect actual file paths and final behavior.
4. Capture learnings in touched package `agents.md` files, especially runtime/compiler/project-io/docs/trace surfaces.

### Implementation Notes

- added `abl:contract:test` and `abl:contract:check` to the root build surface so generated docs, compiler contract tests, BankNexus smoke coverage, Phase 6 doc-alignment checks, and project-io guardrail round-trip regressions run together under one contract gate
- widened Turbo compiler-test inputs so authored docs, mirrored MDX, and example sources invalidate cached compiler test runs when the public contract changes
- fixed FLOW step-entry `SET` batching to route through the same remember/writeback helper path used by later state mutations, preserving the documented `SET` + `REMEMBER` contract on initial step entry
- fixed runtime granted-memory projection so readwrite `execution_tree` grants preserve writable metadata even when the source path starts unset, then write child-agent updates back into the durable workflow memory source of truth on return
- added a real cross-agent runtime proof where auth verification updates workflow-scoped memory, return-handler coordination resumes the parent route, and a downstream reasoning child sees both granted memory and current policy in its pre-turn system prompt
- synced the feature spec, test spec, HLD, LLD, indexes, SDLC logs, and package learning journals to the implemented state

### Verification Snapshot

- `pnpm --filter @agent-platform/runtime build` passes
- `pnpm --filter @agent-platform/runtime exec vitest run --config vitest.core.config.ts src/__tests__/execution/cross-agent-memory-policy.test.ts` passes
- `pnpm --filter @agent-platform/runtime exec vitest run --config vitest.core.config.ts src/__tests__/execution/flow-set-remember-regressions.test.ts src/__tests__/memory-scope-runtime.test.ts -t "step-entry SET batches trigger REMEMBER once|readwrite execution_tree grants preserve writable metadata without an initial value"` passes
- `pnpm abl:contract:check` passes

### Exit Criteria

- Build graph enforces contract freshness and guardrail round-trip validation.
- Legacy support is documented and bounded.
- All SDLC artifacts are current.
- Review worksheet evidence exists for the primary concerns.

### Review Focus

- Activation, Deployment & Reachability
- Test Integrity, Regression Coverage & Behavior Validation
- Docs, Examples, Cross-Module Consistency & Code Sanity

---

## Phase 8: Curated Long-Form Governance for Knowledge & Training Surfaces

**Status**: DONE

### Scope

Close the remaining drift outside the generated reference path by governing the active authored ABL teaching surfaces: Arch-AI knowledge cards, academy modules, and static Studio anatomy assets.

### Target Files

- `packages/arch-ai/src/knowledge/contract-facts.ts` (new)
- `packages/arch-ai/src/knowledge/cards/multi-supervisor.ts`
- `packages/arch-ai/src/knowledge/cards/cross-agent-validation.ts`
- `packages/arch-ai/src/knowledge/cards/memory-full.ts`
- `packages/arch-ai/src/knowledge/card-router.ts`
- `packages/arch-ai/src/__tests__/abl-contract-backed-knowledge.test.ts` (new)
- `packages/arch-ai/src/__tests__/golden-corpus/scenarios.ts`
- `packages/academy/content/modules/multi-agent-fundamentals/content.md`
- `packages/academy/content/modules/multi-agent-reference/content.md`
- `packages/academy/content/modules/multi-agent-reference/quiz.json`
- `packages/academy/content/modules/patterns-deployment/content.md`
- `packages/academy/content/modules/orchestration-patterns/content.md`
- `apps/studio/public/agent-anatomy/coordination.html`
- `apps/studio/public/agent-anatomy/index.html`
- `apps/studio/public/agent-anatomy/workflows.html`
- `apps/studio/public/agent-anatomy/monaco-editor-wireframe.html`
- `packages/compiler/src/__tests__/docs/phase8-long-form-contract-governance.test.ts` (new)
- root `package.json`

### Tasks

1. Create a contract-backed knowledge helper in Arch-AI so coordination/memory cards embed canonical facts directly from the compiler registry.
2. Update the affected Arch-AI cards to use canonical `RETURN_HANDLERS`, `memory_grants`, `history: auto`, `execution_tree`, and `session:start` guidance.
3. Normalize the curated academy modules away from stale `grant_memory`, `Human_Agent`, `ON_RETURN_MAP`, and “four strategies” history wording.
4. Normalize the static Studio anatomy/demo assets to the shipped coordination contract.
5. Add a curated long-form validator to the contract gate that combines:
   - text-level canonical-term assertions
   - forbidden legacy-term assertions
   - parseable ABL snippet checks
   - named `ON_RETURN` handler resolution checks inside examples
6. Extend the contract gate so Arch-AI build/test participates in the same CI surface as compiler/project-io contract checks.

### Exit Criteria

- Arch-AI coordination/memory knowledge consumes compiler-owned contract facts directly.
- Curated academy and static anatomy surfaces no longer teach stale coordination/memory semantics.
- `abl:contract:check` fails when those curated long-form surfaces regress.
- The implementation/feature/test/HLD artifacts record this governance lane explicitly.

### Review Focus

- Docs, Examples, Cross-Module Consistency & Code Sanity
- Contracts & Compatibility
- Activation, Deployment & Reachability

---

## 5. Cross-Phase Test Locking

No phase closes without the minimum proofs below:

- **Phase 1**: generated docs check + registry tests
- **Phase 2**: guardrail round-trip tests + `ON_RETURN` compatibility/regression tests + handoff/history tests
- **Phase 3**: paired reasoning/FLOW parity tests + per-turn policy/tool-shaping tests + async-handoff resume/timeout tests
- **Phase 4**: lookup conflict tests + `grant_memory` enforcement + `execution_tree` isolation/restore tests
- **Phase 5**: trace-contract parity tests across shared-kernel, observatory, and Studio
- **Phase 6**: spec/example validation + BankNexus smoke + public guide contradiction cleanup
- **Phase 7**: build/CI freshness proof + post-impl doc sync verification
- **Phase 8**: curated long-form contract validator + Arch-AI contract-backed knowledge + academy/static anatomy alignment

---

## 6. Review Worksheet

```md
Change:
ABL Contract Hardening

Persona swim lanes touched:

- End user: receives corrected runtime behavior, safer history/escalation semantics, and cleaner long-running orchestration
- Agent developer: authors against one public contract with explicit memory/policy semantics
- Project/builder operator: owns shared lookup tables and project-wide guardrails
- Platform developer: owns registry, generators, validators, compatibility windows, and shared trace contracts

Cross-lane source of truth / precedence:

- Platform registry owns public contract metadata
- Project runtime config and guardrail assets own shared project policy
- Agent DSL owns agent-local enums, handler references, and memory-grant declarations
- Runtime executes compiled IR under the published contract with per-turn policy projection

Primary concerns:

- Execution & Orchestration
- Reasoning vs Flow Path Consistency
- Session State, Metadata & Memory
- Import / Export / Round-Trip Fidelity
- Traceability, Audit & Observability
```

---

## 7. Commands & Verification Order

During implementation, use this order:

1. `pnpm build`
2. targeted package tests for the active slice
3. `pnpm abl:docs:generate` when generated artifacts changed
4. `pnpm abl:docs:check`
5. broader `pnpm test` or targeted integration/e2e suites after build passes

All changed files must be formatted before any commit:

- `npx prettier --write <files>`

---

## 8. Blockers / Dependencies

- The docs-generation location choice must be finalized early enough to avoid reworking app mirrors twice.
- The canonical authoring/projection story for project-wide guardrails must be locked before Phase 2 closes.
- Compatibility policy for legacy `ON_RETURN`, `grant_memory`, and recall syntax must be locked before the affected phases close.
- The canonical package ownership for the trace contract must be finalized before consumer migration starts.
- BankNexus repair depends on the finalized coordination, memory-grant, and bootstrap contract, so it should not start before Phases 2-4 stabilize.

---

## 9. Post-Implementation Notes

### Delivered Beyond the Original Skeleton

- Phase 7 hardened the CI/build contract more than the original plan text: the repo now has a single `abl:contract:check` gate that composes docs freshness, compiler contract coverage, example validation, and project-io round-trip proofs.
- The runtime slice also closed two concrete semantic gaps discovered during rollout hardening rather than leaving them as follow-up work: initial FLOW step-entry `SET` now participates in remember/writeback behavior, and empty-start readwrite grants can become writable later in the handoff tree.
- The final runtime integration proof for cross-agent memory and policy composition landed as an execution-level regression instead of staying only as a design/test-spec scenario.
- Phase 8 extended contract governance beyond generated docs into curated authored surfaces by combining direct contract-backed knowledge sections in Arch-AI with compiler-owned CI validation of academy and static anatomy content.
- A later runtime/import/compiler cleanup slice converted several rollout discoveries into supported contract behavior instead of leaving them as tribal knowledge: import preview now rejects invalid locale paths early, apply failures expose `stage` plus `sanitizedCause`, runtime defaults honor `Project.entryAgentName`, CALL/SET normalization is explicit, quoted timeout literals work, compiler outputs expose additive `errors` / `warnings`, and filtered templates fail closed.

### Remaining Promotion Work

- broader public E2E coverage is still needed before the feature can move from ALPHA to BETA
- dynamic pre-turn shaping still lacks a dedicated performance guard/benchmark
- compatibility lanes for legacy `ON_RETURN`, `grant_memory`, and recall aliases are still intentionally open and must be retired in a later compatibility-removal slice
