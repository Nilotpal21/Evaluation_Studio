# Feature: Guardrails — Sensitive Data Block

**Doc Type**: SUB-FEATURE
**Parent Feature**: [Guardrails](../guardrails.md)
**Status**: ALPHA
**Feature Area(s)**: `governance`, `enterprise`, `customer experience`
**Package(s)**: `apps/studio`, `apps/runtime`, `packages/database`, `packages/shared`, `packages/i18n`
**Owner(s)**: Product — Girish; Eng — TBD
**Testing Guide**: `../../testing/sub-features/guardrails-sensitive-data-block.md`
**Last Updated**: 2026-05-18

---

## 1. Introduction / Overview

### Problem Statement

Studio today exposes PII configuration on **two screens with overlapping names and partially overlapping action vocabularies**:

- **Settings → PII Protection** — project-level vault-backed detection + tokenization. Render modes per consumer: `original` / `masked` / `redacted` / `tokenized` / `random`. Reversible — agent retains the ability to use real values for tool calls via vault restoration.
- **Guardrails → Create Policy → "PII Protection" preset** — per-policy rule with action `block` / `warn` / `redact`. The `redact` action here is destructive string replacement and breaks tool calls.

Three additional latent defects in the Guardrails surface compound the duplication:

1. A guardrail policy can be toggled "Active" with zero enabled rules — "Active" is a meaningless badge.
2. A rule can be toggled "enabled" while required fields are missing — silent runtime no-op.
3. The `builtin-pii` provider treats PII as a monolithic category — there is no way to say "block SSNs only."

Five customer journeys (PRD §2) all end in misconfiguration: project owner breaks her agent's tool calls (Journey A); compliance lead cannot express "refuse SSN" in Settings and wanders into Guardrails (Journey B); AI engineer enables both surfaces and double-strips data (Journey C); project owner activates an empty policy that does nothing (Journey D); compliance lead wants entity-level granularity but gets monolithic blocking (Journey E).

### Goal Statement

Establish two **sharply distinct** PII surfaces: **Guardrails for "stop"** (block / escalate / warn) and **Settings for "handle"** (mask / tokenize / render-per-consumer). Eliminate name and action collisions. Make every "Active" policy meaningfully enforce something. Make every "enabled" rule complete enough to evaluate. Give compliance leads entity-level granularity backed by the ABLP-921 recognizer registry.

### Summary

This feature renames the Guardrails `pii_protection` preset to **Sensitive Data Block**, restricts its action vocabulary to `block` / `warn` / `escalate` (removing the destructive `redact`), and exposes entity-level selection backed by the project's enabled PII recognizer packs. It introduces two integrity gates — a policy cannot be activated without ≥1 enabled rule, and a rule cannot be enabled without all required fields populated. The policy list previews enabled rules inline (green-dot chips), and disabling the last enabled rule on an active policy auto-deactivates with a 5-second Undo toast. A first-run decision matrix modal teaches the "stop vs. handle" mental model, cross-link banners thread between Guardrails and Settings → PII Protection, and a pre-deploy cleanup script removes tester data from existing policies. Pre-launch posture (no customers) eliminates migration debt.

---

## 2. Scope

### Goals

1. Customers can predict which screen (Guardrails vs Settings) to use for any PII task in **<5 seconds**, without reading docs.
2. The two surfaces share **no overlapping action verb** — Guardrails owns `block`/`warn`/`escalate`; Settings owns `mask`/`tokenize`/`redacted`-render-mode/`random`.
3. "Active" on a guardrail policy **always** means at least one rule is enforced (FR-7).
4. "Enabled" on a rule **always** means every required field is populated (FR-8).
5. The policy list previews enabled rules at-a-glance with green-dot chips (FR-9).
6. Sensitive Data Block expresses intent at entity granularity (e.g., "block SSNs only" vs "block all PII") backed by the project's enabled PII recognizer packs (FR-6).
7. Preserve the two distinct enforcement personas the dual surface serves today: project-level gate (Guardrails) and project-level handler (Settings → PII Protection).
8. Ship pre-launch — zero customer-facing migration debt.

### Non-Goals (Out of Scope)

1. Unifying Guardrails and Settings → PII Protection into one screen (Bedrock-style). Rejected in ADR §5.4.
2. Removing Guardrails PII enforcement entirely (Azure-style with no PII guardrail). Rejected in ADR §5.1.
3. Changing the underlying detection engine (`pii-detector.ts`, `PIIRecognizerRegistry`) or vault model.
4. Changing how Settings → PII Protection behaves beyond adding a 90-day-TTL cross-link banner.
5. Third-party PII provider integrations (Microsoft Presidio, AWS Comprehend Medical). Schema is forward-compatible (`entities: string[]` uses canonical IDs) but no provider is wired.
6. Mobile/tablet (<768px viewport) entity multiselect optimization. Configuration flow is desktop-first.
7. Pricing/packaging gating (e.g., tenant-wide enforcement as paid tier). No wedge documented.
8. Auto-open onboarding tour beyond the decision matrix modal (a broader wizard is deferred to post-MVP).

---

## 3. User Stories

Personas: **Compliance Lead** (regulatory mandate owner) and **AI Engineer** (configurer) are **co-equal primary personas**. **Project Owner** (operator) and **Tenant Admin** (cross-project policy author) are secondary.

1. As a **Compliance Lead** in a regulated industry (HIPAA / PCI / GDPR), I want to configure a guardrail policy that refuses any conversation message containing specific PII types (e.g., SSN), so that I can demonstrate enforcement to auditors without relying on after-the-fact tokenization.

2. As an **AI Engineer** building a customer-care agent, I want to enable PII tokenization in Settings (so my agent can still use real values for CRM tool calls) **and** a Guardrails rule that blocks SSN-only messages (because we don't support SSN-based identity verification on this channel), so that the agent works end-to-end without leaking sensitive data.

3. As a **Project Owner** auditing my agent's safety posture, I want to look at the Guardrails Policies list and see which rules are enforced for each policy at a glance, so that I never confuse an "Active" but empty policy for actual protection.

4. As an **AI Engineer** building a new agent, I want the Guardrails policy form to refuse activation of an empty policy and refuse enabling an incomplete rule, so that I cannot accidentally ship a policy that does nothing.

5. As a **Tenant Admin** managing 30+ projects under a single tenant, I want to create a tenant-scoped policy with a Sensitive Data Block rule that all projects inherit, so that I can enforce baseline PII blocking without configuring every project individually.

6. As a **Compliance Lead** facing a quarterly audit, I want a cross-link from Settings → PII Protection to the Guardrails screen (and back) that re-surfaces if I have not seen it in 90 days, so that I am reminded of the gate-vs-handle distinction even after dismissing the banner during initial setup.

7. As a **First-Time User** landing on either Guardrails or Settings → PII Protection, I want a decision matrix that explicitly tells me which screen to use for any PII task, so that I do not have to deduce the platform's mental model from interaction.

---

## 4. Functional Requirements

### 4.1 Rename + action vocabulary

- **FR-1.1** The Guardrails preset key `pii_protection` MUST be renamed to `sensitive_data_block` in `GuardrailPolicyForm.tsx` and all i18n keys (`guardrails.preset.piiProtection` → `guardrails.preset.sensitiveDataBlock`). The Settings nav key `pii_protection` in `apps/studio/src/config/navigation.ts` is unrelated and MUST NOT be renamed.
- **FR-1.2** The Sensitive Data Block row UI MUST expose action options `block`, `warn`, `escalate` only. `redact` MUST be hidden from this preset's UI (custom rules retain the full enum).
- **FR-1.3** Default action for the preset MUST be `block`. Default `enabled` state MUST be `false`.
- **FR-1.4** Inline helper text (always visible, not behind tooltip) MUST be displayed under the row: _"Stops requests containing PII outright. To anonymize or tokenize PII while keeping the agent working, configure under Settings → PII Protection."_ The link MUST navigate within the same project context.

### 4.2 Cross-link banner on Settings → PII Protection

- **FR-2.1** A dismissible info banner MUST be rendered at the top of `Settings → PII Protection`: _"Need to block requests containing PII outright? Create a Guardrail Policy with a Sensitive Data Block rule. → Configure now"_
- **FR-2.2** Banner CTA MUST open the Create Guardrail Policy dialog with the Sensitive Data Block row pre-expanded.
- **FR-2.3** Banner dismissal MUST be persisted in `localStorage` as `{dismissedAt: <epoch_ms>}`. The banner MUST re-surface 90 days after dismissal. On render, check `Date.now() - dismissedAt > 90 * 24 * 60 * 60 * 1000`.

### 4.3 Decision matrix modal

- **FR-3.1** A first-visit modal MUST open automatically on the first visit (per user) to **either** Guardrails policy form **or** Settings → PII Protection, displaying the decision matrix (§8 — "Mental Model" table). Dismissal MUST be persisted in `localStorage` (`decision-matrix-dismissed: <epoch_ms>`); the modal MUST NOT re-open after first dismissal in the same browser profile.
- **FR-3.2** A `?` icon adjacent to the Sensitive Data Block preset row AND adjacent to the Settings → PII Protection page title MUST provide repeat access to the decision matrix.
- **FR-3.3** The modal MUST satisfy WCAG APG dialog pattern: focus trap, `Escape` to close, `role="dialog"`, `aria-modal="true"`, `aria-labelledby` pointing to the modal title.
- **FR-3.4** All matrix content MUST be i18n-keyed under `guardrails.help.sensitiveDataBlock` and `settings.help.piiProtection`.

### 4.4 Telemetry rename

- **FR-4.1** Guardrail evaluation traces today tag rule category as `pii`. Trace tags MUST be renamed to `sensitive_data_block`. Pre-commit, an engineering audit MUST grep `apps/studio/src/components/analytics/` for `pii` tag references. If references exist, dual-emit for one release cycle; otherwise clean cutover.
- **FR-4.2** Studio analytics dashboards that filter by guardrail rule category MUST be updated to the new tag.

### 4.5 Schema & runtime

> **Schema reality check (Round 3 audit reconciliation)**: The Mongoose `IGuardrailRule` in `packages/database/src/models/guardrail-policy.model.ts` does NOT currently have `enabled`, `presetKey`, or a typed `action` string-enum. Studio's `RuleData` UI type has these locally and round-trips them via the form's `passthroughRules` pass-through mechanism. This feature surfaces and tightens these de-facto contracts. See §9 Data Model "Schema vs. Studio-Form Field Mapping" for the canonical correspondence.

- **FR-5.1** Studio's preset-row UI vocabulary uses a string `action` enum (`block | warn | redact | escalate`) — the source of truth for this is `createPresetRules()` in `GuardrailPolicyForm.tsx` and the `RuleData['action']` type in `RuleCard.tsx`. The Mongoose `IGuardrailRule.action` is typed as `Record<string, unknown>` (Mixed). In practice the persisted value is the form's string. This feature does **not** widen or narrow either type; it only restricts which of those four values the Sensitive Data Block _preset_ row exposes in the UI (FR-1.2). The persisted action string for an SDB-preset rule MUST be one of `block | warn | escalate`.
- **FR-5.2** `IGuardrailRule` MUST gain an optional field `entities?: string[]` storing canonical entity IDs (e.g., `us_ssn`, `credit_card`). Default = `undefined` (treated as "all entities" at runtime, but the policy editor refuses to enable a preset rule with no entities — FR-8.1).
- **FR-5.3** `IGuardrailRule` MUST gain optional fields `presetKey?: string`, `enabled?: boolean` (no Mongoose default — `undefined` until explicitly set; resolver/gate predicate is `enabled !== false`, preserving backward compatibility for legacy rules), and `actionMessage?: string` (user-facing block message). The existing `kind` Mongoose enum (`'input' | 'output' | 'tool_input' | 'tool_output' | 'handoff'`) is **unchanged**. The Studio "Applies To" checkboxes that produce a UI value of `'both'` are a form-level convenience: `serializeRule()` in `GuardrailPolicyForm.tsx` (L504-508) and `normalizeRules()` in `apps/runtime/src/routes/guardrail-policies.ts` (L538-543) both already expand `kind: 'both'` into two persisted rules (`{ kind: 'input' }` + `{ kind: 'output' }`) before write. **No schema enum change** — and no new schema value introduced — so dead-letter documents with `kind: 'both'` persisted directly cannot occur (the pipeline filter at `packages/compiler/src/platform/guardrails/pipeline.ts` L493 matches `g.kind === kind` for one of the 5 enum values, never `'both'`).
- **FR-5.4** The settings interface name is `IGuardrailSettings` (not `IGuardrailPolicySettings`). It already declares `failMode: 'open' | 'closed'`. Two changes are required by this feature:
  (a) the **schema default** in `GuardrailSettingsSchema` (`packages/database/src/models/guardrail-policy.model.ts` L194) MUST be changed from `'closed'` to `'open'` so newly created policies adopt the voice-safe default; and
  (b) `failMode` MUST be exposed per-policy via the Sensitive Data Block UI with a consequence disclosure (see FR-6.7). Pre-launch posture means no migration is needed for existing rows.

### 4.6 Sensitive Data Block — entity selection

- **FR-6.1** The Sensitive Data Block row UI MUST render a **quick-preset radio** with three options: `High-risk only` (default), `All PII`, `Custom`. Below the radio, a **scrollable entity list** MUST render all entities returned from `GET /api/projects/:projectId/pii-entities`, grouped by pack with tier badges (1/2/3) per entity.
- **FR-6.2** `High-risk only` preset MUST pre-select **SSN only** as the default. The "high-risk group" (the candidate pool visible under this preset) comprises: `us_ssn`, `credit_card`, `bank_account`, `us_passport`, `us_drivers_license`, `iban`.
- **FR-6.3** `All PII` preset MUST select every entity currently returned by the catalog endpoint (project's enabled packs only).
- **FR-6.4** Detection runs across all entities; the rule MUST trigger only when an entity in the rule's `entities` list matched with confidence ≥ threshold. Empty `entities` array (defensive default) MUST trigger no match.
- **FR-6.5** The rule MUST display `Applies To` checkboxes (Input / Output, both checked by default), `Confidence threshold` slider (0.0–1.0, default 0.7), and a multi-line `Action message` textarea (default copy: see FR-6.6).
- **FR-6.6** Default action message: _"This message contains information that cannot be processed in this channel. Please contact us through an alternative channel for further assistance."_ (Channel-neutral; does not imply user error.)
- **FR-6.7** A `failMode` selector (Open / Closed) MUST appear with disclosure copy: _"Fail-closed means requests are blocked if PII detection fails. Recommended for text channels. May disrupt voice calls."_ Default: Open.
- **FR-6.8** Provider field MUST render as a read-only label (`Built-in PII`) when `builtin-pii` is the only available provider. When third-party providers come online, this becomes a selector (out of scope for v1).
- **FR-6.9** Action message constraints: 500 char max; plain text only (no Markdown); server-side HTML strip + UTF-8 enforcement + null-byte rejection; client shows character counter and disables Save when over limit.

### 4.7 Policy-level activation gate

- **FR-7.1** The system MUST reject any attempt to set a policy to `active: true` unless the policy contains ≥ 1 rule with `enabled: true` AND that rule passes the rule-level enable gate (FR-8). Rejection happens client-side (toggle disabled) AND server-side (route returns `400 NO_ENABLED_RULES`); see FR-7.2, FR-7.3.
- **FR-7.2** The activation toggle in the policy list row MUST be disabled (greyed + tooltip _"Enable at least one rule to activate this policy"_) when the policy has zero enabled rules.
- **FR-7.3** `POST /api/projects/:projectId/guardrail-policies/:id/activate` MUST return `400 { success: false, error: { code: 'NO_ENABLED_RULES', message: <i18n> } }` when no rules are enabled. (HTTP method and param name verified against `apps/runtime/src/routes/guardrail-policies.ts` L1339.)
- **FR-7.4** If the user disables the last enabled rule on an active policy, the policy MUST be auto-deactivated with a 5-second Undo toast: _"Policy '{name}' was deactivated. The last enabled rule was disabled."_ Undo MUST re-enable the rule AND re-activate the policy atomically.
- **FR-7.5** Telemetry: emit `guardrail_activation_blocked` trace event with `reason: 'no_enabled_rules'` when the gate fires; emit `guardrail_auto_deactivation` with `{ policyId, ruleId, undone: boolean }` on auto-deactivation.

### 4.8 Rule-level enable gate

- **FR-8.1** The system MUST reject any attempt to set a rule to `enabled: true` unless every required field for its `checkType` is populated (table below uses Studio-form field names — see §9 Schema-vs-Form mapping for the Mongoose equivalents):

  | `checkType` | Required when `enabled === true`                                                                                                                          |
  | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `provider`  | `name`, `kind` (Applies To), `provider`, `category`, `action`, `severityThreshold`, `actionMessage`, AND (for `category === 'pii'`) `entities.length > 0` |
  | `cel`       | `name`, `kind`, `check` (CEL expression), `action`, `actionMessage`                                                                                       |
  | `llm`       | `name`, `kind`, `llmCheck` (prompt), `action`, `actionMessage`                                                                                            |

- **FR-8.2** Validation MUST be encapsulated in a single pure function `validateRule(rule): { valid: boolean; missingFields: string[] }` exported from `packages/shared/src/validation/guardrail-rule-validation.ts` and imported by both Studio (form UI) and Runtime (route handler).
- **FR-8.3** The rule card's enable toggle MUST be disabled (greyed + cursor not-allowed) when validation fails; tooltip MUST list missing fields by i18n-keyed name; an inline compact hint (`"N fields missing"`) MUST appear adjacent.
- **FR-8.4** `PUT /api/projects/:projectId/guardrail-policies/:id` MUST reject any rule with `enabled: true` and missing required fields, returning `400 { success: false, error: { code: 'RULE_INCOMPLETE', message: <i18n>, missingFields: string[] } }`. (HTTP method and param verified — the existing update route is `router.put('/:id', ...)` in `apps/runtime/src/routes/guardrail-policies.ts` L1132.)

### 4.9 Policy list — enabled-rule preview

- **FR-9.1** Each policy row in the Guardrails Policies list MUST render a horizontal list of green-dot chips for each enabled rule (chip: `● <RuleLabel>`).
- **FR-9.2** Disabled rules MUST NOT be previewed. Policies with zero enabled rules MUST show `⚠ No rules enabled — open editor to add` muted text + an info icon with tooltip _"Enable at least one rule to activate this policy."_
- **FR-9.3** For Sensitive Data Block chips, the chip label MUST include the first 2 selected entities as a sub-label: `● Sensitive Data Block · SSN, CC`. For >2, append `+N more`.
- **FR-9.4** Chip click MUST deep-link to the rule's expanded state inside the policy editor (`?ruleId=<id>` URL parameter consumed by the editor on mount).
- **FR-9.5** For policies with >4 enabled rules, render first 3 chips + `+N more` chip. Hover MUST reveal the full list.
- **FR-9.6** Responsive: chips appear right of the policy name on `≥1024px` viewports; below the name on narrower viewports. Status pill (Draft/Active) remains right-aligned.

### 4.10 Entity catalog endpoint

- **FR-10.1** A new route MUST be added: `GET /api/projects/:projectId/pii-entities`. Returns the list of PII entities AVAILABLE TO THIS PROJECT (filtered by enabled packs) as: `{ success: true, data: { entities: Array<{ id: string; label: string; pack: string; tier: 1|2|3; description?: string }> } }`.
- **FR-10.2** The Studio API proxy at `apps/studio/src/api/pii-entities.ts` MUST consume this endpoint via `apiFetch`. Cache via SWR with `revalidateOnFocus: false` (catalog is stable per project session).
- **FR-10.3** Auth: requires `requireAuth` middleware + a project-scope permission (`pii-pattern:read` or equivalent — match the existing pattern from `pii-detection.md` §8 API table).
- **FR-10.4** If a saved rule references an entity ID NOT in the catalog (because the pack was later disabled), the policy editor MUST display a warning on the rule card: _"This rule references entities from a disabled pack: {ids}. Re-enable the pack in Settings → PII Protection or remove them from this rule."_ The runtime evaluator MUST silently skip unknown entities (other selected entities continue to match).

---

## 5. Feature Classification & Integration Matrix

### Lifecycle / Platform Impact

| Area                       | Impact Level | Notes                                                                                             |
| -------------------------- | ------------ | ------------------------------------------------------------------------------------------------- |
| Project lifecycle          | SECONDARY    | Project-scoped policies; no project lifecycle change                                              |
| Agent lifecycle            | SECONDARY    | Agent-scoped policies still supported via `IGuardrailPolicyScope.type === 'agent'`; no DSL change |
| Customer experience        | PRIMARY      | Action message + block behavior is end-user visible                                               |
| Integrations / channels    | SECONDARY    | Channel-agnostic; voice fail-mode disclosure                                                      |
| Observability / tracing    | PRIMARY      | Trace tag rename; new auto-deactivation + activation-blocked events                               |
| Governance / controls      | PRIMARY      | Core feature area — PII enforcement is governance                                                 |
| Enterprise / compliance    | PRIMARY      | Compliance Lead is a co-primary persona                                                           |
| Admin / operator workflows | SECONDARY    | Tenant admins can author tenant-scoped Sensitive Data Block rules                                 |

### Related Feature Integration Matrix

| Related Feature                                                          | Relationship                     | Why It Matters                                                                                                                                                                    | Key Touchpoints                                                                                     | Current State                                |
| ------------------------------------------------------------------------ | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| [Settings → PII Protection](../pii-detection.md)                         | shares data with / configured by | Settings is the canonical "handle" surface; Sensitive Data Block is the canonical "stop" surface — together they cover the PII lifecycle. Settings packs gate the entity catalog. | Cross-link banner; project-level pack-enable state; shared detection engine                         | STABLE                                       |
| [PII Tiered Recognizers (ABLP-921)](pii-detection-tiered-recognizers.md) | depends on                       | Provides the 37-entity catalog with tier + confidence metadata that the multiselect renders                                                                                       | `GET /api/projects/:projectId/pii-entities` data source; `BuiltinPIIProvider` consumes the registry | BETA                                         |
| [Guardrails (parent)](../guardrails.md)                                  | extends                          | Sensitive Data Block is one of four preset rule categories in the Guardrails policy model                                                                                         | Policy schema; pipeline factory; tier-1 evaluator; trace events                                     | STABLE (parent) / PLANNED (this sub-feature) |

---

## 6. Design Considerations

- **Wireframes** (12 screens, side-by-side before/after): `docs/features/sub-features/guardrails-sensitive-data-block.wireframes.html` — covers preset rename, expanded action selector, Settings banner, decision matrix modal, helper text close-up, empty state, customer journeys replay, policy list chip preview, disabled-activation tooltip, entity multiselect, rule enable gate, auto-deactivation toast.
  - **Known wireframe update needed (resolved in this round)**: Entity-multiselect screen (#10) shows static copy "All 37 entities across 8 packs" / "Showing 11 of 37 entities" from a pre-Pass-2 draft. After Oracle Pass 2 decision NEW-A, the catalog is project-scoped + filtered to enabled packs. Implementers MUST render entity count dynamically as `Showing {visible} of {N} entities` where `N` is the catalog response length for the current project; the `All PII` preset description MUST read `All entities from your enabled packs`. Wireframe HTML will be updated in the same commit that lands this spec revision.
- **ADR** (architectural decision record + steelman analysis): `docs/architecture/2026-05-14-guardrails-pii-separation-adr.md` — codifies the "stop vs. handle" model, the rejected alternatives (full unification, full removal, layered with redact in both places), and the competitive landscape (Bedrock unified, Azure separated).
- **Component refactors**:
  - New: `EntityMultiselect.tsx` (Studio) — quick-preset radio + scrollable entity list with pack-grouping + tier badges
  - New: `DecisionMatrixModal.tsx` (Studio) — reusable modal opened from `?` icon or first-run
  - New: `FailModeSelector.tsx` (Studio) — fail-open vs fail-closed selector with disclosure
- **Accessibility**: decision matrix modal must meet WCAG APG dialog pattern (focus trap, Escape, `role=dialog`, `aria-modal`, `aria-labelledby`). All form controls must have label associations. Tooltips on disabled toggles must be screen-reader-accessible via `aria-describedby` (not visual-only).
- **Design tokens**: Action badges use existing palette — `block` (red `#dc2626`), `warn` (amber `#f59e0b`), `escalate` (blue `#1e40af`), all on light backgrounds. Green dots for enabled-rule chips use `#16a34a`.

---

## 7. Technical Considerations

- **Dependencies**:
  - ABLP-921 (PR #926, BETA) — recognizer registry MUST expose entity metadata for the catalog endpoint. Verified: `packages/compiler/src/platform/security/recognizer-packs/` has the data; the runtime route imports from there.
  - Existing guardrail pipeline (`apps/runtime/src/services/guardrails/`) — post-detection entity filter is the only runtime evaluator change. Detection itself is unchanged.
  - Existing `failMode` mechanism (`packages/compiler/src/platform/guardrails/pipeline.ts` L597–598) — already supports `'open' | 'closed'`; this feature (a) **changes the schema default** in `GuardrailSettingsSchema` (`packages/database/src/models/guardrail-policy.model.ts` L194) from `'closed'` to `'open'` for new policies (voice-channel-safe default; pre-launch posture = no migration debt), and (b) exposes the field per-policy in the Sensitive Data Block UI with consequence disclosure (FR-6.7).
- **Decision: shared validation function (Oracle D-6).** `validateRule()` lives in `packages/shared/src/validation/guardrail-rule-validation.ts` (precedent: `packages/shared/src/validation/pii-pack-names.ts` from ABLP-921). Studio form imports from there; runtime route handler imports the same function. Single source of truth for completeness checks.
- **Decision: clean cutover for telemetry tag (Oracle D-7).** Pre-commit grep of `apps/studio/src/components/analytics/` for `pii` tag references. If empty: rename to `sensitive_data_block` in one cycle. If non-empty: dual-emit for one release; cut over after.
- **Decision: no feature flag (PRD §6.1).** Pre-launch posture (no customers). The pre-deploy cleanup script (`tools/cleanup-pii-guardrail-presets.ts`) removes existing tester `pii_protection: redact` rules. Idempotent + dry-run + `--confirm` gate.
- **Decision: no schema migration script.** New `IGuardrailRule` fields (`entities?`, `enabled?`, `presetKey?`, `actionMessage?`) are all optional. Existing rules without them continue to behave as today (no entity filter; `enabled` treated as `false` until reset via UI; no presetKey association; no custom message). `kind` enum is unchanged on the schema; existing rules without `kind` remain `undefined` and are evaluated by the pipeline against the current evaluation kind via the pre-existing `g.kind === kind` filter (pipeline.ts L493).
- **Sequencing recommendation**: shared validation function FIRST (blocks both Studio form and runtime route changes); entity catalog endpoint SECOND (blocks multiselect UI); UI components THIRD; cleanup script LAST (pre-deploy).

---

## 8. How to Consume

### Studio UI

| Surface                                 | Path / Route                                   | Role expected                               | Entry points                                                                 |
| --------------------------------------- | ---------------------------------------------- | ------------------------------------------- | ---------------------------------------------------------------------------- |
| **Guardrails Policies list**            | `/projects/:projectId/guardrails-config`       | Project owner, AI engineer, compliance lead | Add Policy button → Create dialog; row chip click → rule editor              |
| **Create/Edit Guardrail Policy dialog** | (modal)                                        | Project owner, AI engineer                  | Sensitive Data Block preset row; expand to see entity multiselect + failMode |
| **Settings → PII Protection**           | `/projects/:projectId/settings/pii-protection` | Project owner, AI engineer, compliance lead | Cross-link banner → Guardrails; "?" icon → decision matrix                   |
| **Decision matrix modal**               | (overlay)                                      | All personas                                | First-run auto-open; "?" icon repeat access                                  |

### Mental Model — Decision Matrix (canonical)

| What I want                                                            | Go to                                        |
| ---------------------------------------------------------------------- | -------------------------------------------- |
| Hide PII from the LLM but still let the agent use it (tool calls work) | Settings → PII Protection                    |
| Mask PII in agent responses to end users                               | Settings → PII Protection                    |
| Reversibly tokenize PII (vault-backed)                                 | Settings → PII Protection                    |
| Audit every PII detection event                                        | Settings → PII Protection                    |
| **Block** messages containing specific PII types outright              | Guardrails → Sensitive Data Block            |
| **Escalate** to a human when PII confidence is high                    | Guardrails → Sensitive Data Block            |
| Enforce PII blocking across all projects in a tenant                   | Guardrails (tenant-level policy inheritance) |

### Surface Semantics Matrix

| Asset / Entity Type                    | Source of Truth                                                                       | Design-Time Surface                                                     | Editable?                                                                           | Consumer Reference                                               | Runtime Materialization                                                                | Notes                                                                                                                 |
| -------------------------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `IGuardrailRule.entities[]`            | Per-policy in `guardrail_policies` collection                                         | Sensitive Data Block multiselect                                        | Yes (project owner)                                                                 | Stored as `string[]` of canonical entity IDs                     | Runtime evaluator filters detection results post-detection by membership in this array | Empty array = no match (defensive). Unknown ID = silently skipped + warning surfaced in policy editor when re-opened. |
| Entity catalog (37 entities, 8 packs)  | `packages/compiler/src/platform/security/recognizer-packs/`                           | `EntityMultiselect.tsx` via `GET /api/projects/:projectId/pii-entities` | Read-only (Engineering owns the registry)                                           | Stored as canonical IDs in rule schema                           | Recognizer registry resolves IDs to runtime recognizer functions                       | Project-scoped: filtered by enabled packs. Cached SWR per project session.                                            |
| Sensitive Data Block preset definition | `apps/studio/src/components/guardrails/GuardrailPolicyForm.tsx` (`createPresetRules`) | Form preset rows                                                        | Hidden from user (the preset _generates_ a rule; the user edits the resulting rule) | Stored as a single rule with `presetKey: 'sensitive_data_block'` | Rule is a normal `IGuardrailRule` at runtime; preset key is metadata only              | Renaming this preset is the one preset-key change in this feature.                                                    |
| Decision matrix content                | i18n keys (`guardrails.help.sensitiveDataBlock`, `settings.help.piiProtection`)       | `DecisionMatrixModal.tsx`                                               | Internal (Product / Docs)                                                           | i18n bundle                                                      | Not runtime-relevant                                                                   | Authored once; translatable.                                                                                          |

### Design-Time vs Runtime Behavior

- **Design-time only**: the four-preset taxonomy (Content Safety / Sensitive Data Block / Prompt Injection / Topic Restriction); preset keys; helper text; decision matrix; banner; chips on the policy list; tooltips on disabled toggles.
- **Runtime only**: post-detection entity filter; `failMode` evaluation on detector failure; auto-deactivation when last rule disabled; trace events; action-message string returned to the user.
- **Both**: rule schema fields (`entities`, `kind`, `actionMessage`, `presetKey`, `enabled`) and the `IGuardrailSettings.failMode` field — authored at design time, evaluated at runtime.

### API (Runtime)

| Method       | Path                                                                                                                                                                                                                                                                                                                                               | Purpose                                                                                                                                                                       |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`        | `/api/projects/:projectId/pii-entities`                                                                                                                                                                                                                                                                                                            | Returns project's enabled entity catalog (filtered by enabled packs). New route added by this feature.                                                                        |
| `POST`       | `/api/projects/:projectId/guardrail-policies`                                                                                                                                                                                                                                                                                                      | Create policy. Existing — extended to accept `entities`, `kind`, `actionMessage` on rules; validate via shared `validateRule()`.                                              |
| `PUT`        | `/api/projects/:projectId/guardrail-policies/:id`                                                                                                                                                                                                                                                                                                  | Update policy / rules. Existing route (`router.put('/:id', ...)` at L1132). Extended to enforce FR-8 (RULE_INCOMPLETE rejection).                                             |
| `POST`       | `/api/projects/:projectId/guardrail-policies/:id/activate`                                                                                                                                                                                                                                                                                         | Activate. Existing route (`router.post('/:id/activate', ...)` at L1339). Extended to enforce FR-7 (NO_ENABLED_RULES rejection) and to handle auto-deactivation Undo (FR-7.4). |
| Trace events | NEW: `guardrail_activation_blocked`, `guardrail_auto_deactivation`. EXTENDED: existing `guardrail_input_blocked` and `guardrail_output_blocked` (emitted at `apps/runtime/src/services/execution/reasoning-executor.ts` L1904 + L3485) gain optional `presetKey?: string` field. Filter for SDB events via `presetKey === 'sensitive_data_block'`. | New (2) + Extended (2).                                                                                                                                                       |

### API (Studio — proxy)

| Method | Path                                                      | Purpose                                                                                    |
| ------ | --------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `GET`  | `/api/projects/:projectId/pii-entities` (proxy → runtime) | Studio fetches from `apps/studio/src/api/pii-entities.ts`; SWR-cached per project session. |

### Admin Portal

No changes. Tenant-scoped guardrail policies remain authored via the existing admin flow.

### Channel / SDK / Voice / A2A / MCP Integration

- **Channel-agnostic**: detection + rule evaluation runs identically across channels (`docs/features/pii-detection.md` §8). Streaming evaluation (voice) is handled by the existing `StreamingGuardrailEvaluator` with `earlyTermination` semantics — no new logic needed.
- **Voice consideration (FR-6.7)**: the `failMode` selector defaults to `open` because fail-closed mid-call would drop voice conversations on detector transient failures (HIPAA / 911-adjacent risk). Policy authors who want fail-closed (text-only deployments) opt in per-policy with disclosure.
- **No SDK contract change**: external SDKs do not reference the `pii_protection` preset key (verified by Oracle audit).

---

## 9. Data Model

### Collections / Tables

```text
Collection: guardrail_policies (existing; field additions)

IGuardrailRule (existing Mongoose interface — packages/database/src/models/guardrail-policy.model.ts L35-50):
Existing fields (UNCHANGED by this feature):
  - guardrailName: string                                   // required
  - override: 'disable' | 'threshold' | 'action' | 'severity_actions' | 'define'  // required
  - threshold?: number
  - action?: Record<string, unknown>                        // Mixed; in practice a string in Studio rules
  - severityActions?: Record<string, unknown>
  - tier?: 'local' | 'model' | 'llm'
  - provider?: string
  - category?: string
  - check?: string
  - llmCheck?: string
  - description?: string
  - priority?: number
  - message?: string

Existing field (UNCHANGED by this feature):
  - kind?: 'input' | 'output' | 'tool_input' | 'tool_output' | 'handoff'   // 'both' is form-level only; expanded to input + output before persistence in serializeRule() / normalizeRules()

NEW fields added by this feature:
  - presetKey?: string                                      // e.g., 'sensitive_data_block'
  - enabled?: boolean                                       // no Mongoose default (undefined); today this is form-only — promote to schema; resolver/gate uses `enabled !== false`
  - entities?: string[]                                     // canonical PII entity IDs
  - actionMessage?: string                                  // user-facing block message (500 char max, plain text)

IGuardrailSettings (existing — same model file L66-72):
  - failMode: 'open' | 'closed'                             // already declared; schema DEFAULT changes 'closed' → 'open'
  - timeouts: { local, model, llm }                         // unchanged
  - webhookUrl?, webhookSecret?                             // unchanged
  - streaming: IGuardrailStreamingSettings                  // unchanged

Existing indexes on guardrail_policies (UNCHANGED, verified at L270-282):
  - { tenantId:1, name:1, 'scope.type':1, 'scope.projectId':1, 'scope.agentDefId':1 } (unique compound)
  - { tenantId:1, 'scope.projectId':1, status:1 }
  - { tenantId:1, 'scope.agentDefId':1 }
  - { tenantId:1, isActive:1 }
```

### Schema vs. Studio-Form Field Mapping (canonical correspondence)

The Studio form (`GuardrailPolicyForm.tsx` `createPresetRules()` + `RuleCard.tsx` `RuleData`) uses a UI-shaped type that does not match the Mongoose schema field-for-field. The form persists unknown keys via a `passthroughRules: Record<string, unknown>[]` pass-through. This feature promotes several of those form-only concepts into first-class schema fields.

| Studio form field (`RuleData`)                                                                               | Mongoose field (`IGuardrailRule`)           | Status after this feature                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------ | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`                                                                                                       | `guardrailName`                             | Form `name` writes to schema `guardrailName` on save (existing form mapping; this feature unchanged)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `checkType` (`'provider' \| 'cel' \| 'llm'`)                                                                 | (no direct field; tier + override inferred) | Form-only concept that maps to runtime evaluator selection (`tier`); not stored as `checkType` in schema                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `enabled` (form-only today; omitted from API payload when `false`)                                           | `enabled?: boolean`                         | **NEW schema field added by this feature**. Implementation note: `serializeRule()` currently early-returns `[]` for `rule.enabled === false` (L460-462 in `GuardrailPolicyForm.tsx`), so disabled rules never reach the server. Promoting to schema requires changing `serializeRule()` to serialize disabled rules with `enabled: false` so the activation gate (FR-7.1) and the auto-deactivation flow (FR-7.4) can count them, AND adding `'enabled'` to `FORM_SUPPORTED_RULE_KEYS` so the form can hydrate disabled rules from the server response instead of routing them to `passthroughRules`. |
| `kind` (UI uses `'input' \| 'output' \| 'both'`)                                                             | `kind` (5-value Mongoose enum)              | Same field name; **no schema change**. `'both'` is form-only convenience: both `serializeRule()` (Studio L504-508) and `normalizeRules()` (runtime L538-543) already expand `'both'` → two persisted rules (`'input'` + `'output'`) before write                                                                                                                                                                                                                                                                                                                                                      |
| `provider`, `category`, `check`, `llmCheck`, `threshold`, `action`, `message`                                | Same names                                  | Unchanged                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `entities` (form addition)                                                                                   | `entities?: string[]`                       | **NEW schema field added by this feature**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `actionMessage` (form addition)                                                                              | `actionMessage?: string`                    | **NEW schema field added by this feature**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `presetKey` — **not present today** (no form field, no schema field, no passthrough usage; verified by grep) | `presetKey?: string`                        | **NEW schema field added by this feature**. Implementer must introduce the key in `RuleData`, in each preset entry of `createPresetRules()`, in `serializeRule()`'s output, and add `'presetKey'` to `FORM_SUPPORTED_RULE_KEYS`.                                                                                                                                                                                                                                                                                                                                                                      |

Implementers MUST read this table before touching either the schema or the form. The FR-8.1 required-fields matrix uses **Studio-form field names** because that is the surface the validation logic guards (the same `validateRule()` is shared by the form and the runtime route handler).

### Key Relationships

- `IGuardrailRule.entities[]` → references canonical entity IDs in `packages/compiler/src/platform/security/recognizer-packs/`. No foreign-key enforcement at the schema level; the policy editor validates membership against the project's enabled-pack catalog at save time.
- `IGuardrailSettings.failMode` → consumed by `packages/compiler/src/platform/guardrails/pipeline.ts` L597-598. Existing field; this feature changes its schema default and exposes it in UI.
- Pack-enable state lives in `project_runtime_configs.pii_redaction.packs` (Settings → PII Protection ownership). Sensitive Data Block READS this state via the catalog endpoint; it does NOT write to it.

---

## 10. Key Implementation Files

### Domain / Core Logic

| File                                                                  | Purpose                                                                                                        | Status  |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------- |
| `packages/shared/src/validation/guardrail-rule-validation.ts`         | Pure `validateRule(rule): { valid, missingFields }` function shared by Studio + Runtime                        | SHIPPED |
| `packages/compiler/src/platform/guardrails/providers/builtin-pii.ts`  | Post-detection entity filter — narrows detection results to the rule's `entities` array before scoring         | SHIPPED |
| `packages/compiler/src/platform/security/recognizer-packs/catalog.ts` | Entity catalog aggregator — `listEnabledPIIEntities()` across 8 pack files                                     | SHIPPED |
| `packages/compiler/src/platform/guardrails/tier2-evaluator.ts`        | Projects `Guardrail.entities` into `context.allowedEntityTypes` for the provider                               | SHIPPED |
| `packages/compiler/src/platform/guardrails/types.ts`                  | Extended — `GuardrailViolation.presetKey` for trace-event correlation                                          | SHIPPED |
| `packages/compiler/src/platform/ir/schema.ts`                         | Extended — `Guardrail.entities` + `Guardrail.presetKey` on the IR interface                                    | SHIPPED |
| `apps/runtime/src/services/guardrails/policy-resolver.ts`             | Extended — `PolicyRule` type gains new fields; `toSyntheticGuardrail()` propagates `entities` + `presetKey`    | SHIPPED |
| `apps/runtime/src/services/execution/output-guardrails.ts`            | Extended — `OutputGuardrailResult.violation.presetKey` for trace propagation                                   | SHIPPED |
| `apps/runtime/src/services/execution/reasoning-executor.ts`           | Extended — emits `presetKey` on `guardrail_input_blocked` (L1904) and `guardrail_output_blocked` (L3485)       | SHIPPED |
| `packages/shared-kernel/src/constants/trace-event-registry.ts`        | Extended — `guardrail_activation_blocked` + `guardrail_auto_deactivation` registered (registry now 22 entries) | SHIPPED |
| `packages/database/src/models/guardrail-policy.model.ts`              | Extended — `entities?`, `enabled?`, `presetKey?`, `actionMessage?` on IGuardrailRule; `failMode` default flip  | SHIPPED |

### Routes / Handlers

| File                                                  | Purpose                                                                                                                                           | Status  |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| `apps/runtime/src/routes/pii-entities.ts`             | `GET /api/projects/:projectId/pii-entities` — project-scoped entity catalog                                                                       | SHIPPED |
| `apps/runtime/src/routes/guardrail-policies.ts`       | Extended — activation gate (`NO_ENABLED_RULES`), rule completeness gate (`RULE_INCOMPLETE`), auto-deactivation, `POST /:id/reactivate` undo route | SHIPPED |
| `apps/runtime/src/routes/guardrail-helpers.ts`        | Extracted shared helpers (`requireRouteScopePermission`, `getRouteScopeContext`, `buildScopedPolicyFilter`)                                       | SHIPPED |
| `apps/runtime/src/services/pii/project-pii-config.ts` | `getProjectPIIConfig()` — reads `pii_redaction.enabled_recognizer_packs` with in-process LRU cache                                                | SHIPPED |

### UI Components

| File                                                            | Purpose                                                                                            | Status  |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------- |
| `apps/studio/src/components/guardrails/GuardrailPolicyForm.tsx` | Extended — SDB preset with entity selection, action enum restriction, `serializeRule()` SDB branch | SHIPPED |

### Jobs / Workers / Background Processes

| File                                | Purpose                                                                                   | Status  |
| ----------------------------------- | ----------------------------------------------------------------------------------------- | ------- |
| `tools/cleanup-guardrail-traces.ts` | 90-day TTL cleanup job for SDB trace events in ClickHouse; `--dry-run` + `--confirm` gate | SHIPPED |

### Tests

| File                                                                              | Type        | Coverage Focus                                                                                                                                                 | Status             |
| --------------------------------------------------------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| `packages/shared/src/__tests__/validation/guardrail-rule-validation.test.ts`      | unit        | Pure `validateRule()` — 51 cases across 6 groups (A-F)                                                                                                         | SHIPPED            |
| `apps/studio/src/__tests__/components/guardrails/GuardrailPolicyForm.test.tsx`    | component   | Preset defaults, `kind: 'both'` expansion, disabled-rule round-trip                                                                                            | SHIPPED            |
| `apps/studio/src/__tests__/components/guardrails/preset-defaults.test.ts`         | unit        | SSN-only default preset, default action message copy                                                                                                           | SHIPPED            |
| `apps/studio/src/__tests__/lib/banner-ttl.test.ts`                                | unit        | 90-day TTL banner re-surface logic — file scaffolded with `it.todo` markers; implementation deferred with GAP-006 (PIIProtectionTab cross-link banner)         | it.todo / DEFERRED |
| `apps/runtime/src/__tests__/integration/guardrails/*.test.ts` (9 files)           | integration | Entity filter, validation, auto-deactivation race, RBAC, sanitization, failMode                                                                                | SHIPPED            |
| `apps/runtime/src/__tests__/execution/guardrails/policy-rbac.integration.test.ts` | integration | Extended with +33 SDB-specific RBAC cases                                                                                                                      | SHIPPED            |
| `apps/runtime/src/__tests__/e2e/sensitive-data-block.e2e.test.ts`                 | e2e         | E2E-1 (SSN block), E2E-2 (empty activation), E2E-3 (incomplete rule), E2E-4 (auto-deactivation), E2E-7 (failMode), E2E-8 (backward compat), E2E-14 (telemetry) | SHIPPED            |
| `apps/runtime/src/__tests__/e2e/sensitive-data-block-catalog.e2e.test.ts`         | e2e         | E2E-5 (catalog filtering), E2E-6 (cross-project isolation), E2E-15 (rate limit)                                                                                | SHIPPED            |
| `apps/runtime/src/__tests__/e2e/sensitive-data-block-tenant-scope.e2e.test.ts`    | e2e         | E2E-9 (tenant-scoped SDB policy inheritance)                                                                                                                   | SHIPPED            |
| `apps/runtime/src/__tests__/e2e/sensitive-data-block-api-bypass.e2e.test.ts`      | e2e         | E2E-11 (invalid rule enable bypass), E2E-12 (XSS bypass)                                                                                                       | SHIPPED            |
| `apps/studio/e2e/guardrails-sensitive-data-block.spec.ts`                         | Playwright  | E2E-10 (Studio Create Policy via UI)                                                                                                                           | SHIPPED            |
| `tools/__tests__/cleanup-guardrail-traces.test.ts`                                | tool/CLI    | CL-1 through CL-4 (dry-run, confirmed, idempotency, safety guard)                                                                                              | SHIPPED            |

---

## 11. Configuration

### Environment Variables

None — feature is fully configured per-policy via the schema.

### Runtime Configuration

- `IGuardrailSettings.failMode` — per-policy, `'open' | 'closed'`. Existing field; **schema default changes from `'closed'` to `'open'`** with this feature (FR-5.4). Exposed in Sensitive Data Block UI with consequence disclosure (FR-6.7).
- `project_runtime_configs.pii_redaction.enabled_recognizer_packs[]` — per-project enabled-pack list (read by the catalog endpoint via `getProjectPIIConfig()` at `apps/runtime/src/services/pii/project-pii-config.ts:143-144`; owned by Settings → PII Protection feature). NOT modified by this feature.

### DSL / Agent IR / Schema

- `IGuardrailRule.entities?: string[]` — additive field on the existing rule schema.
- `IGuardrailRule.kind?: 'input' | 'output' | 'tool_input' | 'tool_output' | 'handoff'` — unchanged from current schema. `'both'` is a form-level value only; not persisted (see FR-5.3).
- `IGuardrailRule.actionMessage?: string` — additive (500 char max enforced server-side).
- No ABL DSL change; rules are JSON-only.

---

## 12. Non-Functional Concerns

### Isolation & Multitenancy

| Concern           | Requirement / Expectation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Project isolation | All guardrail-policy routes (`/api/projects/:projectId/guardrail-policies/...`) use the existing `requireRouteScopePermission(req, res, context, 'guardrail:read' \| 'guardrail:write')` helper (locally defined in `apps/runtime/src/routes/guardrail-policies.ts` L96-106). Read routes use `guardrail:read`; write/activate/delete routes use `guardrail:write` (single bundled permission today — see HLD §4 concern #4 for the deferred `guardrail:activate` split). The new entity catalog route uses `pii-pattern:read` per FR-10.3. Cross-project access returns 404. Catalog filters by the requesting project's enabled packs (FR-10.1). |
| Tenant isolation  | Guardrail policies are tenant-scoped at the schema level (`tenantId` required + indexed). Tenant admins can author tenant-scoped policies that all projects inherit (existing capability, preserved).                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| User isolation    | Guardrail policies are project-resources, not user-resources. No `createdBy` filter required. `createdBy` is recorded for audit purposes only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

### Security & Compliance

- **Action message XSS mitigation**: stored as plain text, server-strips HTML on save, rendered with React's default escaping in Studio. Channel renderers (chat, voice TTS, A2A) MUST treat the action message as untrusted text. Validate length (≤500), reject null bytes, enforce UTF-8.
- **Pre-launch audit log requirement**: Sensitive Data Block evaluation triggers emit `GuardrailTraceEvent` only (matches existing Content Safety / Prompt Injection pattern). Compliance audit logging for block events is a deferred decision pending compliance sign-off (see §16 GAP-002).
- **Encryption**: rule data (including `actionMessage`) inherits MongoDB-at-rest encryption from the platform. No new secrets.
- **Compliance terminology**: see Critical Feature Gate §12.7.

### Performance & Scalability

- **Tier 1 latency budget**: `builtin-pii` detector is Tier 1 fast — target p95 ≤ 5ms, p99 ≤ 10ms (per `GUARDRAILS_SPEC.md` §10.1 + `pii-detection-tiered-recognizers.md` §12).
- **Post-detection entity filter**: O(n) array intersection over detected entity results, n ≤ 37. Sub-millisecond. Negligible overhead.
- **Catalog endpoint cache**: Studio fetches via SWR with `revalidateOnFocus: false`. Server-side: stable per `(projectId, pack-enable-state)` tuple; consider memoizing with a 60s in-process cache keyed on `(projectId, configHash)` if profiling shows the registry-walk dominates.
- **Policy list chip rendering**: at-most ~10 policies per project (typical); ~4 chips each. Negligible.

### Reliability & Failure Modes

- **`failMode: 'open'` (default)**: if `builtin-pii` throws / times out, the request PASSES through. PII may leak. Voice-channel-safe default.
- **`failMode: 'closed'` (opt-in)**: if `builtin-pii` throws / times out, the request is BLOCKED. Compliance-safe; risks dropped voice calls. UI discloses this.
- **Catalog endpoint unavailable**: Studio multiselect falls back to a sentinel "Loading entities…" state with retry. Form Save is disabled until the catalog loads (the rule cannot be validated against an unknown universe).
- **Disabled-pack entity in saved rule**: runtime evaluator silently skips the unknown ID (other selected entities continue to match). The policy editor surfaces a yellow warning on the rule card when the policy is re-opened.
- **Auto-deactivation race**: rule update → check remaining enabled rules → set policy.active = false. MUST run within the same MongoDB transaction (or with a tenant-scoped distributed lock) to prevent a window where the policy is active with zero enabled rules. Existing guardrail policy update path already uses `findOneAndUpdate` with a tenant filter — extend to a transactional update.

### Observability

- New trace events:
  - `guardrail_activation_blocked` (NEW) with `{ policyId, reason: 'no_enabled_rules' }`
  - `guardrail_auto_deactivation` (NEW) with `{ policyId, ruleId, undone: boolean }`
  - `guardrail_input_blocked` and `guardrail_output_blocked` (EXTENDED — existing events) gain optional `presetKey?: string` field on their data shape. SDB violations carry `presetKey: 'sensitive_data_block'`. The HLD explorer reconnaissance confirmed there was never a single `guardrail.evaluation.block` event in the codebase; the previous draft of this section conflated the existing input/output block events with a metric name.
- Existing telemetry: rename `ruleCategory: 'pii'` → `'sensitive_data_block'`. Pre-commit grep audit; clean cutover if no dashboard references found.
- Metrics dashboard updates: `apps/studio/src/components/analytics/` — verify which charts filter on `ruleCategory`. Update filters and tooltips.

### Data Lifecycle

- No retention change. Guardrail policies are long-lived configuration. Rules deleted via `PUT /api/projects/:projectId/guardrail-policies/:id` (replace rules array).
- Pre-deploy cleanup: `tools/cleanup-pii-guardrail-presets.ts` removes existing tester `pii_protection: redact` rules. Idempotent; safe to re-run.
- Trace events follow standard `TraceStore` retention.

---

## 13. Delivery Plan / Work Breakdown

1. **Schema + shared validation**
   1.1 Schema edits in `packages/database/src/models/guardrail-policy.model.ts`: add `entities?: string[]`, `enabled?: boolean` (no Mongoose default — resolver/gate predicate is `enabled !== false`), `presetKey?: string`, `actionMessage?: string` to `IGuardrailRule`; flip `IGuardrailSettings.failMode` schema default from `'closed'` to `'open'` (and per LLD R1-F4, also flip the route normalizer at `guardrail-policies.ts:206` and `DEFAULT_POLICY_SETTINGS` at L141 to align all three default sources). The `kind` enum is **unchanged** (`'both'` stays form-level, expanded before persistence). All schema changes are additive (no field deletion / no enum narrowing / no enum extension).
   1.2 Create `packages/shared/src/validation/guardrail-rule-validation.ts` with `validateRule()` per FR-8.1
   1.3 Unit tests for `validateRule()` — per-checkType matrix
2. **Entity catalog endpoint**
   2.1 New route `apps/runtime/src/routes/pii-entities.ts` — `GET /api/projects/:projectId/pii-entities`
   2.2 Wire entity metadata source from `packages/compiler/src/platform/security/recognizer-packs/`
   2.3 Filter by project's enabled packs from `project_runtime_configs.pii_redaction.packs`
   2.4 Studio API proxy `apps/studio/src/api/pii-entities.ts` with SWR caching
   2.5 Integration test: enabled-pack filtering
3. **Runtime gates + auto-deactivation**
   3.1 Extend `apps/runtime/src/routes/guardrail-policies.ts` PUT update (`router.put('/:id', ...)` at L1132): `RULE_INCOMPLETE` error envelope
   3.2 Extend activation route: `NO_ENABLED_RULES` error
   3.3 Auto-deactivation on last-rule-disabled within transactional update
   3.4 Trace events: `guardrail_activation_blocked`, `guardrail_auto_deactivation`
   3.5 Integration tests for both gates + race condition harness
4. **Post-detection entity filter**
   4.1 Modify `BuiltinPIIProvider` (or equivalent evaluator) to read `rule.entities[]` and filter detection results
   4.2 Unit + integration tests covering "SSN selected, email present → no match" and inverse
5. **Studio form — Sensitive Data Block redesign**
   5.1 Rename `pii_protection` preset key → `sensitive_data_block` + i18n keys; default action `block`
   5.2 Restrict action enum in preset UI to `block | warn | escalate`
   5.3 New `EntityMultiselect.tsx` (quick-preset radio + entity list with pack-grouping + tier badges)
   5.4 New `FailModeSelector.tsx` with consequence disclosure
   5.5 Action message textarea with 500-char counter, server validation
   5.6 Inline helper text + cross-link to Settings
   5.7 Pack-disabled-entity warning on rule card
6. **Studio form — policy quality gates UI**
   6.1 Rule enable toggle disabled when `validateRule()` fails; tooltip lists missing fields
   6.2 "N fields missing" inline hint adjacent to toggle
   6.3 Form Save disabled when any enabled rule is invalid; banner aggregates errors
7. **Policy list — enabled rule chips**
   7.1 Render green-dot chips per enabled rule on `GuardrailsConfigPage.tsx`
   7.2 Entity sub-label for Sensitive Data Block chips (first 2 + `+N more`)
   7.3 "⚠ No rules enabled" muted text for empty policies
   7.4 Activation toggle disabled + tooltip when no rules enabled
   7.5 Auto-deactivation toast with 5-second Undo
   7.6 `?ruleId=<id>` deep-link from chip click
8. **Decision matrix + Settings banner**
   8.1 New `DecisionMatrixModal.tsx` (WCAG APG dialog pattern; first-run auto-open via localStorage)
   8.2 `?` icons in both screens for repeat access
   8.3 Settings → PII Protection cross-link banner; 90-day-TTL localStorage
9. **i18n strings**
   9.1 Update `packages/i18n/locales/en/studio.json` — rename keys + add new ones for banner, modal, gates, decision matrix
10. **Cleanup script**
    10.1 New `tools/cleanup-pii-guardrail-presets.ts` — dry-run + `--confirm` gate + audit log
11. **Telemetry audit + dashboards**
    11.1 Grep `apps/studio/src/components/analytics/` for `pii` tag references
    11.2 Clean cutover OR one-cycle dual-emit (decided after grep)
    11.3 Update affected dashboards
12. **Docs**
    12.1 Update `docs/features/pii-detection.md` FR-13 wording (positions guardrail surface)
    12.2 Update `docs/architecture/GUARDRAILS_SPEC.md` §10.4 example replacing `pii_redact` with `sensitive_data_block`
    12.3 Add SEO aliases ("PII Guardrail", "PII Filter", "Block PII messages") to public docs page titles
13. **E2E tests**
    13.1 HTTP-only: create policy → enable SDB with SSN → block SSN message → assert HTTP **200 OK** with `{ blocked: true, message, presetKey: 'sensitive_data_block' }` body (matches `reasoning-executor.ts:1925-1928` pattern; the block decision IS the response, not an HTTP error — per LLD Q-LLD-1 oracle resolution)
    13.2 HTTP-only: same policy → enable email entity → email message → assert NOT blocked
    13.3 HTTP-only: activate empty policy → assert `NO_ENABLED_RULES`
    13.4 HTTP-only: enable rule without `actionMessage` → assert `RULE_INCOMPLETE`
    13.5 HTTP-only: disable last enabled rule on active policy → assert policy auto-deactivated

---

## 14. Success Metrics

| Metric                                                                                                                       | Baseline                           | Target                                                                      | How Measured                                                                                                     |
| ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| % new policies with ≥1 enabled Sensitive Data Block rule                                                                     | 0% (feature new)                   | >30% within 30 days of launch                                               | MongoDB query: `guardrail_policies` where `rules.presetKey === 'sensitive_data_block' && rules.enabled === true` |
| Avg entities per Sensitive Data Block rule                                                                                   | N/A                                | >1 (signal: multiselect is being used vs default All PII)                   | Runtime emits `entities[].length` at save; aggregate via analytics                                               |
| Time-to-first-active-policy (new project)                                                                                    | Unknown                            | <10 minutes from project creation                                           | Studio session telemetry: timestamp of first `guardrail-policies/activate` API call per project                  |
| Decision matrix modal open rate (first visit)                                                                                | N/A                                | >40% of new users (signal: first-run modal is being seen, not flashed past) | `guardrail.help.matrix_opened` trace event vs first-visit count                                                  |
| Cross-link banner CTR                                                                                                        | N/A                                | >10% of users who see the banner                                            | `pii_protection.banner.cta_clicked` vs `pii_protection.banner.shown`                                             |
| Block-event rate (`guardrail_input_blocked` + `guardrail_output_blocked` filtered by `presetKey === 'sensitive_data_block'`) | 0 (no customers)                   | Track as signal — sudden spike >10× baseline indicates misconfigured rule   | Trace event count per project per day                                                                            |
| Support tickets mentioning "PII" or "block" within 60 days post-launch                                                       | Baseline = ticket count pre-launch | 0 new tickets about the dual-surface confusion                              | Manual tagging in support system                                                                                 |

---

## 15. Open Questions

1. **Compliance sign-off on the default `failMode: 'open'` for voice channels.** Healthcare / 911-adjacent flows cannot drop calls. Banking / PCI flows cannot leak. The per-policy override gives flexibility, but the platform-wide default needs compliance counsel review. Owner: Compliance. Target: before code commit on FR-6.7.
2. **Onboarding flow integration.** Should the new-project wizard surface the "stop vs handle" mental model up-front (alongside model selection, etc.), or rely on the in-context decision matrix modal? Owner: Product + Design. Target: post-MVP refinement.
3. **Future third-party PII providers.** Microsoft Presidio, AWS Comprehend Medical, etc. — when these come online, does the entity multiselect generalize via namespaced IDs (`presidio.person`, `comprehend.diagnosis`), or does each provider get its own selector? Schema is forward-compatible; UI design call needed before any provider integration. Owner: Product + Engineering. Target: when third-party PII roadmap surfaces.

---

## 16. Gaps, Known Issues & Limitations

| ID      | Description                                                                                                                                                                                                              | Severity | Status                                                        |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- | ------------------------------------------------------------- |
| GAP-001 | No mobile/tablet optimization for entity multiselect (<768px viewport). Renders as full-height drawer on narrow screens but interaction is suboptimal.                                                                   | Low      | Accepted (out of scope per non-goal §2.6)                     |
| GAP-002 | Sensitive Data Block evaluation triggers emit trace events only, not audit log entries. Compliance audit-logging for block events deferred pending compliance sign-off.                                                  | Medium   | Open — compliance review pending                              |
| GAP-003 | Saved rule references entity from a later-disabled pack — runtime silently skips; policy editor surfaces warning on re-open. This is the chosen behavior but it's a soft Journey-D-class failure for the dropped entity. | Low      | Mitigated — runtime skip + UI warning implemented             |
| GAP-004 | No localized translations for the decision matrix copy in v1. English-only at launch.                                                                                                                                    | Medium   | Open — i18n team to translate post-launch                     |
| GAP-005 | Catalog endpoint cache invalidation on pack-enable-state change is not push-based. Studio may show a stale catalog until SWR revalidation. Acceptable given pack changes are infrequent.                                 | Low      | Mitigated — LRU cache with 60s TTL in `project-pii-config.ts` |
| GAP-006 | PIIProtectionTab cross-link banner (FR-2.1) not yet wired — requires Studio `PIIProtectionTab.tsx` integration.                                                                                                          | Medium   | Deferred — JIRA sub-task                                      |
| GAP-007 | GuardrailsConfigPage SDB chips (FR-9.1–9.6) — enabled-rule chip preview on the policy list not yet implemented.                                                                                                          | Medium   | Deferred — JIRA sub-task                                      |
| GAP-008 | E2E-7 failMode fail-closed test seam — faulty-recognizer fixture mechanism for injecting PII detector failures needs test harness work.                                                                                  | Low      | Deferred — JIRA sub-task (it.todo marker)                     |
| GAP-009 | RuleCard toggle gate (FR-8.3) — enable toggle disabled state + tooltip with missing fields not yet wired in `RuleCard.tsx`.                                                                                              | Medium   | Deferred — JIRA sub-task                                      |
| GAP-010 | Output-blocked `presetKey` E2E coverage — code-verified by data-flow audit but no dedicated E2E test seeds an output guardrail and asserts the trace event `presetKey` field.                                            | Low      | Accepted — code-level audit passed; E2E deferred to post-v1   |

### Status Transition: PLANNED → ALPHA

**Chosen status: ALPHA** (not BETA). Rationale per AUTHORING_GUIDE §6:

- [x] LLD implementation phases complete (12 commits landed)
- [x] Core happy-path functional (SSN block via SDB policy verified in E2E-1)
- [x] `pnpm build` passes for affected packages
- [x] At least 1 E2E test demonstrates the feature works (4 E2E test files, ~215 assertions)
- [x] Feature spec updated with implementation file paths (this sync)
- [x] Known gaps documented in §16

ALPHA → BETA is blocked by: 8 documented `it.todo` markers covering 4 deferred JIRA sub-tasks (GAP-006 through GAP-009). Per AUTHORING_GUIDE, "if any `it.todo` indicates an unimplemented feature path, prefer ALPHA."

---

## 17. Testing & Validation

### Required Test Coverage

| #   | Scenario                                                                                                       | Coverage Type | Status  | Test File / Note                                                                        |
| --- | -------------------------------------------------------------------------------------------------------------- | ------------- | ------- | --------------------------------------------------------------------------------------- |
| 1   | `validateRule()` per-checkType matrix (provider, cel, llm x name/kind/action/threshold/actionMessage/entities) | unit          | PASS    | `packages/shared/src/__tests__/validation/guardrail-rule-validation.test.ts` (51 cases) |
| 2   | Preset defaults + `kind: 'both'` expansion + disabled-rule round-trip                                          | component     | PASS    | `apps/studio/src/__tests__/components/guardrails/GuardrailPolicyForm.test.tsx`          |
| 3   | 90-day TTL banner logic                                                                                        | unit          | it.todo | `apps/studio/src/__tests__/lib/banner-ttl.test.ts` (scaffolded; deferred via GAP-006)   |
| 4   | `GET /api/projects/:projectId/pii-entities` — pack filtering + catalog integrity                               | integration   | PASS    | `apps/runtime/src/__tests__/integration/guardrails/pii-entities-catalog.test.ts`        |
| 5   | `RULE_INCOMPLETE` / `NO_ENABLED_RULES` server-side gates                                                       | integration   | PASS    | `validate-rule-integration.test.ts` + `trace-events-activation.test.ts`                 |
| 6   | Auto-deactivation on last-rule-disabled — transactional correctness + race                                     | integration   | PASS    | `auto-deactivation-race.test.ts`                                                        |
| 7   | E2E: create SDB policy with SSN entity, POST SSN message, assert blocked                                       | e2e           | PASS    | `sensitive-data-block.e2e.test.ts`                                                      |
| 8   | E2E: email message passes through SSN-only rule (entity filter negative case)                                  | e2e           | PASS    | Same file as #7                                                                         |
| 9   | E2E: enable rule without `actionMessage`, assert RULE_INCOMPLETE                                               | e2e           | PASS    | Same file as #7                                                                         |
| 10  | E2E: activate empty policy, assert NO_ENABLED_RULES                                                            | e2e           | PASS    | Same file as #7                                                                         |
| 11  | E2E: disable last enabled rule on active policy, assert auto-deactivated                                       | e2e           | PASS    | Same file as #7                                                                         |
| 12  | E2E: Studio Create Policy via UI (Playwright)                                                                  | Playwright    | PASS    | `apps/studio/e2e/guardrails-sensitive-data-block.spec.ts`                               |

### Testing Summary

~215 assertions passing across ~20 new test files. Breakdown:

- **Unit**: 51 cases in `guardrail-rule-validation.test.ts` (groups A-F) + preset-defaults + banner-TTL
- **Integration**: 9 files in `apps/runtime/src/__tests__/integration/guardrails/` + 33 RBAC cases in `policy-rbac.integration.test.ts`
- **E2E (Runtime)**: 4 files covering E2E-1 through E2E-15 (14 executable + 1 cross-ref)
- **E2E (Playwright)**: 1 Studio comprehensive scenario (E2E-10)
- **Tool**: 1 file for cleanup-guardrail-traces (CL-1 through CL-4)
  **8 `it.todo` markers** in test files point to real impl gaps mapped to 4 deferred JIRA sub-tasks (GAP-006 through GAP-009). **1 LOW data-flow gap**: output-blocked `presetKey` E2E (GAP-010).

Per CLAUDE.md test architecture rules: all E2E tests interact via HTTP API only — no Mongoose model access, no `vi.mock` of platform components, no TODO stubs. The shared `validateRule()` function lives in `packages/shared` precisely to enable pure-function tests with zero mocks.

> Full testing details: [`../../testing/sub-features/guardrails-sensitive-data-block.md`](../../testing/sub-features/guardrails-sensitive-data-block.md) (canonical test spec, audited PASS through 2 rounds).
> Test-spec phase log: [`docs/sdlc-logs/guardrails-sensitive-data-block/test-spec.log.md`](../../sdlc-logs/guardrails-sensitive-data-block/test-spec.log.md).

### Production Wiring Verification

All routes are mounted and reachable:

| Method | Path                                                         | Mount Location                                  | Handler File                                             |
| ------ | ------------------------------------------------------------ | ----------------------------------------------- | -------------------------------------------------------- |
| GET    | `/api/projects/:projectId/pii-entities`                      | `apps/runtime/src/server.ts` (sibling of L1250) | `apps/runtime/src/routes/pii-entities.ts`                |
| POST   | `/api/projects/:projectId/guardrail-policies`                | `apps/runtime/src/server.ts:1248-1249`          | `apps/runtime/src/routes/guardrail-policies.ts`          |
| PUT    | `/api/projects/:projectId/guardrail-policies/:id`            | Same mount                                      | Same file — extended with validation + auto-deactivation |
| POST   | `/api/projects/:projectId/guardrail-policies/:id/activate`   | Same mount                                      | Same file — extended with activation gate                |
| POST   | `/api/projects/:projectId/guardrail-policies/:id/reactivate` | Same mount                                      | Same file — new undo route                               |

---

## 18. References

- **Architecture decision record**: [`docs/architecture/2026-05-14-guardrails-pii-separation-adr.md`](../../architecture/2026-05-14-guardrails-pii-separation-adr.md) — steelman analysis, industry comparison (Bedrock / Azure / Lakera / Aporia), 4 rejected alternatives
- **PRD (exploratory artifact)**: [`docs/features/sub-features/guardrails-sensitive-data-block.prd.md`](guardrails-sensitive-data-block.prd.md) — customer journey transcripts, design rationale (superseded by this spec)
- **Wireframes**: [`docs/features/sub-features/guardrails-sensitive-data-block.wireframes.html`](guardrails-sensitive-data-block.wireframes.html) — 12 side-by-side before/after screens
- **Parent feature**: [`docs/features/guardrails.md`](../guardrails.md)
- **Related feature**: [`docs/features/pii-detection.md`](../pii-detection.md) — Settings → PII Protection (the "handle" surface)
- **ABLP-921 dependency**: [`docs/features/sub-features/pii-detection-tiered-recognizers.md`](pii-detection-tiered-recognizers.md) — 37-entity recognizer registry
- **Guardrails canonical spec**: [`docs/architecture/GUARDRAILS_SPEC.md`](../../architecture/GUARDRAILS_SPEC.md)
- **Pre-pull-request reference (unmerged)**: PR #989 `fix/ABLP-723-guardrails-project-state-isolation` — initial state-isolation work; this feature subsumes its validation logic via shared `validateRule()`
- **Clarifying questions & user decisions log**: [`docs/sdlc-logs/guardrails-sensitive-data-block/clarifying-questions.md`](../../sdlc-logs/guardrails-sensitive-data-block/clarifying-questions.md) — Q&A reference for every AMBIGUOUS item the user personally decided during the feature spec phase (12 decisions: 3 mid-PRD + 9 Oracle Pass 2). Each entry links back to the FR that encodes the decision.

---

## §C. Critical Feature Gate (Privacy / Compliance)

This feature is governed by privacy / compliance rules and requires the four critical-feature gate artifacts before HLD.

### C.1 Terminology Table

| Term                                                    | Meaning                                                                                                                                                                                                                                                             |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| **block**                                               | Guardrails action: refuse the entire request; return an error to the user. Irreversible at the request level.                                                                                                                                                       |
| **warn**                                                | Guardrails action: continue processing; emit a warning trace event. No user-visible interruption.                                                                                                                                                                   |
| **escalate**                                            | Guardrails action: route to a human agent or supervisory workflow. Continues processing under supervision.                                                                                                                                                          |
| **redact**                                              | Settings → PII Protection render mode: destructive label replacement in output only (vault retains original value). NOT an allowed action for the Sensitive Data Block preset.                                                                                      |
| **tokenize**                                            | Settings → PII Protection: reversible `{{PII:type:uuid}}` replacement. Vault-backed; LLM sees tokens; tool calls receive originals via resolution.                                                                                                                  |
| **mask**                                                | Settings → PII Protection render mode: configurable show-first/show-last visual mask.                                                                                                                                                                               |
| **render-mode**                                         | Settings → PII Protection: per-consumer decision (original / masked / redacted / tokenized / random) for how a detected PII value appears in that consumer's view.                                                                                                  |
| **confidence threshold**                                | Numeric 0.0–1.0; minimum detection confidence score for an entity to register as a match. Default for Sensitive Data Block: 0.7.                                                                                                                                    |
| **entity**                                              | A specific PII type (e.g., `us_ssn`, `credit_card`). Canonical IDs are stable strings.                                                                                                                                                                              |
| **pack**                                                | Named group of entities (e.g., `us`, `eu`, `financial`). Packs are enabled per-project under Settings → PII Protection.                                                                                                                                             |
| **tier**                                                | BASIC / STANDARD / ADVANCED detection capability level. Drives latency expectation (Tier 1 = fast).                                                                                                                                                                 |
| **preset rule**                                         | A fixed-name rule row in the Guardrails policy form (Content Safety / Sensitive Data Block / Prompt Injection / Topic Restriction). Has a constrained default action vocabulary. Distinct from a custom rule.                                                       |
| **enabled rule**                                        | A rule with `enabled: true` AND all required fields populated. The §FR-8 gate enforces both conditions together.                                                                                                                                                    |
| **active policy**                                       | A policy with `active: true` AND ≥1 enabled rule. The §FR-7 gate enforces both conditions together.                                                                                                                                                                 |
| **failMode**                                            | Per-policy setting (`'open'                                                                                                                                                                                                                                         | 'closed'`) controlling behavior when the detector fails. `'open'`= pass through;`'closed'`= block. Default after this feature:`'open'`. |
| **guardrailName**                                       | Mongoose field on `IGuardrailRule` storing the rule's machine identifier. Maps to Studio's `RuleData.name`. Use this name when discussing the persisted schema; use `name` when discussing the Studio form surface.                                                 |
| **override**                                            | Existing required Mongoose field on `IGuardrailRule` (`'disable' \| 'threshold' \| 'action' \| 'severity_actions' \| 'define'`) that selects which behavior tier the rule applies. Not user-visible; this feature does not modify the field.                        |
| **checkType**                                           | Studio-form-only concept (`'provider' \| 'cel' \| 'llm'`) that selects which evaluator the rule uses. There is no `checkType` field in the schema; it maps to runtime evaluator tier and the presence of `provider` / `check` / `llmCheck` fields.                  |
| **evaluator**                                           | A runtime component that executes a guardrail check against an input. The Sensitive Data Block rule uses the `builtin-pii` evaluator (Tier 1, local).                                                                                                               |
| **threshold / confidenceThreshold / severityThreshold** | Three names for the same value. Schema field: `IGuardrailRule.threshold` (number 0.0–1.0). Studio form label: `Confidence threshold`. FR-8.1 mnemonic name: `severityThreshold`. All three refer to the minimum detection confidence required for the rule to fire. |

### C.2 Fail-Closed Contract

| Failure                                                  | Default Behavior (`failMode: 'open'`)                                                                                     | Opt-in Behavior (`failMode: 'closed'`)        |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| Detector throws / times out                              | Request passes through (no PII enforcement)                                                                               | Request blocked with `actionMessage`          |
| Catalog endpoint unavailable (Studio)                    | Form Save disabled; user cannot edit rule until catalog loads                                                             | Same                                          |
| Rule references entity ID not in catalog (pack disabled) | Runtime silently skips that entity; other selected entities continue to match. Policy editor surfaces warning on re-open. | Same                                          |
| Activation gate violation (no enabled rules)             | Server returns `400 NO_ENABLED_RULES`. Cannot activate.                                                                   | Same — gate is enforcement-direction agnostic |
| Rule incomplete (missing required fields)                | Server returns `400 RULE_INCOMPLETE` with `missingFields[]`                                                               | Same                                          |

**Error envelope (universal)**: `{ success: false, error: { code: <CODE>, message: <i18n>, missingFields?: string[] } }`. Codes are stable contracts; i18n messages are translatable. No leaky stack traces.

### C.3 Threat Model Summary

| Threat                                                  | Asset / Surface                                                              | Mitigation                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Misconfigured policy (zero entities) blocks all/nothing | Sensitive Data Block rule                                                    | FR-8.1 (`entities.length > 0` required for enable); FR-7 (no empty active policy); runtime defense-in-depth (`entities: []` = never match)                                                                                                                                                  |
| Pack-disabled entity → silent never-match               | Catalog endpoint + saved rule                                                | FR-10.4 (UI warning on re-open); operator can re-enable pack or remove entity from rule                                                                                                                                                                                                     |
| Stored XSS in `actionMessage`                           | User-controlled string returned to end-user                                  | 500-char limit; plain-text only; server-side HTML strip; React default escaping; channel renderers treat as untrusted                                                                                                                                                                       |
| Direct API bypass of UI gates                           | `PUT /guardrail-policies/:id` and `POST /guardrail-policies/:id/activate`    | Server-side enforcement (FR-7.3, FR-8.4) using the SAME `validateRule()` as the client                                                                                                                                                                                                      |
| Cross-project entity catalog leak                       | `GET /pii-entities`                                                          | Project-scoped permission + filter by `projectId`; cross-project access returns 404 (CLAUDE.md core invariant)                                                                                                                                                                              |
| Race on auto-deactivation                               | Concurrent rule disable + concurrent policy read                             | Transactional update (single MongoDB document op); existing distributed-lock pattern if cross-document atomicity later required                                                                                                                                                             |
| Telemetry leak (PII in trace event)                     | `guardrail_input_blocked` / `guardrail_output_blocked` events                | Event captures `presetKey + entities (IDs only) + confidence + guardrailName`; does NOT capture the matched substring or surrounding context                                                                                                                                                |
| Catalog endpoint enumeration / rate exhaustion          | `GET /pii-entities` (new route)                                              | Mounted under `/api/projects/:projectId/...` so the existing project-scoped permission + global API rate limiter apply. Endpoint is read-only and idempotent; payload is fixed-size (≤37 entities). HLD MUST confirm the route is registered under the standard rate-limit middleware.      |
| Log injection / log-format breakage via `actionMessage` | Structured logs + trace events containing the user-controlled message string | Use platform `createLogger` from `@abl/compiler/platform` (root CLAUDE.md "Server logger"), which JSON-escapes embedded values. Also reject control characters and null bytes server-side (FR-6.9). Trace events store the message in a structured field, not concatenated into a log line. |

### C.4 Rollout / Rollback Shape

- **Rollout**: pre-launch posture. No feature flag (`requireFeature('guardrails')` already gates the entire surface). No compatibility lane. Cleanup script `tools/cleanup-pii-guardrail-presets.ts` runs pre-deploy as a one-off MongoDB operation. Deployment is a single artifact: schema changes (additive) + UI changes + new routes + i18n + tests, all in one release.
- **Rollback**: schema changes are additive — new fields (`entities?`, `enabled?`, `presetKey?`, `actionMessage?`) are all optional; the `kind` enum is unchanged. Older code paths reading these new fields will see `undefined` and behave as today (no entity filter, no enabled flag, no presetKey association, no message override). The `failMode` schema default was flipped from `'closed'` → `'open'`; rolling that back is also a Mongoose-default flip — existing rows persisted under the new default with `failMode: 'open'` are unaffected (Mongoose defaults apply only at insert). UI rollback is a Studio revert. No data corruption risk.
- **Pre-launch decision documented**: PRD §6.1 and Oracle CPO-2 — full v1 ships in one wave; no phased rollout.
