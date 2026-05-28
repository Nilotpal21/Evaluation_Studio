# Arch-AI Blueprint Document — Design Specification

**Status:** Draft for review (revision 2 — incorporates 11 P0/P1/P2 review findings)
**Date:** 2026-05-12 (rev 2; original draft 2026-05-11)
**Owner:** Sriharsha Nalluri
**Branch:** `zarch/eval-round2-v2`
**Supersedes:** Bare-topology Blueprint design in arch-ai v4 (current `apps/studio/src/lib/arch-ai/blueprint-flow.ts`)
**Related specs:**

- `docs/superpowers/specs/2026-04-01-arch-project-creation-flow-design.md` (v0.3 onboarding flow)
- `docs/superpowers/specs/2026-04-17-arch-ai-orchestration-redesign-design.md` (orchestration rebuild)

**Memory references:**

- `memory/arch-v4-pending-items.md` (current v4 status)
- `memory/feedback-arch-source-of-truth.md` (runtime is source of truth)
- `memory/abl-when-cel-rules.md` (CEL grammar invariants)

## Revision 2 — corrections from review

| ID        | Finding                                                                                    | Correction                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **P0-1**  | "Dormant schema activation" framing was overstated — existing schema is thin               | Reframed as "v2 major schema replacement" in §2.4                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **P0-2**  | `PerAgentSpec` had several IR mismatches                                                   | Reframed §8.7 as a **Blueprint authoring schema that compiles to IR**, not an exact IR mirror. Runtime-facing sub-shapes now follow `schema.ts` where the blueprint stores runtime-ready values: `systemPrompt: SystemPromptConfig`, memory `access: 'readwrite'`, `Constraint.severity: 'error'\|'warning'`, `Constraint.kind: 'require'\|'limit'\|'restrict'`, `ConstraintCheckpoint` structured, `CompletionCondition.store: string`, `ErrorHandler.retry: number`, `ErrorHandler.then` REQUIRED, `RememberTrigger.ttl: string`, `RecallAction` discriminated union; new `ErrorHandlerSchema` |
| **P0-3**  | DB indexes missing `tenantId` in compound unique constraints                               | All compound indexes now lead with `tenantId`; §11.1 rewritten with rationale                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **P0-4**  | "Paired writes" required a lossless DSL→Blueprint reverse mapper that doesn't exist        | Replaced with **blueprint-only canonical edits** (§13.2) — writes flow one direction (blueprint → DSL via renderer); raw-DSL writes disabled in v2-canonical mode                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **P0-5**  | Bulk path drift acknowledgment contradicted single source of truth                         | Bulk path **disabled in v2-canonical mode**; explicit per-project `manual-drift mode` escape hatch (§13.9) toggles between strict canonical and freeform DSL                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **P1-6**  | Local-edit guard relied on `lastEditedBy/lastEditedAt` not currently set by mutation paths | Guard uses `updatedAt` AND `sourceHash` comparison authoritatively (§13.3); provenance fields are informational only                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **P1-7**  | `AgentVersion` writes were marked "verify; add if missing"                                 | Now **REQUIRED** for every mutation path (§13.8); new acceptance criterion in §18.3                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| **P1-8**  | Non-HTTP tool support was assumed to be a renderer concern                                 | v1 tool bootstrap supports `'http'` only (§8.10); non-HTTP refs allowed only when pointing to existing Project Tool by `id`; v1.5 milestone widens (§16.2)                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **P2-9**  | Golden-corpus fixtures were hand-wavy                                                      | Now a **Phase 0 deliverable** that gates phase exit (§14.2 step 11; §20.3 rewritten); 5 fixtures (2 reference + 3 synthetic) with manually authored structured input JSON + expected MD outputs                                                                                                                                                                                                                                                                                                                                                                                                  |
| **P2-10** | Scope/timeline numbers inconsistent (60-95 vs 55-80 commits)                               | Single canonical estimate: **60–95 commits, 22–28 PRs over ~10–14 weeks**; §16.1 reconciles with §14.9                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **+**     | Validation rules expanded for IR-aligned constraints + canonical-mode invariants           | New rules **BV-021 through BV-030** in §8.14                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Problem Statement](#2-problem-statement)
3. [Architectural Direction](#3-architectural-direction)
4. [Today's Flow (Baseline Analysis)](#4-todays-flow-baseline-analysis)
5. [Proposed Architecture (Target State)](#5-proposed-architecture-target-state)
6. [The 4-Stage BLUEPRINT Phase](#6-the-4-stage-blueprint-phase)
7. [The Canonical Blueprint Spine](#7-the-canonical-blueprint-spine)
8. [The BlueprintOutput Schema (v2.0)](#8-the-blueprintoutput-schema-v20)
9. [The BUILD Compiler (Variant 3 — Pure Renderer)](#9-the-build-compiler-variant-3--pure-renderer)
10. [12-Layer LLM Hallucination Defense](#10-12-layer-llm-hallucination-defense)
11. [Persistence, Lifecycle, Project Linkage, Versioning](#11-persistence-lifecycle-project-linkage-versioning)
12. [Artifact Panel Display & Edit Affordances](#12-artifact-panel-display--edit-affordances)
13. [In-Project Mode Integration](#13-in-project-mode-integration)
14. [Migration Path](#14-migration-path)
15. [Audit Findings & Corrections](#15-audit-findings--corrections)
16. [Scope: v1 / v2 / Out-of-Scope](#16-scope-v1--v2--out-of-scope)
17. [Open Questions for LLD](#17-open-questions-for-lld)
18. [Acceptance Criteria](#18-acceptance-criteria)
19. [Risk Register](#19-risk-register)
20. [Appendix](#20-appendix)

---

## 1. Executive Summary

The arch-ai BLUEPRINT phase today produces an ephemeral chat narrative (`## Pattern / ## Agents / ## Flow / ## Tradeoffs`) and a bare structured topology (`{agents, edges, entryPoint}` — 9 fields total). A thin `BlueprintOutputSchema` exists at `packages/arch-ai/src/types/blueprint.ts:111-122`, but it is not written by the v4 Studio Blueprint flow and is far too small to drive deterministic BUILD. The BUILD phase compensates by having an LLM worker per agent that reconstructs ~24 decisions per agent (persona, tools, gather, constraints, guardrails, FLOW, COMPLETE, MEMORY, ON_ERROR, handoff CONTEXT), partly via deterministic helpers and partly via parallel LLM workers that drift on tone, gather field names, condition expressions, and tool signatures. The 11 reactive layers in BUILD (fix loops, false-error recovery, regression detection, normalization, cross-agent validation) exist because the Blueprint contract is incomplete.

**This design replaces that thin v1-style shape with a load-bearing `BlueprintOutput` v2.0 contract** — a rich 17-section markdown deliverable backed by structured data that can compile to runtime IR — and **collapses BUILD's non-determinism by turning it into a pure deterministic renderer with zero LLM calls**. All creative LLM work moves into a 4-stage BLUEPRINT phase (Classify → Decide Architecture → Plan Sections → Fill Sections) with per-section approval gates, structured-output schema enforcement, multi-layer validation, and section-by-section iteration on a live MD doc rendered in the artifact panel.

**Outcomes:**

- Blueprint becomes the project's persistent, navigable, project-owned artifact (matches references like `lastminute_blueprint_v2.md` and `Lumen_Agentic_Billing_Platform_Blueprint_v1.1.md` in scope and depth)
- BUILD time drops from 30s–5min to 2–10s; failure rate drops from 15–40% to <5%
- ~11 reactive layers (~2000 LOC) deletable from BUILD; replaced by 4 morphed/moved layers + 6 new small-surface layers
- Single source of truth (`BlueprintOutput`) eliminates drift between Blueprint narrative, structured topology, and generated agent files
- User iterates in BLUEPRINT (cheap, high-leverage) instead of BUILD (LLM-dependent, error-prone)
- Section-by-section approval surface lets user lock decisions incrementally, with full diff history per version

---

## 2. Problem Statement

### 2.1 What the user sees today

In the current arch-ai v4 BLUEPRINT phase, the LLM emits a free-form markdown narrative to chat — sections `## Pattern`, `## Agents`, `## Flow`, `## Tradeoffs`. The user reviews this in chat, approves the topology via a widget, and proceeds to BUILD. The narrative dies in the chat scroll. The artifact panel shows a topology graph (`TopologyPanel`) and a few other tabs, but nothing that resembles the rich, SE-deliverable-grade blueprint documents that real customer engagements produce.

Compare the chat-narrative output to two real reference blueprints:

- `lastminute_blueprint_v2.md` — 1146 lines, 17 sections (Executive Summary, Why-This-Should-Win, Platform Config, Topology, Solution Architecture, Call Control, System Prompts, Knowledge, I/O, Tools, Memory, Decision Logic, Multi-Agent Relationships, Guardrails, Error Handling, Eval/QA, Demo Script, Configuration Checklist)
- `Lumen_Agentic_Billing_Platform_Blueprint_v1.1.md` — 1138 lines, same 17-section structure

These references mix tables (config), ASCII diagrams (topology + flow), code blocks (prompts + Script Node JS), prose (rationale + scripts). They're load-bearing deliverables — used by executive sponsors to approve, technical SMEs to validate, build engineers to configure. Arch-ai today produces nothing comparable.

### 2.2 What BUILD has to compensate for

Because BLUEPRINT locks only 9 fields per agent (4 fields × N agents + 4 fields × M edges + 1 entry point + a free-text `blueprintContextSummary`), the downstream BUILD phase must rebuild ~24 decisions per agent. These split roughly evenly:

**Deterministic helpers (currently in BUILD):**

- `computeArchitecturePlans` (`packages/arch-ai/src/planning/agent-architecture-planner.ts:40-113`) — archetype, keyword, gather requirements, complete requirements, complexity, flow recommendations, handoff structure, return-field seeds, history hints, return-contract hints, catch-all flags
- `getModelRecommendation` — per-agent model assignment
- `classifyDataSensitivity` — PII/PCI/PHI classification per agent
- `extractDomainFromSession` — domain, channels, language, compliance, integrations, tone

**LLM creative output (per-agent worker in BUILD):**

- PERSONA prose (`apps/studio/src/lib/arch-ai/build-parallel-gen.ts:1086-1097`)
- GATHER field names and prompts (LLM uses inference templates as seeds but can override)
- GUARDRAILS blocks (LLM emits ad-hoc; only `content_safety` is mandatory floor)
- CONSTRAINTS expressions (free prose validated only as basic syntax)
- FLOW step bodies (RESPOND/CALL/SET/TRANSFORM/REASONING blocks)
- COMPLETE WHEN expressions (LLM writes referencing GATHER fields it just invented)
- HANDOFF `CONTEXT.pass` / `CONTEXT.summary` / `history` choices per target
- ON_RETURN.map field selection
- ON_ERROR recovery prose
- Tool signatures (when not given real Project Tool entries)

This split creates **silent overrides**: `executionMode` set by the LLM in BLUEPRINT is later overridden by `computeComplexityPlan` using different signals. Two decisions, no rationale exposed, no user visibility into the disagreement.

### 2.3 Why the reactive layers exist

BUILD has 16 reactive layers catching errors from this design:

1. Source normalization auto-rewrite (`build-source-normalization.ts:197-268`) — fixes bare-identifier MEMORY paths
2. Quality enrichment (`quality-enrichment.ts:140-212`) — auto-injects missing GUARDRAILS/MEMORY/ON_ERROR sections the LLM omitted
3. Per-worker compile-fix loop (`build-parallel-gen.ts:1239-1496`) — re-prompts LLM with compiler errors, up to `DEFAULT_BUILD_FIX_MAX_ROUNDS=3`
4. HANDOFF regression detector (`build-parallel-gen.ts:219-246`) — catches fix-loop deleting required `HANDOFF TO:` rules under pressure
5. "LLM never called generate_agent" detector — 40% of historical failures
6. Worker retry loop (`build-parallel-gen.ts:2603-2733`) — `AGENT_MAX_RETRIES=2` (3 total attempts)
7. Structural-diagnostic non-retry classifier (`build-retry-policy.ts:6, 35-63`) — blocks blind retry on CO-02, CO-03, H-05
8. Cross-agent topology validator (`cross-agent-validator.ts:33-136`) — dangling HANDOFF targets, orphans, missing returns
9. Topology-aware placeholder validation (`build-orchestrator.ts:140-147, 303-333`)
10. Pre-spawn architecture-plan blocker — rejects impossible topologies
11. Reconciliation + targeted-repair re-spawn (`build-parallel-gen.ts:2370-2501`)
12. Server-side blocking-pattern detector (`build-result-reconciliation.ts:96-119`) — placeholder leftovers like `gathered_detail`, `{{question_to_collect_this_field}}`
13. `recoverFalseErrors` (`build-orchestrator.ts:434-492`)
14. Warning classification (`build-completion.ts:40-77`)
15. Scaffold path Ring 2 — per-slot validators + per-slot retry + fallback defaults
16. Tool-bootstrap synthesizer silent-skip of non-HTTP types

Worst case per agent today: 3 worker attempts × 3 fix rounds = 9 LLM calls + retry feedback = up to ~12 LLM calls per agent. Build time 30s–5min per attempt. Failure rate observed at 15–40%.

### 2.4 The structural insight

`BlueprintOutputSchema` at `packages/arch-ai/src/types/blueprint.ts:122` exists today with a thin shape: `AgentSpecSchema` carries `role`, `model`, `persona`, `tools`, `gathers`, `handoffs`, `constraints`, `guardrails`. The v4 Studio Blueprint flow doesn't write to it — only the bare topology slice is persisted. The slot exists but the contract it represents is far thinner than what BUILD needs to be deterministic.

**This is a major schema replacement, not an "activation."** The proposed `BlueprintOutput` v2.0 is a substantially different and richer contract — every runtime-facing `PerAgentSpec` field must compile cleanly to runtime IR (see §8.7), `governance` and `integrations` get full sub-shapes, and version-aware migration is a first-class concern. Today's v1 schema is unused (zero records written); migration is forward-looking insurance, not an active backfill of v1 data — but the v1 → v2 contract change is real, and the implementation must treat it as such.

---

## 3. Architectural Direction

### 3.1 The three load-bearing claims

1. **Blueprint is the design crucible.** All creative LLM work happens during BLUEPRINT, where decisions are iteratively refined with per-section approval gates, structured-output schema enforcement, and user review. Heavy lifting + full project scope iteration happens here.

2. **BUILD is a pure deterministic renderer.** Takes a locked `BlueprintOutput`, walks structured fields, emits ABL DSL strings via 13 pure renderer functions. Zero LLM calls. Runs in 2–10s. If a compile fails, that's a renderer bug, not a user error.

3. **The MD doc is rendered, never stored.** Source of truth is the structured `BlueprintOutput` document in Mongo. The 17-section markdown deliverable is produced by `renderMarkdown(BlueprintOutput)` on read — same pattern as `packages/arch-ai/src/spec-document/markdown-renderer.ts`.

### 3.2 The single source of truth

```
                   ┌──────────────────────────────────────┐
                   │                                       │
INTERVIEW ─────►  ┌─┴─────────────────────────────────────┴─┐
(spec fields)    │           BlueprintOutput v2.0             │
                 │      (Mongo: arch_blueprints)              │
BLUEPRINT ─────► │  ┌──────────────────────────────────────┐ │
(LLM + valid.)   │  │ topology  : {agents, edges, entry}   │ │
                 │  │ perAgent  : { ...full IR fields }    │ │
                 │  │ governance: { ...shared config }     │ │
                 │  │ integrations: { tools, search, etc }  │ │
                 │  │ buildOrder: [...] (Kahn topo sort)    │ │
                 │  │ assumptions: [...]                    │ │
                 │  │ complexity: ComplexityProfile         │ │
                 │  │ architecture: ArchitectureDecisions   │ │
                 │  │ sectionPlan: SectionPlan              │ │
                 │  │ sectionApprovals: {...}               │ │
                 │  │ validation: {...}                     │ │
                 │  │ status: draft | locked | linked       │ │
                 │  │ version: number                       │ │
                 │  │ projectId? (linked at CREATE)         │ │
                 │  └──────────────────────────────────────┘ │
                 └─┬─────────────────┬───────────────────┬───┘
                   │                 │                   │
       renderMarkdown()      compileToAbl()      finalizeProject()
       (read-time)           (BUILD)             (CREATE)
                   │                 │                   │
                   ▼                 ▼                   ▼
        ┌──────────────────┐ ┌──────────────┐  ┌──────────────────┐
        │  17-section MD   │ │ agent.yaml   │  │  projects/       │
        │  doc (rendered)  │ │ per agent    │  │  agents/         │
        │ in artifact panel│ │ pure deter-  │  │  Project Tools/  │
        │                  │ │ ministic     │  │  journal/        │
        │ Sticky ToC +     │ │ Sanity       │  │  spec-doc linked │
        │ section anchors  │ │ compile only │  │                  │
        └──────────────────┘ └──────────────┘  └──────────────────┘
```

The MD doc is **never stored** — derived from `BlueprintOutput` on every read. The ABL DSL strings are **never edited by hand** — derived from `BlueprintOutput` on every BUILD. Project records are **derived once** at CREATE from the locked `BlueprintOutput`.

### 3.3 Why this is better than today

| Today                                                                         | Proposed                                                                                                               |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Blueprint locks 9 fields per agent; BUILD reconstructs 24                     | Blueprint locks all 33+ fields per agent; BUILD just renders                                                           |
| LLM in BUILD: ~12 calls worst case per agent                                  | LLM in BUILD: 0 calls                                                                                                  |
| 16 reactive layers compensating for design gap                                | 12 defense layers preventing errors upstream                                                                           |
| Build time: 30s–5min per attempt                                              | Build time: 2–10s total                                                                                                |
| Build failure rate: 15–40%                                                    | Build failure rate: <5% (renderer bugs only)                                                                           |
| Errors caught at end (compile failure)                                        | Errors caught per-section as user iterates                                                                             |
| User sees status only at BUILD complete                                       | User sees status per section approval                                                                                  |
| Blueprint = ephemeral chat                                                    | Blueprint = persistent MD artifact (matches references)                                                                |
| Single source of truth: none (drift between topology, narrative, agent files) | Single source of truth: `BlueprintOutput`                                                                              |
| Cost per build (today): ~$0.40–$2.00 (GPT-4o, 4 agents, with retries)         | Cost per build (renderer + section LLM calls): ~$0.08–$0.20 (mostly Haiku-class section calls in BLUEPRINT, not BUILD) |

---

## 4. Today's Flow (Baseline Analysis)

### 4.1 Phase machine (existing)

Reference: `packages/arch-ai/src/coordinator/phase-machine.ts:30-76`

```
INTERVIEW → BLUEPRINT → BUILD → CREATE
                ↑          ↓
                └──────────┘  (BUILD→BLUEPRINT backtrack on topology change)
```

Strict forward transitions with one revertible edge (`phase-machine.ts:84-89`). Coordinator (not LLM) evaluates `exitCriteria` per turn (lines 36-63). Each phase has one specialist (lines 32, 37, 46, 69), but only INTERVIEW/BLUEPRINT/BUILD invoke the LLM — CREATE is fully deterministic.

### 4.2 INTERVIEW (specialist: `onboarding`)

**Locks:** 6-field `Specification` (`packages/arch-ai/src/types/specification.ts:48-60`): `projectName` (only required), `description`, `channels`, `language`, `uploadedFiles`, `conversationNotes[]`. Everything else (compliance, integrations, SLA, escalation) ends up as freeform `conversationNotes[]` strings keyword-matched downstream.

**Exit criterion:** `canExitInterview(spec)` returns `true` when `spec.projectName.trim().length > 0`. One field.

**Persisted:** `arch_sessions.metadata.specification` + spec document via `specDocumentService` + file uploads to GridFS via `fileStoreService` + journal entries.

### 4.3 BLUEPRINT (specialist: `multi-agent-architect`)

**Locks:** Bare topology only — `topology.agents[]` (4 fields each: `name`, `role`, `executionMode`, `description`), `topology.edges[]` (4 fields each: `from`, `to`, `type`, `condition`), `topology.entryPoint`. Plus a scraped `blueprintContextSummary` string from the last assistant message.

**Validations applied (`blueprint-tools.ts:84-129`):**

1. `entryPoint` must be in `agents[]`
2. Edge `from`/`to` must reference declared agents
3. `computeBuildOrder` (Kahn) must succeed unless `allowCycle: true` per edge

**Sub-stages** (`apps/studio/src/lib/arch-ai/blueprint-flow.ts:83-94`): `concept_ready → draft_generating → draft_ready → revising → topology_locked`

**Exit criterion:** `metadata.topologyApproved === true` (`phase-machine.ts:38-43`). Coordinator forces this via `lockDraftTopology` (`process-message.ts:545-562, 952-1011`) only when user clicks accept.

**Synthesis fallback** (`packages/arch-ai/src/coordinator/topology-synthesis.ts:692-708`): `synthesizeDefaultTopology` returns a single-agent fallback if LLM fails. Five canonical patterns exist (`single_agent`, `triage_specialists`, `pipeline`, `hub_spoke`, `peer_mesh` — lines 63-195) and `synthesizePatternTopology` (lines 348-367), but the v4 path does NOT invoke them by default — `BLUEPRINT_USE_SYNTHETIC_DRAFT_FALLBACK = false` (`process-message.ts:84`).

### 4.4 BUILD (specialist: `abl-construct-expert`, in parallel workers)

**Locks:** Full ABL DSL per agent — `AGENT:`/`SUPERVISOR:` header, `PERSONA:`, `GOAL:`, `GATHER`, mandatory `GUARDRAILS.content_safety`, `MEMORY.session`, optional `TOOLS`/`HANDOFF`/`CONSTRAINTS`/`FLOW`/`COMPLETE`/`ON_ERROR`.

**Per-worker LLM prompt** (`apps/studio/src/lib/arch-ai/handbook-reference.ts:233-555`) injects:

1. ABL construct expert syntax
2. Architecture Plan from `computeArchitecturePlans` (deterministic)
3. ~14 ABL generation rules
4. Runtime Expression Contract (CEL)
5. Previous compiler feedback on retries
6. Agent name, role, execution mode, description, suggested tools, gather field source, flow step seeds
7. Return-Path Contract for delegate targets
8. Handoff Continuity rules
9. Entry-Point Routing (explicit HANDOFF block lines for entry agents)
10. Topology Context (siblings, edges)
11. Domain Context (channels, language, compliance, integrations, tone)
12. Blueprint Rationale (last assistant summary)
13. Data Sensitivity classification
14. Model Recommendation

**Determinism applied (already not LLM):** domain extraction, sensitivity classification, model recommendation, architecture plan, source normalization, quality enrichment, cross-agent validation, false-error recovery.

**Exit criterion:** `metadata.topology.agents.every(a => buildProgress.agentStatuses[a.name] in ['compiled', 'warning'])` AND `bp.stage !== 'generating'` (`phase-machine.ts:48-62`).

### 4.5 CREATE (no LLM)

The `create` action on `BuildComplete` widget is intercepted by `handleBuildAction` (`build-completion.ts:644-650`), which calls `createProject` callback, which calls `finalizeProject` (`apps/studio/src/lib/arch-ai/processors/finalize-project.ts:130-450`). Fully deterministic. New `projects` doc + agent records + HTTP Project Tools synthesized via `synthesizeOnboardingBootstrapTools` (only HTTP — non-HTTP gaps surfaced as warning) + decision journal entry + session transition ACTIVE → COMPLETE → ARCHIVED + journal/spec-document linked to project + project memory extracted + final `tool_result` SSE event.

### 4.6 The gap

Today: BLUEPRINT locks 9 fields; BUILD reconstructs ~24 per agent. Half deterministically (helpers above), half via LLM creativity in parallel workers that can't see each other. The 16 reactive layers compensate. The user has no visibility into the deterministic helpers' decisions until BUILD output appears.

---

## 5. Proposed Architecture (Target State)

### 5.1 Phase machine (unchanged structure, expanded BLUEPRINT)

```
INTERVIEW → BLUEPRINT → BUILD → CREATE
                ↑          ↓
                └──────────┘  (BUILD→BLUEPRINT backtrack on topology change — preserved)
```

The phase machine itself doesn't change. BLUEPRINT becomes a 4-stage internal flow. BUILD becomes deterministic.

### 5.2 What each phase locks (target)

| Phase                  | Locks                                                                                                                                                                                                                                                                                                                                                |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| INTERVIEW (expanded)   | 12+ structured fields: today's 6 PLUS `businessObjective`, `primaryPersona`, `audience[]`, `heroScenario`, `supportingScenarios[]`, `compliance[]` (typed), `integrations[]` (typed), `sla.{latencyTarget, containmentTarget}`, `escalationPaths[]`, `successBar[]`, `assumptions[]`                                                                 |
| BLUEPRINT (4 stages)   | Full `BlueprintOutput` v2.0: topology + per-agent (persona, model, executionMode, tools refs, gathers, constraints, guardrails, complete, memory, onError, handoffs with CEL conditions, flow steps with structured prose) + governance + integrations + buildOrder + complexity profile + architecture decisions + section plan + validation report |
| BUILD (pure renderer)  | Per-agent ABL DSL strings + tool DSL strings, deterministically rendered, sanity-compiled                                                                                                                                                                                                                                                            |
| CREATE (deterministic) | Project records, agent files, Project Tool rows, journal/spec/blueprint linkage                                                                                                                                                                                                                                                                      |

### 5.3 What disappears

| Capability/Code Path                                                   | Disposition                                   |
| ---------------------------------------------------------------------- | --------------------------------------------- |
| Per-agent LLM worker in BUILD (`build-parallel-gen.ts:1086-1097`)      | DELETED                                       |
| `buildAgentSystemPrompt` (~500 lines, `handbook-reference.ts:233-555`) | DELETED                                       |
| Per-worker compile-fix loop (`build-parallel-gen.ts:1239-1496`)        | DELETED                                       |
| Worker retry loop (`build-parallel-gen.ts:2603-2733`)                  | DELETED                                       |
| HANDOFF regression detector                                            | DELETED                                       |
| Source normalization auto-rewrite                                      | DELETED                                       |
| Quality enrichment auto-injection                                      | DELETED                                       |
| `recoverFalseErrors`                                                   | DELETED                                       |
| Cross-agent topology validator (post-render)                           | DELETED                                       |
| Topology-aware placeholder validation                                  | DELETED                                       |
| Reconciliation + targeted-repair re-spawn                              | DELETED                                       |
| Server-side blocking-pattern detector                                  | DELETED                                       |
| Tool-bootstrap silent-skip of non-HTTP types                           | DELETED                                       |
| Structural-diagnostic classifier (BUILD)                               | DELETED (UX moves to BLUEPRINT lock gauntlet) |
| "LLM never called generate_agent" detector                             | DELETED                                       |

Total deletable: ~11 reactive layers, estimated ~2000 LOC.

### 5.4 What's added

- `arch_blueprints` Mongo collection + `BlueprintService`
- `ComplexityClassifier` (extends `topology-synthesis.classifyTopologyPattern`)
- `BlueprintArchitectureDecisions` wrapper (extends existing `computeArchitecturePlans`)
- `SectionPlanner` (deterministic, computes from classifier + architecture)
- Per-section LLM call infrastructure (reuses `scaffold/slot-fix-loop.ts` pattern)
- Per-section Zod schemas + validators (extends `scaffold/slot-validators.ts`)
- Cross-section consistency checks
- Lock-time validation gauntlet (BV-001..BV-N)
- 13 renderer functions (one per ABL section)
- `renderMarkdown(BlueprintOutput)` markdown renderer
- `BlueprintPanel` UI (sticky ToC + scrollable doc)
- 5 new blueprint tools in `IN_PROJECT_SPECIALIST_TOOL_MAP`
- Real `in-project-architect.ts` prompt
- Schema migration framework (`blueprintSchemaVersion`)
- Per-tenant LLM budget gate
- Telemetry events for blueprint lifecycle
- Auto-journal for blueprint mutations
- `BLUEPRINT_VALIDATION_FAILED` typed error

Estimated additions: ~600 LOC net new.

---

## 6. The 4-Stage BLUEPRINT Phase

### 6.1 Flow overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    BLUEPRINT (the design crucible)                       │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  STAGE 1            STAGE 2                STAGE 3            STAGE 4   │
│  ─────────          ──────────────────     ─────────────     ────────   │
│  CLASSIFY    ───►   DECIDE ARCHITECTURE ───► PLAN SECTIONS ───► FILL    │
│                                                                          │
│  Read spec.         Per-agent + system     Compute which       Section- │
│  Score 7            decisions:              sections render    by-      │
│  complexity         • topology pattern      and at what        section  │
│  dimensions.        • execution mode         depth, given      iter.    │
│                       per agent +            classification    Per-     │
│  Show user a        signals + rationale      + decisions.      section  │
│  ComplexityCard     • model per agent                          approval │
│  with explicit      • tool budget          Show user a         gates.   │
│  reasoning.         • memory strategy      BlueprintPlanCard:           │
│                     • eval rigor            "I'll write 11     Validate │
│  Approve/refine.    • compliance            sections, ~600     at lock  │
│                       enforcement           lines, ~3 min."    time.    │
│                                                                          │
│                     Show user an           Approve/refine.              │
│                     ArchitectureCard                                     │
│                     per agent.                                          │
│                                                                          │
│                     Approve/override.                                   │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

The MD doc starts populating from Stage 3 onward. The user sees the plan **before** Arch commits to writing 1000+ lines.

### 6.2 Stage 1 — CLASSIFY

#### 6.2.1 Inputs

- `Specification` from INTERVIEW (12+ structured fields)
- Project context (channels, integrations, compliance hints)

#### 6.2.2 The complexity classifier (7 dimensions)

Arch scores 7 dimensions: each `low | medium | high`, each with signals (evidence) and rationale (1-sentence LLM explanation).

| Dimension          | What it measures                       | Signals (evidence Arch checks)                                                                     |
| ------------------ | -------------------------------------- | -------------------------------------------------------------------------------------------------- |
| **Conversational** | How open-ended is the dialog           | # of intents from spec, intent-ambiguity flag, domain breadth, multi-domain routing needed         |
| **Procedural**     | How much fixed business process        | # of SOPs identified, # of mandatory gather fields inferred, # of compliance steps                 |
| **Topological**    | How many agents and what relationships | # of distinct domains, # of escalation paths, supervisor-needed signal, return-contract complexity |
| **Channel**        | Single, multi, or omnichannel          | `channels[]` count, voice present, channel-aware logic needed                                      |
| **Integration**    | Mock vs light vs heavy real systems    | `integrations[]` count from spec, real-vs-mock flag, auth complexity                               |
| **Sensitivity**    | Regulatory burden                      | `compliance[]` from spec, PII / PCI / PHI signals in domain                                        |
| **Operational**    | POC vs internal vs production          | `preset` indicator, SLA presence, oncall signal, scale signal                                      |

#### 6.2.3 Outputs

`BlueprintOutput.complexity: ComplexityProfile` (see schema in Section 8).

User sees `ComplexityCard` widget — table of 7 scores + rationale + `[approve, refine]`. Refine re-runs the classifier with user override hints.

#### 6.2.4 Example contrasts

**Simple Slack FAQ bot:**

```
conversational: low      (1 intent: "answer Q from KB")
procedural:     low      (no SOPs)
topological:    low      (single-agent suffices)
channel:        low      (Slack only)
integration:    low      (Search-AI + Slack — both mockable)
sensitivity:    low      (internal docs, no PII)
operational:    low      (internal-dev preset)
overall:        SIMPLE
```

**Lumen billing reference:**

```
conversational: medium   (3 intents: payment, variance, supervisor disambig)
procedural:     high     (payment SOP, auth flow, variance SOP — fixed sequences)
topological:    high     (supervisor + 3 workers, return contracts, escalation)
channel:        medium   (voice primary, chat secondary)
integration:    high     (CRM, billing, payment, case mgmt)
sensitivity:    high     (PCI — payment card data)
operational:    high     (enterprise-poc, BCG-evaluated)
overall:        COMPLEX
```

### 6.3 Stage 2 — DECIDE ARCHITECTURE

#### 6.3.1 Decisions made

Each surfaces to the user with signals + rationale + approve/override. **No silent BUILD overrides.**

| Decision                            | Signals                                                                                    | Default mechanism                                               |
| ----------------------------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| **Topology pattern** (system-level) | topological × conversational × procedural complexity                                       | `topology-synthesis.classifyTopologyPattern` (extends existing) |
| **Per-agent execution mode**        | tool count, gather field count, process determinism, intent breadth, compliance constraint | `computeArchitecturePlans` (existing planner, extended)         |
| **Model per agent**                 | Mode × sensitivity × latency target                                                        | `getModelRecommendation` (existing)                             |
| **Tool budget per agent**           | Mode × tool count × cost tier                                                              | scripted: tool_count; reasoning: 2; hybrid: tool_count + 1      |
| **Memory strategy**                 | Conversational complexity × session lifetime × multi-turn signal                           | session-only for low; project for medium+                       |
| **Eval rigor**                      | Operational complexity × preset                                                            | none / smoke / full (3 tiers)                                   |
| **Compliance enforcement layer**    | Compliance set × executionMode                                                             | prompt+runtime for reasoning; runtime+middleware for scripted   |

#### 6.3.2 Topology pattern selection

Uses the existing 5-pattern selector at `topology-synthesis.ts:226` (`classifyTopologyPattern`) with `TOPOLOGY_PATTERN_VOCABULARY`. Today this runs only as LLM fallback. New design runs it as the primary recommendation; LLM proposes agent names/roles fitting the chosen pattern; user approves the pattern itself separately from the agent details.

| Topology             | Trigger                                                  | Example                                            |
| -------------------- | -------------------------------------------------------- | -------------------------------------------------- |
| `single_agent`       | topological=low, intent count ≤ 2                        | Slack FAQ bot, simple form filler                  |
| `triage_specialists` | topological=medium, multi-domain, supervisor needed      | Lumen (supervisor + 3 workers)                     |
| `pipeline`           | procedural=high, ordered stages                          | Document processing, onboarding wizard             |
| `hub_spoke`          | topological=high, central coordinator + many specialists | Travel concierge w/ flights, hotels, cars, support |
| `peer_mesh`          | topological=high, no clear hub, agents collaborate       | Multi-expert consultation system                   |

#### 6.3.3 Per-agent execution mode decision matrix

For each agent, score 5 signals → recommend a mode → show signals + rationale → user approves or overrides.

| Signal                    | Indicates `reasoning` | Indicates `scripted`               | Indicates `hybrid`            |
| ------------------------- | --------------------- | ---------------------------------- | ----------------------------- |
| **Tool count**            | 0–1 tools             | 3+ tools wired in fixed order      | 2+ tools, conditional         |
| **Gather field count**    | 0–2 fields            | 4+ mandatory fields                | 2–4 fields, branchy           |
| **Process determinism**   | Open dialog, judgment | Fixed SOP, regulated               | SOP exists but not all paths  |
| **Intent breadth**        | Broad / open          | Narrow / single-intent             | Disambiguation then deep      |
| **Compliance constraint** | None                  | Hard regulatory steps (PCI, HIPAA) | Some constraints, mostly free |

**Decision rules:**

- All signals point reasoning → `reasoning` (full autonomous LLM, FLOW-light or absent)
- All signals point scripted → `scripted` (FLOW-driven, LLM only for slot-filling)
- Mix → `hybrid` (open-dialog branches with scripted FLOW segments at compliance-critical or tool-heavy steps)

#### 6.3.4 ArchitectureCard widget (per agent)

```
┌─────────────────────────────────────────────────────────────────┐
│  Agent: Bill Payment Worker                                       │
│  ─────────────────────────────                                    │
│  Recommended mode: SCRIPTED                                       │
│                                                                    │
│  Signals that drove this:                                         │
│    • Tools (3): retrieve_invoices, submit_payment, send_receipt   │
│    • Gather fields (5): payment_type, amount, payment_method,     │
│        cvv, authorization                                          │
│    • Process determinism: HIGH (fixed SOP — fee disclosure,       │
│        collect, authorize, submit, confirm)                       │
│    • Intent: NARROW (one job: process a payment)                  │
│    • Compliance: PCI (CVV handling, fee disclosure required)      │
│                                                                    │
│  Why scripted: PCI compliance requires deterministic steps.       │
│  4+ mandatory fields + ordered tool sequence means a FLOW         │
│  is more reliable and auditable than open reasoning.              │
│                                                                    │
│  ▸ approve  ▸ change to hybrid  ▸ change to reasoning  ▸ details  │
└─────────────────────────────────────────────────────────────────┘
```

User approves all per-agent cards → mode locked in `perAgent[name].executionMode`. BUILD never overrides this silently again.

#### 6.3.5 Reuse vs replace

**EXTEND `computeArchitecturePlans`, do not replace.** The existing planner (`packages/arch-ai/src/planning/agent-architecture-planner.ts`, 391 lines, 5 test cases, used by 7+ files) already computes archetype, keyword, gather/complete requirements, execution mode recommendation, complexity, flow.recommended, handoffs with returnFieldSeeds + historyHint + returnContractHint, needsCatchAll. The new design:

1. Adds a system-level `computeSystemArchitectureSignals(spec, topology) → SystemSignals` (the 7-dimension classifier above)
2. Extends `PlannerTopologyInput.agents[]` with `complianceTags?: string[]` and `intentBreadth?: number`
3. Wraps the existing planner in a `BlueprintArchitectureDecisions` facade that:
   - Persists the plans to `BlueprintOutput.architecture`
   - Surfaces per-agent decisions to UI via `ArchitectureCard` widget
   - Adds a lock mechanism (once approved, BUILD reads from `BlueprintOutput.architecture` instead of re-deriving)
4. Cutover phased: Phase 1 plans computed at BLUEPRINT in addition to BUILD (no behavior change); Phase 4 BUILD reads from persisted; Phase 6 BUILD-side re-derivation removed.

### 6.4 Stage 3 — PLAN SECTIONS

#### 6.4.1 Deterministic from classification + decisions

The planner computes which sections render and at what depth. No LLM call in this stage.

#### 6.4.2 Section inclusion rules

| §   | Section                      | Included when                                                 | Depth scales with                                             |
| --- | ---------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------- |
| 0   | Header / Frontmatter         | always                                                        | —                                                             |
| A   | Assumptions                  | always                                                        | INTERVIEW gap count                                           |
| 1A  | Executive Summary            | always                                                        | overall complexity                                            |
| 1B  | Why This Should Win          | preset == enterprise-poc AND audience.competitive == true     | —                                                             |
| 2   | Platform & App Configuration | always                                                        | channel + integration complexity                              |
| 3   | Agent Topology               | always                                                        | topological complexity                                        |
| 4   | Solution Architecture        | always                                                        | integration + topological complexity                          |
| 5   | Call Control Parameters      | channels.includes('voice')                                    | voice config depth                                            |
| 6   | System Prompts               | always                                                        | per-agent execution mode (scripted = thin; reasoning = thick) |
| 7   | Knowledge & Search           | integrations.searchAi present                                 | knowledge source count                                        |
| 8   | Inputs & Outputs             | always (compact if no gathers)                                | gather schema size                                            |
| 9   | Tools                        | always (compact if mock-only)                                 | tool count + auth complexity                                  |
| 10  | Memory & Context             | always (compact if session-only)                              | memory strategy                                               |
| 11  | Decision Logic               | always                                                        | intent count + edge count                                     |
| 12  | Multi-Agent Relationships    | topology.agents.length > 1                                    | edge count + return contract complexity                       |
| 13  | Guardrails                   | always                                                        | compliance set + sensitivity                                  |
| 14  | Error Handling               | always                                                        | operational complexity                                        |
| 15  | Evaluation / Quality         | preset in [enterprise-poc, prod-launch] OR eval-rigor != none | eval rigor tier                                               |
| 16  | Demo Script                  | preset == enterprise-poc                                      | scenario count                                                |
| 17  | Configuration Checklist      | always                                                        | sum of all included sections                                  |
| 18  | Deployment / Runbook         | preset == prod-launch                                         | env vars, secrets, rollout, observability                     |

#### 6.4.3 Depth modes per section

Three rendering depths; the planner picks per section based on signals:

- **Compact** — minimum viable info; one or two short tables; ~30–60 lines
- **Standard** — full per-agent / per-tool detail; ~80–150 lines
- **Deep** — adds rationale prose, cross-references, examples; ~200–400 lines

#### 6.4.4 BlueprintPlanCard widget

```
┌─────────────────────────────────────────────────────────────────┐
│  BLUEPRINT PLAN                                                   │
│  ──────────────                                                   │
│                                                                    │
│  Project type: COMPLEX (enterprise-poc preset)                    │
│  Sections to render: 16 of 18                                     │
│  Estimated length: ~1,150 lines                                   │
│  Estimated time: ~3 minutes                                       │
│                                                                    │
│  Sections included:                                               │
│   §0  Header                          compact   30 lines          │
│   §A  Assumptions                     standard  50 lines          │
│   §1A Executive Summary               deep      120 lines         │
│   §1B Why This Should Win             deep      90 lines          │
│   §2  Platform & App Configuration    standard  85 lines          │
│   §3  Agent Topology                  deep      180 lines         │
│   §4  Solution Architecture           standard  60 lines          │
│   §5  Call Control Parameters         standard  70 lines          │
│   §6  System Prompts                  deep      220 lines         │
│   §8  Inputs & Outputs                standard  55 lines          │
│   §9  Tools                           standard  90 lines          │
│   §11 Decision Logic                  standard  50 lines          │
│   §12 Multi-Agent Relationships       standard  45 lines          │
│   §13 Guardrails                      deep      75 lines          │
│   §14 Error Handling                  standard  40 lines          │
│   §15 Evaluation / Quality            deep      80 lines          │
│   §16 Demo Script                     standard  100 lines         │
│   §17 Configuration Checklist         standard  60 lines          │
│                                                                    │
│  Sections skipped:                                                │
│   §7  Knowledge & Search   (no Search-AI integration)             │
│   §10 Memory & Context     (folded into §3 — session-only)        │
│   §18 Deployment / Runbook (preset != prod-launch)                │
│                                                                    │
│  ▸ start writing  ▸ adjust plan  ▸ change preset                  │
└─────────────────────────────────────────────────────────────────┘
```

For the simple Slack FAQ bot: ~6 sections, ~280 lines, ~30s.

### 6.5 Stage 4 — FILL SECTIONS

For each planned section in order:

```
LLM call via generateObject with section's Zod schema
   ↓
Run section-specific semantic validators (Layer 2)
   ↓
If validators fail, retry up to 3× with structured feedback (Layer 3)
   ↓
If exhausted, use fallback default + warn (Layer 4)
   ↓
Run cross-section consistency check against approved sections (Layer 5)
   ↓
Render section MD via renderMarkdown(slice) → update artifact panel
   ↓
SectionApproval widget [approve | refine | skip-if-optional]
   ↓
User approves or refines
```

Sections are filled in order to satisfy cross-section dependencies (e.g., §6 System Prompts references §3 Topology agents; §8 I/O references §6 personas + agent gathers).

**Per-section persistence is mandatory** — `BlueprintService.persistSection({sessionId, sectionId, content, status})` called immediately after each LLM completion, BEFORE the approval widget emits. Disconnect during section fill: content survives, user resumes at the same approval gate. (Addresses audit finding B1.)

### 6.6 Lock (BLUEPRINT exit)

When all required sections approved (or explicitly skipped):

1. Run full BV-001..BV-N validation gauntlet (Layer 6)
2. If any rule fires, identify section, flip to `validation_failed`, surface banner with `[Go to section]` deep links
3. If all pass: transition `state: draft → locked`, set `lockedAt`, set `validation: {passing: true, ...}`
4. Coordinator advances phase to BUILD

---

## 7. The Canonical Blueprint Spine

Derived from the two reference blueprints (`lastminute_blueprint_v2.md`, `Lumen_Agentic_Billing_Platform_Blueprint_v1.1.md`) and validated against runtime IR consumption.

### 7.1 Tier presets

| Preset           | When                                         | Sections rendered                                                                |
| ---------------- | -------------------------------------------- | -------------------------------------------------------------------------------- |
| `internal-dev`   | Building agents for own team / internal use  | 12 always-on (skips §1B, §16, optional sales)                                    |
| `enterprise-poc` | SE-built deliverable for customer evaluation | Full 18 (everything)                                                             |
| `prod-launch`    | Production deployment of internal-dev or POC | 12 always-on + deepened §13/14/15 + §18 (Deployment/Runbook); §16 (Demo) dropped |

INTERVIEW asks one explicit question to set the preset. Default: `internal-dev`.

### 7.2 Block A — Project Framing

#### §0 Header / Frontmatter

YAML-ish frontmatter at the top of every blueprint:

```yaml
project: <project name>
version: <semver, e.g. 1.0>
preset: <internal-dev | enterprise-poc | prod-launch>
owner: <userId or full name>
stage: <draft | locked | linked>
created: <ISO8601>
locked: <ISO8601 or null>
git: <commit SHA or null>
# enterprise-poc only:
customer: <customer name>
dealStage: <stage>
evaluationPartner: <partner>
timeline: <description>
```

**Source:** `BlueprintOutput.metadata`. **Always-on. Compact (~20-30 lines).**

#### §A Assumptions

Bulleted list of inferred decisions from INTERVIEW gaps, distinguished as `INFERRED` vs `DECIDED`. Each assumption flagged for review:

```markdown
## Assumptions

The following assumptions were made from incomplete intake data. Review before lock:

- **INFERRED:** Phone numbers NOT in mock data — authentication accepts account number or invoice number only. [Source: spec contains no phone field; intake mentioned MCP Data sheet]
- **DECIDED:** Latency target is <500ms to first token. [Source: spec field sla.latencyTarget=500ms]
- **INFERRED:** All integrations are mocked. [Source: spec.integrations[].mock=true]
- ⓘ 3 assumptions inferred from intake gaps
```

**Source:** `BlueprintOutput.specification.assumptions[]`. **Always-on. Standard depth.**

#### §1A Executive Summary

Mixed format — prose + tables:

- **Business Objective** (1 para from `specification.businessObjective`)
- **Primary Persona** (`specification.primaryPersona` + `audience[]`)
- **Primary Hero Scenario** (`specification.heroScenario`)
- **Supporting Scenarios** (numbered list from `specification.supportingScenarios[]`)
- **Platform Pillars Demonstrated** (table from `governance.platformPillars`)
- **Success Bar** (numbered list from `specification.successBar`)

**Source:** specification + governance. **Always-on. Compact for internal-dev, deep for enterprise-poc.**

#### §1B Why This Should Win

4 sub-sections (each ~150 words):

1. Why this scenario is the right hero for the deal
2. Why more persuasive than a feature tour
3. Why it fits the prospect's volume / pain / customer reality
4. Why it outperforms competitor demos

**Source:** `specification.competitiveContext` + LLM-authored prose. **Optional — `enterprise-poc` preset only.**

### 7.3 Block B — Configuration & Topology

#### §2 Platform & App Configuration

Tables:

- **Platform Scope** (which modules: Automation AI, Search AI, Contact Center AI, Agent AI, Quality AI)
- **Agentic App Profile** (name, description, default model, backup model, context window, toggles)
- **Channels & Languages** (per channel)
- **Orchestration Pattern** (single / triage / pipeline / hub_spoke / peer_mesh) + rationale
- **Voice Stack** (if voice channel)
- **Events Configuration** (Welcome, Handoff, EOC)
- **XO / AI for Service Integration**

**Source:** `governance.appProfile` + `governance.channels` + `governance.voiceStack` + `governance.events` + `integrations.entrypoints`. **Always-on. Depth scales with channel/integration complexity.**

#### §3 Agent Topology

- **Topology Overview** — ASCII diagram, generated from `topology.agents + topology.edges + topology.entryPoint`
- **Agent Detail Cards** — one per agent, ~15 fields each:
  - Agent Name, Agent Type (native/human/external), Archetype, Role, Description
  - AI Model, Backup Model, Context Window, Tool Budget, Execution Mode
  - Persona (voice + rationale)
  - Knowledge Sources
  - Tools (refs)
  - Delegation Rules
  - Channel, Language
  - LOBs / Domains
  - Constraints
  - Mock Behavior (POC only)
- **Orchestration Flow** — ASCII flow diagram, generated from topology + handoffs
- **Why This Topology** — rationale prose (LLM-authored, sibling-aware)

**Source:** `topology` + `perAgent[]`. **Always-on. Depth scales with topological complexity.**

#### §4 Solution Architecture

- **Pipeline declaration** (ASR → LLM → TTS, etc.)
- **Integration Method** (XO Flow, AI for Service, Web SDK, etc.)
- **Architecture Diagram** — ASCII, generated from `topology + integrations + governance.channels`

**Source:** derived from topology + integrations. **Always-on. Compact ASCII if simple; full diagram if complex.**

#### §5 Call Control Parameters

**Voice-only. Tables + code blocks:**

- Script Node JS code blocks (Primary TTS, Fallback TTS, Emergency Fallback)
- ASR Configuration table
- TTS Configuration table (with latency budget)
- Configuration Level Reference table (Node vs Flow level for each parameter)
- Fallback Plan prose

**Source:** `governance.voiceStack` + `governance.callControl`. **Conditional — `channels.includes('voice')`.**

### 7.4 Block C — Per-Agent Specifications

#### §6 System Prompts

Fenced code blocks, ready to paste into the platform:

- **Shared Behavioral Instructions (App-Level)** — TTS rules, output formatting, number normalization, conversational style. Single block at top, deduplicated.
- **Per-Agent Agent Definition** — one fenced block per agent:
  - Identity
  - Channel Awareness
  - Authentication / Auth Flow
  - Domain SOP (handles X intents: ...)
  - Multi-Intent Handling
  - Data Capture & Corrections
  - Silence Handling
  - Constraints
  - TTS Engine-Specific Addendum (per voice engine if voice)

**Source:** `governance.sharedBehavioralInstructions` + `perAgent[].{persona, identity, channelAwareness, sop, ttsInstructions}`. **Always-on. Depth scales with per-agent executionMode (scripted = thin; reasoning = thick).**

#### §7 Knowledge & Search Configuration

Tables for knowledge sources, search profiles, retrieval config.

**Source:** `integrations.searchAi`. **Conditional — Search-AI in scope.**

#### §8 Inputs & Outputs

Per-agent inputs (gather schema with name/prompt/type/dependsOn) + outputs (return contract from COMPLETE / handoff CONTEXT.pass).

**Source:** `perAgent[].gathers[]` + `perAgent[].complete.returns` + edge `CONTEXT.pass`. **Always-on. Compact if no gathers; full if gather schema present.**

#### §9 Tools

- **Tool Catalog** — one row per Project Tool: name, type, auth, input schema, output schema, mock behavior, when called
- **Per-agent tool assignment matrix**

**Source:** `integrations.tools[]` + `perAgent[].tools[]` (refs). **Always-on. Compact if mock-only; full if real systems.**

#### §10 Memory & Context Management

Per-agent memory schema (declared paths, scopes, TTLs) + conversation memory ownership + sliding-window strategy.

**Source:** `perAgent[].memory[]` + `governance.contextManagement`. **Always-on. Compact if session-only; full if project memory.**

### 7.5 Block D — Operations & Quality

#### §11 Decision Logic

- **Intent Routing Table** (intent → agent, with canonical CEL condition)
- **Escalation Logic** (when, why, who)
- **Contact Center AI Configuration**

**Source:** `topology.edges` + `perAgent[].handoffs` + `governance.contactCenter`. **Always-on. Depth scales with intent count + edge count.**

#### §12 Multi-Agent Relationships

- **Pattern-Specific Constraints** (e.g., last-node restriction in Adaptive Network)
- **Delegation Matrix** (who-can-delegate-to-whom)
- **Return Contract** (per delegate edge)

**Source:** derived from `topology` + `perAgent[].handoffs`. **Conditional — `topology.agents.length > 1`.**

#### §13 Guardrails

Table: category × policy × rationale × enforcement layer:

- PII, prompt injection, scope, content safety, payment authentication, profanity, escalation triggers
- Per-agent overrides if any

**Source:** `governance.guardrails[]` + per-agent overrides. **Always-on. Deepened in `prod-launch`.**

#### §14 Error Handling

- **Standard Error Scenarios** (table: trigger × user-facing response × retry strategy)
- **Bot No-Input Handling** (timeout strategy)
- **Voice Waiting Experience** (latency fillers, hold messages, prosody)

**Source:** `perAgent[].onError` + `governance.{noInputHandling, waitingExperience}`. **Always-on. Deepened in `prod-launch`.**

#### §15 Evaluation / Quality

- **Demo Success Criteria** (numbered rubric)
- **AgentAssist Configuration** (structured-handoff JSON template, fields)
- **Auto-QA Dimensions** (per-dimension scoring rubric, weights)

**Source:** `governance.{evalCriteria, autoQa, agentAssist}` + `specification.successBar`. **Conditional — `preset in [enterprise-poc, prod-launch]` OR `eval-rigor != none`. Depth scales with eval rigor tier.**

#### §16 Demo / Walkthrough Script

- **Wow Moments — Strategic Summary** (per-scenario)
- **Per-call/turn scripts** (table format: caller line / agent response / SE notes)
- **Alternate Lines** (variations)
- **Architecture-to-Script Coverage Matrix**
- **Self-Check** (does the script exercise every architecture pillar?)

**Source:** LLM (one-shot per scenario) + `governance.demoScript`. **Optional — `enterprise-poc` preset only.**

#### §17 Configuration Checklist

Per-section actionable tick-boxes for SE/engineering to verify configuration in the actual platform. Mirrors every section above:

```markdown
## §17 Configuration Checklist

### Section 1 — Platform & App Configuration

- [ ] App created in Kore platform with name "Lumen Travel Assistant"
- [ ] Default model set to GPT-4o
- [ ] Context window set to 50 messages
- ...

### Section 2 — Agent Topology

- [ ] All 4 agents created in app
- [ ] Entry agent set to Supervisor
- [ ] Handoff routing configured per topology
- ...
```

**Source:** derived from every section above. **Always-on. The SE handoff artifact.**

#### §18 Deployment / Runbook

**Conditional — `prod-launch` preset only:**

- Environment variables list
- Secrets management (Vault paths, rotation policy)
- Rollout strategy (canary %, success criteria)
- Observability hooks (Grafana dashboards, Coroot scopes)
- Oncall runbook (common alerts, escalation, recovery)

**Source:** `governance.deployment` (new field) + `governance.observability` (new field). **Conditional — `prod-launch` only.**

---

## 8. The BlueprintOutput Schema (v2.0)

The schema is the contract. Every field has a runtime consumer or is explicitly deliverable polish.

**Reference:** `PerAgentSpec` is a Blueprint authoring schema whose runtime-facing fields compile to runtime IR (`packages/compiler/src/platform/ir/schema.ts`). It is not a direct copy of the IR: some fields are deliverable polish or authoring affordances, and those must be explicitly marked as such.

### 8.1 Top-level schema

```ts
// packages/arch-ai/src/types/blueprint.ts (v2.0)

export const BlueprintOutputSchema = z.object({
  schemaVersion: z.literal('2.0'),
  metadata: BlueprintMetadataSchema,
  specification: BlueprintSpecificationSchema, // extended INTERVIEW spec
  complexity: ComplexityProfileSchema, // Stage 1 output
  architecture: ArchitectureDecisionsSchema, // Stage 2 output
  sectionPlan: SectionPlanSchema, // Stage 3 output
  topology: TopologyOutputSchema, // existing (agents, edges, entryPoint)
  perAgent: z.record(PerAgentSpecSchema), // keyed by agent name
  governance: GovernanceSchema,
  integrations: IntegrationsSchema,
  buildOrder: z.array(z.string()), // computed via Kahn at lock time
  sectionApprovals: z.record(SectionApprovalSchema), // keyed by section ID
  validation: ValidationReportSchema.optional(),
  attachmentContext: AttachmentContextSchema.optional(),
});

export type BlueprintOutput = z.infer<typeof BlueprintOutputSchema>;
```

### 8.2 Metadata

```ts
export const BlueprintMetadataSchema = z.object({
  projectName: z.string().min(1),
  version: z.string().default('1.0'), // semver
  preset: z.enum(['internal-dev', 'enterprise-poc', 'prod-launch']),
  owner: z.string().min(1), // userId
  stage: z.enum(['draft', 'review', 'locked']),
  createdAt: z.string().datetime(),
  lockedAt: z.string().datetime().optional(),
  sourceHash: z.string().optional(), // for runtime IR cache (REQUIRED post-lock)
  // For enterprise-poc preset:
  customerName: z.string().optional(),
  dealStage: z.string().optional(),
  evaluationPartner: z.string().optional(),
  timeline: z.string().optional(),
});
```

### 8.3 Specification (extended INTERVIEW capture)

```ts
export const BlueprintSpecificationSchema = z.object({
  // Existing fields
  projectName: z.string(),
  description: z.string().optional(),
  channels: z.array(z.enum(['voice', 'chat', 'email', 'sms', 'webhook'])),
  language: z.array(z.string()),
  uploadedFiles: z.array(FileRefSchema),
  conversationNotes: z.array(ConversationNoteSchema),

  // New required fields (expanded INTERVIEW)
  businessObjective: z.string().min(1),
  primaryPersona: z.string(),
  audience: z.array(
    z.object({
      role: z.string(),
      judging: z.string(), // what they'll judge
    }),
  ),
  heroScenario: z.string(), // full prose scenario
  supportingScenarios: z.array(
    z.object({
      title: z.string(),
      description: z.string(),
    }),
  ),
  compliance: z.array(z.enum(['hipaa', 'pci', 'soc2', 'gdpr', 'ccpa', 'fedramp'])),
  integrations: z.array(
    z.object({
      name: z.string(),
      type: z.string(),
      mock: z.boolean(),
      auth: z.string().optional(),
    }),
  ),
  sla: z
    .object({
      latencyTarget: z.number().optional(), // ms
      containmentTarget: z.number().optional(), // %
      availabilityTarget: z.number().optional(),
    })
    .optional(),
  escalationPaths: z.array(
    z.object({
      trigger: z.string(),
      target: z.string(),
    }),
  ),
  successBar: z.array(z.string()), // numbered rubric items
  assumptions: z.array(
    z.object({
      text: z.string(),
      source: z.enum(['inferred', 'decided', 'overridden_by_user']),
      sourceDetail: z.string().optional(),
    }),
  ),
  competitiveContext: z
    .object({
      // enterprise-poc only
      competitors: z.array(z.string()),
      differentiators: z.array(z.string()),
    })
    .optional(),
});
```

### 8.4 Complexity profile (Stage 1 output)

```ts
export const ComplexityScoreSchema = z.enum(['low', 'medium', 'high']);

export const ComplexityProfileSchema = z.object({
  conversational: ComplexityScoreSchema,
  procedural: ComplexityScoreSchema,
  topological: ComplexityScoreSchema,
  channel: ComplexityScoreSchema,
  integration: ComplexityScoreSchema,
  sensitivity: ComplexityScoreSchema,
  operational: ComplexityScoreSchema,
  overall: z.enum(['simple', 'moderate', 'complex']),
  signals: z.record(z.array(z.string())), // dimension → evidence strings
  rationale: z.record(z.string()), // dimension → 1-sentence explanation
  approvedAt: z.string().datetime().optional(),
});
```

### 8.5 Architecture decisions (Stage 2 output)

```ts
export const ExecutionModeDecisionSchema = z.object({
  mode: z.enum(['reasoning', 'scripted', 'hybrid']),
  signals: z.object({
    toolCount: z.number().int(),
    gatherFieldCount: z.number().int(),
    processDeterminism: z.enum(['low', 'medium', 'high']),
    intentBreadth: z.enum(['narrow', 'medium', 'broad']),
    complianceConstraint: z.enum(['none', 'some', 'hard']),
  }),
  rationale: z.string(), // LLM explanation
  userOverride: z.boolean().default(false), // true if user changed from recommendation
  approvedAt: z.string().datetime().optional(),
});

export const ArchitectureDecisionsSchema = z.object({
  topologyPattern: z.enum([
    'single_agent',
    'triage_specialists',
    'pipeline',
    'hub_spoke',
    'peer_mesh',
  ]),
  topologyPatternRationale: z.string(),
  perAgentExecutionMode: z.record(ExecutionModeDecisionSchema),
  perAgentModel: z.record(z.string()),
  perAgentToolBudget: z.record(z.number().int().nonnegative()),
  memoryStrategy: z.enum(['session_only', 'project', 'global']),
  evalRigor: z.enum(['none', 'smoke', 'full']),
  complianceEnforcement: z.array(
    z.object({
      compliance: z.string(),
      layers: z.array(z.enum(['prompt', 'middleware', 'runtime', 'post_processing'])),
    }),
  ),
  approvedAt: z.string().datetime().optional(),
});
```

### 8.6 Section plan (Stage 3 output)

```ts
export const SectionPlanEntrySchema = z.object({
  sectionId: z.string(), // "1A", "3", "16", ...
  title: z.string(),
  included: z.boolean(),
  depth: z.enum(['compact', 'standard', 'deep']).optional(),
  estimatedLines: z.number().int().optional(),
  skipReason: z.string().optional(), // when included == false
});

export const SectionPlanSchema = z.object({
  preset: z.enum(['internal-dev', 'enterprise-poc', 'prod-launch']),
  sections: z.array(SectionPlanEntrySchema),
  totalEstimatedLines: z.number().int(),
  totalEstimatedSeconds: z.number().int(),
  approvedAt: z.string().datetime().optional(),
});
```

### 8.7 Per-agent specification (Blueprint authoring schema → runtime IR)

**CRITICAL:** The compiler/runtime is the source of truth. This schema is the Blueprint authoring contract that compiles to IR. Runtime-facing sub-shapes must mirror IR field names and enum values when the blueprint stores already-runtime-ready values; authoring-only fields must be called out in comments and converted by the renderer/compiler. Implementer note: before adding a field, read `packages/compiler/src/platform/ir/schema.ts` and decide whether the field is (a) a direct IR field, (b) a Blueprint-only deliverable field, or (c) an authoring convenience that must be transformed into IR.

```ts
export const PerAgentSpecSchema = z.object({
  // Identity (maps to AgentIdentity in schema.ts:878-896)
  name: z.string().min(1),
  agentType: z.enum(['native', 'human', 'external']).default('native'),
  archetype: z.enum(['supervisor', 'specialist', 'pipeline_stage', 'worker']),
  role: z.string().min(1),
  description: z.string().min(1),
  goal: z.string(), // identity.goal in IR
  language: z.string().optional(), // identity.language in IR (optional per schema.ts:895)
  limitations: z.array(z.string()), // identity.limitations in IR (schema.ts:886)

  // Persona (LLM-authored, sibling-aware)
  persona: z.object({
    voice: z.string(), // "warm, professional, efficient" (LLM-authored description)
    rationale: z.string(), // why this persona (Blueprint-only — not in IR)
    description: z.string(), // identity.persona in IR (schema.ts:883) — verbatim into LLM context
  }),

  // System prompt (maps to AgentIdentity.system_prompt: SystemPromptConfig at schema.ts:898-919)
  systemPrompt: z.object({
    template: z.string(), // core instruction template
    custom: z.boolean().optional(), // explicitly provided by user
    sections: z.object({
      context: z.boolean().optional(),
      tools: z.boolean().optional(),
      constraints: z.boolean().optional(),
      history: z.boolean().optional(),
    }),
    libraryRef: z
      .object({
        promptId: z.string(),
        versionId: z.string(),
        resolvedHash: z.string(),
      })
      .optional(),
  }),

  // Voice response rules (when voice channel)
  voiceResponseRules: z.string().optional(), // identity.voice_response_rules in IR

  // Model + complexity
  model: z.string(), // resolved from getModelRecommendation
  backupModel: z.string().optional(),
  executionMode: z.enum(['reasoning', 'scripted', 'hybrid']),
  contextWindow: z.number().int().positive().default(50),
  toolBudget: z.number().int().nonnegative(),

  // Tools (NAME REFS ONLY — bindings live in ProjectTool)
  tools: z.array(
    z.object({
      ref: z.string(), // tool name, resolves to ProjectTool by (tenantId, projectId, name)
      purpose: z.string(),
      when: z.string(), // when to call (CEL or 'always')
    }),
  ),

  // Gather schema (maps to GatherConfig in schema.ts:1280-1289)
  // CRITICAL: strategy is per-config, not per-field
  gather: z
    .object({
      strategy: z.enum(['llm', 'pattern', 'hybrid']), // matches runtime
      correctionPatterns: z.array(z.string()).optional(),
      fields: z.array(
        z.object({
          name: z.string().min(1),
          prompt: z.string(),
          type: z.string(), // IR GatherField.type is string; Studio may constrain allowed UI choices separately
          default: z.unknown().optional(),
          enumValues: z.array(z.string()).optional(),
          required: z.boolean().default(true),
          validation: ValidationRuleSchema.optional(),
          activation: z
            .union([
              z.enum(['required', 'optional', 'progressive']),
              z.object({ when: z.string() }), // CEL
            ])
            .optional(),
          dependsOn: z.array(z.string()).optional(), // compiles to IR depends_on
          infer: z.boolean().optional(),
          inferConfidence: z.number().min(0).max(1).optional(),
          inferConfirm: z.boolean().optional(),
          semantics: GatherFieldSemanticsSchema.optional(),
          range: z.boolean().optional(),
          list: z.boolean().optional(),
          preferences: z.boolean().optional(),
          promptMode: z.enum(['ask', 'extract_only']).optional(),
          sensitive: z.boolean().optional(),
          sensitiveDisplay: z.enum(['redact', 'mask', 'replace']).optional(),
          maskConfig: z
            .object({
              showFirst: z.number().int(),
              showLast: z.number().int(),
              char: z.string(),
            })
            .optional(),
          piiType: z
            .enum(['email', 'phone', 'ssn', 'credit_card', 'address', 'name', 'custom'])
            .optional(),
          transient: z.boolean().optional(),
          extractionPattern: z.string().optional(),
          extractionGroup: z.number().int().optional(),
          synonyms: z.record(z.array(z.string())).optional(),
          extractionHints: z.array(z.string()).optional(),
          entityRef: z.string().optional(),
          messageKey: z.string().optional(),
          voiceConfig: VoiceConfigSchema.optional(),
          richContent: z.unknown().optional(),
        }),
      ),
    })
    .optional(),

  // CONSTRAINTS (maps to Constraint in schema.ts:1547-1558)
  // Values mirror IR enums verbatim — DO NOT invent new ones
  // Validated at lock time against gather + memory paths
  constraints: z.array(
    z.object({
      condition: z.string(), // CEL — REQUIRED to parse
      // onFail is structured ConstraintAction (schema.ts:1566-1585), not a bare enum
      onFail: z.object({
        type: z.enum([
          'respond',
          'escalate',
          'handoff',
          'block',
          'redact',
          'retry_step',
          'goto_step',
          'collect_field',
        ]),
        message: z.string().optional(),
        target: z.string().optional(),
        reason: z.string().optional(),
        collectFields: z.array(z.string()).optional(),
        thenAction: z.enum(['continue', 'retry']).optional(),
        thenStep: z.string().optional(),
      }),
      severity: z.enum(['error', 'warning']).optional(), // IR: schema.ts:1551
      kind: z.enum(['require', 'limit', 'restrict']).optional(), // IR: schema.ts:1553
      appliesWhen: z.string().optional(), // CEL — schema.ts:1555
      // ConstraintCheckpoint (schema.ts:1561-1564) — structured, not a bare enum
      checkpoint: z
        .object({
          kind: z.enum(['tool_call', 'response']),
          target: z.string().optional(),
        })
        .optional(),
    }),
  ),

  // GUARDRAILS overrides (governance has shared)
  guardrailOverrides: z.array(GuardrailSchema).optional(),

  // COMPLETE (maps to CompletionConfig in schema.ts:1775-1786)
  complete: z.object({
    conditions: z.array(
      z.object({
        when: z.string(), // CEL — REQUIRED to parse
        respond: z.string().optional(),
        voiceConfig: VoiceConfigSchema.optional(),
        richContent: z.unknown().optional(),
        actions: z.array(z.unknown()).optional(),
        store: z.string().optional(), // IR: schema.ts:1785 — single string, NOT a record
      }),
    ),
  }),

  // Memory (maps to MemoryConfig in schema.ts:1469-1533)
  memory: z.object({
    session: z
      .array(
        z.object({
          name: z.string(),
          type: z.string().optional(), // IR: schema.ts:1486 — optional
          description: z.string().optional(), // IR: schema.ts:1487
          initialValue: z.unknown().optional(),
          reset: z.enum(['per_session', 'per_step', 'never']).optional(), // IR: schema.ts:1490 — optional
        }),
      )
      .optional(),
    persistent: z
      .array(
        z.object({
          path: z.string(),
          description: z.string().optional(), // IR: schema.ts:1495
          scope: z.enum(['user', 'project', 'execution_tree']),
          access: z.enum(['read', 'write', 'readwrite']), // IR: schema.ts:1498 — NO underscore
          type: z.enum(['string', 'number', 'boolean', 'date', 'array', 'object']).optional(), // IR: schema.ts:1500
          unit: z.string().optional(),
          defaultValue: z.unknown().optional(),
          sensitive: z.boolean().optional(),
          sensitiveDisplay: z.enum(['redact', 'mask', 'replace']).optional(), // IR: schema.ts:1508
          maskConfig: z
            .object({
              showFirst: z.number().int(),
              showLast: z.number().int(),
              char: z.string(),
            })
            .optional(), // IR: schema.ts:1510
        }),
      )
      .optional(),
    remember: z
      .array(
        z.object({
          when: z.string(), // CEL
          store: z.object({
            value: z.string(),
            target: z.string(),
          }),
          ttl: z.string().optional(), // IR: schema.ts:1519 — STRING (e.g. "1h", "30d"), NOT number
        }),
      )
      .optional(),
    // RecallInstruction (schema.ts:1528-1533) with discriminated RecallAction (schema.ts:1523-1526)
    recall: z
      .array(
        z.object({
          event: z.string(),
          instruction: z.string(),
          action: z
            .discriminatedUnion('type', [
              z.object({ type: z.literal('inject_context'), paths: z.array(z.string()) }),
              z.object({ type: z.literal('load_memory'), domain: z.string().optional() }),
              z.object({ type: z.literal('prompt_llm'), instruction: z.string() }),
            ])
            .optional(),
        }),
      )
      .optional(),
  }),

  // HANDOFFS (Blueprint authoring view; topology.edges is canonical structural)
  // Compiles to CoordinationConfig.handoffs[] / delegates[] in schema.ts:1643-1728.
  // The edge `type` lives in topology.edges; this per-agent view stores runtime handoff behavior.
  handoffs: z.array(
    z.object({
      to: z.string(), // agent name (must exist in topology.agents)
      when: z.string(), // canonical CEL — REQUIRED to parse
      context: z.object({
        pass: z.array(
          z.object({
            name: z.string(),
            type: z.string(),
            description: z.string().optional(),
          }),
        ),
        summary: z.string(),
        memoryGrants: z
          .array(
            z.object({
              path: z.string(),
              access: z.enum(['read', 'readwrite']),
            }),
          )
          .optional(),
        history: z
          .union([
            z.enum(['auto', 'none', 'summary_only', 'full']),
            z.object({ lastN: z.number().int().positive() }),
          ])
          .optional(),
      }),
      return: z.boolean(),
      onFailure: z.enum(['continue', 'escalate', 'respond']).optional(),
      failureMessage: z.string().optional(),
      onReturn: z
        .union([
          z.string(),
          z.object({
            action: z.string().optional(),
            handler: z.string().optional(),
            map: z.record(z.string()).optional(),
          }),
        ])
        .optional(),
      remote: RemoteAgentLocationSchema.optional(),
      timeout: z.string().optional(),
      onTimeout: z.string().optional(),
      async: z.boolean().optional(),
      asyncTimeout: z.number().int().positive().optional(),
    }),
  ),

  // FLOW steps (when executionMode != 'reasoning')
  // Aligned to FlowConfig + FlowStep in schema.ts:2114-2531
  flow: z
    .object({
      entryPoint: z.string().optional(), // default = first step
      steps: z.array(FlowStepSchema), // see 8.8
      globalDigressions: z.array(DigressionSchema).optional(),
    })
    .optional(),

  // ON_ERROR (maps to ErrorHandlingConfig in schema.ts:1792-1815)
  // ErrorHandler shape (schema.ts:1797-1815) — IR field types verbatim
  onError: z.object({
    handlers: z.array(ErrorHandlerSchema),
    defaultHandler: ErrorHandlerSchema, // IR: schema.ts:1794 — full ErrorHandler, not a slim variant
  }),

  // Mock behavior (POC + dev only)
  mockBehavior: z.string().optional(),
});

// ErrorHandler — used by both onError.handlers[] and onError.defaultHandler
// Maps to ErrorHandler at schema.ts:1797-1815
export const ErrorHandlerSchema = z.object({
  type: z.string(), // error type (e.g. 'tool_error', 'timeout', 'validation_error')
  subtypes: z.array(z.string()).optional(), // e.g. 'credit_card_declined'
  respond: z.string().optional(),
  voiceConfig: VoiceConfigSchema.optional(),
  richContent: z.unknown().optional(),
  actions: z.array(z.unknown()).optional(),
  retry: z.number().int().nonnegative().optional(), // IR: schema.ts:1805 — NUMERIC count, not boolean
  retryDelayMs: z.number().int().nonnegative().optional(),
  retryBackoff: z.enum(['fixed', 'exponential', 'linear']).optional(), // IR: schema.ts:1808 — must include 'fixed'
  retryMaxDelayMs: z.number().int().nonnegative().optional(), // IR: schema.ts:1810
  // 'then' is REQUIRED in IR (schema.ts:1811) — drives the recovery action after handler runs
  then: z.enum(['continue', 'escalate', 'handoff', 'complete', 'backtrack', 'retry_step']),
  handoffTarget: z.string().optional(), // required when then === 'handoff'
  backtrackTo: z.string().optional(), // required when then === 'backtrack'
});
```

### 8.8 FlowStep schema (aligned to runtime)

**CRITICAL:** Only step kinds actually consumed by `flow-step-executor.ts` (runtime) are emittable. `human_approval` is in the IR but has no runtime consumer (`schema.ts:2281` but no consumer in `flow-step-executor.ts`) — **excluded from renderer**.

```ts
export const FlowStepSchema = z.object({
  name: z.string(), // step name (referenced by then:, on_input:then, etc.)
  kind: z.enum([
    'reasoning', // REASONING: true with INSTRUCTIONS, available_tools, exit_when, max_turns
    'gather', // GATHER: {fields, strategy, prompt, complete_when, corrections}
    'present', // PRESENT: Handlebars template
    'set', // SET: variable assignments
    'clear', // CLEAR: paths
    'transform', // TRANSFORM: source/item_var/target/filter/map/sort_by/limit
    'call', // CALL: tool with input/output/success_when
    'check', // CHECK: CEL with on_fail
    'respond', // RESPOND: text + optional rich content
    'await_attachment', // AWAIT_ATTACHMENT: variable, prompt, category, required, timeout
  ]),
  // kind-specific fields:
  reasoningZone: ReasoningZoneSchema.optional(),
  gather: FlowGatherConfigSchema.optional(),
  present: z.string().optional(),
  set: z
    .array(
      z.object({
        variable: z.string(),
        expression: z.string(), // CEL
      }),
    )
    .optional(),
  clear: z.array(z.string()).optional(),
  transform: TransformConfigSchema.optional(),
  call: z.string().optional(),
  callWith: z.record(z.string()).optional(),
  callAs: z.string().optional(),
  successWhen: z.string().optional(), // CEL
  check: z.string().optional(), // CEL
  onFail: z.string().optional(), // step name to jump to
  respond: z.string().optional(),
  messageKey: z.string().optional(),
  voiceConfig: VoiceConfigSchema.optional(),
  richContent: z.unknown().optional(),
  actions: z.array(z.unknown()).optional(),
  awaitAttachment: AwaitAttachmentSchema.optional(),
  // Branching:
  onSuccess: CallResultBlockSchema.optional(),
  onFailure: CallResultBlockSchema.optional(),
  onInput: z.array(InputBranchSchema).optional(), // IF/ELSE branches (CEL conditions)
  onResult: z.array(InputBranchSchema).optional(), // post-CALL or no-CALL gate
  // Digressions (intent-based escapes):
  digressions: z.array(DigressionSchema).optional(),
  subIntents: z.array(SubIntentSchema).optional(),
  // Transitions:
  then: z.string().optional(), // target step name or 'COMPLETE'
  onError: z.array(z.unknown()).optional(),
});

export const ReasoningZoneSchema = z.object({
  goal: z.string().optional(), // falls back to identity.goal
  availableTools: z.array(z.string()).optional(), // intersected with agent.tools at runtime
  exitWhen: z.string().optional(), // CEL
  maxTurns: z.number().int().positive().default(10),
  constraints: z.array(z.string()).optional(), // IR ReasoningZoneIR.constraints
});

export const InputBranchSchema = z.object({
  condition: z.string().optional(), // CEL (omit for else branch)
  respond: z.string().optional(),
  set: z.record(z.string()).optional(),
  call: z.string().optional(),
  then: z.string(), // target step or 'COMPLETE'
});
```

### 8.9 Governance schema

```ts
export const GovernanceSchema = z.object({
  appProfile: z.object({
    name: z.string(),
    description: z.string(),
    defaultModel: z.string(),
    backupModel: z.string().optional(),
    contextWindowLimit: z.number().int(),
    externalAgentToggle: z.boolean().default(false),
    voiceToVoiceToggle: z.boolean().default(false),
  }),

  channels: z.array(
    z.object({
      name: z.enum(['voice', 'chat', 'email', 'sms', 'webhook']),
      primary: z.boolean(),
      languages: z.array(z.string()),
      config: z.record(z.unknown()).optional(),
    }),
  ),

  voiceStack: z
    .object({
      pipeline: z.enum(['asr-llm-tts', 'speech-to-speech']),
      asr: z.object({
        engine: z.string(),
        endpointingMs: z.number(),
      }),
      tts: z.object({
        engine: z.string(),
        voice: z.string(),
        streaming: z.boolean(),
      }),
      fallbackTts: z
        .object({
          engine: z.string(),
          voice: z.string(),
        })
        .optional(),
      bargeIn: z.boolean(),
      botNoInput: z.object({
        timeoutSec: z.number(),
        retries: z.number(),
        giveUpSec: z.number(),
      }),
    })
    .optional(),

  callControl: z
    .object({
      primaryScriptNode: z.string(), // JS code block as string
      fallbackScriptNode: z.string().optional(),
      emergencyFallbackScriptNode: z.string().optional(),
      configurationLevels: z.record(z.enum(['node', 'flow', 'channel'])),
    })
    .optional(),

  events: z.array(
    z.object({
      name: z.enum(['welcome', 'agent_handoff', 'end_of_conversation', 'silence', 'error']),
      enabled: z.boolean(),
      type: z.enum(['ai_generated', 'static']),
      config: z.record(z.unknown()),
    }),
  ),

  sharedBehavioralInstructions: z.string().optional(),

  guardrails: z.array(GuardrailSchema),

  evalCriteria: z.array(
    z.object({
      dimension: z.string(),
      rubric: z.string(),
      weight: z.number().min(0).max(1),
      perAgent: z.record(z.string()).optional(),
    }),
  ),

  sensitivity: z.enum(['none', 'standard', 'pii', 'pci', 'phi', 'mixed']),

  autoQa: z
    .object({
      enabled: z.boolean(),
      dimensions: z.array(z.string()),
      sampleRate: z.number().min(0).max(1),
    })
    .optional(),

  agentAssist: z
    .object({
      enabled: z.boolean(),
      summaryTemplate: z.string(), // structured handoff JSON template
      fields: z.array(z.string()),
    })
    .optional(),

  demoScript: z
    .object({
      wowMoments: z.array(
        z.object({
          title: z.string(),
          description: z.string(),
        }),
      ),
      scenarios: z.array(
        z.object({
          name: z.string(),
          turns: z.array(
            z.object({
              caller: z.string(),
              agent: z.string(),
              seNotes: z.string().optional(),
            }),
          ),
        }),
      ),
      alternateLines: z.array(
        z.object({
          scenario: z.string(),
          variant: z.string(),
          text: z.string(),
        }),
      ),
    })
    .optional(),

  compliance: z.array(z.enum(['hipaa', 'pci', 'soc2', 'gdpr', 'ccpa', 'fedramp'])),

  platformPillars: z
    .array(
      z.object({
        pillar: z.string(),
        whereDemonstrated: z.string(),
        whatAudienceSees: z.string(),
      }),
    )
    .optional(),

  noInputHandling: z
    .object({
      timeoutSec: z.number(),
      retries: z.number(),
      promptText: z.string(),
    })
    .optional(),

  waitingExperience: z
    .object({
      fillerPhrases: z.array(z.string()),
      holdMessages: z.array(z.string()),
    })
    .optional(),

  contextManagement: z
    .object({
      slidingWindowSize: z.number().int(),
      summarizationStrategy: z.enum(['none', 'last_n', 'rolling_summary']),
      historySummaryFields: z
        .object({
          maxAnswers: z.number().int(),
          maxDecisions: z.number().int(),
          maxToolOutcomes: z.number().int(),
          maxOpenThreads: z.number().int(),
        })
        .optional(),
    })
    .optional(),

  // prod-launch preset only:
  deployment: z
    .object({
      envVars: z.array(
        z.object({
          name: z.string(),
          description: z.string(),
          secret: z.boolean(),
        }),
      ),
      secrets: z.array(
        z.object({
          vaultPath: z.string(),
          rotation: z.string(),
        }),
      ),
      rollout: z.object({
        strategy: z.enum(['canary', 'blue_green', 'rolling']),
        canaryPercent: z.number().optional(),
        successCriteria: z.array(z.string()),
      }),
    })
    .optional(),
  observability: z
    .object({
      dashboards: z.array(
        z.object({
          name: z.string(),
          url: z.string(),
        }),
      ),
      alerts: z.array(
        z.object({
          name: z.string(),
          condition: z.string(),
          severity: z.string(),
        }),
      ),
      runbook: z.array(
        z.object({
          alert: z.string(),
          recovery: z.string(),
        }),
      ),
    })
    .optional(),
});
```

### 8.10 Integrations schema

**v1 SCOPE NOTE:** Tool bootstrap supports `'http'` only in v1. Other tool types (`'mcp' | 'sandbox' | 'lambda' | 'connector' | 'workflow' | 'searchai' | 'async_webhook' | 'function' | 'mock'`) require their own bootstrap path verification (today's `tool-bootstrap-synthesizer.ts:283-356` handles only HTTP and silently records others as `unsupported[]`). The schema **accepts** non-HTTP refs ONLY when they reference an _existing_ Project Tool by `id` — bootstrap descriptors are restricted to `'http'`. Non-HTTP bootstrap is a separate **v1.5 milestone** (see §16.1) — once each tool type's CREATE-time provisioning + runtime binding is verified end-to-end.

```ts
export const IntegrationsSchema = z.object({
  // Project Tools — resolved (existing) or bootstrap descriptor (to create)
  tools: z.array(
    z.object({
      id: z.string().optional(), // existing Project Tool ID — any tool_type allowed when set
      name: z.string(),
      bootstrapDescriptor: z
        .object({
          name: z.string(),
          // v1: HTTP only. Other types must reference an existing Project Tool via `id`.
          // v1.5+ will widen this enum after each type's bootstrap path is verified.
          type: z.literal('http'),
          auth: z.string().optional(),
          input: z.record(z.unknown()),
          output: z.record(z.unknown()),
          mockBehavior: z.string().optional(),
        })
        .optional(), // if not existing
    }),
  ),

  searchAi: z
    .object({
      knowledgeSources: z.array(z.string()),
      profiles: z.array(
        z.object({
          name: z.string(),
          config: z.record(z.unknown()),
        }),
      ),
    })
    .optional(),

  externalSystems: z.array(
    z.object({
      name: z.string(),
      type: z.string(),
      authPattern: z.string(),
    }),
  ),

  entrypoints: z.array(
    z.object({
      type: z.enum(['phone', 'web', 'email', 'webhook']),
      config: z.record(z.unknown()),
    }),
  ),
});
```

### 8.11 Section approvals

```ts
export const SectionApprovalSchema = z.object({
  sectionId: z.string(),
  status: z.enum(['pending', 'draft', 'approved', 'skipped', 'validation_failed', 'generating']),
  approvedAt: z.string().datetime().optional(),
  revisionCount: z.number().int().nonnegative().default(0),
  lastEditedBy: z.string().optional(),
  generatedContent: z.string().optional(), // CHECKPOINT — persisted after each LLM completion
  validationErrors: z
    .array(
      z.object({
        code: z.string(),
        message: z.string(),
        field: z.string().optional(),
      }),
    )
    .optional(),
});
```

### 8.12 Validation report

```ts
export const ValidationReportSchema = z.object({
  lastRunAt: z.string().datetime(),
  passing: z.boolean(),
  errors: z.array(
    z.object({
      section: z.string(),
      code: z.string(), // BV-001, BV-002, ...
      message: z.string(),
      field: z.string().optional(),
    }),
  ),
  warnings: z.array(
    z.object({
      section: z.string(),
      code: z.string(),
      message: z.string(),
    }),
  ),
});
```

### 8.13 Attachment context

```ts
export const AttachmentContextSchema = z.object({
  pinnedAttachments: z.array(
    z.object({
      blobId: z.string(),
      name: z.string(),
      mimeType: z.string(),
      sizeBytes: z.number().int(),
      summary: z.string().optional(), // chunked summary for >20KB files
      pinnedAtSection: z.string().optional(), // which section context this informs
    }),
  ),
});
```

### 8.14 Validation rules at lock time

| Code   | Rule                                                                                                                                                                                                                                           |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| BV-001 | Every `topology.edges[].when` parses as CEL via `evaluateConditionDual`                                                                                                                                                                        |
| BV-002 | Every `perAgent[*].handoffs[*].to` exists in `topology.agents`                                                                                                                                                                                 |
| BV-003 | Every `perAgent[*].constraints[*].condition` references only declared `gather.fields[*].name` or `memory.*` paths                                                                                                                              |
| BV-004 | Every `perAgent[*].complete.conditions[*].when` references only declared `gather.fields[*].name`                                                                                                                                               |
| BV-005 | Every `perAgent[*].tools[*].ref` resolves to `integrations.tools[*]` (existing or bootstrap)                                                                                                                                                   |
| BV-006 | `topology.entryPoint` exists in `topology.agents`                                                                                                                                                                                              |
| BV-007 | `buildOrder` computed via Kahn over `topology.edges` succeeds (or `allowCycle: true` per edge)                                                                                                                                                 |
| BV-008 | Every `perAgent[*].guardrailOverrides[*].category` references `governance.guardrails[*].category`                                                                                                                                              |
| BV-009 | Every `compliance` value has matching `governance.guardrails` entry                                                                                                                                                                            |
| BV-010 | `governance.voiceStack` present iff any `governance.channels[].name === 'voice'`                                                                                                                                                               |
| BV-011 | Every `perAgent[*].handoffs[*].context.pass[*].name` references declared gather/memory paths                                                                                                                                                   |
| BV-012 | All `gather.fields[*].dependsOn` form a DAG (no cycles)                                                                                                                                                                                        |
| BV-013 | Supervisor archetypes have a catch-all HANDOFF (`when: "true"`)                                                                                                                                                                                |
| BV-014 | Every `perAgent[*].flow.steps[*].reasoning_zone.availableTools` is a subset of `perAgent[*].tools[*].ref`                                                                                                                                      |
| BV-015 | Every `FlowStep.then` references a step name in `steps[]` or equals `COMPLETE`                                                                                                                                                                 |
| BV-016 | Every `perAgent[*].memory.persistent[*].path` matches `MEMORY:` declarations referenced in `remember[*].store.target` or `recall[*].instruction`                                                                                               |
| BV-017 | `gather.strategy` is one of `llm \| pattern \| hybrid` (not `'as_needed'` etc. — invented values rejected)                                                                                                                                     |
| BV-018 | `perAgent[*].flow.steps` does NOT include `human_approval` kind (unverified at runtime)                                                                                                                                                        |
| BV-019 | `metadata.sourceHash` present and 64 hex chars (for IR cache round-trip)                                                                                                                                                                       |
| BV-020 | If `enterprise-poc` preset: `governance.platformPillars` non-empty and `specification.competitiveContext` present                                                                                                                              |
| BV-021 | Every `perAgent[*].constraints[*].onFail.type === 'goto_step'` has a non-empty `onFail.thenStep` referencing an existing step name                                                                                                             |
| BV-022 | Every `perAgent[*].constraints[*].onFail.type === 'collect_field'` has a non-empty `onFail.collectFields[]`                                                                                                                                    |
| BV-023 | Every `perAgent[*].constraints[*].onFail.type === 'handoff'` has a non-empty `onFail.target` referencing an existing agent                                                                                                                     |
| BV-024 | Every `perAgent[*].onError.handlers[*]` and `perAgent[*].onError.defaultHandler` has a `then` value (required field per IR)                                                                                                                    |
| BV-025 | When `onError.handlers[*].then === 'handoff'` then `handoffTarget` is set; when `then === 'backtrack'` then `backtrackTo` is set                                                                                                               |
| BV-026 | Every `perAgent[*].memory.persistent[*].access` is one of `read \| write \| readwrite` (no underscore — IR enum verbatim)                                                                                                                      |
| BV-027 | Every `perAgent[*].memory.remember[*].ttl` parses as a duration string (e.g. `"1h"`, `"30d"`) — NOT a number                                                                                                                                   |
| BV-028 | Every `perAgent[*].complete.conditions[*].store` (when present) is a single string, NOT a record                                                                                                                                               |
| BV-029 | If `integrations.tools[*].bootstrapDescriptor` is set, then `bootstrapDescriptor.type === 'http'` (v1 scope; v1.5 widens)                                                                                                                      |
| BV-030 | If a project is in v2-canonical mode (`Project.archConfig.canonicalBlueprintMode === true`, new field added in §13.9), every `ProjectAgent.dslContent` write must originate from a blueprint render (rejected at the mutation layer otherwise) |

If any rule fires, the relevant section reopens for refinement; BLUEPRINT cannot exit.

---

## 9. The BUILD Compiler (Variant 3 — Pure Renderer)

### 9.1 I/O contract

```
INPUT:                                      OUTPUT:
─────                                       ──────
{                                           {
  blueprint: BlueprintOutput   (locked)       agents: {
  // schema version 2.0                         [name]: {
  // validation.passing == true                   ablDsl: string,
  // all CEL parses, all refs                     compiledOk: boolean,
  // resolve, all paths declared                  warnings: string[],
}                                                 errors: string[]
                                                }
                                              },
                                              tools: {
                                                [name]: {
                                                  toolDsl: string,
                                                  ref: 'existing' | 'bootstrap'
                                                }
                                              },
                                              buildMeta: {
                                                durationMs: number,
                                                renderedAt: string,
                                                sourceHash: string
                                              }
                                            }
```

Compiler is a **pure function over locked `BlueprintOutput`**. Failure means renderer bug or schema gap, not user error. **Zero LLM calls.**

### 9.2 The renderer suite

Located at `packages/arch-ai/src/compiler/renderers/`. Every renderer is a typed, sync, no-I/O pure function. Each is unit-testable in isolation.

```ts
export interface RendererContext {
  agent: PerAgentSpec;
  blueprint: BlueprintOutput;
  topology: TopologyOutput;
}

// 13 renderer functions, one per ABL section:
export function renderHeader(ctx: RendererContext): string;
export function renderPersona(ctx: RendererContext): string;
export function renderGoal(ctx: RendererContext): string;
export function renderGather(ctx: RendererContext): string;
export function renderGuardrails(ctx: RendererContext): string;
export function renderMemory(ctx: RendererContext): string;
export function renderTools(ctx: RendererContext): string;
export function renderHandoff(ctx: RendererContext): string;
export function renderConstraints(ctx: RendererContext): string;
export function renderFlow(ctx: RendererContext): string; // mode-dependent dispatch
export function renderComplete(ctx: RendererContext): string;
export function renderOnError(ctx: RendererContext): string;
export function renderToolDsl(descriptor: BootstrapDescriptor): string;

// Top-level orchestrator:
export function renderAgent(ctx: RendererContext): string;
```

### 9.3 FLOW renderer (mode-dependent)

The most interesting renderer. Branches on `agent.executionMode`:

#### `reasoning` mode → no FLOW section

```abl
# (FLOW omitted entirely — agent runs on PERSONA + GOAL + TOOLS + HANDOFF)
```

#### `scripted` mode → full FLOW with explicit step sequence

Generated from `flow.steps[]`:

```abl
FLOW:
  ENTRY_POINT: collect_payment

  - NAME: collect_payment
    GATHER:
      FIELDS: [payment_type, amount, payment_method]
      STRATEGY: llm
    THEN: collect_cvv

  - NAME: collect_cvv
    GATHER:
      FIELDS: [cvv]
      STRATEGY: pattern
    THEN: authorize

  - NAME: authorize
    GATHER:
      FIELDS: [authorization]
    CHECK: authorization == "yes"
    ON_FAIL: cancel
    THEN: submit

  - NAME: submit
    CALL: submit_payment
    CALL_WITH:
      type: payment_type
      amount: amount
      method: payment_method
      cvv: cvv
    CALL_AS: payment_result
    ON_SUCCESS:
      RESPOND: "Payment {payment_result.confirmation_number} processed."
      THEN: send_receipt
    ON_FAILURE:
      RESPOND: "Payment failed. Let me connect you with a specialist."
      THEN: escalate

  - NAME: send_receipt
    CALL: send_receipt
    CALL_WITH:
      email: session.email
      ref: payment_result.confirmation_number
    THEN: COMPLETE

  - NAME: cancel
    RESPOND: "Payment cancelled at your request."
    THEN: COMPLETE

  - NAME: escalate
    # ... escalation step
```

Generated deterministically from `flow.steps[]`. The renderer maps each `FlowStep` to ABL constructs 1:1.

#### `hybrid` mode → mixed REASONING + scripted FLOW

```abl
FLOW:
  ENTRY_POINT: classify

  - NAME: classify
    REASONING: true
    INSTRUCTIONS: |
      Classify the user's intent into one of: billing_question, payment_request, escalation, other.
    THEN: route

  - NAME: route
    REASONING: false
    ON_INPUT:
      - IF: intent.category == "billing_question"
        THEN: handoff_variance
      - IF: intent.category == "payment_request"
        THEN: handoff_payment
      - IF: intent.category == "escalation"
        THEN: escalate
      - ELSE:
        THEN: free_response

  - NAME: free_response
    REASONING: true
    GOAL: "Answer the user using available tools"
    AVAILABLE_TOOLS: [search_kb, lookup_account]
    EXIT_WHEN: intent_resolved == true
    MAX_TURNS: 5
    THEN: COMPLETE

  # handoff_variance, handoff_payment, escalate steps render same way as scripted
```

The renderer emits REASONING blocks with `INSTRUCTIONS:`, `AVAILABLE_TOOLS:`, `EXIT_WHEN:`, `MAX_TURNS:` from the structured `reasoningZone` fields.

### 9.4 Tool DSL renderer

`integrations.tools[]` resolves to:

- **`id` set** → existing Project Tool, no DSL emission needed (just reference)
- **`bootstrapDescriptor` set** → emit a tool DSL block ready for `addToolToProject` during CREATE

```ts
function renderToolDsl(descriptor: BootstrapDescriptor): string;
```

In v1, this subsumes only the HTTP bootstrap subset of today's scattered `tool-bootstrap-synthesizer` + `synthesizeOnboardingBootstrapTools` logic. Non-HTTP tools (`mcp`, `function`, `mock`, `sandbox`, `lambda`, `connector`, `workflow`, `searchai`, `async_webhook`) are **not bootstrapped by the renderer in v1**; they may be referenced only when `integrations.tools[*].id` points to an existing Project Tool. The renderer must surface a validation error if a non-HTTP bootstrap descriptor is requested. Non-HTTP bootstrap becomes first-class only in the v1.5 milestone after each type's CREATE-time provisioning and runtime binding are verified end-to-end.

### 9.5 Validation: one sanity-check pass

After all renderers run, call `compile_abl` once per agent's DSL string. Two outcomes:

| Outcome           | Action                                                                                                                           |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| All compile clean | Mark agents `compiled`, advance to `BuildComplete` widget                                                                        |
| Any compile error | Mark agent `error`, surface error with section + agent context, **block CREATE**. No retry. User revises Blueprint and re-locks. |

If `compile_abl` fails on a renderer-produced DSL, that's a **renderer bug**. Log + surface to user as "Build failed — internal compiler issue, not your blueprint" with the failing section name. Prevents the user from churning trying to "fix their blueprint" when the bug is ours.

### 9.6 BuildComplete widget — simplified

| State       | Today                                   | Proposed                                                                                                      |
| ----------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| All clean   | `[create, tools, modify, review]`       | `[create, view, modify, review]`                                                                              |
| Some warn   | `[create, fix_warnings, tools, modify]` | `[create, view warnings, modify]` (warnings rare — Blueprint validation catches most pre-build)               |
| Some err    | `[retry, modify, back]`                 | n/a — errors rare; surface as renderer bug                                                                    |
| All err     | `[retry_all, back]`                     | n/a                                                                                                           |
| Compile err | n/a                                     | `[revise blueprint, view error, contact support]` (rare — indicates renderer bug or Blueprint-validation gap) |

`retry`, `retry_all`, `fix_warnings` actions disappear. The fix path goes through Blueprint, not BUILD.

### 9.7 Performance characteristics

| Metric                            | Today                                     | Proposed                         |
| --------------------------------- | ----------------------------------------- | -------------------------------- |
| Build time, 1 agent               | 30s–2min                                  | 1–2s (renderer + sanity compile) |
| Build time, 4 agents (parallel)   | 2–5min                                    | 2–4s                             |
| LLM calls per build               | N agents × (1 + retries) = ~12 worst case | 0                                |
| Failure rate                      | ~15–40% (need fix loop)                   | <1% (renderer bugs only)         |
| Cost per build (4 agents, GPT-4o) | $0.40–$2.00                               | $0 (renderer)                    |

### 9.8 Compiler package layout

```
packages/arch-ai/src/compiler/
├── index.ts                         # public API: compile(blueprint) → BuildOutput
├── driver.ts                        # parallel orchestration + sanity check
├── renderers/
│   ├── index.ts                     # barrel
│   ├── header.ts
│   ├── persona.ts
│   ├── goal.ts
│   ├── gather.ts
│   ├── guardrails.ts
│   ├── memory.ts
│   ├── tools.ts
│   ├── handoff.ts
│   ├── constraints.ts
│   ├── flow.ts                      # mode-dependent dispatch
│   ├── flow-scripted.ts
│   ├── flow-hybrid.ts
│   ├── flow-reasoning.ts            # mostly returns empty
│   ├── complete.ts
│   ├── on-error.ts
│   └── tool-dsl.ts
├── validators/
│   └── compile-sanity.ts            # wraps existing compile_abl
└── __tests__/
    ├── renderers/
    │   └── *.test.ts                # one test file per renderer, pure-function tests, no mocks
    └── property-based/
        └── round-trip.test.ts        # random BlueprintOutput → render → compile → must succeed
```

Every renderer testable as a pure function — fits the project's "no mocking platform components" rule cleanly.

---

## 10. 12-Layer LLM Hallucination Defense

The current architecture has **one fat retry loop** at BUILD time that catches everything through compile errors. The new architecture has **12 thinner defense layers** distributed across BLUEPRINT (where errors are cheap to fix) and BUILD (where errors must not occur). The same defensive total work happens, but distributed and structurally constrained.

### 10.1 The 12 layers

| #       | Layer                                          | Where                          | Catches                                                                                                               | Source pattern                                                                      |
| ------- | ---------------------------------------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| **L1**  | Structured-output schema enforcement           | BLUEPRINT per-section LLM call | Hallucinated field names, missing required fields, wrong types — LLM literally can't produce invalid JSON             | Existing — `generateObject` from AI SDK + Zod (used in `scaffold/slot-fix-loop.ts`) |
| **L2**  | Per-section semantic validators                | BLUEPRINT after each LLM call  | Structurally valid but semantically wrong (empty goal, persona too short, CEL parse fail, ref to undeclared variable) | Existing — pattern in `scaffold/slot-validators.ts:16-102`                          |
| **L3**  | Per-section LLM retry with structured feedback | BLUEPRINT after L2 fails       | Issues the LLM can fix on retry given Zod path + semantic hint + previous value                                       | Existing — `scaffold/slot-fix-loop.ts:113`, `maxRetriesPerSlot: 3`                  |
| **L4**  | Fallback default on retry exhaustion           | BLUEPRINT after L3 exhausts    | Irrecoverable LLM failure → ship baseline default + warning                                                           | Existing — `FALLBACK_DEFAULTS` at `scaffold/slot-fix-loop.ts:84-88`                 |
| **L5**  | Cross-section consistency at write time        | BLUEPRINT on section approval  | Drift between sections (e.g., §8 references gather field that §3 didn't declare)                                      | New — small validator suite                                                         |
| **L6**  | Lock-time validation gauntlet                  | BLUEPRINT before exit to BUILD | Anything that survived L1–L5 (final BV-001..BV-020 rules)                                                             | New — extends `cross-agent-validator.ts:33-136` semantics                           |
| **L7**  | User-in-the-loop section approvals             | BLUEPRINT every section        | Subjective drift only the user can catch                                                                              | New surface, follows existing widget pattern                                        |
| **L8**  | Renderer precondition assertions               | BUILD start of each renderer   | Schema migration / hand-edit corruption / Blueprint validation gap (locked struct doesn't pass renderer's Zod parse)  | New — top of each render fn                                                         |
| **L9**  | Sanity compile after render                    | BUILD after renderer           | Renderer YAML emission bug (wrong indent, missing colon)                                                              | Existing — wraps `compile_abl`                                                      |
| **L10** | Locked-topology mutation guard                 | BUILD entry                    | Direct DB edit / race condition altering locked topology                                                              | New — runtime invariant check                                                       |
| **L11** | Schema migration guard                         | Session resume                 | V1 BLUEPRINT schema resumed under V2                                                                                  | New — `blueprintSchemaVersion` + migrator                                           |
| **L12** | Property-based renderer tests in CI            | CI build                       | Renderer bugs before they ship to prod                                                                                | New — random valid `BlueprintOutput` → render → must compile                        |

### 10.2 Comparison: today vs proposed

|                                             | **Today**                                                                            | **Proposed**                                                                                                                                 |
| ------------------------------------------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Where errors caught                         | BUILD only (after full agent generated)                                              | BLUEPRINT per section + lock-time + BUILD render                                                                                             |
| LLM call shape                              | Free-text ABL generation via `streamText` + `generate_agent` tool                    | Structured object generation via `generateObject` + Zod schema                                                                               |
| Failure mode if LLM produces invalid output | Compile error → re-prompt with verbatim error                                        | Schema mismatch → SDK auto-retries until shape matches                                                                                       |
| Retry budget per agent                      | Worst case ~12 LLM calls (3 worker × 3 fix-loop + reconciliation)                    | Per-section: 1 + 3 retries; agent has ~10 sections so ~40 max — but each call is small and most pass first try                               |
| Retry feedback shape                        | Compiler error verbatim ("CO-02: gather has no consumer")                            | Zod issue with semantic hint ("field `gather[2].name` references undeclared memory path; declare it in `memory[]` or remove the dependency") |
| User visibility into errors                 | Final BuildComplete widget — see status per agent                                    | Per-section approval gate — user sees and can refine each section                                                                            |
| User can fix without rebuilding             | No — must wait for full retry cycle                                                  | Yes — refine the section in chat, no agent regeneration needed                                                                               |
| Failure surface (build never starts)        | Pre-spawn topology blocker only                                                      | Lock-time gauntlet (much wider)                                                                                                              |
| Symptomatic recovery layers                 | 11 reactive layers (false-error recovery, regression detection, normalization, etc.) | Eliminated — input contract is closed                                                                                                        |
| Build success rate                          | 60–85% historical (estimate, not measured)                                           | ≥95% target — defense-in-depth ensures structural validity by construction                                                                   |
| Build duration on failure                   | 30s–5min per attempt × 3 attempts                                                    | Section refinement in chat takes seconds; build itself is always fast                                                                        |
| Build duration on success                   | 30s–2min per agent                                                                   | 2–10 seconds total (parallel renders, no LLM)                                                                                                |

### 10.3 Residual risks honestly catalogued

| Risk                                                                                                 | Likelihood                        | Mitigation                                                                                          |
| ---------------------------------------------------------------------------------------------------- | --------------------------------- | --------------------------------------------------------------------------------------------------- |
| **Renderer YAML bug** (dev introduces new construct, template wrong)                                 | Low–medium during initial rollout | L9 (sanity compile), L12 (CI property tests), golden-corpus tests on locked-topology fixtures       |
| **PERSONA/copy quality regression** (LLM polish disabled, baseline templates flat)                   | Low for V1 launch                 | All LLM work moved to BLUEPRINT with multi-layer defense; quality should match or exceed today      |
| **User locks BLUEPRINT with degraded section** (fallback default fired, persona is bland but valid)  | Medium                            | UI warning chip on sections where L4 fired; user can always re-iterate before lock                  |
| **Schema migration bug** (V1 session resumed under V2 fails to migrate cleanly)                      | Medium during rollout             | L11, plus explicit migration tests on representative V1 sessions                                    |
| **Compiler upstream regression** (compiler emits new error code on previously-valid output)          | Low                               | L9 catches it as "renderer bug" — surfaces clearly, doesn't silently fail; CI catches before deploy |
| **Cross-agent shape drift** (BLUEPRINT iteration changes one agent, dependent agent stale)           | Medium                            | L5 cross-section consistency at every approval gate; L6 final gauntlet catches anything missed      |
| **Tool bootstrap unsupported types** (Blueprint allows tool type that BUILD/CREATE can't synthesize) | Medium                            | Surface in BLUEPRINT at tool-section validation, not silently in synthesizer (today's behavior)     |
| **LLM refuses to generate prose for sensitive domain** (e.g., medical advice script)                 | Low–medium                        | L4 fallback baseline + UI flag for user to author manually                                          |

---

## 11. Persistence, Lifecycle, Project Linkage, Versioning

### 11.1 Storage model

**New Mongo collection `arch_blueprints`** in `packages/database/src/models/arch-blueprint.model.ts`.

```ts
export interface IArchBlueprintRecord {
  _id: Types.ObjectId;
  tenantId: string; // tenant isolation (plugin-applied)

  // Scope
  sessionId: string; // always set
  projectId?: string; // backfilled by linkToProject after CREATE

  // Schema versioning
  blueprintSchemaVersion: '2.0';

  // Lifecycle state
  state: 'draft' | 'locked' | 'linked' | 'archived';
  lockedAt?: Date;
  linkedAt?: Date;
  archivedAt?: Date;

  // Versioning (snapshot history)
  version: number; // monotonic int per scope
  parentVersion?: number; // for diff

  // The actual blueprint
  output: BlueprintOutput;

  // Per-section approval state (mirrored from output.sectionApprovals)
  sectionsApproved: number;
  sectionsTotal: number;

  // Validation snapshot at lock time
  validation?: ValidationReport;

  // Audit
  createdAt: Date;
  updatedAt: Date;
  createdBy: string; // userId
  lastModifiedBy: string;
}
```

**Indexes** — every compound index is **tenant-scoped first**. Tenant isolation is a hard platform invariant; unique indexes that omit `tenantId` would allow cross-tenant version collisions and cross-tenant lookups via accidental key reuse.

- `{ tenantId: 1, sessionId: 1, version: -1 }` unique — primary lookup for session-scoped versions
- `{ tenantId: 1, projectId: 1, version: -1 }` unique sparse — primary lookup for project-scoped versions (sparse: `projectId` is null pre-CREATE)
- `{ tenantId: 1, projectId: 1, state: 1 }` — list current/draft for a project
- `{ tenantId: 1, sessionId: 1, state: 1 }` — list current/draft for a session
- `{ tenantId: 1, updatedAt: -1 }` — cleanup cron, scoped to one tenant per pass

**Tenant isolation:** `tenantIsolationPlugin` applied. **All service calls MUST include `tenantId` in the query** — never `findById` without it. Cross-tenant access returns 404 (per platform invariant in CLAUDE.md), never 403.

### 11.2 Mirror to session metadata

Write slim summary (current version + state + section progress) to `session.metadata.blueprintOutput` on every blueprint write, same transaction (with `isTransactionUnsupported` fallback per existing `spec-document-service.ts:160-178` pattern). Existing session-load paths get a fast read without joining `arch_blueprints`.

### 11.3 Lifecycle state machine

```
                                                 Stage 4 user
                                                 approves all
                                                 sections + lock
   ┌────────┐  user enters    ┌─────────┐       passes BV-001..BV-020
   │ (none) │ ───BLUEPRINT──► │  draft  │ ─────────────────────────────►┐
   └────────┘                 └────┬────┘                                │
                                   │                                     │
                                   │ user edits sections                 │
                                   │ (in place, same version)            │
                                   │                                     │
                                   ▼                                     ▼
                              ┌─────────┐                         ┌──────────┐
                              │  draft  │                         │  locked  │
                              └─────────┘                         └────┬─────┘
                                                                       │
                                                                       │ user clicks
                                                                       │ "Create project"
                                                                       │ → finalizeProject
                                                                       │   calls linkToProject
                                                                       ▼
                                                                  ┌──────────┐
                                                                  │  linked  │
                                                                  └────┬─────┘
                                                                       │
                                                                       │ user opens project,
                                                                       │ edits blueprint
                                                                       │ (creates v2)
                                                                       ▼
                                                                  ┌──────────┐
                                                                  │  draft   │  (v2)
                                                                  │ (linked) │
                                                                  └────┬─────┘
                                                                       │
                                                                       │ lock v2 (v1 stays
                                                                       │  as immutable snapshot)
                                                                       ▼
                                                                  ┌──────────┐
                                                                  │  locked  │  (v2)
                                                                  └────┬─────┘
                                                                       │
                                                                       │ user revises + regenerates agents
                                                                       ▼
                                                                  any version can be
                                                                  archived; archived
                                                                  versions are read-
                                                                  only deliverables
```

| State      | Mutability              | Visible in artifact panel       | BUILD reads from                   |
| ---------- | ----------------------- | ------------------------------- | ---------------------------------- |
| `draft`    | Yes (per-section edits) | Yes — current working version   | No — not buildable until locked    |
| `locked`   | No                      | Yes                             | Yes — pure renderer reads `output` |
| `linked`   | No (need new version)   | Yes — in InProjectArtifactPanel | Yes                                |
| `archived` | No                      | Read-only history               | No                                 |

**Invariant:** Only `state == 'locked'` or `'linked'` is buildable. Layer 10 (locked-topology mutation guard) checks `output.topology` matches the locked snapshot at BUILD entry.

### 11.4 Project linkage

Mirrors `journal-service.linkToProject` at `packages/arch-ai/src/journal/journal-service.ts:237`. Called from `finalizeProject.ts` (add sibling call alongside existing `journalService.linkToProject` at line 369-381).

```ts
async linkToProject(opts: {
  sessionId: string;
  projectId: string;
  tenantId: string;
}): Promise<void>;
```

Project-scope reads require explicit `unsafeProjectScope: true` flag (matches `journal-service.ts:130` and `spec-document-service.ts:414`).

### 11.5 Versioning model

**Each `lock` creates an immutable snapshot row.** Edits after lock create a new draft (next version), keyed by `(sessionId-or-projectId, version)`.

| Why immutable snapshots |                                                                                               |
| ----------------------- | --------------------------------------------------------------------------------------------- |
| Audit + compliance      | Locked blueprint is the source of truth for "what was approved when this project was created" |
| BUILD reproducibility   | Re-run BUILD on v1 → same agents, even if v2 has diverged                                     |
| Diff + comparison       | Show user what changed between v1 and v2                                                      |
| Rollback                | If v2 introduces a regression, user can re-lock v1 (clones to v3 with v1's content)           |

Version numbering: monotonic integer per scope (sessionId before link, projectId after).

Storage cost per version: ~50–500 KB. Latest 10 versions per project; older auto-archived.

### 11.6 API surface

```
# Session-scoped (during BLUEPRINT phase)
GET    /api/arch-ai/sessions/:id/blueprint
GET    /api/arch-ai/sessions/:id/blueprint/versions
GET    /api/arch-ai/sessions/:id/blueprint/versions/:n
PATCH  /api/arch-ai/sessions/:id/blueprint/sections/:sectionId
POST   /api/arch-ai/sessions/:id/blueprint/sections/:sectionId/approve
POST   /api/arch-ai/sessions/:id/blueprint/sections/:sectionId/skip
POST   /api/arch-ai/sessions/:id/blueprint/lock

# Project-scoped (after CREATE)
GET    /api/arch-ai/projects/:projectId/blueprint
GET    /api/arch-ai/projects/:projectId/blueprint/versions
GET    /api/arch-ai/projects/:projectId/blueprint/versions/:n
POST   /api/arch-ai/projects/:projectId/blueprint/fork
POST   /api/arch-ai/projects/:projectId/blueprint/sections/:sectionId/edit
POST   /api/arch-ai/projects/:projectId/blueprint/lock
POST   /api/arch-ai/projects/:projectId/blueprint/build

# Cross-cutting
GET    /api/arch-ai/sessions/:id/blueprint/render?format=md
GET    /api/arch-ai/projects/:projectId/blueprint/render?format=md
GET    /api/arch-ai/projects/:projectId/blueprint/diff?from=:n&to=:n
```

All routes return `{ success, data?, error?: { code, message } }`. Tenant isolation via model plugin. Project routes use `requireProjectAccess` then pass `unsafeProjectScope: true`.

### 11.7 Post-CREATE blueprint behavior

The blueprint is **editable after CREATE, but lock creates a new version, not in-place mutation.** Rebuilding agents from a new version is **explicit** — never automatic.

Three decoupled actions:

1. **Edit blueprint** — forks to new draft
2. **Lock blueprint version** — runs validation gauntlet
3. **Rebuild agents from a locked version** — explicit user action with confirmation

Decoupling prevents "I just clicked Edit and now production is broken."

### 11.8 Schema migration

```ts
export const MIGRATIONS: Record<string, BlueprintMigration> = {
  '1.0→2.0': {
    fromVersion: '1.0',
    toVersion: '2.0',
    migrate: (oldDoc: any): BlueprintOutput => {
      // Convert bare topology to full BlueprintOutput
      // Most fields get sensible defaults; user must iterate to fill
    },
  },
};
```

Since the dormant v1 schema is never written today, this is forward-looking insurance. But adding it from day 1 means we can iterate the schema without breaking changes later.

### 11.9 Retention policy

| Scope                    | State                     | Retention                                                                   |
| ------------------------ | ------------------------- | --------------------------------------------------------------------------- |
| Session-only blueprint   | `draft`                   | 30 days from last edit (then archived)                                      |
| Session-only blueprint   | `locked`                  | 90 days from lock (then archived) — gives user time to come back and CREATE |
| Project-linked blueprint | `linked` (current)        | Indefinite — kept with project                                              |
| Project-linked blueprint | `linked` (older versions) | Latest 10 versions kept; older auto-archived                                |
| Any state                | `archived`                | 1 year, then hard delete (per data minimization invariant in CLAUDE.md)     |

Cleanup runs as daily cron job. Hard delete cascades journal entries.

### 11.10 SSE event surface

New `blueprint` artifact case in `event-dispatcher.ts:1417-1499`:

```ts
{
  type: 'artifact',
  subtype: 'blueprint',
  data: {
    sessionId: string;
    sectionId?: string;                          // present for section-level updates
    state: 'draft' | 'locked' | 'linked';
    version: number;
    sectionsApproved: number;
    sectionsTotal: number;
    eventKind: 'section_updated' | 'section_approved' | 'section_skipped'
             | 'lock_started' | 'lock_succeeded' | 'lock_failed'
             | 'forked' | 'rebuilt';
  }
}
```

---

## 12. Artifact Panel Display & Edit Affordances

### 12.1 Layout: sticky ToC + scrollable document

```
┌─────────────────── ARTIFACT PANEL (right side of arch screen) ───────────────────┐
│                                                                                    │
│  ┌──────────────────┐ ┌────────────────────────────────────────────────────────┐ │
│  │  Blueprint v2    │ │ [▾] Tab: blueprint                                       │ │
│  │  ─────────────   │ │                                                          │ │
│  │  state: draft    │ │  ┌──────────────────────────────────────────────────┐  │ │
│  │  12 of 17 ✓      │ │  │  Header (sticky)                                   │  │ │
│  │  [██████░░░░░░]  │ │  │  Lumen Technologies — Agentic Billing Platform     │  │ │
│  │                  │ │  │  ●  draft (v2)   [Lock]  [Export ▾]   [⋯]         │  │ │
│  │  ┌──────────────┐│ │  ├──────────────────────────────────────────────────┤  │ │
│  │  │ § 0  Header  ││ │  │                                                    │  │ │
│  │  │ ✓  approved  ││ │  │  ## §0 Header                              [Edit] │  │ │
│  │  ├──────────────┤│ │  │                                                    │  │ │
│  │  │ § A  Assump. ││ │  │  Customer:        Lumen Technologies              │  │ │
│  │  │ ✓  approved  ││ │  │  Stage:           Competitive Bake-Off            │  │ │
│  │  ├──────────────┤│ │  │  ...                                               │  │ │
│  │  │ § 6  Prompts ││ │  │                                                    │  │ │
│  │  │ ⏳ generating ││ │  │  ## §6 System Prompts          ⏳ generating...   │  │ │
│  │  ├──────────────┤│ │  │  ▓▓▓▓▓░░░░░░░░░ (streaming)                      │  │ │
│  │  │ § 8  I/O     ││ │  │                                                    │  │ │
│  │  │ ●  pending   ││ │  │  ## §8 Inputs & Outputs                            │  │ │
│  │  └──────────────┘│ │  │  ●  pending — will generate after §6 approves    │  │ │
│  └──────────────────┘ └────────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────────────────────────┘
```

### 12.2 Per-section status states

| Status              | Icon | Color                | Meaning                                         | Available actions                                              |
| ------------------- | ---- | -------------------- | ----------------------------------------------- | -------------------------------------------------------------- |
| `pending`           | ●    | gray                 | Not yet generated; waiting for prior sections   | none (disabled)                                                |
| `draft`             | ◐    | blue                 | Generated, awaiting your approval               | `Approve`, `Refine`, `Skip` (if optional)                      |
| `approved`          | ✓    | green                | Locked into this draft version                  | `Edit` (creates new draft if locked state)                     |
| `skipped`           | ⊘    | gray (italic in ToC) | Section not applicable to this project          | `Include` (un-skip)                                            |
| `validation_failed` | ⚠    | red                  | Auto-validation caught an issue post-generation | `Refine` (with error context shown), `Override` (with warning) |
| `generating`        | ⏳   | yellow (pulsing)     | LLM call in progress; content streaming         | none (read-only during stream)                                 |

### 12.3 Edit affordances by lifecycle state

| Lifecycle state                          | Panel actions                                                      | Chat actions                                       |
| ---------------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------- |
| `draft` (during initial BLUEPRINT)       | `Approve`, `Refine`, `Skip` per section. `Lock` when all approved. | Iterate any pending/draft section; refine via chat |
| `locked` (BLUEPRINT exit, BUILD ready)   | View only. `Edit` forks to new draft (v(N+1))                      | (chat in BUILD/CREATE phase)                       |
| `linked` (post-CREATE, current version)  | View only. `Edit` forks. `Rebuild agents` if newer locked exists   | (chat in InProject mode)                           |
| `archived` (older versions, post-CREATE) | View only. `Restore` clones to new draft                           | n/a                                                |

**Invariants:**

1. No direct in-place editing of locked or linked blueprint
2. No auto-rebuild of agents on blueprint edit (always explicit)
3. No raw markdown editing — edits go through structured-field forms or chat refinement

### 12.4 Refine flow

When user clicks `Refine` on a section:

```
[ARTIFACT PANEL]                  [CHAT]
 §6 System Prompts ──── click ──► Architect: "Let's refine the System Prompts
 ◐ draft                           section. What would you like to change?"
 [Refine]
                                   ┌─────────────────────────────────────┐
                                   │  SectionRefinement widget           │
                                   │  ┌─────────────────────────────────┐│
                                   │  │ ▸ Adjust persona for one agent  ││
                                   │  │ ▸ Add channel awareness rules   ││
                                   │  │ ▸ Tighten guardrail wording     ││
                                   │  │ ▸ Other (describe)              ││
                                   │  └─────────────────────────────────┘│
                                   └─────────────────────────────────────┘

User picks option → architect produces new draft → panel updates live →
section status returns to `draft` (revisionCount += 1) → user re-approves
```

### 12.5 Streaming and validation feedback

Streaming sections show `⏳ generating...` with progress bar. ToC item pulses. Approve/refine actions disabled during stream.

If retries exhaust (Layer 4 fires), show banner:

```
## §6 System Prompts                                 ⚠ baseline used
This section was generated using a fallback template after 3 LLM retries
failed. You can refine it now or accept and review later.
```

Lock-time validation failure surfaces as panel banner with `[Go to section]` deep links:

```
┌────────────────────────────────────────────────────────────────────────┐
│  ⚠ Lock blocked — 2 validation issues to fix                            │
│                                                                          │
│  ● BV-005 in §9 Tools                                          [Go to]  │
│  ● BV-003 in §6 Prompts (Lumen Supervisor)                     [Go to]  │
│                                                                          │
│  [Refine all] [Dismiss banner]                                           │
└────────────────────────────────────────────────────────────────────────┘
```

### 12.6 Diff view (version comparison)

`GET /api/arch-ai/projects/:id/blueprint/diff?from=1&to=2` returns per-section diffs. Client uses `react-diff-viewer-continued` or similar markdown-aware diff library.

### 12.7 Component layout

```
apps/studio/src/lib/arch-ai/components/arch/panels/
├── BlueprintPanel.tsx                  ← top-level (replaces topology tab content)
├── BlueprintHeader.tsx                 ← sticky header strip
├── BlueprintToc.tsx                    ← sidebar nav
├── BlueprintTocItem.tsx                ← single ToC entry with status badge
├── BlueprintProgressBar.tsx
├── BlueprintDocument.tsx               ← scrollable doc body
├── BlueprintSection.tsx                ← per-section rendering
├── BlueprintSectionStatusBadge.tsx
├── BlueprintSectionStreamingState.tsx
├── BlueprintEmptyState.tsx
├── BlueprintValidationBanner.tsx
├── BlueprintDiffView.tsx
├── BlueprintActions.tsx
├── BlueprintExportMenu.tsx
└── BlueprintForkConfirmDialog.tsx

apps/studio/src/lib/arch-ai/components/arch/chat/widgets/
├── SectionApprovalWidget.tsx           ← chat: [approve, refine, skip]
├── SectionRefinementWidget.tsx
├── BlueprintLockWidget.tsx
├── BlueprintBuildWidget.tsx
├── ComplexityCardWidget.tsx            ← Stage 1
├── ArchitectureCardWidget.tsx          ← Stage 2 per agent
└── BlueprintPlanCardWidget.tsx         ← Stage 3
```

### 12.8 A11y baseline (acceptance criteria for UI work)

- `role="region"` per section with `aria-labelledby` to section heading
- `aria-live="polite"` on streaming content area
- `aria-busy="true"` during generation
- `aria-current="step"` on active ToC item
- Focus management when a new approval gate appears (focus moves to widget)
- Keyboard navigation between sections via arrow keys + Enter to expand/jump
- All status badges have `aria-label` describing the status
- Sticky headers have `aria-hidden="true"` on duplicate visual elements

### 12.9 Reuse from existing components

| Existing                                                     | Reused as                                                  |
| ------------------------------------------------------------ | ---------------------------------------------------------- |
| `ArchMarkdown` (`chat/ArchMarkdown.tsx:11`)                  | Wraps `react-markdown` for the doc body                    |
| `useArchAIStore` artifact-tab pattern                        | Add `'blueprint'` to `ArtifactTabType`                     |
| `addTab` dedupe + version inc (`store/arch-ai-store.ts:348`) | Blueprint tab uses same pattern                            |
| `event-dispatcher.ts:1417-1499` SSE artifact case            | New `'blueprint'` case dispatches to store handler         |
| `JournalPanel` polling+SSE merge pattern                     | `BlueprintPanel` does same                                 |
| `BlueprintDiffCard` (existing onboarding plan diff)          | Pattern reused for `BlueprintDiffView`                     |
| Sticky-header CSS pattern                                    | Lifted from `OnboardingArtifactPanel.tsx`                  |
| Existing widget shape                                        | New widgets follow same Zod schema + button-action pattern |

---

## 13. In-Project Mode Integration

### 13.1 Current in-project architecture

**Entry point:** Overlay (`ArchV4Overlay`) mounts on `/projects/:projectId/...` pages via `AppShell.tsx:602-603`. NOT a separate URL — the panel slides in on existing project pages.

**Specialist:** `IN_PROJECT_ARCHITECT_SPECIALIST = 'in-project-architect'` at `packages/arch-ai/src/engine/coordinator-bridge.ts:27`. **Critical finding:** the prompt today is just `export const IN_PROJECT_ARCHITECT_PROMPT = IN_PROJECT_GENERALIST_PROMPT` — an alias for the generalist, not a tailored architect prompt.

**Tools:** 50+ tools in `IN_PROJECT_SPECIALIST_TOOL_MAP` at `packages/arch-ai/src/types/tools.ts:149-196`. **No blueprint tools exist today.**

**Mutation flow:** Every mutation is plan-gated. `propose_plan` → user approval → `propose_modification` → diff review → user confirm → `apply_modification` → writes to `ProjectAgent.dslContent` directly.

**Existing BUILD↔BLUEPRINT backtrack:** `process-in-project.ts:1042-1090` already moves phase backwards on topology-altering messages via `classifyMutationScope`.

### 13.2 The drift problem (Decision: blueprint-only edits in v2-canonical mode)

Today, `applyProjectAgentModification` writes arbitrary DSL to `ProjectAgent.dslContent` directly. Same for `createNewProjectAgent`. **If we hold blueprint as canonical, every existing modification path that writes raw DSL silently drifts the blueprint** — and a "paired write" approach that tries to patch the structured blueprint _from_ arbitrary DSL would require a lossless DSL-to-blueprint reverse mapper, which does not exist and is non-trivial to build (the DSL has prose fields, free-form Handlebars templates, and edge-case constructs that don't map cleanly back to structured fields).

**Decision: blueprint-only canonical edits in v2-enabled projects.**

In v2-canonical mode (project has `blueprintSchemaVersion: '2.0'` and a non-archived blueprint), the in-project mutation surface is restructured around the blueprint:

| Edit kind                                                                                                                   | v1 today                              | v2 canonical                                                                                                                                                                                                   |
| --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Structured architectural edit** (rename agent, add gather field, change handoff condition, swap tool ref, edit guardrail) | `propose_modification` writes raw DSL | `propose_blueprint_edit` writes structured blueprint section → triggers re-render of affected agent's DSL                                                                                                      |
| **Persona prose / RESPOND copy refinement**                                                                                 | `propose_modification` writes raw DSL | `propose_blueprint_edit` writes structured prose field → re-renders DSL                                                                                                                                        |
| **Direct DSL paste / hand-edit** (advanced power-user)                                                                      | Allowed via `agent_ops.modify`        | **Disabled in v2-canonical mode** — surfaces "This project is canonical-blueprint mode. Use `propose_blueprint_edit` instead." with a `[Disable canonical mode]` escape hatch (manual-drift state — see §13.9) |

Implementation pattern — every blueprint edit re-renders the affected agent file via the same pure renderer used in BUILD:

```ts
async function applyBlueprintEdit(opts: {
  projectId: string;
  tenantId: string;
  userId: string;
  blueprintEdit: { sectionId: string; changes: unknown };
}): Promise<void> {
  await withTransactionOrSequential(async (session) => {
    // 1. Patch the blueprint draft (structured)
    const draft = await BlueprintService.findOrForkDraft({ projectId, tenantId, session });
    const updated = await BlueprintService.patchSection({
      blueprintId: draft._id,
      sectionId: opts.blueprintEdit.sectionId,
      changes: opts.blueprintEdit.changes,
      session,
    });

    // 2. Re-render affected agent file(s) via pure renderer
    const affectedAgents = computeAffectedAgents(opts.blueprintEdit, updated.output);
    for (const agentName of affectedAgents) {
      const newDsl = renderAgent({
        agent: updated.output.perAgent[agentName],
        blueprint: updated.output,
        topology: updated.output.topology,
      });

      // 3. Atomic write to ProjectAgent (re-rendered DSL is canonical)
      const agentRecord = await ProjectAgent.findOne(
        { tenantId, projectId, name: agentName },
        null,
        { session },
      );
      if (!agentRecord) {
        throw new Error(`ProjectAgent not found for blueprint render: ${agentName}`);
      }

      await ProjectAgent.updateOne(
        { tenantId, projectId, name: agentName },
        {
          $set: {
            dslContent: newDsl,
            sourceHash: hash(newDsl),
            lastEditedBy: 'blueprint-engine', // distinguish from human edits
            lastEditedAt: new Date(),
          },
        },
        { session },
      );

      // 4. Snapshot to AgentVersion (see §13.8 — REQUIRED, not optional)
      const compiledIr = compileRenderedAgentToIr(newDsl);
      await AgentVersion.create(
        [
          {
            agentId: agentRecord._id, // ProjectAgent._id, not agentName
            version: await nextAgentVersion(agentRecord._id, session), // string; unique per agentId
            status: 'draft',
            dslContent: newDsl,
            irContent: JSON.stringify(compiledIr),
            sourceHash: hash(newDsl),
            changelog: `Rendered from blueprint v${updated.version} section ${opts.blueprintEdit.sectionId}`,
            createdBy: opts.userId,
            toolSnapshot: await snapshotProjectToolsForAgent({
              tenantId,
              projectId,
              agentName,
              session,
            }),
          },
        ],
        { session },
      );
    }

    // 5. Journal the mutation
    await journalAppendAndEmit(
      { type: 'mutation', sectionId: opts.blueprintEdit.sectionId /* ... */ },
      { session },
    );
  });
}
```

**Why blueprint-only is correct:**

- No reverse-mapper needed. Blueprint is structured; DSL is rendered. Writes flow one direction.
- No drift possible by construction — DSL cannot be edited without going through the blueprint.
- Re-renders are deterministic (same renderer used by BUILD), so blueprint state and agent files always agree.
- The escape hatch (manual-drift mode, §13.9) is explicit and per-project — one warning, one toggle, persistent state — not a silent path.

**Migration path for existing projects without v2 blueprint:** During Phase 4 backfill (§14.6), every existing project gets a derived v2 blueprint via `deriveBlueprintFromExistingProject(projectId)`. The derivation parses each agent's DSL with `parseAgentBasedABL`, walks the resulting `AgentBasedDocument` IR, and populates `BlueprintOutput.perAgent[name]` field-by-field. Fields that don't have a clean DSL-to-structured mapping (free-form prose, custom Handlebars expressions) are captured verbatim in a per-agent `derivedFromV1: { rawSnapshots: { ... } }` escape hatch. The user sees a banner: "This blueprint was derived from your existing project — review and refine each section."

### 13.3 Local edit guard for rebuild (Decision audit C6)

When user clicks "Rebuild agents from blueprint v2":

```
┌──────────────────────────────────────────────────────────────┐
│  Rebuild agents from blueprint v2                              │
│  ───────────────────────────────                              │
│                                                                │
│  3 agents have local edits since blueprint v1 was locked:     │
│    • Bill Payment Worker — last edited 2 hours ago by you     │
│    • Bill Variance Worker — last edited yesterday by alice    │
│    • Lumen Billing Supervisor — last edited 3 days ago by bob │
│                                                                │
│  Rebuilding will overwrite these local edits with the         │
│  versions generated from blueprint v2.                         │
│                                                                │
│  Recommendations:                                              │
│    1. Review the diff first: [View per-agent diff]             │
│    2. Discard local edits and use blueprint v2: [Rebuild]     │
│    3. Cancel and resolve manually: [Cancel]                   │
└──────────────────────────────────────────────────────────────┘
```

**Detection mechanism — uses `updatedAt` and source hash, not just `lastEditedBy/lastEditedAt`.**

The existing `ProjectAgent` model has `lastEditedBy` and `lastEditedAt` fields (`project-agent.model.ts:27`), but `applyProjectAgentModification` does not currently set them — it sets only `dslContent`, `name`, `agentPath`. So a guard relying solely on those fields would miss most existing edits.

Defense uses two signals together:

1. **`updatedAt`** (Mongoose-managed, always set on any write) — newer than blueprint's `lockedAt` means _something_ changed since lock
2. **`sourceHash`** (already on `ProjectAgent`) — compared against the renderer's output hash for the same agent at blueprint vN

A conflict exists if `updatedAt > lockedAt` AND `sourceHash !== render(blueprint.perAgent[agentName])`. This catches both:

- Agents edited via the new blueprint-rendered path (sourceHash diverges from blueprint)
- Agents edited via legacy paths or direct DB tampering (updatedAt exceeds lockedAt; hash diverges)

In v2-canonical mode (after Phase 4 cutover), blueprint-rendered writes ALSO set `lastEditedBy = 'blueprint-engine'` and `lastEditedAt = now()`, so the rebuild guard can distinguish "user-touched" from "blueprint-rendered" provenance. This is informational; the `updatedAt + sourceHash` check is authoritative.

Conflict surface and acknowledgment forced via explicit confirmation modal (above) — user must click `Rebuild` after reading the conflict list.

### 13.4 New blueprint tools (audit C2)

Add to `IN_PROJECT_SPECIALIST_TOOL_MAP`:

```ts
'read_blueprint': {
  description: 'Read the current locked blueprint for this project',
  parameters: z.object({
    version: z.number().optional(),                    // omit for latest locked
    section: z.string().optional(),                    // omit for full doc
  }),
},
'propose_blueprint_edit': {
  description: 'Propose an edit to a section of the current draft blueprint',
  parameters: z.object({
    sectionId: z.string(),
    changes: z.unknown(),                              // section-specific
    reason: z.string(),
  }),
},
'lock_blueprint_version': {
  description: 'Run validation gauntlet and lock the current draft as a new immutable version',
  parameters: z.object({}),
},
'fork_blueprint': {
  description: 'Create a new draft from the current locked version (for editing post-CREATE)',
  parameters: z.object({}),
},
'rebuild_agents_from_blueprint': {
  description: 'Regenerate agent files from a locked blueprint version. Requires explicit user confirmation.',
  parameters: z.object({
    fromVersion: z.number(),
    confirmOverwriteLocalEdits: z.boolean().default(false),
  }),
},
```

### 13.5 New in-project-architect prompt (audit C3)

Replace `IN_PROJECT_ARCHITECT_PROMPT = IN_PROJECT_GENERALIST_PROMPT` alias with a real prompt that knows about blueprints:

```
You are the In-Project Architect for an arch-ai project.

You have access to the project's blueprint — the structured architectural
document that defines this project's agents, tools, governance, and integrations.
All architectural changes flow through the blueprint:

1. Reading: use `read_blueprint` to see what's defined
2. Proposing changes: use `propose_blueprint_edit` for any architectural
   modification (agent changes, tool changes, guardrail changes, etc.)
3. Validating: changes are validated against the blueprint schema
4. Locking: use `lock_blueprint_version` to create a new immutable version
5. Rebuilding: use `rebuild_agents_from_blueprint` to regenerate agent files

For every agent-affecting edit in canonical-blueprint mode — including small
persona tweaks, prompt refinements, gather changes, guardrail edits, or tool
reference changes — use `propose_blueprint_edit`. Do NOT use `propose_modification`
in canonical-blueprint mode; that tool is legacy/manual-drift only because it
writes raw DSL and cannot be losslessly mapped back into the structured
blueprint.

If the user asks to paste or hand-edit raw DSL, explain that canonical mode
does not allow direct DSL writes. Offer the explicit manual-drift escape hatch
only if they understand that the blueprint will be archived and future
reconciliation becomes manual.

The user's project lives at version N of the blueprint. Always show them
which version they're working against.

[... full prompt continues with mutation gating, classification, etc.]
```

### 13.6 Blueprint editing follows existing diff/chat/Confirmation pattern

| Pattern from existing in-project                                      | Reused for blueprint edits                                                      |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Read-only panel + chat-driven mutation                                | Blueprint tab is read-only; user types refinement in chat                       |
| `propose_modification` → diff tab → Confirmation widget               | `propose_blueprint_edit` → diff tab shows blueprint delta → Confirmation widget |
| `apply_modification` paired with journal entry                        | `apply_blueprint_edit` paired with journal + section status update              |
| Inline panel actions discouraged (`InProjectArtifactPanel.tsx:49-50`) | Blueprint tab follows same — no inline editing                                  |

### 13.7 classifyMutationScope extension (audit C7)

Extend the existing classifier to classify blueprint edits:

```ts
type MutationScope = 'small' | 'medium' | 'large';

function classifyMutationScope(intent: string): MutationScope {
  // SMALL: typo fixes, persona word changes, single field updates
  // → skip full propose_plan, go directly to propose_blueprint_edit in canonical mode
  // MEDIUM: add a guardrail, change execution mode for one agent
  // → require propose_plan but lightweight
  // LARGE: add agent, change topology pattern, restructure flow
  // → require full propose_plan with rationale
}
```

Reduces friction for trivial edits while preserving safety for architectural changes.

### 13.8 AgentVersion writes — REQUIRED (audit C9)

The `agent_versions` collection exists at `packages/database/src/models/agent-version.model.ts:46-65` with required fields `agentId`, `version`, `status`, `dslContent`, `irContent`, `sourceHash`, and `createdBy`; it has a unique `(agentId, version)` index. **Verification confirmed at audit time: `applyProjectAgentModification` does NOT write `AgentVersion` rows today.**

Without `AgentVersion` writes, the blueprint's "rebuild from version N" rollback story has no foundation — there's nothing to roll an individual agent back to. So:

**REQUIREMENT (not optional):** As part of v2-canonical work, every write to `ProjectAgent.dslContent` (whether from blueprint re-render or — temporarily — from legacy `applyProjectAgentModification`) MUST also create an `AgentVersion` row in the same transaction. The row must match the existing model exactly: `agentId` is the `ProjectAgent._id` string, `version` is a per-agent string, `status` is the existing status string (use `draft` for newly rendered snapshots unless the caller is explicitly promoting a version), and metadata such as blueprint provenance belongs in `changelog` unless the model is explicitly extended in a separate migration. Do not invent `tenantId`, `projectId`, `triggeredBy`, or `lifecycle` fields on `AgentVersion`.

```ts
await AgentVersion.create(
  [
    {
      agentId: projectAgent._id,
      version: nextAgentVersion,
      status: 'draft',
      sourceHash: hash(newDsl),
      dslContent: newDsl,
      irContent: JSON.stringify(compiledIr),
      changelog: 'Rendered from blueprint v2 section 6',
      createdBy: userId,
      toolSnapshot,
    },
  ],
  { session },
);
```

Estimated touch: ~5-8 files (`applyProjectAgentModification`, `createNewProjectAgent`, `agent_ops.modify`, blueprint render path, `tools_ops.update` where it touches agents). All in `apps/studio/src/lib/arch-ai/tools/in-project-tools.ts`.

**Acceptance criterion** (added to §18.1): Every mutation path that touches `ProjectAgent.dslContent` produces a corresponding `AgentVersion` row, verified by integration tests.

### 13.9 Bulk path: removed in v2-canonical mode + explicit manual-drift escape hatch (audit C10)

`agent_ops.modify` (bulk path) today explicitly skips the diff/plan flow and writes raw DSL directly. Keeping it as-is would let power users drift the blueprint silently — that contradicts the single-source-of-truth invariant.

**Decision:** Bulk-path direct DSL write is **disabled in v2-canonical mode**. Two replacement surfaces:

**Required model addition:** `Project.archConfig` does not exist today. V2 implementation adds it to `packages/database/src/models/project.model.ts` and updates project create/backfill defaults:

```ts
archConfig: {
  canonicalBlueprintMode: { type: Boolean, default: true },
  canonicalBlueprintVersion: { type: Number, default: null },
  manualDriftEnabledAt: { type: Date, default: null },
  manualDriftEnabledBy: { type: String, default: null },
}
```

If we choose not to extend `Project`, the equivalent state must live in a project-scoped Blueprint/ProjectSettings record. The LLD must choose one storage location; the invariant is that the mutation layer can cheaply check canonical mode before any raw `ProjectAgent.dslContent` write.

| User intent                                                                                                     | v2 surface                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Bulk structured edits** ("rename N agents", "add a guardrail to all agents")                                  | Bulk-path is rewritten to call `propose_blueprint_edit` per-section — still edits the blueprint first; still re-renders DSL deterministically; still creates AgentVersion rows. No raw DSL write.                                                                                                                                                                                                                                                                                   |
| **Power-user raw DSL edit** (advanced workflow, e.g. trying a custom construct not yet in the blueprint schema) | **Manual-drift mode** — explicit per-project toggle: `Project.archConfig.canonicalBlueprintMode = false`. Setting this to `false` requires explicit user confirmation: _"This disables blueprint-canonical mode for this project. Future blueprint edits will require manual reconciliation against your direct DSL changes. You can re-enable canonical mode after."_ The blueprint state for that project transitions to `archived` (current versions kept as read-only history). |

**Manual-drift mode provides a clean escape hatch** for genuine power-user needs without compromising the v1 invariant. The toggle is per-project, persisted, and reversible (re-enabling forks a new blueprint draft from the current agent files via `deriveBlueprintFromExistingProject`).

**No silent drift path remains.** Either you're in canonical mode (all edits via blueprint, deterministic re-render) or in manual-drift mode (no blueprint enforcement, you own reconciliation). The choice is explicit and visible in the UI.

---

## 14. Migration Path

### 14.1 Six-phase rollout

```
Phase 0    Phase 1     Phase 2      Phase 3       Phase 4         Phase 5    Phase 6
─────────  ──────────  ───────────  ────────────  ──────────────  ──────────  ──────────
Build      Internal    Beta opt-in  Default ON    Backfill + cut   Deprecate   Delete
parallel   dogfood     by tenant    new sessions  in-flight        v1 path     v1 path
                                                  sessions

[flag off] [flag on    [flag on for [flag on by   [flag on for     [flag and   [code
           for arch    select       default;      all; old path     old path    deleted]
           team]       tenants]     opt-out flag] still callable]   live, warn]
```

### 14.2 Phase 0 — Parallel implementation (4-6 weeks)

Feature flag: `NEXT_PUBLIC_FEATURE_ARCH_BLUEPRINT_V2 = false`. Old path untouched.

Implementation order:

1. `BlueprintOutput` v2.0 schema extension
2. `arch_blueprints` Mongo collection + `ArchBlueprint` model + `BlueprintService` (CRUD)
3. API routes (GET/PATCH/POST) — no UI consumer yet
4. Renderer suite — pure functions, fully unit-tested
5. Markdown renderer
6. Validation gauntlet — BV-001..BV-020 rules, fully unit-tested
7. Section LLM-call wrappers + per-section validators (extends `scaffold/slot-fix-loop.ts`)
8. `BlueprintPanel` UI (empty state + ToC of empty sections)
9. 4-stage BLUEPRINT phase coordinator integration
10. Migration scripts for in-flight sessions
11. **Golden-corpus fixtures (REQUIRED — gates Phase 0 exit):**
    - Copy `lastminute_blueprint_v2.md` and `Lumen_Agentic_Billing_Platform_Blueprint_v1.1.md` from `~/Downloads/` into `packages/arch-ai/src/blueprint/__tests__/fixtures/reference-blueprints/`
    - **Manually author the structured `BlueprintOutput` v2.0 JSON** for each by reading the MD section-by-section and populating each field — this is real engineering work, ~1-2 days per fixture
    - Add `parseBlueprintOutputFromMd(mdString) → BlueprintOutput | ValidationError` helper for future reverse-derivation work (used by `deriveV2BlueprintFromV1` in §14.6)
    - Property-based renderer test: `renderMarkdown(fixture.json)` must produce MD that lexically matches `fixture.md` modulo whitespace and (configurable) prose-rewrap
    - Add 3 additional smaller synthetic fixtures: simple Slack FAQ bot, mid-complexity internal billing assistant, voice-only ASR demo — covers the 3 preset tiers
    - Renderer tests run in CI; failures block deploy

**Exit criteria:** All units testable in isolation. Renderer property tests pass for the 5 fixtures (2 reference + 3 synthetic). Old path completely untouched. Golden corpus committed under `packages/arch-ai/src/blueprint/__tests__/fixtures/`.

### 14.3 Phase 1 — Internal dogfood (1 week)

Flag on for arch dev team's tenant. Run 5+ real arch projects of varying complexity through new path. Identify UX friction. Tune classifier thresholds.

**Exit criteria:** Team consensus that new path matches or beats old path. Failure rate <5%. All P0/P1 bugs fixed.

### 14.4 Phase 2 — Beta opt-in (2 weeks)

Surface "Try new arch experience" toggle in user settings for select tenants. Active monitoring + feedback.

Telemetry tracked: section approval rates, refinement counts per section, validation failure counts, lock-time gauntlet hit rate, BUILD success rate.

**Exit criteria:** Beta tenants prefer new path. Failure rate <2%. No data loss incidents. UX-blocking bugs fixed.

### 14.5 Phase 3 — Default ON for new sessions (2-4 weeks)

New sessions default to V2. Old in-flight stay on V1.

Per-session flag:

```ts
session.metadata.blueprintFlow: 'v1' | 'v2'   // immutable after first set
```

`process-message.ts` reads on every message, dispatches to v1 or v2 coordinator. **Cannot mid-flow migrate** (would corrupt in-flight state).

**Exit criteria:** New-session adoption ≥95%. v2 failure rate ≤ v1 failure rate. Support ticket volume not elevated.

### 14.6 Phase 4 — Backfill + cut in-flight sessions (1-2 weeks)

Migration logic per session:

```ts
async function migrateInFlightSession(sessionId: string): Promise<MigrationResult> {
  const session = await loadSession(sessionId);

  switch (session.phase) {
    case 'INTERVIEW':
      // Identical between flows — flip the flag
      await updateSession(sessionId, { 'metadata.blueprintFlow': 'v2' });
      return { action: 'flag-flipped', userVisible: false };

    case 'BLUEPRINT':
      // Show banner: "Your blueprint is being upgraded"
      // Derive v2.0 BlueprintOutput from current topology
      const v2Blueprint = deriveV2BlueprintFromV1(
        session.metadata.specification,
        session.metadata.topology,
      );
      await BlueprintService.create({ sessionId, output: v2Blueprint, state: 'draft' });
      await updateSession(sessionId, { 'metadata.blueprintFlow': 'v2' });
      return {
        action: 'migrated',
        userVisible: true,
        message: 'Blueprint upgraded — please review the new sections.',
      };

    case 'BUILD':
      // Too risky to cut over mid-build
      return { action: 'allow-complete-on-v1', userVisible: false };

    case 'CREATE':
      // Already past blueprint
      return { action: 'noop', userVisible: false };
  }
}
```

Backfill for created projects (no in-flight session):

```ts
async function backfillProjectBlueprint(projectId: string): Promise<void> {
  const existing = await ArchBlueprint.findOne({ projectId });
  if (existing) return;

  const project = await loadProject(projectId);
  const v1Data = await loadLegacyV1Data(projectId);

  const v2Blueprint = deriveV2BlueprintFromExistingProject(project, v1Data);

  await BlueprintService.create({
    projectId,
    sessionId: v1Data.originatingSessionId,
    output: v2Blueprint,
    state: 'linked', // immediately project-linked
    version: 1,
  });
}
```

**Exit criteria:** All in-flight sessions flipped/migrated/allowed-complete. All existing projects backfilled. v1 path still live but no new sessions enter it.

### 14.7 Phase 5 — Deprecate v1 (4 weeks)

v1 path stays live, emits deprecation warnings on every use. Telemetry tracks remaining v1 traffic. Internal announcement.

**Exit criteria:** v1 traffic ≤1%. No active v1 sessions. No bug reports on v1.

### 14.8 Phase 6 — Delete v1 (1 week)

Delete the 11 reactive layers + per-agent LLM worker + BUILD prompt + legacy specialist + `handbook-reference.ts` + `build-parallel-gen.ts` + supporting code (~2000 lines).

**Exit criteria:** Build green, tests pass, no references to v1 modules.

### 14.9 Estimated timeline + scope

| Phase     | Estimated commits  | Estimated PRs                    |
| --------- | ------------------ | -------------------------------- |
| Phase 0   | 25–35              | 6–8                              |
| Phase 1   | 5–10               | 2–3                              |
| Phase 2   | 10–15              | 4–5                              |
| Phase 3   | 5–8                | 2                                |
| Phase 4   | 8–12               | 3–4                              |
| Phase 5   | 3–5                | 1                                |
| Phase 6   | 6–10               | 3–4                              |
| **TOTAL** | **~60–95 commits** | **~22–28 PRs** over ~10–14 weeks |

### 14.10 Migration risk register

| Risk                                                          | Likelihood | Impact   | Mitigation                                                                                                     |
| ------------------------------------------------------------- | ---------- | -------- | -------------------------------------------------------------------------------------------------------------- |
| In-flight session migration corrupts user work                | Medium     | High     | Phase 4 happens AFTER Phase 3 has proven adoption; migration script tested on synthetic v1 sessions in Phase 0 |
| Backfill misses some projects                                 | Medium     | Medium   | Backfill enumerates ALL projects without v2 blueprint; idempotent re-run possible                              |
| v2 has regression that surfaces only at scale                 | Medium     | Medium   | Phased rollout — flag-driven cohorts — caught before full launch                                               |
| User data loss during migration                               | Low        | Critical | v1 data preserved (not deleted) until Phase 6; immediate rollback possible from Phase 4                        |
| New path has higher LLM cost                                  | Low–medium | Medium   | Telemetry tracks per-session cost; tune section depth defaults or LLM model selection (default Haiku)          |
| Older project blueprints (backfilled v1 → v2) feel incomplete | High       | Low      | Banner explicitly tells user; refinement is non-blocking                                                       |

---

## 15. Audit Findings & Corrections

### 15.1 V1 — Runtime contract corrections

| Issue                 | Original design             | Runtime reality                                                                           | Action                                                                     |
| --------------------- | --------------------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Conditions            | "CEL strings" (vague)       | `evaluateConditionDual` (CEL-first w/ legacy fallback); prose conditions silently skipped | BV-001 actively parses CEL                                                 |
| Tool resolution       | Tools as part of agent spec | TOOLS in ABL is **names only**; bindings live in `ProjectTool`                            | Split: `perAgent[].tools[]` is refs; `integrations.tools[]` is descriptors |
| GatherConfig.strategy | Per-field flag              | Per-config (`llm \| pattern \| hybrid`)                                                   | Restructured: `gather: { strategy, fields[] }`                             |
| Guardrails            | "Single source of truth"    | Runtime overlays DB policies at `runtime-executor.ts:3517-3519`                           | Acknowledge DB policy overlay; Blueprint guardrails are defaults           |
| `human_approval` step | Used in renderer examples   | In IR but no runtime consumer                                                             | **Excluded from renderer** (BV-018)                                        |
| Source hash           | Not in design               | Required for IR cache                                                                     | Added `metadata.sourceHash` (BV-019)                                       |
| Voice fields          | Not detailed                | `VoiceConfigIR` per-step + per-respond                                                    | Specced per-step `voice_config` shape in renderer                          |
| Memory shape          | Generic paths               | `MemoryConfig` structured: session/persistent/remember/recall                             | Match exact IR shape in `PerAgentSpec.memory`                              |

### 15.2 V2 — Onboarding flow corrections

| #   | Gap                                                | Action in design                                                                                                                                       |
| --- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| B1  | Section content persists only via streaming deltas | Per-section checkpoint in `BlueprintService.persistSection` before approval widget emits                                                               |
| B2  | Resume snapshot has no per-section state           | Extend `buildResumeSnapshot` with `blueprintOutput: { sections[], currentSectionId, lastApprovedSectionId }`                                           |
| B3  | No per-tenant LLM budget                           | Per-tenant per-day token-budget gate; `BUDGET_EXCEEDED` typed error                                                                                    |
| B4  | Telemetry missing blueprint events                 | Extend `UserActionDetail.action`: `section_approved/rejected/refined/skipped`, `blueprint_locked/forked/rebuilt`; new `blueprint_event` audit category |
| B5  | Blueprint state mutations don't auto-journal       | Wrap every `BlueprintService.lock()` / `updateSection()` / `linkToProject()` in `journalAppendAndEmit`                                                 |
| B6  | `pendingInteraction` schema = ONE widget           | Map per-section approval to existing widget shape — no parallel-widget invention                                                                       |
| B7  | 100-message hard cap                               | Per-section message-count tracking; soft cap on refinements per section (5); compaction strategy                                                       |
| B8  | No `BLUEPRINT_VALIDATION_FAILED` typed error       | Add typed error with section + field + Zod issue path; UI surfaces `[Go to section]` deep link                                                         |
| B9  | File propagation strategy undefined                | `BlueprintAttachmentContext` pinned at BLUEPRINT entry; `fillSection` rehydrates per call; chunked-summary contract for files >20KB                    |
| B10 | Image input behavior in BLUEPRINT                  | Document: images consumed by classifier + section-fill calls; no structured extraction                                                                 |
| B11 | Multi-tab semantics                                | Document: pessimistic — second tab read-only; lock prevents parallel mutations                                                                         |
| B12 | A11y baseline missing                              | Explicit ARIA contracts in §12.8; implemented during UI build per WCAG 2.1 AA                                                                          |
| B13 | Stuck-session 25-min cutoff                        | Document: max single LLM call time stays under cutoff                                                                                                  |

### 15.3 V3 — In-project mode corrections

| #     | Mismatch                                             | Action in design                                                                                                                                                                              |
| ----- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1    | No project-scoped Blueprint model                    | `arch_blueprints` collection (Section 11)                                                                                                                                                     |
| C2    | No blueprint tools in IN_PROJECT_SPECIALIST_TOOL_MAP | 5 new tools (Section 13.4)                                                                                                                                                                    |
| C3    | `in-project-architect` prompt is generalist alias    | Write real prompt (Section 13.5)                                                                                                                                                              |
| C4/C5 | Drift problem: direct ProjectAgent mutations         | **Blueprint-only canonical edits** (§13.2) — no lossless DSL→Blueprint mapper needed; renders flow one direction (blueprint → DSL); manual-drift escape hatch is explicit per project (§13.9) |
| C6    | Rebuild wipes local edits silently                   | Local-edit guard with explicit confirmation (Section 13.3)                                                                                                                                    |
| C7    | Plan-gating overhead for trivial edits               | Extend `classifyMutationScope` (Section 13.7)                                                                                                                                                 |
| C8    | Existing BUILD↔BLUEPRINT backtrack                   | Hook into existing path; blueprint edit triggers backtrack                                                                                                                                    |
| C9    | AgentVersion write path missing                      | **REQUIRED** — every mutation path writes AgentVersion (§13.8)                                                                                                                                |
| C10   | Two mutation paths (gated + bulk)                    | Bulk path **disabled in v2-canonical mode**; explicit manual-drift escape hatch per project (§13.9)                                                                                           |

---

## 16. Scope: v1 / v2 / Out-of-Scope

### 16.1 V1 — In scope (this design)

**Workstream 1: Schema alignment** — All A1–A8 runtime corrections. `PerAgentSpec` authoring schema compiles to IR; CEL validation; tool refs split from bindings; GatherConfig restructured; DB policy overlay acknowledged; `human_approval` excluded; source hash round-trip; memory shape matches IR.

**Workstream 2: Persistence + recovery** — B1, B2, B7. Per-section checkpoint; resume snapshot extension; refinement count tracking.

**Workstream 3: In-project integration** — C1–C5, C8. `arch_blueprints` collection; 5 new blueprint tools; real `in-project-architect` prompt; blueprint-only canonical edits plus manual-drift guard; hook into existing backtrack.

**Workstream 4: Data safety** — C6, C9. Local-edit guard; verify + ensure AgentVersion writes.

**Workstream 5: Cost controls + telemetry** — B3, B4, B5. Per-tenant LLM budget; section_approved/rejected/refined events; auto-journal blueprint mutations.

**Workstream 6: Error UX** — B6, B8. BLUEPRINT_VALIDATION_FAILED typed error; UI banner with deep links; sequential widget pattern documented.

**Workstream 7: Documented constraints** — B10, B11, B12, A6. Image input docs; multi-tab pessimistic locking; A11y ARIA contracts; i18n known constraint.

**Plus 6 original design sections** — 4-stage BLUEPRINT, BUILD compiler, MD renderer, UI panel, migration, lifecycle.

**Estimated V1 scope (canonical, used everywhere in this spec):** ~170 files touched, **60–95 commits, 22–28 PRs**, over ~10–14 weeks. (This number is the same as the migration phase total in §14.9 — the workstreams above ARE the work that the migration phases roll out.)

### 16.2 V2 — Deferred (explicit out-of-scope for this design)

| Feature                                                                                            | Why deferred                                                                    | Compensating control in v1                                                                                                                     |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Multi-user collaborative editing                                                                   | Significant data-model migration (session scoping `userId` → `projectId+roles`) | Lock prevents conflicts; one user per session today                                                                                            |
| Multi-tab live mirror (fan-out subscriber wiring)                                                  | Modest complexity; lock already prevents bad behavior                           | Documented as poll-only                                                                                                                        |
| Image-based architecture extraction                                                                | Requires vision-LLM workflow design                                             | Manual capture by user during INTERVIEW                                                                                                        |
| Blueprint as collaborative review (PR-style comments)                                              | Adds review/comment subsystem                                                   | v1 single-author; review via export + external tools                                                                                           |
| Cross-tenant blueprint sharing / marketplace                                                       | Requires entirely new auth/visibility model                                     | v1 tenant-private                                                                                                                              |
| Voice input to BLUEPRINT chat                                                                      | Speech-to-text + multimodal pipeline                                            | v1 text + image only                                                                                                                           |
| Bulk-path raw DSL editing as a first-class flow                                                    | v2-canonical mode disables bulk raw-DSL writes (would silently drift blueprint) | v1 explicit per-project "manual-drift mode" toggle (§13.9); blueprint state archived when toggled off                                          |
| Non-HTTP tool bootstrap (mcp / sandbox / lambda / connector / workflow / searchai / async_webhook) | Each type needs CREATE-time provisioning + runtime binding verified end-to-end  | v1 supports only HTTP bootstrap; non-HTTP refs accepted only when pointing to existing Project Tool by id (§8.10). v1.5 milestone widens this. |

### 16.3 Out-of-scope (not planned)

- Real-time multi-user editing (Google Docs-style)
- Branching / forking of blueprints for "what if" exploration (beyond version snapshots)
- Public blueprint repository / marketplace
- AI-driven blueprint optimization (suggest improvements after deployment based on telemetry)
- Cross-project blueprint composition (compose multi-project systems from individual blueprints)

---

## 17. Open Questions for LLD

These are questions LLD must answer before implementation, NOT design ambiguity:

1. **Renderer YAML emission style**: Use a YAML library (e.g., `js-yaml`) or hand-formatted strings? Tradeoff: library handles edge cases (quoting, escaping) but adds dependency; hand-formatted preserves exact ABL DSL style.

2. **Per-section LLM model selection**: Use Haiku 4.5 for all section calls (cheaper) or vary by section type? Persona may want Sonnet; topology may want Haiku.

3. **Streaming SSE shape for section content**: Stream chunked markdown deltas, or render incrementally section-by-section? UX tradeoff: streaming feels faster but is harder to checkpoint reliably.

4. **Validation gauntlet performance**: Run all BV-001..BV-020 in parallel or sequentially? Some rules depend on others (e.g., BV-002 needs BV-006 to have passed). LLD specifies DAG of validation dependencies.

5. **Tool DSL renderer for non-HTTP types**: How to emit DSL for `mcp`, `function`, `sandbox`, etc.? Need to coordinate with existing tool binding executors at `packages/compiler/src/platform/constructs/executors/tool-binding-executor.ts`.

6. **Blueprint diff library choice**: `react-diff-viewer-continued`, `react-markdown-diff`, or custom? Picks affect visual style.

7. **A11y testing harness**: How to automate a11y tests for the panel? `@axe-core/react`, manual screen-reader testing, or both?

8. **Backfill performance**: Backfill for N existing projects — sequential, batched, or queued via BullMQ? Affects Phase 4 duration.

9. **Schema migration testing**: How to generate representative v1 session fixtures for migration testing? Use real anonymized data or synthetic.

10. **Per-tenant LLM budget storage**: Mongo doc on tenants collection? Redis counter? How does cron-based reset work?

11. **Section template inheritance**: When section depth is `compact`, what gets cut? Is there a base template + extension tiers, or three separate templates per section?

12. **Fixture freshness as schema evolves**: Golden corpus is a Phase 0 deliverable (5 fixtures: 2 reference + 3 synthetic) — see §14.2 step 11. Open question for LLD: when `BlueprintOutputSchema` changes (added field, renamed field), what's the fixture-update workflow? Auto-migration via the same migrator framework (§4.8 / §11.8), manual update with PR review, or both?

---

## 18. Acceptance Criteria

A successful v1 implementation meets all of:

### 18.1 Functional

- [ ] User can complete an INTERVIEW with all 12+ structured fields captured
- [ ] BLUEPRINT phase runs 4 stages (CLASSIFY → DECIDE ARCHITECTURE → PLAN SECTIONS → FILL SECTIONS) with widget at each stage
- [ ] Sections render in artifact panel as markdown with sticky ToC
- [ ] Per-section approval gates work (`Approve`, `Refine`, `Skip` actions)
- [ ] Section refinement via chat updates structured data and re-renders MD
- [ ] Lock gauntlet runs BV-001..BV-020; failures surface as banner with deep links
- [ ] BUILD produces ABL DSL deterministically without LLM calls
- [ ] Sanity compile catches renderer bugs; surfaces as "internal error"
- [ ] CREATE produces project + agents + tools from locked blueprint
- [ ] Post-CREATE: `Edit` forks new draft; `Lock` creates new version; `Rebuild` regenerates with explicit confirmation
- [ ] All v2-canonical in-project mutations that affect agents go through blueprint edits and renderer-originated DSL writes; legacy raw DSL writes are blocked unless manual-drift mode is enabled
- [ ] In-project chat uses real in-project-architect prompt (not generalist alias)
- [ ] Blueprint MD can be exported as `.md` file
- [ ] Diff view shows per-section changes between versions
- [ ] Per-section persistence: disconnect during section fill, content survives, user resumes at approval gate

### 18.2 Non-functional

- [ ] BUILD time ≤10s for 4-agent project (parallel renders)
- [ ] BLUEPRINT total time ≤5min for complex project (including all user iteration)
- [ ] BUILD success rate ≥95% (only renderer bugs cause failure)
- [ ] Per-tenant LLM budget enforced (`BUDGET_EXCEEDED` typed error)
- [ ] All blueprint mutations auto-write to journal
- [ ] Telemetry events fire for section_approved/rejected/refined/skipped/blueprint_locked/forked/rebuilt
- [ ] A11y: WCAG 2.1 AA compliance verified for blueprint panel
- [ ] Schema migration tested on representative v1 sessions
- [ ] No data loss during migration phases
- [ ] Old `build-parallel-gen.ts` retired (~2000 LOC deleted at Phase 6)
- [ ] All 16 reactive layers' bug classes documented as covered by 12 defense layers OR documented as residual risk

### 18.3 Quality

- [ ] 100% of `PerAgentSpec` fields trace to runtime IR or are explicitly deliverable polish
- [ ] All renderers are pure functions with unit tests (no mocks, no I/O)
- [ ] Property-based renderer tests pass for 5+ representative blueprints
- [ ] No `vi.mock` or `jest.mock` of `@agent-platform/*` / `@abl/*` in test suite (per platform-mock-lint)
- [ ] E2E test creates a project end-to-end via the new v2 path
- [ ] Migration script tested on synthetic v1 sessions in Phase 0
- [ ] Backfill script idempotent (re-runnable safely)
- [ ] All API routes have integration tests against real Mongo + Redis (per CLAUDE.md test rules)
- [ ] **AgentVersion writes verified for every mutation path** (`applyProjectAgentModification`, `createNewProjectAgent`, `agent_ops.modify`, blueprint render path) — integration test asserts presence of corresponding `AgentVersion` row after each
- [ ] **Golden-corpus fixtures committed** under `packages/arch-ai/src/blueprint/__tests__/fixtures/reference-blueprints/` (5 fixtures: 2 reference + 3 synthetic) — see §14.2 step 11
- [ ] **Renderer property tests pass** for every fixture — `renderMarkdown(fixture.json)` matches `fixture.md` modulo whitespace
- [ ] **Tenant-scoped indexes verified** on `arch_blueprints` collection — schema migration test asserts compound indexes start with `tenantId`

### 18.4 Documentation

- [ ] All 18 sections of the blueprint have rendered examples in the design doc
- [ ] Schema migration playbook documented for ops
- [ ] Per-package `agents.md` updated for `packages/arch-ai`, `packages/database`, `apps/studio`
- [ ] Feature spec under `docs/features/` (post-impl-sync)
- [ ] Test spec under `docs/testing/` (post-impl-sync)
- [ ] HLD reference in `docs/specs/`
- [ ] LLD reference in `docs/plans/`

---

## 19. Risk Register

### 19.1 Architectural risks

| Risk                                                         | Likelihood                            | Impact                       | Mitigation                                                                                                                                                                                   |
| ------------------------------------------------------------ | ------------------------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Renderer YAML bug (dev introduces construct, template wrong) | Medium initial; low after CI maturity | High (BUILD fails for users) | L9 sanity compile + L12 property-based tests + golden corpus                                                                                                                                 |
| PERSONA quality regression from structured generation        | Low–medium                            | Medium                       | All LLM work in BLUEPRINT with multi-layer defense; quality matches/exceeds today                                                                                                            |
| Schema migration corrupts user data                          | Low                                   | Critical                     | v1 data preserved; rollback possible at every phase up to 5; explicit migration tests                                                                                                        |
| Cross-section drift during iteration                         | Medium                                | Medium                       | L5 cross-section consistency at every approval gate; L6 final gauntlet                                                                                                                       |
| In-project mode integration regressions                      | Medium                                | High                         | Blueprint-only canonical edits (§13.2); local-edit guard via updatedAt + sourceHash (§13.3); AgentVersion writes REQUIRED (§13.8); manual-drift escape hatch is explicit per project (§13.9) |

### 19.2 Operational risks

| Risk                                                | Likelihood | Impact | Mitigation                                                                       |
| --------------------------------------------------- | ---------- | ------ | -------------------------------------------------------------------------------- |
| LLM cost blowup from refinement-heavy projects      | Medium     | Medium | Per-tenant per-day budget; soft cap on refinements per section; default to Haiku |
| Sessions stuck in BLUEPRINT (long iteration)        | Low        | Low    | Existing 25-min stuck-session detection; document max LLM call time stays under  |
| Backfill takes too long for large customers         | Medium     | Medium | Phase 4 background queue via BullMQ; monitor and pace                            |
| Migration script fails on unusual v1 session shapes | Medium     | Medium | Idempotent retry; manual review path; rollback flag                              |

### 19.3 Team risks

| Risk                                               | Likelihood                       | Impact | Mitigation                                                                                    |
| -------------------------------------------------- | -------------------------------- | ------ | --------------------------------------------------------------------------------------------- |
| ~12-week timeline slip                             | Medium                           | Medium | Phased rollout = early signal; can pause at any phase                                         |
| LLD reveals load-bearing assumption was wrong      | Low (after 3-round verification) | High   | Open Questions in §17 surface remaining ambiguity; LLD answers them before coding             |
| Renderer logic too complex for pure-function model | Low                              | High   | If found, fall back to Variant 2 (LLM-on-persona-only) — keeps determinism for FLOW structure |
| Beta tenant rejection in Phase 2                   | Low                              | Medium | Phase 1 dogfood catches most UX issues first; Phase 2 has rollback                            |

### 19.4 Out-of-scope risks (accept)

- Multi-user collaboration impedance — accepted; v2 feature
- Image-as-architecture extraction — accepted; manual capture v1
- Real-time SSE for second tab — accepted; documented as poll-only

---

## 20. Appendix

### 20.1 File location summary

| Asset                           | Location                                                                        |
| ------------------------------- | ------------------------------------------------------------------------------- |
| Updated Blueprint schema        | `packages/arch-ai/src/types/blueprint.ts`                                       |
| Blueprint service               | `packages/arch-ai/src/blueprint/blueprint-service.ts`                           |
| Markdown renderer               | `packages/arch-ai/src/blueprint/markdown-renderer.ts`                           |
| Lock-time validators            | `packages/arch-ai/src/blueprint/validators.ts`                                  |
| Migration framework             | `packages/arch-ai/src/blueprint/migrations.ts`                                  |
| Mongo model                     | `packages/database/src/models/arch-blueprint.model.ts`                          |
| Compiler driver                 | `packages/arch-ai/src/compiler/driver.ts`                                       |
| Renderer suite                  | `packages/arch-ai/src/compiler/renderers/`                                      |
| Section LLM-call infrastructure | `packages/arch-ai/src/blueprint/section-fill/`                                  |
| 4-stage coordinator             | `packages/arch-ai/src/coordinator/blueprint-stages.ts`                          |
| Studio panel                    | `apps/studio/src/lib/arch-ai/components/arch/panels/BlueprintPanel.tsx`         |
| Studio chat widgets             | `apps/studio/src/lib/arch-ai/components/arch/chat/widgets/`                     |
| Session-scoped API routes       | `apps/studio/src/app/api/arch-ai/sessions/[id]/blueprint/`                      |
| Project-scoped API routes       | `apps/studio/src/app/api/arch-ai/projects/[projectId]/blueprint/`               |
| In-project architect prompt     | `packages/arch-ai/src/prompts/specialists/in-project-architect.ts` (rewrite)    |
| Blueprint tools                 | `packages/arch-ai/src/types/tools.ts` (extend `IN_PROJECT_SPECIALIST_TOOL_MAP`) |

### 20.2 Files to delete at Phase 6

| File                                                         | LOC (estimated) | Reason                                           |
| ------------------------------------------------------------ | --------------- | ------------------------------------------------ |
| `apps/studio/src/lib/arch-ai/build-parallel-gen.ts`          | ~1100           | Per-agent LLM worker — replaced by pure renderer |
| `apps/studio/src/lib/arch-ai/handbook-reference.ts`          | ~500            | `buildAgentSystemPrompt` no longer needed        |
| `apps/studio/src/lib/arch-ai/build-orchestrator.ts`          | ~150            | Cross-agent validation moves to lock-time        |
| `apps/studio/src/lib/arch-ai/build-source-normalization.ts`  | ~120            | Auto-repair no longer needed                     |
| `apps/studio/src/lib/arch-ai/build-retry-policy.ts`          | ~80             | Retries move to per-section in BLUEPRINT         |
| `apps/studio/src/lib/arch-ai/build-result-reconciliation.ts` | ~150            | Reconciliation no longer needed                  |
| `apps/studio/src/lib/arch-ai/cross-agent-validator.ts`       | ~100            | Validation moves to lock-time                    |
| Various retry/recovery helpers                               | ~200            | Subsumed by 12-layer defense                     |
| **Total**                                                    | **~2400 LOC**   |                                                  |

### 20.3 Reference blueprint samples (canonical templates) — Phase 0 deliverable

The two reference blueprints originate from `~/Downloads/`:

- `lastminute_blueprint_v2.md` (1146 lines)
- `Lumen_Agentic_Billing_Platform_Blueprint_v1.1.md` (1138 lines)

**Phase 0 work to materialize the golden corpus** (gates Phase 0 exit per §14.2 step 11):

1. **Copy MD files** into `packages/arch-ai/src/blueprint/__tests__/fixtures/reference-blueprints/`
2. **Manually author the structured `BlueprintOutput` v2.0 JSON** for each — read the MD section-by-section, populate every field of every typed slot. This is real engineering work, ~1-2 days per fixture. The deliverable per fixture is `<name>.input.json` (BlueprintOutput) + `<name>.expected.md` (the original MD, lightly normalized for whitespace).
3. **Add 3 synthetic fixtures** covering the three preset tiers:
   - `simple-faq-bot.{input.json, expected.md}` — single-agent Slack KB bot, `internal-dev` preset
   - `mid-billing-assistant.{input.json, expected.md}` — 2-agent internal billing helper, `prod-launch` preset
   - `voice-asr-demo.{input.json, expected.md}` — voice-only voice agent, `enterprise-poc` preset
4. **Add `parseBlueprintOutputFromMd(mdString)` helper** at `packages/arch-ai/src/blueprint/parsers/parse-from-md.ts` for future reverse-derivation work — used by `deriveV2BlueprintFromV1` in §14.6 and useful for round-trip tests
5. **Wire renderer property tests** at `packages/arch-ai/src/blueprint/__tests__/renderer-property.test.ts`: for each fixture, assert `renderMarkdown(fixture.input.json)` equals `fixture.expected.md` modulo whitespace

This is **NOT snapshot theater** — it requires deliberate authorship of structured inputs, but once authored, the renderer is held to a high bar: any output drift fails CI.

### 20.4 Section-by-section MD rendering examples

Once §20.3's fixtures land, every section in the spine has at least one rendered example across the 5 fixtures. LLD will derive per-section renderer templates from these. The `simple-faq-bot` fixture exercises the always-on sections; the `enterprise-poc` and `prod-launch` fixtures exercise the conditional sections.

### 20.5 Glossary

| Term                          | Definition                                                                                                                                                                                     |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BlueprintOutput`             | The structured v2.0 schema; single source of truth for arch-ai projects                                                                                                                        |
| Blueprint MD doc              | The 17-section markdown rendered from `BlueprintOutput` via `renderMarkdown()`                                                                                                                 |
| BLUEPRINT phase               | The arch-ai phase between INTERVIEW and BUILD — now 4 sub-stages                                                                                                                               |
| BUILD phase                   | The arch-ai phase that compiles BlueprintOutput to ABL DSL — now pure renderer                                                                                                                 |
| 4-stage flow                  | CLASSIFY → DECIDE ARCHITECTURE → PLAN SECTIONS → FILL SECTIONS                                                                                                                                 |
| Renderer                      | A pure function in `packages/arch-ai/src/compiler/renderers/`                                                                                                                                  |
| 12-layer defense              | The set of validation + retry + fallback layers preventing/catching LLM errors                                                                                                                 |
| Blueprint-only canonical mode | All structured architectural edits flow through `propose_blueprint_edit`; agent files re-rendered from the blueprint; raw-DSL writes disabled (§13.2)                                          |
| Manual-drift mode             | Per-project explicit toggle (`Project.archConfig.canonicalBlueprintMode = false`) that disables blueprint enforcement and allows raw-DSL editing; blueprint state archived; reversible (§13.9) |
| Local-edit guard              | Pre-rebuild conflict check using `ProjectAgent.updatedAt` AND `sourceHash` (§13.3) — surfaces overwrites for explicit user acknowledgement                                                     |
| AgentVersion write            | Required snapshot row created in same transaction as every `ProjectAgent.dslContent` write (§13.8); foundation for blueprint version rollback                                                  |
| Section approval gate         | Widget shown after each section LLM completes; user approves or refines                                                                                                                        |
| Lock-time gauntlet            | BV-001..BV-030 validation suite that runs before draft → locked transition                                                                                                                     |
| Variant 3                     | The chosen BUILD architecture: pure deterministic renderer with zero LLM calls                                                                                                                 |
| `arch_blueprints`             | New Mongo collection storing immutable version snapshots; tenant-scoped indexes                                                                                                                |
| Golden corpus                 | 5 renderer fixtures (2 reference + 3 synthetic) with structured input JSON + expected MD output, used for property-based renderer tests in CI (§14.2 step 11)                                  |

### 20.6 Related work

- Spec-document pattern (`packages/arch-ai/src/spec-document/`): structured + render MD on read, this design mirrors
- Journal service (`packages/arch-ai/src/journal/`): project linkage + tenant isolation, this design mirrors
- Scaffold slot-fix-loop (`apps/studio/src/lib/arch-ai/scaffold/slot-fix-loop.ts`): per-slot retries + fallback defaults, this design extends to per-section
- Existing agent-architecture-planner (`packages/arch-ai/src/planning/agent-architecture-planner.ts`): extends, not replaces

### 20.7 Out-of-scope clarifications

- This design does NOT redesign INTERVIEW capture beyond expanding required fields
- This design does NOT modify runtime execution (agent IR consumption, tool resolution, etc.) — only how arch-ai produces the ABL DSL
- This design does NOT change CREATE phase semantics (still deterministic; only the bootstrap call simplifies)
- This design does NOT change project model, agent model, or tool model — only adds `arch_blueprints` collection alongside

---

**End of design specification.**

For implementation planning, this spec hands off to: `superpowers:writing-plans` skill → LLD generation → `docs/plans/2026-05-11-arch-blueprint-document-implementation-plan.md` → phased implementation.
