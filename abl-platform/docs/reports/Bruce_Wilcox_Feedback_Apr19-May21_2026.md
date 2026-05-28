# BRUCE WILCOX — ABL PLATFORM FEEDBACK

## Emails: April 19 – May 21, 2026 | To: Prasanna Arikala

**Total: 48 items | 2 CRITICAL | 12 HIGH | 10 MEDIUM | 24 SPEC/DOC/EXAMPLE**

---

# PART A: CODE BUGS & IMPLEMENTATION ISSUES

---

## 1. Editor Package

### 1.1 [CRITICAL] nodesToDocuments silently discards canvas edits on export

**Email:** Execution + Editor + HANDOFF (Apr 19) | conversion.ts:266-291

> It pulls the agent document wholesale from node.data.document, never rebuilding from edges/children. Canvas edits that don't also write back to data.document are lost.

Three specific failure modes: (a) Edits to step/routing/guardrail/tool properties go nowhere — stepNode.data.stepNumber is set but nodesToDocuments doesn't read step nodes. (b) Edits to supervisor/agent top-level props sit on data.label/data.agentName while export reads frozen data.document from import time. (c) Edge changes (adding/removing connections, re-wiring step flow) don't touch .document either.

---

## 2. Execution Package

### 2.1 [HIGH] Unscoped Redis callback key uses deterministic ID

**Email:** Execution + Editor + HANDOFF (Apr 19) | async-webhook-executor.ts:55

> Safe only if every caller uses crypto-random IDs; but the webhook executor builds a deterministic `${executionId}:${step.id}`.

---

## 3. Handoff / Delegate Type Safety

### 3.1 [CRITICAL] HANDOFF CONTEXT.pass silently loses GATHER type annotations

**Email:** Execution + Editor + HANDOFF (Apr 19)

> If GATHER declares `age` as `number` and author writes CONTEXT.pass: [age] but doesn't add age to MEMORY.session, the tool parameter generated for the handoff will be `{ name: 'age', type: 'string' }`. The GATHER type annotation is silently lost. Particularly serious for array and non-primitive types.

Compiler should at minimum warn ("age was passed but not declared in MEMORY.session — resolved as string; consider promoting") and cross-check for conflicting type declarations.

### 3.2 [HIGH] DELEGATE has no compile-time type-safety at all

**Email:** Execution + Editor + HANDOFF (Apr 19)

Three failure modes: (a) Type mismatch: parent passes number, sub-agent expects string — silently passed. (b) Dropped fields (delegate-executor.ts:184): undefined sourceExpr silently dropped into droppedFields[]. (c) No cross-agent validation: typo in `INPUT: { topc: user_query }` compiles, runs, drops silently.

### 3.3 [MEDIUM] HANDOFF/DELEGATE interface inconsistency

**Email:** Execution + Editor + HANDOFF (Apr 19)

DELEGATE uses `INPUT: {}` and `AGENT:`. HANDOFF uses `CONTEXT: pass:` and `TO:`. Different argument treatment. Extra cognitive load for scripters.

---

## 4. Compiler / Parser

### 4.1 [HIGH] MEMORY vs GATHER type conflict silently ignored

**Email:** variable types (May 17)

> If MEMORY declares a variable as one type and GATHER declares it as another, Gather wins assigning. The MEMORY type: is silently ignored. No error, no warning, no runtime check. Downstream template interpolation might get a number where code expects a string.

### 4.2 [HIGH] ENTITIES section not documented in ABL_SPEC

**Email:** ENTITIES-TEST examples (Apr 26)

> ENTITIES is missing from ABL_SPEC! entity-reasoning-test-agent uses sensitive on gather variables but doesn't specify SENSITIVE_DISPLAY. Runtime does not use parsed SENSITIVE_DISPLAY.

### 4.3 [HIGH] Handoff conditions fail on null vs false comparisons

**Email:** Saludsa examples (May 21)

> Handoff conditions will fail because user.is_validated defaults to null and thus is not false. `WHEN: user.is_validated == false` won't match when the value is null.

---

## 5. Spec / System Variables

### 5.1 [HIGH] user.requests_human referenced in spec/examples but never set by runtime

**Email:** BL_SPEC (Apr 25)

> user.requests_human does not seem to be set by any runtime code, and example scripts don't set it either. EVEN in ABL_SPEC this exists as an escalate example.

### 5.2 [HIGH] System variable naming inconsistency

**Email:** BL_SPEC (Apr 25)

Leading-underscore vars: \_clarification_count, \_validation_retries, \_pending_inferences, \_constraint_warnings, \_disambiguation_intents. Non-prefixed: tool_failures, constraint_failures, channel, language, sentiment_trajectory, match. Easily confused with user session variables. Also: user.sentiment vs sentiment_trajectory (inconsistent namespacing).

### 5.3 [HIGH] System variables not documented in ABL_SPEC

**Email:** BL_SPEC (Apr 25)

Bruce provides comprehensive list including: user.frustration*detected, user.intent, intent.\*, user.sentiment, sentiment_trajectory, \_clarification_count, \_validation_retries, \_pending_inferences, all_fields_gathered, last*<tool>\_result, channel, language, handoff.completed, escalate.completed, match._, caller._. None documented in spec.

---

## 6. Guardrails Examples

### 6.1 [HIGH] PII protection agent uses manual inadequate patterns and inverts truth test

**Email:** Guardrails examples (Apr 28)

> pii_protection agent code uses manual inadequate patterns. Should use builtins. And code inverts truth test — if we MATCH we want to guard.

---

## 7. Constraints Documentation

### 7.1 [MEDIUM] Constraints doc should explain WHEN constraints are checked and variable clearing

**Email:** ABL_CONSTRAINTS (May 7)

> Reference doc should have a section explaining when constraints are checked and under what conditions some variables may be cleared.

---

## 8. Memory

### 8.1 [MEDIUM] No per_activation reset for memory variables

**Email:** MEMORY resets (May 17)

> Could imagine wanting to treat every invocation of an agent as a fresh call with memory variables reset. Currently not feasible. Maybe support `reset: per_activation`?

Feature request.

---

# PART B: SPEC / DOC ISSUES

---

## 9. Spec Consistency

### 9.1 Handoff ON_FAILURE should be renamed ON_FAIL for consistency

**Email:** Handoff on_failure (Apr 21)

> Everything else is using ON_FAIL. This makes handoff's exception confusing.

### 9.2 HANDOFF type adjustment to string is irrelevant (recanted)

**Email:** recanting handoff/types (Apr 19)

> No one uses the type data, receiving agents do no type conversion. Type data would only go to LLM as advice but LLM doesn't get it. Irrelevant.

### 9.3 LLM for gather validation — batch multiple validations per call?

**Email:** Execution + Editor + HANDOFF (Apr 19)

> Called once per field that has `validation.type: 'llm'` — have you experimented to see if LLM can handle multiple validations per call?

Efficiency suggestion.

---

# PART C: EXAMPLE REVIEWS (10 examples)

Each example review surfaces both example-specific bugs and systemic issues. Listed by example:

---

## 10. Apple-Care (Apr 24-25)

### 10.1 [EX] Uses old-style RETURN instead of EXPECT_RETURN

### 10.2 [EX] Supervisor handoff to Device_support doesn't pass serial_number

### 10.3 [EX] Escalate test on undefined variable

### 10.4 [EX] IMPLIES constraint tests condition that can never be true at that point

### 10.5 [EX] ON_INPUT contains-based routing is silly when THEN would suffice

### 10.6 [EX] "Genius bar" referenced — Apple-specific term shouldn't be in generic example

---

## 11. BankNexus Updates (Apr 25)

### 11.1 [EX] Additional issues on top of prior BankNexus feedback (see Mar 22-Apr 18 doc)

---

## 12. Entities-Test (Apr 26)

### 12.1 [EX] SENSITIVE_DISPLAY parsed but runtime doesn't use it

### 12.2 [EX] ENTITIES section missing from ABL_SPEC entirely

---

## 13. Env_Demo (May 1)

### 13.1 [EX] Supervisor has no AGENTS declaration

### 13.2 [EX] Handoff passes undefined variable `query` — dead code

### 13.3 [EX] System ignores undefined variable in CONTEXT.pass (no error)

---

## 14. Crawler (May 1)

### 14.1 [EX] COMPLETE condition can never match — crawl_batch.status and all_browser_pages_visited both unreachable at runtime

---

## 15. Dispute_Transaction (May 4)

### 15.1 [EX] "This example is going nowhere" — various undefined variables: profile_id, customer_info, dispute_context, conversation_history, escalation_reason, escalation_required, contact_to_merchant

---

## 16. AI4H-Payer (May 3)

### 16.1 [EX] No agent is a supervisor — Welcome_Agent should be

### 16.2 [EX] EXECUTION max_flow_iterations: 200 — default is 100, why doubled with no comment?

---

## 17. Retail (May 5)

### 17.1 [EX] Supervisor passes undefined variables: customer_id, order_id, item_id, cart_contents, manager_approved

### 17.2 [EX] user.wants_human doesn't exist — handoff always fails

---

## 18. Telco (May 9 + May 11)

### 18.1 [EX] Legacy ON_START in Recall should use current recall event syntax

### 18.2 [EX] abl_spec should document recall event ON/ACTION/PATHS meanings

### 18.3 [EX] network_triage_agent: alarm_id assumed passed by supervisor but never set

### 18.4 [EX] Step calls multiple CALLs sequentially — not documented whether that's legal

### 18.5 [MEDIUM] Undefined variable handling — system silently passes null to tools without error

---

## 19. Saludsa (May 21)

### 19.1 [EX] Handoff conditions fail on null vs false for user.is_validated

### 19.2 [EX] Whatsapp_User_Check routing uses undefined state

---

## 20. Agent Handbook (Apr 21)

### 20.1 [DOC] Various issues in handbook HTML documentation (forwarded from Harsha)

---

# PART D: SUMMARY BY SEVERITY

---

## CRITICAL (2)

1. Editor nodesToDocuments silently discards all canvas edits on export
2. HANDOFF CONTEXT.pass silently loses GATHER type annotations (resolves as string)

## HIGH (12)

3. Unscoped Redis callback key uses deterministic ID
4. DELEGATE has no compile-time type-safety
5. MEMORY vs GATHER type conflict silently ignored
6. ENTITIES section missing from ABL_SPEC
7. Handoff conditions fail on null vs false
8. user.requests_human referenced but never set
9. System variable naming inconsistency
10. System variables not documented in ABL_SPEC
11. PII guardrails example uses wrong patterns and inverted logic
12. Handoff conditions on Saludsa fail due to null defaults
13. Undefined variables silently passed as null to tools
14. SENSITIVE_DISPLAY parsed but runtime ignores it

## MEDIUM (10)

15. HANDOFF/DELEGATE interface inconsistency
16. Constraints doc missing evaluation timing section
17. No per_activation reset for memory variables
18. Undefined variable handling (system-wide, no error on null pass)
    19–24. Various example-specific medium issues

## SPEC/DOC/EXAMPLE (24)

25. Handoff ON_FAILURE → ON_FAIL rename
26. Type adjustment recanted as irrelevant
27. LLM validation batching suggestion
    28–48. Example review items across 10 examples (Apple-Care, BankNexus, Entities-Test, Env_Demo, Crawler, Dispute_Transaction, AI4H-Payer, Retail, Telco, Saludsa)

---

**Note:** Bruce's May 21 email ("Venture Beat Story") asks: "Is this system actually released? I would think Arch is not quite ready. Where are you in bug/enhancement implementations of what I've reported to you."
