# Arch AI In-Project Intelligence Enhancement — Master Plan

**Date:** 2026-04-08
**Branch:** features/arch-ai
**Status:** DESIGN
**Backlog Refs:** B04, B15, B20, B23, B59, B60, IP-F01–IP-F12

---

## Problem Statement

Arch AI's in-project mode produces **false positives and generic responses** across health checks, agent reviews, summaries, and recommendations. Root causes:

1. **Health check has 5+ regex bugs** — reports errors on perfectly valid agents
2. **Specialist prompts are stubs** — 5 of 9 specialists have <500 token prompts with zero workflow guidance
3. **ABL construct knowledge is surface-level** — specialists know keyword names but not semantics, patterns, or anti-patterns
4. **Tool implementations do existence checks, not intelligence** — "does X exist?" instead of "is X well-designed?"
5. **Content router is ambiguous** — generic regex patterns, first-match wins, no disambiguation
6. **Two prompt systems diverge** — coordinator prompts and Studio system-prompt teach different syntax and tools
7. **No semantic/cross-agent validation** — compiler checks "does Agent_B exist?" but never "does Agent_B have COMPLETE logic for RETURN: true?", "do PASS fields match GATHER?", "do WHEN conditions reference real variables?"

---

## Master Issue List

### Category 1: Health Check False Positives (CRITICAL)

| #     | Issue                                                                                     | File            | Lines    | Impact                                               | Fix Effort |
| ----- | ----------------------------------------------------------------------------------------- | --------------- | -------- | ---------------------------------------------------- | ---------- |
| HC-01 | Guardrail detection regex misses multiline CONSTRAINTS/GUARDRAILS sections                | health-check.ts | ~374-375 | False WARN: "no guardrails" on agents that have them | S          |
| HC-02 | Handoff extraction from parsed doc assumes flat array; if parser changes, breaks silently | health-check.ts | ~413-419 | Silent degradation                                   | S          |
| HC-03 | No circular handoff detection                                                             | health-check.ts | —        | Misses topology design flaw                          | M          |
| HC-04 | Tool binding check: silent WARN on DB fetch failure looks like "tools missing" to LLM     | health-check.ts | ~334-340 | LLM tries to "fix" service failure                   | S          |
| HC-05 | No cross-agent validation (orphaned agents, unreachable from entry)                       | health-check.ts | —        | Misses topology coherence issues                     | M          |
| HC-06 | No CONSTRAINTS syntax validation (just checks presence, not correctness)                  | health-check.ts | —        | False PASS on malformed constraints                  | M          |
| HC-07 | No GATHER field validation (missing prompts, invalid types, orphaned depends_on)          | health-check.ts | —        | Misses data collection design flaws                  | M          |
| HC-08 | No FLOW step reachability check (dead steps, missing transitions)                         | health-check.ts | —        | Misses scripted agent design flaws                   | M          |
| HC-09 | No tool parameter compatibility check (DSL signature vs ProjectTool schema)               | health-check.ts | —        | Misses runtime tool call failures                    | L          |

### Category 2: Topology Extraction Bugs (HIGH)

| #     | Issue                                                                                | File            | Lines    | Impact                                      | Fix Effort |
| ----- | ------------------------------------------------------------------------------------ | --------------- | -------- | ------------------------------------------- | ---------- |
| TP-01 | Agent type detection uses string includes('SUPERVISOR:') — matches comments, strings | topology-ops.ts | ~97      | Misclassified agent types                   | S          |
| TP-02 | Handoff extraction regex won't match underscores in agent names                      | topology-ops.ts | ~117-120 | Missing edges in topology view              | S          |
| TP-03 | Section detection doesn't handle multiple whitespace or section END                  | topology-ops.ts | ~108-114 | Incomplete handoff extraction               | M          |
| TP-04 | Edges missing condition/priority data                                                | topology-ops.ts | ~71-72   | Topology view shows connections but not WHY | M          |
| TP-05 | No cycle detection, orphan detection, or entry point validation                      | topology-ops.ts | —        | Misses topology design flaws                | M          |
| TP-06 | modifyTopology NOT IMPLEMENTED (returns NOT_IMPLEMENTED error)                       | topology-ops.ts | —        | Can't modify topology in-project            | L          |

### Category 3: Agent Operations Gaps (HIGH)

| #     | Issue                                                                                    | File         | Lines | Impact                                                      | Fix Effort |
| ----- | ---------------------------------------------------------------------------------------- | ------------ | ----- | ----------------------------------------------------------- | ---------- |
| AO-01 | createAgent uses parse-only validation — misses tool binding and handoff target errors   | agent-ops.ts | ~153  | Agent passes creation but fails compilation later           | S          |
| AO-02 | proposeModification wraps changes in stub agent for validation — misses cross-references | agent-ops.ts | ~413  | Proposed changes validate in isolation but break in context | M          |
| AO-03 | No cross-agent validation on modify — changes can break other agents' handoffs           | agent-ops.ts | —     | Cascading breakage after modification                       | M          |
| AO-04 | spliceSections output not re-validated as complete ABL                                   | agent-ops.ts | —     | Section edit could produce invalid agent                    | S          |
| AO-05 | No detection of unused tools, dead code, unreachable flow steps                          | agent-ops.ts | —     | No quality analysis on read                                 | M          |

### Category 4: Specialist Prompt Deficiencies (CRITICAL)

| #     | Issue                                                                       | Specialist                | Current State                 | What's Needed                                          | Fix Effort |
| ----- | --------------------------------------------------------------------------- | ------------------------- | ----------------------------- | ------------------------------------------------------ | ---------- |
| SP-01 | ABL Construct Expert teaches non-compilable UPPERCASE syntax examples       | abl-construct-expert      | ~2,650 tokens, wrong examples | Rewrite with compiler-verified examples                | L          |
| SP-02 | Analyst prompt has no read_insights schema or expected response formats     | analyst                   | ~1,460 tokens, good workflow  | Add tool schemas, metric definitions, thresholds       | M          |
| SP-03 | Observability Analyst has no trace structure knowledge or metric thresholds | observability-analyst     | ~640 tokens                   | Add trace format, latency thresholds, error categories | M          |
| SP-04 | Testing & Eval has no test scenario templates or coverage metrics           | testing-eval              | ~720 tokens                   | Add scenario taxonomy, coverage model, eval criteria   | M          |
| SP-05 | Channel & Voice is a stub — no workflow, no syntax, no examples             | channel-voice             | ~420 tokens (STUB)            | Full rewrite with voice/channel ABL patterns           | L          |
| SP-06 | Entity Collection is a stub — no GATHER syntax, no validation examples      | entity-collection         | ~480 tokens (STUB)            | Full rewrite with GATHER patterns and validation       | L          |
| SP-07 | Integration Methodologist is a stub — no ABL TOOLS syntax                   | integration-methodologist | ~670 tokens (STUB)            | Full rewrite with tool binding patterns                | L          |
| SP-08 | Governance specialist declared but NO prompt file exists                    | governance                | 0 tokens                      | Create from scratch — compliance patterns              | L          |
| SP-09 | project-architect declared but NO prompt or routing exists                  | project-architect         | 0 tokens                      | Create or remove from type system                      | M          |
| SP-10 | diagnostician declared but NO prompt or routing exists                      | diagnostician             | 0 tokens                      | Create or remove from type system                      | M          |
| SP-11 | quality-engineer declared but NO prompt or routing exists                   | quality-engineer          | 0 tokens                      | Create or remove from type system                      | M          |
| SP-12 | platform-guide declared but NO prompt or routing exists                     | platform-guide            | 0 tokens                      | Create or remove from type system                      | M          |

### Category 5: ABL Knowledge Gaps (CRITICAL)

| #     | Issue                                                                                                     | Impact                                        | Fix Effort |
| ----- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------- | ---------- |
| AK-01 | No specialist knows MEMORY construct syntax (session vars, persistent paths, remember/recall)             | Can't help users design memory                | M          |
| AK-02 | No specialist knows GUARDRAILS construct (input/output, tiers, actions, streaming eval)                   | Can't help with safety configuration          | M          |
| AK-03 | No specialist knows BEHAVIOR_PROFILE (context-dependent behavior, CEL expressions)                        | Can't help with adaptive agents               | M          |
| AK-04 | No specialist knows advanced FLOW (sub_intents, digressions, max_attempts, exit_when)                     | Can't help with complex scripted agents       | M          |
| AK-05 | No specialist knows VOICE construct (SSML, provider config, speed, instructions)                          | Can't help with voice agent design            | M          |
| AK-06 | No specialist knows RICH_CONTENT templates (carousel, kpi, chart, form, progress)                         | Can't help with multi-channel response design | M          |
| AK-07 | No specialist knows TEMPLATES (named response templates with interpolation)                               | Can't help with response management           | S          |
| AK-08 | No specialist knows LOOKUP_TABLES (inline, collection, API sources, fuzzy matching)                       | Can't help with reference-based validation    | S          |
| AK-09 | No specialist knows DELEGATE vs HANDOFF semantics (stack-based return vs full transfer)                   | Gives wrong multi-agent advice                | M          |
| AK-10 | No specialist knows A2A protocol (remote agents, streaming, async)                                        | Can't help with distributed agent design      | M          |
| AK-11 | No specialist knows tool binding types (HTTP, MCP, Sandbox, Connector, Workflow, SearchAI, async_webhook) | Only knows "tools exist", not HOW they bind   | L          |
| AK-12 | No specialist knows EXECUTION config (operation_models, pipeline, compaction_threshold)                   | Can't help optimize agent performance         | M          |
| AK-13 | Healthy vs unhealthy pattern knowledge not codified anywhere                                              | No pattern-based diagnosis                    | L          |

### Category 6: Content Router Issues (HIGH)

| #     | Issue                                                                                                                         | Impact                                      | Fix Effort |
| ----- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | ---------- |
| CR-01 | "change the topology" matches rule 1 (modify agent) instead of rule 2 (architect)                                             | Wrong specialist handles topology changes   | S          |
| CR-02 | "metric" (singular) may not match rule 4's `\bmetrics\b` pattern                                                              | Missed routing to analyst                   | S          |
| CR-03 | No disambiguation for ambiguous messages                                                                                      | First-match wins with no confidence scoring | M          |
| CR-04 | 5 declared specialists have NO routing rules (project-architect, diagnostician, quality-engineer, platform-guide, governance) | Dead code in type system                    | S          |
| CR-05 | "improve agent" → analyst (metrics) but could mean "modify agent code" → abl-construct-expert                                 | Ambiguous intent, wrong specialist          | M          |
| CR-06 | No multi-specialist chaining (e.g., "check health then fix issues" needs health_check → propose_modification)                 | User must make separate requests            | L          |

### Category 7: Analytics & Insights Gaps (MEDIUM)

| #     | Issue                                                                                | File               | Impact                       | Fix Effort |
| ----- | ------------------------------------------------------------------------------------ | ------------------ | ---------------------------- | ---------- |
| AN-01 | Sentiment trajectory uses fixed 0.1 threshold — noisy on sparse data                 | insight-queries.ts | False trend detection        | S          |
| AN-02 | Tool performance dual-path (raw events vs daily dest) may have field name mismatches | insight-queries.ts | Inconsistent metrics         | M          |
| AN-03 | analytics-ops anomaly detection is naive — any error = anomaly                       | analytics-ops.ts   | False positive anomalies     | M          |
| AN-04 | No time-based filtering — ancient sessions included in metrics                       | analytics-ops.ts   | Stale data pollutes analysis | S          |
| AN-05 | No comparative analysis (agent A vs agent B, this week vs last week)                 | insight-queries.ts | Can't identify regression    | M          |
| AN-06 | intents and quality_scores actions return "not yet configured"                       | insight-queries.ts | Dead tool actions            | S          |

### Category 8: Testing Tool Gaps (MEDIUM)

| #     | Issue                                                             | File           | Impact                        | Fix Effort |
| ----- | ----------------------------------------------------------------- | -------------- | ----------------------------- | ---------- |
| TE-01 | run_test doesn't validate agentName exists before calling runtime | testing-ops.ts | Silent failure                | S          |
| TE-02 | No batch test execution                                           | testing-ops.ts | Can't run regression suites   | M          |
| TE-03 | No test result persistence or comparison                          | testing-ops.ts | Can't track quality over time | M          |
| TE-04 | No evaluation metrics (pass/fail against expected behavior)       | testing-ops.ts | LLM must manually judge       | M          |
| TE-05 | Response structure from runtime is unpredictable (tries 3 fields) | testing-ops.ts | Fragile                       | S          |

### Category 9: Semantic & Cross-Agent Validation (CRITICAL)

_The compiler checks "does Agent_B exist?" but never "does the handoff contract make sense?"_

**What the compiler validates today:**

- Handoff/delegate/routing target agent EXISTS (error if not)
- Flow step transitions reference valid step names (error)
- Constraint on_fail goto_step and collect_field targets exist (error)
- Condition variable references produce warnings (NOT errors) if not found
- Circular depends_on in GATHER fields (error)
- Session memory variables have population sources (warning)

**What the compiler does NOT validate (and Arch must):**

| #     | Issue                                                                     | Example                                                                                                                      | Impact                                                                           | Fix Effort |
| ----- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ---------- |
| SV-01 | HANDOFF RETURN:true but target has no COMPLETE logic                      | Agent_A hands off TO: Agent_B with RETURN: true, but Agent_B has no COMPLETE section — control never returns                 | Silent hang: supervisor waits forever for return that never comes                | M          |
| SV-02 | HANDOFF PASS fields don't exist in source agent's GATHER                  | `pass: [customer_id, billing_plan]` but agent has no `customer_id` in GATHER                                                 | Handoff sends undefined/null context to target                                   | M          |
| SV-03 | HANDOFF WHEN condition references non-existent variables                  | `WHEN: user.is_premium == true` but no gather field, tool result, or memory var populates `user.is_premium`                  | Condition always evaluates false — handoff never fires                           | M          |
| SV-04 | DELEGATE INPUT fields don't map to target agent's GATHER fields           | `INPUT: booking_id: selected_booking` but target agent's GATHER has no `booking_id` field                                    | Target agent ignores passed data, re-asks user                                   | M          |
| SV-05 | DELEGATE RETURNS mapping references fields target doesn't produce         | `RETURNS: total_fee: quoted_fee` but target agent never sets `total_fee`                                                     | Parent receives undefined, downstream logic breaks                               | M          |
| SV-06 | CONSTRAINT REQUIRE references tool results not yet available              | `REQUIRE check_trip_status.departure_in_hours > 24` but `check_trip_status` tool not called before this constraint evaluates | Constraint checks undefined value — always fails or always passes                | M          |
| SV-07 | CONSTRAINT ON_FAIL: HANDOFF references non-existent agent                 | `ON_FAIL: HANDOFF Authentication_Agent` but `Authentication_Agent` not in topology                                           | Runtime error on constraint violation                                            | S          |
| SV-08 | FLOW step SET/CLEAR references variables not declared in GATHER or memory | `SET: user.is_authenticated = true` but `user.is_authenticated` not in session memory                                        | Variable exists in runtime but not in agent contract — invisible to other agents | M          |
| SV-09 | FLOW step CALL references tool not in agent's TOOLS section               | `CALL: search_hotels(...)` but `search_hotels` not declared in TOOLS                                                         | Runtime tool call fails                                                          | S          |
| SV-10 | FLOW ON_SUCCESS/ON_FAIL references non-existent step                      | `ON_FAIL: THEN: retry_booking` but no `retry_booking` step exists                                                            | Dead branch — error if taken                                                     | S          |
| SV-11 | HANDOFF agent name mismatch (case, underscores, spelling)                 | TO: `Booking_manager` but actual agent is `Booking_Manager`                                                                  | Handoff fails at runtime — compiler only checks exact match                      | S          |
| SV-12 | GATHER depends_on references field in different GATHER scope              | Step-level GATHER `depends_on: [destination]` but `destination` is in top-level GATHER, not step GATHER                      | Progressive activation logic breaks                                              | M          |
| SV-13 | COMPLETE conditions reference variables never populated                   | `WHEN: action_completed == true` but no tool or flow step ever sets `action_completed`                                       | Agent never completes — session hangs                                            | M          |
| SV-14 | ON_RETURN action references non-existent step or variable                 | `ON_RETURN: "route_to_booking_manager"` but no step by that name                                                             | Supervisor doesn't know what to do when child returns                            | M          |
| SV-15 | ESCALATE trigger references undefined variables                           | `WHEN: user.frustration_detected == true` but no gather/tool populates this                                                  | Escalation never fires when it should                                            | M          |
| SV-16 | Tool on_result/on_error variable mappings target undeclared session vars  | `on_result: { map: { reference_id: booking_ref } }` but `booking_ref` not in session memory                                  | Value stored but invisible to constraints/conditions                             | S          |
| SV-17 | ROUTING rules have overlapping/conflicting WHEN conditions                | Two handoffs both match `intent.category == "booking"` with different targets                                                | Non-deterministic routing — first match wins unpredictably                       | M          |
| SV-18 | Template interpolation references non-existent variables                  | `RESPOND: "Found {{hotels.length}} hotels"` but `hotels` not set                                                             | User sees raw `{{hotels.length}}` text or empty string                           | S          |

### Category 10: Tool Schema & Documentation (HIGH)

| #     | Issue                                                                  | Impact                                 | Fix Effort |
| ----- | ---------------------------------------------------------------------- | -------------------------------------- | ---------- |
| TS-01 | 15 of 18 tools have NO JSON Schema definition in definitions.ts        | Specialists can't call tools correctly | L          |
| TS-02 | Coordinator prompts and Studio system-prompt teach different tool sets | Inconsistent behavior by entry point   | M          |
| TS-03 | In-project phase prompt lists tools but no parameter descriptions      | LLM guesses parameter names            | M          |

### Category 10: Platform Context & Caching (LOW)

| #     | Issue                                                               | File                    | Impact                          | Fix Effort |
| ----- | ------------------------------------------------------------------- | ----------------------- | ------------------------------- | ---------- |
| PC-01 | Cache not invalidated when agents/tools/channels created            | platform-context.ts     | 5-min stale data                | S          |
| PC-02 | Model list assumes `body.data ?? body` — breaks on nested responses | platform-context.ts     | Silent failure                  | S          |
| PC-03 | Tool pagination not handled — only first page returned              | platform-context.ts     | Missing tools in large projects | M          |
| PC-04 | Guardrail count always returns 0                                    | arch-project-service.ts | SmartWelcome shows wrong data   | S          |

---

## Recommended Approach: Knowledge-First, Then Tools

Rather than fixing tools one by one, we build a **shared ABL knowledge layer** that all specialists and tools consume. This prevents duplicating construct knowledge across 9 specialists.

### Layer Architecture

```
┌─────────────────────────────────────────────────┐
│  ABL Knowledge Base (shared module)              │
│  - Construct catalog (syntax, semantics, patterns)│
│  - Healthy/unhealthy pattern rules               │
│  - Anti-pattern detection rules                  │
│  - Diagnostic decision trees                     │
└────────────┬────────────────────────┬────────────┘
             │                        │
    ┌────────▼────────┐    ┌──────────▼──────────┐
    │ Specialist       │    │ Tool Implementations │
    │ Prompts          │    │ (health-check, etc.) │
    │ (inject relevant │    │ (use knowledge base  │
    │  knowledge per   │    │  for smart validation)│
    │  specialist)     │    │                      │
    └─────────────────┘    └──────────────────────┘
```

---

## Dev Plan — Ordered Work Items

### Phase 1: Fix Critical False Positives (Week 1)

_Stop the bleeding — make health checks trustworthy_

| #   | Work Item                                                            | Issues Addressed | Deliverable                                      |
| --- | -------------------------------------------------------------------- | ---------------- | ------------------------------------------------ |
| 1.1 | Fix health-check guardrail regex                                     | HC-01            | Parser-based CONSTRAINTS/GUARDRAILS detection    |
| 1.2 | Fix health-check handoff extraction robustness                       | HC-02            | Use parser output consistently, add fallback     |
| 1.3 | Fix health-check tool binding false WARN on DB failure               | HC-04            | Distinguish "service error" from "tools missing" |
| 1.4 | Fix topology agent type detection (use parser, not string includes)  | TP-01            | Parser-based type detection                      |
| 1.5 | Fix topology handoff regex (underscores, complex syntax)             | TP-02, TP-03     | Parser-based edge extraction                     |
| 1.6 | Fix agent-ops createAgent: use full compile, not parse-only          | AO-01            | Catch tool binding errors at creation            |
| 1.7 | Fix content router: "change/modify topology" → multi-agent-architect | CR-01            | Updated regex rules                              |
| 1.8 | Fix content router: singular "metric" matching                       | CR-02            | Updated regex pattern                            |

### Phase 2: Build ABL Knowledge Base (Week 2)

_Shared intelligence layer all specialists consume_

| #   | Work Item                              | Issues Addressed    | Deliverable                                                                                              |
| --- | -------------------------------------- | ------------------- | -------------------------------------------------------------------------------------------------------- |
| 2.1 | Create ABL construct catalog module    | AK-01 through AK-13 | `packages/arch-ai/src/knowledge/abl-constructs.ts` — all 40+ constructs with syntax, semantics, examples |
| 2.2 | Create healthy/unhealthy pattern rules | AK-13               | `packages/arch-ai/src/knowledge/patterns.ts` — 12+ patterns with detection logic                         |
| 2.3 | Create anti-pattern detection rules    | AK-13               | `packages/arch-ai/src/knowledge/anti-patterns.ts` — 12+ anti-patterns with detection                     |
| 2.4 | Create diagnostic decision trees       | HC-03 through HC-09 | `packages/arch-ai/src/knowledge/diagnostics.ts` — per-construct health rules                             |
| 2.5 | Create construct-to-specialist mapping | CR-03, CR-05        | Which constructs each specialist should know about                                                       |

### Phase 3: Semantic & Cross-Agent Validation (Week 2-3)

_The intelligence layer — validate that agent logic MAKES SENSE, not just that it parses_

This is the core differentiator. The compiler checks syntax; Arch checks semantics.

| #    | Work Item                                                                                                                                                                           | Issues Addressed           | Deliverable                                                           |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | --------------------------------------------------------------------- |
| 3.1  | **HANDOFF return contract validation** — if RETURN:true, verify target has COMPLETE logic; if no COMPLETE, warn "control will never return"                                         | SV-01                      | `validateHandoffReturnContract()` in knowledge/diagnostics.ts         |
| 3.2  | **HANDOFF PASS field existence** — verify every field in `pass: [...]` exists in source agent's GATHER, session memory, or tool results                                             | SV-02                      | `validatePassFields()` — cross-reference PASS against known variables |
| 3.3  | **WHEN condition variable reachability** — for every WHEN clause (HANDOFF, DELEGATE, CONSTRAINT, ROUTING), verify referenced variables are populated before the condition evaluates | SV-03, SV-06, SV-15        | `validateConditionVariables()` — trace variable population chain      |
| 3.4  | **DELEGATE input/output contract** — verify INPUT fields map to target GATHER, RETURNS fields map to target outputs                                                                 | SV-04, SV-05               | `validateDelegateContract()` — cross-agent field mapping              |
| 3.5  | **Agent name mismatch detection** — fuzzy match agent names in HANDOFF/DELEGATE/ESCALATE against actual topology, flag case/spelling mismatches                                     | SV-11                      | `detectAgentNameMismatch()` — Levenshtein distance check              |
| 3.6  | **COMPLETE condition reachability** — verify every variable in COMPLETE WHEN clauses has a population source (SET, tool result, GATHER)                                             | SV-13                      | `validateCompletionReachability()` — trace variable origins           |
| 3.7  | **FLOW step reference validation** — verify ON_SUCCESS/ON_FAIL/ON_RETURN THEN targets exist, CALL references valid TOOLS, SET/CLEAR targets valid vars                              | SV-08, SV-09, SV-10, SV-14 | `validateFlowSemantics()` — full flow graph analysis                  |
| 3.8  | **Template interpolation validation** — verify `{{var}}` references in RESPOND exist in scope                                                                                       | SV-18                      | `validateTemplateVars()` — extract and check                          |
| 3.9  | **Routing rule conflict detection** — detect overlapping WHEN conditions across multiple HANDOFFs to different targets                                                              | SV-17                      | `detectRoutingConflicts()` — condition overlap analysis               |
| 3.10 | **CONSTRAINT action target validation** — ON_FAIL: HANDOFF target exists, ON_FAIL: COLLECT_FIELD target in GATHER                                                                   | SV-07                      | `validateConstraintTargets()` — cross-reference                       |
| 3.11 | **Tool result chain validation** — if CONSTRAINT references `tool_name.field`, verify tool is called before constraint evaluates                                                    | SV-06, SV-16               | `validateToolResultAvailability()` — execution order analysis         |

### Phase 4: Enhance Health Check with Semantic Layer (Week 3)

_Wire semantic validation into health-check tool_

| #   | Work Item                                                   | Issues Addressed | Deliverable                                   |
| --- | ----------------------------------------------------------- | ---------------- | --------------------------------------------- |
| 4.1 | Add circular handoff detection                              | HC-03, TP-05     | Graph cycle detection using topology data     |
| 4.2 | Add orphaned agent detection                                | HC-05, TP-05     | Reachability analysis from entry point        |
| 4.3 | Add CONSTRAINTS syntax validation                           | HC-06            | Parse and validate constraint expressions     |
| 4.4 | Add GATHER field quality checks                             | HC-07            | Missing prompts, invalid types, orphaned deps |
| 4.5 | Add FLOW reachability analysis                              | HC-08            | Dead step detection, missing transitions      |
| 4.6 | Add tool parameter compatibility check                      | HC-09            | DSL signature vs ProjectTool schema match     |
| 4.7 | Wire all Phase 3 semantic validators into health_check tool | All SV-\*        | Per-agent + cross-agent semantic report       |
| 4.8 | Add cross-agent validation to health check                  | HC-05, AO-03     | Topology-wide coherence checks                |

### Phase 5: Rewrite Specialist Prompts (Week 3-4)

_Inject ABL knowledge into each specialist_

| #   | Work Item                                                         | Issues Addressed           | Deliverable                                         |
| --- | ----------------------------------------------------------------- | -------------------------- | --------------------------------------------------- |
| 4.1 | Rewrite ABL Construct Expert with compiler-verified examples      | SP-01                      | ~4,000 token prompt with correct syntax             |
| 4.2 | Enhance Analyst with tool schemas and metric definitions          | SP-02                      | Add read_insights schema, threshold table           |
| 4.3 | Enhance Observability Analyst with trace structure and thresholds | SP-03                      | Add trace format, latency categories                |
| 4.4 | Enhance Testing & Eval with scenario taxonomy and eval criteria   | SP-04                      | Add scenario templates, coverage model              |
| 4.5 | Rewrite Channel & Voice specialist (full prompt)                  | SP-05                      | ~2,000 token prompt with voice/channel ABL patterns |
| 4.6 | Rewrite Entity Collection specialist (full prompt)                | SP-06                      | ~2,000 token prompt with GATHER patterns            |
| 4.7 | Rewrite Integration Methodologist (full prompt)                   | SP-07                      | ~2,500 token prompt with tool binding patterns      |
| 4.8 | Create Governance specialist prompt                               | SP-08                      | ~2,000 token prompt with compliance patterns        |
| 4.9 | Resolve phantom specialists — implement or remove from types      | SP-09 through SP-12, CR-04 | Clean up type system                                |

### Phase 6: Enhance Content Router (Week 4)

_Smarter routing with disambiguation_

| #   | Work Item                                                    | Issues Addressed | Deliverable                                        |
| --- | ------------------------------------------------------------ | ---------------- | -------------------------------------------------- |
| 5.1 | Add multi-pattern scoring (confidence-based routing)         | CR-03, CR-05     | Score all patterns, route to highest confidence    |
| 5.2 | Add disambiguation prompts for ambiguous messages            | CR-03            | Ask user when top-2 scores are close               |
| 5.3 | Add construct-aware routing (detect ABL keywords in message) | CR-05            | "GATHER" in message → entity-collection specialist |
| 5.4 | Remove dead specialist references from type system           | CR-04            | Clean types                                        |

### Phase 7: Enhance Tool Implementations (Week 4-5)

_Make tools return intelligence, not just data_

| #   | Work Item                                                    | Issues Addressed | Deliverable                                   |
| --- | ------------------------------------------------------------ | ---------------- | --------------------------------------------- |
| 6.1 | Add cross-agent validation to proposeModification            | AO-02, AO-03     | Check impact on other agents before proposing |
| 6.2 | Add quality analysis to read_agent (unused tools, dead code) | AO-05            | Return insights alongside agent data          |
| 6.3 | Add time-based filtering to analytics-ops                    | AN-04            | Default to last 7 days                        |
| 6.4 | Improve anomaly detection with pattern-based rules           | AN-03            | Replace naive "any error = anomaly"           |
| 6.5 | Add agentName validation to run_test                         | TE-01            | Check existence before calling runtime        |
| 6.6 | Fix platform-context cache invalidation                      | PC-01            | Invalidate on CRUD operations                 |
| 6.7 | Fix guardrail count in project summary                       | PC-04            | Query actual guardrails from agents           |

### Phase 8: Tool Schema Documentation (Week 5)

_All tools get proper JSON Schema definitions_

| #   | Work Item                                             | Issues Addressed | Deliverable                     |
| --- | ----------------------------------------------------- | ---------------- | ------------------------------- |
| 7.1 | Add JSON Schema for all 15 undocumented tools         | TS-01            | Complete definitions.ts         |
| 7.2 | Reconcile coordinator vs Studio tool registries       | TS-02            | Single source of truth          |
| 7.3 | Add parameter descriptions to in-project phase prompt | TS-03            | LLM knows exact parameter names |

### Phase 9: Analytics Intelligence (Week 5-6)

_Smarter insights and trend detection_

| #   | Work Item                                               | Issues Addressed | Deliverable                             |
| --- | ------------------------------------------------------- | ---------------- | --------------------------------------- |
| 8.1 | Fix sentiment trajectory threshold for sparse data      | AN-01            | Adaptive threshold based on sample size |
| 8.2 | Fix tool performance dual-path field mismatch           | AN-02            | Unified field mapping                   |
| 8.3 | Add comparative analysis (agent vs agent, week vs week) | AN-05            | New insight query actions               |
| 8.4 | Remove or implement dead insight actions                | AN-06            | Clean up intents/quality_scores stubs   |
| 8.5 | Add test result persistence and comparison              | TE-03, TE-04     | Track quality over time                 |

---

## Issue Count Summary

| Category                         | Critical | High   | Medium  | Low    | Total   |
| -------------------------------- | -------- | ------ | ------- | ------ | ------- |
| Health Check                     | 2        | 3      | 4       | 0      | **9**   |
| Topology                         | 1        | 3      | 2       | 0      | **6**   |
| Agent Ops                        | 1        | 2      | 2       | 0      | **5**   |
| Specialist Prompts               | 3        | 2      | 7       | 0      | **12**  |
| ABL Knowledge                    | 3        | 3      | 7       | 0      | **13**  |
| Content Router                   | 1        | 1      | 3       | 1      | **6**   |
| **Semantic Validation**          | **4**    | **5**  | **9**   | **0**  | **18**  |
| Analytics                        | 0        | 1      | 3       | 2      | **6**   |
| Testing                          | 0        | 1      | 3       | 1      | **5**   |
| Tool Schemas                     | 1        | 1      | 1       | 0      | **3**   |
| Platform Context                 | 0        | 0      | 1       | 3      | **4**   |
| Construct Diagnostics (98 rules) | 8        | 24     | 62      | 4      | **98**  |
| **Total**                        | **24**   | **46** | **104** | **11** | **185** |

---

## Backlog Cross-Reference

| Dev Plan Phase                    | Backlog Items Addressed                                                                  |
| --------------------------------- | ---------------------------------------------------------------------------------------- |
| Phase 1 (False Positives)         | B04 P0 fixes, IP-F06 foundation                                                          |
| Phase 2 (Knowledge Base)          | B20, B23 foundations, all IP-F\* intelligence                                            |
| **Phase 3 (Semantic Validation)** | **IP-F06, IP-F01, IP-F02 — the core intelligence layer that makes Arch actually useful** |
| Phase 4 (Health Check + Semantic) | IP-F06 (Agent Review & Health Check), B15 (Agent Health Score)                           |
| Phase 5 (Specialist Prompts)      | B04 (Enhanced In-Project), B22 (MEMORY), B25 (NLU), B26 (Tool Config)                    |
| Phase 6 (Content Router)          | B04 (Enhanced In-Project)                                                                |
| Phase 7 (Tool Enhancements)       | IP-F01 (Agent Modification), IP-F04 (Trace Analysis)                                     |
| Phase 8 (Tool Schemas)            | B17 (Doc Reconciliation)                                                                 |
| Phase 9 (Analytics)               | B59 (ABL Observer), B60 (ABL Improvement Loop)                                           |

---

## Success Criteria

After all phases complete:

1. Health check on a valid project reports **zero false positives**
2. Every specialist can answer construct-specific questions with **correct ABL syntax**
3. "Review my agents" returns **actionable insights** (not just "agents exist")
4. Routing sends messages to the **correct specialist** for 95%+ of common queries
5. propose_modification validates changes **in full project context**, not isolation
6. Analytics insights include **trend detection** and **comparative analysis**
7. **HANDOFF with RETURN:true flags missing COMPLETE logic** in target agent
8. **PASS fields validated** against actual GATHER/memory/tool-result variables
9. **WHEN conditions validated** — every referenced variable has a population source
10. **DELEGATE contracts validated** — INPUT maps to target GATHER, RETURNS maps to target outputs
11. **Agent name mismatches detected** — case, spelling, underscore variations flagged
12. **COMPLETE conditions validated** — unreachable completion variables flagged
13. **Routing conflicts detected** — overlapping WHEN conditions across handoffs flagged

## Semantic Validation Examples

To illustrate what "intelligence" means concretely:

### Example 1: HANDOFF Return Contract

```
# Agent: TravelDesk_Supervisor
HANDOFF:
  - TO: Booking_Manager
    RETURN: true
    CONTEXT:
      pass: [booking_id, customer_tier]

# Agent: Booking_Manager
GOAL: "Manage bookings"
PERSONA: |
  A booking management specialist
# ❌ NO COMPLETE SECTION — supervisor waits forever for return
```

**Arch should say:** "Booking_Manager has no COMPLETE logic. Since TravelDesk_Supervisor hands off with RETURN: true, Booking_Manager needs COMPLETE conditions (e.g., `WHEN: action_completed == true`) to signal when to return control."

### Example 2: PASS Field Mismatch

```
# Agent: TravelDesk_Supervisor
GATHER:
  destination:
    type: string
    prompt: "Where to?"

HANDOFF:
  - TO: Booking_Manager
    CONTEXT:
      pass: [booking_id, customer_tier]  # ❌ Neither exists in GATHER
```

**Arch should say:** "`booking_id` and `customer_tier` are listed in PASS but don't exist in this agent's GATHER fields, session memory, or tool results. Either add them to GATHER or remove from PASS."

### Example 3: Unreachable WHEN Condition

```
HANDOFF:
  - TO: Premium_Support
    WHEN: user.loyalty_tier == "platinum"  # ❌ Nothing populates user.loyalty_tier
```

**Arch should say:** "`user.loyalty_tier` is referenced in this WHEN condition but has no population source. Add it to GATHER, populate it from a tool result (e.g., `lookup_customer.loyalty_tier`), or load it from memory."

### Example 4: Routing Conflict

```
HANDOFF:
  - TO: Billing_Agent
    WHEN: intent.category == "billing" OR intent contains "payment"
  - TO: Refund_Agent
    WHEN: intent contains "payment" AND intent contains "refund"
```

**Arch should say:** "These two HANDOFF rules have overlapping conditions. A message like 'I want a payment refund' matches BOTH rules. The first match wins (Billing_Agent), which may not be correct. Consider making conditions mutually exclusive or adding priority."

---

## Appendix A: Cross-Construct Dependency Matrix

Every ABL construct interacts with others. This matrix captures ALL dependencies Arch must validate.

### A.1 Data Flow Chains (16 chains identified)

| Chain | Source                                    | Consumer                                                                    | What Can Break                                 | Compiler Checks                                                           | Arch Must Check |
| ----- | ----------------------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------- | --------------- |
| 1     | GATHER field → CONSTRAINT condition       | Type mismatch (string vs numeric), optional field makes constraint no-op    | Field exists (warning only)                    | Type compatibility, optional field + REQUIRE interaction                  |
| 2     | GATHER field → TOOL parameter (CALL_WITH) | Key doesn't match tool param, value not in gather/session                   | CALL references declared tool only             | call_with keys match tool params, values exist in scope                   |
| 3     | GATHER field → HANDOFF PASS               | Pass field not in gather/memory, target agent expects different name        | Nothing                                        | Pass fields exist, target agent field name match, type match              |
| 4     | GATHER field → FLOW CHECK/ON_INPUT        | on_input conditions never validated, step-scope leaks                       | CHECK vars warned only                         | on_input/on_result/on_success/on_failure conditions, step execution order |
| 5     | TOOL result → CONSTRAINT                  | Tool failure silently bypasses constraint, dot-paths skipped                | Auto-guard only                                | Tool failure path, dot-path validation, temporal ordering                 |
| 6     | TOOL result → FLOW ON_SUCCESS/ON_FAIL     | Missing ON_FAIL handler, branch conditions unvalidated                      | Step transition targets only                   | ON_FAIL presence, branch condition variables                              |
| 7     | TOOL result → HANDOFF WHEN                | **WHEN conditions COMPLETELY UNVALIDATED**                                  | Nothing                                        | Variable existence, typo detection, temporal ordering                     |
| 8     | GATHER field → TEMPLATE {{interpolation}} | Typo in {{field}} renders "undefined" to user                               | Nothing                                        | {{var}} references exist in scope, optional field handling                |
| 9     | FLOW SET → COMPLETE WHEN                  | Typo in COMPLETE WHEN, unreachable SET                                      | COMPLETE WHEN not scanned                      | Variables have population source, SET reachability                        |
| 10    | MEMORY → any consumer                     | Uninitialized session var, first-session persistent memory empty            | Session var population source warned           | initial_value presence, persistent memory first-access                    |
| 11    | GATHER depends_on → activation order      | Required field depends on optional, conditional activation chain impossible | Circular deps, missing refs                    | Required→optional chain, conditional reachability, depth                  |
| 12    | BEHAVIOR_PROFILE → overridden constructs  | tools_hide breaks FLOW CALL, flow skip breaks transitions                   | Profile name existence, tools_hide names exist | Re-validate tool refs and flow graph post-profile                         |
| 13    | FLOW CLEAR → downstream consumers         | CLEAR removes value that CHECK/CONSTRAINT needs                             | Nothing                                        | Impact of CLEAR on downstream conditions                                  |
| 14    | FLOW TRANSFORM → target variable          | Source/target never validated                                               | Nothing                                        | Source exists, register target as known var                               |
| 15    | ON_START SET → first-turn state           | SET targets undeclared vars, on_start failure leaves vars unset             | Tool refs and delegate refs                    | SET targets declared, failure impact on first-turn constraints            |
| 16    | DIGRESSION → flow state                   | CLEAR/CALL/GOTO within digressions affect main flow                         | goto targets, call tools                       | CLEAR field names, call tool refs in DO blocks                            |

### A.2 Per-Construct Diagnostic Rules

#### TOOLS — 12 diagnostic rules

| Rule | Severity | What to Check                                                            | Currently Checked? |
| ---- | -------- | ------------------------------------------------------------------------ | ------------------ |
| T-01 | ERROR    | AVAILABLE_TOOLS in flow step references undeclared tool                  | NO                 |
| T-02 | WARN     | Tool declared but never referenced in FLOW/HOOKS/ON_START/digressions    | NO                 |
| T-03 | WARN     | Tool has `requires_auth: true` hint but no auth_profile_ref              | NO                 |
| T-04 | WARN     | HTTP tool endpoint URL is not valid or is localhost in production        | NO                 |
| T-05 | WARN     | MCP tool `server` name doesn't match configured MCP servers              | NO                 |
| T-06 | WARN     | SearchAI tool `indexId` doesn't match configured knowledge bases         | NO                 |
| T-07 | WARN     | Model doesn't support tool calling but agent has TOOLS declared          | NO                 |
| T-08 | ERROR    | auth_profile_ref doesn't point to existing auth profile                  | NO                 |
| T-09 | WARN     | Tool parameter types inconsistent with GATHER field types that feed them | NO                 |
| T-10 | WARN     | async_webhook tool type has no dedicated runtime executor                | NO                 |
| T-11 | WARN     | Tool with `store_result: false` but result referenced in conditions      | NO                 |
| T-12 | WARN     | Tool with side_effects hint but no confirmation configured               | NO                 |

#### GATHER — 8 diagnostic rules

| Rule | Severity | What to Check                                                                | Currently Checked? |
| ---- | -------- | ---------------------------------------------------------------------------- | ------------------ |
| G-01 | WARN     | Gather field never referenced in CONSTRAINT, HANDOFF PASS, FLOW, or COMPLETE | NO                 |
| G-02 | ERROR    | Top-level gather field name duplicates step-level gather field name          | NO                 |
| G-03 | WARN     | Gather field type is `enum` but no options defined                           | NO                 |
| G-04 | WARN     | Required field depends_on optional field                                     | NO                 |
| G-05 | WARN     | depends_on chain passes through conditionally-activated field                | NO                 |
| G-06 | WARN     | depends_on chain deeper than 3 levels                                        | NO                 |
| G-07 | WARN     | Gather field name shadows session memory variable name                       | NO                 |
| G-08 | WARN     | Gather field with `sensitive: true` but no `sensitive_display` configured    | NO                 |

#### CONSTRAINTS — 10 diagnostic rules

| Rule | Severity | What to Check                                                                       | Currently Checked? |
| ---- | -------- | ----------------------------------------------------------------------------------- | ------------------ |
| C-01 | WARN     | Numeric operator (`>`, `<`, `>=`, `<=`) on string-type gather field                 | NO                 |
| C-02 | WARN     | REQUIRE on optional field without explicit IS SET guard (auto-guard makes it no-op) | NO                 |
| C-03 | ERROR    | ON_FAIL: HANDOFF target is not a known agent                                        | NO                 |
| C-04 | WARN     | ON_FAIL: ESCALATE but no ESCALATE section defined                                   | NO                 |
| C-05 | WARN     | ON_FAIL: COLLECT field has no prompt defined in GATHER                              | NO                 |
| C-06 | WARN     | Constraint references tool return field but tool may not have been called yet       | NO                 |
| C-07 | WARN     | Constraint references dot-path (e.g., `tool.field`) — skipped entirely today        | NO                 |
| C-08 | WARN     | Constraint condition is tautological after auto-guard                               | NO                 |
| C-09 | WARN     | Constraint and guardrail cover the same concern (redundant)                         | NO                 |
| C-10 | WARN     | Constraint WHEN-lowered to pure OR with no auto-guard                               | NO                 |

#### HANDOFF/DELEGATE/ESCALATE — 14 diagnostic rules

| Rule | Severity | What to Check                                                  | Currently Checked?               |
| ---- | -------- | -------------------------------------------------------------- | -------------------------------- |
| H-01 | WARN     | HANDOFF RETURN:true but target has no COMPLETE conditions      | NO                               |
| H-02 | ERROR    | PASS field not in GATHER, session memory, or tool results      | NO                               |
| H-03 | WARN     | PASS field name doesn't match any GATHER field in target agent | NO                               |
| H-04 | WARN     | PASS field type mismatch between source and target agent       | NO                               |
| H-05 | WARN     | WHEN condition references variable with no population source   | NO (WHEN completely unvalidated) |
| H-06 | WARN     | HANDOFF to self (direct circular reference)                    | NO                               |
| H-07 | WARN     | ON_RETURN MAP keys reference fields target doesn't produce     | NO                               |
| H-08 | WARN     | grant_memory paths not declared in persistent memory           | NO                               |
| H-09 | WARN     | Multiple HANDOFFs with overlapping WHEN conditions             | NO                               |
| H-10 | WARN     | DELEGATE input references unknown context variables            | NO                               |
| H-11 | WARN     | DELEGATE returns vars never used in agent                      | NO                               |
| H-12 | WARN     | DELEGATE on_failure is "escalate" but no ESCALATE section      | NO                               |
| H-13 | ERROR    | ESCALATE context_for_human references undeclared fields        | NO                               |
| H-14 | WARN     | ESCALATE defined but no trigger or constraint ever fires it    | NO                               |

#### FLOW — 14 diagnostic rules

| Rule | Severity | What to Check                                                              | Currently Checked? |
| ---- | -------- | -------------------------------------------------------------------------- | ------------------ |
| F-01 | WARN     | CALL step has no ON_SUCCESS and no ON_FAILURE handlers                     | NO                 |
| F-02 | WARN     | Step has EXIT_WHEN but no MAX_TURNS (could loop forever)                   | NO                 |
| F-03 | WARN     | Step transitions create cycle without EXIT_WHEN or MAX_TURNS               | NO                 |
| F-04 | ERROR    | ON_ERROR BACKTRACK_TO references nonexistent step                          | NO                 |
| F-05 | WARN     | CALL_WITH keys don't match tool parameter names                            | NO                 |
| F-06 | WARN     | CALL_WITH values reference variables not in scope                          | NO                 |
| F-07 | WARN     | TRANSFORM source references unknown variable                               | NO                 |
| F-08 | ERROR    | STEP_CONSTRAINTS reference undefined gather fields                         | NO                 |
| F-09 | WARN     | Step has GATHER but no subsequent step uses gathered data                  | NO                 |
| F-10 | WARN     | Step has MAX_TURNS but no EXIT_WHEN (infinite reasoning with cap)          | NO                 |
| F-11 | WARN     | on_input/on_result/on_success/on_failure conditions reference unknown vars | NO                 |
| F-12 | WARN     | CLEAR targets field referenced by downstream step CHECK/CONSTRAINT         | NO                 |
| F-13 | WARN     | CALL step tool needs auth but no identity_tier configured                  | NO                 |
| F-14 | WARN     | ON_SUCCESS branch references fields not in called tool's returns           | NO                 |

#### COMPLETE — 4 diagnostic rules

| Rule  | Severity | What to Check                                                          | Currently Checked? |
| ----- | -------- | ---------------------------------------------------------------------- | ------------------ |
| CO-01 | WARN     | COMPLETE WHEN references variable never SET in any reachable flow step | NO                 |
| CO-02 | WARN     | Agent has no COMPLETE and no flow steps transitioning to COMPLETE      | NO                 |
| CO-03 | WARN     | COMPLETE WHEN references only optional fields (may never fire)         | NO                 |
| CO-04 | ERROR    | Agent is HANDOFF target with RETURN:true but has no COMPLETE logic     | NO                 |

#### MEMORY — 6 diagnostic rules

| Rule | Severity | What to Check                                                 | Currently Checked? |
| ---- | -------- | ------------------------------------------------------------- | ------------------ |
| M-01 | WARN     | Session var referenced in CONSTRAINT but has no initial_value | NO                 |
| M-02 | WARN     | Session var initial_value type doesn't match declared type    | NO                 |
| M-03 | WARN     | Persistent path declared but never used in REMEMBER or RECALL | NO                 |
| M-04 | WARN     | Session var populated but never read by any consumer          | NO                 |
| M-05 | ERROR    | Duplicate session variable name                               | NO                 |
| M-06 | WARN     | REMEMBER WHEN condition references undeclared vars            | NO                 |

#### EXECUTION — 7 diagnostic rules

| Rule | Severity | What to Check                                               | Currently Checked? |
| ---- | -------- | ----------------------------------------------------------- | ------------------ |
| E-01 | WARN     | temperature outside 0-2 range                               | NO                 |
| E-02 | WARN     | enable_thinking: true but model doesn't support thinking    | NO                 |
| E-03 | ERROR    | thinking_budget set but enable_thinking is false            | NO                 |
| E-04 | WARN     | Timeout values zero or negative                             | NO                 |
| E-05 | WARN     | VOICE config exists but model doesn't support voice         | NO                 |
| E-06 | WARN     | operation_models reference unknown model names              | NO                 |
| E-07 | WARN     | compaction_threshold below 0.3 (very aggressive compaction) | NO                 |

#### GUARDRAILS — 5 diagnostic rules

| Rule  | Severity | What to Check                                                   | Currently Checked? |
| ----- | -------- | --------------------------------------------------------------- | ------------------ |
| GR-01 | ERROR    | Duplicate guardrail name                                        | NO                 |
| GR-02 | WARN     | Guardrail check expression is empty                             | NO                 |
| GR-03 | WARN     | Guardrail threshold outside 0-1 range                           | NO                 |
| GR-04 | WARN     | Streaming guardrail on input kind (streaming applies to output) | NO                 |
| GR-05 | WARN     | Guardrail with llm_check but no model configured for validation | NO                 |

#### BEHAVIOR_PROFILE — 6 diagnostic rules

| Rule  | Severity | What to Check                                               | Currently Checked? |
| ----- | -------- | ----------------------------------------------------------- | ------------------ |
| BP-01 | WARN     | Profile WHEN condition references undeclared variables      | NO                 |
| BP-02 | WARN     | Multiple profiles with identical PRIORITY                   | NO                 |
| BP-03 | ERROR    | Profile tools_hide removes tool referenced by FLOW CALL     | NO                 |
| BP-04 | ERROR    | Profile flow skip removes step that is transition target    | NO                 |
| BP-05 | WARN     | Profile constraint references vars not in host agent gather | NO                 |
| BP-06 | WARN     | Profile gather_overrides reference nonexistent fields       | NO                 |

#### OTHER CONSTRUCTS — 12 diagnostic rules

| Rule | Severity | What to Check                                                          | Currently Checked? |
| ---- | -------- | ---------------------------------------------------------------------- | ------------------ |
| O-01 | WARN     | GOAL is empty or under 10 characters                                   | NO                 |
| O-02 | WARN     | PERSONA empty on agent with REASONING steps                            | NO                 |
| O-03 | WARN     | LIMITATIONS text contains evaluatable conditions (suggest CONSTRAINTS) | NO                 |
| O-04 | WARN     | NLU entity references field not in GATHER                              | NO                 |
| O-05 | WARN     | NLU intents defined but no routing uses them                           | NO                 |
| O-06 | ERROR    | LOOKUP_TABLE source "inline" but values empty                          | NO                 |
| O-07 | ERROR    | LOOKUP_TABLE source "api" but no endpoint                              | NO                 |
| O-08 | WARN     | LOOKUP_TABLE defined but never referenced                              | NO                 |
| O-09 | WARN     | ON_ERROR BACKTRACK_TO references nonexistent step                      | NO                 |
| O-10 | WARN     | ON_ERROR THEN: ESCALATE but no ESCALATE section                        | NO                 |
| O-11 | WARN     | Template {{field}} interpolation references non-existent variable      | NO                 |
| O-12 | WARN     | DESTINATION defined but never referenced                               | NO                 |

### A.3 Total Diagnostic Rules: 98

| Construct                 | Rules  | Currently Checked | Arch Must Add |
| ------------------------- | ------ | ----------------- | ------------- |
| TOOLS                     | 12     | 0                 | 12            |
| GATHER                    | 8      | 0                 | 8             |
| CONSTRAINTS               | 10     | 0                 | 10            |
| HANDOFF/DELEGATE/ESCALATE | 14     | 0                 | 14            |
| FLOW                      | 14     | 0                 | 14            |
| COMPLETE                  | 4      | 0                 | 4             |
| MEMORY                    | 6      | 0                 | 6             |
| EXECUTION                 | 7      | 0                 | 7             |
| GUARDRAILS                | 5      | 0                 | 5             |
| BEHAVIOR_PROFILE          | 6      | 0                 | 6             |
| OTHER                     | 12     | 0                 | 12            |
| **TOTAL**                 | **98** | **0**             | **98**        |

None of these 98 rules are checked by the compiler today. This is the intelligence gap that makes Arch produce false positives and generic advice instead of precise, actionable diagnostics.
