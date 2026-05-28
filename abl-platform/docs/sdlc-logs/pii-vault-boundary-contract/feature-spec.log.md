# Feature Spec Phase Log — PII Vault Boundary Contract

**Ticket**: ABLP-535
**Date**: 2026-05-19
**Branch**: `discuss/guardrails-pii-consolidation`

---

## Clarifying Questions & Decision Protocol

### Scope & Problem

| #   | Question                                                                        | Classification | Answer                                                                                                                                                                                                                                                                                      |
| --- | ------------------------------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | What is the root cause — one architectural defect or multiple independent bugs? | ANSWERED       | One defect: `resolveRenderMode('tools')` hardcodes `'redacted'`, the `pii_access` enum lacks `'original'`, and the UI mislabels `'tools'` as "Original". All stem from a missing "plaintext for tools" consumer mode. Source: `pii-vault.ts:477`, `schema.ts:1003`, `ToolsSection.tsx:531`. |
| Q2  | Is this pre-launch (no migration debt)?                                         | ANSWERED       | Yes — user's task description states "Pre-launch: no production agents to migrate. Free to change defaults without legacy compat shims."                                                                                                                                                    |
| Q3  | Should the fix include the RBAC sub-issue on `pii-patterns.ts:116`?             | DECIDED        | Yes — include it. The route uses `requirePermission` (tenant-level) instead of `requireProjectPermission` (project-level). This blocks QA from verifying PII pattern changes in project-scoped context. Small fix, high value.                                                              |
| Q4  | Should the Tool Test UI parity issue be included?                               | DECIDED        | Yes — the Studio Tool Test UI currently bypasses PII processing entirely. This divergence means testing tools in Studio gives different results from live execution. Include a unified `applyPIIBoundary()` helper.                                                                         |
| Q5  | Should the workflow engine path (`flow-step-executor.ts`) be touched?           | ANSWERED       | No — per task description, it's out of scope. Uses `restorePIITokensForTrustedInternalExecution → vault.detokenize()` and works correctly. Document the divergence in the feature spec.                                                                                                     |

### User Stories & Requirements

| #   | Question                                                         | Classification | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --- | ---------------------------------------------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q6  | Who are the primary personas?                                    | INFERRED       | AI Engineer (configures tool PII access), Compliance Lead (audits plaintext dispense), Project Owner (reviews agent behavior). Based on the parent feature's persona model in `guardrails-sensitive-data-block.md`.                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Q7  | What are the critical user journeys?                             | ANSWERED       | Per ABLP-535 evidence: (1) Configure tool to receive original PII → tool actually gets plaintext, (2) Configure tool to receive redacted → tool gets `[REDACTED_*]`, (3) User UI shows masked original (not masked UUID), (4) Audit log records every plaintext dispense.                                                                                                                                                                                                                                                                                                                                                                                         |
| Q8  | What is the bare-UUID false positive boundary?                   | DECIDED        | Lookup is exact-match against the current session's vault entries only. Non-matches pass through unchanged. A UUID that happens to look like a PII token ID but belongs to a different session or is a legitimate document ID must NOT be matched. This is a security boundary: cross-session UUID matching would be an info-leakage vector.                                                                                                                                                                                                                                                                                                                      |
| Q9  | Should user-render path also handle bare UUIDs?                  | DECIDED        | No. The bare-UUID restoration is limited to the tool boundary path. Rationale: (1) the user-render path already handles the `{{PII:...}}` wrapper case correctly, (2) if the LLM strips the wrapper in its response text, the user seeing a UUID is a lesser problem than the tool receiving garbage, (3) adding bare-UUID scanning to user-render would add latency to every response and risk false positives on legitimate UUIDs in response text. The LLM-side tokenization (`renderTextForLLMWithPIIRedaction`) forces the token format, so the LLM SHOULD echo it. If it doesn't, the tool path handles restoration; the user path accepts the degradation. |
| Q10 | What is the audit log shape for `'original'` plaintext dispense? | DECIDED        | New trace event type `pii_plaintext_dispensed` in the trace event registry. Fields: `tenantId`, `projectId`, `sessionId`, `toolName`, `entityType`, `entityHash` (SHA-256 of original, NOT the raw value), `agentId`, `piiAccess` (always `'original'`). Also logged through the existing `PIIAuditLogger` Kafka→ClickHouse pipeline.                                                                                                                                                                                                                                                                                                                             |

### Technical & Architecture

| #   | Question                                          | Classification | Answer                                                                                                                                                                                                                                                                                                                                                                                                |
| --- | ------------------------------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q11 | What packages are affected?                       | ANSWERED       | `packages/compiler` (vault, schema), `packages/shared-kernel` (trace event registry), `packages/i18n` (labels), `apps/runtime` (tool execution, audit, routes), `apps/studio` (UI components).                                                                                                                                                                                                        |
| Q12 | What data models change?                          | ANSWERED       | (1) `pii_access` enum in IR schema adds `'original'`. (2) No new MongoDB collections. (3) New trace event type in registry. (4) `PIIAuditEntry` shape is already sufficient — `consumer: 'original'` plus `metadata: { toolName }` covers the audit.                                                                                                                                                  |
| Q13 | Performance constraint for bare-UUID restoration? | ANSWERED       | Per task description: "tool-arg restoration is hot-path. No DB round-trip per tool arg. Vault lookups must be in-memory / Redis (sub-ms)." The vault is already in-memory (`Map<string, PIIToken>`). Bare-UUID lookup is an additional `store.get(uuid)` per candidate UUID — O(1) per UUID.                                                                                                          |
| Q14 | How does the Tool Test UI get PII context?        | INFERRED       | The `internal-tools.ts` route needs to accept optional PII pattern configs and create a temporary vault context. Since Tool Test is a dry-run, the vault would be session-scoped to the request. The request body can include `piiPatternConfigs` from the project settings, and the route creates a `PIIVault` instance, tokenizes the input params, then renders for the tool's `pii_access` level. |

### Critical Feature Gate (auth/isolation/compliance)

| #   | Question                            | Classification | Answer                                                                                                                                                                                                                                                                                                                                          |
| --- | ----------------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q15 | Is a threat-model summary required? | ANSWERED       | Yes — this is a privacy/compliance feature. The primary threat is unauthorized plaintext dispense: a misconfigured `pii_access: 'original'` could expose PII to a tool that doesn't need it. Mitigations: (1) default remains `'tools'` (redacted), (2) `'original'` requires explicit opt-in, (3) every `'original'` dispense is audit-logged. |
| Q16 | What is the fail-closed behavior?   | DECIDED        | If `resolveRenderMode` receives an unrecognized consumer, it returns `'redacted'` (already the case at `pii-vault.ts:490`). If `pii_access` enum validation fails, normalize to `'tools'` (already the case at `pii-tool-execution.ts:10-12`). The system never fails-open to plaintext.                                                        |
| Q17 | What is the rollout shape?          | ANSWERED       | Pre-launch, so direct deployment. No `audit`/`warn`/`enforce` modes needed. The change is backwards-compatible: existing agents with `pii_access: 'tools'` continue to get `'redacted'` (same behavior). Only agents explicitly configured with `pii_access: 'original'` get plaintext.                                                         |

---

## Review Rounds

### Round 1 — Completeness & Quality

**Checklist**:

- [x] All 18 TEMPLATE.md sections addressed
- [x] 5 user stories (minimum 3)
- [x] 9 functional requirements (minimum 4, all testable)
- [x] Integration matrix references 3 related features (minimum 2)
- [x] Non-functional concerns address tenant/project/user/session isolation
- [x] Critical-feature gate satisfied: terminology table, fail-closed behavior, threat model, rollout shape
- [x] Delivery plan has 6 parent tasks with numbered subtasks
- [x] Open questions: 3 items
- [x] Claims grounded in code evidence (file:line references throughout)
- [x] Characterization artifact referenced in References section

**Result**: No blocking findings.

### Round 2 — Cross-Phase Consistency

- [x] FR numbering consistent (FR-1 through FR-9), all referenced in test matrix
- [x] Scope boundaries aligned with 6 non-goals
- [x] User stories map to FRs: US1→FR-1,2,5; US2→FR-5; US3→FR-7; US4→FR-6; US5→FR-4
- [x] All 9 implementation files verified to exist at stated paths
- [x] Characterization artifact referenced and consistent

**Result**: No blocking findings.

### Round 3 — Platform Audit

- [x] No invariant violations: tenant-scoped queries, cross-scope 404, centralized auth
- [x] No reinvention: uses existing PIIAuditLogger, PIIPatternConfig, renderForConsumer, TraceEvent
- [x] Isolation model correct: session-level vault, bare-UUID confined to session
- [x] Native `<select>` fix called out in spec (pre-existing violation corrected)

**Result**: No blocking findings.

### Round 4 — Industry Research Expert Audit

- [x] HIPAA Safe Harbor: tokenization = de-identification, `'original'` = authorized re-identification with audit
- [x] GDPR Art. 4(5): tokenization = pseudonymization, `'original'` = authorized de-pseudonymization with logging
- [x] PCI DSS v4.0: credit card tokenization aligned
- [x] Audit logging best practice: entity hash, never raw value

**Result**: No blocking findings.

### Round 5 — OSS Library Audit

- [x] No new external libraries needed
- [x] SHA-256 via Node.js crypto (built-in)
- [x] UUID regex uses standard RFC 4122 pattern
- [x] All functionality implemented with existing platform infrastructure

**Result**: No blocking findings.

---

## Files Created

- `docs/sdlc-logs/pii-vault-boundary-contract/characterization.md`
- `docs/sdlc-logs/pii-vault-boundary-contract/feature-spec.log.md` (this file)
- `docs/features/sub-features/pii-vault-boundary-contract.md`
- `docs/testing/sub-features/pii-vault-boundary-contract.md`
- Updated: `docs/features/sub-features/README.md`
- Updated: `docs/testing/sub-features/README.md`

---

## Phase Handoff Packet

**Phase**: Feature Spec
**Status**: READY_FOR_NEXT_PHASE

**Objective**:

- Define the PII vault boundary contract bug (ABLP-535 consolidation) and its 6 manifestations
- Establish 9 functional requirements covering schema, vault, runtime, UI, audit, and RBAC fixes

**Scope**:

- `pii_access` enum expansion with `'original'`
- `resolveRenderMode()` fix + bare-UUID restoration
- Audit logging on every plaintext dispense
- Studio UI label parity + native `<select>` → design-system `<Select>`
- Tool Test UI PII parity
- `pii-patterns` RBAC project-scope fix

**Evidence Files**:

- `docs/features/sub-features/pii-vault-boundary-contract.md`
- `docs/testing/sub-features/pii-vault-boundary-contract.md`
- `docs/sdlc-logs/pii-vault-boundary-contract/characterization.md`

**Key Decisions**:

- [DECIDED] Include RBAC sub-issue (pii-patterns route) in scope — small fix, blocks QA
- [DECIDED] Include Tool Test UI parity — divergent behavior is a testing integrity concern
- [DECIDED] Bare-UUID restoration scoped to tool path only, not user-render path
- [DECIDED] No bare-UUID cross-session matching (info-leakage prevention)
- [DECIDED] Audit log uses entity hash (SHA-256), never raw value
- [ANSWERED] Workflow engine path (`flow-step-executor.ts`) out of scope — works correctly

**Open Ambiguities**:

- None remaining — all escalatable questions resolved through DECIDED classification

**Invariants**:

- `'tools'` default remains `'redacted'` (secure default, never plaintext)
- `'llm'` forced to `'tokenized'` (security baseline, no opt-out)
- Unrecognized values normalize to `'tools'`, never to `'original'`
- Every `'original'` dispense emits audit trace event + PIIAuditLogger entry

**Next-Phase Obligations**:

- Test Spec must cover all 9 FRs with minimum 5 E2E + 5 integration scenarios
- Test Spec must include negative-path scenarios (cross-session isolation, false-positive UUIDs)
- Test Spec must address the Critical Feature Gate test requirements (fail-closed, threat-model abuse paths)
