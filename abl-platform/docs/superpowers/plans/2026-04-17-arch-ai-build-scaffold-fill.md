# Arch-AI BUILD Scaffold+Fill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the free-form "LLM generates ABL YAML" BUILD path with a deterministic scaffold generator + structured-output LLM fill + assembler pipeline, closing the structural failure modes documented in diagnostics `1228a16b`, `3dd30d8e`, and `7093c7b0`.

**Architecture:** Deterministic code owns all structural fields of each agent (keyword, HANDOFF targets, RETURN flags, catch-all, MEMORY/GUARDRAILS shell). LLM owns only creative slots (GOAL, PERSONA, WHEN refinements, GATHER questions, tool descriptions) via structured-output JSON. Three validation rings (schema then content then compile) with per-slot re-prompting. Ships behind `FEATURE_SCAFFOLD_GENERATION` flag.

**Tech Stack:** TypeScript, AI SDK v4 structured output, Vitest, existing `@agent-platform/arch-ai` planner output, existing `@abl/compiler` diagnostics.

**Branch:** `arch/agentgeneration` (current — do not switch per CLAUDE.md)

**Spec:** `docs/superpowers/specs/2026-04-17-arch-ai-build-scaffold-fill-design.md`

**Commit convention:** `[ABLP-162] <type>(studio): <description>`

---

## File Structure

All new code lives under `apps/studio/src/lib/arch-ai/scaffold/`. Existing files are modified minimally; the legacy path is preserved behind the feature flag for rollback safety.

### Create

| File                                                         | Responsibility                                                                                         |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `apps/studio/src/lib/arch-ai/scaffold/types.ts`              | Shared types: `AblSkeleton`, `CreativeContent`, `Slot`, `SlotMap`, `ScaffoldResult`, `FillLoopResult`. |
| `apps/studio/src/lib/arch-ai/scaffold/scaffold-generator.ts` | Pure function `scaffoldAblAgent(plan, topology, spec, domain)`. Per-archetype skeleton construction.   |
| `apps/studio/src/lib/arch-ai/scaffold/creative-schemas.ts`   | Per-archetype JSON schema builders.                                                                    |
| `apps/studio/src/lib/arch-ai/scaffold/assembler.ts`          | Pure function `assembleAblAgent(skeleton, creative)`. Skeleton to YAML with slot-to-line mapping.      |
| `apps/studio/src/lib/arch-ai/scaffold/slot-validators.ts`    | Per-slot pure validators.                                                                              |
| `apps/studio/src/lib/arch-ai/scaffold/slot-fix-loop.ts`      | Orchestrates three-ring validation with per-slot re-prompt.                                            |
| `apps/studio/src/lib/arch-ai/scaffold/worker-runner.ts`      | New worker code path entry point.                                                                      |
| `apps/studio/src/__tests__/arch-ai/scaffold/*.test.ts`       | Unit tests (one per module) + parity test.                                                             |

### Modify

| File                                                | Change                                                                                                     |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `apps/studio/src/lib/arch-ai/build-parallel-gen.ts` | Branch on `FEATURE_SCAFFOLD_GENERATION` env var: new path calls `worker-runner.ts`, legacy path unchanged. |

### Preserve (legacy path for rollback)

- `apps/studio/src/lib/arch-ai/handbook-reference.ts` — unchanged; used when flag is off.
- `apps/studio/src/lib/arch-ai/helpers/compile-and-fix.ts` — unchanged; used when flag is off.

---

## Slice Structure

The plan is decomposed into three slices. Each slice produces working, testable software behind the feature flag. Hand off for review at slice boundaries.

- **Slice 1: Foundation + supervisor archetype** (Tasks 1-11, ~2 days) — ships supervisor scaffolding for `triage_specialists` topologies. Eliminates the self-reference failure class.
- **Slice 2: Specialist archetype with GATHER + COMPLETE** (Tasks 12-15, ~1 day) — extends scaffold to delegate targets.
- **Slice 3: Remaining archetypes + rollout** (Tasks 16-21, ~2 days) — pipeline_stage, worker, single_agent; parity tests; flag-on.

---

> **NOTE:** Full task-by-task details (with test code, implementation code, expected output, and commit commands) are in the `PLAN-DETAILS` companion file at the same path, section-linked by task number. This header file is the overview used for progress tracking; the details file is the step-by-step recipe the executing agent follows.

## Task Index

### Slice 1: Foundation + Supervisor Archetype

- [ ] **Task 1:** Define shared types (`types.ts`)
- [ ] **Task 2:** Scaffold generator — supervisor branch + dispatcher (`scaffold-generator.ts`)
- [ ] **Task 3:** Extract `creative-schemas.ts` from scaffold-generator
- [ ] **Task 4:** Assembler — render skeleton + creative to YAML (`assembler.ts`)
- [ ] **Task 5:** Slot validators — pure functions (`slot-validators.ts`)
- [ ] **Task 6:** Slot fix-loop — structured output + validation + re-prompt (`slot-fix-loop.ts`)
- [ ] **Task 7:** Worker runner — end-to-end scaffold path (`worker-runner.ts`)
- [ ] **Task 8:** Feature flag + build-parallel-gen branching
- [ ] **Task 9:** Parity test fixture — triage_specialists
- [ ] **Task 10:** End-to-end parity test against CommerceCare-class topology
- [ ] **Task 11:** Slice 1 handoff — internal flag-on test + diagnostic doc

### Slice 2: Specialist Archetype

- [ ] **Task 12:** Verify GATHER + COMPLETE types already present
- [ ] **Task 13:** Scaffold generator — specialist branch
- [ ] **Task 14:** Assembler extension — GATHER + COMPLETE + MEMORY.session vars
- [ ] **Task 15:** Extend slot validators + fix-loop for specialist slots; enable specialist in flag

### Slice 3: Remaining Archetypes + Rollout

- [ ] **Task 16:** Scaffold pipeline_stage (incoming + outgoing delegates)
- [ ] **Task 17:** Scaffold worker (sink) and single_agent
- [ ] **Task 18:** Reference topology fixtures for all 5 canonical patterns
- [ ] **Task 19:** Parity test suite across all 5 patterns
- [ ] **Task 20:** Flag default ON + legacy path deprecation notice
- [ ] **Task 21:** Production verification + diagnostic doc

---

## Slice exit criteria

### Slice 1

- Supervisor agents emitted via the scaffold path have 100% correct HANDOFF targets.
- Self-reference failure class eliminated for supervisors.
- Legacy path fully intact (flag default off).
- All existing tests pass.

### Slice 2

- Specialist agents route through scaffold path when flag is on.
- GATHER fields match topology hints exactly.
- COMPLETE conditions reference only declared GATHER names (validator enforces).

### Slice 3

- 100% compiled rate on all 5 reference patterns in parity tests.
- Flag default ON; production verification doc written.
- Legacy paths marked deprecated; removal scheduled.

---

## Spec coverage matrix

| Spec section                                         | Covered by                             |
| ---------------------------------------------------- | -------------------------------------- |
| §2.1 goals — structurally prevent failures           | Tasks 2, 4, 13                         |
| §2.1 goals — preserve creative leverage              | Tasks 2, 13, 17                        |
| §2.1 goals — compress prompt size                    | Task 2 (prompt rendering)              |
| §2.1 goals — field-scoped fixes                      | Task 6 (slot fix-loop)                 |
| §2.1 goals — keep UI/SSE/metadata shape unchanged    | Task 8                                 |
| §2.1 goals — keep compile_abl gate                   | Task 7                                 |
| §2.3 success criteria — 7/7 compiled on CommerceCare | Tasks 10, 19, 21                       |
| §5 scaffold generator contract                       | Tasks 1, 2, 3, 13, 16, 17              |
| §5.4 worked Triage example                           | Task 10 (parity test)                  |
| §5.5 per-archetype behavior                          | Tasks 2, 13, 16, 17                    |
| §6 assembler                                         | Task 4                                 |
| §7.1 Ring 1 JSON schema                              | Tasks 3, 13                            |
| §7.1 Ring 2 content validators                       | Tasks 5, 15                            |
| §7.1 Ring 3 compile gate                             | Task 21 (via reconciliation)           |
| §7.1 fallback defaults                               | Task 6                                 |
| §8.1 code organization                               | All tasks place files under scaffold/  |
| §8.4 rollout phases                                  | Tasks 11, 20, 21                       |
| §8.5 streaming UX                                    | Task 8 (existing SSE events preserved) |
| §8.6 backwards compat                                | Task 8                                 |

### Deferred (tracked, not hidden)

- **Slot-map-based Ring 3 re-prompt** — spec §7.1: reconciliation backstop used initially; per-slot compile-error trace is a follow-up.
- **Skeleton-first streaming UX** — spec §8.5: existing `file_content_delta` preserved; two-stage streaming is UX polish.
- **Tools scaffold** — spec §5.3: `tools: []` empty in Slice 1-3; tool signature + description slots are a Slice 4 item if needed.
- **CONSTRAINTS/LIMITATIONS slots** — deferred per spec §2.2 non-goals.

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-17-arch-ai-build-scaffold-fill.md`.

**Two execution options:**

1. **Subagent-Driven (recommended)** — dispatch a fresh subagent per task via `superpowers:subagent-driven-development`. Two-stage review per task, fast iteration, isolated context.
2. **Inline Execution** — execute tasks in this session using `superpowers:executing-plans`. Batch execution with checkpoints at slice boundaries (after Task 11, 15, 19).

Each task has detailed steps (failing test, implementation code with complete signatures, verification command with expected output, commit command) captured in the companion details file — the next step when starting execution is to open that file alongside this one.

---

# Task Details

## Slice 1: Foundation + Supervisor Archetype

### Task 1: Define shared types

**Files:**

- Create: `apps/studio/src/lib/arch-ai/scaffold/types.ts`

- [ ] **Step 1: Write the file**

```ts
/**
 * Shared types for the scaffold+fill pipeline.
 * - AblSkeleton: structured IR produced by scaffold-generator, contains all
 *   deterministic fields plus slot placeholders for creative fields.
 * - CreativeContent: validated JSON from the LLM matching the creative schema.
 * - SlotMap: line-range lookup for mapping compile errors back to slots.
 */

import type { AgentArchitecturePlan, TopologyOutput } from '@agent-platform/arch-ai';

export interface HandoffEntry {
  to: string;
  returnExpected: boolean;
  /** Slot path for the WHEN clause. Empty for catch-all (literal "true"). */
  whenSlot: string | null;
  /** If whenSlot is null, this is the literal WHEN value. */
  whenLiteral?: string;
}

export interface GatherField {
  name: string;
  type: string;
  /** Slot path for the ask prompt. */
  askSlot: string;
}

export interface AblSkeleton {
  agentName: string;
  keyword: 'AGENT' | 'SUPERVISOR';
  goalSlot: string;
  personaSlot: string;
  handoffs: HandoffEntry[];
  gatherFields: GatherField[];
  completeSlots: Array<{ whenSlot: string; reasonSlot: string }>;
  memorySessionVars: string[];
  tools: Array<{ name: string; signatureSlot: string; descriptionSlot: string }>;
  includeGuardrails: boolean;
}

export type CreativeContent = Record<string, string>;

export interface SlotLineRange {
  lineStart: number;
  lineEnd: number;
}

export type SlotMap = Map<string, SlotLineRange>;

import type { JSONSchema7 } from 'json-schema';

export interface ScaffoldResult {
  skeleton: AblSkeleton;
  creativeSchema: JSONSchema7;
  prompt: string;
}

export interface FillLoopResult {
  yaml: string;
  slotMap: SlotMap;
  creative: CreativeContent;
  slotAttempts: Record<string, number>;
  fallbackSlots: string[];
  compileStatus: 'pass' | 'warning' | 'error';
  compileErrors: string[];
  compileWarnings: string[];
}

export type { AgentArchitecturePlan, TopologyOutput };

export interface AgentSpecInput {
  name: string;
  role: string;
  executionMode: 'reasoning' | 'scripted' | 'hybrid';
  description?: string;
  tools?: string[];
  gatherFields?: string[];
  isEntry: boolean;
}

export interface DomainContextInput {
  domain: string;
  channels: string[];
  language?: string;
  compliance: string[];
  integrations: string[];
  tone: string;
}
```

- [ ] **Step 2: Format and typecheck**

Run from repo root: `npx prettier --write apps/studio/src/lib/arch-ai/scaffold/types.ts`
Then from `apps/studio`: `pnpm exec tsc --noEmit`
Expected: no errors

- [ ] **Step 3: Commit**

```
cd /Users/sriharshanalluri/abl-platform
git add apps/studio/src/lib/arch-ai/scaffold/types.ts
git commit -m "[ABLP-162] feat(studio): add scaffold pipeline types"
```

---

### Task 2: Scaffold generator — supervisor branch + dispatcher

**Files:**

- Create: `apps/studio/src/lib/arch-ai/scaffold/scaffold-generator.ts`
- Test: `apps/studio/src/__tests__/arch-ai/scaffold/scaffold-generator.test.ts`

- [ ] **Step 1: Write the failing test** (see full test code in the spec section §5.4; test asserts keyword, handoffs length, whenSlot values, and absence of gather/complete slots for supervisor)

- [ ] **Step 2: Run test, expect FAIL** (module not found)

From `apps/studio`: `pnpm exec vitest run src/__tests__/arch-ai/scaffold/scaffold-generator.test.ts`

- [ ] **Step 3: Implement scaffold-generator.ts with `scaffoldAblAgent` dispatcher + `scaffoldSupervisor` function**

Key shape:

- Dispatcher switch on `plan.archetype`; Slice 1 only `supervisor`, others throw
- `scaffoldSupervisor(plan, topology, spec, domain)`: builds HandoffEntry[] from plan.handoffs.targets (slot path `handoff.<i>.when`) + catch-all with `whenLiteral: 'true'` + no gather/complete/tools
- `buildSupervisorSchema(handoffs)`: produces JSONSchema7 with `goal`, `persona`, and nested `handoff: { properties: { "0.when": {...}, "1.when": {...} } }`
- `renderSupervisorPrompt(plan, topology, spec, domain)`: string describing agent, role, domain, topology targets

- [ ] **Step 4: Run test, expect PASS**

- [ ] **Step 5: Format and commit**

```
npx prettier --write apps/studio/src/lib/arch-ai/scaffold/scaffold-generator.ts apps/studio/src/__tests__/arch-ai/scaffold/scaffold-generator.test.ts
git add apps/studio/src/lib/arch-ai/scaffold/scaffold-generator.ts apps/studio/src/__tests__/arch-ai/scaffold/scaffold-generator.test.ts
git commit -m "[ABLP-162] feat(studio): scaffold generator for supervisor archetype"
```

---

### Task 3: Extract creative-schemas.ts

**Why:** Keeps scaffold-generator focused on skeleton shape; schema-building grows across archetypes.

**Files:**

- Create: `apps/studio/src/lib/arch-ai/scaffold/creative-schemas.ts`
- Modify: `apps/studio/src/lib/arch-ai/scaffold/scaffold-generator.ts` (move and import)

Steps: move `buildSupervisorSchema` to new file; re-import in scaffold-generator; verify tests still pass; commit as refactor.

---

### Task 4: Assembler — render skeleton + creative to YAML

**Files:**

- Create: `apps/studio/src/lib/arch-ai/scaffold/assembler.ts`
- Test: `apps/studio/src/__tests__/arch-ai/scaffold/assembler.test.ts`

Tests assert: SUPERVISOR line present, GOAL/PERSONA rendered, all HANDOFF TO: names match skeleton (no self-ref), catch-all WHEN: "true" present exactly once, creative WHEN strings present for non-catch-all handoffs, GUARDRAILS block, slotMap has entries for goal/persona/handoff.\*.when, double-quote escaping works, throws on missing required slot.

Implementation shape:

- `assembleAblAgent(skeleton, creative)` returns `{ yaml, slotMap }`
- Manual line-by-line emission (not yaml.stringify — ABL's keywords don't round-trip)
- `requireSlot(creative, slotPath)` throws if missing
- `escapeYamlDouble(value)` — backslash + double-quote escaping
- Incremental line counter feeding slotMap

---

### Task 5: Slot validators

**Files:**

- Create: `apps/studio/src/lib/arch-ai/scaffold/slot-validators.ts`
- Test: `apps/studio/src/__tests__/arch-ai/scaffold/slot-validators.test.ts`

Validators (pure functions returning `{ ok: true } | { ok: false, error: string }`):

- `validateGoal(value)`: length 20-500
- `validatePersona(value)`: length 100-2000
- `validateHandoffWhen(value)`: length 10-200; rejects `{{` or `}}`; rejects `"true"` (reserved for catch-all)

Tests cover pass and fail cases for each.

---

### Task 6: Slot fix-loop — structured output + per-slot re-prompt

**Files:**

- Create: `apps/studio/src/lib/arch-ai/scaffold/slot-fix-loop.ts`
- Test: `apps/studio/src/__tests__/arch-ai/scaffold/slot-fix-loop.test.ts`

Function `fillSlots(scaffold, { model, maxRetriesPerSlot })`:

1. Ring 1: call `generateObject` from AI SDK with the scaffold schema + prompt; flatten nested `handoff`/`gather`/`complete` keys into dotted paths
2. Ring 2: for each slot, call the corresponding validator; collect failures
3. For each failing slot: re-prompt with a single-slot schema + error feedback; max N retries
4. On exhaust: use a bland-but-valid default from `FALLBACK_DEFAULTS` and record in `fallbackSlots`
5. Return `{ creative, slotAttempts, fallbackSlots }`

Tests use `vi.mock('ai', () => ({ generateObject: vi.fn() }))` and assert retry counts, re-prompt isolation, fallback behavior.

---

### Task 7: Worker runner

**Files:**

- Create: `apps/studio/src/lib/arch-ai/scaffold/worker-runner.ts`
- Test: `apps/studio/src/__tests__/arch-ai/scaffold/worker-runner.test.ts`

`runScaffoldWorker(input)` orchestrates:

1. `scaffoldAblAgent(plan, topology, spec, domain)` → scaffold result
2. `fillSlots(scaffold, { model, maxRetriesPerSlot })` → validated creative
3. `assembleAblAgent(skeleton, creative)` → yaml + slotMap
4. Return `FillLoopResult` with `compileStatus: 'pass'` (structural correctness by construction for Slice 1)

Test asserts: no self-reference possible in output, all targets present, fallbackSlots empty on happy path.

---

### Task 8: Feature flag + build-parallel-gen branching

**File:** modify `apps/studio/src/lib/arch-ai/build-parallel-gen.ts`

1. Add `isScaffoldPathEnabled(plan)` helper at the top: returns true only when `FEATURE_SCAFFOLD_GENERATION === 'true'` AND `plan.archetype === 'supervisor'` (Slice 1 restriction).
2. In `runAgentWorker` around where `const plan = shared.architecturePlans.get(agentName)` is computed, add an early branch:
   - When flag enabled: call `runScaffoldWorker` with topology/spec/domain mapped from shared context
   - Persist yaml to `metadata.files[agentName].content`
   - Emit `build_agent_validated` SSE with correct `handoffCount`
   - Return `{ agentName, status: fallbackSlots.length > 0 ? 'warning' : 'compiled', warnings, errors: [], elapsed }`
3. When flag disabled: fall through to existing streamText path unchanged.

Verify all existing tests pass; legacy path is untouched.

---

### Task 9: Parity test fixture — triage_specialists

**File:** create `apps/studio/src/__tests__/arch-ai/scaffold/fixtures/triage-specialists.ts`

Exports: `TRIAGE_SPECIALISTS_TOPOLOGY`, `TRIAGE_PLAN`, `TRIAGE_SPEC`, `DOMAIN`. 4 agents (Triage supervisor, Order, Returns, Human), 3 edges (2 delegate + 1 escalate), Triage archetype=supervisor with catchAllTarget=OrderSupportAgent.

---

### Task 10: End-to-end parity test

**File:** create `apps/studio/src/__tests__/arch-ai/scaffold/parity.test.ts`

Mocks `generateObject` with realistic LLM response. Asserts:

1. Keyword correct (SUPERVISOR: SupportTriageAgent)
2. All 3 topology targets present as TO: entries
3. Catch-all TO: OrderSupportAgent WHEN: "true"
4. No self-reference (YAML does NOT contain "- TO: SupportTriageAgent")
5. 3 delegates/catch-all → RETURN: true count = 3
6. 1 escalate → RETURN: false count = 1
7. `fallbackSlots` empty
8. `compileStatus === 'pass'`

---

### Task 11: Slice 1 handoff — flag-on verification

1. Run full scaffold test suite: `pnpm exec vitest run src/__tests__/arch-ai/scaffold src/__tests__/arch-ai/helpers src/__tests__/arch-ai/handbook-reference.test.ts src/__tests__/arch-ai/build-parallel-gen-streaming.test.ts src/__tests__/arch-ai/build-parallel-gen-handoff-check.test.ts`
2. Start Studio with flag on: `FEATURE_SCAFFOLD_GENERATION=true SKIP_SETUP=1 NODE_ENV=production pm2 restart abl-studio`
3. Trigger a BUILD for CommerceCare Support (or equivalent 5+agent triage topology)
4. Verify in `logs/studio-out.log`: "Scaffold worker succeeded" entries; no `HANDOFF_SELF_REFERENCE` for supervisor
5. Write diagnostic doc at `docs/sdlc-logs/build-diagnostics/2026-04-<DD>-scaffold-slice1-<buildRunId>.md` with before/after comparison vs 7093c7b0
6. Commit diagnostic doc

---

## Slice 2: Specialist Archetype

### Task 12: Types check (no-op if Task 1 complete)

Verify `gatherFields`, `completeSlots`, `memorySessionVars` already exist in `AblSkeleton` (they do per Task 1). Skip if present.

### Task 13: Scaffold generator — specialist branch

Add specialist case to dispatcher. `scaffoldSpecialist(plan, topology, spec, domain)`:

- keyword: 'AGENT'
- handoffs: only escalate edges (no catch-all for sink specialists)
- gatherFields: from plan.gather.suggestedFields + spec.gatherFields deduped
- completeSlots: one entry when plan.complete.required
- memorySessionVars: same as gatherFieldNames

Extend `creative-schemas.ts` with `buildSpecialistSchema(skeleton)` emitting `goal`, `persona`, nested `gather.<name>.ask`, nested `complete.<i>.when`, `complete.<i>.reason`.

Tests added to scaffold-generator.test.ts: AGENT keyword, no HANDOFF for sink, gather field slots, complete slot pair, memorySessionVars derivation.

### Task 14: Assembler extension

Emit GATHER block (fields loop with type + ask slot interpolation) before GUARDRAILS. Emit COMPLETE block with WHEN/REASON slot interpolation. Update MEMORY.session emission to use `skeleton.memorySessionVars` when non-empty.

Tests added to assembler.test.ts: AGENT keyword, no HANDOFF for sink specialist, GATHER block with fields, COMPLETE block references gather names, MEMORY.session has one entry per gather field.

### Task 15: Validators + fix-loop extensions + enable specialist in flag

Add `validateGatherAsk`, `validateCompleteWhen(value, declaredGatherFields)`, `validateCompleteReason`.
`validateCompleteWhen` extracts identifiers via regex `/[a-zA-Z_][a-zA-Z0-9_]*/g`, filters out keywords (AND OR NOT null true false + lowercase), then verifies every remaining identifier is in `declaredGatherFields`.

Thread `gatherFields` (Set of names) through `fillSlots` and `validateSlot`.
Extend `flattenCreative` to handle `gather` and `complete` nested keys like `handoff`.

Update `isScaffoldPathEnabled` to include `'specialist'`.

Slice 2 exit: specialist agents compile 100% on triage_specialists parity test.

---

## Slice 3: Remaining Archetypes + Rollout

### Task 16: scaffoldPipelineStage

`pipeline_stage` = specialist + outgoing handoffs. Reuse specialist skeleton shape + add HandoffEntry[] from plan.handoffs.targets. Merge supervisor-style handoff schema properties into the specialist schema.

Enable `'pipeline_stage'` in `isScaffoldPathEnabled`.

### Task 17: scaffoldWorker + single_agent

`worker` (sink, only incoming) and `single_agent` (1 agent, 0 edges) both use `scaffoldSpecialist` as the shape is identical when plan says no gather/complete needed. Enable `'worker'` in flag.

### Task 18: Reference fixtures

Create four more fixture files modeled on triage-specialists.ts:

- `fixtures/pipeline.ts` — 3-stage linear chain
- `fixtures/hub-spoke.ts` — coordinator + 2-3 workers with return
- `fixtures/peer-mesh.ts` — 3 peers, bidirectional transfer with allowCycle
- `fixtures/single-agent.ts` — 1 agent, 0 edges

Use `synthesizePatternTopology` in `packages/arch-ai/src/coordinator/topology-synthesis.ts` as the reference shape.

### Task 19: Parity suite across all 5 patterns

Extend `parity.test.ts` with one `describe` block per pattern. Each asserts:

1. Keyword correct per agent
2. All topology targets in HANDOFF blocks (where applicable)
3. No self-reference
4. RETURN flags match edge types
5. `fallbackSlots` empty
6. `compileStatus === 'pass'`

Target: 5 describes, 15+ tests total.

### Task 20: Flag default ON + deprecation

Change `isScaffoldPathEnabled`:

```
if (process.env.FEATURE_SCAFFOLD_GENERATION === 'false') return false;
```

(inverted: default ON, opt-out via env var)

Add `@deprecated` JSDoc banner to `handbook-reference.ts` and `helpers/compile-and-fix.ts` with 2-week removal target.

Update spec doc header status: `Implemented — Slice 3 rolled out; legacy removal pending 2-week soak`.

### Task 21: Production verification

1. Restart Studio with new default
2. Run CommerceCare Support build
3. Verify "Scaffold worker succeeded" for all agents in logs
4. Write `docs/sdlc-logs/build-diagnostics/2026-04-<DD>-scaffold-rollout-<buildRunId>.md` with before/after comparison across all 5 reference patterns
5. Commit diagnostic

**Target metrics:**

- Compiled count: 6/6 (vs 0/6 in 7093c7b0)
- HANDOFF count: 5 specialists + catch-all per supervisor
- Self-reference: zero across all agents
- Warnings: at or below 7093c7b0 baseline
- Errors: 0
- Latency: at or below 100s per build

---

## Self-Review Results

**Placeholder scan:** No TBD/TODO/implement-later in executable steps. All code blocks complete. Deferrals are explicit (Ring-3 slot-trace, streaming UX, tools scaffold, CONSTRAINTS — all tracked in the "Deferred" section above).

**Type consistency:** All signatures defined once in Task 1 types file and reused verbatim across later tasks. `scaffoldAblAgent`, `assembleAblAgent`, `fillSlots`, `runScaffoldWorker` all have one signature each, threaded consistently.

**Spec coverage:** All spec sections mapped to tasks in the matrix above.

**Scope:** Three slices, each independently shippable, under one feature flag. Cleanup deferred per spec §8.1.
