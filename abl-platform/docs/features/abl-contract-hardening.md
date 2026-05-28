# Feature: ABL Contract Hardening

**Doc Type**: MAJOR FEATURE
**Parent Feature**: N/A
**Status**: BETA
**Feature Area(s)**: `agent lifecycle`, `governance`, `observability`, `integrations`
**Package(s)**: `packages/core`, `packages/compiler`, `packages/language-service`, `packages/project-io`, `packages/shared-kernel`, `packages/observatory`, `packages/arch-ai`, `packages/academy`, `apps/runtime`, `apps/studio`, `docs/reference`, `examples`
**Owner(s)**: Platform team
**Testing Guide**: [../testing/abl-contract-hardening.md](../testing/abl-contract-hardening.md)
**Last Updated**: 2026-04-19

---

## 1. Introduction / Overview

### Problem Statement

ABL currently has multiple competing authorities for the same public contract. Parser support, compiler IR, runtime behavior, Studio/editor assumptions, examples, academy material, and three separate documentation surfaces do not move together consistently. The result is false confidence for agent developers: syntax may parse but not execute as documented, runtime behavior may diverge between reasoning and FLOW modes, and examples can demonstrate patterns that are not actually safe or portable.

The original nine approved design decisions and the newly surfaced orchestration/export/observability gaps are all symptoms of the same root issue:

- no single machine-readable source of truth for the public ABL contract
- ambiguous ownership between agent-local, project-level, and platform-level semantics
- partially public constructs with unclear stability and migration policy
- examples and docs drifting away from the running product
- cross-agent memory, policy, and tracing semantics that are only partially composable
- project-level artifacts such as guardrails lacking a clean round-trip story alongside agent ABL

### Goal Statement

Establish one versioned, future-ready ABL public contract that is explicit about ownership, execution semantics, compatibility lanes, support tier, project-level policy assets, and cross-agent memory/tracing behavior; then align compiler, runtime, Studio, docs, examples, and bundle round-trip paths to that contract with build-time freshness checks and executable validation.

### Summary

This feature is now implemented across the original contract workstreams plus the missing cross-agent and observability foundations:

1. reasoning vs FLOW semantic parity
2. canonical `ON_RETURN`, `grant_memory`, and cross-agent memory-policy contract
3. agent-local enum vs project-level lookup ownership
4. public vs beta vs experimental construct tiers
5. canonical memory model including an execution-tree scope and recall/event semantics
6. machine `HANDOFF` vs human/system `ESCALATE`, including history policy and async completion
7. pre-turn reasoning-context projection and dynamic tool/prompt shaping
8. project-wide guardrails as first-class project artifacts with clean import/export round-trip
9. FLOW execution-order contract and dangerous-pattern linting
10. canonical trace-event contract and downstream type safety
11. BankNexus example architecture and bootstrap correctness
12. schema-backed generated docs and example validation wired into build/CI
13. curated long-form contract governance for Arch-AI, academy, and static Studio anatomy surfaces

The implementation bar for any public ABL contract in this feature is: parser/compiler acceptance, runtime execution or explicit non-runtime status, traceability where runtime applies, generated/reference docs alignment, example validation, and regression tests at the correct boundary.

---

## 2. Scope

### Goals

- Define a single canonical ABL contract model that compiler, runtime, Studio, and docs can all consume.
- Unify the core state/action semantics used by reasoning and FLOW execution paths.
- Replace ambiguous or half-public constructs with explicit public, beta, or experimental status.
- Make multi-agent coordination behavior predictable across `HANDOFF`, `ON_RETURN`, history passing, and human escalation.
- Establish one memory model that clearly separates observed values, session state, persistent facts, and recall behavior.
- Add a durable third memory scope for one execution tree / workflow / handoff chain.
- Make lookup-table ownership and precedence explicit across agent DSL and project runtime config.
- Make `grant_memory` an enforceable runtime capability, not parsed-only metadata.
- Surface session memory and granted memory into the reasoning context that drives prompts and tool selection.
- Rebuild tool availability and prompt overlays before each LLM turn based on auth, policy, and state.
- Make async handoff/background completion a first-class suspend/resume contract.
- Treat project-wide guardrails as first-class project artifacts that round-trip cleanly in export/import bundles.
- Unify trace event typing so runtime, observatory, Studio, and downstream consumers share one canonical contract.
- Freeze FLOW evaluation order as a documented, tested contract.
- Repair BankNexus so it is self-contained, architecturally correct, and suitable as a reference example.
- Generate repeated factual docs from machine-readable contract data and fail builds when generated artifacts drift.
- Govern curated long-form/manual ABL teaching surfaces with contract-backed CI checks so academy, Arch-AI knowledge, and static anatomy demos stop drifting from the shipped contract.

### Non-Goals (Out of Scope)

- A flag-day rewrite of the entire ABL grammar.
- A full redesign of all Studio authoring experiences unrelated to this broader hardening program.
- New customer-facing product features beyond the contract and example corrections required here.
- Immediate removal of all legacy syntax without a compatibility lane.
- Auto-generating all prose documentation; narrative guidance, tradeoffs, and curated examples remain hand-authored.
- Replacing the canonical project guardrail asset model with a flag-day ABL-only storage format; any future authoring surface must still lower to the same canonical asset and bundle projections.

---

## 3. User Stories

1. As an **agent developer**, I want the same core state and action semantics in reasoning and FLOW modes so that I can move patterns between them without hidden breakage.
2. As an **agent developer**, I want `ON_RETURN`, memory, lookup references, and human escalation to have one documented meaning so that examples and production agents stay portable.
3. As a **platform developer**, I want a single machine-readable contract registry so that parser, compiler, runtime, Studio, and docs stop drifting independently.
4. As a **Studio/builder user**, I want project-owned reference data and agent-owned semantics to stay clearly separated so that authoring surfaces do not create duplicate authority.
5. As a **QA/operator**, I want docs, examples, and reference apps to be validated in build/CI so that the public contract remains provably aligned with runtime behavior.
6. As a **project/bundle author**, I want project-wide guardrails to round-trip cleanly with the rest of a demo or deployment bundle so that cross-agent policy can ship as a first-class asset.
7. As an **agent developer**, I want `grant_memory`, session memory, and mid-flight tool access policy to behave predictably across handoffs so that multi-agent workflows are composable.
8. As an **observability/tooling developer**, I want one canonical trace-event contract so that runtime and Studio consumers stay type-safe without `as string` escape hatches.

---

## 4. Functional Requirements

1. **FR-1 (Shared Semantic Contract)**: The system must expose one canonical ABL contract registry that describes public constructs, stability tier, syntax metadata, legal values, system variables, event names, and repeated docs facts for use by compiler, runtime-adjacent validation, Studio/help surfaces, and doc generators.
2. **FR-2 (Reasoning vs FLOW Parity)**: The system must define and implement a shared result/state/action contract across reasoning and FLOW modes, including explicit result binding, computed state mutation, and documented intentional differences only where execution style truly requires them.
3. **FR-3 (`ON_RETURN` Canonicalization)**: The system must replace free-form `ON_RETURN` ambiguity with named return handlers plus explicit mapping, while preserving a documented compatibility lane for existing shorthand where safe.
4. **FR-4 (Lookup Ownership)**: The system must treat simple enum choices as agent-local authoring data and complex/shared lookup tables as project-owned runtime config, with explicit reference semantics, deterministic precedence, and fail-fast conflict handling.
5. **FR-5 (Public Stability Tiers)**: The system must classify ABL constructs and fields as `core`, `beta`, or `experimental`, and tooling must warn or fail when parsed-but-nonpublic constructs are used outside their supported tier.
6. **FR-6 (Memory Contract)**: The system must define one public memory model covering observed values, session state, persistent facts, remember/recall policies, canonical recall event syntax, reserved system identifiers such as `user_id`, and the handling of currently parsed advanced memory forms.
7. **FR-7 (Handoff / Escalation Split)**: The system must treat `HANDOFF` as machine-to-machine coordination only, `ESCALATE` as human/system escalation only, and must document plus enforce default history-passing behavior as `auto` unless explicitly overridden, with `auto` preferring summary-only transfer when safe and otherwise falling back to bounded raw history.
8. **FR-8 (FLOW Execution Order)**: The system must publish and test a numbered FLOW step execution order, including `GATHER`, `ON_INPUT`, mutation visibility, completion evaluation, and warnings for dangerous constructs such as ambiguous `GATHER + ON_INPUT` combinations and `COMPLETE_WHEN` misuse.
9. **FR-9 (BankNexus Reference Quality)**: The system must update BankNexus so that identity/bootstrap context is established before specialist routing, transfer flows gather all required fields, human requests use the correct escalation primitive, and the example folder is self-contained or explicitly marked when dependencies are external.
10. **FR-10 (Generated Facts + Build Gating)**: The system must generate repeated docs facts from the canonical contract registry, add explicit generate/check scripts, wire freshness checks into build/CI, and prevent stale mirrored docs or quick references from silently diverging.
11. **FR-11 (Round-Trip & Example Validation)**: The system must validate examples, fixtures, and generated reference artifacts against the canonical contract in automated tests so that docs/examples cannot claim support that compiler/runtime do not actually provide.
12. **FR-12 (Migration & Compatibility)**: The system must provide deprecation and compatibility behavior for legacy forms impacted by this feature, including documented warnings, test coverage for accepted legacy syntax, and a removal path for temporary shims.
13. **FR-13 (Project Guardrail Round-Trip)**: The system must treat project-wide guardrails as first-class project artifacts in export/import and demo bundles, with canonical persisted files, schema validation, ownership rebinding, and optional ABL-facing projections where authoring ergonomics require them.
14. **FR-14 (`grant_memory` Enforcement)**: The system must convert `grant_memory` from parsed metadata into an enforced cross-agent memory grant contract with validation, runtime application, lifetime rules, and explicit read/write semantics.
15. **FR-15 (Execution-Tree Memory Scope)**: The system must add a durable persistent-memory scope between `session` and `user`/`project`, representing one root execution tree or workflow/handoff chain, with deterministic lifecycle and isolation semantics.
16. **FR-16 (Reasoning Context Projection)**: The system must surface session memory, granted memory, and other canonical session-state projections into the reasoning context used for system-prompt construction, tool selection, and turn-level policy decisions.
17. **FR-17 (Dynamic Pre-Turn Tool / Prompt Shaping)**: The system must rebuild or filter available tools and prompt overlays before each LLM turn based on current auth, guardrail policy, granted memory, and execution context rather than relying only on start-of-execution static construction.
18. **FR-18 (Async Handoff / Background Completion)**: The system must make async handoff/background completion a first-class execution contract with suspend/resume state, timeout behavior, callback or completion routing, and trace coverage.
19. **FR-19 (Canonical Trace Event Contract)**: The system must define one canonical trace-event registry and type contract shared by shared-kernel, observatory, runtime, Studio, and downstream tooling, with parity tests for labels/grouping maps and emitted events.
20. **FR-20 (Cross-Agent Memory & Policy Composition)**: The system must support a fully composable cross-agent flow where identity, policy, memory grants, prompt context, tool gating, and return-path behavior can be reasoned about as one contract rather than isolated primitives.
21. **FR-21 (Curated Long-Form Contract Governance)**: The system must validate curated long-form/manual ABL teaching surfaces against the canonical contract during CI/build, combining contract-backed text assertions with parseable snippet checks so Arch-AI cards, academy modules, and static Studio anatomy assets cannot silently drift.

---

## 5. Feature Classification & Integration Matrix

### Lifecycle / Platform Impact

| Area                       | Impact Level | Notes                                                                                     |
| -------------------------- | ------------ | ----------------------------------------------------------------------------------------- |
| Project lifecycle          | PRIMARY      | Shared lookup tables, project-wide guardrails, and bundle round-trip affect project setup |
| Agent lifecycle            | PRIMARY      | Core authoring and execution contracts change                                             |
| Customer experience        | SECONDARY    | End-user behavior becomes more predictable through aligned contracts                      |
| Integrations / channels    | SECONDARY    | History passing, voice, human escalation, and SDK surfaces align                          |
| Observability / tracing    | PRIMARY      | Public semantics and runtime traces must match                                            |
| Governance / controls      | PRIMARY      | Stability tiers and public-contract boundaries become explicit                            |
| Enterprise / compliance    | SECONDARY    | Memory, escalation, and example correctness affect governed use cases                     |
| Admin / operator workflows | NONE         | No new admin workflow is planned in this feature                                          |

### Related Feature Integration Matrix

| Related Feature                                                | Relationship Type | Why It Matters                                                                                                  | Key Touchpoints                                             | Current State                                                  |
| -------------------------------------------------------------- | ----------------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------- |
| [ABL Language](abl-language.md)                                | extends           | This feature hardens the public contract for existing language constructs                                       | parser, compiler, language-service, docs                    | Stable feature doc exists; contract drift remains              |
| [ABL Spec-Implementation Parity](abl-spec-impl-parity.md)      | follows from      | This program expands parity from runtime-only wiring into full contract ownership and source-of-truth alignment | runtime execution, docs, examples                           | Partial parity work exists; broader contract issues remain     |
| [Memory & Session Management](memory-sessions.md)              | shares data with  | Memory scopes, recall semantics, and reserved identifiers must align with the runtime session model             | session stores, recall, persistent memory                   | Memory works, public contract is inconsistent                  |
| [Multi-Agent Orchestration](multi-agent-orchestration.md)      | depends on        | `HANDOFF`, `ESCALATE`, `ON_RETURN`, and history passing are part of the orchestration contract                  | compiler coordination config, runtime routing/handoff       | Runtime support exists with contract ambiguity                 |
| [Agent Development (Studio)](agent-development-studio.md)      | configured by     | Studio/editor authoring must present the same ownership and stability model as the runtime                      | gather editor, runtime config UI, docs/help                 | Studio surfaces still reflect mixed authority                  |
| [Voice Capabilities](voice-capabilities.md)                    | shares data with  | Voice behavior must remain aligned with the public ABL contract across behavior profiles and templates          | voice config resolver, docs, examples                       | Voice is implemented; authoring semantics need consistent docs |
| [Enum Fields & Lookup Tables Audit](enum-and-lookup-tables.md) | incorporates      | The lookup ownership decision from the audit becomes canonical here                                             | runtime config, gather semantics, runtime lookup resolution | Audit exists; platform-wide contract not yet finalized         |

---

## 6. Design Considerations

### Persona Boundary & Source-of-Truth Matrix

| Persona Lane             | Canonical Source of Truth                                                                        | Can Edit? | Runtime Impact                                                               | Precedence / Guardrail                                                                                  |
| ------------------------ | ------------------------------------------------------------------------------------------------ | --------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| End user                 | Runtime execution state and responses                                                            | No        | Receives execution behavior only                                             | Must never become a hidden authoring authority                                                          |
| Agent developer          | Agent DSL plus agent-local enums and return-handler references                                   | Yes       | Compiles into agent IR and runtime behavior                                  | Cannot silently override project-owned lookup data or platform-owned contract metadata                  |
| Project/builder operator | Project runtime config and project policy assets, especially shared lookup tables and guardrails | Yes       | Materializes into runtime config and cross-agent policy consumed by sessions | Project-owned reference data and guardrails cannot be duplicated as hidden authorities inside agent DSL |
| Platform developer       | Contract registry, parser/compiler/runtime validators, generated docs metadata                   | Yes       | Defines public ABL surface, stability, and generators                        | Platform-owned metadata must not be copied into ad hoc docs or examples                                 |

### Canonical Contract Principles

- One construct is public ABL only when it is parsed, validated, executed or explicitly non-runtime, documented, and represented consistently in examples.
- Compatibility shims are time-bounded and documented in the canonical contract, not buried in parser tests.
- Generated facts come from the contract registry; prose explanations and curated examples remain authored.
- Contract-sensitive long-form surfaces outside the generated reference path are curated explicitly and checked in CI against the same canonical contract.
- Project-wide guardrails remain project-owned artifacts even when a future ABL authoring projection exists; authoring projections compile down to the same canonical persisted asset.
- Cross-agent memory and tool/prompt policy are driven by explicit grants, scopes, and pre-turn projection rules, not by hidden prompt-builder side effects.
- Trace event names, categories, and downstream presentation metadata must derive from one canonical contract instead of per-package local unions.
- Example programs are treated as executable contract assertions, not marketing collateral.

### Compatibility Policy

- Legacy `ON_RETURN` string shorthand remains accepted only when it resolves to a named handler or explicitly supported compatibility action.
- Legacy `grant_memory: [paths]` remains accepted only as a compatibility shorthand; the canonical contract must lower it into explicit memory-grant metadata with typed access and lifetime semantics.
- Legacy recall aliases (`ON_START`, `session_start`, etc.) remain parseable during migration but canonical docs and generators emit `ON: session:start`.
- Parsed-but-nonpublic syntax remains either hidden behind `experimental` warnings or explicitly promoted; it is not left in an ambiguous half-public state.

---

## 7. Technical Considerations

### Canonical Registry Placement

The registry should live in the compiler layer so parser/compiler/language-service/runtime consumers can share one typed definition set without inventing a new authority in the docs stack. A planned location is `packages/compiler/src/platform/contracts/` with exported metadata consumed by:

- parser/compiler validation
- runtime-facing contract validation helpers
- Studio help, hover, and diagnostics surfaces
- generated quick-reference and schema-backed docs
- example validation and doc freshness tests

### Generated Docs Strategy

Use a hybrid model:

- **Generated**: construct inventories, property tables, legal enum/action values, built-in function counts, system-variable tables, event-name tables, stability markers, quick reference, mirrored app content
- **Authored**: philosophy, best practices, migration guidance, worked examples, anti-patterns, architectural rationale

Build integration must use explicit `generate` and `check` tasks. CI/build should fail on stale generated content rather than silently rewriting tracked files.

### Long-Form Governance Strategy

Not every ABL teaching surface should be generated, but every active one should be governed:

- Arch-AI knowledge cards should embed contract-backed fact sections directly from the compiler registry and then layer hand-authored explanation on top.
- Academy modules, static Studio anatomy pages, and other curated long-form surfaces remain authored, but CI must check them for forbidden legacy terms, canonical terminology, and parseable ABL snippets where they include runnable examples.
- The curated long-form validator is intentionally narrower than “all markdown in the repo”; it covers the active product/training surfaces where drift is highest-risk and can expand over time.

### Project-Wide Guardrail Asset Model

Project-wide guardrails need a clean ownership and round-trip story:

- the canonical project guardrail asset remains one portable policy object, with bundle projections available as `guardrails/<name>.guardrail.json` by default or `guardrails/<name>.guardrail.yaml` when requested
- import/export and demo bundles must treat guardrails as first-class project assets alongside runtime config
- any future ABL-facing guardrail authoring surface must compile to the same canonical guardrail asset rather than becoming a second authority
- runtime policy shaping should consume the canonical project guardrail asset, not copy partial settings into per-agent metadata

### Cross-Agent Memory & Policy Composition

The future-ready contract for multi-agent workflows is:

- a durable `execution_tree` memory scope for one root execution / workflow / handoff chain
- explicit memory grants between parent and child agents, with access rules and lifecycle
- a canonical pre-turn context projection that surfaces session memory, granted memory, gather progress, and policy state into reasoning
- dynamic pre-turn tool and prompt shaping driven by current auth, policy, memory grants, and execution state

This keeps cross-agent behavior explicit and testable instead of hiding it inside prompt-builder accidents.

### Async Orchestration & Trace Contract

Async handoff and observability must be hardened together:

- async handoff/background completion becomes a durable suspend/resume contract with timeout and completion routing
- trace events for these paths must be emitted from one canonical trace registry shared by runtime, observatory, and Studio
- downstream presentation layers should consume canonical event types and labels without `as string` escape hatches

### Rollout & Migration

- Land contract registry and generated docs early so subsequent workstreams stop creating new drift.
- Ship runtime/compiler behavior behind compatibility warnings where necessary.
- Promote docs/examples only after behavior, validation, and tests are aligned.
- Treat BankNexus as the reference “good sample” only after it compiles and passes its smoke scenarios.

---

## 8. How to Consume

### Studio UI

Studio continues to author ABL, but it must surface clearer ownership boundaries:

- agent-local enums stay inline with the agent authoring experience
- project lookup tables are selected by reference from project runtime config
- public/beta/experimental status is visible in help, diagnostics, and lint output
- generated reference content replaces hand-maintained duplicated factual docs where possible

### Surface Semantics Matrix

| Asset / Entity Type       | Source of Truth / Ownership          | Design-Time Surface(s)                                                      | Editable or Read-Only?            | Consumer Reference / Binding Model          | Runtime Materialization / Resolution                                                                                                                     | Notes / Unsupported State                                 |
| ------------------------- | ------------------------------------ | --------------------------------------------------------------------------- | --------------------------------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Public construct metadata | Platform contract registry           | generated docs, Studio help, validators                                     | Read-only to consumers            | construct id / keyword metadata             | used by parser/compiler/docs tooling                                                                                                                     | Must not be duplicated manually across docs               |
| Agent-local enum choices  | Agent DSL                            | Studio gather editor, DSL authoring                                         | Editable                          | inline field options                        | compiled into agent IR                                                                                                                                   | Remains agent-owned only                                  |
| Shared lookup tables      | Project runtime config               | RuntimeConfigTab and project settings                                       | Editable                          | field semantic reference by table name      | loaded into runtime/project config and merged deterministically                                                                                          | Agent DSL should not become a second config authority     |
| Project-wide guardrails   | Canonical project policy asset model | project settings, import/export bundle, future guardrail authoring surfaces | Editable                          | guardrail asset id / canonical logical path | imported/exported as `guardrails/*.guardrail.json` by default or `guardrails/*.guardrail.yaml` when requested, then applied at runtime policy boundaries | Future ABL projections must compile to the same asset     |
| Return handlers           | Agent DSL                            | DSL authoring, future Studio advanced authoring                             | Editable                          | handler name + optional map                 | compiled into coordination config                                                                                                                        | Legacy shorthand allowed only through compatibility layer |
| Generated factual docs    | Contract registry + doc generator    | docs/reference, docs-internal, Studio content                               | Generated artifacts are read-only | generated file paths and manifests          | consumed at docs build time                                                                                                                              | Freshness checked in CI/build                             |
| Example agents            | Example source files                 | repo examples and academy content                                           | Editable by platform team         | parsed/compiled fixture validation          | used as executable contract assertions                                                                                                                   | Must compile and match current contract                   |

### Design-Time vs Runtime Behavior

- Design-time contract metadata is platform-owned and must remain stable enough for docs/tooling generation.
- Agent-authored DSL remains the source for agent-specific behavior and references.
- Project runtime config remains the source for shared operational data such as lookup tables.
- Project-wide guardrails remain project-owned assets that can shape runtime policy across agents without being duplicated into per-agent hidden config.
- Runtime executes only the compiled/runtime-supported subset of the public contract, and unsupported experimental features must be surfaced explicitly before execution time.

### API (Runtime)

This feature hardened existing runtime boundaries rather than adding a brand-new endpoint family:

- `POST /api/projects/:projectId/project-io/import/preview` now mirrors `previewDigest` at the response root and fails invalid locale asset paths during preview with `E_LOCALE_INVALID_PATH`.
- `POST /api/projects/:projectId/project-io/import` now returns structured apply failures with `error.stage` plus `error.sanitizedCause` instead of collapsing all failures behind a single opaque sink.
- import rate limits now include `Retry-After` on `429` responses.
- imported inline agent `TOOLS:` signatures now materialize project-tool stubs during apply so bundle imports do not require separate manual tool creation.
- runtime session/chat entry now treats `project.entryAgentName` as the authoritative default entry agent when the caller does not request a valid override.

### API (Studio)

No new top-level Studio API was added, but the existing proxy/import surfaces were hardened to preserve the same additive contract:

- `POST /api/projects/:id/import/preview` mirrors the root-level `previewDigest`.
- `POST /api/projects/:id/import/apply` forwards staged apply errors with sanitized causes.
- Studio’s import/export docs and helper client types now treat these fields as part of the supported response envelope.

### Admin Portal

N/A.

### Channel / SDK / Voice / A2A / MCP Integration

- **SDK / web**: must observe the same `HANDOFF`/`ESCALATE`/history semantics as server-side executions.
- **Voice**: behavior-profile and voice contract documentation must stay aligned with the runtime voice resolver.
- **A2A / MCP**: no new protocol is planned, but any reuse of ABL contract metadata must consume the canonical registry rather than copy static tables.

---

## 9. Data Model

### Contract & Generated Artifacts

```text
Artifact: ABL contract registry (planned)
Location: packages/compiler/src/platform/contracts/
Purpose:
  - public constructs and stability tiers
  - legal enum/action values
  - system variables and event names
  - docs-generation metadata
  - example-validation metadata

Artifact: generated contract manifest (planned)
Location: docs/reference/generated/abl-contract.json
Purpose:
  - machine-readable snapshot for docs/tests

Artifact: project-wide guardrail assets (existing, hardened by this feature)
Location:
  - guardrails/<name>.guardrail.json (default bundle projection)
  - guardrails/<name>.guardrail.yaml (alternate bundle projection)
Purpose:
  - canonical cross-agent project policy asset
  - import/export round-trip for demo and deployment bundles through deterministic JSON/YAML projections

Artifact: canonical trace-event contract (planned hardening)
Location:
  - packages/shared-kernel/src/constants/trace-event-registry.ts
  - packages/shared-kernel/src/types/trace-event.ts
Purpose:
  - shared event names, categories, and type-safe downstream consumption

Artifact: generated quick-reference / mirror content (planned)
Locations:
  - docs/reference/generated/
  - apps/docs-internal/content/abl-reference/
  - apps/studio/content/abl-reference/
Purpose:
  - shared factual content derived from the registry
```

### Existing Runtime / Config Data Touched

```text
Existing collection/config: project_runtime_configs.lookup_tables
Ownership: project-level
Used for:
  - shared lookup validation/reference data
  - Studio runtime-config editing
  - runtime lookup resolution

Existing artifact/config: guardrails/*.guardrail.{json|yaml}
Ownership: project-level
Used for:
  - project-wide cross-agent guardrails
  - import/export round-trip
  - runtime policy shaping and bundle portability

Existing project metadata: Project.entryAgentName
Ownership: project-level
Used for:
  - authoritative default entry-agent selection for runtime chat/session entry
  - import/apply persisted entry-agent updates
  - parity between previewed project state and live runtime execution

Existing IR/config areas impacted:
  - coordination config (handoff / on_return / history)
  - memory config (session / persistent / remember / recall)
  - memory grants and execution-tree scope
  - flow step config (gather / on_input / complete_when)
  - pre-turn prompt/tool shaping
  - async handoff suspend/resume state
  - trace-event registry and downstream presentation maps
  - behavior and voice metadata where docs/runtime parity matters
  - import preview/apply response envelope (`previewDigest`, staged apply errors)
  - compiler output aliases (`errors`, `warnings`) for SDK-facing consumers
```

### Key Relationships

- The contract registry becomes the upstream authority for generated docs and validation metadata.
- Parser/compiler/runtime continue to own executable behavior, but their public-facing allowable shapes derive from the registry.
- Project runtime config remains the durable source of shared lookup tables consumed by runtime and referenced by agent DSL.
- Example suites and generated docs consume the same contract registry so drift becomes test-visible.

---

## 10. Key Implementation Files

### Domain / Core Logic

| File                                                                            | Purpose                                                                        |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `packages/core/src/parser/agent-based-parser.ts`                                | Canonical parser behavior for ABL sections and legacy alias handling           |
| `packages/core/src/parser/yaml-parser.ts`                                       | YAML-form ingest and shorthand normalization                                   |
| `packages/core/src/schema/abl-schema.json`                                      | Public schema surface consumed by tooling/tests                                |
| `packages/compiler/src/platform/ir/schema.ts`                                   | Typed IR contract for coordination, memory, flow, and docs metadata            |
| `packages/compiler/src/platform/ir/compiler.ts`                                 | DSL-to-IR lowering and compatibility transforms                                |
| `packages/compiler/src/platform/constructs/executors/timeout-utils.ts`          | Canonical timeout literal normalization for quoted and unquoted forms          |
| `packages/compiler/src/platform/ir/validate-coordination-config.ts`             | Handoff/return compatibility and legality checks                               |
| `packages/compiler/src/platform/ir/validate-field-refs.ts`                      | Field/state mapping and producer/consumer validation for handoff and flow      |
| `packages/project-io/src/import/layer-disassemblers/guardrails-disassembler.ts` | Project guardrail import and bundle rebinding                                  |
| `packages/project-io/src/export/layer-assemblers/guardrails-assembler.ts`       | Project guardrail export and canonical file emission                           |
| `packages/project-io/src/import/entity-schemas.ts`                              | Guardrail schema recognition during import validation                          |
| `packages/project-io/src/import/import-validator.ts`                            | Import path and file-shape validation for guardrail assets                     |
| `packages/project-io/src/import/core-direct-apply.ts`                           | Direct import planning/execution, tool-stub synthesis, and staged apply errors |
| `packages/project-io/src/import/folder-reader.ts`                               | Preview-time file classification and locale path validation                    |
| `packages/shared/src/prompts/template-engine.ts`                                | Shared filter-aware template rendering with fail-closed behavior               |
| `packages/shared-kernel/src/constants/trace-event-registry.ts`                  | Canonical runtime event names and registry metadata                            |
| `packages/shared-kernel/src/types/trace-event.ts`                               | Shared trace event type contract                                               |
| `packages/observatory/src/schema/trace-events.ts`                               | Observatory schema that must converge on the canonical contract                |

### Runtime / Execution

| File                                                          | Purpose                                                                       |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `apps/runtime/src/services/runtime-executor.ts`               | Shared execution entry point, handoff return handling, compatibility behavior |
| `apps/runtime/src/services/execution/reasoning-executor.ts`   | Reasoning-path semantic behavior                                              |
| `apps/runtime/src/services/execution/flow-step-executor.ts`   | FLOW-path ordering, gather, on_input, completion behavior                     |
| `apps/runtime/src/services/execution/value-resolution.ts`     | Shared path resolution, template filters, and fail-closed interpolation rules |
| `apps/runtime/src/services/execution/routing-executor.ts`     | Handoff routing, cycle prevention, and async orchestration touchpoints        |
| `apps/runtime/src/services/execution/types.ts`                | Async handoff timeout and execution-state contract types                      |
| `apps/runtime/src/services/execution/memory-scope-runtime.ts` | Scoped memory projection, grants, and `execution_tree` aliasing               |
| `apps/runtime/src/repos/project-repo.ts`                      | Project entry-agent selection contract                                        |
| `apps/runtime/src/routes/chat.ts`                             | Live runtime entry-agent resolution                                           |
| `apps/runtime/src/routes/project-io.ts`                       | Public import preview/apply response envelope                                 |
| `apps/runtime/src/services/voice/voice-config-resolver.ts`    | Voice/runtime parity touchpoint for contract-backed docs                      |

### UI / Docs Surfaces

| File                                                              | Purpose                                           |
| ----------------------------------------------------------------- | ------------------------------------------------- |
| `apps/studio/src/components/settings/RuntimeConfigTab.tsx`        | Project-owned lookup-table authoring              |
| `apps/studio/src/store/agent-detail-store.ts`                     | Agent-editor semantic loading and field ownership |
| `apps/studio/src/store/trace-store.ts`                            | Studio trace contract consumption                 |
| `apps/studio/src/utils/observatory-event-presentation.ts`         | Studio event presentation mapping                 |
| `apps/studio/src/api/project-io.ts`                               | Studio-side import/apply client contract          |
| `docs/reference/ABL_SPEC.md`                                      | Canonical long-form authored spec                 |
| `docs/reference/ABL_QUICK_REFERENCE.md`                           | Quick reference, should become generated-heavy    |
| `apps/docs-internal/content/abl-reference/full-specification.mdx` | Mirrored internal-doc surface                     |
| `apps/studio/content/abl-reference/full-specification.mdx`        | Mirrored Studio help surface                      |

### Examples / Validation / Tests

| File                                                                                 | Type             | Coverage Focus                                                 |
| ------------------------------------------------------------------------------------ | ---------------- | -------------------------------------------------------------- |
| `packages/compiler/src/__tests__/ir/abl-spec-examples-validation.test.ts`            | integration      | spec example validity against parser/compiler                  |
| `packages/compiler/src/__tests__/validate-coordination-config.test.ts`               | unit             | `ON_RETURN` legality and compatibility                         |
| `packages/compiler/src/__tests__/compiler-output-contract.test.ts`                   | unit             | additive SDK-facing `errors` / `warnings` aliases              |
| `packages/compiler/src/__tests__/memory-enhanced.test.ts`                            | unit             | memory syntax and recall normalization                         |
| `packages/compiler/src/__tests__/lookup-compilation.test.ts`                         | integration      | lookup ownership and compiled representation                   |
| `packages/project-io/src/__tests__/core-direct-apply-orchestrator.test.ts`           | integration      | preview/apply tool synthesis and staged operation planning     |
| `packages/project-io/src/__tests__/core-direct-apply.test.ts`                        | integration      | apply error envelopes and rollback behavior                    |
| `packages/project-io/src/__tests__/folder-reader-diagnostics.test.ts`                | unit/integration | preview-time invalid locale path rejection                     |
| `apps/runtime/src/__tests__/execution/handoff-return-propagation-regression.test.ts` | regression       | return-path behavior and session mapping                       |
| `apps/runtime/src/__tests__/execution/reasoning-gather-handoff.test.ts`              | integration      | reasoning/runtime coordination behavior                        |
| `apps/runtime/src/__tests__/execution/cross-agent-memory-policy.test.ts`             | integration      | cross-agent memory, policy, and pre-turn prompt projection     |
| `apps/runtime/src/__tests__/execution/flow-set-remember-regressions.test.ts`         | regression       | FLOW step-entry mutation and REMEMBER batching                 |
| `apps/runtime/src/__tests__/execution/value-resolution.test.ts`                      | unit/regression  | dotted SET resolution and template-filter fail-closed behavior |
| `apps/runtime/src/__tests__/memory-scope-runtime.test.ts`                            | unit/regression  | granted-memory aliasing and `execution_tree` writeback         |
| `apps/runtime/src/__tests__/memory-integration.test.ts`                              | integration      | runtime memory semantics                                       |
| `apps/runtime/src/__tests__/project-io-routes.test.ts`                               | integration      | import preview/apply response envelope and rate-limit headers  |
| `apps/runtime/src/__tests__/sessions/chat-routes.test.ts`                            | integration      | entry-agent selection and runtime chat defaults                |
| `apps/runtime/src/__tests__/import-idempotent.e2e.test.ts`                           | e2e              | tool auto-creation from inline `TOOLS:` signatures             |
| `apps/studio/src/__tests__/api-routes/api-project-io-roundtrip.test.ts`              | integration      | Studio import/apply proxy contract                             |
| `apps/runtime/src/__tests__/behavior-profiles.e2e.test.ts`                           | e2e/integration  | behavior/runtime parity examples                               |
| `examples/banknexus/agents/*.abl`                                                    | example fixtures | reference-example correctness                                  |
| `package.json`                                                                       | build / CI       | contract freshness + validation gate scripts                   |
| `turbo.json`                                                                         | build / CI       | docs/example-sensitive cache invalidation                      |

---

## 11. Configuration

### Environment Variables

No new environment variable is required to define the contract itself. If implementation introduces generation-specific toggles, they must default fail-closed in CI and remain optional for local development only.

### Runtime Configuration

- Existing `project_runtime_configs.lookup_tables` remains the project-level source for shared lookup tables.
- Existing coordination defaults such as history strategy must remain documented and aligned with the contract registry.
- Any temporary compatibility toggle introduced during rollout must be explicitly documented with a removal target.

### DSL / Agent IR / Schema

Illustrative target shape for the return path:

```abl
RETURN_HANDLERS:
  await_next_request:
    RESPOND: "What else can I help with?"
    CONTINUE: true

HANDOFF:
  - TO: Fund_Transfer
    RETURN: true
    ON_RETURN:
      handler: await_next_request
      map:
        customer_id: auth_result.customer_id
```

Illustrative target shape for explicit cross-agent memory grants:

```abl
HANDOFF:
  - TO: Billing_Agent
    RETURN: true
    CONTEXT:
      pass: [customer_id]
      memory_grants:
        - path: user.last_verified_at
          access: read
        - path: execution_tree.auth_result
          access: readwrite
```

`grant_memory: [user.last_verified_at]` remains a compatibility shorthand until the explicit grant model fully replaces it.

Current additive compatibility envelopes landed during rollout hardening:

- `CompilationOutput.errors` / `warnings` mirror `compilation_errors` / `compilation_warnings` for SDK callers that inspect generic fields only.
- FLOW terminal targets `COMPLETE` and `ESCALATE` are now case-insensitive wherever `THEN:` / `ON_FAIL:` consume terminal actions.
- Bare dotted `SET` values resolve as paths; quote them to preserve literal dotted strings.
- Template filters (`upper`, `lower`, `json` / `tojson`, `ago`) now render intentionally and fail closed on unresolved values.
- Import/apply failures surface `error.stage` plus `error.sanitizedCause` instead of one opaque `IMPORT_APPLY_FAILED` sink.

Illustrative ownership split for reference data:

```abl
GATHER:
  - account_type:
      type: enum
      options: [checking, savings]
  - destination_country:
      semantics:
        lookup: supported_countries
```

---

## 12. Non-Functional Concerns

### Change-Review Rubric Coverage

Primary concerns for this feature:

- Persona boundaries & source-of-truth ownership
- Reasoning vs FLOW path consistency
- Contracts & compatibility
- Activation, deployment & reachability
- Docs, examples, cross-module consistency & code sanity
- Test integrity, regression coverage & behavior validation

Secondary concerns:

- Session state, metadata & memory
- Execution & orchestration
- Traceability, audit & observability
- Import/export round-trip fidelity for generated docs and examples

### Isolation / Security / Compliance

- No change may let project-owned or agent-owned artifacts silently override platform-owned contract metadata.
- Shared lookup references must remain project-scoped and fail closed on conflicts.
- Project-wide guardrails must round-trip without lossy rebinding or silent downgrade to per-agent hidden config.
- Reserved identifiers such as `user_id` must remain system-owned and immutable at the public-contract layer.
- Memory grants and `execution_tree` scope must fail closed so one workflow cannot read another workflow’s durable state.
- Human escalation semantics must not be smuggled into machine handoff behavior.

### Performance / Reliability

- Generated-doc freshness checks and guardrail round-trip checks must be deterministic and fast enough for CI gating.
- New caches or maps introduced for contract metadata must include max size, TTL, and eviction if retained in memory.
- Pre-turn tool/prompt reshaping must remain bounded enough that it does not create unbudgeted per-turn latency spikes.
- Example validation should run incrementally where possible, but must still exercise all canonical public examples in CI.

---

## 13. Delivery Plan / Work Breakdown

1. **Contract foundation**
   1. Inventory the public ABL contract across parser, compiler IR, runtime, docs, Studio, and examples.
   2. Create the canonical contract registry and generated-manifest pipeline.
   3. Add doc/example freshness checks before changing public behavior.
2. **Project policy and coordination hardening**
   1. Treat project-wide guardrails as canonical project assets with clean import/export round-trip and runtime policy application.
   2. Canonicalize `ON_RETURN`, `HANDOFF`, `ESCALATE`, and history-policy behavior.
   3. Define the compatibility lane for legacy `grant_memory` shorthand and future explicit memory grants.
3. **Execution and runtime orchestration hardening**
   1. Align reasoning and FLOW state/action semantics.
   2. Add pre-turn context projection, dynamic tool/prompt shaping, and async handoff/background completion.
   3. Freeze and test FLOW execution order plus risky-pattern linting.
4. **Ownership, memory, and trace hardening**
   1. Finalize lookup-table ownership and precedence.
   2. Finalize memory scopes, `execution_tree`, recall syntax, reserved system variables, and advanced-form policy.
   3. Unify trace-event typing and downstream presentation metadata across packages.
   4. Add stability-tier metadata and warnings for nonpublic constructs.
5. **Surface alignment**
   1. Update generated docs and mirrored app content.
   2. Update Studio authoring/help surfaces to reflect the contract.
   3. Repair BankNexus and other affected examples.
   4. Remove guide/spec contradictions for `grant_memory`, async handoff, and trace contracts.
6. **Rollout and verification**
   1. Add compatibility warnings and removal plan for legacy forms.
   2. Complete regression, round-trip, and reachability coverage.
   3. Run post-implementation doc sync using the generated contract as the source of truth.

---

## 14. Success Metrics

- One canonical contract registry exists and is consumed by at least compiler validation, docs generation, and example validation.
- Curated long-form surfaces are validated against the same contract in CI and cannot silently regress to legacy coordination/memory semantics.
- No repeated factual ABL tables are hand-maintained across spec, quick ref, Studio, and docs-internal surfaces.
- Reasoning and FLOW parity tests cover all intentionally shared semantics touched by this feature.
- Project-wide guardrails round-trip cleanly through import/export bundles and remain project-owned throughout runtime application.
- `ON_RETURN`, memory, lookup ownership, and handoff history rules have explicit compatibility coverage and no unresolved CRITICAL/HIGH contract ambiguity.
- `grant_memory`, `execution_tree`, and pre-turn tool/prompt shaping support at least one fully automated cross-agent workflow scenario.
- Trace consumers use one canonical event contract without local string-cast escape hatches for valid runtime events.
- BankNexus compiles and passes smoke validation as a self-consistent reference example.
- Build/CI fails when generated docs or validated examples drift from the canonical contract.

---

## 15. Open Questions

- No blocking open questions remain for the approved ABL contract-hardening scope.
- Future product-expansion questions, outside this closed program, include:
  - whether to add a fully authored ABL guardrail source surface beyond the current canonical asset model plus JSON/YAML bundle projections
  - which currently parsed advanced memory forms should graduate from `experimental` to `beta`
  - how far to extend curated long-form governance beyond the currently protected reference, academy, Arch-AI, and static Studio anatomy surfaces

---

## 16. Gaps, Known Issues & Limitations

- The feature is implemented, build-gated, and now includes public orchestration/policy E2E coverage, a dedicated pre-turn shaping performance guard, and explicit retirement coverage for the previously temporary legacy authoring lanes.
- Authored compatibility lanes for inline `ON_RETURN`, legacy `grant_memory`, and legacy recall-event aliases are retired from parser/compiler/docs/examples. Runtime keeps only a narrow persisted-IR shim so already-deployed artifacts can still complete safely during rollout.
- Some long-form docs remain hand-authored by design; they are protected by parity tests and generated factual inserts, but they are not fully generated from the contract registry.
- Curated long-form contract governance is now implemented for Arch-AI knowledge cards, academy multi-agent modules, and static Studio anatomy surfaces; broader handbook/cookbook coverage can be added incrementally using the same manifest-driven validator pattern.
- No required follow-up remains for the approved ABL contract-hardening program.
- Future product expansion could still add a fully authored ABL guardrail DSL, but that is intentionally outside this closed scope because the current canonical asset model plus JSON/YAML bundle projections already satisfy the approved portability contract.

### Mitigated During Implementation

- Generated docs and mirrored app reference surfaces now fail freshness checks in build/CI.
- `grant_memory` is now enforced through explicit runtime memory-grant handling instead of remaining parsed-only metadata.
- Session memory, granted memory, and policy state now participate in the pre-turn execution view used by reasoning turns.
- Async handoff/background completion now routes through durable suspend/resume handling with shared return-dispatch behavior.
- Trace typing is now driven from the shared-kernel registry rather than fragmented local unions.
- BankNexus now compiles as a self-consistent reference bundle with supervisor bootstrap, memory grants, and human `ESCALATE`.
- import preview/apply now share one deterministic file-validation surface for locale assets, expose root-level `previewDigest`, and return staged apply failures with sanitized causes.
- runtime now honors `project.entryAgentName`, normalizes DSL CALL signatures to the bare tool key, and resolves bare dotted `SET` expressions as value paths instead of silent string literals.
- quoted timeout literals and additive compiler `errors` / `warnings` aliases are now covered as supported compatibility lanes instead of accidental behavior.
- filtered template expressions now render intentionally in shared/runtime surfaces and fail closed when unsupported.

---

## 17. Testing & Validation

See [../testing/abl-contract-hardening.md](../testing/abl-contract-hardening.md) for the full matrix. At a minimum, implementation must include:

- compiler/runtime contract tests for each affected workstream
- parity tests across reasoning and FLOW paths
- deny-path tests for conflicts, unsupported constructs, and reserved-variable misuse
- docs freshness tests and generated-artifact checks in build/CI
- example compile/validation coverage for BankNexus and canonical spec examples

Current implementation verification includes:

- `pnpm abl:contract:check`
- `pnpm --filter @agent-platform/project-io test -- src/__tests__/core-direct-apply-orchestrator.test.ts src/__tests__/core-direct-apply.test.ts src/__tests__/folder-reader-diagnostics.test.ts`
- `pnpm --filter @abl/compiler test -- src/__tests__/validate-coordination-config.test.ts src/__tests__/validate-flow-graph.test.ts src/__tests__/compiler-output-contract.test.ts`
- `pnpm --filter @agent-platform/shared test -- src/__tests__/template-engine.test.ts`
- `pnpm --filter @agent-platform/studio test -- src/__tests__/api-routes/api-project-io-roundtrip.test.ts`
- `pnpm --filter @agent-platform/runtime exec vitest run --config vitest.core.config.ts --maxWorkers=1 src/__tests__/auth/middleware.test.ts src/__tests__/project-io-routes.test.ts src/__tests__/rate-limiter-per-api-key.test.ts src/__tests__/execution/value-resolution.test.ts`
- `pnpm --filter @agent-platform/runtime exec vitest run --config vitest.integration.config.ts --maxWorkers=1 src/__tests__/sessions/chat-routes.test.ts`
- `pnpm --filter @agent-platform/runtime exec vitest run --config vitest.e2e.config.ts --maxWorkers=1 src/__tests__/import-idempotent.e2e.test.ts`
- `pnpm --filter @agent-platform/runtime build`
- `pnpm --filter @agent-platform/runtime exec vitest run --config vitest.core.config.ts src/__tests__/execution/cross-agent-memory-policy.test.ts`
- `pnpm --filter @agent-platform/runtime exec vitest run --config vitest.core.config.ts src/__tests__/execution/flow-set-remember-regressions.test.ts src/__tests__/memory-scope-runtime.test.ts -t "step-entry SET batches trigger REMEMBER once|readwrite execution_tree grants preserve writable metadata without an initial value"`

---

## 18. References

- [ABL Language](abl-language.md)
- [ABL Spec-Implementation Parity](abl-spec-impl-parity.md)
- [Memory & Session Management](memory-sessions.md)
- [Multi-Agent Orchestration](multi-agent-orchestration.md)
- [Agent Development (Studio)](agent-development-studio.md)
- [Enum Fields & Lookup Tables Audit](enum-and-lookup-tables.md)
- [ABL Semantic Constructs Design](../design/2026-04-07-abl-semantic-constructs-design.md)
- [Enum / Lookup PR Review](../reviews/enum-lookup-pr-review.md)
- `docs/enterprise/GRAPH_TO_ABL_FEATURE_MAPPING.md`
- `docs/reference/ABL_SPEC.md`
- `docs/reference/ABL_QUICK_REFERENCE.md`
- `/Users/prasannaarikala/projects/f-1/abl-platform/docs/sdlc/change-review-rubric.md`
