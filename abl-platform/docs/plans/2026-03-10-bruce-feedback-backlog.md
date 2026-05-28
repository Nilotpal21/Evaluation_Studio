# Bruce Wilcox Feedback — Prioritized Backlog

**Created:** 2026-03-10
**Source:** [Consolidated Review](./2026-03-10-bruce-wilcox-feedback-review.md)
**Total items:** 33 confirmed + 5 partial = 38 actionable items

---

## Sprint 5 — Critical Hotfixes (Immediate)

**Goal:** Fix all critical/high bugs that are small in scope. Estimated: 2-3 days.

| #    | Item                                                     | LOE       | Files to Change                           |
| ---- | -------------------------------------------------------- | --------- | ----------------------------------------- |
| 4.1  | goto_step field mismatch (`then_step` → `target`)        | 1 line    | `constraint-checker.ts:257`               |
| 9.2  | IndexRegistry missing tenantIsolationPlugin              | 1 line    | `index-registry.model.ts`                 |
| 9.1  | SearchDocument query missing explicit tenantId           | 1 line    | `documents.ts:39`                         |
| 5.4  | Action applier uses default action not severity-resolved | ~20 lines | `pipeline.ts:275`, `action-applier.ts:51` |
| 10.2 | Compiler downgrades error diagnostics to warnings        | ~10 lines | `compiler.ts:337-344`                     |
| 6.2  | Digression substring matching → word boundary regex      | ~5 lines  | `fallbacks.ts:48-77`                      |

**Validation:** Add tests for each fix. For 4.1, add a test that compiles a goto_step constraint via the compiler and runs it through `interpretConstraintControlFlow` end-to-end.

---

## Sprint 6 — ON_ERROR & Guardrails Correctness (1 week)

**Goal:** Make ON_ERROR system functional and fix guardrails correctness bugs.

### ON_ERROR (3-4 days)

| #   | Item                                              | LOE    | Notes                                                    |
| --- | ------------------------------------------------- | ------ | -------------------------------------------------------- |
| 2.1 | RESPOND messages reach user via onChunk           | Medium | Thread `onChunk` through `executeToolWithErrorHandling`  |
| 2.4 | Error type classification                         | Medium | New `classifyToolError()` helper + wiring at catch sites |
| 2.3 | HANDOFF action dead code → wire to routing engine | Medium | Check `resolution.action === 'handoff'` post-resolution  |
| 2.2 | Implement LOG directive                           | Small  | AST field, parser case, compiler mapping, runtime emit   |

### Guardrails (3-4 days)

| #   | Item                                           | LOE    | Notes                                                              |
| --- | ---------------------------------------------- | ------ | ------------------------------------------------------------------ |
| 5.5 | Streaming evaluator: pass full buffer          | Small  | Change `this.buffer.slice(evaluatedUpTo)` → `this.buffer`          |
| 5.2 | Remove dual input guardrail evaluation         | Medium | Skip guardrail violations in `checkConstraints` after pipeline run |
| 5.3 | result.passed semantics: add `result.modified` | Small  | New boolean + trace events for non-terminal actions                |
| 5.6 | Provider registry: LRU refresh on access       | Small  | Refresh `registeredAt` in `get()`                                  |

---

## Sprint 7 — Memory, Constraints & Safety (1 week)

**Goal:** Fix memory dedup, constraint safety, and PII handling.

### Memory (2-3 days)

| #   | Item                                                 | LOE    | Notes                                                                 |
| --- | ---------------------------------------------------- | ------ | --------------------------------------------------------------------- |
| 3.1 | Remember trigger dedup (read-before-write)           | Medium | Batch `getMany()` before writes in `evaluateRememberAfterStateChange` |
| 3.2 | Add `tool:before` / `turn:before` recall events      | Medium | New taxonomy entries + `resolveToolBeforeEvents` + wiring             |
| 3.3 | Escalate context: runtime warning for missing fields | Small  | Warning trace in `filterEscalationContext`                            |

### Constraints (2-3 days)

| #   | Item                                             | LOE    | Notes                                                        |
| --- | ------------------------------------------------ | ------ | ------------------------------------------------------------ |
| 4.3 | retry_step backtrack limit                       | Small  | Add `MAX_RETRIES_PER_STEP` parallel to goto_step limit       |
| 4.6 | Reset backtrack counts on step exit              | Small  | Clear counts in step transition logic                        |
| 8.1 | PII redaction: support non-canonical field names | Medium | Field-to-PII hints in GATHER config or infer from validation |

---

## Sprint 8 — Spec, Docs & Compiler Hardening (1 week)

**Goal:** Fix DSL spec issues, add missing documentation, harden compiler.

### Spec & Compiler (3 days)

| #    | Item                                                          | LOE    | Notes                                           |
| ---- | ------------------------------------------------------------- | ------ | ----------------------------------------------- |
| 6.4  | Fix spec examples (COLLECT/PROMPT → gather)                   | Small  | Doc-only                                        |
| 10.1 | Add ON_FAILURE to HandoffConfig                               | Medium | Schema + parser + compiler + runtime handling   |
| 1.2  | Compiler lint for tools with side_effects but no confirmation | Medium | New analyzer rule                               |
| 5.1  | Reask: implement or remove from type system                   | Medium | Decision needed: implement retry loop or remove |
| 15   | Configurable default language per agent/project               | Small  | Add to agent config, use in fallback            |

### Documentation (2 days)

| #   | Item                                                 | LOE    | Notes                                                |
| --- | ---------------------------------------------------- | ------ | ---------------------------------------------------- |
| 6.1 | Document ON_INPUT as deterministic-only              | Small  | Spec update                                          |
| 6.6 | Document implicit global variables                   | Small  | New spec section                                     |
| 6.7 | Document EXECUTION section                           | Medium | New spec section covering all ExecutionConfig fields |
| 5.8 | Align spec action names with IR types                | Small  | Replace REGENERATE→reask, add fix/filter             |
| 6.3 | Document CALL syntax modes                           | Small  | Spec update                                          |
| 6.5 | Document ON\_ label interactions                     | Small  | Spec update                                          |
| 3.3 | Clarify context_for_human requires session variables | Small  | Spec update                                          |

---

## Backlog — Feature Requests (Unscheduled)

### P1 — Competitive Blockers

| #   | Feature                                                               | Competitor Reference                     |
| --- | --------------------------------------------------------------------- | ---------------------------------------- |
| —   | Conversation testing framework (send X, expect Y, verify slot Z)      | Cognigy Playbooks, Rasa Story Testing    |
| —   | Agent versioning & rollback (snapshot N in prod, edit N+1 in staging) | Cognigy Snapshots, Rasa Model Versioning |
| —   | Human handoff queue management UI                                     | Cognigy Agent Copilot                    |

### P2 — Platform Gaps

| #    | Feature                                              | Notes                                                 |
| ---- | ---------------------------------------------------- | ----------------------------------------------------- |
| 7.1  | Custom extractors in scripted GATHER                 | Needed for complex entity types                       |
| 7.2  | Custom regex entities                                | XO11 migration blocker                                |
| 11.1 | Pluggable classifier strategy for supervisor routing | LLM/NLU-sidecar/embedding options                     |
| 5.7  | Budget enforcement in guardrails pipeline            | Load budget config from DB policy                     |
| —    | Real-time translation                                | Cognigy gap — agent in English serving Japanese users |
| —    | LLM-based intent reranking                           | Cognigy/Rasa both have it                             |

### P3 — Nice to Have

| #    | Feature                                                     | Notes                                               |
| ---- | ----------------------------------------------------------- | --------------------------------------------------- |
| 12.2 | Chunking strategy comparison tool                           | Search.AI UX enhancement                            |
| 4.2  | Phase-scoped constraint evaluation                          | Currently by-design flat, could add phase isolation |
| 4.4  | Multi-violation reporting (short-circuit: false by default) | UX improvement                                      |
| —    | Extension framework / plugin marketplace                    | Cognigy gap                                         |
| —    | Built-in voice testing in IDE                               | Cognigy gap                                         |

---

## Tracking

| Sprint                                  | Items | Status      |
| --------------------------------------- | ----- | ----------- |
| Sprint 5 — Critical Hotfixes            | 6     | Not Started |
| Sprint 6 — ON_ERROR & Guardrails        | 8     | Not Started |
| Sprint 7 — Memory, Constraints & Safety | 6     | Not Started |
| Sprint 8 — Spec, Docs & Compiler        | 12    | Not Started |
| Backlog — P1 Features                   | 3     | Not Started |
| Backlog — P2 Features                   | 6     | Not Started |
| Backlog — P3 Features                   | 5     | Not Started |
