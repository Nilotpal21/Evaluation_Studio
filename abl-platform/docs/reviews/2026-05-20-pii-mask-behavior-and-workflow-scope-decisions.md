# PII Mask Behavior & Workflow Engine Scope — Decision Document for PMs

**Date:** 2026-05-20
**JIRA:** ABLP-535 (umbrella) — surfaced during BETA-promotion meta-review
**Author:** Platform engineering (ABL)
**Audience:** Product managers (primary), security architects, compliance leads
**What we need from you:** Two product decisions:

1. **F-6:** How should PII be masked in user-facing surfaces — full mask, partial reveal (last 4), or configurable per-deployment?
2. **F-7:** Should the workflow engine participate in the PII vault contract, or be explicitly out-of-scope?

Both decisions are blockers for the ABLP-535 ALPHA → BETA promotion and have downstream impact on customer trust, compliance posture, and engineering effort.

---

## Where to read the related code

- **Branch:** `guardrails-pii-consolidation`
- **Bitbucket:** https://bitbucket.org/koreteam1/abl-platform/branch/guardrails-pii-consolidation
- **Related design doc:** `docs/reviews/2026-05-19-pii-vault-boundary-beta-promotion.md`

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Decision 1 — PII Mask Behavior (F-6)](#2-decision-1--pii-mask-behavior-f-6)
   - 2.1 Background: What ABLP-535 Built
   - 2.2 The Doc-vs-Code Discrepancy
   - 2.3 How Other Products Handle This
   - 2.4 Why "One Mask Fits All" Doesn't Work
   - 2.5 Proposed Design
   - 2.6 UI Sketch
   - 2.7 Migration & Defaults
3. [Decision 2 — Workflow Engine Scope (F-7)](#3-decision-2--workflow-engine-scope-f-7)
   - 3.1 Background: How the Workflow Engine Touches PII Today
   - 3.2 The Silent Bypass Problem
   - 3.3 Four Options
   - 3.4 Recommendation
4. [Combined Decision Matrix](#4-combined-decision-matrix)
5. [References](#5-references)

---

## 1. Executive Summary

### Decision 1 — PII Mask Behavior

**Today:** When the agent echoes a user's SSN back to them (e.g., "I'll look up the account for SSN **\*-**-\***\*"), the platform fully masks every character. The design review document, however, claimed users would see the **last 4 digits** (`\***-\*\*-6789`). This is doc-vs-code drift — we need to pick one.

**Recommendation:** Add a per-pattern UI option in Studio (under PII Pattern config) that lets the developer choose between three preset mask styles:

- **Full mask** (`***-**-****`) — most conservative, current default
- **Last-N visible** (`***-**-6789`) — industry standard for verification flows
- **First-N visible** (`alice***@example.com`) — for emails

Defaults should be conservative (full mask) per pattern, with developers opting into partial reveal **per use case**.

### Decision 2 — Workflow Engine Scope

**Today:** When the workflow engine invokes a tool, it bypasses the PII vault entirely — the tool receives whatever raw data the workflow has. There is no documentation flagging this, and no warning when PII passes through.

**Recommendation:** Explicit two-step approach:

1. **Short term (this release):** Add a clear comment + feature-spec disclaimer that the workflow engine is out-of-scope. Land a runtime warning when known-PII patterns are detected in workflow tool params (observability without behavior change).
2. **Medium term (next major release):** Introduce workflow-level PII policy declaration (workflows declare PII inputs; tool dispatch renders per `pii_access`). This is a deliberate roadmap item, not an emergency fix.

---

## 2. Decision 1 — PII Mask Behavior (F-6)

### 2.1 Background: What ABLP-535 Built

The PII vault has five render modes, picked per consumer (tool, LLM, user, logs, audit):

- `original` — plaintext
- `tokenized` — `{{PII:ssn:abc-123}}`
- `redacted` — `[REDACTED_SSN]`
- `masked` — partial reveal (e.g., `***-**-****`)
- `random` — replaced with a synthetic value

The `masked` mode is what users see when the agent reflects PII back to them. The masking algorithm is configurable via `maskConfig`:

```ts
{ showFirst: 0, showLast: 0, maskChar: '*' }  // current default for SSN
```

A `showLast: 4` configuration would produce `***-**-6789` instead of `***-**-****`.

### 2.2 The Doc-vs-Code Discrepancy

| Source                                                                                                     | What it says                                          |
| ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| **Design review** ([§2.1, table row "User-facing reply"](2026-05-19-pii-vault-boundary-beta-promotion.md)) | "User sees `***-**-6789`" (last 4 visible)            |
| **Production code** (`packages/compiler/src/platform/security/pii-vault.ts:431`)                           | Returns `***-**-****` (full mask)                     |
| **Default mask config** (`pii-vault.ts:451`)                                                               | `{ showFirst: 0, showLast: 0 }` (zero digits visible) |
| **Test assertion** (`pii-vault-boundary.test.ts:100`)                                                      | `expect(userView).toBe('***-**-****')` — matches code |

The design review described the intended UX. The code implements the conservative default. The test locks in the conservative default. Nothing flags the conflict.

**This is the trigger for the decision** — we either update the design review to align with the conservative default, or we update the code/test to match the design review. Either way, **whatever we pick must be intentional**.

### 2.3 How Other Products Handle This

A scan of how comparable products mask sensitive data in user-facing surfaces:

#### Financial services (the dominant pattern)

| Product                     | SSN                                                    | Credit card          | Bank account |
| --------------------------- | ------------------------------------------------------ | -------------------- | ------------ |
| **Stripe Dashboard**        | n/a (doesn't store SSN in chat)                        | Last 4 (`**** 4242`) | Last 4       |
| **Plaid (consumer)**        | n/a                                                    | Last 4               | Last 4       |
| **Chase / BofA mobile**     | Full mask in transcripts; last 4 in verification flows | Last 4               | Last 4       |
| **Mint / Personal Capital** | n/a                                                    | Last 4               | Last 4       |
| **Robinhood**               | Full mask                                              | Last 4               | Last 4       |

**Pattern:** Last 4 visible is the industry default for account numbers and SSNs in **user-owned views** (the user is looking at their own data). For agent-to-user dialogue, it's the verification-flow standard ("is your SSN ending in 6789?").

#### Healthcare / HIPAA

| Product                                | Approach                                                                                       |
| -------------------------------------- | ---------------------------------------------------------------------------------------------- |
| **Epic / Cerner**                      | MRN displayed in full to clinical users; SSN last 4 with explicit unmask requiring audit trail |
| **HIPAA Safe Harbor (45 CFR 164.514)** | Specifies de-identification rules — does NOT prescribe display masks                           |
| **HIPAA Limited Data Set**             | Allows zip-3, dates, ages — strictly less than full PHI                                        |

**Pattern:** Healthcare leans conservative by default; clinical roles can unmask with audit. Consumer-facing healthcare apps (Teladoc, MyChart) tend to last-4.

#### Tech / SaaS

| Product                         | Approach                                                             |
| ------------------------------- | -------------------------------------------------------------------- |
| **OpenAI / Anthropic API keys** | `sk-***...` (first 3 + suffix mask)                                  |
| **AWS console**                 | Account ID last 4 (`...1234`); ARNs partial                          |
| **Salesforce Shield**           | Per-field encryption with role-based unmask; default is full hide    |
| **ServiceNow Data Privacy**     | Role-based; per-field configurable                                   |
| **GitHub**                      | Email shows username only (no domain) when private; full when public |

**Pattern:** Tech products are uniformly **configurable per field** with conservative defaults. The "developer decides" model dominates.

#### Identity & verification

| Product           | Approach                                                                  |
| ----------------- | ------------------------------------------------------------------------- |
| **Auth0 / Okta**  | Phone last 4 in SMS verification; email partial mask (`a***@example.com`) |
| **Twilio Verify** | Phone full mask during input, last 4 in confirmation                      |
| **DocuSign**      | Signer's email last 4 of local-part visible                               |

**Pattern:** Verification flows almost universally show **last 4 for phone**, **first-1 + domain for email**.

### 2.4 Why "One Mask Fits All" Doesn't Work

Different PII types have different verification conventions:

| PII Type      | Common mask                           | Why                                                                         |
| ------------- | ------------------------------------- | --------------------------------------------------------------------------- |
| SSN           | Last 4 (`***-**-6789`)                | US banking standard; "last 4 of SSN" is a recognized verification challenge |
| Credit card   | Last 4 (`**** 4242`)                  | PCI DSS allows display of last 4 + first 6 (BIN)                            |
| Phone         | Last 4 (`***-***-5309`)               | SMS-verification convention                                                 |
| Email         | First-1 + domain (`a***@example.com`) | Most products' "we sent a code to your email" UX                            |
| Date of birth | Year only or full mask                | HIPAA Limited Data Set allows year                                          |
| Address       | City + state only                     | Common in healthcare and finance                                            |
| Passport      | Last 4 or full mask                   | Country-dependent regulation                                                |
| IBAN          | Last 4 of account portion             | EU SEPA convention                                                          |

A single global default — say, "last 4 always" — would be:

- **Wrong for email** (`***-**-****@example.com` makes no sense)
- **Wrong for DOB** (`***-**-19?9` half-reveals age range)
- **Too generous for passport** in some jurisdictions

The conservative default (full mask) is safe but unhelpful in verification flows. The lenient default (last-4) is convenient but inappropriate for some types.

### 2.5 Proposed Design

A three-tier control model with safe defaults and developer override:

#### Tier 1 — Platform defaults (conservative)

Every PII type ships with a **full-mask default**. No partial reveal until the developer opts in. This is what the code already does; we keep it.

#### Tier 2 — Per-pattern presets (developer choice in Studio)

In the **PII Pattern Config** UI in Studio (Project Settings → PII Detection → per-pattern row), expose a `Mask style` dropdown:

| Preset                          | Behavior                             | Use when                                                         |
| ------------------------------- | ------------------------------------ | ---------------------------------------------------------------- |
| **Full mask** _(default)_       | `***-**-****`                        | Default; user-facing transcripts; high-sensitivity environments  |
| **Last 4 visible**              | `***-**-6789`                        | Financial verification; "is this your SSN ending in 6789?" flows |
| **First N + Last N**            | `123-**-6789` (configurable)         | Power-user cases (advanced)                                      |
| **Domain visible (email only)** | `a***@example.com`                   | Email verification flows                                         |
| **Custom format**               | Developer provides a template string | Edge cases, e.g., `[REDACTED-XX]`                                |

The developer picks the preset per pattern (per PII type), not per agent. This means SSN can have its preset, email can have its own, independently.

#### Tier 3 — Per-agent override (advanced)

For customers who need different masks in different agent contexts (e.g., a customer-service agent shows last 4 for verification, while a transcript-export agent shows full mask), we expose a per-agent `mask_override` field in the agent DSL:

```yaml
PII:
  mask_overrides:
    ssn: full_mask
    email: domain_visible
```

This is opt-in and rarely needed. Most customers will use Tier 2 (pattern-level) defaults.

### 2.6 UI Sketch

In **Studio → Project Settings → PII Detection → [Pattern: SSN]**:

```
┌─────────────────────────────────────────────────────┐
│ PII Pattern: SSN                                    │
├─────────────────────────────────────────────────────┤
│ Detection                                            │
│   ☑ Enabled                                          │
│   Confidence threshold: [85%]                        │
│                                                     │
│ User-Facing Mask Style                               │
│   ⦿ Full mask        ***-**-****     (recommended)  │
│   ○ Last 4 visible    ***-**-6789                   │
│   ○ Custom format     [             ]               │
│                                                     │
│   Preview: ***-**-****                              │
│                                                     │
│ ℹ  This controls what end-users see when the agent  │
│    reflects this PII back to them. Tools and the    │
│    LLM follow separate render rules.                │
└─────────────────────────────────────────────────────┘
```

### 2.7 Migration & Defaults

- **Existing deployments:** keep current behavior (full mask). No change.
- **New deployments:** start with full mask. The Studio UI surfaces the choice.
- **Audit trail:** when a developer changes the mask style for a pattern, log a `pii_mask_style_changed` audit event (tenant, project, pattern, old, new, who, when).
- **Multi-region / regulated tenants:** consider a tenant-level "lock to full mask" flag for regulated industries (healthcare, government) — admins cannot pick a less-conservative preset. Defer to PM.

---

## 3. Decision 2 — Workflow Engine Scope (F-7)

### 3.1 Background: How the Workflow Engine Touches PII Today

The workflow engine (`apps/workflow-engine`, built on Restate) handles durable async patterns — waits, polls, scheduled triggers, multi-hour orchestrations. Agents invoke workflows via `type: workflow` tool. Workflows can chain tool calls of their own.

The PII vault is a **session-scoped** concept inside the agent runtime. A vault lives for the lifetime of a chat session. The workflow engine has no concept of a vault — workflow state persists across hours or days, far longer than any agent session.

When a workflow invokes a tool via `POST /api/internal/tools/execute`, the request **does not include a `piiAccess` field**. The route handler (`internal-tools.ts:530`) gates PII rendering on this field. With no field, no rendering. The tool receives whatever raw data the workflow holds.

### 3.2 The Silent Bypass Problem

Consider this scenario:

```
1. User chats with an onboarding agent and says: "My SSN is 123-45-6789."
2. Agent extracts SSN and starts a workflow: `submit_kyc_application({ ssn: "123-45-6789" })`.
3. Workflow is durable — it persists this input to disk, possibly Kafka, possibly ClickHouse.
4. Workflow's first step is a tool call: `external_kyc_provider.verify({ ssn: input.ssn })`.
5. This tool call goes through `POST /api/internal/tools/execute` WITHOUT `piiAccess`.
6. The tool receives plaintext SSN.
7. NO `pii_plaintext_dispensed` audit event is emitted.
8. NO redaction is applied.
9. The SSN sits in workflow state for the workflow's lifetime (hours? days?).
```

**This isn't a bug in the workflow engine.** It's working as designed — workflows are explicit data planes, the author chose to pass an SSN. But:

- **No customer documentation** says PII vault doesn't apply to workflows.
- **No runtime warning** alerts the workflow author that they're handling unprotected PII.
- **No audit trail** captures the plaintext dispensing in this path.
- **A future engineer** adding a workflow tool call won't realize the gap exists.

When a customer's auditor asks "show me every plaintext PII dispense," the audit log is incomplete by an unknown amount.

### 3.3 Four Options

#### Option A — Document as out-of-scope, no behavior change

Add:

- A code comment at `workflow-engine/src/index.ts:743` flagging the bypass.
- A "Non-Goals" section in the feature spec naming workflows.
- A docs page advising workflow authors to handle PII manually.

**Pros:** Zero engineering risk. Honest about today's behavior.
**Cons:** Relies on developers reading docs. Compliance gap remains. No observability.

#### Option B — Wire the PII vault through the workflow engine

Major architectural change:

- Workflows get their own PII vault (persisted to workflow state).
- PII detection runs on workflow inputs at entry.
- Tool calls go through `restorePIITokensForToolExecution` with declared `pii_access`.

**Pros:** True contract closure. Audit completeness. Single mental model across agent + workflow.
**Cons:** Significant engineering effort (multi-week). Workflow "consumer" semantics differ (no LLM, no user). Persistence story for workflow vaults across pauses is non-trivial.

#### Option C — Workflow-level PII policy declaration

Middle ground:

- Workflow author declares which inputs are PII (in the workflow definition).
- Tools declare `pii_access` (already exists in IR).
- A render step runs at the workflow → tool boundary.

**Pros:** Surgical scope. Author-driven (matches workflow engine's mental model). Closes the contract for workflows that opt in.
**Cons:** Workflows that don't opt in have no protection (same as today). Adds yet another configuration surface.

#### Option D — Detection-only safety net (warn, don't block)

Lightweight observability:

- Wrap workflow tool dispatch with a scanner that detects PII patterns in outgoing tool params.
- If detected, emit a `workflow_unprotected_pii_dispatched` trace event with tenant, workflow, tool, PII type (NOT the value).
- No behavior change — tools still receive what they would have.

**Pros:** Closes the "no observability" gap immediately. Low effort. Buys time to design Option B/C properly.
**Cons:** Just a warning — leak still happens. Adds detection overhead to workflow tool dispatch.

### 3.4 Recommendation

**Two-phase approach:**

**Phase 1 (this release):** **A + D combined.**

- Land the code comment + docs (Option A) — immediate hygiene.
- Land the detection-only safety net (Option D) — immediate observability.

This costs ~2-3 engineering days and gives us:

- Honest disclosure to customers reading docs.
- Audit log entries for unprotected PII in workflows (even if not blocked).
- A data signal — once we have telemetry, we know whether real customers are actually hitting this path with real PII (informs Phase 2).

**Phase 2 (next major release):** Decide between **Option B** (full contract closure) and **Option C** (opt-in declaration) based on Phase 1 telemetry. If Phase 1 shows few customers hit the path → Option C is enough. If many customers hit it → Option B is justified.

This staged approach avoids over-engineering for a hypothetical use case while removing the silent-failure mode immediately.

---

## 4. Combined Decision Matrix

For each item, please indicate **APPROVE / REVISE / REJECT** and rationale.

| Decision                                                                                      | Approve as proposed? | Revisions requested |
| --------------------------------------------------------------------------------------------- | -------------------- | ------------------- |
| **F-6** — Three-tier mask design (platform default + per-pattern preset + per-agent override) |                      |                     |
| **F-6** — Per-pattern presets list (full / last-4 / first+last / domain / custom)             |                      |                     |
| **F-6** — Default for new deployments = full mask (conservative)                              |                      |                     |
| **F-7** — Phase 1: docs + detection-only safety net                                           |                      |                     |
| **F-7** — Phase 2: defer decision (Option B vs C) until telemetry collected                   |                      |                     |

### Specific questions for stakeholders

| Stakeholder                | Question                                                                                                                                                                           |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Product**                | Do we expect customers to ship agents that ask users to confirm last-4 of SSN? If yes, the last-4 preset must be easy to enable. If no, full mask everywhere is the right default. |
| **Product**                | What's the workflow engine's PII story in the customer-facing pitch? Are workflows expected to handle PII, or are they orchestration-only?                                         |
| **Security architect**     | Is per-pattern mask configuration (developer-controlled) acceptable, or do you want a tenant-level "lock to full mask" override for regulated customers?                           |
| **Compliance lead**        | For workflow engine bypass — does the detection-only safety net (Option D) satisfy your compliance review, or do you require Option B/C before GA in regulated verticals?          |
| **Engineering leadership** | Is the Phase 1 / Phase 2 staging for workflow scope acceptable, or do you want a single decision now?                                                                              |

---

## 5. References

### In-repo

- **F-6 source:** `packages/compiler/src/platform/security/pii-vault.ts:431-451` (mask defaults)
- **F-6 test:** `apps/runtime/src/__tests__/pii-vault-boundary.test.ts:100`
- **F-7 source (bypass site):** `apps/runtime/src/routes/internal-tools.ts:530` (the `if (piiAccess)` gate)
- **F-7 source (workflow caller):** `apps/workflow-engine/src/index.ts:743-764`
- **Related design review:** `docs/reviews/2026-05-19-pii-vault-boundary-beta-promotion.md`
- **Feature spec:** `docs/features/sub-features/pii-vault-boundary-contract.md`

### External

- **PCI DSS 4.0 §3.4** (PAN truncation rules)
- **HIPAA 45 CFR 164.514** (de-identification)
- **HIPAA Limited Data Set** (allowed partial reveal)
- **NIST SP 800-122** (PII confidentiality)
- **GDPR Art. 32** (security of processing)

### JIRA

- ABLP-535 — umbrella ticket
