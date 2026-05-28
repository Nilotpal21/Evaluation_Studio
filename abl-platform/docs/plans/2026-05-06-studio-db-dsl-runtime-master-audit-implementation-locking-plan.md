# Master Implementation And Test Locking Plan: Studio -> DB -> DSL -> Runtime Propagation

**Date**: 2026-05-06
**Status**: COMPLETE
**Source Audits**:

- `docs/audit/2026-05-05-multidimensional-runtime-contract-coverage-matrix.md`
- `docs/audit/2026-05-05-project-tool-contract-coverage-matrix.md`
- `docs/audit/2026-05-05-studio-db-dsl-runtime-expanded-contract-matrix.md`
- `docs/audit/2026-05-05-studio-db-dsl-runtime-multidimensional-coverage-audit.md`
- `docs/audit/2026-05-06-studio-db-dsl-runtime-master-propagation-audit.md`
- `docs/audit/2026-05-06-studio-db-dsl-runtime-propagation-master-tracker.md`

## 1. Planning Baseline

This plan is the execution map for the full open implementation list from the audit set. The 2026-05-05 matrices include several cells already marked fixed or covered in the current local tree; those are treated as preservation locks, not work to re-implement. The 2026-05-06 master audit and tracker are the current implementation baseline for open defects and under-proven seams.

The master tracker also contains a second, broader **Platform Propagation Extension Matrix** guarded by `packages/shared-kernel/src/__tests__/platform-propagation-audit-lint.test.ts`. That matrix is part of this plan: it covers adjacent propagation families such as tools/forms, attachments/media, streaming, localization, auth/model/tool binding, memory, import/export internals, Studio proxies, production wiring, and workers.

The target contract is:

1. Authored assistant output is structured-first. `response` text may be empty; `richContent`, `voiceConfig`, `actions`, localization, metadata, and content envelopes are still user-visible output.
2. Runtime delivery and assistant history are separate forms of the same logical output. Delivery may be redacted; history must preserve protected/tokenized structured payloads where policy requires it.
3. Every shortcut, fallback, guardrail, trace, channel, readback, and Studio visual mutation path must either use the canonical helper or have an explicit capability boundary with a regression lock.
4. Every slice starts by adding deterministic tests for the exact audit cells it closes. A slice is not done if it only fixes the happy path.

## Implementation Progress

| Slice                                                                       | Status | Evidence                                                                                                                                                                                                                           |
| --------------------------------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Slice 0: Baseline Inventory And Gate Stabilization                          | DONE   | Shared golden fixture corpus and compatibility manifest added in `@agent-platform/shared-kernel`; fixture, propagation audit, and platform propagation lint tests pass; shared-kernel build passes.                                |
| Slice 1: Flow Output Guardrail Structured Payload Policy                    | DONE   | Runtime flow guardrail handling now clears pre-guardrail `richContent`, `voiceConfig`, and `actions` whenever guardrails replace or modify authored text; focused flow output PII/guardrail test locks pass.                       |
| Slice 2: Non-Flow Input Guardrail Output Protection                         | DONE   | Standard runtime input guardrail block messages now use `protectSessionOutputForUser` before streaming, assistant history, and final response; focused runtime executor guardrail protection lock passes.                          |
| Slice 3: Voice Trace Scrubbing With Project PII Registry                    | DONE   | KoreVG voice STT/TTS/turn/tool trace writes now route through a central scrubbed helper that applies built-in scrubbers plus the live session PII registry; KoreVG helper tests and semgrep gate completed.                        |
| Slice 4: Branch Action Interpolation Parity                                 | DONE   | Runtime now interpolates action sets for normal flow responses, `ON_INPUT`, navigation shortcuts, `ON_RESULT`, `ON_SUCCESS`, and `ON_FAILURE`; focused action interpolation and PII locks pass.                                    |
| Slice 5: Raw Flow CHECK Failure Sanitization                                | DONE   | Failed `CHECK` without `ON_FAIL` now emits a stable sanitized user message through protected assistant output while retaining condition diagnostics in trace events; focused runtime locks pass.                                   |
| Slice 6: Studio Lifecycle Visual Mutation Safety                            | DONE   | Studio lifecycle partial edits now have mutation locks proving hidden structured/retry/store siblings are preserved, while removal is intentional and compatibility gates still block unsupported dirty saves.                     |
| Slice 7: Canonical Direct Chat Constructors                                 | DONE   | WebSocket, SDK WebSocket, typed-interrupt, on-start, and HTTP chat call sites now use the canonical persisted assistant structured-content helper.                                                                                 |
| Slice 8: Readback, Trace Replay, And Observatory Surfaces                   | DONE   | Session detail merge prefers richer equivalent messages; trace-only replay hydrates structured `agent_response` payloads; observatory summaries prefer rendered DSL text.                                                          |
| Slice 9: Channel Outcome And AI4W Capability Decision                       | DONE   | Channel outcome and AI4W capability boundaries are locked with behavior-contract tests and AI4W rich-output flattening assertions.                                                                                                 |
| Slice 10: Init-Time And Nested Branch Persistence Proof                     | DONE   | Init-time and nested branch structured envelopes are protected, remembered, persisted, and covered by focused runtime locks.                                                                                                       |
| Slice 11: Fallback, Error Handler, And Terminal Return Inventory            | DONE   | Default error-handler, fallback branch, and terminal child-return paths now preserve protected structured envelopes, including structured-only child returns to parent history.                                                    |
| Slice 12: Runtime Channel Dispatcher Type/Build Contract Revalidation       | DONE   | Runtime channel dispatcher persistence accepts structured-only payloads and compiles against the canonical persistence helper.                                                                                                     |
| Slice 13: Channel Adapter Structured Payload Parity                         | DONE   | Channel rich-content capability families have deterministic locks; adapter-specific rendering remains tracked as narrower platform/channel follow-up work.                                                                         |
| Slice 14: End-To-End Runtime Result To Read API And Studio Rehydration      | DONE   | SDK HTTP chat now has a public-boundary E2E lock proving `response`, `richContent`, `voiceConfig`, `actions`, and persisted `contentEnvelope` survive session readback.                                                            |
| Slice 15: PII Registry And Policy Context Across Structured Return/Readback | DONE   | Structured child-return paths already use protected delivery/history envelopes; PII read-surface locks now prove custom project PII is redacted in raw and tokenized `contentEnvelope` readback.                                   |
| Slice 16: Project Tool Numeric Placeholder UI Parity                        | DONE   | HTTP/Sandbox Studio forms and adapters now display, validate, edit, and preserve exact `{{config.KEY}}` runtime numeric placeholders; focused adapter/component locks cover placeholder-to-number and number-to-placeholder edits. |
| Slice 17: Project Tool-Test And Module Deployment Unknown Closure           | DONE   | SOAP, MCP header config resolution, workflow version/param mapping, SearchAI concrete bindings, and unresolved module placeholders now have focused tool-test/runtime/module deployment locks.                                     |
| Slice 18: Platform Tools And Forms Propagation                              | DONE   | Platform tools/forms rows are now enforced as `PASS` by the platform lint; dynamic form DSL schema, MCP runtime IR binding, tool-result metadata compression, and confirmation/tool-call E2E locks cover the row family.           |
| Slice 19: Platform Attachments And Media Propagation                        | DONE   | Attachment/media rows are now enforced as `PASS`; runtime attachment tools withhold storage internals, channel/email/A2A trace paths preserve safe metadata, and Studio runtime proxy requires project access before forwarding.   |
| Slice 20: Platform Streaming And Realtime Propagation                       | DONE   | Streaming/realtime rows are now enforced as `PASS`; chunk-to-final envelope commit, SDK typed interrupt resume, status/filler transience, voice realtime traces, and Arch SSE ordering have deterministic locks.                   |
| Slice 21: Platform Localization Propagation                                 | DONE   | Localization rows are now enforced as `PASS`; Studio locale asset scope/readback, runtime Accept-Language fallback, locale path/config-key round-trips, and channel template localized variables have deterministic locks.         |
| Slice 22: Platform Auth, Secrets, Model, And Policy Propagation             | DONE   | Auth/model/policy rows are now enforced as `PASS`; auth context propagation, serialized secret redaction, runtime tool auth resolver shape, model cache scoping, and tenant policy invalidation have deterministic locks.          |
| Slice 23: Platform Memory, Recall, And Context Propagation                  | DONE   | Memory/context rows are now enforced as `PASS`; scoped memory read/write, tool memory provenance, contact-id recall, contact erasure, and active-window envelope preservation have deterministic locks.                            |
| Slice 24: Platform Import/Export, Proxy, Wiring, And Worker Propagation     | DONE   | Import/export/proxy/wiring rows are now enforced as `PASS`; public barrels, direct import/export parity, Studio proxy scope, runtime route mounting, and queue worker lifecycle wiring have deterministic locks.                   |
| Slice 25: Web SDK, React, Vanilla, And Preview Surface Parity               | DONE   | SDK/preview rows are now enforced as `PASS`; shared golden assistant-output envelopes normalize through core transport, ChatClient, React renderer, vanilla renderer, hosted preview, and preview/share links.                     |

## 2. Source Finding Reconciliation

| Source ID                                                         | Current Plan Disposition                                                                                                                                   | Slice        |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| `SDR-MASTER-001` / `MDRC-001`                                     | Flow output guardrails must not keep original structured payloads after block/redact/escalate/reask.                                                       | 1            |
| `SDR-MASTER-002`                                                  | Non-flow input guardrail block must use output protection before stream/history.                                                                           | 2            |
| `SDR-MASTER-003`                                                  | Voice trace paths must scrub transcripts/tool args with live project PII registry.                                                                         | 3            |
| `SDR-MASTER-004` / `MTR-001`                                      | Branch action payloads must interpolate identically across flow, branches, lifecycle, and action handlers.                                                 | 4            |
| `SDR-MASTER-005`                                                  | Flow `CHECK` failure must not emit raw internal condition text through `onChunk`.                                                                          | 5            |
| `SDR-MASTER-006` / `SDR-MULTI-007` / `SDR-MULTI-008` / `MDRC-005` | Studio lifecycle visual mutation remains partial; preserve hidden fields or block unsupported edits.                                                       | 6            |
| `MTR-002`                                                         | WebSocket, SDK WebSocket, and HTTP chat must stop hand-rolling structured assistant content.                                                               | 7            |
| `MTR-003`                                                         | Studio trace-only replay must reconstruct structured assistant payloads from `message.agent`.                                                              | 8            |
| `MTR-004`                                                         | Session detail live/persisted merge must prefer richer structured content when text matches.                                                               | 8            |
| `MTR-005`                                                         | Observatory summary must read `dsl_respond.rendered` before legacy fields.                                                                                 | 8            |
| `MTR-006`                                                         | Channel outcome trace contract needs a decision and lock for successful structured output.                                                                 | 9            |
| `MTR-007`                                                         | AI4W must either expose structured sideband or document text-only flattening.                                                                              | 9            |
| `MATRIX-001` through `MATRIX-006`                                 | Already marked fixed in the 2026-05-05 expanded matrix update; keep tests in the regression suite and include in acceptance gates.                         | Preservation |
| `SDR-MULTI-013`                                                   | Init-time structured payload delivery/persistence/readback is still under-proven across surfaces.                                                          | 10           |
| `SDR-MULTI-014`                                                   | Nested branch payload persistence/readback after auto-advance is still under-proven.                                                                       | 10           |
| `SDR-MULTI-015` / `MDRC-006`                                      | Helper-owned fallback and terminal-return seams need complete inventory locks.                                                                             | 11           |
| `MDRC-002`                                                        | Runtime channel-dispatcher build/type drift was called out in older audit; verify current branch before closure.                                           | 12           |
| `MDRC-003`                                                        | Default/error handler structured history needs delivered/history/readback parity proof.                                                                    | 11           |
| `MDRC-004` / `UNKNOWN-001` / `SDR-UNKNOWN-004`                    | Channel adapter structured payload parity is not fully locked.                                                                                             | 13           |
| `UNKNOWN-002` / `SDR-UNKNOWN-005`                                 | Readback/rehydration needs E2E proof from runtime result to read API and Studio display.                                                                   | 14           |
| `UNKNOWN-003`                                                     | PII registry/policy context needs proof across structured child return and readback.                                                                       | 15           |
| `UNKNOWN-004`                                                     | Studio visual add/remove/reorder semantics need intentional deletion vs accidental sibling-loss tests.                                                     | 6            |
| `PT-CONTRACT-005`                                                 | HTTP/Sandbox numeric placeholders are no longer number-only in UI authoring/display; exact `{{config.KEY}}` values are visible, editable, and preserved.   | 16           |
| `PT-UNKNOWN-001` through `PT-UNKNOWN-005`                         | Tool-test and module-deployment unknowns are closed with focused SOAP, MCP, Workflow, SearchAI, and module snapshot locks.                                 | 17           |
| Platform matrix: tools/forms rows                                 | Tool calls/results, confirmation prompts, dynamic forms, and MCP/tool binding are closed with definition-to-consumption locks.                             | 18           |
| Platform matrix: attachments/media rows                           | Session, channel, email, A2A, and trace attachment propagation are closed with schema/readback locks.                                                      | 19           |
| Platform matrix: streaming/realtime rows                          | WebSocket chunks, SDK typed interrupts, async callbacks, filler/status, realtime transcripts, and Arch-AI SSE are closed with envelope locks.              | 20           |
| Platform matrix: localization rows                                | Studio localization assets, runtime locale resolution, locale import/export, and channel/template localization are closed with deterministic parity locks. | 21           |
| Platform matrix: auth/model/tool binding rows                     | Auth profiles, secrets redaction, tool auth, model resolution, and tenant policy are closed with cross-surface propagation locks.                          | 22           |
| Platform matrix: memory/context rows                              | Session memory, tool memory bridge, omnichannel recall, contact memory, and context window/readback are closed with persistence/read locks.                | 23           |
| Platform matrix: import/export/proxy/wiring rows                  | Manifest validation, assemblers/disassemblers, direct apply, preview/revert, workers, proxies, route mounting, barrels, and queues are closed.             | 24           |
| Platform matrix: web SDK and preview rows                         | Web SDK core, React package, vanilla embed, Studio preview runtime, and SDK preview share links are closed with shared-fixture parity locks.               | 25           |

## 3. Design Decisions

| #    | Decision                                                                                                               | Rationale                                                                                                        | Alternatives Rejected                                                                  |
| ---- | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| D-1  | Keep the 2026-05-06 master tracker as the issue register of record.                                                    | It supersedes older broad matrices for current open runtime defects.                                             | Splitting fixes across older overlapping audit docs.                                   |
| D-2  | Treat older fixed matrix cells as preservation locks.                                                                  | Re-implementing closed cells risks churn and obscures what is still open.                                        | Re-running the full MATRIX-001..006 implementation plan from scratch.                  |
| D-3  | Prefer canonical helper adoption over one-off field copying.                                                           | The repeated defect class is helper bypass and payload drift.                                                    | Adding `richContent`/`actions` parameters to each caller independently.                |
| D-4  | Capability boundaries must be executable tests, not prose only.                                                        | Text-only or flattening channels are valid only when the contract is locked.                                     | Leaving `P`, `UNKNOWN`, or `Likely` rows in audit tables without tests.                |
| D-5  | Studio visual surfaces either preserve invisible advanced fields or block mutation.                                    | A narrow UI is acceptable; silent loss is not.                                                                   | Making partial editors responsible for every advanced DSL construct immediately.       |
| D-6  | Use public API/E2E tests for cross-boundary behavior, and focused unit tests only for pure helpers.                    | The audit gaps are mostly boundary and wiring failures.                                                          | Mock-heavy tests that bypass auth, route ordering, persistence, or channel adaptation. |
| D-7  | Treat content envelopes, channel capabilities, trace payloads, and tool envelopes as versioned contracts.              | Separately deployed SDKs, persisted messages, and trace replay need backward-compatible readers.                 | Unversioned shape changes that only work for newly created sessions.                   |
| D-8  | Establish a shared golden fixture corpus before broad implementation.                                                  | The same payload examples should drive runtime, Studio, import/export, channel, and readback locks.              | Recreating similar but incompatible fixtures in each package.                          |
| D-9  | Prefer reader compatibility before writer migration.                                                                   | Existing persisted messages, traces, exports, and SDK payloads must keep rendering while writers are modernized. | Backfilling first or assuming old records are irrelevant.                              |
| D-10 | Require per-slice schema-route and dependency-wiring audits when a slice touches API, DB, worker, or proxy boundaries. | The largest future defect class is accepted fields or constructed services that are not forwarded.               | Relying on compile success to prove route/worker reachability.                         |
| D-11 | Add rollout and rollback notes for any slice that changes persisted shape, client payload shape, or channel behavior.  | Several slices affect independently deployed clients and historical data.                                        | Shipping behavior flips with no compatibility lane.                                    |
| D-12 | Add performance budgets for hot-path helpers and readback comparisons.                                                 | Canonicalization can accidentally add deep serialization, unbounded maps, or per-message scrubbing overhead.     | Treating correctness tests as sufficient for runtime paths.                            |

## 4. Future-Ready Design Audit Controls

These controls apply to every slice below. They are the audit findings from the future-readiness pass: the implementation list is broad enough, but the first draft needed stronger contract governance so the work remains maintainable after the current backlog is closed.

### 4.1 Contract Versioning

Any slice that changes a persisted, streamed, exported, or SDK-visible payload must define:

- **Stable contract name**: for example `assistant.contentEnvelope`, `message.agent`, `channel.outcome`, `tool.callEnvelope`, `attachmentEnvelope`, or `localeAsset`.
- **Version field or compatibility discriminator**: readers must tolerate the previous shape and the new shape in the same deployment window.
- **Canonical constructor and parser**: writers should call one constructor; readers should call one parser/normalizer before presentation.
- **Unknown-field policy**: preserve unknown structured fields in durable envelopes and export/import paths unless a slice explicitly strips them with a test.
- **Removal policy**: deprecated fields require a compatibility branch, audit row update, and a follow-up removal trigger.

### 4.2 Golden Fixture Corpus

Slice 0 should establish or identify shared fixtures used by later slices. Each fixture should include text-plus-structured and structured-only variants.

| Fixture family     | Required payloads                                                                                         | Consumers                                                                 |
| ------------------ | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Assistant output   | text, `richContent`, `voiceConfig`, `actions`, localization, completion/retry metadata, `contentEnvelope` | runtime execution, chat routes, SDK/websocket, sessions, Studio replay    |
| Guardrail output   | original payload, blocked/redacted/fixed payload, reask/escalate fallback                                 | flow executor, runtime executor, traces, persistence                      |
| Channel capability | preserve, native transform, flatten, reject/no-op                                                         | channel manifest, adapters, AI4W, channel outcome traces                  |
| Tool contract      | HTTP/Sandbox/MCP/Workflow/SearchAI fields, auth, numeric placeholders, confirmation, result compression   | Studio tool UI/test, project tools, compiler executors, module deployment |
| Attachment/media   | session attachment, channel media, email, A2A, trace reference                                            | runtime attachment tools, Studio attachment proxy, replay/readback        |
| Locale/auth/memory | locale fallback, auth profile redaction, model policy, memory ownership                                   | localization, auth/model policy, memory/context slices                    |

The corpus should avoid package-local clones. Package tests can import or materialize from the same canonical examples, then assert their package-specific boundary behavior.

### 4.3 Dependency DAG

The suggested execution order remains risk-first, but implementation should respect these dependency groups:

| Group                               | Slices                 | Dependency rule                                                                                                                                |
| ----------------------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Foundation                          | 0                      | Must land before all other slices; creates fixture/gate baseline and current failure map.                                                      |
| Policy safety                       | 1, 2, 3, 4, 5          | Can run mostly independently after Slice 0; Slice 15 depends on 3 and the output-protection parts of 1/2.                                      |
| Canonical construction and readback | 7, 8, 10, 11, 12, 14   | Slice 7 should precede 20; Slice 8 should precede 14; Slice 12 should precede 13 where channel dispatcher types are reused.                    |
| Studio/project authoring            | 6, 16, 17, 18          | Can run after Slice 0; Slice 17 should reuse numeric placeholder rules from Slice 16.                                                          |
| Channel and realtime                | 9, 13, 20              | Slice 9 decides AI4W/channel outcome contract before full channel parity; Slice 20 depends on Slice 7 for final envelope construction.         |
| Platform propagation                | 18, 19, 21, 22, 23, 24 | Can split into sub-slices by matrix row; each sub-slice must keep `platform-propagation-audit-lint.test.ts` green.                             |
| Web SDK and preview                 | 25                     | Depends on Slice 7 and Slice 20 for canonical envelope/stream semantics; should run before final proxy/wiring closure if preview paths change. |

If a slice grows beyond one package family plus one boundary test family, split it into a child plan instead of expanding the parent slice.

### 4.4 Per-Slice Definition Of Ready

Before implementation starts for a slice:

1. Read the source for every existing component, function, type, route helper, logger, and exported symbol used by the slice.
2. Enumerate fields from the definition layer and map them across definition, transform, presentation, persistence, consumption, and wiring.
3. Run schema-route alignment for every create/update/import/proxy route touched by the slice.
4. Run dependency-wiring review for every service, worker, queue processor, package barrel, or route registration touched by the slice.
5. Identify legacy records/payloads that the reader must still accept.
6. Choose the exact golden fixture family and add a failing deterministic lock before production edits.

### 4.5 Per-Slice Definition Of Done

A slice is done only when:

1. The red lock test failed before the implementation or the gap was proven with an existing failing test.
2. The production fix uses a canonical constructor/parser/helper or updates the capability contract with a test.
3. The source audit row is updated with fixed status, regression lock path, and any remaining narrower follow-up.
4. Both propagation lints still pass if the slice touches audited tracker rows or source inventories.
5. Focused package build passes after the focused tests.
6. `npx prettier --write <changed-files>` has run.
7. Rollback behavior is documented for persisted shape, stream payload, SDK-visible, or channel behavior changes.

### 4.6 Rollout, Rollback, And Migration

For persisted or client-visible contract changes:

- Prefer **dual-read, single-write** first: readers accept legacy and new shapes, while new writers emit only the canonical shape after tests pass.
- Use **dual-write** only when an old deployed reader still requires the legacy field.
- Add a migration/backfill estimate before writing data migrations. Include record count source, expected runtime, failure behavior, and whether backfill is required for correctness or only for analytics/search.
- Keep rollback simple: a rollback must leave readers able to display both legacy and newly written records.
- Channel behavior flips must be guarded by capability tests and, when needed, by a narrow feature flag or channel capability version.

### 4.7 Performance And Scale Budgets

Hot-path slices must define performance expectations before implementation:

- No unbounded in-memory `Map` or cache; include max size, TTL, and eviction if a cache is needed.
- Avoid repeated deep `JSON.stringify` comparisons on session message lists; prefer normalized envelope hashes or bounded field comparisons.
- Trace scrubbing must be batched or scoped where possible and must not duplicate full payload traversal across TraceStore and EventStore writes.
- Channel manifest conformance tests should be table-driven but runtime dispatch should not scan every channel on each message.
- Import/export and backfill tests should include at least one multi-agent/multi-locale fixture to catch quadratic materialization behavior.

### 4.8 CI And Governance

The final implementation should add these checks to the regular gate surface, or document why they remain focused-only:

- `propagation-audit-lint.test.ts`
- `platform-propagation-audit-lint.test.ts`
- Channel manifest conformance tests
- Canonical fixture parity tests for runtime, Studio, import/export, and direct chat surfaces
- Security scan for slices touching auth, PII, HTTP routes, trace payloads, attachments, or user input

## 5. Slice Plan

### Slice 0: Baseline Inventory And Gate Stabilization

**Goal**: Establish the current state before fixing code so each later slice has a measurable starting point.

**Test locks first**:

- Add or update an audit inventory test that asserts every source audit row listed in this plan maps to a slice or preservation status.
- Run both propagation audit lints and capture current unresolved statuses.
- Run focused existing locks for already-fixed `MATRIX-001` through `MATRIX-006`.
- Add or identify the shared golden fixture corpus described in Section 4.2 and prove at least runtime, Studio, and import/export tests can consume it without package-local cloning.

**Implementation**:

- Add a small docs/audit inventory fixture only if the existing audit lint cannot validate the slice mapping.
- Create a fixture manifest that names each fixture family, owning package, expected consumer packages, and compatibility shape versions.
- Do not change runtime/Studio production behavior in this slice; shared fixture exports are allowed as test/support contract.

**Files likely touched**:

- `packages/shared-kernel/src/propagation-fixtures.ts`
- `packages/shared-kernel/src/__tests__/propagation-fixtures.test.ts`
- `packages/shared-kernel/src/__tests__/propagation-audit-lint.test.ts`
- `packages/shared-kernel/src/__tests__/platform-propagation-audit-lint.test.ts`
- `packages/shared-kernel/package.json`
- `docs/audit/2026-05-06-studio-db-dsl-runtime-propagation-master-tracker.md`

**Exit criteria**:

- Every source finding in this plan is accounted for.
- Baseline test commands are documented in the slice log.
- Golden fixture corpus and compatibility-version manifest are discoverable by later slices.
- No audit table row is removed to make a test pass.

**Verification**:

- `pnpm --filter @agent-platform/shared-kernel exec vitest src/__tests__/propagation-fixtures.test.ts`
- `pnpm --filter @agent-platform/shared-kernel exec vitest src/__tests__/propagation-audit-lint.test.ts`
- `pnpm --filter @agent-platform/shared-kernel exec vitest src/__tests__/platform-propagation-audit-lint.test.ts`

### Slice 1: Flow Output Guardrail Structured Payload Policy

**Goal**: When output guardrails block, redact, fix, filter, escalate, or reask, the original structured payload cannot leak through delivery, history, persistence, or traces.

**Test locks first**:

- Flow `RESPOND` with text plus `richContent`, `voiceConfig`, and `actions`; output guardrail blocks with replacement text; assert original structured payload is absent from result and history.
- Flow `ON_SUCCESS`/`ON_FAILURE` branch with structured payload; guardrail redact/fix changes text; assert structured payload is sanitized, rebuilt, or cleared according to policy.
- Reask/escalate fallback path; assert no pre-guardrail button/card/voice payload survives unless explicitly produced by the fallback.
- Persistence/readback assertion: persisted `contentEnvelope` matches the guarded result, not the original response.

**Implementation**:

- In `apps/runtime/src/services/execution/flow-step-executor.ts`, move guardrail evaluation before remembering pending rendered payloads or construct the pending payload from the guardrail-approved output.
- Add a helper for "guarded authored output" that returns delivery text plus approved structured fields as a single object.
- Ensure PII protection happens after interpolation and after guardrail replacement decisions.

**Files likely touched**:

- `apps/runtime/src/services/execution/flow-step-executor.ts`
- `apps/runtime/src/__tests__/execution/flow-authored-output-pii.test.ts`

**Exit criteria**:

- `SDR-MASTER-001` and `MDRC-001` moved to fixed with regression lock.
- Guardrail block and modified-content tests prove text, structured payload, history, and in-memory pending persistence agree. The implementation applies the same clearing path to block, escalate, reask fallback, and modified-content redact/fix/filter outcomes.

**Verification**:

- `pnpm --filter @agent-platform/runtime exec vitest src/__tests__/execution/flow-authored-output-pii.test.ts`

### Slice 2: Non-Flow Input Guardrail Output Protection

**Goal**: Standard runtime input guardrail block messages use the same output protection/history split as flow and reasoning paths.

**Test locks first**:

- Non-flow input guardrail block with project PII recognizer and policy-authored block message containing PII-like values; assert user delivery is sanitized.
- Assert assistant history stores the protected/tokenized form, not raw block text.
- Assert streamed chunk and final result are consistent.

**Implementation**:

- In `apps/runtime/src/services/runtime-executor.ts`, replace direct `onChunk(blockMessage)` and raw history push with `emitProtectedAssistantText(...)` or the canonical structured output protection helper.
- Preserve existing status/result semantics for blocked turns.

**Files likely touched**:

- `apps/runtime/src/services/runtime-executor.ts`
- `apps/runtime/src/__tests__/execution/guardrails/*`
- `apps/runtime/src/__tests__/execution/flow-authored-output-pii.test.ts` if shared fixtures already exist there.

**Exit criteria**:

- `SDR-MASTER-002` is fixed.
- Runtime input guardrail block has a deterministic protection lock.

**Verification**:

- `pnpm --filter @agent-platform/runtime exec vitest src/__tests__/execution/guardrails`
- `pnpm --filter @agent-platform/runtime exec vitest src/__tests__/execution/runtime-executor.test.ts --testNamePattern "protects non-flow input guardrail block messages"`

### Slice 3: Voice Trace Scrubbing With Project PII Registry

**Goal**: Voice STT, TTS, realtime tool-call, and voice pipeline traces scrub transcript/tool argument data with the live session/project recognizer registry.

**Test locks first**:

- KoreVG STT trace includes transcript containing a project-defined PII token; assert trace data is scrubbed before store.
- Voice tool-call trace includes sensitive argument value; assert scrubbed data is written and raw value is absent.
- Shared voice trace helper test proves all callers go through a single scrubbing seam.

**Implementation**:

- Add or reuse a voice trace helper that accepts `session` or explicit PII context and calls `scrubTraceEvent(...)`.
- Replace direct `getTraceStore().addEvent(...)` calls in KoreVG router/session voice paths with the helper.
- Make missing session PII context fail closed to built-in scrubbers plus logged warning, not raw write.

**Files likely touched**:

- `apps/runtime/src/services/voice/korevg/korevg-router.ts`
- `apps/runtime/src/services/voice/korevg/korevg-session.ts`
- `apps/runtime/src/services/channel-trace-utils.ts` or a new voice trace utility
- `apps/runtime/src/services/voice/korevg/__tests__/*`

**Exit criteria**:

- `SDR-MASTER-003` is fixed.
- Direct voice transcript/tool trace writes are routed through the central scrubbed helper; remaining direct writes are session lifecycle/barge-in events without transcript/tool argument payloads.
- PII registry/policy audit row improves for voice traces.

**Verification**:

- `pnpm --filter @agent-platform/runtime exec vitest src/services/voice/korevg`
- `./tools/run-semgrep.sh`

### Slice 4: Branch Action Interpolation Parity

**Goal**: `ACTIONS` interpolation is identical across normal `FLOW` responses, `ON_INPUT`, navigation shortcuts, `ON_RESULT`, `ON_SUCCESS`, `ON_FAILURE`, lifecycle responses, and action-handler responses.

**Test locks first**:

- Flow step `ACTIONS` with `{{session.customer_id}}` in label/value/payload/url; assert result, `contentEnvelope`, persisted message, and event payload all contain resolved values.
- `ON_INPUT` branch and navigation shortcut emit equivalent action payloads; assert both resolve tokens.
- `ON_RESULT`/success/failure branch action payloads resolve the same way.
- Existing action-handler interpolation test remains unchanged.

**Implementation**:

- Use `interpolateActionSet(...)` in the same normalization block that already interpolates rich content and voice config.
- Ensure branch helper outputs pass interpolated actions to `rememberPendingRenderedPayload(...)`.
- Keep PII protection after interpolation.

**Files likely touched**:

- `apps/runtime/src/services/execution/flow-step-executor.ts`
- `apps/runtime/src/__tests__/execution/flow-authored-output-pii.test.ts`

**Exit criteria**:

- `SDR-MASTER-004` and `MTR-001` are fixed.
- Action interpolation has helper-level parity across all branch lanes.

**Verification**:

- `pnpm --filter @agent-platform/runtime exec vitest src/__tests__/execution/flow-authored-output-pii.test.ts`

**Slice 4 completion evidence (2026-05-06)**:

- `apps/runtime/src/services/execution/flow-step-executor.ts` now runs `interpolateActionSet(...)` for `ON_INPUT` helper payloads, `ON_RESULT` helper payloads, and the final response normalization block used by direct `FLOW`, `ON_SUCCESS`, and `ON_FAILURE` payloads.
- `apps/runtime/src/__tests__/execution/flow-authored-output-pii.test.ts` locks interpolation for direct flow actions, normal `ON_INPUT`, navigation-command `ON_INPUT`, `ON_RESULT`, `ON_SUCCESS`, and `ON_FAILURE`, while preserving existing action-handler interpolation coverage.
- Verification passed: `pnpm --filter @agent-platform/runtime build` and `pnpm --filter @agent-platform/runtime exec vitest src/__tests__/execution/flow-authored-output-pii.test.ts`.

### Slice 5: Raw Flow CHECK Failure Sanitization

**Goal**: A failed `CHECK` without `on_fail` does not stream raw internal condition text or bypass output protection.

**Test locks first**:

- Flow `CHECK` failure with internal condition expression; assert user-facing response is a sanitized stable message and does not include the condition string.
- Assert history entry is protected through the canonical helper.
- Assert trace/logs may retain the diagnostic condition without exposing it to user surfaces.

**Implementation**:

- Replace `Check failed: ${step.check}` delivery text with a sanitized runtime error message.
- Route emitted text through `emitProtectedAssistantText(...)`.
- Keep internal condition details in structured trace/log context only.

**Files likely touched**:

- `apps/runtime/src/services/execution/flow-step-executor.ts`
- `apps/runtime/src/__tests__/execution/flow-authored-output-pii.test.ts` or a dedicated flow check test file

**Exit criteria**:

- `SDR-MASTER-005` is fixed.
- User-visible runtime errors follow sanitization rules.

**Verification**:

- `pnpm --filter @agent-platform/runtime exec vitest src/__tests__/execution`

**Slice 5 completion evidence (2026-05-06)**:

- `apps/runtime/src/services/execution/flow-step-executor.ts` now replaces raw `Check failed: ${step.check}` delivery with a stable sanitized message routed through `emitProtectedAssistantText(...)`.
- `apps/runtime/src/__tests__/execution/flow-authored-output-pii.test.ts` locks that chunks, result text, and assistant history omit the raw condition and contract-like identifier while the `constraint_check` trace retains the diagnostic condition.
- `apps/runtime/src/__tests__/execution/flow-execution-coverage.test.ts` now expects the sanitized check-failure response and verifies the internal condition is not streamed.
- Verification passed: `pnpm --filter @agent-platform/runtime build` and `pnpm --filter @agent-platform/runtime exec vitest src/__tests__/execution/flow-authored-output-pii.test.ts src/__tests__/execution/flow-execution-coverage.test.ts`.

### Slice 6: Studio Lifecycle Visual Mutation Safety

**Goal**: Completion and error-handling visual editors preserve invisible advanced metadata on partial/no-op edits, and block or intentionally delete only when the user performs an unsupported mutation.

**Test locks first**:

- Serializer regression for `ON_ERROR.DEFAULT` and specific handlers with empty `respond` plus `richContent`, `voiceConfig`, `actions`, retry metadata, and `store` siblings.
- Completion condition with structured-only payload and `store`; assert emitted DSL preserves it or compat gate blocks save.
- UI/store partial edit preserves hidden fields byte-for-byte.
- Add/remove/reorder tests distinguish intentional deletion from accidental sibling loss.
- No-op save round-trip keeps lifecycle sections semantically identical.

**Implementation**:

- Update `serializeLifecycleToABL(...)` and `serializeLifecycleDiffToABL(...)` to emit structured payload blocks when structured fields exist even if `respond` is empty, or mark the exact section unsupported in compatibility analysis.
- Keep existing editor components narrow; do not add broad UI controls unless preservation/blocking cannot satisfy the contract.
- Update compatibility messages for unsupported ordered advanced mutation paths.

**Files likely touched**:

- `apps/studio/src/lib/abl-serializers.ts`
- `apps/studio/src/lib/abl/lifecycle-visual-editor-compat.ts`
- `apps/studio/src/components/agent-editor/sections/CompletionEditor.tsx`
- `apps/studio/src/components/agent-editor/sections/ErrorHandlingEditor.tsx`
- `apps/studio/src/store/agent-detail-store.ts`
- `apps/studio/src/__tests__/abl-serializers.test.ts`

**Exit criteria**:

- `SDR-MASTER-006`, `SDR-MULTI-007`, `SDR-MULTI-008`, `MDRC-005`, and `UNKNOWN-004` have deterministic locks or explicit blocked-safe statuses.
- Visual save cannot silently drop structured lifecycle siblings.

**Verification**:

- `pnpm --filter @agent-platform/studio exec vitest src/__tests__/abl-serializers.test.ts`
- `pnpm --filter @agent-platform/studio build`

**Slice 6 completion evidence (2026-05-06)**:

- `apps/studio/src/__tests__/components/lifecycle-visual-editors.test.tsx` locks visible-field edits in completion and error-handling editors so hidden `voiceConfig`, `richContent`, `actions`, retry metadata, and `store` siblings are preserved; remove actions intentionally delete only the selected item.
- `apps/studio/src/__tests__/abl-serializers.test.ts` locks lifecycle diff serialization so partial visual edits still emit structured-only completion/error payloads and advanced metadata.
- `apps/studio/src/__tests__/lifecycle-visual-editor-compat.test.ts` keeps unsupported lifecycle dirty saves blocked by surface.
- Verification passed: `pnpm --filter @agent-platform/studio exec vitest src/__tests__/abl-serializers.test.ts src/__tests__/lifecycle-visual-editor-compat.test.ts src/__tests__/components/lifecycle-visual-editors.test.tsx` and `pnpm --filter @agent-platform/studio build`.
- Build note: Studio build passed with existing Turbopack warnings for `apps/studio/src/app/api/abl/docs/route.ts` dynamic file tracing.

### Slice 7: Canonical Direct Chat Constructors

Status: Done in `[ABLP-856] fix(runtime): canonicalize direct chat structured content`.

**Goal**: WebSocket, SDK WebSocket, typed interrupt, on-start, and HTTP chat paths build durable structured assistant content through the canonical helper.

**Test locks first**:

- WebSocket normal response parity: direct path output equals `buildPersistedMessageStructuredContent(...)` for text, rich, voice, actions, localization, completion metadata, retry metadata, and envelope fields.
- SDK normal response, typed interrupt, and on-start parity with the same fixture.
- HTTP chat parity with the same fixture.
- Future-field guard: adding a field to canonical helper should break direct-path tests until wired.

**Implementation**:

- Create a thin adapter around `buildPersistedMessageStructuredContent(...)` if direct chat surfaces need route-specific input shape.
- Replace manual `assistantStructuredContent` object construction in runtime WebSocket, SDK WebSocket, and chat route.
- Keep presentation payloads separate from persistence envelope construction.

**Files likely touched**:

- `apps/runtime/src/websocket/handler.ts`
- `apps/runtime/src/websocket/sdk-handler.ts`
- `apps/runtime/src/routes/chat.ts`
- `apps/runtime/src/services/session/persisted-message-content.ts`
- `apps/runtime/src/__tests__/websocket/*`
- `apps/runtime/src/__tests__/routes/chat*`

**Exit criteria**:

- `MTR-002` is fixed.
- Bypass scan classification moves these direct chat paths out of `Partial/bypass`.

**Verification**:

- `pnpm --filter @agent-platform/runtime build`
- `pnpm --filter @agent-platform/runtime exec vitest src/services/session/__tests__/persisted-message-content.test.ts src/__tests__/channels/websocket-handler.test.ts src/__tests__/sessions/chat-routes.test.ts`
- `pnpm --filter @agent-platform/shared-kernel build`
- `pnpm --filter @agent-platform/shared-kernel exec vitest src/__tests__/propagation-audit-lint.test.ts src/__tests__/platform-propagation-audit-lint.test.ts`

### Slice 8: Readback, Trace Replay, And Observatory Surfaces

Status: Done in `[ABLP-856] fix(runtime): preserve structured readback surfaces`.

**Goal**: Session detail, Studio trace replay, and observatory summaries prefer canonical structured payloads and the correct rendered fields.

**Test locks first**:

- Session detail merge with identical assistant text, persisted text-only message, and active message with richer `contentEnvelope`; assert richer active message wins.
- Trace-only `message.agent` event containing `contentEnvelope`, `rawContent`, `richContent`, `voiceConfig`, and `actions`; assert synthesized Studio assistant message preserves all structured fields.
- `dsl_respond` event with `data.rendered`; assert summary displays rendered value before legacy `message`/`text`.

**Implementation**:

- Update `sessionDetailMessagesAreEquivalent(...)` or merge policy to compare structured envelope/metadata and prefer richer content on text equivalence.
- Teach Studio replay to consume `message.agent` payloads before falling back to `llm_call.response` or text-only `dsl_respond` synthesis.
- Read `data.rendered` first in observatory presentation.

**Files likely touched**:

- `apps/runtime/src/routes/sessions.ts`
- `apps/studio/src/utils/replay-trace-events.ts`
- `apps/studio/src/utils/observatory-event-presentation.ts`
- `apps/runtime/src/__tests__/routes/sessions*`
- `apps/studio/src/utils/__tests__/*`

**Exit criteria**:

- `MTR-003`, `MTR-004`, and `MTR-005` are fixed.
- Read surfaces no longer regress to text-only when canonical structured payload exists.

**Verification**:

- `pnpm --filter @agent-platform/runtime build`
- `pnpm --filter @agent-platform/runtime exec vitest src/routes/__tests__/session-message-merge.test.ts`
- `pnpm --filter @agent-platform/studio build`
- `pnpm --filter @agent-platform/studio exec vitest src/__tests__/replay-trace-events.test.ts src/__tests__/observatory-event-presentation.test.ts`
- `pnpm --filter @agent-platform/shared-kernel build`
- `pnpm --filter @agent-platform/shared-kernel exec vitest src/__tests__/propagation-audit-lint.test.ts src/__tests__/platform-propagation-audit-lint.test.ts`

### Slice 9: Channel Outcome And AI4W Capability Decision

Status: Done in `[ABLP-856] test(runtime): lock channel boundary contracts`.

**Goal**: Convert likely channel trace and AI4W findings into fixed behavior or explicit tested capability boundaries.

**Test locks first**:

- Channel outcome successful structured result test: either trace contains enough structured payload for replay, or test asserts durable messages are the source of truth and successful outcome trace omits payload by design.
- AI4W structured payload test: either sideband structured payload is present, or flattening is deterministic and channel manifest declares text-only/action-flatten behavior.
- Capability matrix test ensures AI4W cannot drift silently between text-only and structured modes.

**Implementation**:

- If traces are rehydratable, extend `buildOutcomeTraceEvent(...)` to include successful structured payloads.
- If durable messages are source of truth, document and test that successful outcome traces carry diagnostics/provenance only.
- For AI4W, either add structured sideband response support or make text-only flattening explicit in channel behavior contract and route tests.

**Files likely touched**:

- `apps/runtime/src/services/channel/outcome.ts`
- `apps/runtime/src/routes/ai4w-channel.ts`
- `apps/runtime/src/channels/channel-behavior-contract.ts`
- `apps/runtime/src/channels/manifest.ts`
- `apps/runtime/src/__tests__/channels/*`

**Exit criteria**:

- `MTR-006` and `MTR-007` are fixed or reclassified as documented non-issues with regression locks.

**Verification**:

- `pnpm --filter @agent-platform/runtime build`
- `pnpm --filter @agent-platform/runtime exec vitest src/services/channel/__tests__/outcome.test.ts src/__tests__/channels/channel-behavior-contract.test.ts src/__tests__/channels/ai4w-capability-contract.test.ts`
- `pnpm --filter @agent-platform/shared-kernel build`
- `pnpm --filter @agent-platform/shared-kernel exec vitest src/__tests__/propagation-audit-lint.test.ts src/__tests__/platform-propagation-audit-lint.test.ts`

### Slice 10: Init-Time And Nested Branch Persistence/Readback Proof

**Status**: Done in `[ABLP-856] fix(runtime): persist init branch envelopes`.

**Goal**: Prove structured `ON_START`, hook/init-time payloads, nested branches, auto-advance, and navigation shortcut lanes survive delivery, persistence, and readback.

**Test locks first**:

- `ON_START` with structured-only and text-plus-structured payload; assert runtime result, history, persisted envelope, and session read API.
- Hook/init-time payload through same-pod and async/pending readback path where available.
- Nested `ON_INPUT` branch after auto-advance with rich/actions/voice; assert persisted and readback content envelope.
- Navigation command/gather shortcut with nested structured branch; assert no text-gated loss.

**Implementation**:

- Patch any discovered remaining text gates in init/nested branch/pending paths.
- Reuse canonical structured-only history helper from existing fixed matrix work.

**Files likely touched**:

- `apps/runtime/src/services/execution/flow-step-executor.ts`
- `apps/runtime/src/services/execution/session-output-protection.ts`
- `apps/runtime/src/routes/sessions.ts`
- `apps/runtime/src/__tests__/execution/flow-authored-output-pii.test.ts`

**Exit criteria**:

- `SDR-MULTI-013` and `SDR-MULTI-014` move from `NOT_COVERED` to `PASS` or a narrower explicit remaining row.

**Verification**:

- `pnpm --filter @agent-platform/runtime build`
- `pnpm --filter @agent-platform/runtime exec vitest src/__tests__/execution/flow-authored-output-pii.test.ts`

### Slice 11: Fallback, Error Handler, And Terminal Return Inventory

**Status**: Done in `[ABLP-856] fix(runtime): lock fallback structured envelopes` plus the Slice 11 structured-only child-return closure.

**Goal**: Close helper-owned fallback/default/error/terminal-return seams that historically rediscover structured-output bugs.

**Test locks first**:

- Tool error `default_handler` with `richContent`, `voiceConfig`, and `actions`; assert delivery, history, DB envelope, and Studio/session readback match.
- ELSE/fallback branch with structured payload and no text; assert structured output survives or blocked contract is explicit.
- Constraint violation/fail-open/fail-closed path with structured fallback; assert no raw/old payload leaks.
- Terminal child-thread return via complete-transition string caller; assert parent history and readback preserve content envelope.
- Action handler `respond -> delegate/handoff -> return` with actions and metadata; assert forwarded result, trace events, and persistence.

**Implementation**:

- Ensure fallback/error handler result paths pass full `ExecutionResult` objects, not strings or partial sentinel fields.
- Replace any remaining one-off pending payload memory writes with the canonical authored output helper.
- Keep `tryThreadReturn(session, string)` compatibility, but migrate known structured callers.

**Files likely touched**:

- `apps/runtime/src/services/execution/flow-step-executor.ts`
- `apps/runtime/src/services/execution/types.ts`
- `apps/runtime/src/services/execution/routing-executor.ts`
- `apps/runtime/src/__tests__/execution/*`

**Exit criteria**:

- `SDR-MULTI-015` and `MDRC-003` close for default error-handler, fallback branch, and terminal child-return seams. Broader platform hook/lifecycle tails remain tracked under Slice 18+ platform rows where they cross tool/form/channel surfaces.
- Structured-only child-thread returns append a protected parent-history content envelope instead of disappearing because the text response is empty.
- No terminal-return caller known to have structured result passes only `response`.

**Verification**:

- `pnpm --filter @agent-platform/runtime build`
- `pnpm --filter @agent-platform/runtime exec vitest src/__tests__/execution/flow-authored-output-pii.test.ts`

### Slice 12: Runtime Channel Dispatcher Type/Build Contract Revalidation

**Status**: Done in `[ABLP-856] test(runtime): lock channel dispatcher persistence`.

**Goal**: Confirm the older async channel dispatcher type drift is actually fixed on the current branch and add a lock if not.

**Test locks first**:

- Compile-time fixture for `DispatchableResult.richContent` accepted by persistence helper.
- Async channel dispatcher test with rich/actions/voice payload; assert persistence helper receives canonical structured content.
- Cross-pod/pending delivery test if not already covered by preservation locks.

**Implementation**:

- Align `DispatchableResult` and persistence helper types around the canonical structured content contract.
- Remove any adapter-local type coercions that hide schema drift.

**Files likely touched**:

- `apps/runtime/src/services/execution/channel-dispatcher.ts`
- `apps/runtime/src/channels/pipeline/message-pipeline.ts`
- `apps/runtime/src/services/session/persisted-message-content.ts`
- `apps/runtime/src/__tests__/execution/channel-dispatcher*`

**Exit criteria**:

- `MDRC-002` is confirmed fixed or fixed in this slice. Confirmed fixed by runtime build and locked with structured-only persistence coverage.
- Runtime package build is clean for this area.

**Verification**:

- `pnpm --filter @agent-platform/runtime build`
- `pnpm --filter @agent-platform/runtime exec vitest src/__tests__/execution/channel-dispatcher.test.ts`

### Slice 13: Channel Adapter Structured Payload Parity

**Status**: Done for channel capability-family parity in `[ABLP-856] test(runtime): lock channel rich capability families`.

**Goal**: Every manifest channel has a capability-aware proof for `richContent`, `voiceConfig`, and `actions`.

**Test locks first**:

- Table-driven channel manifest conformance test that requires each channel to declare one of: native structured support, deterministic transform, intentional flatten, or intentional reject.
- Representative adapter black-box tests for Slack, Teams, WhatsApp, Messenger, Telegram, email, AG-UI, SDK/web debug/web chat, A2A, and voice families.
- Text-only channels (`twilio_sms`, `zendesk`, similar) assert no-op/flatten behavior explicitly.
- Voice channels assert transcript plus `voiceConfig` behavior and trace/readback expectations.

**Implementation**:

- Add missing capability declarations in `manifest.ts` or channel behavior contract.
- Fix adapters only where tests show drift from declared capability.
- Avoid normalizing all channels to a single payload shape when native channel contracts differ.

**Files likely touched**:

- `apps/runtime/src/channels/manifest.ts`
- `apps/runtime/src/channels/channel-behavior-contract.ts`
- `apps/runtime/src/channels/adapters/*`
- `apps/runtime/src/services/execution/channel-dispatcher.ts`
- `apps/runtime/src/__tests__/channels/*`

**Exit criteria**:

- `MDRC-004`, `UNKNOWN-001`, and `SDR-UNKNOWN-004` have deterministic channel-family locks. Slice 13 first locks channel rich-content capability families; adapter-specific payload rendering remains a narrower follow-up.
- Channel Surface Coverage Matrix has no unexplained missing lock for manifest channels.

**Verification**:

- `pnpm --filter @agent-platform/runtime exec vitest src/__tests__/channels`

### Slice 14: End-To-End Runtime Result To Read API And Studio Rehydration

**Goal**: Prove runtime structured output is stable from execution result through DB, session read API, resume/replay, and Studio interactions display.

**Test locks first**:

- Public API E2E creates/runs an agent with text plus structured payload and structured-only payload; assert `GET /api/sessions/:id` returns the same content envelope.
- Resume/replay test compares original runtime result to rehydrated assistant message.
- Studio interactions utility test consumes the read API fixture and preserves `richContent`, `voiceConfig`, `actions`, and redaction state.

**Implementation**:

- Fix any route/serializer/display drops discovered by E2E.
- Keep route queries scoped by tenant/project; cross-scope access returns non-leaky 404.

**Files likely touched**:

- `apps/runtime/src/routes/sessions.ts`
- `apps/studio/src/utils/replay-trace-events.ts`
- `apps/studio/src/lib/*interactions*`
- `apps/runtime/src/__tests__/e2e/*`
- `apps/studio/src/utils/__tests__/*`

**Exit criteria**:

- `UNKNOWN-002` and `SDR-UNKNOWN-005` are closed for the SDK HTTP chat -> runtime result -> session read API representative lane, with Studio trace/read replay evidence carried by Slice 8.
- E2E test uses HTTP/public API only, no DB imports or module mocks.

**Verification**:

- `pnpm --filter @agent-platform/runtime build`
- `pnpm --filter @agent-platform/runtime exec vitest run --config vitest.e2e.config.ts --maxWorkers=1 --no-file-parallelism --testTimeout=90000 --hookTimeout=180000 src/__tests__/channels/channels-sdk-runtime.e2e.test.ts -t "preserves structured SDK chat output through persisted session readback"`

- `pnpm --filter @agent-platform/runtime test:e2e`
- `pnpm --filter @agent-platform/studio exec vitest src/utils`

### Slice 15: PII Registry And Policy Context Across Structured Return/Readback

**Goal**: Project-scoped PII policy and recognizers apply consistently to structured payloads across child return, handoff/delegate, persistence, traces, and readback.

**Test locks first**:

- Child thread returns card/action/voice payload containing project-defined PII; assert user delivery redacts and parent history tokenizes.
- Read API reveal/non-reveal scopes return appropriate redacted or protected forms.
- Trace replay and Studio display do not expose raw project PII unless caller scope allows it.
- Contact/session-derived identity test confirms policy context follows session source, not the workspace user who created a debug session.

**Implementation**:

- Route child return and handoff/delegate structured payloads through `protectExecutionResultForUser(...)`.
- Ensure session PII context refresh is available before trace/persistence/readback decisions.
- Patch any read surface that formats raw `contentEnvelope` without caller-scope sanitization.

**Files likely touched**:

- `apps/runtime/src/services/execution/session-output-protection.ts`
- `apps/runtime/src/services/pii/session-pii-context.ts`
- `apps/runtime/src/services/execution/types.ts`
- `apps/runtime/src/routes/sessions.ts`
- `apps/runtime/src/__tests__/execution/*`

**Exit criteria**:

- `UNKNOWN-003` closes for structured child return and readback.
- PII module row improves from partial for these lanes; broader direct trace and voice handoff PII follow-ups remain tracked separately.

**Verification**:

- `pnpm --filter @agent-platform/runtime build`
- `pnpm --filter @agent-platform/runtime exec vitest src/__tests__/pii/runtime-pii-boundary-service.test.ts src/__tests__/pii/session-pii-context.test.ts src/__tests__/execution/flow-authored-output-pii.test.ts`
- `./tools/run-semgrep.sh`

### Slice 16: Project Tool Numeric Placeholder UI Parity

**Status**: DONE.

**Goal**: HTTP and Sandbox runtime numeric placeholders are visible, intentionally editable, and preserved in Studio UI read/edit flows.

**Test locks first**:

- Existing HTTP tool with `timeout`, `retry`, `retry_delay`, `rate_limit`, and circuit breaker numeric fields backed by `{{config.KEY}}`; UI displays placeholder-aware state.
- Existing Sandbox tool with `timeout` and `memory_mb` placeholders; UI displays and preserves placeholders.
- Unrelated edit keeps placeholder values exactly.
- Intentional user edit from placeholder to numeric and numeric to placeholder validates correctly.

**Implementation**:

- Update tool form adapters to model runtime numeric values as `number | exact config template` instead of number-only for UI state.
- Add validation copy/state for exact config numeric templates.
- Preserve existing runtime validation and executor coercion contracts.

**Files likely touched**:

- `apps/studio/src/components/tools/*`
- `apps/studio/src/components/tools/form-adapters.ts`
- `packages/shared/src/validation/project-tool-schemas.ts`
- `packages/shared/src/tools/serialize-tool-form-to-dsl.ts`
- `packages/shared/src/tools/parse-dsl-to-tool-form.ts`
- `apps/studio/src/__tests__/components/*tool*`

**Exit criteria**:

- `PT-CONTRACT-005` moved from `FAIL`/open to `PASS`.
- HTTP/Sandbox UI no longer hides placeholder-backed numeric config.

**Verification**:

- `pnpm --filter @agent-platform/studio exec vitest src/__tests__/components`
- `pnpm --filter @agent-platform/studio build`

### Slice 17: Project Tool-Test And Module Deployment Unknown Closure

**Status**: DONE.

**Goal**: Close project tool unknown cells for SOAP, MCP, Workflow, SearchAI, and module deployment snapshots.

**Test locks first**:

- SOAP Studio tool-test via project API preserves `protocol`, `soap_version`, `soap_action`, body formatting, auth, and runtime numeric config.
- MCP tool-test resolves headers with `{{config.KEY}}` or explicitly documents why project config is not resolved in test mode.
- Workflow tool-test asserts version pin, trigger ID, timeout, and param mapping are represented in the execution request.
- SearchAI tool-test rejects placeholder `index_id` and passes concrete `index_id` to the search client.
- Module deployment snapshot tests for each tool type with config placeholders; unresolved placeholders fail closed with diagnostics.

**Implementation**:

- Fix Studio tool-test service divergence from runtime executor setup.
- Add module deployment diagnostics for any field group that silently rewrites or drops unresolved placeholders.
- Keep validation aligned with live project tool validation.

**Files likely touched**:

- `apps/studio/src/services/tool-test-service.ts`
- `apps/studio/src/app/api/projects/[id]/tools/*`
- `apps/runtime/src/services/modules/deployment-build-service.ts`
- `apps/runtime/src/services/tool-runtime-config-resolution.ts`
- `packages/compiler/src/platform/constructs/executors/*`
- `apps/studio/src/__tests__/tool-test-service.test.ts`
- `apps/runtime/src/services/modules/__tests__/deployment-build-service.test.ts`

**Exit criteria**:

- `PT-UNKNOWN-001` through `PT-UNKNOWN-005` were converted to `PASS` with deterministic proof in `docs/audit/2026-05-05-project-tool-contract-coverage-matrix.md`.
- Module deployment no longer remains the blind spot for SOAP, MCP, Workflow, SearchAI, and Sandbox unresolved config placeholders.

**Verification**:

- `pnpm --filter @agent-platform/studio exec vitest src/__tests__/tool-test-service.test.ts`
- `pnpm --filter @agent-platform/runtime exec vitest src/routes/__tests__/internal-tools-project-scope.test.ts`
- `pnpm --filter @agent-platform/runtime exec vitest src/services/modules/__tests__/deployment-build-service.test.ts`

### Slice 18: Platform Tools And Forms Propagation

**Status**: DONE.

**Goal**: Close the platform matrix rows for tool calls, tool results, confirmation prompts, dynamic tool forms, and MCP/tool binding from schema definition through runtime consumption and readback.

**Test locks first**:

- Tool-call envelope test proves arguments, auth binding metadata, variable namespaces, confirmation state, and result compression metadata survive trace, history, and readback.
- Tool-result compression/readback test asserts compressed and expanded forms round-trip without losing structured result metadata.
- Tool confirmation prompt test asserts prompt text, action payload, user decision, and resumed execution state stay linked.
- Dynamic tool form test asserts form schema generated from DSL/project-tool config reaches Studio presentation and runtime validation unchanged.
- MCP/tool binding test asserts server/tool identity, headers, config placeholders, and auth binding metadata use the same resolution contract in Studio test and runtime dispatch.

**Implementation**:

- Route tool-call/result/confirmation payloads through typed envelopes rather than ad hoc trace or message metadata.
- Add contract fixtures that cover `packages/shared/src/tools/*`, runtime tool loading, compiler executor dispatch, and Studio tool form presentation.
- Fix any divergence between Studio tool-test setup and runtime executor setup found by the tests.

**Files likely touched**:

- `apps/runtime/src/services/execution/tool-confirmation.ts`
- `apps/runtime/src/services/execution/tool-result-compressor.ts`
- `apps/runtime/src/tools/load-project-tools-as-ir.ts`
- `packages/shared/src/tools/serialize-tool-form-to-dsl.ts`
- `packages/shared/src/tools/parse-dsl-to-tool-form.ts`
- `packages/shared/src/tools/project-tool-persistence.ts`
- `packages/shared/src/types/project-tool-form.ts`
- `apps/studio/src/services/tool-test-service.ts`

**Exit criteria**:

- Platform matrix rows for Tool calls, Tool results, Tool confirmation prompts, Dynamic tool forms, and MCP/tool binding have deterministic regression locks and are enforced as all-`PASS` rows by `platform-propagation-audit-lint.test.ts`.
- `platform-propagation-audit-lint.test.ts` source inventory remains complete.

**Verification**:

- `pnpm --filter @agent-platform/shared-kernel exec vitest src/__tests__/platform-propagation-audit-lint.test.ts`
- `pnpm --filter @agent-platform/shared exec vitest run src/tools/__tests__/project-tool-form-dsl-parity.test.ts`
- `pnpm --filter @agent-platform/runtime exec vitest src/__tests__/load-project-tools-as-ir.test.ts src/__tests__/tools-deployment/tool-result-compressor.test.ts`
- `pnpm --filter @agent-platform/studio exec vitest src/__tests__/tool-test-service.test.ts`

### Slice 19: Platform Attachments And Media Propagation

**Status**: DONE.

**Goal**: Close attachment/media propagation rows across session attachments, channel media processors, email attachments, A2A attachments, and attachment traces.

**Test locks first**:

- Session attachment API-only test uploads, reads, and reuses an attachment; assert tenant/project/session scope and metadata are preserved.
- Channel media downloader/processor test asserts media ID, MIME type, storage key, redaction status, and trace references survive processing.
- Email attachment test asserts inbound/outbound attachment metadata survives adapter transform and readback.
- A2A attachment ingestion test asserts content references and provenance survive agent-to-agent handoff.
- Attachment trace replay test asserts Studio read/replay can resolve attachment references without exposing unauthorized storage keys.

**Implementation**:

- Normalize attachment metadata into one envelope shared by runtime tool executor, channel adapter traces, A2A ingestor, and Studio attachment proxy.
- Ensure Studio route handlers scope every query by `tenantId` and project/session ownership.
- Add trace scrub/reveal behavior for attachment metadata where PII policy applies.

**Files likely touched**:

- `apps/runtime/src/tools/attachment-tool-executor.ts`
- `apps/runtime/src/tools/attachment-param-validator.ts`
- `apps/runtime/src/services/a2a/attachment-ingestor.ts`
- `apps/runtime/src/channels/adapters/attachment-trace-utils.ts`
- `apps/studio/src/app/api/runtime/sessions/[id]/attachments/route.ts`

**Exit criteria**:

- Platform attachment/media rows have test locks, explicit safe readback behavior, and all-`PASS` enforcement in `platform-propagation-audit-lint.test.ts`.
- Unauthorized cross-tenant/project attachment reads return non-leaky 404 before Studio proxies to runtime.

**Verification**:

- `pnpm --filter @agent-platform/runtime exec vitest src/tools/__tests__/attachment-tool-executor.test.ts src/__tests__/services/a2a-attachment-ingestor.test.ts src/__tests__/channels/adapters/email-attachment-processor.test.ts src/__tests__/channels/adapters/attachment-trace-utils.test.ts`
- `pnpm --filter @agent-platform/studio exec vitest src/__tests__/runtime-session-attachments-proxy.test.ts src/__tests__/replay-trace-events.test.ts`
- `pnpm --filter @agent-platform/shared-kernel exec vitest run src/__tests__/platform-propagation-audit-lint.test.ts`

### Slice 20: Platform Streaming And Realtime Propagation

**Status**: DONE.

**Goal**: Lock envelope parity for WebSocket chunks, SDK typed interrupts, async callback streaming, filler/status messages, voice realtime transcript deltas, and Studio SSE/Arch-AI streams.

**Test locks first**:

- WebSocket chunk-to-final test asserts chunk metadata, final content envelope, actions, localization, and voice config stay consistent.
- SDK typed interrupt test asserts interrupt payload and resumed assistant payload preserve structured content.
- Async callback streaming test asserts pending delivery and final callback use the same envelope.
- Filler/status message test asserts filler payloads are marked non-assistant or assistant-visible consistently and do not pollute durable history unexpectedly.
- Voice realtime transcript delta test asserts deltas, final transcript, trace event, and readback are scrubbed and ordered.
- Studio SSE/Arch-AI stream test asserts stream observer keeps event IDs, partial payloads, final payload, and errors aligned.

**Implementation**:

- Reuse the canonical content envelope constructor in stream finalization paths.
- Add typed stream event contracts where chunks currently carry route-specific shape.
- Keep status/filler events out of assistant history unless explicitly user-visible.

**Files likely touched**:

- `apps/runtime/src/websocket/handler.ts`
- `apps/runtime/src/websocket/sdk-handler.ts`
- `apps/runtime/src/websocket/twilio-media-handler.ts`
- `apps/runtime/src/services/filler/pipeline-filler.ts`
- `apps/runtime/src/services/voice/livekit/agent-worker.ts`
- `apps/studio/src/lib/arch-ai/sse-stream.ts`
- `apps/studio/src/lib/arch-ai/stream-observer.ts`

**Exit criteria**:

- Streaming/realtime platform rows have deterministic chunk/final/readback locks and all-`PASS` enforcement in `platform-propagation-audit-lint.test.ts`.
- Direct stream paths are classified in the master tracker with deterministic lock references.

**Verification**:

- `pnpm --filter @agent-platform/studio exec vitest src/__tests__/stores/session-store-endstreaming.test.ts src/__tests__/arch-ai/stream-observer.test.ts`
- `pnpm --filter @agent-platform/web-sdk exec vitest run src/__tests__/chat-client-status.test.ts`
- `pnpm --filter @agent-platform/runtime exec vitest src/__tests__/pipeline-filler.test.ts src/__tests__/channels/voice-realtime-trace.test.ts src/__tests__/channels/websocket-events.test.ts`
- `pnpm --filter @agent-platform/shared-kernel exec vitest run src/__tests__/platform-propagation-audit-lint.test.ts`

### Slice 21: Platform Localization Propagation

**Status**: DONE.

**Goal**: Lock localization propagation from Studio assets through runtime locale resolution, import/export locale files, and channel/template localization.

**Test locks first**:

- Studio localization asset save/read test asserts locale key, fallback chain, namespace, and project scope survive route and DB layers.
- Runtime locale resolution test asserts session/channel locale, fallback, and template variables resolve deterministically.
- Import/export locale files round-trip test asserts all locale assets materialize and direct-apply without key loss.
- Channel/template localization test asserts channel adapter receives localized template output and records locale metadata in envelope/trace.

**Implementation**:

- Align locale file import/export with runtime resolver key format.
- Add locale metadata to structured output envelopes where channel/template rendering depends on it.
- Ensure Studio localization routes use explicit tenant/project scoping.

**Files likely touched**:

- `packages/project-io/src/locale-files.ts`
- `packages/i18n/src/resolve-locale.ts`
- `apps/studio/src/api/localization.ts`
- `apps/runtime/src/services/channel/outcome.ts`
- `packages/language-service/src/serialize-yaml.ts`

**Exit criteria**:

- Localization platform rows have round-trip and runtime locks enforced by `platform-propagation-audit-lint.test.ts`.
- Channel/template localization no longer remains a generic `P` row without evidence.

**Verification**:

- `pnpm --filter @agent-platform/studio exec vitest src/__tests__/api-routes/localization-routes.test.ts`
- `pnpm --filter @agent-platform/i18n exec vitest run src/__tests__/resolve-locale.test.ts`
- `pnpm --filter @agent-platform/project-io exec vitest run src/__tests__/locale-files.test.ts src/__tests__/project-exporter.test.ts src/__tests__/core-direct-apply.test.ts`
- `pnpm --filter @agent-platform/runtime exec vitest src/__tests__/template-engine.test.ts src/__tests__/escalation-channel-templates.test.ts`
- `pnpm --filter @agent-platform/shared-kernel exec vitest run src/__tests__/platform-propagation-audit-lint.test.ts src/__tests__/propagation-audit-lint.test.ts`

### Slice 22: Platform Auth, Secrets, Model, And Policy Propagation

**Status**: DONE.

**Goal**: Lock auth-profile, secret redaction, tool auth binding, model resolution, and tenant model policy propagation across Studio/API/runtime/readback.

**Test locks first**:

- Auth profile propagation test asserts profile refs, connection IDs, consent metadata, and redacted display values survive save/read/runtime dispatch.
- Secret redaction readback test asserts credentials are never surfaced raw in Studio, traces, diagnostics, or exported artifacts.
- Tool auth resolver parity test asserts runtime and Studio test use the same auth resolution result for project tools.
- Model resolution diagnostic/readback test asserts user-visible diagnostics are sanitized while logs/traces keep safe internal context.
- Tenant model policy propagation test asserts tenant/project/user scope affects full model resolution but not reasoning-settings-only caches.

**Implementation**:

- Route auth profile display through shared redaction helpers.
- Keep tool auth resolution centralized in runtime middleware/service and reused by test execution where possible.
- Add diagnostic sanitization at downstream presenter surfaces, not only throw sites.
- Preserve model resolution cache contract around `userId` only for full credential-bearing resolution.

**Files likely touched**:

- `packages/shared/src/services/auth-profile/apply-auth.ts`
- `packages/shared/src/services/auth-profile/redact.ts`
- `apps/runtime/src/services/auth-profile/resolve-tool-auth.ts`
- `apps/runtime/src/services/auth-profile/auth-profile-tool-middleware.ts`
- `apps/runtime/src/services/llm/model-resolution.ts`
- `apps/runtime/src/routes/tenant-llm-policy.ts`

**Exit criteria**:

- Auth/model/tool binding platform rows have deterministic locks enforced by `platform-propagation-audit-lint.test.ts`.
- User-facing runtime/model errors remain sanitized.

**Verification**:

- `pnpm --filter @agent-platform/shared exec vitest run src/__tests__/auth-profile/secret-redaction.test.ts`
- `pnpm --filter @agent-platform/runtime exec vitest src/__tests__/auth/auth-profile-propagation.test.ts src/__tests__/auth/auth-profile-tool-executor-integration.test.ts src/__tests__/model-resolution-versioning.test.ts src/routes/__tests__/tenant-llm-policy.test.ts`
- `pnpm --filter @agent-platform/runtime exec vitest run --config vitest.integration.config.ts --maxWorkers=1 src/routes/__tests__/platform-admin-models.test.ts`
- `pnpm --filter @agent-platform/studio exec vitest src/__tests__/tool-test-service.test.ts src/__tests__/workspace-auth-profile-list-route.test.ts`
- `pnpm --filter @agent-platform/shared-kernel exec vitest run src/__tests__/platform-propagation-audit-lint.test.ts src/__tests__/propagation-audit-lint.test.ts`
- `./tools/run-semgrep.sh`

### Slice 23: Platform Memory, Recall, And Context Propagation

**Status**: DONE. Memory/context platform rows are now locked as `PASS` with scoped memory read/write coverage, tool-derived memory provenance, contact-id recall, contact erasure, and active-window structured envelope preservation.

**Goal**: Lock session memory, tool memory bridge, omnichannel recall, contact memory, and context window/readback propagation.

**Test locks first**:

- Session memory write/read test asserts memory metadata, owner identity, tenant/project scope, and erasure status survive runtime and read API.
- Tool memory bridge test asserts tool-derived memory uses the same session/user/contact ownership context as the source execution.
- Omnichannel recall test asserts channel/customer/contact identity is used, not workspace user ownership.
- Contact memory erasure test asserts deleted/redacted memory does not reappear in recall or readback.
- Context window/readback test asserts compressed/pruned context still preserves content envelope references needed for replay.

**Implementation**:

- Normalize memory ownership dispatch on `Session.source`.
- Ensure recall and memory routes enforce tenant/project/user/contact isolation and return non-leaky 404 where appropriate.
- Add context-window metadata needed to reconstruct structured readback without storing raw over-retained content.

**Files likely touched**:

- `apps/runtime/src/services/execution/memory-integration.ts`
- `apps/runtime/src/services/execution/tool-memory-bridge.ts`
- `apps/runtime/src/services/execution/memory-executor.ts`
- `apps/runtime/src/services/omnichannel/recall-service.ts`
- `apps/runtime/src/routes/memory-api.ts`

**Exit criteria**:

- Memory/context platform rows have ownership-aware locks.
- Contact-derived sessions do not leak memory across users or channel identities.
- `platform-propagation-audit-lint.test.ts` prevents the Slice 23 rows from regressing from `PASS`.

**Verification**:

- `pnpm --filter @agent-platform/runtime build`
- `pnpm --filter @agent-platform/shared-kernel build`
- `pnpm --filter @agent-platform/runtime exec vitest src/__tests__/memory-scope-integration.test.ts src/__tests__/tools-deployment/tool-memory-bridge.test.ts src/__tests__/memory-omnichannel-recall.test.ts src/__tests__/compaction-engine.test.ts src/__tests__/routes/memory-api.openapi-contract.test.ts`
- `pnpm --filter @agent-platform/runtime exec vitest src/__tests__/cascade-delete-contact-memory-erasure.test.ts`
- `pnpm --filter @agent-platform/shared-kernel exec vitest run src/__tests__/platform-propagation-audit-lint.test.ts src/__tests__/propagation-audit-lint.test.ts`

### Slice 24: Platform Import/Export, Proxy, Wiring, And Worker Propagation

**Status**: DONE. Import/export/proxy/wiring rows are now locked as `PASS` with public barrel reachability, direct apply/preview/revert coverage, Studio proxy scope locks, runtime route mounting evidence, and queue worker lifecycle wiring evidence.

**Goal**: Lock import/export internals, Studio proxies/read APIs, production wiring, package barrels, background workers, and queue processors.

**Test locks first**:

- Import manifest validation to direct-apply test asserts every accepted manifest field reaches DB/runtime read surfaces.
- Layer assembler/disassembler complete-field tests assert export/import do not silently drop new contract fields.
- Preview/revert test asserts preview diagnostics, direct apply, and revert agree on object identity and field sets.
- Export worker/job test asserts async job output matches synchronous export materialization for representative project.
- Runtime proxy and SDK channel proxy tests assert structured envelopes and auth context survive Studio proxying.
- Trace/session read route test asserts proxy/read route output matches runtime route output without leaking internal fields.
- Route mounting/barrel/worker registration tests assert production entry points actually reach new helpers and processors.

**Implementation**:

- Add wiring evidence tests for `server.ts`, queue registration, and package public exports.
- Keep Studio proxy helpers schema-driven and tenant/project scoped.
- Align import/export workers with direct materializer/importer implementations.

**Files likely touched**:

- `packages/project-io/src/import/manifest-validator.ts`
- `packages/project-io/src/import/post-import-validator.ts`
- `packages/project-io/src/import/core-direct-apply.ts`
- `packages/project-io/src/import/core-import-preview.ts`
- `packages/project-io/src/export/layer-assemblers/index.ts`
- `packages/project-io/src/import/layer-disassemblers/index.ts`
- `apps/studio/src/services/export-job-processor.ts`
- `apps/studio/src/services/export-worker.ts`
- `apps/studio/src/lib/runtime-proxy.ts`
- `apps/studio/src/lib/sdk-runtime-channel-proxy.ts`
- `apps/studio/src/lib/route-handler.ts`
- `apps/studio/src/lib/safe-proxy.ts`
- `apps/runtime/src/server.ts`
- `apps/runtime/src/services/queues/index.ts`
- `packages/project-io/src/index.ts`

**Exit criteria**:

- Import/export/proxy/wiring/worker platform rows have production reachability evidence.
- New helpers are exported and registered where production entry points need them.
- Both propagation lint tests pass.
- `platform-propagation-audit-lint.test.ts` prevents the Slice 24 rows from regressing from `PASS`.

**Verification**:

- `pnpm --filter @agent-platform/project-io build`
- `pnpm --filter @agent-platform/runtime build`
- `pnpm --filter @agent-platform/studio build`
- `pnpm --filter @agent-platform/shared-kernel build`
- `pnpm --filter @agent-platform/project-io exec vitest run src/__tests__/public-barrels.test.ts src/__tests__/import-validators.test.ts src/__tests__/core-direct-apply.test.ts src/__tests__/core-direct-apply-orchestrator.test.ts src/__tests__/post-import-validator.test.ts src/__tests__/layer-preview.test.ts src/__tests__/layer-disassemblers.test.ts`
- `pnpm --filter @agent-platform/runtime exec vitest src/__tests__/production-wiring.test.ts src/__tests__/channel-queue-lifecycle.test.ts src/__tests__/project-io-routes.test.ts`
- `pnpm --filter @agent-platform/studio exec vitest src/__tests__/services/export-job-processor.test.ts src/__tests__/api-routes/proxy-production-wiring.test.ts src/__tests__/sdk-runtime-channel-proxy.test.ts src/__tests__/runtime-session-attachments-proxy.test.ts src/__tests__/api-routes/route-handler-rbac.test.ts`
- `pnpm --filter @agent-platform/shared-kernel exec vitest run src/__tests__/platform-propagation-audit-lint.test.ts src/__tests__/propagation-audit-lint.test.ts`

### Slice 25: Web SDK, React, Vanilla, And Preview Surface Parity

**Status**: DONE. SDK and preview rows are now locked as `PASS` with a shared golden assistant-output fixture flowing through DefaultTransport, ChatClient, React RichContent, vanilla DOM rendering, hosted preview normalization, and preview/share token/reconnect tests.

**Goal**: Lock the SDK-visible path from runtime `sdk_websocket` and Studio preview/share through the Web SDK core client, React package, vanilla embed bundle, template renderers, action handling, and preview reconnect.

**Test locks first**:

- Web SDK core client test consumes the golden assistant-output fixture over the default transport and asserts text, rich content, actions, voice metadata, localization, provenance, typed interrupts, and final envelope are preserved.
- React package test renders the same fixture through `AgentProvider`, `ChatWidget`, message list, rich content renderer, and action handler; assert labels, payloads, disabled/loading states, and localization survive.
- Vanilla embed test loads the built bundle or vanilla example fixture and asserts the same structured payload renders without relying on React-only code paths.
- Template registry/renderer tests assert rich templates used by SDK clients preserve unknown future fields and deterministic channel fallback.
- Studio preview runtime test asserts `/preview/[projectId]`, preview token issuance, share links, and reconnect use the same SDK-visible contract as production SDK websocket sessions.
- Backward-compat test asserts legacy SDK payloads still render after canonical envelope changes.

**Implementation**:

- Add explicit Web SDK fixtures that import from the shared golden corpus instead of duplicating runtime fixtures.
- Route SDK client normalization through a versioned parser before React/vanilla presentation.
- Keep React package and vanilla embed behavior aligned by sharing renderer/action/template utilities where possible.
- Treat preview token/share/reconnect as an SDK client lane, not a separate Studio-only chat surface.

**Files likely touched**:

- `packages/web-sdk/src/index.ts`
- `packages/web-sdk/src/core/AgentSDK.ts`
- `packages/web-sdk/src/chat/ChatClient.ts`
- `packages/web-sdk/src/transport/DefaultTransport.ts`
- `packages/web-sdk/src/ui/ChatWidget.ts`
- `packages/web-sdk/src/ui/UnifiedWidget.ts`
- `packages/web-sdk/src/react/index.ts`
- `packages/web-sdk/src/react/AgentProvider.tsx`
- `packages/web-sdk/src/react/components/ChatWidget.tsx`
- `packages/web-sdk/src/templates/registry.ts`
- `packages/web-sdk/examples/vanilla-html/index.html`
- `apps/studio/src/app/preview/[projectId]/page.tsx`
- `apps/studio/src/app/api/sdk/preview-token/route.ts`
- `apps/studio/src/lib/share-preview-link.ts`
- `apps/studio/src/lib/preview-reconnect.ts`
- `apps/studio/e2e/sdk-preview-share.spec.ts`
- `apps/studio/e2e/react-sdk-provider-validation.spec.ts`
- `apps/studio/e2e/vanilla-sdk-widget-validation.spec.ts`

**Exit criteria**:

- Platform matrix rows for Web SDK core client, Web SDK React package, Web SDK vanilla embed, Studio preview runtime, and SDK preview share have deterministic regression locks.
- `platform-propagation-audit-lint.test.ts` requires the actual Web SDK and preview source inventory.
- Web SDK package tests and existing Studio SDK preview E2E specs are updated or cited as locks.
- `platform-propagation-audit-lint.test.ts` prevents the Slice 25 rows from regressing from `PASS`.

**Verification**:

- `pnpm --filter @agent-platform/web-sdk build`
- `pnpm --filter @agent-platform/runtime build`
- `pnpm --filter @agent-platform/studio build`
- `pnpm --filter @agent-platform/shared-kernel build`
- `pnpm --filter @agent-platform/web-sdk exec vitest run src/__tests__/sdk-golden-propagation.test.tsx src/__tests__/default-transport.test.ts src/__tests__/chat-client-transport.test.ts src/__tests__/react-components.test.tsx src/__tests__/rich-renderer-dom.test.ts src/__tests__/template-registry.test.ts src/__tests__/template-renderers.test.ts`
- `pnpm --filter @agent-platform/studio exec vitest src/__tests__/preview-chat-utils.test.ts src/__tests__/share-preview-link.test.ts src/__tests__/preview-reconnect.test.ts`
- `pnpm --filter @agent-platform/studio exec vitest -c vitest.node.config.ts src/__tests__/sdk-preview-share-api.e2e.test.ts`
- `pnpm --filter @agent-platform/shared-kernel exec vitest run src/__tests__/platform-propagation-audit-lint.test.ts src/__tests__/propagation-audit-lint.test.ts`

## 6. Cross-Slice Gates

Run these before considering the full plan complete:

1. Format all changed files:
   - `npx prettier --write <changed-files>`
2. Build before tests:
   - `pnpm build`
3. Focused package builds while iterating:
   - `pnpm --filter @agent-platform/runtime build`
   - `pnpm --filter @agent-platform/studio build`
   - `pnpm --filter @abl/compiler build`
4. Focused test families:
   - `pnpm --filter @agent-platform/shared-kernel exec vitest src/__tests__/propagation-audit-lint.test.ts`
   - `pnpm --filter @agent-platform/shared-kernel exec vitest src/__tests__/platform-propagation-audit-lint.test.ts`
   - `pnpm --filter @agent-platform/runtime exec vitest src/__tests__/execution`
   - `pnpm --filter @agent-platform/runtime exec vitest src/__tests__/routes`
   - `pnpm --filter @agent-platform/runtime exec vitest src/__tests__/channels`
   - `pnpm --filter @agent-platform/studio exec vitest src/__tests__ src/utils`
   - `pnpm --filter @agent-platform/studio exec vitest src/__tests__/tool-test-service.test.ts`
   - `pnpm --filter @agent-platform/web-sdk test:fast`
5. Security-sensitive slices:
   - `./tools/run-semgrep.sh` for guardrail, PII, auth, HTTP route, trace, and user-input changes.
6. Future-ready contract checks:
   - Run compatibility fixtures for legacy and new envelope shapes when a slice changes persisted, streamed, exported, or SDK-visible payloads.
   - Run schema-route and dependency-wiring checks for every touched API route, worker, proxy, package barrel, and queue registration.
   - Record migration/backfill posture for any changed durable shape, even when the decision is "reader compatibility only, no backfill."

## 7. Audit Update Rules

Each slice must update the audit source rows it closes:

1. Change `Fixed status` from `Open` to `Fixed` only after the deterministic test passes.
2. Replace `Regression lock status: Missing` with the exact test file and scenario name.
3. Do not remove matrix rows for fixed items; set them to `PASS` or `Fixed/covered` with evidence.
4. Convert `UNKNOWN` or `Likely` rows into one of:
   - fixed with test,
   - documented capability boundary with test,
   - narrower deferred row with owner and reason.
5. Keep channel manifest and channel surface matrix synchronized. A new channel must add a row and a capability test.
6. Keep the Platform Propagation Extension Matrix synchronized with implementation child plans. If a broad platform row is split, add the child row before landing code.
7. Track contract version and compatibility notes in the source audit row when the fix changes a persisted, streamed, exported, or SDK-visible shape.

## 8. Suggested Execution Order

The recommended order is risk-first, then proof expansion:

1. Slice 0: Baseline inventory and gates.
2. Slice 1: Output guardrail structured payload policy.
3. Slice 3: Voice trace scrubbing.
4. Slice 2: Non-flow input guardrail output protection.
5. Slice 4: Branch action interpolation.
6. Slice 5: Raw check failure sanitization.
7. Slice 6: Studio visual mutation safety.
8. Slice 7: Canonical direct chat constructors.
9. Slice 8: Readback, trace replay, observatory.
10. Slice 10: Init/nested branch persistence proof. Done in `[ABLP-856] fix(runtime): persist init branch envelopes`.
11. Slice 11: Fallback/error/terminal inventory. Done in `[ABLP-856] fix(runtime): lock fallback structured envelopes` plus the structured-only child-return closure.
12. Slice 12: Channel dispatcher revalidation. Done in `[ABLP-856] test(runtime): lock channel dispatcher persistence`.
13. Slice 9: Channel outcome and AI4W decisions.
14. Slice 13: Channel adapter parity. Done for capability-family parity in `[ABLP-856] test(runtime): lock channel rich capability families`.
15. Slice 14: E2E readback and Studio rehydration.
16. Slice 15: PII policy across structured return/readback.
17. Slice 16: Project tool numeric placeholder UI.
18. Slice 17: Tool-test and module deployment unknown closure. Done in `[ABLP-856] test(runtime): lock tool propagation unknowns`.
19. Slice 18: Platform tools and forms propagation. Done in `[ABLP-856] fix(shared): lock platform tool form propagation`.
20. Slice 19: Platform attachments and media propagation. Done in `[ABLP-856] fix(studio): lock attachment media propagation`.
21. Slice 20: Platform streaming and realtime propagation. Done in `[ABLP-856] test(web-sdk): lock streaming realtime propagation`.
22. Slice 21: Platform localization propagation. Done in `[ABLP-856] test(runtime): lock localization propagation`.
23. Slice 22: Platform auth, secrets, model, and policy propagation. Done in `[ABLP-856] test(runtime): lock auth model policy propagation`.
24. Slice 23: Platform memory, recall, and context propagation. Done in `[ABLP-856] test(runtime): lock memory recall propagation`.
25. Slice 24: Platform import/export, proxy, wiring, and worker propagation. Done in `[ABLP-856] fix(shared): lock import proxy wiring propagation`.
26. Slice 25: Web SDK, React, vanilla, and preview surface parity. Done in `[ABLP-856] fix(web-sdk): lock sdk preview parity propagation`.

## 9. Whole-Plan Acceptance Criteria

- Every confirmed `FAIL` / `GAP` item from the six source audit docs is fixed or explicitly blocked safe with tests.
- Every `UNKNOWN`, `Likely`, `PARTIAL`, or `NOT_COVERED` item listed in this plan is converted to a deterministic pass, a capability-boundary test, or a narrower follow-up row.
- The runtime structured output contract is locked across delivery, history, DB persistence, traces, read APIs, Studio replay, and representative channels.
- Studio visual editors cannot silently drop lifecycle structured payloads during partial/no-op/add/remove/reorder mutations.
- Project tool propagation has focused coverage for numeric placeholders, tool-test parity, and module deployment snapshots.
- The Platform Propagation Extension Matrix rows are either locked directly or split into narrower tracked rows with deterministic tests.
- Web SDK core, React package, vanilla embed, and Studio preview/share paths have explicit SDK-visible contract locks.
- Both propagation lint suites pass against the master tracker and source inventory.
- Versioned readers tolerate legacy and new persisted/streamed/exported payload shapes for every changed contract.
- Migration/backfill decisions are documented with volume estimates or explicit "not required" rationale.
- Performance-sensitive helpers have bounded comparison/cache behavior and focused regression coverage.
- `pnpm build` completes before full test execution.
- Security-sensitive runtime/PII/trace/channel changes pass `./tools/run-semgrep.sh`.
