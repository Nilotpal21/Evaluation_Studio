# SDLC Log: ABL Contract Hardening — Implementation Phase

**Feature**: abl-contract-hardening
**Phase**: IMPLEMENTATION
**LLD**: `docs/plans/2026-04-18-abl-contract-hardening-impl-plan.md`
**Date Started**: 2026-04-18
**Date Completed**: 2026-04-19

---

## Preflight

- [x] LLD, feature spec, test spec, and HLD re-read from disk
- [x] Phase 1 file paths verified
- [x] Target signatures inspected before editing
- [x] Recent history checked for touched Phase 1 paths
- Discrepancies:
  - Working tree was already dirty at start, but the unrelated runtime/database changes were left untouched for this phase.
  - Phase 1 scaffold files already existed in the worktree and were treated as the in-progress implementation baseline.
  - Before Phase 2 implementation, the SDLC design artifacts were re-baselined to add project guardrails, `grant_memory`, `execution_tree`, pre-turn policy shaping, async handoff, and canonical trace-contract workstreams.

## Phase Execution

### LLD Phase 1: Contract Registry & Docs Build Foundation

- **Status**: DONE
- **Goal**: Land the canonical contract registry, deterministic generated artifacts, and stale-doc build gating before behavior changes.
- **Implementation**:
  - extended the registry with public-surface metadata, coordination actions, system-variable docs, and compatibility notes
  - moved contract facts into a lightweight shared source-data module so generation stays independent of runtime-heavy imports
  - generated `docs/reference/generated/*` artifacts plus app-facing `full-specification.mdx` mirrors from the canonical spec
  - wired `abl:docs:check` into direct `@agent-platform/docs-internal` and `@agent-platform/studio` builds
  - added Turbo build inputs for docs apps so canonical source changes invalidate cached builds
  - added registry/source alignment regression tests in the compiler package
- **Exit Criteria**: all met
  - `pnpm abl:docs:generate` passes
  - `pnpm abl:docs:check` passes
  - `pnpm --filter @abl/compiler build` passes
  - `pnpm --filter @abl/compiler test -- src/__tests__/contracts/abl-contract-registry.test.ts` passes
  - `pnpm --filter @agent-platform/docs-internal build` passes
  - `pnpm --filter @agent-platform/studio build` passes

### LLD Phase 2: Guardrail Policy Round-Trip Foundation

- **Status**: DONE
- **Goal**: Make project guardrail bundles preserve real exported policy fields and carry a portable agent-scoped anchor through import/export, then harden the first live coordination-contract semantics around `ON_RETURN` and safe history defaults.
- **Implementation**:
  - widened the `project-io` guardrail import and staged-record schemas to preserve `providerOverrides`, `rules`, `constitution`, `settings`, `caching`, `budget`, `version`, `previousVersionId`, `status`, `isActive`, and `_v`
  - normalized legacy `enabled` -> `isActive` and legacy `scope.agentId` -> canonical `scope.agentDefId`
  - added export-time `scope.agentName` enrichment for agent-scoped guardrails so bundles have a stable human-readable remap target
  - updated the guardrails disassembler to convert `scope.agentName` into a staged `_guardrailAgentName` temp field and avoid carrying stale source `agentDefId` values into the target project
  - extended Phase 2.5 cross-reference resolution to map `_guardrailAgentName` onto `guardrail_policies.scope.agentDefId`
  - added regression coverage across exporter, schema validation, disassembly, and cross-reference resolution
  - promoted the shared platform-default handoff history strategy into compiler contract data instead of runtime-local string literals
  - updated the contract registry to document the safe default explicitly and regenerated the mirrored contract artifacts
  - fixed the docs generator to resolve repo Prettier config before formatting generated artifacts, eliminating drift between `abl:docs:generate`, `abl:docs:check`, and the pre-commit hook
  - added compiler validation for unreachable `ON_RETURN` usage on `RETURN: false` handoffs so impossible coordination configs fail with a stable warning
  - updated runtime routing/session regression coverage to prove the new default keeps summaries without copying raw parent messages
  - added first-class `RETURN_HANDLERS` support to the core ABL AST, text parser, YAML parser, and JSON schema while preserving legacy `ON_RETURN` shorthand
  - normalized compiler coordination IR so `ON_RETURN` now compiles to built-in action strings or canonical `{ handler, map }` objects backed by `coordination.return_handlers`
  - extended coordination validation to reject ambiguous action+handler mixes, flag unknown named handlers, and prevent handler names from colliding with built-in `ON_RETURN` actions
  - wired runtime return-handler behavior through both immediate handoff returns and delayed multi-turn thread returns, including state clearing and follow-up response emission
  - preserved conversation-history integrity by merging handler follow-up messages into the just-returned child assistant entry instead of creating consecutive assistant messages
  - regenerated contract facts to document named return handlers and the machine-agent `HANDOFF` versus human/system `ESCALATE` split
- **Verification Snapshot**:
  - `pnpm --filter @agent-platform/project-io build` passes
  - `pnpm --filter @agent-platform/project-io test -- src/__tests__/entity-schemas.test.ts src/__tests__/layer-disassemblers.test.ts src/__tests__/cross-ref-resolver.test.ts src/__tests__/guardrails-assembler.test.ts` passes
  - `pnpm --filter @abl/compiler build` passes
  - `pnpm --filter @abl/core build` passes
  - `pnpm --filter @agent-platform/runtime build` passes
  - `pnpm --filter @abl/core test -- src/__tests__/parser-handoff-enhanced.test.ts src/__tests__/yaml-parser.test.ts src/__tests__/abl-schema.test.ts` passes
  - `pnpm --filter @abl/compiler test -- src/__tests__/handoff-return-handlers-compilation.test.ts src/__tests__/validate-coordination-config.test.ts src/__tests__/contracts/abl-contract-registry.test.ts` passes
  - `pnpm --filter @agent-platform/runtime exec vitest run --config vitest.core.config.ts src/__tests__/routing/routing-executor-unit.test.ts src/__tests__/execution/handoff-resume-intent.test.ts` passes
  - `pnpm abl:docs:generate` passes
  - `pnpm abl:docs:check` passes
  - `pnpm --filter @agent-platform/docs-internal build` passes
  - `pnpm --filter @agent-platform/studio build` passes

### LLD Phase 3: Execution Parity, Pre-Turn Policy Shaping, & Async Orchestration

- **Status**: DONE
- **Goal**: Align reasoning/FLOW execution surfaces, shape prompts/tools from a canonical pre-turn view, and make async remote handoff completion a durable suspend/resume contract.
- **Implementation**:
  - added a canonical pre-turn execution view that projects session memory, granted memory, gather progress, auth-derived tool availability, and cached guardrail policy from live runtime session state
  - moved projected prompt sections into shared prompt templates and prompt-builder context generation so standard prompts, custom `SYSTEM_PROMPT`, and FLOW reasoning zones all render the same surface without duplicate `Current Context` blocks
  - refreshed reasoning-mode prompt/tool surfaces before the initial LLM call and after state-changing events (pre-pass gather extraction, profile changes, pipeline tool filtering, guardrail input rewrites, and tool execution)
  - let FLOW reasoning zones supply a per-step surface builder so their step-specific goals/tool constraints survive pre-turn refreshes inside the shared reasoning executor
  - centralized handoff post-return behavior in `dispatchHandoffOnReturnBehavior()` and reused it across local handoffs, synchronous remote returns, streamed remote returns, and async remote resume callbacks
  - promoted async remote handoff completion into a real runtime contract by forwarding typed `remoteHandoffResume` payloads from `ResumptionService`, restoring parent threads in `RuntimeExecutor.executeMessage()`, and routing timeout/completion responses through the same `ON_RETURN` behavior
  - preserved suspended-thread metadata needed for cold rehydration by serializing/deserializing per-thread timing, return expectations, flow position, pending response/rich content, and `AWAIT_ATTACHMENT` state in `SessionStateRepo`
  - extended the durable session-state schema to carry `suspended` / `human_agent` statuses and per-thread metadata buffers
  - added FLOW runtime-semantic warnings for risky `COMPLETE_WHEN`, mixed `GATHER + ON_INPUT`, and reasoning-step post-mutation timing
  - completed the pre-existing `piiType` wiring gap in `compileFlow` so the phase build could pass against the current worktree
- **Verification Snapshot**:
  - `pnpm --filter @agent-platform/shared build` passes
  - `pnpm --filter @agent-platform/database build` passes
  - `pnpm --filter @abl/core build` passes
  - `pnpm --filter @agent-platform/execution build` passes
  - `pnpm --filter @abl/compiler build` passes
  - `pnpm --filter @agent-platform/runtime build` passes
  - `pnpm --filter @abl/compiler test -- src/__tests__/validate-flow-runtime-semantics.test.ts` passes
  - `pnpm --filter @agent-platform/runtime exec vitest run --config vitest.core.config.ts src/__tests__/routing/prompt-builder.test.ts src/__tests__/routing/routing-remote-handoff.test.ts src/__tests__/execution/async-handoff-resume.test.ts src/__tests__/sessions/session-state-repo.test.ts` passes
  - `pnpm --filter @agent-platform/runtime exec vitest run --config vitest.core.config.ts src/__tests__/execution/handoff-resume-intent.test.ts src/__tests__/sessions/session-threading-context.test.ts src/__tests__/routing/routing-executor-helpers.test.ts` passes

### LLD Phase 4: Memory Grants, `execution_tree`, Lookup Ownership, and Stability Tiers

- **Status**: DONE
- **Goal**: Make cross-agent memory sharing explicit and durable, formalize `execution_tree` workflow memory, and surface lookup/stability guidance consistently across runtime, validators, docs, and Studio authoring.
- **Implementation**:
  - extended the core AST, text parser, YAML parser, and JSON schema so persistent memory supports `scope: execution_tree` and handoff context supports explicit `memory_grants` entries while preserving `grant_memory` shorthand
  - canonicalized parser-emitted recall aliases onto lifecycle event names like `session:start` and `session:end`, keeping legacy aliases as accepted input but not as generated/public output
  - widened compiler IR to carry `execution_tree` persistent scope and normalized handoff memory grants, then added validation for undeclared grants, invalid `readwrite` requests, immutable system identifiers, and experimental agent-local `LOOKUP_TABLES`
  - documented the new contract in the compiler-owned registry, including `memory.persistent.execution_tree`, `handoff.context.memory_grants`, `handoff.grant-memory-shorthand`, and the system-owned `project_id` / `user_id` variables
  - added hidden durable workflow memory on runtime sessions via `executionTreeValues`, projected declared workflow memory into `session.data.values.execution_tree`, and restored that state through runtime-session creation plus Redis/session-state persistence
  - taught memory initialization, `REMEMBER`, `RECALL`, flow `SET`, reasoning `__set_context__`, tool context updates, and handoff grant hydration to read/write the scoped workflow memory contract instead of treating everything as flat session state
  - added runtime granted-memory metadata so readwrite grants can flow changes back into the shared `execution_tree` source of truth, including sync/clear behavior for both the alias surface and the underlying workflow store
  - surfaced the lookup ownership decision in Studio’s runtime-config authoring UI so project runtime lookup tables are presented as the canonical shared source and agent-local `LOOKUP_TABLES` are called out as experimental compatibility only
- **Verification Snapshot**:
  - `pnpm --filter @abl/core build` passes
  - `pnpm --filter @abl/compiler build` passes
  - `pnpm --filter @agent-platform/execution build` passes
  - `pnpm --filter @agent-platform/runtime build` passes
  - `pnpm --filter @abl/core test -- src/__tests__/parser-memory-enhanced.test.ts src/__tests__/parser-memory-scope.test.ts src/__tests__/parser-handoff-enhanced.test.ts src/__tests__/yaml-parser.test.ts src/__tests__/abl-schema.test.ts` passes
  - `pnpm --filter @abl/compiler test -- src/__tests__/validate-coordination-config.test.ts src/__tests__/memory-enhanced.test.ts src/__tests__/lookup-compilation.test.ts src/__tests__/contracts/abl-contract-registry.test.ts src/__tests__/validate-integration.test.ts src/__tests__/session-memory-validation.test.ts` passes
  - `pnpm --filter @agent-platform/execution test -- src/__tests__/child-session.test.ts` passes
  - `pnpm --filter @agent-platform/runtime exec vitest run --config vitest.core.config.ts src/__tests__/memory-scope-integration.test.ts src/__tests__/memory-scope-runtime.test.ts src/__tests__/routing/routing-executor-unit.test.ts` passes
  - `pnpm --filter @agent-platform/studio build` passes

### LLD Phase 5: Canonical Trace Contract & Downstream Consumer Alignment

- **Status**: DONE
- **Goal**: Make shared-kernel the single source of truth for trace event typing/metadata and migrate observatory, runtime, and Studio consumers onto that contract without losing dotted replay compatibility.
- **Implementation**:
  - promoted `packages/shared-kernel/src/constants/trace-event-registry.ts` into the canonical inventory for trace domains, `ALL_TRACE_EVENT_TYPES`, runtime-emitted subsets, and registry metadata
  - widened the shared-kernel public barrel and trace type exports so downstream packages consume the same `TraceEventType` / `ExtendedTraceEventType` contract instead of maintaining narrower local unions
  - replaced the giant observatory-local trace union in `packages/observatory/src/schema/trace-events.ts` with shared-kernel re-exports while preserving observatory-owned payload interfaces and protocol schema
  - added an explicit observatory workspace dependency on shared-kernel and wired the TS project reference so observatory builds against the canonical contract directly
  - moved runtime trace-type ownership for generic runtime traces, voice trace events, and guardrail trace events onto shared-kernel while leaving observatory responsible for platform-name mappings and richer payload-layer helpers
  - switched the Studio trace store default filter state to `ALL_TRACE_EVENT_TYPES`, eliminating the stale hand-maintained event list that had already drifted from runtime reality
  - tightened Studio observatory presentation typing so label lookups use a typed guard instead of indexing a broad `Record<string, string>` surface
  - fixed downstream observatory interaction consumers to normalize dotted replay event names through `normalizeEventType()` instead of carrying legacy dotted-name branches in the main interaction processor and parallel-tool swim-lane logic
  - added explicit dotted compatibility aliases for `llm.call.failed`, `tool.call.failed`, and `tool.call.retried` in observatory trace-event mappings so replay normalization is deliberate and test-backed rather than an accidental consequence of the reverse map
- **Verification Snapshot**:
  - `pnpm install --filter @agent-platform/observatory...` passes
  - `pnpm --filter @agent-platform/shared-kernel build` passes
  - `pnpm --filter @agent-platform/observatory build` passes
  - `pnpm --filter @agent-platform/runtime build` passes
  - `pnpm abl:docs:generate` passes
  - `pnpm abl:docs:check` passes
  - `pnpm --filter @agent-platform/docs-internal build` passes
  - `pnpm --filter @agent-platform/studio build` passes
  - `pnpm --filter @agent-platform/shared-kernel test -- src/__tests__/trace-event-contract.test.ts` passes
  - `pnpm --filter @agent-platform/observatory test -- src/__tests__/trace-event-mappings.test.ts src/__tests__/trace-events-attachments.test.ts` passes
  - `pnpm --filter @agent-platform/studio exec vitest run src/__tests__/event-types.test.ts src/__tests__/stores/trace-store.test.ts src/__tests__/interactions-contract.test.ts src/__tests__/observatory-event-presentation.test.ts src/__tests__/interactions-event-processor.test.ts src/__tests__/interactions-parallel-detect.test.ts` passes
  - `pnpm --filter @agent-platform/runtime exec vitest run --config vitest.core.config.ts src/__tests__/execution/guardrails/trace-events.test.ts src/__tests__/observability/trace-emitter.test.ts` passes

## Wiring Verification

- [x] Registry exported through compiler public barrels
- [x] Generated artifacts written under `docs/reference/generated/`
- [x] App mirror pages generated from canonical spec source
- [x] Direct Studio/docs-internal builds fail on stale generated docs
- [x] Turbo cache keys include canonical doc-generation inputs for docs builds
- [x] Agent-scoped guardrail bundles export `scope.agentName` when the source agent can be resolved
- [x] Guardrail import validation preserves the real policy payload instead of stripping it to the legacy subset
- [x] Guardrail disassembly now stages a portable temp join field for agent-scoped remapping
- [x] Cross-ref resolution remaps staged guardrails onto target `project_agents` via `scope.agentDefId`
- [x] Runtime handoff history fallback now comes from shared compiler contract exports
- [x] Generated contract artifacts reflect the shared handoff-history default without manual edits
- [x] Compiler coordination validation warns when `ON_RETURN` is declared on a permanent (`RETURN: false`) handoff
- [x] Core DSL surfaces now accept canonical named `RETURN_HANDLERS` alongside legacy `ON_RETURN` shorthand
- [x] Compiler IR now carries normalized `coordination.return_handlers` plus `{ handler, map }` handoff return references
- [x] Runtime return handling now applies named handler effects in both immediate and delayed thread-return paths
- [x] Generated contract facts now document named return handlers and the machine-only `HANDOFF` contract
- [x] Reasoning-mode prompt/tool shaping now flows through one canonical pre-turn execution view
- [x] Shared system prompts, custom system prompts, and FLOW reasoning zones now render the same projected memory/policy context
- [x] Async remote handoff completions now re-enter `executeMessage()` through a typed resume payload instead of an untyped text-only callback
- [x] Synchronous, streamed, and async remote returns now reuse the same handoff `ON_RETURN` dispatcher
- [x] Suspended-thread metadata required for remote return and `AWAIT_ATTACHMENT` resumption now round-trips through cold session storage
- [x] FLOW runtime-semantic warnings are emitted from compiler IR validation and covered by dedicated regression tests
- [x] Shared-kernel trace registry now exports the full canonical event inventory plus registry metadata through a public package barrel
- [x] Observatory schema now re-exports trace event inventory/types from shared-kernel instead of maintaining a second authoritative union
- [x] Runtime trace type surfaces for generic, voice, and guardrail traces now consume the shared-kernel contract directly
- [x] Studio trace-store defaults now bind to `ALL_TRACE_EVENT_TYPES` instead of a local mirrored subset
- [x] Dotted failure/retry platform event aliases now normalize explicitly through observatory mapping helpers instead of relying on incomplete reverse-map coverage
- [x] Manual docs-internal/studio guide/reference pairs are locked under byte-identical regression coverage for the authored Phase 6 pages
- [x] BankNexus reference examples no longer rely on undeclared flow steps or README-only bundle paths that do not exist on disk
- [x] Standalone guide snippets that use named `ON_RETURN` handlers now define matching `RETURN_HANDLERS` blocks in the same code fence

## Acceptance Snapshot

- Phase 1 foundation completed without touching the unrelated runtime/database changes already present in the worktree
- Generated-doc freshness is now deterministic and build-gated
- Compiler registry coverage is test-backed
- Phase 2 guardrail portability/preservation foundation is now implemented and test-backed inside `project-io`
- Phase 2 coordination-default hardening is now implemented and test-backed across compiler, runtime, and generated contract docs
- Phase 2 named return-handler semantics are now implemented and test-backed across core parsing, compiler normalization/validation, runtime execution, and generated contract docs
- Phase 3 pre-turn policy/tool shaping is now implemented and exercised on reasoning and FLOW execution paths
- Phase 3 async remote handoff completion is now deterministic across direct returns, queue-driven resumes, and cold-thread rehydration paths
- Phase 3 FLOW runtime-semantic warnings are implemented and regression-tested in compiler validation
- Phase 4 explicit memory grants are now implemented end-to-end with compatibility handling for legacy `grant_memory`
- Phase 4 `execution_tree` workflow memory is durable across handoffs/session persistence and exposed through typed runtime projections instead of ad hoc flat session keys
- Phase 4 lookup ownership and stability guidance are now emitted through validator/docs surfaces and reflected in Studio runtime-config authoring
- Phase 5 canonical trace-event ownership is now implemented: shared-kernel owns the contract, observatory re-exports it, runtime consumes it directly, and Studio defaults/tests are aligned to the same inventory
- Phase 5 dotted replay failure/retry aliases are now explicit and regression-tested instead of being partial reverse-map accidents
- Phase 6 canonical docs/manual guides now align with the hardened coordination and memory contract, and that alignment is build/test backed
- Phase 6 BankNexus is now a self-consistent reference bundle with supervisor bootstrap, explicit memory grants, human `ESCALATE`, and specialist account-context establishment
- Phase 7 rollout hardening is complete: the contract gate is on the real build path, rollout-time runtime gaps are closed, and the SDLC artifact set now reflects the implemented state
- Remaining work is now feature-promotion work only: broader public E2E coverage for BETA, a dedicated dynamic pre-turn shaping performance guard, and planned retirement of temporary legacy compatibility lanes

## Review Rounds

| Round | Verdict          | Critical | High | Medium | Low |
| ----- | ---------------- | -------- | ---- | ------ | --- |
| 1     | PASS AFTER FIXES | 0        | 0    | 1      | 0   |
| 2     | PASS             | 0        | 0    | 0      | 0   |
| 3     | PASS AFTER FIXES | 0        | 0    | 2      | 0   |
| 4     | PASS AFTER FIXES | 0        | 0    | 1      | 0   |
| 5     | —                | —        | —    | —      | —   |

### Round 1 Notes

- Found one medium-gap in regression coverage: the new async remote resume branch in `RuntimeExecutor.executeMessage()` was only covered indirectly through `ResumptionService`.
- Fixed by adding a direct runtime regression that drives `remoteHandoffResume` through `executeMessage()` and proves the parent thread is restored after a suspended remote child completes.

### Round 2 Notes

- Broader routing/session regressions passed without additional fixes after rerunning the existing `handoff-resume-intent`, `session-threading-context`, and `routing-executor-helpers` suites.

### Phase 4 Review Notes

- **Round 1 verdict**: PASS AFTER FIXES
  - Found one medium runtime-coordination issue: direct writes and clears against execution-tree memory did not keep readwrite granted-memory aliases synchronized when both surfaces referenced the same shared workflow path.
  - Fixed by making scoped execution-tree writes update matching granted aliases, clearing matching aliases when the source path is removed, and preferring the hidden workflow store as the source of truth when rehydrating handoff grants.
- **Round 2 verdict**: PASS AFTER FIXES
  - Found one medium regression-gap issue: an older core parser suite still asserted the legacy `session_start` output even though Phase 4 intentionally canonicalizes parser-emitted recall events to `session:start`.
  - Fixed by updating the stale parser regression to assert the canonical public form and then rerunning the broader core/compiler/runtime Phase 4 sweep.

### Phase 5 Review Notes

- **Round 1 verdict**: PASS AFTER FIXES
  - Found one medium downstream-consumer issue under the traceability and contracts rubric: Studio’s interaction processor and parallel swim-lane helper still carried dotted-name comparisons even though the observatory ingestion path is supposed to normalize trace types at the edge.
  - Fixed by routing those consumers through `normalizeEventType()`, removing the dotted-name branching from the main interaction logic, and adding Studio regressions that prove dotted replay events still classify correctly after normalization.
- **Round 2 verdict**: PASS AFTER FIXES
  - Found one medium compatibility gap under the contracts and reachability rubric: observatory’s dotted replay normalization depended on a reverse map that never explicitly covered `llm.call.failed`, `tool.call.failed`, or `tool.call.retried`, so some legacy platform events were not actually normalizable.
  - Fixed by introducing explicit `PLATFORM_TO_TRACE_ALIASES`, wiring them into the canonical platform-to-trace mapping, extending the mapping contract tests, and rerunning the observatory + Studio normalization regressions.

### LLD Phase 6: Docs, Studio, Import/Export, and Example Alignment

- **Status**: DONE
- **Goal**: Align public docs, authored guide snippets, and the BankNexus reference bundle to the hardened ABL coordination/memory contract without leaving stale examples behind.
- **Implementation**:
  - updated `docs/reference/ABL_SPEC.md` and `docs/reference/ABL_QUICK_REFERENCE.md` to teach canonical `session:start` recall events, `execution_tree` scope, `memory_grants`, machine-only `HANDOFF`, safe `auto` history defaults with strict `summary_only` opt-in, and the shipped async handoff contract
  - refreshed the authored docs-internal and Studio guide/reference pages so they remove pseudo-human handoff examples, explain `ESCALATE`, keep mirrored pages byte-identical, and make standalone `ON_RETURN` handler snippets self-contained
  - repaired BankNexus so the supervisor bootstraps customer context once, specialists share workflow-scoped state through explicit grants, transfer/history agents establish account context before acting, and human resolution uses `ESCALATE`
  - added Phase 6 compiler regressions covering mirrored-doc parity, hardened contract facts in authored docs, BankNexus bundle compilation, flow-step declaration drift, and README structure drift
- **Verification Snapshot**:
  - `pnpm --filter @abl/core build` passes
  - `pnpm --filter @abl/compiler build` passes
  - `pnpm abl:docs:generate` passes
  - `pnpm abl:docs:check` passes
  - `pnpm --filter @agent-platform/docs-internal build` passes
  - `pnpm --filter @agent-platform/studio build` passes
  - `pnpm --filter @abl/compiler test -- src/__tests__/examples/banknexus-smoke.test.ts src/__tests__/docs/phase6-doc-alignment.test.ts src/__tests__/ir/abl-spec-examples-validation.test.ts` passes

### Phase 6 Review Notes

- **Round 1 verdict**: PASS AFTER FIXES
  - Found one medium example-integrity issue under the docs/examples and reachability rubric: `Transaction_History` jumped to `apply_filter_choice` without declaring that flow step, and the BankNexus README still advertised a `tools/` folder that does not exist in the example bundle.
  - Fixed by declaring `apply_filter_choice` in the flow step list, correcting the README structure block, and extending the BankNexus smoke test to lock both invariants.
- **Round 2 verdict**: PASS AFTER FIXES
  - Found one medium docs copy-paste issue under the contract-consistency rubric: two standalone guide snippets used named `ON_RETURN` handlers without defining matching `RETURN_HANDLERS`, making the examples invalid when copied in isolation.
  - Fixed by adding local `RETURN_HANDLERS` blocks to the docs-internal and Studio guide snippets, clarifying that child return data merges before the handler continues, and extending the Phase 6 doc-alignment regression to catch stale fallback/handler drift.

### LLD Phase 7: Rollout Hardening, CI Gates, and Post-Impl Sync

- **Status**: DONE
- **Goal**: Put the contract gate on the real build path, close the final rollout-time runtime gaps, and sync every SDLC artifact to the shipped implementation.
- **Implementation**:
  - added the root `abl:contract:test` / `abl:contract:check` gate so docs freshness, compiler contract coverage, BankNexus smoke validation, Phase 6 doc-alignment checks, and project-io guardrail round-trip regressions run as one reusable contract check
  - wired the main build entry points (`build`, `build:changed`, `build:low-mem`, `build:packages`, `build:studio-low-mem`) through that contract gate while keeping raw helper variants for the low-memory split build path
  - fixed FLOW step-entry `SET` handling so initial step-entry mutations now route through the same remember/writeback helper path as later runtime mutations
  - fixed granted-memory projection so readwrite `execution_tree` grants keep writable metadata even when the source path starts unset
  - fixed child-thread return merge so readwrite `execution_tree` grants propagate both writes and explicit clears back into the parent workflow memory source of truth
  - added direct runtime regressions for step-entry `SET` + `REMEMBER`, empty-start readwrite grants, cross-agent memory/policy prompt projection, and cleared workflow-memory grant return propagation
  - completed the post-implementation sync across the feature spec, test spec, HLD, LLD, testing/features indexes, runtime `agents.md`, and a dedicated post-impl-sync log
- **Verification Snapshot**:
  - `pnpm --filter @agent-platform/runtime build` passes
  - `pnpm --filter @agent-platform/runtime exec vitest run --config vitest.core.config.ts src/__tests__/routing/routing-executor-helpers.test.ts src/__tests__/execution/cross-agent-memory-policy.test.ts src/__tests__/execution/flow-set-remember-regressions.test.ts src/__tests__/memory-scope-runtime.test.ts -t "propagates cleared readwrite execution_tree grants back to the parent workflow state|auth handoff writes execution_tree memory, resumes intent, and the billing child sees granted memory plus policy|step-entry SET batches trigger REMEMBER once|readwrite execution_tree grants preserve writable metadata without an initial value"` passes
  - `pnpm abl:contract:check` passes

### Phase 7 Review Notes

- **Round 1 verdict**: PASS AFTER FIXES
  - Found one medium runtime-memory issue under the session-state and orchestration rubric: child-agent clears of readwrite `execution_tree` grants were not being propagated back to the parent workflow memory on thread return.
  - Found one medium reachability issue under the activation/build rubric: the new contract gate existed as a root script, but the main build entry points still bypassed it.
  - Fixed by teaching `mergeReturnedExecutionTreeGrantWrites()` to propagate explicit clears, locking that with a `tryThreadReturn` regression, and routing the main build entry points through `abl:contract:check`.
- **Round 2 verdict**: PASS AFTER FIXES
  - Found one medium SDLC-traceability issue under the docs/examples and review-artifact rubric: the feature/test/HLD/LLD docs had been synced, but the feature’s own implementation log and post-implementation sync log were still stale/missing.
  - Fixed by updating this implementation log with the completed Phase 7 record and creating a dedicated `post-impl-sync.log.md` that captures the final artifact/status/coverage sync.

### Post-Phase Follow-Up: Auto History Authoring Parity & Teaching-Surface Cleanup

- **Status**: DONE
- **Goal**: Close the last drift between the shipped `history: auto` coordination contract and the remaining authoring, language-service, handbook, and training surfaces so new content stops teaching stale defaults or legacy memory syntax.
- **Implementation**:
  - tightened the public ABL JSON schema so authored handoff history only accepts `auto`, `none`, `summary_only`, `full`, and DSL `last_<n>` shorthand instead of arbitrary strings
  - extended the language-service completion surface with canonical `history` values, `memory_grants`, `return_handlers`, and supervisor-aware top-level suggestions
  - updated the language-service YAML serializer to emit canonical `memory_grants`, structured `ON_RETURN`, and top-level `return_handlers` blocks instead of drifting back to legacy handoff syntax
  - refreshed active handbook/testing/academy/knowledge examples plus the Studio agent-anatomy page so they teach `history: auto` as the default, reserve `summary_only` for explicit strict usage, and prefer `memory_grants` over legacy `grant_memory`
  - updated runtime/package learning logs and renamed one stale runtime regression title so the repo no longer claims the old default-history behavior
- **Verification Snapshot**:
  - `pnpm build` passes
  - `pnpm --filter @abl/core test -- src/__tests__/abl-schema.test.ts` passes
  - `pnpm --filter @abl/language-service test -- src/__tests__/serialize-yaml.test.ts src/__tests__/completions.test.ts` passes
  - `pnpm --filter @agent-platform/runtime exec vitest run --config vitest.core.config.ts src/__tests__/routing/routing-executor-unit.test.ts src/__tests__/routing/routing-executor-helpers.test.ts src/__tests__/sessions/session-threading-context.test.ts src/__tests__/conversation-history-integrity.test.ts` passes
  - `pnpm --filter @agent-platform/studio exec vitest run src/__tests__/dsl-updater.test.ts` passes
  - `pnpm --filter @agent-platform/arch-ai build` passes

### Follow-Up Review Notes

- **Round 1 verdict**: PASS AFTER FIXES
  - Found one medium authoring-surface issue under the contracts and docs/examples rubric: the public JSON schema and language-service serializer still allowed or emitted looser/legacy handoff syntax than the runtime contract now teaches, which would have let Studio/editor tooling drift back to non-canonical history and memory syntax.
  - Fixed by tightening the authored-YAML schema, extending completions, and teaching the serializer to emit canonical `memory_grants`, structured `ON_RETURN`, and `return_handlers`.
- **Round 2 verdict**: PASS AFTER FIXES
  - Found one medium teaching-surface issue under the docs/examples and reachability rubric: active academy/knowledge/anatomy content still used legacy `grant_memory` or described `summary_only` as the default, even though the runtime and primary docs now default to `auto`.
  - Fixed by updating the remaining live teaching content, rerunning the impacted build/test ring, and confirming that only intentional compatibility surfaces still mention the legacy forms.

### LLD Phase 8: Curated Long-Form Governance for Knowledge & Training Surfaces

- **Status**: DONE
- **Goal**: Bring the remaining authored training/knowledge/demo surfaces under the same canonical ABL governance model without forcing full generation everywhere.
- **Implementation**:
  - added `packages/arch-ai/src/knowledge/contract-facts.ts` so Arch-AI coordination and memory cards embed compiler-owned contract facts directly instead of re-copying the syntax by hand
  - updated the Arch-AI `multi-supervisor`, `cross-agent-validation`, and `memory-full` cards to teach canonical `RETURN_HANDLERS`, `memory_grants`, `history: auto`, `execution_tree`, and `session:start` semantics
  - refreshed the affected academy modules so they stop teaching `grant_memory`, pseudo-human handoff, `ON_RETURN_MAP`, and the old “four strategies” history explanation that omitted `auto`
  - refreshed the static Studio anatomy/demo HTML so its coordination examples and editor mockups show `RETURN_HANDLERS`, `history: auto`, and the machine `HANDOFF` / human `ESCALATE` split
  - added a compiler-owned long-form contract validator that reads the shipped Arch-AI, academy, and static anatomy files, enforces canonical-term and forbidden-term rules, validates handler references, and parses representative ABL snippets
  - extended the root contract gate so `@agent-platform/arch-ai` build/tests participate in `abl:contract:check`
- **Verification Snapshot**:
  - `pnpm --filter @abl/compiler build` passes
  - `pnpm --filter @agent-platform/arch-ai build` passes
  - `pnpm --filter @abl/compiler test -- src/__tests__/docs/phase8-long-form-contract-governance.test.ts` passes
  - `pnpm --filter @agent-platform/arch-ai test -- src/__tests__/abl-contract-backed-knowledge.test.ts src/__tests__/golden-corpus/knowledge-coverage.test.ts` passes
  - `pnpm abl:contract:check` passes

### Phase 8 Review Notes

- **Round 1 verdict**: PASS AFTER FIXES
  - Found one medium long-form contract issue under the docs/examples and compatibility rubric: Arch-AI still described `ON_RETURN_MAP`, academy still taught `grant_memory` / pseudo-human `HANDOFF`, and the static anatomy demo still defaulted to `summary_only` in key coordination surfaces.
  - Fixed by converting those surfaces to canonical `RETURN_HANDLERS`, `memory_grants`, `history: auto`, and `ESCALATE` semantics before the new validator was enabled.
- **Round 2 verdict**: PASS AFTER FIXES
  - Found one medium CI-governance issue under the activation/build rubric: the long-form validator and Arch-AI contract-backed knowledge assertions existed locally but were not yet part of the reusable root contract gate.
  - Fixed by extending `abl:contract:test` / `abl:contract:check` so the compiler-owned validator and targeted Arch-AI build/test ring now run in the same contract lane as the reference docs and project-io round-trip proofs.

### Phase 8 Audit Follow-Up Notes

- **Audit round 1 verdict**: PASS AFTER FIXES
  - Found one medium canonical-syntax issue under the docs/examples and contract-surface rubric: some academy long-form prose still taught top-level handoff `MAP:` and the obsolete authored history spellings `last_n: 10` / `last_N`, even though the executable contract is structured `ON_RETURN.map` plus DSL `last_<n>`.
  - Fixed by converting the affected academy examples/prose to structured `ON_RETURN` with `map`, canonical `last_<n>` teaching, and extending the long-form validator to forbid the stale authored spellings on the governed surfaces.
- **Audit round 2 verdict**: PASS AFTER FIXES
  - Found one medium validator-gap issue under the activation/build rubric: the new long-form contract test only resolved inline `ON_RETURN` strings, so a bad multi-line `ON_RETURN.handler` block could still drift through CI unnoticed.
  - Fixed by teaching the validator to inspect both inline and structured `ON_RETURN` forms, validate built-in `action` values, and assert that named handlers referenced inside nested blocks are declared in `RETURN_HANDLERS`.

### Phase 9A: Public E2E Promotion Coverage

- **Status**: DONE
- **Goal**: Close the remaining BETA blocker by proving the hardened ABL coordination/memory/policy contract through the public runtime API instead of only unit/integration coverage.
- **Implementation**:
  - added a focused public runtime E2E suite in `apps/runtime/src/__tests__/e2e/abl-contract-hardening-phase9.e2e.test.ts`
  - covered named `RETURN_HANDLERS` plus `resume_intent` through a public chat-session round trip that validates child completion, parent resumption, and session isolation from an outsider tenant
  - covered `execution_tree` projection, `memory_grants`, project guardrail policy activation, pre-turn policy shaping, and `guardrail_tool_blocked` behavior through a public handoff-plus-next-turn scenario
  - normalized the authored ABL fixtures in the new E2Es to the canonical nested `FLOW` step form so the promotion suite proves the contract we want authors and Studio to copy
- **Verification Snapshot**:
  - `pnpm --filter @agent-platform/runtime build` passes
  - `pnpm --filter @agent-platform/runtime exec vitest run --config vitest.e2e.config.ts src/__tests__/e2e/abl-contract-hardening-phase9.e2e.test.ts` passes

### Phase 9A Review Notes

- **Round 1 verdict**: PASS AFTER FIXES
  - Found one medium contract-authoring issue under the docs/examples and future-safety rubric: the new public E2E suite mixed canonical nested `FLOW` steps with the older root-level step form, which would have kept the promotion coverage on a looser parser path than the contract we teach elsewhere.
  - Fixed by converting the remaining fixtures in the public E2E suite to the canonical nested `FLOW` step form before the phase was closed.
- **Round 2 verdict**: PASS AFTER FIXES
  - Found one medium behavioral issue under the orchestration and reachability rubric: a non-returning public handoff to the billing child agent correctly activated the child thread, but the original E2E assumed the child would also execute its reasoning turn immediately on the bootstrap handoff.
  - Fixed by modeling the real public API path explicitly: first prove the thread handoff, then send the next user turn through the same session so the child executes with granted memory and project policy in place.

### Phase 9B: Pre-Turn Shaping Performance Guard

- **Status**: DONE
- **Goal**: Add a dedicated bounded-latency guard for dynamic pre-turn prompt/tool shaping so the contract stays safe under CI and visible in runtime traces.
- **Implementation**:
  - added high-resolution latency measurement to the `pre_turn_surface` decision trace in `apps/runtime/src/services/execution/pre-turn-execution-view.ts`
  - added `apps/runtime/src/__tests__/execution/pre-turn-shaping-performance.test.ts`, which exercises the real hot path `preparePreTurnExecutionView() + buildSystemPrompt() + buildTools()` against a representative session with execution-tree memory, granted memory, blocked tools, JIT-allowed tools, gather state, and project policy
  - locked the steady-state hot-path budget with explicit average and p95 thresholds so regressions fail fast in CI instead of hiding behind whole-turn runtime noise
  - refreshed the feature/test/post-sync docs so the SDLC artifacts no longer claim the performance guard is missing
- **Verification Snapshot**:
  - `pnpm --filter @agent-platform/runtime build` passes
  - `pnpm --filter @agent-platform/runtime exec vitest run --config vitest.core.config.ts src/__tests__/execution/pre-turn-shaping-performance.test.ts src/__tests__/execution/cross-agent-memory-policy.test.ts src/__tests__/routing/prompt-builder.test.ts` passes

### Phase 9B Review Notes

- **Round 1 verdict**: PASS AFTER FIXES
  - Found one medium observability issue under the runtime-trace rubric: the new performance guard could fail in CI, but the runtime still had no direct latency signal on the `pre_turn_surface` trace to explain shaping cost in production sessions.
  - Fixed by adding `latencyMs` to the emitted `pre_turn_surface` decision trace and asserting that the signal is present in the new hot-path guard test.
- **Round 2 verdict**: PASS AFTER FIXES
  - Found one medium SDLC-staleness issue under the docs/testing rubric: the implementation had landed, but the feature spec, test spec, and post-implementation sync log still described the pre-turn shaping performance guard as missing.
  - Fixed by updating those SDLC artifacts in the same slice so the remaining-gap list only names the still-open compatibility-retirement work.

### Phase 9C: Compatibility-Retirement Closure

- **Status**: DONE
- **Goal**: Retire the temporary authored compatibility lanes for inline `ON_RETURN`, legacy `grant_memory`, and legacy recall aliases, while preserving only the narrow runtime-edge shims needed for already-persisted IR payloads.
- **Implementation**:
  - retired inline/string `ON_RETURN` authoring in both legacy `.abl` parsing and YAML parsing, requiring structured `action` / `handler` blocks plus nested `map`
  - retired authored `grant_memory` and `on_return_map`, converting those paths into parser/compiler diagnostics instead of silently lowering them
  - retired legacy recall-event aliases such as `session_start`, `agent_enter`, and `delegate_complete` from authored DSL/YAML, replacing auto-normalization with guided diagnostics toward canonical lifecycle events
  - tightened compiler contract metadata, generated docs facts, governed examples, and BankNexus/academy/orchestration samples so public surfaces no longer teach the retired shorthands
  - kept only a narrow runtime compatibility shim for pre-retirement persisted IR payloads that may still contain string `on_return` or `grant_memory`
  - fixed the authoring surface follow-ups uncovered during audit: history completions now include canonical `last_<n>`, and governed docs/tests now consistently use `last_<n>` instead of `last_N`
- **Verification Snapshot**:
  - `pnpm --filter @abl/core build` passes
  - `pnpm --filter @abl/core test -- src/__tests__/parser-handoff-enhanced.test.ts src/__tests__/parser-memory-enhanced.test.ts src/__tests__/yaml-parser.test.ts src/__tests__/abl-schema.test.ts` passes
  - `pnpm --filter @abl/compiler build` passes
  - `pnpm --filter @abl/compiler test -- src/__tests__/compiler-recall-validation.test.ts src/__tests__/validate-coordination-config.test.ts src/__tests__/handoff-return-handlers-compilation.test.ts src/__tests__/memory-enhanced.test.ts src/__tests__/contracts/abl-contract-registry.test.ts src/__tests__/remote-agent-coordination.test.ts src/__tests__/handoff-expect-return.test.ts src/__tests__/session-memory-validation.test.ts src/__tests__/validate-integration.test.ts src/__tests__/docs/phase6-doc-alignment.test.ts src/__tests__/docs/phase8-long-form-contract-governance.test.ts src/__tests__/ir/abl-spec-examples-validation.test.ts` passes
  - `pnpm --filter @abl/language-service build` passes
  - `pnpm --filter @abl/language-service test -- src/__tests__/serialize-yaml.test.ts src/__tests__/completions.test.ts` passes
  - `pnpm --filter @agent-platform/runtime build` passes
  - `pnpm --filter @agent-platform/runtime exec vitest run --config vitest.core.config.ts src/__tests__/execution/handoff-resume-intent.test.ts src/__tests__/execution/flow-child-resume-intent.test.ts src/__tests__/execution/cross-agent-memory-policy.test.ts src/__tests__/execution/handoff-return-propagation-regression.test.ts src/__tests__/execution/runtime-executor.test.ts src/__tests__/memory-executor.test.ts src/__tests__/traveldesk.e2e.test.ts` passes
  - `pnpm abl:docs:generate` passes
  - `pnpm abl:docs:check` passes
  - `pnpm --filter @agent-platform/docs-internal build` passes
  - `pnpm --filter @agent-platform/studio build` passes
  - `git diff --check` passes

### Phase 9C Review Notes

- **Round 1 verdict**: PASS AFTER FIXES
  - Found one medium authoring-surface issue under the language-service and docs/examples rubric: canonical handoff history still supported `last_<n>`, but completions no longer advertised it, which would push users toward an incomplete set of legal values.
  - Fixed by adding `last_<n>` completions with a direct regression test and correcting the remaining stale internal history comment.
- **Round 2 verdict**: PASS AFTER FIXES
  - Found one medium contract-governance issue under the docs/build rubric: several public guide/reference surfaces still taught `last_N`, even though the canonical authored syntax is `last_<n>` / `last_10`.
  - Fixed by updating the source docs and parity expectations, then regenerating the mirrored reference surfaces and rerunning the build/doc-governance ring.

## Final Acceptance Update

- All planned contract-hardening, promotion, and compatibility-retirement slices are now implemented and verified.
- No required blocking gaps remain for the approved Bruce/ABL program.
- Remaining follow-up is optional v2 ergonomics only: any future ABL-facing guardrail authoring projection that still lowers into the canonical project asset model.

### Phase 10A: Typed Handoff History Authoring

- **Status**: DONE
- **Goal**: Promote bounded handoff history from the legacy `last_<n>` shorthand into a first-class typed authoring surface while keeping the shorthand as a compatibility input.
- **Implementation**:
  - extended the core AST, legacy parser, YAML parser, and YAML schema so handoff history accepts canonical typed authoring blocks with `mode: last_n` plus `count`
  - kept scalar authored modes (`auto`, `none`, `summary_only`, `full`) intact while preserving legacy `last_<n>` string input for the compatibility window
  - updated compiler lowering so both the typed block and the legacy shorthand normalize into the same IR/runtime `{ last_n: n }` form
  - updated the language-service serializer and completions so generated YAML emits the typed block for bounded history and editors can complete `mode` / `count` inside `history:`
  - updated the Studio handoff authoring helpers so canvas-created handoffs can emit the typed `last_n` form instead of hard-coding `last_5`
  - regenerated the contract-facts artifacts so generated surfaces now teach the typed form as canonical and demote `last_<n>` to compatibility guidance
- **Verification Snapshot**:
  - `pnpm --filter @abl/core build` passes
  - `pnpm --filter @abl/core test -- src/__tests__/abl-schema.test.ts src/__tests__/yaml-parser.test.ts src/__tests__/parser-handoff-enhanced.test.ts` passes
  - `pnpm --filter @abl/compiler build` passes
  - `pnpm --filter @abl/compiler test -- src/__tests__/contracts/abl-contract-registry.test.ts` passes
  - `pnpm --filter @abl/language-service build` passes
  - `pnpm --filter @abl/language-service test -- src/__tests__/serialize-yaml.test.ts src/__tests__/completions.test.ts` passes
  - `pnpm --filter @agent-platform/studio exec vitest run src/__tests__/dsl-updater.test.ts` passes
  - `pnpm abl:docs:generate` passes
  - `pnpm abl:docs:check` passes

### Phase 10A Review Notes

- **Round 1 verdict**: PASS AFTER FIXES
  - Found one medium parser-contract issue under the authoring-surface rubric: typed handoff history blocks accepted arbitrary `mode` strings and would only fail later through schema/compiler behavior, which risks silent runtime drift for raw parser consumers.
  - Fixed by validating typed `mode` values directly in both the YAML parser and the legacy parser, with explicit diagnostics for unsupported values.
- **Round 2 verdict**: PASS WITH FOLLOW-UP
  - Found one medium docs/teaching drift under the contract-governance rubric: several public long-form surfaces still teach `history: last_<n>` or concrete `last_10` examples even though the generated contract facts now present the typed block as canonical.
  - Deferred to the final close-out sync because the governed long-form and reference pages will be updated together with the remaining project-guardrail projection phase.

### Phase 10B: Project Guardrail YAML Projection

- **Status**: DONE
- **Goal**: Add an ABL/YAML-facing project guardrail archive projection without creating a second schema, so the same canonical guardrail asset model can round-trip through JSON or YAML bundles.
- **Implementation**:
  - added `packages/project-io/src/guardrail-projection.ts` as the single helper for guardrail archive path detection, name extraction, JSON/YAML parsing, and deterministic YAML serialization
  - extended `ExportOptionsV2` / `LayerQueryContext` with `guardrailFormat?: 'json' | 'yaml'`, keeping JSON as the default while letting v2 exports request YAML guardrail bundles explicitly
  - updated `GuardrailsAssembler` to emit `.guardrail.yaml` bundles when requested while still exporting the exact same canonical policy object, including the portable `scope.agentName` remap anchor
  - updated guardrail import/schema/folder/SHA surfaces so `.guardrail.yaml` is first-class across disassembly, schema selection, folder categorization, and lockfile path resolution
  - added direct regression coverage for the new projection helper, YAML export, YAML import, schema detection, folder classification, SHA fallback lookup, and exporter context propagation
- **Verification Snapshot**:
  - `pnpm install` passes
  - `pnpm --filter @agent-platform/project-io build` passes
  - `pnpm --filter @agent-platform/project-io test -- src/__tests__/guardrail-projection.test.ts src/__tests__/guardrails-assembler.test.ts src/__tests__/layer-disassemblers.test.ts src/__tests__/entity-schemas.test.ts src/__tests__/folder-reader-v2.test.ts src/__tests__/import-validator-v2.test.ts src/__tests__/project-exporter.test.ts src/__tests__/integration/export-v2-integration.test.ts` passes
  - `pnpm --filter @agent-platform/project-io test` passes

### Phase 10B Review Notes

- **Round 1 verdict**: PASS
  - Re-swept all live `project-io` source files for hard-coded `.guardrail.json` assumptions after implementation. Remaining JSON-only references were limited to default-mode tests and intentional compatibility assertions; all importer/exporter/runtime code paths now route through the shared projection helper.
- **Round 2 verdict**: PASS
  - Re-ran the full `@agent-platform/project-io` test suite after the targeted proof set to catch any missed layered-export/import or lockfile regressions. The full package sweep stayed green, so the YAML projection is wired through the real package surface instead of only the focused tests.

## Updated Remaining Work

- Final authored spec/reference/training sync for typed handoff history and guardrail YAML projection
- Final repo-wide build-before-test closure and SDLC status cleanup

### Phase 10C: Authored Surface + SDLC Closure

- **Status**: DONE
- **Goal**: Close the remaining authored-surface, reference-mirror, and SDLC drift for typed bounded handoff history plus JSON/YAML guardrail bundle projections so the approved ABL hardening program is fully closed out.
- **Implementation**:
  - updated the canonical spec, quick reference, and mirrored guide/reference/example surfaces so new authored examples use typed bounded history (`mode: last_n` + `count`) instead of concrete `last_10` / `last_20` shorthand examples
  - refreshed academy modules, Arch-AI coordination knowledge, and static Studio anatomy so governed training surfaces describe `auto`/`summary_only` correctly and stop teaching legacy bounded-history snippets
  - updated the feature spec, test spec, and HLD so project guardrails are described as one canonical guardrail asset model with deterministic JSON (default) and YAML bundle projections, rather than JSON-only persistence plus future projection work
  - regenerated the compiler-owned reference mirrors and tightened the Phase 6/Phase 8 doc-governance expectations to match the shipped authored syntax and mirrored content
  - completed the final build-before-test closure and appended the final post-implementation sync record for this feature
- **Verification Snapshot**:
  - `pnpm abl:docs:generate` passes
  - `pnpm abl:docs:check` passes
  - `pnpm build` passes
  - `pnpm --filter @abl/compiler test -- src/__tests__/docs/phase6-doc-alignment.test.ts src/__tests__/docs/phase8-long-form-contract-governance.test.ts src/__tests__/ir/abl-spec-examples-validation.test.ts` passes
  - `git diff --check` passes

### Phase 10C Review Notes

- **Round 1 verdict**: PASS AFTER FIXES
  - Found one medium doc-governance issue under the docs/build rubric: the Phase 6 alignment test still asserted the rendered overview string instead of the raw markdown source, so it failed on the escaped `summary\\*only` cell even though the actual mirrored docs were correct.
  - Fixed by tightening the expectation to the checked-in markdown source string and rerunning the full root build gate.
- **Round 2 verdict**: PASS
  - Re-swept the governed long-form surfaces for stale coordination terms (`grant_memory`, `ON_RETURN_MAP`, `Human_Agent`, concrete `history: last_<n>` examples, and incorrect `summary_only` semantics) and reran `git diff --check`.
  - The governed surfaces stayed clean, and the focused compiler docs/example-validation ring passed on the final tree.

## Final Acceptance Update

- All approved implementation, promotion, compatibility-retirement, typed-history, and guardrail-projection slices are now implemented and verified.
- No required blocking gaps remain for the approved Bruce/ABL contract-hardening program.
- Any future fully authored ABL guardrail DSL would be a separate product-expansion track, not unfinished work in this closed program.
