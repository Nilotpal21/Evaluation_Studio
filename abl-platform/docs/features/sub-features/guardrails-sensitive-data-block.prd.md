# PRD: Guardrails "Sensitive Data Block" — Separating PII Gating from PII Handling

- **Date:** 2026-05-14 (revised 2026-05-15 — added §2.4, §5.6–§5.10, §7.5, §10 tasks 11–18, §11 items 6–10; Oracle UX+CPO re-eval locked all 10 open items)
- **Status:** **Superseded** — see canonical feature spec at `docs/features/sub-features/guardrails-sensitive-data-block.md` (created 2026-05-15). This PRD is preserved as the exploratory/journey artifact; ground-truth requirements live in the feature spec.
- **Owner:** Girish (PM)
- **Branch:** `discuss/guardrails-pii-consolidation`
- **Anchor decision:** `docs/architecture/2026-05-14-guardrails-pii-separation-adr.md`
- **Companion wireframes:** `docs/features/sub-features/guardrails-sensitive-data-block.wireframes.html`
- **Related work:** ABLP-723 (PR #989, state isolation), ABLP-921 (PR #926, tiered PII recognizers)
- **JIRA ticket:** TBD (no ticket yet; will be created before any code commit)

---

## 1. Background

Today, Studio exposes PII configuration on two screens with overlapping names and partially overlapping action vocabularies:

- **Settings → PII Protection** — project-level vault-backed detection + tokenization. Render modes per consumer: `original` / `masked` / `redacted` / `tokenized` / `random`. The agent retains the ability to use real values for tool calls via vault restoration.
- **Guardrails → Create Policy → "PII Protection" preset** — per-policy rule with action `block` / `warn` / `redact`. The `redact` action here is destructive string replacement and breaks tool calls.

The investigation in the companion ADR confirmed there is **no documented rationale** for the dual surface. The preset was added as part of an industry-standard 4-category UI pattern (Aporia/Bedrock/Azure). Customer journeys repeatedly fail because the two screens share a name and partially overlapping verbs.

This PRD specifies the changes needed to ship a coherent **Azure-style separation**: each surface owns a sharply distinct job.

---

## 2. Customer journey transcripts (problem evidence)

### 2.1 Journey A — Apple Care project owner

> Configures her customer-care agent. Goes to Guardrails (because Sidebar surfaces it). Sets `PII Protection → redact`. Saves. Tests. PII is gone — but so is the agent's ability to greet "Hi, Jamie." The CRM tool call now passes `[REDACTED]` instead of an email. Agent breaks.

She never found Settings → PII Protection. She thought she configured PII. She didn't.

### 2.2 Journey B — Compliance lead

> Mandate: "If a customer pastes an SSN, agent must refuse." Goes to Settings → PII Protection. Sees patterns + render modes — none of it says "block." Gives up. Goes to Guardrails. Sets PII Protection → block. ✅ Works.

This is the **one legitimate distinct use case** Guardrails serves today. Settings cannot express "refuse."

### 2.3 Journey C — AI engineer panicking pre-demo

> Agent leaked an SSN. Searches "PII" in Studio. Finds **two** screens with the same name and partially overlapping controls. Turns on both. Now requests are double-processed: guardrail destructively strips strings first, then Settings tries to tokenize what's already gone. Vault is empty. Tool calls get `[REDACTED]`. Worse than before.

### 2.4 Journey D — Project owner activates an empty policy (added 2026-05-15)

> Configures a new guardrail policy named "Customer Care Safety." Clicks "Add Policy", types the name, doesn't enable any of the four preset rules, clicks "Save as Draft". Then on the list, toggles the policy from Draft → Active. The list shows `Active` with a green pill. She walks away thinking her agent is now protected.
>
> Hours later, a test reveals zero enforcement. The "active" policy has zero enabled rules — it does nothing. Studio gave no warning at activation time, and the list row shows no way to see what rules (if any) are enabled inside.

**Pattern**: "Active" is a meaningless badge today. It marks a policy as the project's selected policy, but does not require that the policy actually do anything. The list view has no rule preview, so users cannot audit at a glance which protections are in effect.

### 2.5 Journey E — Specific-entity block (added 2026-05-15)

> Compliance lead: "I need to block SSNs only. I'm fine with credit cards, emails, and phone numbers passing through — those go through Settings → PII Protection for tokenization."
>
> Enables Sensitive Data Block with action `block`. Sets confidence threshold. Saves. Tests with an email — request is **blocked**. Because the `builtin-pii` provider detects _all_ PII entity types as a monolithic category, there's no way to scope the block to SSNs only.

**Pattern**: The current Sensitive Data Block treats PII as one undifferentiated category. With ABLP-921 already exposing 8 packs / 37 entities under the recognizer registry, we can — and should — let users pick which entities trigger the block.

**Combined pattern across all journeys**: every failure mode is a signal that the policy's _intent_ is invisible until you open it. Either the name doesn't match the behavior (A, C), or "active" doesn't imply enforcement (D), or the rule is too coarse to express the user's real intent (E).

---

## 3. Goals & Non-goals

### 3.1 Goals

1. Customers can predict which screen to use for any PII task in <5 seconds, without reading docs.
2. The two surfaces share no overlapping action verb.
3. Preserve the two genuinely distinct jobs the surfaces serve today (handle vs. stop).
4. Ship pre-launch (no customers; no migration debt).
5. Telemetry continuity is preserved or explicitly versioned.
6. **(Added 2026-05-15)** "Active" on a policy always means at least one rule is enforced. No empty-policy activation.
7. **(Added 2026-05-15)** "Enabled" on a rule always means every required field is populated. No half-configured rule can ever evaluate.
8. **(Added 2026-05-15)** A user can audit which rules are enforced in any policy without opening the editor — the policy list row previews enabled rules at a glance.
9. **(Added 2026-05-15)** Sensitive Data Block expresses intent at entity granularity. A user can scope a rule to "block SSNs only" or "block all PII" or any custom subset of the 37 entities exposed by the ABLP-921 recognizer registry.

### 3.2 Non-goals

- Unifying the two surfaces into one screen (Bedrock-style). Rejected in ADR §5.4.
- Removing Guardrails PII entirely. Rejected in ADR §5.1.
- Changing the underlying detection engine (`pii-detector.ts`, `PIIRecognizerRegistry`).
- Changing how Settings → PII Protection behaves. We only add a banner.
- Adding third-party PII provider integrations (e.g., OpenAI Moderation as a PII provider). Future work.

---

## 4. Mental model the customer learns

| Screen                                | Verb     | When to use                                                                              |
| ------------------------------------- | -------- | ---------------------------------------------------------------------------------------- |
| **Settings → PII Protection**         | _Handle_ | "I want my agent to use real customer data without exposing it to the LLM or end users." |
| **Guardrails → Sensitive Data Block** | _Stop_   | "I want my agent to refuse the entire request if it contains certain PII types."         |

### 4.1 Decision matrix (shipped in onboarding + Studio in-app help)

| What I want                                                            | Where to go                                  |
| ---------------------------------------------------------------------- | -------------------------------------------- |
| Hide PII from the LLM but still let the agent use it (tool calls work) | Settings → PII Protection                    |
| Mask PII in agent responses to end users                               | Settings → PII Protection                    |
| Reversibly tokenize PII (vault-backed)                                 | Settings → PII Protection                    |
| Audit every PII detection event                                        | Settings → PII Protection (audit toggle)     |
| **Block** messages containing specific PII types outright              | Guardrails → Sensitive Data Block            |
| **Escalate** to a human when PII confidence is high                    | Guardrails → Sensitive Data Block            |
| Enforce PII blocking across all projects in a tenant                   | Guardrails (tenant-level policy inheritance) |

---

## 5. Functional Requirements

### 5.1 Guardrail Policy Form — preset row changes

**File:** `apps/studio/src/components/guardrails/GuardrailPolicyForm.tsx`

| Property                     | Before                                               | After                                                                                                                                                  |
| ---------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Preset key                   | `pii_protection`                                     | `sensitive_data_block`                                                                                                                                 |
| Label (i18n)                 | `guardrails.preset.piiProtection` → "PII Protection" | `guardrails.preset.sensitiveDataBlock` → "Sensitive Data Block"                                                                                        |
| Default action               | `redact`                                             | `block`                                                                                                                                                |
| Allowed actions in row UI    | `block`, `warn`, `redact`                            | `block`, `warn`, `escalate` _(redact removed; escalate added)_                                                                                         |
| Default enabled              | `false`                                              | `false` _(unchanged)_                                                                                                                                  |
| Provider default             | `builtin-pii`                                        | `builtin-pii` _(unchanged)_                                                                                                                            |
| Helper text (always visible) | none                                                 | "Stops requests containing PII outright. To **anonymize or tokenize** PII while keeping the agent working, configure under Settings → PII Protection." |

**FR-1.1** The row label, description, and helper text must come from `packages/i18n/locales/en/studio.json` (no hardcoded strings).

**FR-1.2** When the user expands the row, the action selector renders three options only: Block, Warn, Escalate. `Redact` does **not** appear in this preset's UI.

**FR-1.3** Custom rules added via "Add Custom Rule" still support the full action enum (`block`, `warn`, `redact`, `escalate`) — this restriction applies only to the preset row UI, not the schema.

**FR-1.4** Helper text contains a textual link to Settings → PII Protection. Clicking the link navigates within the same project context (no full page reload).

### 5.2 Settings → PII Protection — banner

**File:** `apps/studio/src/app/projects/[id]/settings/pii-protection/...` (and/or `PIIPatternFormDialog`)

**FR-2.1** Show a dismissible info banner at the top of the screen:

> "Need to **block** requests containing PII outright? Create a Guardrail Policy with a **Sensitive Data Block** rule. → Configure now"

**FR-2.2** The banner's CTA navigates to `/projects/:projectId/guardrails-config` and opens the Create Guardrail Policy dialog with the Sensitive Data Block row pre-expanded.

**FR-2.3** Banner is dismissible per-user (stored in `localStorage` with key `pii-protection-banner-dismissed`).

### 5.3 Decision matrix in Studio in-app help

**FR-3.1** Add a help section at `Settings → PII Protection` _and_ at `Guardrails Policy Form` (small "?" icon next to the preset row) that opens a modal showing the decision matrix from §4.1.

**FR-3.2** Help content is i18n-keyed and lives in `packages/i18n/locales/en/studio.json` under `guardrails.help.sensitiveDataBlock` and `settings.help.piiProtection`.

### 5.4 Telemetry

**FR-4.1** Guardrail evaluation traces today tag rule category as `pii`. Decision: **rename trace tag to `sensitive_data_block`**, with a one-week dual-emit period (emit both `pii` and `sensitive_data_block` tags) for any external dashboards.
_(This is pre-launch — no external dashboards exist. The dual-emit period is precautionary and can be skipped if we confirm internal dashboards only.)_

**FR-4.2** Update any analytics dashboards in `apps/studio/src/components/analytics/` that filter by guardrail rule category.

### 5.5 Schema & runtime

**FR-5.1** `guardrail-policy.model.ts` action enum remains unchanged (`block`, `warn`, `redact`, `escalate`). No schema migration required.

**FR-5.2** `BuiltinPIIProvider` (`apps/runtime/src/services/guardrails/providers/builtin-pii.ts`) — unchanged. Detection code path is reused as-is.

**FR-5.3** `BUILTIN_GUARDRAIL_PROVIDERS` (`guardrail-adapters.ts`) — `adapterType: 'builtin_pii'` remains. No registry change.

### 5.6 Sensitive Data Block — per-entity selection (added 2026-05-15)

**Context:** Today the `builtin-pii` provider is monolithic — it detects all 37 entities across 8 packs (post-ABLP-921) and reports a single PII score. Users cannot scope "block SSNs only" — see Journey E in §2.5.

**Decision:** Expose entity selection inside the Sensitive Data Block rule. The user picks which entities trigger the rule. The detection runs across all entities (cheap), but the rule's outcome is gated on whether _selected_ entities matched.

#### 5.6.1 Redesign of the rule's existing fields

Auditing each existing field for necessity:

| Field                  | Decision                                                                                                                                    | Notes                                                                                                                                                                        |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `provider`             | **Keep, but render as read-only label** if `builtin-pii` is the only option. Becomes a selector when third-party PII providers come online. | Removes a useless dropdown on day one without locking out future providers.                                                                                                  |
| `action`               | **Keep** — `block` / `warn` / `escalate`.                                                                                                   | Core rule semantics.                                                                                                                                                         |
| `confidence threshold` | **Keep** — slider 0.0–1.0, default 0.7.                                                                                                     | Leverages ABLP-921 tier confidence scoring. Higher = fewer false positives.                                                                                                  |
| `kind` (Applies To)    | **Keep, expose explicitly** — checkboxes for Input / Output (default: both checked).                                                        | Was implicit/hidden in the current UI. Becomes a required field for enable.                                                                                                  |
| `category`             | **Auto-set to `pii`, hidden** (no UI control).                                                                                              | Schema field still exists for runtime routing; user never sees it.                                                                                                           |
| `action message`       | **NEW (required)** — text input for the message shown when rule triggers.                                                                   | Required for enable. Defaults to a sensible template ("Your message contains sensitive information and cannot be processed. Please remove personal details and try again."). |
| `entities to detect`   | **NEW (required)** — multiselect across the 37 entities.                                                                                    | See §5.6.2 below.                                                                                                                                                            |
| `description`          | **Keep, optional** — internal note.                                                                                                         | Unchanged.                                                                                                                                                                   |

#### 5.6.2 Entity multiselect — UI model

- **Quick presets** (radio above the entity list):
  - `High-risk only` (**default**, with **only SSN pre-selected**) — radio is `High-risk only` on first enable; entity list shows SSN checked, other high-risk entities unchecked but visible. User can check more to widen scope.
  - `All PII` (selects every entity in the registry — opt-in)
  - `Custom` (user toggles individual entities; selecting this from `High-risk only` retains the current selection set)
- **High-risk entity group** comprises: SSN, Credit Card Number, Bank Account Number, Passport Number, Driver's License Number, IBAN (financial + government-ID entities). This group is the candidate pool the `High-risk only` preset exposes; only SSN starts pre-checked.
- **Entity list**: scrollable list of all 37 entities (grouped by pack: Identity, Financial, Contact, Location, Medical, Internet, Government, Other). Each entity has:
  - Label (e.g., "Social Security Number")
  - Pack badge (e.g., "Government")
  - Tier indicator (1 / 2 / 3, from ABLP-921 — informs latency expectation)
  - Toggle
- **At least one entity must be selected** when the rule is enabled (covered by §5.8 enable gate).

#### 5.6.3 Runtime semantics

**FR-6.1** Detection still runs across all entities (the registry has no per-entity short-circuit today, and selectively short-circuiting would change ABLP-921's pack-load semantics). The rule's outcome is gated _after_ detection: if any _selected_ entity matched with confidence ≥ threshold, the rule triggers.

**FR-6.2** Rule schema gains a new field `entities: string[]` (canonical entity IDs from the registry, e.g., `['us_ssn', 'credit_card', 'us_passport']`). Empty array = no rule trigger ever (defensive default). The preset `All PII` is sugar — saves as the full entity list explicit, not `[]`, so the rule's intent is auditable.

**FR-6.3** Future optimization (out of scope): if the registry adds per-entity recognizers that can be skipped, gate detection itself on the selected entity set to reduce latency. Pre-launch the user-facing behavior is identical regardless.

#### 5.6.4 Files touched

- `apps/studio/src/components/guardrails/GuardrailPolicyForm.tsx` — entity multiselect component, integration into the Sensitive Data Block row.
- `apps/studio/src/components/guardrails/EntityMultiselect.tsx` (new) — reusable component with quick presets.
- `packages/database/src/models/guardrail-policy.model.ts` — add `entities?: string[]` to the rule schema.
- `apps/runtime/src/services/guardrails/...` (evaluator) — post-detection filter by `entities` array.
- `packages/runtime/src/services/pii/recognizer-registry.ts` (or wherever ABLP-921 exposed entity metadata) — expose entity catalog API to Studio (`GET /api/pii/entities`).
- `apps/studio/src/api/pii-entities.ts` — proxy route to fetch entity catalog.

### 5.7 Policy-level activation gate (added 2026-05-15)

**Context:** Per Journey D (§2.4), a policy can be toggled to "Active" today with zero enabled rules. "Active" should always mean enforcement.

**Files:** `apps/studio/src/components/guardrails/GuardrailsConfigPage.tsx` (policy list), `apps/runtime/src/routes/guardrail-policies.ts` (server-side guard).

**FR-7.1** A policy may only be set to `active: true` if it contains **at least one rule** with `enabled: true` _and_ that rule passes the rule-level enable gate (§5.8). This is enforced on **both** the client and the server.

**FR-7.2** Client-side: the activation toggle in the list row is disabled (greyed out + tooltip) if the policy has zero enabled rules. Tooltip: "Enable at least one rule to activate this policy."

**FR-7.3** Server-side: `PATCH /api/projects/:projectId/guardrail-policies/:policyId/activate` returns `400 { error: { code: 'NO_ENABLED_RULES', message: '…' } }` if no rules are enabled. The error message is i18n-keyed.

**FR-7.4** If the user removes/disables the last enabled rule from an active policy, the policy is **automatically deactivated** with a one-time toast: "Policy 'X' was deactivated because its last enabled rule was disabled." The server-side activation guard re-validates on every rule update.

**FR-7.5** Telemetry: emit `guardrail.activation.blocked` trace event with `reason: 'no_enabled_rules'` when the gate fires (helps measure how often users hit it).

### 5.8 Rule-level enable gate (added 2026-05-15)

**Context:** Per requirement #3, a rule may only be `enabled: true` if all required fields are populated. Today, PR #989's `validateRule()` enforces a subset; we extend it.

**Files:** `apps/studio/src/components/guardrails/GuardrailPolicyForm.tsx` (validateRule pure helper, RuleCard UI), `apps/runtime/src/routes/guardrail-policies.ts` (server-side guard).

**FR-8.1** Extend `validateRule()` to enforce per-`checkType` required fields when `rule.enabled === true`:

| `checkType` | Required fields when enabled                                                                                                                                  |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `provider`  | `name`, `kind` (Applies To), `provider`, `category`, `action`, `severityThreshold`, `actionMessage`, **and** (for `category === 'pii'`) `entities.length > 0` |
| `cel`       | `name`, `kind`, `check` (CEL expression), `action`, `actionMessage`                                                                                           |
| `llm`       | `name`, `kind`, `llmCheck` (prompt), `action`, `actionMessage`                                                                                                |

**FR-8.2** Client-side: the enable toggle on the rule card is **disabled** (greyed + tooltip) when any required field is empty. Tooltip lists missing fields by name. Pre-existing PR #989 behavior (showing inline red error + disabling Save) is **preserved** — the new check runs alongside, not instead.

**FR-8.3** Server-side: `PATCH /api/projects/:projectId/guardrail-policies/:policyId` rejects a rule with `enabled: true` and missing required fields. Response: `400 { error: { code: 'RULE_INCOMPLETE', message: '…', missingFields: [...] } }`.

**FR-8.4** If the user attempts to enable a rule via the API directly (bypassing the form), the server guard catches it. Defense in depth.

**FR-8.5** _PR #989 validation disposition_: **Keep all existing validations.** They are per-`checkType` field-completeness checks at a finer granularity than the new policy-level gate. Specifically:

- `validateRule()` name-required-if-enabled: **kept** (covered as part of FR-8.1).
- Provider-required-if-`checkType === 'provider'`: **kept** (covered by FR-8.1).
- CEL-required-if-`checkType === 'cel'`: **kept** (covered by FR-8.1).
- LLM-check-required-if-`checkType === 'llm'`: **kept** (covered by FR-8.1).
- Save-button-disable on validation error: **kept**.
- Validation banner: **kept**.

The new gates (§5.7, §5.8) compose on top of PR #989's validations. None of #989's checks become redundant.

### 5.9 Policy list — enabled-rule preview (added 2026-05-15)

**Context:** Per Journey D + Goal 8, "Active" should be auditable at a glance from the list view. Today the row only shows policy name + status pill (Draft / Active). Nothing about contents.

**File:** `apps/studio/src/components/guardrails/GuardrailsConfigPage.tsx` (policy list rendering).

**FR-9.1** Each policy row shows a **rule preview** below or beside the name: a horizontal list of "enabled rule" chips, each with a green dot + rule label.

**FR-9.2** Only rules with `enabled === true` are previewed. Disabled rules are not shown — a clean row means an empty policy and visually mirrors the activation gate (no chips → cannot activate).

**FR-9.3** Chip format: `● Sensitive Data Block · ● Content Safety · ● Prompt Injection` (separator: middle dot or hairline). For policies with >4 enabled rules, show first 3 + `+N more`.

**FR-9.4** Chip click navigates to the rule's expanded state inside the policy editor (deep-link).

**FR-9.5** For a draft policy with **zero** enabled rules, show a subtle warning: "No rules enabled" in muted text + an info icon with tooltip "Enable at least one rule to activate this policy."

**FR-9.6** Visual position: chips appear to the right of the policy name on a single line if there's room (>1024px viewport); below the name on narrow viewports. Status pill (Draft / Active) remains right-aligned.

### 5.10 PR #989 validation audit and disposition (added 2026-05-15, revised 2026-05-15)

> **REVISION (2026-05-15):** Verified on develop @ `291d23576` — PR #989 is **NOT merged** and may be abandoned. None of its symbols (`validateRule`, `firstRuleError`, `presetRuleErrors`, `formInstance`, `onSwitchTab`) exist on develop. The matrix below documents which behaviors from PR #989 we are **re-implementing fresh** as part of this feature spec; nothing is assumed to be present in the baseline.

PR #989 introduced per-rule field-completeness validation. The new requirements (§5.7, §5.8) **subsume** the equivalents from PR #989 — they are implemented fresh as part of this feature, not as deltas on top. Disposition matrix:

| PR #989 behavior                                                                                 | Disposition          | Rationale                                                                                                                            |
| ------------------------------------------------------------------------------------------------ | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `validateRule()` returns error if enabled & name empty                                           | **Keep**             | Name remains required; new gate enumerates more fields.                                                                              |
| Provider required if `checkType === 'provider'`                                                  | **Keep**             | Subset of FR-8.1; same enforcement point.                                                                                            |
| CEL expression required if `checkType === 'cel'`                                                 | **Keep**             | Same.                                                                                                                                |
| LLM check required if `checkType === 'llm'`                                                      | **Keep**             | Same.                                                                                                                                |
| Save button disabled if any rule fails validation                                                | **Keep**             | Operates at form level; complements per-rule toggle gating from FR-8.2.                                                              |
| Inline red border + AlertTriangle on rule card                                                   | **Keep**             | Visual signal works for both #989 and new gates.                                                                                     |
| Validation banner above the rule list                                                            | **Keep**             | Aggregates errors; still useful.                                                                                                     |
| `pii_protection` preset default action `provider: 'builtin-pii'`                                 | **Keep then evolve** | Default provider remains `builtin-pii`. The preset key changes to `sensitive_data_block` (FR-1) and gains entity multiselect (§5.6). |
| Tab-switch flush prevention (form remount via `key={editPolicy._id ?? \`new-${formInstance}\`}`) | **Keep**             | Solved a real bug; unrelated to current scope.                                                                                       |
| Sibling-deactivation behavior on policy activate                                                 | **Keep**             | "Only one active policy per project" is intentional product behavior.                                                                |

**Net change vs. PR #989's surface**: this feature **re-implements** every "Keep" row above as part of its own implementation (not assumed present). The new gates (FR-7, FR-8) and the re-implemented PR #989 behaviors are designed together as one coherent UX. Open Item #6 ("how to coexist with PR #989's banner") is now **moot** — there is no separate PR #989 banner to coexist with; this feature owns the banner design from scratch.

---

## 6. Migration Plan (pre-launch posture)

### 6.1 Decision

Per product owner's call (2026-05-14): **delete** existing tester entries rather than convert. No customers in v1 means no migration burden, cleaner schema, no one-time UX banner needed.

### 6.2 Cleanup script

**File (new):** `tools/cleanup-pii-guardrail-presets.ts` (run once, pre-deploy)

**Behavior:**

1. Connect to MongoDB.
2. For each `guardrail_policies` document, remove any rule where `presetKey === 'pii_protection'` OR `category === 'pii'` AND the rule originated from the preset row (heuristic: `provider === 'builtin-pii' && action === 'redact'`).
3. Log count of removed rules per policy.
4. Idempotent — safe to re-run.

**Approval gate:** script requires `--confirm` flag and prints a dry-run summary first.

### 6.3 Custom rules with `category: 'pii'`

If a tester manually added a _custom_ rule with `category: 'pii'` (not via preset), the cleanup script does **not** touch it. These remain valid as long as the action is not `redact` (which would still be destructive). A future hardening could warn on custom PII rules with `redact`, but is out of scope here.

### 6.4 Audit log

The cleanup script emits a one-line audit entry per removed rule:

```
[cleanup-pii-guardrail-presets] removed rule {ruleId} from policy {policyId} (tenant {tenantId})
```

---

## 7. Acceptance criteria

### 7.1 UI

- [ ] Create Guardrail Policy dialog shows "Sensitive Data Block" instead of "PII Protection" in the preset row.
- [ ] Expanding the row shows action selector with only Block, Warn, Escalate (no Redact).
- [ ] Helper text is visible without expanding the row.
- [ ] Helper text link navigates to Settings → PII Protection within the same project.
- [ ] Banner appears at top of Settings → PII Protection screen.
- [ ] Banner CTA opens Create Guardrail Policy dialog with Sensitive Data Block row pre-expanded.
- [ ] Decision matrix modal is reachable from both screens via "?" icon.
- [ ] All strings are i18n-keyed.

### 7.2 Functional

- [ ] Creating a new policy with Sensitive Data Block (action: block) and triggering it via test message results in the request being blocked.
- [ ] Settings → PII Protection still tokenizes PII independently (no regression).
- [ ] Trace events tag the rule category as `sensitive_data_block` (with optional dual-emit).
- [ ] Cleanup script dry-run reports correct count of legacy rules.
- [ ] Cleanup script with `--confirm` removes legacy rules and leaves custom rules untouched.

### 7.3 Tests

- [ ] Unit: i18n key resolution for new labels.
- [ ] Unit: preset row action enum is filtered to `block | warn | escalate`.
- [ ] Integration: creating a Sensitive Data Block policy and evaluating against PII-containing input returns `outcome: 'block'`.
- [ ] E2E (HTTP): Studio Create Policy → Sensitive Data Block → trigger via runtime API → assert 403/blocked response.
- [ ] E2E: Settings → PII Protection banner appears, CTA navigates correctly.
- [ ] Pure-function: `validateRule()` accepts `escalate` action for sensitive_data_block preset.

### 7.4 Docs

- [ ] ADR present at `docs/architecture/2026-05-14-guardrails-pii-separation-adr.md`.
- [ ] Decision matrix added to public onboarding / Studio help.
- [ ] `docs/features/pii-detection.md` updated to reference the renamed preset and the explicit gate-vs-handle distinction (replaces FR-13 wording).
- [ ] `docs/architecture/GUARDRAILS_SPEC.md` updated to remove the implicit "PII redact" example (lines 239-249), replaced with a "Sensitive Data Block" example.

### 7.5 Policy quality gates (added 2026-05-15)

- [ ] Policy list shows enabled-rule chips with green dots for each policy row.
- [ ] Draft policies with zero enabled rules show "No rules enabled" muted text + tooltip.
- [ ] Activation toggle is disabled when policy has zero enabled rules (tooltip explains).
- [ ] Server rejects `PATCH /activate` with code `NO_ENABLED_RULES` when policy is empty.
- [ ] Disabling the last enabled rule on an active policy auto-deactivates the policy + emits toast.
- [ ] Rule enable toggle is disabled when required fields missing; tooltip lists missing fields.
- [ ] Server rejects rule with `enabled: true` and missing required fields with code `RULE_INCOMPLETE`.
- [ ] Pre-existing PR #989 validations (provider/CEL/LLM required, name required, Save disable, red border, banner) all still pass — no regression.
- [ ] No UI double-banner or contradictory tooltip between PR #989 and new gate.

### 7.6 Sensitive Data Block — entity selection (added 2026-05-15)

- [ ] Expanding the Sensitive Data Block row shows quick-preset radio (All PII / High-risk only / Custom).
- [ ] Custom mode shows scrollable list of all 37 entities grouped by pack with toggle each.
- [ ] Selecting `All PII` enables all entities (visible state, not hidden default).
- [ ] Selecting `High-risk only` enables the curated 6 entities (SSN, CC, Bank, Passport, DL, IBAN).
- [ ] Rule cannot be enabled with zero entities selected (FR-8.1).
- [ ] `Applies To` checkboxes (Input / Output) expose `kind` as an explicit required field.
- [ ] `Action message` textarea is required; default template populates on first toggle.
- [ ] Provider is rendered as read-only label when only `builtin-pii` is available.
- [ ] `entities` field round-trips through MongoDB + runtime evaluator.
- [ ] Selecting only SSN + triggering rule with email-containing input → rule does NOT trigger (post-detection entity filter works).
- [ ] Selecting all entities + triggering rule with email-containing input → rule triggers.
- [ ] `GET /api/pii/entities` returns the entity catalog with pack + tier metadata.

---

## 8. Out of scope

- Adding third-party PII provider integrations to the Sensitive Data Block preset.
- Adding new PII pattern types to Settings.
- Changing the vault/tokenization model.
- API/SDK external contract changes (verify no external consumer; if any exists, add to scope).
- Surfacing per-rule severity thresholds for the preset (steelman #5; closing gap; revisit post-ABLP-921 GA).

---

## 9. Risks

| Risk                                                                         | Likelihood | Impact | Mitigation                                                                         |
| ---------------------------------------------------------------------------- | ---------- | ------ | ---------------------------------------------------------------------------------- |
| Users still confuse the two surfaces after rename                            | Medium     | Medium | Decision matrix + onboarding + cross-link banners.                                 |
| Tester data cleanup misses some entries (custom rules with same fingerprint) | Low        | Low    | Idempotent script + dry-run + audit log.                                           |
| External SDK or API references `pii_protection` preset key                   | Unknown    | High   | Audit `apps/studio/src/api/`, `packages/web-sdk/`, public docs before code commit. |
| Telemetry continuity break                                                   | Low        | Low    | Dual-emit period if any internal dashboard exists.                                 |
| Future request to re-add redact to Guardrails preset                         | Medium     | Low    | Anchor decision in ADR; require revisiting explicitly.                             |

---

## 10. Implementation tasks (high-level)

> Detailed sub-tasking happens during LLD; this is the work breakdown for sizing.

| #   | Task                                                                                       | Files                                                                                             | Estimate |
| --- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- | -------- |
| 1   | Rename preset, update default action, restrict action enum in row UI                       | `GuardrailPolicyForm.tsx`, `RuleCard.tsx`                                                         | S        |
| 2   | Add helper text + cross-link to Settings                                                   | `GuardrailPolicyForm.tsx`, i18n                                                                   | S        |
| 3   | Add banner to Settings → PII Protection                                                    | `pii-protection/...`, i18n                                                                        | S        |
| 4   | Decision matrix modal (reusable component)                                                 | new `DecisionMatrixModal.tsx`                                                                     | M        |
| 5   | Hook decision matrix into both screens                                                     | both screens                                                                                      | S        |
| 6   | Update analytics trace tag (dual-emit)                                                     | runtime guardrail evaluator                                                                       | S        |
| 7   | Cleanup script                                                                             | `tools/cleanup-pii-guardrail-presets.ts`                                                          | M        |
| 8   | Update i18n strings                                                                        | `packages/i18n/locales/en/studio.json`                                                            | S        |
| 9   | Update GUARDRAILS_SPEC.md + pii-detection.md                                               | docs only                                                                                         | S        |
| 10  | Tests (unit + integration + E2E)                                                           | tests in respective packages                                                                      | M        |
| 11  | (Added 2026-05-15) Policy list — enabled rule chips + zero-rules warning                   | `GuardrailsConfigPage.tsx`, i18n                                                                  | M        |
| 12  | Policy-level activation gate (client + server)                                             | `GuardrailsConfigPage.tsx`, `apps/runtime/src/routes/guardrail-policies.ts`                       | M        |
| 13  | Rule-level enable gate — extend `validateRule()` + per-checkType required fields + tooltip | `GuardrailPolicyForm.tsx`, `RuleCard.tsx`                                                         | M        |
| 14  | Server-side rule completeness check (`RULE_INCOMPLETE` error)                              | `apps/runtime/src/routes/guardrail-policies.ts`                                                   | S        |
| 15  | Auto-deactivate policy when last enabled rule disabled                                     | rule update handler                                                                               | S        |
| 16  | Entity catalog API + Studio proxy                                                          | runtime `routes/pii-entities.ts` (new), `apps/studio/src/api/pii-entities.ts` (new)               | S        |
| 17  | `EntityMultiselect.tsx` component + quick-preset radio                                     | new component, integration in Sensitive Data Block row                                            | M        |
| 18  | Add `entities?: string[]` to rule schema + runtime evaluator post-detection filter         | `packages/database/src/models/guardrail-policy.model.ts`, `apps/runtime/src/services/guardrails/` | M        |

**Total estimate:** ~10 developer-days for a single engineer, including review cycles (original 5 + new 5 for policy quality gates and entity multiselect).

---

## 11. Open items requiring decision

| #   | Item                                                                                                                                                                                                                                                                                                                                                                                                                                 | Owner                     | Decision needed by                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | ~~Visual indicator for `escalate` action (color/icon)~~                                                                                                                                                                                                                                                                                                                                                                              | ~~Design~~                | **DECIDED 2026-05-15:** blue `badge-escalate` (color #1e40af on #dbeafe background, per wireframe screen 1). Same visual family as `block` (red) and `warn` (amber).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 2   | ~~Confirm no external SDK references `pii_protection` preset key~~                                                                                                                                                                                                                                                                                                                                                                   | ~~Engineering~~           | **RESOLVED 2026-05-15:** Oracle audit confirmed zero external SDK/API references. The `pii_protection` string in `apps/studio/src/config/navigation.ts` / `ProjectSidebar.tsx` is the **Settings** nav key (not the guardrail preset) and MUST NOT be renamed. The example file path in `examples/guardrails/project.json` is a docs/examples task.                                                                                                                                                                                                                                                                                                                                                                                               |
| 3   | ~~Telemetry dual-emit duration~~                                                                                                                                                                                                                                                                                                                                                                                                     | ~~Analytics~~             | **DECIDED 2026-05-15 (Oracle D-7):** Pre-commit grep of `apps/studio/src/components/analytics/` for `pii` tag references. If none found: clean cutover to `sensitive_data_block`. If references exist: one-release-cycle dual-emit.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 4   | ~~Banner dismissibility duration~~                                                                                                                                                                                                                                                                                                                                                                                                   | ~~Product~~               | **DECIDED 2026-05-15:** 90-day TTL. Banner re-surfaces 90 days after dismissal to align with quarterly compliance review cycles. Implementation: store `{dismissedAt: timestamp}` in localStorage; on render, check `Date.now() - dismissedAt > 90 * 24 * 60 * 60 * 1000`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 5   | Onboarding flow — does the new agent wizard introduce the gate-vs-handle distinction up-front?                                                                                                                                                                                                                                                                                                                                       | Product + Design          | Post-MVP refinement (intentionally deferred)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 6   | ~~(Added 2026-05-15) When the rule-enable gate (§5.8) fires alongside PR #989's existing red-border + Save-disable, how do they coexist?~~                                                                                                                                                                                                                                                                                           | ~~Design~~                | **MOOT 2026-05-15:** PR #989 is unmerged and likely abandoned (verified on develop @ `291d23576`). This feature implements all validation UX from scratch as one coherent design — no coexistence problem.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 7   | ~~(Added 2026-05-15) Default `entities` selection on a newly enabled Sensitive Data Block rule~~                                                                                                                                                                                                                                                                                                                                     | ~~Product~~               | **DECIDED 2026-05-15:** Default = `High-risk only` quick preset with **SSN as the only pre-selected entity**. User explicitly opts into broader PII via the preset radio or Custom mode. Rationale: SSN is the highest-severity single entity; pre-selecting only SSN gives a usable default without over-blocking.                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 8   | ~~(Added 2026-05-15) Entity catalog endpoint — is it project-scoped or tenant-scoped?~~                                                                                                                                                                                                                                                                                                                                              | ~~Engineering + Product~~ | **REVISED 2026-05-15 (Oracle A-9):** Entity catalog endpoint is **project-scoped**, filtered to enabled packs only: `GET /api/projects/:projectId/pii-entities`. Prevents the Journey-D-variant failure where a user selects an entity from a pack the project hasn't enabled (silently never fires). Disabled-pack entities are NOT returned by the API. If a saved rule references an entity from a later-disabled pack, the policy editor shows a warning when re-opened and the runtime evaluator simply does not match that entity (other selected entities continue to work). Earlier "global, no per-tenant packs" decision is superseded by this refinement — packs are still available to every tenant, but enable-state is per-project. |
| 9   | ~~(Added 2026-05-15) Auto-deactivation toast on disabling last rule — silent / toast-with-undo / confirmation modal?~~                                                                                                                                                                                                                                                                                                               | ~~Product~~               | **DECIDED 2026-05-15:** Toast with 5-second Undo CTA. Toast text: "Policy '{name}' was deactivated. The last enabled rule was disabled." Undo re-enables the rule AND re-activates the policy in one operation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 10  | ~~(Added 2026-05-15) Entity chip preview in §5.9 policy list~~                                                                                                                                                                                                                                                                                                                                                                       | ~~Design~~                | **DECIDED 2026-05-15:** Show entity sublabel for Sensitive Data Block only (the only rule type with selectable subscope). Format: `● Sensitive Data Block · SSN, CC` (first 2 entities + `+N more` for >2). Worth the row richness given it's the only multiselect rule. Other rule types show just the rule name.                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 11  | **DECIDED 2026-05-15 (Oracle UX-1, D-1):** Decision matrix modal opens automatically on first visit to either Guardrails policy form OR Settings → PII Protection, with localStorage-gated dismissal. `?` icon provides repeat access. WCAG APG dialog pattern: focus trap, Escape to close, correct ARIA role.                                                                                                                      | Design + Engineering      | Resolved                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 12  | **DECIDED 2026-05-15 (Oracle UX-2, A-2):** Keep "Sensitive Data Block" as the in-product name. Verb-among-nouns trade-off accepted to preserve plain-English clarity. Documentation/SEO uses aliases ("PII Filter", "PII Guardrail", "Block PII messages").                                                                                                                                                                          | Product                   | Resolved                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 13  | **DECIDED 2026-05-15 (Oracle UX-5):** Default action message revised to be channel-neutral: "This message contains information that cannot be processed in this channel. Please contact us through an alternative channel for further assistance." Replaces the user-error-implying default. Plain text only, 500 char max, server-side HTML strip. Single template in v1 (action message field is user-editable for customization). | Product + Engineering     | Resolved                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 14  | **DECIDED 2026-05-15 (Oracle CPO-1, A-5):** Both compliance lead AND AI engineer are primary configurer personas. User stories §3 cover both. Copy stays plain English. Marketing page surfaces both. Resolves the "compliance-only" framing that the initial PRD implied.                                                                                                                                                           | Product                   | Resolved                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 15  | **DECIDED 2026-05-15 (Oracle CPO-2, A-6):** Full v1 scope (~10 dev-days) — rename + banner + decision matrix + entity multiselect + activation gates + list chips + auto-deactivation ship together. No phasing.                                                                                                                                                                                                                     | Product                   | Resolved                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 16  | **DECIDED 2026-05-15 (Oracle CPO-5, A-7):** No pricing/packaging gating in v1. No documented wedge. All SDB capabilities available to all plans. Future pricing decisions are explicit business-development asks.                                                                                                                                                                                                                    | Product                   | Resolved                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 17  | **DECIDED 2026-05-15 (Oracle CPO-6, A-8):** Per-policy `failMode` field on `IGuardrailPolicySettings` exposed in Sensitive Data Block UI with disclosure: "Fail-closed means requests are blocked if PII detection fails. Recommended for text channels. May disrupt voice calls." Default: `failMode: 'open'`. Project authors opt into fail-closed per policy.                                                                     | Product + Engineering     | Resolved (compliance sign-off still pending)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 18  | **DECIDED 2026-05-15 (Oracle D-2):** Mobile / tablet entity multiselect (<768px viewport) is **out of scope for v1**. The multiselect is desktop-only. Narrower viewports render a full-height drawer with the same content. Documented as accepted gap.                                                                                                                                                                             | Product                   | Resolved                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 19  | **DECIDED 2026-05-15 (Oracle D-5):** Action message constraints: 500 chars max, plain text only (no Markdown — renderer support varies by channel), server-side HTML strip + UTF-8 enforcement + null-byte rejection. Client shows character counter; disables Save when over limit.                                                                                                                                                 | Engineering               | Resolved                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 20  | **DECIDED 2026-05-15 (Oracle D-6, NEW-C):** `validateRule()` pure helper extracted to `packages/shared/src/validation/guardrail-rule-validation.ts` and imported by both Studio (React) and Runtime (Express). Pattern: `packages/shared/src/validation/pii-pack-names.ts` (precedent from ABLP-921). Server-side route handler uses the same function as the client form — single source of truth.                                  | Engineering               | Resolved                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

---

## 12. Sign-off

| Role          | Owner  | Status                            |
| ------------- | ------ | --------------------------------- |
| Product       | Girish | Draft                             |
| Engineering   | TBD    | Pending                           |
| Design        | TBD    | Wireframes ready (companion file) |
| Compliance    | TBD    | Pending                           |
| Documentation | TBD    | Pending                           |
