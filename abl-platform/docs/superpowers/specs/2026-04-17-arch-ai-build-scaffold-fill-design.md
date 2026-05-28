# Arch-AI BUILD Phase — Scaffold + Fill Architecture

**Date:** 2026-04-17
**Status:** Draft — pending implementation plan
**Owner:** Arch-AI team
**Related:**

- `docs/sdlc-logs/build-diagnostics/2026-04-17-build-run-1228a16b.md` — first observation of the failure pattern
- `docs/sdlc-logs/build-diagnostics/2026-04-17-build-run-3dd30d8e.md` — post-fix diagnostic showing why the tactical patches were insufficient
- `docs/features/arch-agent-architecture-planner.md` — the architecture planner this design builds on

---

## 1. Context & motivation

### 1.1 The observed failure pattern

Two BUILD runs of the same-class e-commerce support topology (6 specialists under a Triage supervisor) on 2026-04-17 both produced 0 compiled agents and 1 blocking error on the Triage. In both runs:

1. Haiku generated a HANDOFF block where every `TO:` field referenced the agent's own name (self-reference), not the topology targets.
2. The compile-and-fix loop, unaware of the topology, "repaired" the errors by **deleting 5 of 6 HANDOFF rules** and leaving a single self-referencing catch-all.
3. Per-agent compile passed (`skipCrossAgentValidation: true` hides self-reference).
4. Cross-agent reconciliation ~80 seconds later caught the residual self-reference, flipping Triage from `compiled` to `error`.
5. Bonus regression: specialists emitted `SUPERVISOR:` keyword instead of `AGENT:`.

Three prompt-layer fixes (`8f271fd2f`, `909e8f37c`, `d502bbb4a`) landed the same morning. The post-fix diagnostic showed the pattern reproduced unchanged. Prompt engineering cannot eliminate small-model structural drift on a 13.5K-char prompt.

### 1.2 Why tactical patches compound risk

Every leak in the current pipeline is a field the LLM keeps getting wrong that is **100% computable from topology**:

| Field                             | Is it creative?                    | Current                          | New            |
| --------------------------------- | ---------------------------------- | -------------------------------- | -------------- |
| `SUPERVISOR:` vs `AGENT:` keyword | No — derived from plan             | LLM writes, drifts               | Code writes    |
| `HANDOFF.TO:` names               | No — copied from topology          | LLM writes, self-references      | Code writes    |
| `HANDOFF.RETURN:` flags           | No — delegate=true, escalate=false | LLM writes, occasionally forgets | Code writes    |
| Catch-all HANDOFF                 | No — planner computes target       | LLM writes, often self-refs      | Code writes    |
| `GUARDRAILS.content_safety` shell | No — boilerplate                   | LLM writes                       | Code writes    |
| `MEMORY.session` shape            | No — derived from GATHER           | LLM writes                       | Code writes    |
| `GOAL`, `PERSONA` text            | **Yes**                            | LLM writes                       | **LLM writes** |
| Tool descriptions                 | **Yes**                            | LLM writes                       | **LLM writes** |
| `FLOW:` step logic                | **Yes** (for scripted/hybrid)      | LLM writes                       | **LLM writes** |
| `GATHER` field questions          | **Yes**                            | LLM writes                       | **LLM writes** |

Asking the LLM to do the structural work is the root cause. Patching each failure mode adds surface without addressing the underlying mismatch.

### 1.3 The pivot in one sentence

**Stop asking the LLM to generate an agent from scratch. Start asking it to fill the creative slots in a topology-derived skeleton.**

---

## 2. Goals & non-goals

### 2.1 Goals

- **Structurally prevent** self-reference, missing HANDOFFs, wrong keyword, missing catch-all, and catch-all target drift.
- **Preserve creative leverage** on GOAL, PERSONA, tool descriptions, FLOW logic, WHEN refinements, and GATHER field questions.
- **Compress prompt size** from ~13.5K chars to ~3–4K chars so small models like Haiku stay in their reliable range.
- **Make fixes field-scoped** instead of file-scoped, so one bad WHEN string cannot trigger deletion of five good HANDOFF rules.
- **Keep the BUILD tile UI, SSE events, and session metadata shape unchanged** — UX parity at minimum, optionally better via skeleton-first streaming.
- **Keep the ABL compiler gate** as a sanity ring and semantic-diagnostics emitter.

### 2.2 Non-goals

- **Redesigning the BLUEPRINT phase** (topology generation) — out of scope for this change. The architecture planner output is the input to this pipeline.
- **Removing the compile_abl gate** — it becomes a sanity check rather than the primary gate, but remains in place.
- **Redesigning the LLM provider / model layer** — supervisor-vs-specialist model selection improvements are orthogonal and tracked separately.
- **Changing the reconciliation layer** — it stays as a safety net and should find zero new issues under the new pipeline.
- **Addressing CONSTRAINTS / LIMITATIONS quality issues** (e.g., `user_authenticated` pattern) beyond the existing per-slot validator scope. These are deferred to a separate creative-content quality pass.

### 2.3 Success criteria

- On the reference CommerceCare Support topology, the new pipeline produces **7/7 agents compiled** (current baseline: 0/7 compiled, 1 error).
- On the reference test suite (single-agent, triage, pipeline, hub-spoke, peer-mesh), total warning count is ≤ current baseline.
- Reconciliation emits zero new errors in any successful reference run.
- Triage agents across all test topologies contain all topology target names in their HANDOFF blocks with correct WHEN, RETURN, and catch-all.
- No specialist agent is emitted with `SUPERVISOR:` keyword across the reference suite.
- Per-agent worker latency is ≤ current baseline (shorter prompt + fewer retries compensates for structured-output overhead).

---

## 3. Core insight

The architecture planner (`computeArchitecturePlans`) already separates structural concerns (archetype, handoff targets, catch-all target, return-path contracts) from creative concerns (GOAL text, PERSONA voice, etc.). The current pipeline ignores that separation: it hands the planner's output to the LLM as hints and asks the LLM to re-derive structural facts plus write creative content.

The new design treats the planner output as **authoritative for structure**. The LLM is never asked to decide a structural fact the planner has already computed.

---

## 4. Architecture overview

### 4.1 Three-stage pipeline

```
  ┌─────────────────┐       ┌─────────────────┐       ┌──────────────────┐
  │ topology + plan │──┬───▶│ Scaffold gen    │──────▶│ Skeleton ABL     │
  │    + spec       │  │    │ (pure function) │       │ + creative brief │
  └─────────────────┘  │    └─────────────────┘       └──────────────────┘
                       │                                        │
                       │                                        ▼
                       │                      ┌───────────────────────────┐
                       │                      │  LLM call, structured JSON│
                       └─────────────────────▶│  matching creativeSchema  │
                                              └───────────────────────────┘
                                                             │
                                                             ▼
                                              ┌───────────────────────────┐
                                              │ Ring 1: JSON-schema valid │
                                              └───────────────────────────┘
                                                             │
                                                             ▼
                                              ┌───────────────────────────┐
                                              │ Ring 2: Content validator │
                                              └───────────────────────────┘
                                                             │
                                                             ▼
                                              ┌───────────────────────────┐
                                              │ Assembler (pure function) │
                                              │ skeleton + validated JSON │
                                              │ → final ABL YAML + slotMap│
                                              └───────────────────────────┘
                                                             │
                                                             ▼
                                              ┌───────────────────────────┐
                                              │ Ring 3: compile_abl +     │
                                              │ diagnostics (sanity gate) │
                                              └───────────────────────────┘
                                                             │
                                                             ▼
                                              ┌───────────────────────────┐
                                              │ Persist to DB, emit SSE   │
                                              └───────────────────────────┘
```

Each ring has a field-scoped retry budget. Other slots are untouched when one slot fails.

### 4.2 Why this shape beats the alternatives

**vs. "plug the leaks" (tactical patches to current architecture):** every patch accepts that the LLM is doing structural work. Each new failure mode needs its own patch. Cumulative regression surface grows without eliminating root cause.

**vs. "scaffold-LLM-modifies-file":** the LLM receives a scaffolded YAML and is told to fill slots. LLMs don't respect "don't modify these parts" boundaries reliably; a diff checker would have to revert scaffold changes constantly, producing messy, hard-to-diagnose outcomes.

**vs. "per-slot independent LLM calls":** multiple calls hurt cross-field consistency (GOAL and PERSONA drift from each other) and multiply latency. Structured output in a single call preserves consistency while isolating failure modes.

**Chosen shape (structured output + deterministic assembly)** combines: one LLM call, JSON-schema enforcement, code-owned structure, LLM-owned creativity, per-slot re-prompting only when the LLM's creative content fails validation.

---

## 5. Scaffold generator contract

### 5.1 Type signature

```ts
interface ScaffoldResult {
  /** Deterministic IR — everything computable from plan + topology */
  skeleton: AblSkeleton;
  /** JSON schema the LLM must match — every property maps to a slot in skeleton */
  creativeSchema: JSONSchema7;
  /** Rendered system prompt — describes agent context, names every required slot */
  prompt: string;
}

function scaffoldAblAgent(
  plan: AgentArchitecturePlan,
  topology: TopologyOutput,
  spec: AgentSpec,
  domain: DomainContext,
): ScaffoldResult;
```

**Pure. Zero LLM. Fully unit-testable. Function-local Maps/Sets only.**

### 5.2 What the skeleton encodes (structural, code-owned)

Every field where the plan or topology has the answer:

- Agent name + keyword (`AGENT:` / `SUPERVISOR:` from `plan.keyword`)
- All HANDOFF `TO:` names (from `plan.handoffs.targets`)
- All HANDOFF `RETURN:` flags (from `returnExpected`)
- Catch-all HANDOFF target (from `plan.handoffs.catchAllTarget`) with `WHEN: "true"` literal
- GATHER field **names and types** (from `plan.gather.suggestedFields` + topology hints)
- COMPLETE reference targets (the GATHER field names the conditions must reference)
- MEMORY.session variable names (derived from GATHER field names, deduped)
- TOOL **names** (from `spec.tools`)
- GUARDRAILS.content_safety shell (fixed boilerplate: tier 1, kind: input, action: block)
- **Section presence** — only sections the plan marks required or recommended are instantiated. A reasoning-mode agent with no return contract gets no FLOW, no GATHER, no COMPLETE.

### 5.3 What's a slot (creative, LLM-owned)

Every field where domain intelligence is needed. Each slot has a stable dotted path:

| Slot path                 | Type                          | Constraints                                                                                                 |
| ------------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `goal`                    | string                        | 20–500 chars, should start with action verb                                                                 |
| `persona`                 | string                        | 100–2000 chars, ≥3 sentences, references domain                                                             |
| `handoff.<i>.when`        | string                        | 10–200 chars, refines topology condition, no `{{ }}` interpolation, rejects `WHEN: "true"` (catch-all only) |
| `gather.<fieldName>.ask`  | string                        | 20–300 chars, question form, first-person                                                                   |
| `complete.<i>.when`       | string                        | Expression referencing only GATHER field names the scaffold declared                                        |
| `complete.<i>.reason`     | string                        | 20–200 chars, third-person explanation                                                                      |
| `tool.<name>.signature`   | string                        | Matches `name(...) -> {...}` regex                                                                          |
| `tool.<name>.description` | string                        | 20–500 chars                                                                                                |
| `constraints.<i>`         | string \| null                | `REQUIRE/WARN <expr>`; validator rejects refs to undeclared vars                                            |
| `flow.step.<name>.prompt` | string (hybrid/scripted only) | 50–1500 chars                                                                                               |

**The creative schema is generated from the skeleton.** If the skeleton has 5 HANDOFFs, the schema has exactly 5 `handoff.*.when` slots — LLM cannot add a 6th, cannot skip one, schema enforcement is handled by the AI SDK's structured output mode.

### 5.4 Worked example — SupportTriage scaffold output

```yaml
# skeleton (pre-filled by scaffold generator)
SUPERVISOR: SupportTriageAgent
GOAL: '<<goal>>'
PERSONA: |
  <<persona>>

HANDOFF:
  - TO: OrderSupportAgent
    WHEN: '<<handoff.0.when>>'
    RETURN: true
  - TO: ReturnsRefundsAgent
    WHEN: '<<handoff.1.when>>'
    RETURN: true
  - TO: ProductSupportAgent
    WHEN: '<<handoff.2.when>>'
    RETURN: true
  - TO: ShippingSupportAgent
    WHEN: '<<handoff.3.when>>'
    RETURN: true
  - TO: AccountSupportAgent
    WHEN: '<<handoff.4.when>>'
    RETURN: true
  - TO: AccountSupportAgent # catch-all, code-injected
    WHEN: 'true'
    RETURN: true

GUARDRAILS:
  content_safety:
    kind: input
    tier: 1
    check: 'Block harmful or abusive content'
    action: block

MEMORY:
  session:
    - name: detected_intent
      type: string
      initial_value: null
```

```json
{
  "type": "object",
  "required": ["goal", "persona", "handoff"],
  "properties": {
    "goal": { "type": "string", "minLength": 20, "maxLength": 500 },
    "persona": { "type": "string", "minLength": 100, "maxLength": 2000 },
    "handoff": {
      "type": "object",
      "required": ["0.when", "1.when", "2.when", "3.when", "4.when"],
      "properties": {
        "0.when": {
          "type": "string",
          "description": "Refine routing condition to OrderSupportAgent. Topology hint: 'When intent is order status or order-related inquiry.' One sentence, no templating."
        }
        // ... 1-4 similar
      }
    }
  }
}
```

The LLM is **physically unable** to produce a self-referencing HANDOFF, wrong keyword, or an extra/missing TO: target. Structural correctness is guaranteed by code, not prayer.

### 5.5 Per-archetype behavior

| Archetype                                                   | Skeleton sections emitted                                                   | Creative slots                                                                                  |
| ----------------------------------------------------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `supervisor` (entry, has delegates)                         | keyword + HANDOFF block (N targets + catch-all) + GUARDRAILS + MEMORY shell | `goal`, `persona`, `handoff.*.when`                                                             |
| `specialist` (return contract from supervisor)              | keyword + GATHER shell + COMPLETE shell + GUARDRAILS + MEMORY + tools       | `goal`, `persona`, `gather.*.ask`, `complete.*.when`, `complete.*.reason`, `tool.*.description` |
| `pipeline_stage` (has both incoming and outgoing delegates) | keyword + HANDOFF to next stage + GATHER + COMPLETE + GUARDRAILS + MEMORY   | `goal`, `persona`, `handoff.*.when`, `gather.*`, `complete.*`                                   |
| `worker` (sink with incoming, no outgoing)                  | keyword + GATHER (if return expected) + GUARDRAILS + MEMORY                 | `goal`, `persona`, `gather.*`                                                                   |
| `specialist` single-agent (whole system is one agent)       | keyword + GUARDRAILS + MEMORY + tools                                       | `goal`, `persona`, `tool.*.description`                                                         |

---

## 6. Assembler

### 6.1 Contract

```ts
function assembleAblAgent(
  skeleton: AblSkeleton,
  creative: CreativeContent, // validated JSON from LLM
): { yaml: string; slotMap: SlotMap };

/** SlotMap: slot path → line range in final YAML, for fix-loop error→slot mapping */
type SlotMap = Map<string, { lineStart: number; lineEnd: number }>;
```

Pure, deterministic, ~150 LOC. Three passes:

1. **YAML emit from structured skeleton.** Deterministic output order (no `yaml.stringify` — ABL's keyword style doesn't round-trip cleanly). Stable.
2. **Creative interpolation.** Every `<<slot.path>>` placeholder replaced with the LLM's validated content. YAML scalar escaping (quote handling, `|` for multi-line `PERSONA:` and step prompts).
3. **Slot map emission.** Records the line range each slot occupies. Used by Ring 3 to trace compiler errors back to individual slots.

### 6.2 Design notes

- Skeleton is an IR, not a string. Emit once with fixed ordering; never re-parse.
- Placeholders use `<<slot.path>>` syntax to avoid collision with ABL's `{{ }}` templating.
- Line tracking is incremental: as each section is emitted, increment a line counter and stamp the slot map.
- Escaping: YAML scalar rules (quote doubling for `"`, backslash for multi-line in double-quoted strings, `|` literal block for multi-line fields like PERSONA).

---

## 7. Per-field validation and fix-loop

### 7.1 Three-ring validation

**Ring 1 — JSON schema (catches ~70% of errors).**
AI SDK structured-output mode enforces the schema at the model layer. The LLM is physically unable to submit a response that doesn't match. Missing `handoff.2.when`? Can't submit. Wrong type? Can't submit.

**Ring 2 — Content validators (pure functions per slot).**
Each slot optionally has `validate(value, context) → ValidationResult`. Examples:

```ts
const HANDOFF_WHEN_VALIDATOR: SlotValidator = (value) => {
  if (value.includes('{{')) return fail('No template interpolation allowed in WHEN conditions.');
  if (value.trim() === 'true') return fail('Only the catch-all can use WHEN: true.');
  if (value.length < 10) return fail('WHEN condition too short to be meaningful.');
  return ok();
};

const CONSTRAINTS_VALIDATOR: SlotValidator = (value, { declaredVars }) => {
  if (value === null) return ok();
  const referenced = extractIdentifiers(value);
  const undeclared = referenced.filter((v) => !declaredVars.has(v));
  if (undeclared.length) {
    return fail(
      `References undeclared variables: ${undeclared.join(', ')}. Declared: ${[...declaredVars].join(', ')}`,
    );
  }
  return ok();
};
```

Validators run per slot. A failure re-prompts **only that slot** with the validator message as feedback. Other slots untouched. Retry budget: 3 attempts per slot.

**Ring 3 — Compiler + semantic diagnostics.**
If Rings 1+2 pass but the assembled ABL still fails compile (unescaped quote inside PERSONA, unusual tool signature, etc.), use the `slotMap` to trace each compile error's line to its slot. Re-prompt only that slot with the compiler message as feedback.

Example resolution:

```
compile_abl error: Line 14: Unterminated string in PERSONA
slotMap lookup: line 14 → slot "persona"
action: re-prompt LLM for slot "persona" with the compiler message
       keep all other slots; reassemble; retry compile
```

If three Ring-3 rounds fail to fix a slot, escalate to a bland-but-valid default for that slot (e.g., `"Help the user with their request."` for GOAL). Mark agent `warning` with diagnostic `FALLBACK_SLOT_DEFAULT:<slot>`; build completes rather than loop forever.

### 7.2 Why this beats the current fix-loop

| Dimension                      | Current (file-level)                          | New (slot-level)                                     |
| ------------------------------ | --------------------------------------------- | ---------------------------------------------------- |
| LLM re-call cost               | Full 1898-char file regenerated for any error | Single field re-prompted (~100–500 chars context)    |
| Collateral damage              | Fix for error A can break field B (observed)  | Impossible — other slots untouched                   |
| Self-reference / keyword drift | Possible (structural work in LLM scope)       | Impossible (structural work in code scope)           |
| Diagnosability                 | "LLM couldn't fix" — opaque                   | Exact slot + exact validator/compiler message logged |
| Per-agent latency              | 2–3 full-file regenerations                   | 1 generation + small targeted re-prompts             |

---

## 8. Migration path

### 8.1 Code organization

All new code lives under `apps/studio/src/lib/arch-ai/scaffold/`:

- `scaffold-generator.ts` — pure function, takes plan+topology+spec, returns `ScaffoldResult`
- `assembler.ts` — pure function, takes skeleton+validated creative, returns YAML + slotMap
- `slot-validators.ts` — pure functions per slot type
- `slot-fix-loop.ts` — orchestrates Rings 1/2/3 with per-slot retry
- `creative-schemas.ts` — per-archetype JSON schema builders
- `types.ts` — shared types (`AblSkeleton`, `CreativeContent`, `Slot`, `SlotMap`)

### 8.2 What stays unchanged

- `build-result-reconciliation.ts` — cross-agent validation at the end still runs (as a safety net; should detect zero new issues).
- Session metadata shape (`metadata.files[agentName].content`) — identical.
- SSE event types (`build_agent_start`, `file_content_delta`, `build_agent_stage`, `compile_result`, `build_agent_validated`) — identical. Internal stage names evolve (`scaffolding`, `slot_filling`, `assembling`) but map to existing `'compiling'` for tile UI.
- BUILD tile UI — no changes required.

### 8.3 What shrinks or is replaced

- `handbook-reference.ts` — the 360-line, 13.5K-char prompt builder shrinks dramatically. Most content moves into scaffold-generator or the structured-output prompt. The new system prompt is ~3–4K chars.
- `generate_agent` build-worker tool — removed from the LLM's toolbox. Assembler writes the file directly.
- `compile_abl` tool — kept, but its role shifts from "primary gate" to "sanity gate." Expected to pass every time.
- `compileAndFixWithModel` — replaced by slot-level `refillBrokenSlots`. Old function stays in code behind the feature flag for rollback safety.

### 8.4 Rollout — three phases behind a flag

**Phase 1 (days 1–3) — build in parallel, no rollout.**

- Feature flag: `FEATURE_SCAFFOLD_GENERATION` (env var + per-session override via `session.metadata.buildPathVersion`).
- Worker dispatches based on flag:
  ```ts
  if (flag) runScaffoldPath(...) else runLegacyPath(...)
  ```
- Unit tests for scaffold-generator across all 5 archetypes.
- Unit tests for each slot validator.
- Unit tests for assembler output + slot map accuracy.

**Phase 2 (days 4–5) — parity testing.**

- Flag ON internally. Run 5 reference topologies through both paths.
- Parity assertions:
  - New ≥ old on `compiled` count (target: 100% compiled vs. current 0%)
  - New ≤ old on total warnings
  - New = 0 on errors (enforced)
  - Per-agent token cost ≤ current (shorter prompts, fewer retries)
- Any parity regression blocks rollout.

**Phase 3 (day 6) — flag flip.**

- Flag default ON. Legacy path remains behind `FEATURE_SCAFFOLD_GENERATION=false` for emergency rollback.
- One week of monitoring with diagnostic logs.
- Cleanup commit: remove legacy path + feature flag after 2 weeks clean operation.

### 8.5 Streaming UX

Current: LLM streams YAML tokens → `file_content_delta` events → tile shows live typing.

New two-stage streaming:

1. **Scaffold streamed immediately.** Skeleton known before LLM runs. Emit it as `file_content_delta` with placeholder markers. Tile shows structured skeleton up front.
2. **Slots fill in.** As each slot arrives from the LLM's structured output, emit `file_content_delta` replacing its placeholder region.

UI sees "skeleton → filled in" rather than "typed character by character." Tile component doesn't need changes because it only watches deltas.

**Fallback** (if structured-output streaming proves awkward in the AI SDK): assemble full file, chunk to ~160-char `file_content_delta` events post-assembly. Identical to today from UI POV.

### 8.6 Backwards compatibility — in-flight builds

- A session started under legacy path continues under legacy path even if flag flips mid-build (stored in `session.metadata.buildPathVersion`).
- Retry-failed-agents on a session with mixed-origin agents uses the session's original path.
- Completed builds: artifacts are identical shape (`metadata.files[].content`), so downstream features (modify agent, add agent, deploy) are unaffected.

---

## 9. Testing strategy

| Test suite                        | Count target | Purpose                                                                                                                          |
| --------------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| Scaffold-generator unit tests     | 15–20        | One per archetype × key plan variants (required GATHER, escalate edges, catch-all, single-agent, pipeline, hub-spoke, peer-mesh) |
| Assembler unit tests              | 8–10         | YAML correctness for every skeleton shape + slot-map accuracy + escape handling                                                  |
| Slot validator unit tests         | 10–15        | One per validator × representative valid/invalid inputs                                                                          |
| Slot fix-loop integration tests   | 5–8          | Simulated LLM responses (good/bad/partial), retry budget enforcement, fallback defaults                                          |
| End-to-end parity tests           | 5            | Reference topologies end-to-end: single-agent, triage, pipeline, hub-spoke, peer-mesh                                            |
| Existing handbook-reference tests | 23 (keep)    | Validate legacy path for rollback safety                                                                                         |

All new tests follow the platform's no-mocking-internal-components rule (`@abl/*`, `@agent-platform/*`, relative imports). LLM calls are mocked via dependency injection (mock returns pre-canned structured JSON).

---

## 10. Risks & mitigations

| Risk                                                                 | Likelihood | Impact                                            | Mitigation                                                                                                                              |
| -------------------------------------------------------------------- | ---------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| AI SDK structured-output streaming is immature for some providers    | Medium     | Streaming UX degraded                             | Fallback to post-hoc chunked `file_content_delta` emission. UX parity preserved.                                                        |
| Slot map line tracking is imprecise on multi-line creative fields    | Low        | Ring 3 retries target wrong slot                  | Unit tests enforce slot-map accuracy on multi-line skeletons; compile errors without a slot match fall back to full-file re-prompt once |
| LLM structured-output token overhead offsets prompt compression      | Medium     | Slight latency increase                           | Parity test measures token cost; if regression, reduce schema verbosity                                                                 |
| Creative field quality regresses because LLM sees less context       | Low        | Worse GOAL/PERSONA text                           | Scaffold prompt includes domain context and specific topology hints per slot description                                                |
| Hidden FLOW/CONSTRAINTS creative slots need scaffold-level structure | Medium     | Scaffold-generator bugs emit broken skeletons     | 15-20 unit tests covering all archetype × plan combinations; parity tests catch regressions end-to-end                                  |
| Scaffold generator becomes the new single point of failure           | Low        | All agents broken if scaffold generator has a bug | Pure function, fully unit-testable, no I/O. Reconciliation layer still runs as final backstop.                                          |

---

## 11. Delivery estimate

| Day | Work                                                                                  |
| --- | ------------------------------------------------------------------------------------- |
| 1   | `types.ts`, `scaffold-generator.ts` (supervisor + specialist archetypes), unit tests  |
| 2   | Remaining archetypes (pipeline_stage, worker, single-agent), `assembler.ts`, slot map |
| 3   | `slot-validators.ts`, `creative-schemas.ts`, `slot-fix-loop.ts`                       |
| 4   | Worker integration (`build-parallel-gen.ts` branching on feature flag)                |
| 5   | Parity test harness + reference topology fixtures + fallback-default paths            |
| 6   | Internal flag-on testing, diagnostic log verification, flag flip                      |

**~6 engineering days to flag-on for internal users.** Legacy removal after a 2-week soak.

---

## 12. Open questions

- **Should the tool-signature slot be a validator-constrained string or a structured sub-schema?** Currently a constrained string with regex validation. If LLMs frequently produce malformed signatures, upgrade to structured (`{ name, params: [{name, type}], returnType: {...} }`) and emit the signature text from code.
- **How should FLOW steps for hybrid-mode agents be scaffolded?** Initial design: scaffold emits step names + order from topology (if derivable); LLM fills step prompts. If topology doesn't specify step order, scaffold emits an empty FLOW shell and lets LLM propose step names _and_ prompts as creative slots. TBD whether hybrid mode needs a richer plan.
- **Do CONSTRAINTS belong in the scaffold at all?** They're creative per agent but have strict rules about variable references. Initial design: treat as a creative slot with a strict validator. If validator rejection rate is high, move to "planner declares which constraint templates apply; LLM picks from enum."
- **How long before removing the legacy path?** Proposed: 2 weeks clean operation. Could compress to 1 week if parity + production monitoring show consistent green.

---

## 13. Glossary

- **Plan** — output of `computeArchitecturePlans`, per-agent structural specification derived from topology.
- **Scaffold** — deterministic ABL IR pre-filled with all structural content (keyword, HANDOFF targets, RETURN flags, etc.) plus placeholders for creative content.
- **Slot** — a named position in the scaffold where creative content is filled. Has a stable path (e.g., `handoff.2.when`), an optional validator, and a JSON schema entry.
- **Creative content** — the LLM's structured-JSON response matching the scaffold's creative schema.
- **Assembler** — pure function that combines a scaffold with validated creative content to produce the final ABL YAML + slot map.
- **Slot map** — runtime artifact mapping slot paths to line ranges in the assembled YAML, used by Ring 3 to trace compiler errors back to individual slots.
- **Ring** — a validation layer. Ring 1 = JSON schema, Ring 2 = content validators, Ring 3 = compiler + semantic diagnostics.
