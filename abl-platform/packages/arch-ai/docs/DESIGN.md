# Arch AI — Design Document

> Package: `@agent-platform/arch-ai` (`packages/arch-ai/`)
> Version: 0.3.0
> Status: Live (in-project + knowledge hardening slice)
> Companion diagram: [`presentations/architecture.html`](./presentations/architecture.html) — open in a browser for the interactive view.
> Other presentations: [`presentations/showcase.html`](./presentations/showcase.html) (visual demo), [`presentations/deep-dive.html`](./presentations/deep-dive.html) (interactive guide), [`presentations/presentation.html`](./presentations/presentation.html) (short marketing demo).
> Generation architecture: [`generation-architecture.md`](./generation-architecture.md) — construct-aware blueprint/build plan for moving from repair loops to validated deterministic rendering.
> Agent intelligence audit: [`agent-intelligence-pattern-audit.md`](./agent-intelligence-pattern-audit.md) — orchestration patterns, execution-mode fit, and scenario coverage gaps.

Arch AI is the **surface-agnostic engine** that powers AI-assisted agent design in the ABL platform. It is consumed by Studio (Next.js) and the Runtime (Express) through a small set of public exports, and is intentionally free of HTTP, React, or transport concerns.

This document describes:

1. What Arch AI is and what it is _not_
2. The conceptual model (modes, phases, sessions, specialists, tools)
3. Each subsystem inside `src/`
4. The data flows that stitch the subsystems together
5. The persistence model and public API contract

---

## 1. What Arch AI is

Arch AI is a **deterministic coordinator wrapped around an agentic LLM loop**. The coordinator owns the lifecycle (which phase we are in, which specialist runs, what tools are allowed, when to advance). The LLM owns the conversation inside a single phase. Tool calls cross the boundary in both directions.

Three properties shape the entire design:

- **Surface-agnostic.** No Express handlers, no React, no Next.js. The package exports types, services, schemas, and pure functions. The Runtime mounts an SSE route on top; Studio renders SSE events.
- **Contract-driven.** Every subsystem exists to satisfy a numbered contract under `docs/arch/contracts/`. Phase transitions, tool registration, SSE event shapes, and journaling are typed at the boundary; the LLM cannot fabricate them.
- **Deterministic where it matters.** Phase transitions, exit criteria, scope classification, build-gate queueing, and topology ordering are pure functions over session metadata. The LLM never decides _when_ to advance — it only decides _what to say_ inside a phase.

What Arch AI is **not**:

- Not a runtime for compiled agents — that is `apps/runtime/` driven by `@abl/compiler`.
- Not an LLM provider abstraction — it consumes an `LLMStreamClient` interface; the implementation lives elsewhere.
- Not a UI library — widget rendering, chat surfaces, and progressive layout live in `apps/studio/src/components/arch-v3/`.
- Not a transport — SSE event _shapes_ live here (Zod schemas, serializer, parser). Mounting them on a route is the consumer's job.

---

## 2. Conceptual Model

### Modes

| Mode         | Trigger                           | Lifecycle                                                               |
| ------------ | --------------------------------- | ----------------------------------------------------------------------- |
| `ONBOARDING` | Session created without project   | INTERVIEW → BLUEPRINT → BUILD → CREATE → completes when `projectId` set |
| `IN_PROJECT` | Session bound to existing project | Single open phase; specialist routed by content                         |

Mode is resolved deterministically: `resolveMode(projectId)` returns `IN_PROJECT` iff `projectId` is provided.

### Phases (ONBOARDING)

Owned by `coordinator/phase-machine.ts`. Each phase has one specialist, a typed exit predicate, and exactly one forward edge. The only legal backward edge is `BUILD → BLUEPRINT` for large-scope mutations.

| Phase       | Specialist              | Exit criterion                                                     |
| ----------- | ----------------------- | ------------------------------------------------------------------ |
| `INTERVIEW` | `onboarding`            | `canExitInterview(specification)` — required spec fields populated |
| `BLUEPRINT` | `multi-agent-architect` | `metadata.topologyApproved === true`                               |
| `BUILD`     | `abl-construct-expert`  | All topology agents have `compiled` or `warning` status            |
| `CREATE`    | `onboarding` (no LLM)   | `metadata.projectId` set (project created)                         |

`PHASE_CONFIG` is a `Record<ArchPhase, PhaseConfig>` rather than a `Set` so it stays a compile-time constant — no unbounded-collection lint trip.

### Session States

Owned by `coordinator/session-state-machine.ts`. **Gate-free design**: a single session alternates between `IDLE` and `ACTIVE` only. Pending widget interactions are persisted on the session as `pendingInteraction` rather than a distinct state.

```
IDLE ⇄ ACTIVE → COMPLETE → ARCHIVED
            ↓
        ARCHIVED   (manual "Start Fresh")
```

`GATE_PENDING` is retained only as a legacy DB read state for cleanup; new sessions never enter it.

### Specialists

Eleven specialists in two pools:

- **ONBOARDING pool** (7): `onboarding`, `multi-agent-architect`, `abl-construct-expert`, `channel-voice`, `entity-collection`, `integration-methodologist`, `testing-eval`
- **IN_PROJECT pool** (3 + 1 generalist): `diagnostician`, `analyst`, `observer`, plus the in-project generalist for routing fallback

Each specialist is a system prompt under `prompts/specialists/`, a tool list under `types/tools.ts`, and a display banner emitted as the first SSE event of every turn.

### Tools

Tools come in two flavors:

- **Server-side tools** — executed by the coordinator's `toolExecutors` map. Result is fed back to the LLM in the same turn (multi-turn loop).
- **Client-side tools** — `ask_user`, `collect_file`. The executor emits the `tool_call`, emits `done`, and STOPS. The user supplies the answer; the coordinator calls `resume()`.

`PHASE_TOOL_MAP` (`types/tools.ts`) gates which tools are visible to the LLM in each phase. The LLM can only call what it can see.

---

## 3. Subsystem Reference

```
src/
├── coordinator/      — phase machine, state machine, scope, loops, topology, build-gate queue, content router
├── executor/         — specialist turn, multi-turn loop, content-block resolution, tool validation, guards
├── session/          — service (CRUD + transitions), checkpoints, file store, memory, resume
├── spec-document/    — single-source-of-truth project document (markdown + structured)
├── journal/          — append-only typed event log (decision/consultation/mutation/validation/analysis)
├── audit/            — security/operational audit log emitter
├── streaming/        — SSE serializer, parser, activity emitter
├── tools/            — JSON Schema tool definitions for the LLM
├── knowledge/        — knowledge cards (ABL constructs, workflows, limits) + selector
├── diagnostics/      — rules engine, findings, fix templates
├── generation/       — ABL skeleton → validate → auto-fix pipeline
├── mock-server/      — extract tools from agents, generate mock server artifacts
├── prompts/          — base + per-specialist + per-phase system prompts
└── types/            — schemas, constants, errors, content blocks, page context
```

### 3.1 `coordinator/`

#### `phase-machine.ts`

Pure functions over `ArchSession`. `transitionPhase(session, target)` validates the edge against `VALID_TRANSITIONS`, evaluates the source phase's exit criteria (skipped for the special `BUILD → BLUEPRINT` backtrack), and returns the new phase or throws `InvalidTransitionError` / `ExitCriteriaNotMetError`. The coordinator stays in control; the LLM cannot advance phases.

#### `session-state-machine.ts`

Same pattern as the phase machine but for `SessionState`. Emits explicit transition errors so the API layer can return well-typed 409s when two clients race a state change.

#### `scope-classifier.ts`

Classifies a user request as `SMALL` or `LARGE`:

- **Small** mutations (rewording, copy edits, single-field updates) stay in the current phase.
- **Large** mutations (add/remove an agent, redesign topology, change channel set) trigger a `BUILD → BLUEPRINT` backtrack so the architect can re-plan.

#### `loop-detection.ts`

Per-turn SHA-256 fingerprinting of LLM output. If the model emits the same response twice in a row, the executor trips a guard and returns `guard_tripped` rather than burning tokens in a tight loop.

#### `topology-synthesis.ts`

Handles topology generation, pattern classification, and a deterministic decision tree (`TOPOLOGY_DECISION_TREE`) for picking common patterns (single-agent, supervisor + workers, pipeline, etc.) when the architect doesn't propose one. Includes `synthesizeDefaultTopology` for the case where the user moves forward without explicit architecture input.

#### `build-gate-queue.ts`

Pure-functional queue derived on demand from `(topology, files, approvedAgents)`. Returns one of three decisions:

- `next` — an agent is ready for review (file exists, not approved). Caller emits an `agent_review` gate.
- `needs_generation` — generated files are exhausted; call the LLM again to generate the next batch.
- `all_done` — every topology agent is approved; advance to TOOLS sub-phase or mock-server generation.

Build order is computed via Kahn's topological sort on every call; never trust a cached order across topology edits. `diffTopologyAgainstBuildState` preserves work on a `BUILD → BLUEPRINT` backtrack — agents whose role hasn't changed keep their files and approvals.

Hard cap: `MAX_AGENTS_PER_TOPOLOGY = 256` documents the bound and satisfies the unbounded-collections lint.

#### `content-router.ts`

For `IN_PROJECT` mode: routes a user message to the right specialist (`diagnostician`, `analyst`, `observer`, generalist) based on content cues.

### 3.2 `executor/`

#### `specialist-executor.ts` — `executeSpecialistTurn(params)`

One LLM turn. Streams via the `LLMStreamClient` interface:

1. Emit `specialist` SSE event (banner) before any text.
2. Pump LLM stream chunks, emitting `text_delta` for tokens.
3. On `tool_call_end`:
   - **Client-side tool** (`isClientSideTool(name)`): emit `tool_call` + `done`, return `awaiting_tool_result`. Stream stops here.
   - **Server-side tool**: validate input against the tool's JSON Schema, run the executor with a 30 s timeout, emit `tool_result`, return `tool_executed`.
4. On `response_end`: emit `done`, return `completed`.

Activity events (`ActivityEmitter`) provide UI breadcrumbs ("Thinking…", "Running search_docs…", "Response ready") between large gaps.

#### `multi-turn-executor.ts` — `executeMultiTurn(params)`

Wraps `executeSpecialistTurn` in the tool loop. After a server-side tool executes, appends the result as a tool message and re-invokes the LLM. Loop terminates when:

- `completed` (LLM responds without further tool calls)
- `awaiting_tool_result` (LLM called a client-side tool)
- `error` (executor or LLM failure)
- `guard_tripped` (max turns, stall, loop, timeout — see `executor-guards.ts`)

Retriable LLM errors (rate limit, transient 5xx) are retried with backoff (`MAX_RETRIABLE_RETRIES = 2`, base 500 ms, rate-limit wait 5 s).

#### `executor-guards.ts`

Per-turn `ExecutorGuards` instance: tracks reinvocation count, stall windows, and cumulative time. Guards check before each LLM call, not after, so a runaway is caught before the next round-trip.

#### `content-block-resolver.ts`

Resolves `ArchContentBlock` references (e.g. file IDs) into `ProviderContentBlock[]` for the LLM. Handles text + image multimodal preambles; images are inlined as base64 with type validation.

#### `tool-validator.ts`

Pre-execution JSON Schema validation of tool inputs. Catches the most common LLM mistakes (missing required fields, wrong primitive types) without taking on `ajv` as a dependency. Returns an error tool result so the LLM can self-correct on the next turn.

### 3.3 `session/`

#### `session-service.ts` — `SessionService`

Thin Mongoose-backed service. Constructor takes the model via dependency injection (testability). Operations:

- `getOrCreate({ tenantId, userId, projectId? })` — returns the resumable session (`IDLE`/`ACTIVE`) or creates a new one.
- `transition(session, targetState)` — atomic via `findOneAndUpdate` with the precondition in the filter (no read-then-write race).
- `archive(session)` — manual cleanup; cascade delete of journal entries deferred to `CC-F01`.
- CRUD over `messages[]` with `$slice` enforcing `MAX_STORED_MESSAGES = 200` (sliding window).

#### `checkpoint-service.ts`

Snapshots session metadata at decision points (specification complete, topology approved, agent approved). `rollbackFromCheckpoint` is used by the LARGE-scope backtrack to preserve user-facing artifacts that survive a topology edit.

#### `file-store-service.ts`

GridFS-backed file persistence. Server-only deps (`mongoose`, `async_hooks`) — **not re-exported from the main barrel** to keep client bundles clean. Import directly from `@agent-platform/arch-ai/session` in server code.

#### `learning-memory-service.ts` / `project-memory-service.ts`

Cross-session memory. `ProjectMemoryService` holds project-scoped facts; `learning-memory` records "what worked / what didn't" for future onboarding sessions.

#### `resume-summary.ts` / `resume-snapshot.ts`

On session resume, builds a structured `ResumeSnapshot` (last specialist, pending interaction, last decision) so the UI can render an accurate "where we left off" banner without replaying the whole transcript.

### 3.4 `spec-document/`

`SpecDocumentService` maintains a per-project markdown specification document — the durable, human-readable artifact that survives long after a session is archived. `V1_EDITABLE_PATHS` and `SPEC_TO_SESSION_FIELD_MAP` define which document paths are user-editable and how they map back to `SessionMetadata`. `validateEditablePath` enforces the boundary so a malicious or buggy edit can't rewrite system fields.

`renderMarkdown` is the canonical Markdown renderer for the spec document; consumers should not roll their own.

### 3.5 `journal/`

Append-only typed event log. Five record types (CC-F01):

| Type           | Captures                                                                |
| -------------- | ----------------------------------------------------------------------- |
| `decision`     | Specification answers, design choices                                   |
| `consultation` | Specialist-to-specialist hand-offs                                      |
| `mutation`     | Field changes with `from`/`to` and rationale                            |
| `validation`   | Pass/fail audit results triggered by a specialist or the user           |
| `analysis`     | Diagnostic findings + fix outcome (root-cause-driven, not symptom-only) |

Status transitions only (`active` → `superseded` / `archived` / `invalidated`). Content is never mutated.

### 3.6 `audit/`

`AuditLogEmitter` — operational/security log surface separate from the journal. Emits structured entries with category/severity tokens; consumed by the runtime audit sink. The journal is _domain_ history; the audit log is _system_ history.

### 3.7 `streaming/`

#### Event protocol

Twelve typed SSE events under `types/sse-events.ts`, each with a Zod schema:

`specialist`, `text_delta`, `tool_call`, `tool_result`, `done`, `activity`, `file_processed`, `file_error`, `file_context_change`, `suggestion`, `quality_floor`, `build_*` (start/stage/compiled/enriched/error/diagnostics).

The discriminated union `ArchSSEEvent` is the contract; `ArchSSEEventSchema` validates inbound events on the client.

#### Serializer / parser

`serializeSSEEvent`, `createSSETransformStream`, `createSSEStream` produce the wire format. `parseSSEChunk` / `parseSSEStream` consume it. The Studio `useArchChat` hook is a thin React shim over `parseSSEStream`.

#### `ActivityEmitter`

Stateful helper that tracks activity IDs per turn so the UI can correlate a "Running search_docs…" with its eventual "search_docs complete".

### 3.8 `tools/`

JSON Schema tool definitions handed to the LLM. Three exports:

- `INTERVIEW_TOOLS` — minimum viable set for INTERVIEW phase
- `PROCEED_TO_NEXT_PHASE_TOOL` — the explicit `proceed_to_next_phase` tool the coordinator advertises only when exit criteria are satisfied
- `PLATFORM_CONTEXT_TOOL` — read-only platform introspection (limits, available constructs)

Schemas under `tools/schemas/in-project-schemas.ts` cover the `IN_PROJECT` specialist surfaces.

### 3.9 `knowledge/`

35+ `KnowledgeCard`s under `knowledge/cards/` covering ABL constructs (gather, handoff, flow, tools, behavior profiles, hooks, memory, guardrails, observers, …) and workflows (channel-voice, entity-collection, testing-eval, observer-patterns, …).

`selectKnowledgeCards(query, capabilities)` is the selector — picks the smallest relevant card set for the prompt budget. `PLATFORM_LIMITS_CARD` is always included so the LLM never invents a limit.

### 3.10 `diagnostics/`

Pure rules engine. `runDiagnostics(context)` executes every registered rule against an agent/topology/spec snapshot and returns a `DiagnosticReport` of typed `Finding`s grouped into `DiagnosticSection`s. Each finding carries severity, category, optional `architecturePattern` / `antiPattern`, and zero or more `FixSuggestion`s — including `getFixTemplate` for one-click apply.

Used by:

- `diagnostician` specialist (in-project) on user-initiated audits
- BUILD-phase post-compile analysis
- Validation journal entries when a fix is applied

### 3.11 `generation/`

The ABL pipeline: turn an agent skeleton into a compilable `agent.yaml`.

```
buildSkeleton(spec) → validatePreCompile → autoFixABL → processGeneratedABL
```

Each stage is a pure function over `ABLAgentContext`. `processGeneratedABL` is the convenience wrapper that runs the full pipeline and emits a `PipelineResult` (success + diagnostics, or failure + actionable issues).

### 3.12 `mock-server/`

Given a set of compiled agents, `extractAllTools` walks the topology to collect every external tool reference, and `generateMockServerArtifacts` produces a runnable mock server scaffold (handlers, schemas, OpenAPI). The mock server lets users test their agent end-to-end before wiring real integrations.

### 3.13 `prompts/`

`composeSystemPrompt(specialist, phase, context)` and `composeInProjectPrompt(specialist, projectContext)` are the two entry points. Internally:

1. Load base prompt fragments (`prompts/base.ts`)
2. Layer in the per-specialist prompt
3. Layer in the per-phase modifier
4. Append the formatted context section (page context, files, knowledge cards, referenced entities)

`ABL_CONSTRUCT_EXPERT_SYNTAX` is the canonical ABL grammar reference embedded in the `abl-construct-expert` prompt. `BUILD_NARRATION_PROMPT` is the per-agent narration template emitted during BUILD streaming.

---

## 4. Data Flows

### 4.1 User Turn (ONBOARDING)

```
User → POST /api/arch-ai/chat
         ↓
       Runtime SSE handler
         ↓
       SessionService.getOrCreate → ArchSession
         ↓
       resolveMode() + getSpecialistForPhase(phase)
         ↓
       getToolsForPhase(phase) → tool list
         ↓
       composeSystemPrompt(specialist, phase, context)
         ↓
       executeMultiTurn({ specialist, tools, toolExecutors, llmClient, onEvent })
         ↓        ↑
         │     LLMStreamClient.streamChat (provider-agnostic)
         ↓
       SSE events (specialist, text_delta, tool_call, tool_result, done, …)
         ↓
       Studio useArchChat → React state → widgets
```

After a turn completes, the runtime appends the user/assistant messages, evaluates `checkExitCriteria(session)`, and if satisfied advertises `PROCEED_TO_NEXT_PHASE_TOOL` on the next turn so the LLM can request advancement (the coordinator validates and executes the actual transition).

### 4.2 Client-Side Tool (`ask_user`)

```
LLM → tool_call_end (ask_user) → executor detects client-side
                                     ↓
                                 emit tool_call → emit done → return awaiting_tool_result
                                     ↓
                                 SessionService persists pendingInteraction
                                     ↓
                                 Studio renders widget (renderer.tsx)
                                     ↓
                                 User answers → POST /api/arch-ai/resume
                                     ↓
                                 specialist-executor.resume({ toolCallId, toolResult })
                                     ↓
                                 multi-turn loop continues
```

### 4.3 BUILD Phase Gate Loop

```
BUILD enters with approved topology
   ↓
pickNextGate({ topology, files, approvedAgents })
   ↓
 ┌──────────────────┬──────────────────┬─────────────┐
 │       next       │ needs_generation │  all_done   │
 │       ↓          │       ↓          │      ↓      │
 │ emit agent_review│ call LLM to      │ advance to  │
 │ user approves    │ generate next    │ TOOLS / mock│
 │ ↓                │ batch of agents  │ server      │
 │ approve in meta  │ ↓                │             │
 │ ↓                │ files updated    │             │
 │ pickNextGate ...  │ → pickNextGate  │             │
 └──────────────────┴──────────────────┴─────────────┘
```

LARGE-scope mutation during BUILD:

```
classifyMutationScope(message) === 'LARGE'
    ↓
transitionPhase(BUILD → BLUEPRINT)   ← only legal backward edge
    ↓
multi-agent-architect re-plans → new topology
    ↓
diffTopologyAgainstBuildState → { preserve, regenerate, remove }
    ↓
checkpoint rollback (preserve approved files for unchanged agents)
    ↓
transitionPhase(BLUEPRINT → BUILD) → resume gate loop
```

### 4.4 Diagnostics (IN_PROJECT)

```
User: "audit my agent"
    ↓
content-router → diagnostician
    ↓
runDiagnostics({ agent, topology, spec, capabilities })
    ↓
DiagnosticReport (sections + findings + fixes)
    ↓
Specialist narrates findings, offers fix templates
    ↓
User accepts → mutation tool → JournalService.append({ type: 'mutation' })
    ↓
runDiagnostics again → validation journal entry (pass/fail)
```

---

## 5. Persistence Model

| Collection            | Owner                                                           | Purpose                                                         |
| --------------------- | --------------------------------------------------------------- | --------------------------------------------------------------- |
| `arch_sessions`       | `@agent-platform/database` (model) + `SessionService` (service) | Live session state, sliding-window messages, pendingInteraction |
| `arch_journal`        | `JournalService`                                                | Append-only typed events                                        |
| `arch_spec_documents` | `SpecDocumentService`                                           | Project-scoped markdown specifications                          |
| `arch_files` (GridFS) | `FileStoreService`                                              | User-uploaded files referenced by `ArchContentBlock`            |
| `arch_audit_log`      | `AuditLogEmitter` (sink in runtime)                             | Operational/security entries                                    |

All collections use the shared **tenant-isolation plugin** from `@agent-platform/database`. Every query scopes by `tenantId` (and `projectId` when applicable). Cross-tenant access returns 404 by design.

**Atomic transitions.** State and phase changes go through `findOneAndUpdate` with the precondition in the filter, never read-then-write. Two clients racing the same transition see one success and one well-typed `InvalidTransitionError`.

**Sliding window on `messages[]`.** `MAX_STORED_MESSAGES = 200`. The `$slice` projection trims older messages on append; the spec document and journal hold long-term history.

---

## 6. Public API Contract

The package exports a curated barrel from `src/index.ts`. Consumers import from `@agent-platform/arch-ai` (and a few sub-paths: `/types`, `/session`, `/executor`, `/streaming`, `/streaming/client`, `/generation`).

### Surface groups

- **Types & errors** — `ArchPhase`, `ArchSession`, `SessionState`, `MessageRequest`, all error classes
- **Coordinator** — `transitionPhase`, `getSpecialistForPhase`, `checkExitCriteria`, `validateStateTransition`, `classifyMutationScope`, `LoopDetector`, `pickNextGate`, `diffTopologyAgainstBuildState`, `synthesize{Default,Pattern}Topology`
- **Tool filtering** — `PHASE_TOOL_MAP`, `getToolsForPhase`, `IN_PROJECT_TOOLS`, `isClientSideTool`
- **Session** — `SessionService`, `ProjectMemoryService`, `buildResumeSummary`, `buildResumeSnapshot`, checkpoint helpers
- **Spec document** — `SpecDocumentService`, `renderSpecMarkdown`, editable-path helpers
- **Journal** — `JournalService` and the typed content unions
- **Audit** — `AuditLogEmitter`, categories/severities
- **Schemas** — `MessageRequestSchema`, `ArchSSEEventSchema`, `SpecificationSchema`, `BlueprintOutputSchema`, …
- **Streaming** — `serializeSSEEvent`, `parseSSEStream`, `ActivityEmitter`, `createSSEStream`
- **Executor** — `executeSpecialistTurn`, `executeMultiTurn`, `resolveContentBlocks`, multimodal helpers
- **Prompts** — `composeSystemPrompt`, `composeInProjectPrompt`, `ABL_CONSTRUCT_EXPERT_SYNTAX`
- **Tools** — `INTERVIEW_TOOLS`, `PROCEED_TO_NEXT_PHASE_TOOL`, `PLATFORM_CONTEXT_TOOL`
- **Knowledge** — `selectKnowledgeCards`, `PLATFORM_LIMITS_CARD`
- **Diagnostics** — `runDiagnostics`, `getRule`, `getFixTemplate`
- **Generation** — `buildSkeleton`, `validatePreCompile`, `autoFixABL`, `processGeneratedABL`
- **Mock server** — `extractAllTools`, `generateMockServerArtifacts`

### What is intentionally **not** exported

- `FileStoreService` and `createFileStoreService` are server-only (mongoose, async_hooks). Import them from `@agent-platform/arch-ai/session` in server code; never from the root barrel.
- Private prompt assembly internals (`base.ts`, per-specialist files) — go through `composeSystemPrompt`.
- Per-rule diagnostic implementations — go through `getRule` / `runDiagnostics`.

---

## 7. Extension Points

| Extension           | How                                                                                                                                                                                                          |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| New specialist      | Add prompt under `prompts/specialists/`, add ID to `SPECIALIST_IDS` or `IN_PROJECT_SPECIALIST_IDS`, register tools in `PHASE_TOOL_MAP` or `IN_PROJECT_TOOLS`, add display banner in `specialist-executor.ts` |
| New tool            | Add JSON Schema to `tools/definitions.ts`, register executor in the runtime's `toolExecutors`, declare client-side via `CLIENT_SIDE_TOOLS` if applicable                                                     |
| New SSE event       | Add Zod schema to `types/sse-events.ts`, extend `ArchSSEEvent` union, emit via `onEvent`                                                                                                                     |
| New diagnostic rule | Register under `diagnostics/` (rule entry + validator + fix template)                                                                                                                                        |
| New knowledge card  | Add file under `knowledge/cards/`, ensure selector picks it up via `selectKnowledgeCards`                                                                                                                    |
| New phase           | High-impact change — extend `ARCH_PHASES`, `PHASE_CONFIG`, `VALID_TRANSITIONS`, `PHASE_TOOL_MAP`, exit criteria, prompts. Coordinator-side only; LLM never decides advancement                               |
| New LLM provider    | Implement `LLMStreamClient` outside this package; the executor is provider-agnostic                                                                                                                          |

---

## 8. Design Principles (cross-cutting)

1. **Coordinator decides; LLM speaks.** Every irreversible action — phase advance, state transition, mutation persistence — goes through a typed function in this package. The LLM proposes; the coordinator decides.
2. **Pure functions over session metadata.** Phase machine, state machine, scope classifier, build-gate queue, topology diff — all pure. Easy to test, impossible to surprise.
3. **No hidden state.** Build-gate queue derives from `(topology, files, approvedAgents)` on every call. No persistent queue collection to drift out of sync.
4. **Append-only history.** Journal entries supersede; they don't mutate. Reconstructable timeline.
5. **Fail typed.** Six dedicated error classes (`InvalidTransitionError`, `ExitCriteriaNotMetError`, `SessionBusyError`, `LoopDetectedError`, …) so the API can return precise status codes without parsing strings.
6. **Bounded everything.** Every Map/Set has a documented cap (`MAX_AGENTS_PER_TOPOLOGY = 256`, `MAX_STORED_MESSAGES = 200`, `MAX_FILES = 10`). No unbounded collections.
7. **Surface-agnostic.** Zero HTTP, zero React. Anything that mounts the package on a transport lives in `apps/`.

---

## 9. Where to look next

- **Contracts** — `docs/arch/contracts/` (source of truth for behavior)
- **Build status** — `packages/arch-ai/DEV-STATUS.md`
- **Deferred items & deviations** — `packages/arch-ai/DEFERRED.md`
- **Per-feature review notes** — `packages/arch-ai/dev-review/`
- **Package learnings** — `packages/arch-ai/agents.md` (read before modifying)
- **Frontend architecture** — `docs/arch/08-frontend-architecture.md`
- **Project creation walkthrough** — `docs/arch/06-project-creation-walkthrough.md`

---

_Last updated: 2026-05-07. Maintained alongside `presentations/architecture.html`. Keep both in sync when adding subsystems or changing public exports._
