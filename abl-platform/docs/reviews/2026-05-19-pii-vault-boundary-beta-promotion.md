# PII Vault — Design Review: Audit Precision & Tool Test Parity

**Date:** 2026-05-19
**JIRA tickets covered:** ABLP-535 (umbrella), ABLP-673, plus internal audit findings
**Author:** Platform engineering (ABL)
**Audience:** Product managers, technical architects, security architects, platform leads
**What we need from you:** Sign-off (or revisions) on two design proposals — **R1** (audit precision) and **R2** (Tool Test parity). See §8 for the decision matrix.

---

## Where to read the code

All changes referenced in this document live on the working branch — **they are not yet on `develop`**. To inspect the code:

- **Branch:** https://bitbucket.org/koreteam1/abl-platform/branch/guardrails-pii-consolidation
- **Commit history:** https://bitbucket.org/koreteam1/abl-platform/commits/branch/guardrails-pii-consolidation
- **Key commits referenced below:**
  - `d18b0a182` — main production fix → https://bitbucket.org/koreteam1/abl-platform/commits/d18b0a182
  - `b692bd2e8` — unit + integration + initial E2E tests → https://bitbucket.org/koreteam1/abl-platform/commits/b692bd2e8
  - `d2a51578b` — additional live-LLM E2E tests → https://bitbucket.org/koreteam1/abl-platform/commits/d2a51578b
  - `a65f9a43b` — mock LLM extended with dynamic tool-call synthesis → https://bitbucket.org/koreteam1/abl-platform/commits/a65f9a43b
  - `fa50040e6` — RBAC route guard for PII pattern routes → https://bitbucket.org/koreteam1/abl-platform/commits/fa50040e6

JIRA links:

- ABLP-535: https://koreteam.atlassian.net/browse/ABLP-535
- ABLP-673: https://koreteam.atlassian.net/browse/ABLP-673

---

## TL;DR

ABLP-535 fixed a serious bug: when a user said something like "my SSN is 123-45-6789" in chat, the runtime was dispatching the wrong value to downstream tools — sometimes a random UUID, sometimes a literal `[REDACTED_SSN]` string, sometimes the raw SSN — depending on a misconfigured rendering path. The fix is shipped on the branch above, with **60 automated tests passing** (24 unit, 21 integration, 15 E2E) and clean external code review.

Two refinements remain. We are asking for your design opinion on both:

1. **Audit precision (R1)** — Every time a tool receives plaintext PII, we emit an audit event. Today the audit log over-reports: it records every PII value in the session, not just the ones the tool actually saw. This is safe but noisy and creates problems for compliance teams answering "what PII did tool X see?" questions.
2. **Tool Test parity (R2)** — The Studio developer "Tool Test" feature applies PII rendering only to flat parameters. If a developer pastes a nested JSON payload containing PII, it bypasses the policy gate. The live execution path does not have this gap.

Neither is an active leak today (no production agents exist yet — we are pre-launch). Both should be closed before we open the feature for general use.

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Background — What ABLP-535 Fixed](#2-background--what-ablp-535-fixed)
3. [R1 — Audit Emission Precision](#3-r1--audit-emission-precision)
4. [R2 — Tool Test Nested-Object Parity](#4-r2--tool-test-nested-object-parity)
5. [Verification — How We Know the Existing Fix Works](#5-verification--how-we-know-the-existing-fix-works)
6. [Cross-Cutting Considerations](#6-cross-cutting-considerations)
7. [Proposed Rollout](#7-proposed-rollout)
8. [Decision Matrix](#8-decision-matrix)
9. [References](#9-references)

---

## 1. Executive Summary

### What is the PII vault?

The PII vault is a session-scoped, in-memory store. When a user says "my SSN is 123-45-6789", the runtime detects "123-45-6789" as an SSN, replaces it in the message with a token like `{{PII:ssn:abc-123}}`, and stores the original value in the vault keyed by `abc-123`. Downstream consumers (the LLM prompt, tool calls, user-visible response, audit log) each ask the vault to render the token according to **their own policy**: redacted for the LLM, plaintext for a tool that needs it, masked for the user-facing reply, hashed for the audit log.

The whole purpose of the vault is to let a sensitive value flow through a system without ever exposing it to a consumer that should not see it.

### What was the bug?

The vault was ignoring the consumer argument. Every consumer got the same rendering, regardless of policy. This caused five visible failures in QA across ABLP-535, ABLP-673, and our internal audits:

| #   | Reported behavior                                                                                           | Should have been                                  |
| --- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| 1   | Tool received a random UUID instead of the SSN                                                              | Plaintext SSN (if the tool was configured for it) |
| 2   | User saw their own SSN unmasked in the agent reply                                                          | Masked: `***-**-6789`                             |
| 3   | Tool received the literal string `{{PII:ssn:abc-123}}` (no value, just the token wrapper)                   | Plaintext or redacted, per the tool's config      |
| 4   | Tool received the literal string `[REDACTED_SSN]` when it had been configured to receive the original value | Plaintext SSN                                     |
| 5   | After a workflow paused and resumed, the vault was empty and tokens never resolved                          | Vault restored                                    |

All five turned out to be symptoms of one architectural defect: the vault hard-coded its rendering mode. The fix (commit `d18b0a182`) wires the rendering through the configured policy at every consumer boundary.

### What still needs your input?

Two refinements that came out of internal code review:

- **R1 (MEDIUM)** — When a tool receives plaintext PII, we log an audit event for compliance. The current implementation logs an event for every value currently in the vault, not just the values the tool actually saw. We need your read on whether the cleaner "log only what was dispensed" approach is acceptable to compliance/security stakeholders.
- **R2 (LOW)** — The Studio Tool Test UI only applies PII rendering to top-level string parameters. Nested structures are passed through unfiltered. We propose extending the rendering to nested objects. Low-impact today (developer-facing surface only), but we want explicit sign-off because it touches the PII boundary contract.

---

## 2. Background — What ABLP-535 Fixed

### 2.1 The original behaviour, by example

Suppose a customer support agent is configured with two tools:

- `lookup_account_by_ssn(ssn: string)` — needs the **real SSN** to query the customer database.
- `notify_supervisor(summary: string)` — sends a Slack message; should **not** see plaintext PII.

A user types: `"Hi, my SSN is 123-45-6789, I can't log in."`

The runtime should:

| Boundary                                 | What the consumer receives                                                                        |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------- |
| LLM prompt                               | `"Hi, my SSN is {{PII:ssn:abc-123}}, I can't log in."` (tokenized — LLM should not see plaintext) |
| `lookup_account_by_ssn` tool             | `"123-45-6789"` (plaintext, because this tool is explicitly configured to receive it)             |
| `notify_supervisor` tool                 | `"[REDACTED_SSN]"` (redacted — no plaintext for unconfigured tools)                               |
| User-facing reply (echoing back the SSN) | `"…your SSN ***-**-6789…"` (masked)                                                               |
| Audit log entry for the lookup tool      | SHA-256 hash of "123-45-6789" + metadata (no plaintext in logs)                                   |

Before the fix, **every consumer got the same rendering** because the vault ignored its consumer argument. So depending on which fixed rendering the vault happened to apply, one of the five symptoms in §1 surfaced.

### 2.2 The fix at a glance

- **Vault is now consumer-aware.** `renderForConsumer(text, consumer, patternConfigs)` looks up the configured rendering for that consumer + PII type and applies it. Five rendering modes are supported: `original` (plaintext), `masked`, `redacted`, `tokenized`, `random`.
- **New explicit opt-in `'original'`.** Previously the only way for a tool to receive plaintext was a confusing UI label. We made it explicit: tools default to `'redacted'`; developers must opt into `'original'` per-tool.
- **Bare-UUID rescue.** Some LLMs occasionally strip the `{{PII:type:UUID}}` wrapper from tokens when emitting tool calls, leaving only the bare UUID. The vault now detects bare UUIDs that match its store and re-renders them. Scoped to the current session only — no cross-session lookup, no risk of leaking value A into session B.
- **Audit trail on plaintext dispense.** Every time a tool receives plaintext PII (`pii_access: 'original'`), we emit a `pii_plaintext_dispensed` audit trace event. The event includes tenant, project, session, tool name, PII type, and a SHA-256 **hash** of the value (never the plaintext itself). This aligns with HIPAA Safe Harbor and GDPR pseudonymization guidance.
- **Tool Test UI parity.** The Studio "Tool Test" feature now applies the same tokenization + rendering pipeline as live execution, so developers see realistic behavior.
- **UI labels corrected.** The misleading "Original" label in the agent editor's tool config dropdown was renamed; "Redacted" is now the default visible value.

### 2.3 Verification already completed

- **60 automated tests passing** on the branch: 24 unit, 21 integration, 15 E2E (HTTP-only, real Express server, no platform mocks). See §5 for the breakdown.
- **5-round internal code review** found 2 lower-severity findings (the R1 and R2 items in this document). No critical or high issues.
- **2-round data-flow audit** (a structured trace of every PII value through every boundary in the system) found zero leak paths.

---

## 3. R1 — Audit Emission Precision

### 3.1 Concrete scenario

Imagine a 20-minute customer call where a single chatbot session has detected and tokenized three pieces of PII along the way:

| Token   | Value (vault contents) | Type  |
| ------- | ---------------------- | ----- |
| `tok-1` | `alice@example.com`    | email |
| `tok-2` | `+1-555-867-5309`      | phone |
| `tok-3` | `123-45-6789`          | ssn   |

Now the agent calls a tool, `lookup_account_by_ssn`, configured with `pii_access: 'original'`. The tool needs only the SSN. The LLM correctly passes `tok-3` as the argument; the runtime resolves it to `"123-45-6789"`; the tool runs.

**What the audit log should record:** ONE event — "tool `lookup_account_by_ssn` saw plaintext of an SSN (hash: …) at time T."

**What the audit log records today:** THREE events — one for the email, one for the phone, one for the SSN — because the audit emitter iterates the **entire vault**, not the tokens actually dispensed.

### 3.2 Why this matters

Three downstream impacts:

1. **Forensic ambiguity.** If a security analyst is investigating "what plaintext PII did tool X see during this session?", today they have to cross-reference the audit log against the tool-call payload to figure out which of the N reported tokens was actually rendered. This is solvable but slow, and it costs analyst time per investigation.
2. **DSAR (Data Subject Access Request) noise.** When a customer asks "which tools have seen my SSN in plaintext?", today's audit log will name tools that **never actually saw the SSN** but happened to fire while the SSN was sitting in the vault. The current behavior is a false positive in the audit trail.
3. **Volume inflation.** For long sessions with many PII tokens, every `'original'` tool call emits one event per vault token. For agents with frequent tool calls this can multiply audit volume 5–10×.

**What the current behavior gets right** — and why we shipped it as-is: it **over-reports**, not **under-reports**. From a compliance standpoint, falsely _including_ a tool in the audit log is far safer than falsely _excluding_ one. We chose the safe failure mode and tabled the precision question for design review.

### 3.3 What we propose (Option A — recommended)

Extend the vault's render API so the executor can ask: "render this text for this consumer, _and tell me which tokens you actually substituted_". The audit emitter then iterates only the returned set.

API sketch:

```ts
// Today
renderForConsumer(text, consumer, patternConfigs): string

// Proposed (sibling method, backward-compatible)
renderForConsumerWithTrace(text, consumer, patternConfigs): {
  text: string;
  renderedTokens: PIIToken[];  // exactly the tokens that were substituted
}
```

The reasoning executor changes from "list every vault token" to "iterate `result.renderedTokens`". The audit event shape is **unchanged** — only the _count_ of events changes. Downstream consumers of the audit log need no schema update.

### 3.4 Alternatives considered

- **Option B — post-render substring scan.** After rendering, search the rendered text for each vault token's plaintext. _Rejected_ — O(N×M) per dispatch, fragile to false positives when a token's plaintext happens to be a common substring (e.g., a postcode pattern coincidentally appearing in unrelated text).
- **Option C — tag tool args with token IDs at tokenize time.** _Rejected_ — requires a side-channel that travels through the prompt → LLM → tool-call extraction pipeline; the LLM does not preserve our side-channel; high implementation cost for marginal benefit over Option A.

### 3.5 Questions for reviewers

1. **Compliance / security architect:** Are you comfortable moving from "over-report" to "precise-report" given the boundary tests we'll add? Or do you want over-reporting kept as a defense-in-depth posture?
2. **Audit log consumers (SOC, DSAR tooling):** Does anything in your pipeline depend on the current over-emission (e.g., inferring vault size from event count)? If so, we need to know before changing the semantics.
3. **Engineering:** Acceptable trade-off — small additional allocation per render call in exchange for precise audit — or would you prefer a separate "tracing" decorator instead of an API change?

---

## 4. R2 — Tool Test Nested-Object Parity

### 4.1 Concrete scenario

The "Tool Test" feature in Studio lets a developer manually fire a tool with hand-typed JSON. A developer is debugging an HTTP tool with this test payload:

```json
{
  "customer": {
    "email": "alice@example.com",
    "ssn": "123-45-6789"
  },
  "items": ["P1234", "P5678"]
}
```

The same tool, when called by a live agent during a real conversation, would have its parameters tokenized through the vault before being dispatched. The tool actually receives `{{PII:email:…}}` or `[REDACTED_EMAIL]` (depending on its `pii_access` config), **not** the raw `"alice@example.com"`.

**What happens in live execution:** Both `customer.email` and `customer.ssn` are tokenized → vault → rendered per the tool's policy. ✅
**What happens in Tool Test today:** Only top-level string parameters are tokenized. Because `customer` is a nested object, **its `email` and `ssn` fields pass through as plaintext** regardless of the tool's `pii_access` config. ❌

### 4.2 Why this matters (and what mitigates it)

**Aggravating factors:**

- If a developer pastes a captured production payload into Tool Test for reproduction purposes — a common debugging pattern — the realistic PII inside it bypasses the policy gate.
- If, in the future, Tool Test is reused for a customer-facing "try this agent" sandbox, the gap becomes a real leak path.

**Mitigating factors (why this is LOW, not MEDIUM):**

- Tool Test inputs come from an authenticated developer typing into a Studio UI inside their own project. They are not arbitrary end-user input.
- The developer is effectively the data controller for their own test inputs.
- There is no audit-log promise on Tool Test today — it's not a production data plane.

### 4.3 What we propose (Option A — recommended)

Replace the flat parameter loop with a recursive walk that tokenizes every string leaf in the payload, descending into nested objects and arrays. Non-string scalars (numbers, booleans, null) are not tokenized — PII detection regexes assume string input.

The rendering side (`restorePIITokensForToolExecution`) already handles nested objects correctly — verified by existing integration tests. Only the tokenization side needs the fix.

### 4.4 Alternatives considered

- **Option B — serialize → tokenize → parse back.** _Rejected_ — fragile across JSON escape boundaries, could falsely tokenize key names that look like PII, lossy on type fidelity.
- **Option C — warn the developer and refuse to apply PII rendering on nested payloads.** _Rejected_ — punts the problem to the developer; produces inconsistent behavior between Tool Test and live execution.

### 4.5 Questions for reviewers

1. **Product:** Is the "Tool Test" feature expected to be used with real production payloads? If yes, this should be FIXED not deferred. If no (developer-only test data), the current behavior is acceptable but we should still close the gap for hygiene.
2. **Security architect:** Are there any scenarios in which we'd want Tool Test to _intentionally_ skip PII rendering (e.g., a developer specifically wants to verify that a downstream system fails when it sees plaintext)? If so, we need an explicit opt-out switch in the UI.
3. **Technical architect:** Should this same recursive walk be applied at any _other_ PII boundary we may have missed (e.g., direct-API callers of the runtime that don't go through chat)?

---

## 5. Verification — How We Know the Existing Fix Works

### 5.1 Test inventory (already on the branch)

| Layer                                  | File                                     | Count                      | What it exercises                                                                                                                                                    |
| -------------------------------------- | ---------------------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit                                   | `pii-vault-boundary.test.ts`             | 24                         | Rendering-mode resolution, bare-UUID restoration + false-positive resistance, per-pattern overrides                                                                  |
| Integration                            | `pii-vault-boundary.integration.test.ts` | 21                         | `restorePIITokensForToolExecution` across every access level, cross-session vault isolation, nested objects and arrays                                               |
| E2E (early)                            | `pii-vault-boundary.e2e.test.ts`         | 6                          | HTTP-only: input tokenization, output masking, cross-tenant 404, cross-session isolation, RBAC                                                                       |
| E2E (recently added)                   | same file (extended)                     | 3                          | Full live-LLM round-trip including tool-call dispatch — E2E-1 (`pii_access: 'original'` + audit event), E2E-2 (default redacted path), E2E-3 (bare-UUID restoration) |
| E2E (existing PII suites — unaffected) | various                                  | 6                          | Pre-existing PII redaction tests confirmed passing                                                                                                                   |
| **Total**                              |                                          | **60 passing / 0 failing** |                                                                                                                                                                      |

### 5.2 What the E2E layer specifically proves

We extended our mock LLM with **dynamic tool-call synthesis** — at the moment the runtime calls the mock LLM, it inspects the prompt the runtime sent, extracts the PII tokens from it via regex, and synthesizes a tool-call response echoing those tokens back. This lets us test the full round-trip:

1. User sends plaintext PII via HTTP.
2. Runtime tokenizes; mock LLM receives **tokens, not plaintext** — asserted.
3. Mock LLM emits a tool call with the token (or with a bare UUID, for the restoration test) as the argument.
4. Runtime renders the token per the tool's `pii_access` and dispatches.
5. Tool receives the correctly-rendered value — asserted.
6. Audit event emitted (or not, per policy) — asserted.
7. User-facing response masks PII — asserted.

This is the closest we can get to a real production trace without standing up a real LLM provider in CI.

### 5.3 Code review and audit history

- **5 rounds of code review** on the production fix (Correctness, API & Data, Platform Compliance, Error Handling, Production Readiness) — log: `docs/sdlc-logs/pii-vault-boundary-contract/pr-review.log.md`
- **2 rounds of data-flow audit** (a 9-dimension trace of every PII value through every boundary) — zero leak paths — log: `docs/sdlc-logs/pii-vault-boundary-contract/data-flow-audit.md`
- **2 rounds of light code review** on the additional E2E tests — no findings beyond one unused-import cleanup

---

## 6. Cross-Cutting Considerations

### 6.1 Compliance posture

- **HIPAA Safe Harbor / GDPR pseudonymization.** The audit log records a SHA-256 hash of dispensed values, never the plaintext. R1 improves the _precision_ of that log without weakening the contract.
- **Right to erasure (DSAR).** R1 directly improves DSAR response quality by removing false-positive tool entries from "where did my PII go?" reports.
- **Auditor expectations.** External auditors generally accept conservative over-reporting but push back on under-reporting. We need explicit sign-off (§3.5 Q1) before swapping the failure mode.

### 6.2 Performance impact

- **R1**: adds one `Set<string>` allocation per render call. Negligible. Net effect on the audit log is _fewer_ events emitted, _fewer_ SHA-256 hashes computed, _fewer_ audit-logger calls — a small performance **win**.
- **R2**: recursive walk over Tool Test payloads. Tool Test is not a hot path (one developer at a time, manually). Linear in payload size, with cycle protection.
- **Existing production fix (already shipped)**: vault operations are O(1) `Map` lookups, regex-based rendering is one pass per dispatch, no synchronous I/O introduced. No measurable hot-path impact.

### 6.3 Backwards compatibility

We are **pre-launch** — no production agents are live, no compatibility shims needed. Both R1 and R2 can land additively.

---

## 7. Proposed Rollout

If R1 and R2 are approved as proposed:

1. **One design-doc delta** appended to the existing low-level design at `docs/specs/pii-vault-boundary-contract.lld.md` covering R1 and R2. No new feature spec or HLD required (scope is fully inside the existing feature).
2. **Two implementation commits**:
   - `[ABLP-535] refactor(compiler): track rendered tokens for audit precision` (R1)
   - `[ABLP-535] fix(runtime): tokenize nested-object string leaves in Tool Test path` (R2)
3. **Verification** — pr-reviewer (5 rounds, standard), data-flow audit (2 rounds, mandatory because R1 touches a PII boundary), additional boundary tests for both items.
4. **Doc sync** — update feature status, audit logs.
5. **Merge back to `develop`** when stakeholder approvals are in.

**Estimate:** 3–4 engineering days plus 1 day of review/audit cycles.

---

## 8. Decision Matrix

For each item, please indicate **APPROVE / REVISE / REJECT** with rationale.

| Item                                                    | Approve as proposed? | Revisions requested |
| ------------------------------------------------------- | -------------------- | ------------------- |
| R1 — Audit precision (track rendered tokens)            |                      |                     |
| R2 — Tool Test nested-object tokenization               |                      |                     |
| Proposed rollout (single design-doc delta, two commits) |                      |                     |
| Audit posture change (over-report → precise-report)     |                      |                     |

### Specific questions

| Stakeholder            | Question                                                                                                                                                                                                     |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Product                | Is "Tool Test" expected to be used with real production payloads? Are there customer use cases that would benefit from `'original'` plaintext access landing in MCP / connector tools (not just HTTP tools)? |
| Security architect     | Is moving from over-reporting → precise-reporting acceptable, given the boundary tests we'll add? Any external audit obligations that prefer conservative over-reporting?                                    |
| Technical architect    | Is the proposed sibling method `renderForConsumerWithTrace` the right shape, or would you prefer a separate render-tracer decorator? Any other PII boundaries we may have missed?                            |
| Engineering leadership | Should our extended mock-LLM harness (dynamic tool-call synthesis) be generalized for reuse across the broader PII / guardrails test suite, or kept as a one-off?                                            |

---

## 9. References

### Documents in the repo

- **Feature spec:** `docs/features/sub-features/pii-vault-boundary-contract.md`
- **Test spec:** `docs/testing/sub-features/pii-vault-boundary-contract.md`
- **High-level design:** `docs/specs/pii-vault-boundary-contract.hld.md`
- **Low-level design:** `docs/specs/pii-vault-boundary-contract.lld.md`
- **Code-review log:** `docs/sdlc-logs/pii-vault-boundary-contract/pr-review.log.md`
- **Data-flow audit log:** `docs/sdlc-logs/pii-vault-boundary-contract/data-flow-audit.md`
- **Post-implementation sync log:** `docs/sdlc-logs/pii-vault-boundary-contract/post-impl-sync.log.md`

### Key code locations

| Concern                                   | File                                                            | Approx. line |
| ----------------------------------------- | --------------------------------------------------------------- | ------------ |
| Vault render entry point                  | `packages/compiler/src/platform/security/pii-vault.ts`          | 187          |
| Bare-UUID restoration                     | `packages/compiler/src/platform/security/pii-vault.ts`          | 253          |
| Audit event emission (R1 location)        | `apps/runtime/src/services/execution/reasoning-executor.ts`     | 5040         |
| Tool Test tokenization (R2 location)      | `apps/runtime/src/routes/internal-tools.ts`                     | 488          |
| Trace registry event entry                | `packages/shared-kernel/src/constants/trace-event-registry.ts`  | 298          |
| Live-LLM E2E tests                        | `apps/runtime/src/__tests__/e2e/pii-vault-boundary.e2e.test.ts` | —            |
| Mock LLM with dynamic tool-call synthesis | `tools/agents/e2e-functional/mock-llm-server.ts`                | —            |

### External tickets

- **ABLP-535**: https://koreteam.atlassian.net/browse/ABLP-535 — "PII Redaction Failure in Agent Runtime"
- **ABLP-673**: https://koreteam.atlassian.net/browse/ABLP-673 — bare-UUID dispatch report
