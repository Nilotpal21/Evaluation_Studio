# ADR: Separate PII Handling (Settings) from PII Gating (Guardrails)

- **Date:** 2026-05-14
- **Status:** Accepted
- **Authors:** Girish (PM); discussion thread on branch `discuss/guardrails-pii-consolidation`
- **Related work:** ABLP-723 (state isolation, PR #989), ABLP-921 (tiered PII recognizers, PR #926)
- **Supersedes:** Implicit dual-surface model established by `docs/plans/2026-03-08-guardrails-ui-design.md` (§Preset categories)

---

## 1. Context

The platform currently exposes **two** PII-related configuration surfaces in Studio:

| Surface                                                  | Path                                                                                                                                    | What it does today                                                                                                                                                                                                           |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Settings → PII Protection**                            | `apps/studio/src/app/projects/[id]/settings/...` → `PIIPatternFormDialog`                                                               | Project-level PII detection + vault tokenization. Render modes per consumer: `original` / `masked` / `redacted` / `tokenized` / `random`. Reversible — agent can still use real values for tool calls via vault restoration. |
| **Guardrails → Create Policy → "PII Protection" preset** | `apps/studio/src/components/guardrails/GuardrailPolicyForm.tsx` (preset row, defaults to `provider: 'builtin-pii'`, `action: 'redact'`) | Per-policy guardrail rule. Action enum: `block` / `warn` / `redact`. The `redact` action here is **destructive string replacement**, not the same code path as Settings.                                                     |

### 1.1 Customer-facing problem

Customer journeys repeatedly fail because:

1. The two screens **share a name** ("PII Protection") with no signal to disambiguate.
2. Both expose a **`redact` action** that means different things:
   - Settings `redact` = a _render mode_ in the reversible vault (real value retained server-side; consumers see redacted form).
   - Guardrail `redact` = destructive in-place string replacement (real value lost; tool calls break).
3. There is **no documented evaluation order** when both are enabled.
4. Users picking the wrong surface for their job experience silent failures (agent breaks, PII leaks, double-processing).

Three customer journeys (Apple Care project owner, compliance lead, AI engineer) all end in misconfiguration. See companion PRD `docs/features/sub-features/guardrails-sensitive-data-block.prd.md` §2 for full journey transcripts.

### 1.2 Historical context

The Explore-agent investigation (this conversation, 2026-05-14) confirmed:

> "No design document, ADR, or code comment anywhere in this codebase explains why both surfaces exist. The `pii_protection` preset was added as part of a UI pattern (Aporia-style toggle cards with four industry-standard categories), not as a deliberate architectural decision to create a second PII enforcement layer."

Documents reviewed (none provide rationale for dual surface):

- `docs/architecture/GUARDRAILS_SPEC.md` — lists PII as a P0 guardrail goal but does not relate to Settings PII.
- `docs/plans/2026-03-08-guardrails-ui-design.md` lines 43–48 — mechanical specification of preset row.
- `docs/plans/2026-03-08-guardrails-ui-plan.md` lines 608–654 — hardcoded preset (`category: 'pii', action: 'redact', threshold: 0.3`).
- `docs/features/pii-detection.md` FR-13 (line 104) — only cross-reference: positions guardrail surface as a _zero-cost Tier 1 provider_, i.e., a **consumer** of detection, not a parallel enforcement layer.
- `docs/plans/2026-04-27-ablp-535-pii-boundary-hardening-plan.md` — establishes `pii_redaction.*` as the authoritative project-scoped contract; no mention of guardrail-level PII enforcement.
- `docs/plans/2026-05-02-pii-studio-db-dsl-runtime-hardening-impl-plan.md` — decision D-1 keeps PII project-scoped (not guardrail-scoped).
- `docs/audit/2026-05-08-pii-detection-gap-analysis-and-enhancement-plan.md` — does not question the dual surface.

### 1.3 Industry comparison

| Platform                    | Model     | Where PII config lives                                     |
| --------------------------- | --------- | ---------------------------------------------------------- |
| **AWS Bedrock Guardrails**  | Unified   | One screen. Actions: `BLOCK` or `ANONYMIZE`.               |
| **Azure AI Content Safety** | Separated | PII is _not_ a guardrail; lives under data governance.     |
| **Lakera Guard**            | Unified   | Single guardrail layer; redaction is an action.            |
| **Aporia**                  | Unified   | Single guardrail with policies.                            |
| **Our platform today**      | ⚠️ Both   | Worst-of-both: two screens with overlapping names/actions. |

Both unified (Bedrock-style) and separated (Azure-style) models are defensible. The incoherent third option we ship today is not.

---

## 2. Steelman: Why might the original designers have intended two surfaces?

Reconstructed from architecture (not from any document). Five candidate justifications, graded:

| #   | Argument                                                                                                                                                                                                                                                                           | Verdict                                                                  |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| 1   | **Different enforcement persona — gate vs. filter.** Settings PII is always-on detect→tokenize→render. Guardrail PII can `block` or `escalate` — actions Settings cannot express. A compliance team wanting "hard-block any message containing SSN" has no path in Settings today. | ✅ **Strong.** Real product gap.                                         |
| 2   | **Discoverability — industry-standard 4-category taxonomy** (Aporia/Bedrock/Azure all have Content Safety + PII + Prompt Injection + Topic Restriction).                                                                                                                           | ⚠️ **Weak as architecture, fair as UX.** Justifies naming, not behavior. |
| 3   | **Pluggable third-party providers** — guardrail PII could point to OpenAI Moderation or a cloud PII API; Settings is locked to the built-in registry.                                                                                                                              | ⚠️ **Theoretical.** No third-party PII provider is wired today.          |
| 4   | **Tenant → Project → Agent inheritance.** Tenant admins can mandate "all agents block SSNs" via tenant-level guardrail. Settings is project-only.                                                                                                                                  | ✅ **Strong.** Real scope dimension Settings lacks.                      |
| 5   | **Scored detection with severity thresholds.** Guardrails support `warn ≥0.5, block ≥0.7`. Settings was binary (until ABLP-921).                                                                                                                                                   | ⚠️ **Closing.** ABLP-921 added tiered confidence; gap is shrinking.      |

**Two arguments survive scrutiny: #1 (block/escalate hard gate) and #4 (tenant-wide enforcement).** Both describe legitimate scenarios Settings cannot cover today. **These are preserved by the chosen decision.**

---

## 3. Decision

We adopt an **Azure-style separation** with explicit cross-references. Both surfaces remain, but each owns a **sharply distinct job**:

| Screen                                                                  | Job                                                                                 | Verb     | Action vocabulary                                         |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | -------- | --------------------------------------------------------- |
| **Settings → PII Protection**                                           | "How my agent **handles** sensitive data so it can do its job without exposing it." | _Handle_ | Mask · Tokenize · Render-per-consumer · Restore via vault |
| **Guardrails → "Sensitive Data Block"** (renamed from "PII Protection") | "Where my agent **stops** when it sees data it must never process."                 | _Stop_   | Block · Escalate · Warn                                   |

### 3.1 Specific changes

1. **Rename** the Guardrail preset row from `PII Protection` to `Sensitive Data Block`. The preset key, label, description, and helper text all change. Internal key changes from `pii_protection` to `sensitive_data_block`.
2. **Strip `redact` action** from this guardrail row. Allowed actions: `block`, `escalate`, `warn` only. (The schema-level action enum in `guardrail-policy.model.ts` remains unchanged — `redact` is still valid for _custom_ rules — but the preset UI for this row hides it.)
3. **Default action** for the preset: `block` (was `redact`). **Default state**: `OFF` (unchanged).
4. **Helper text** under the row (always visible, not in a tooltip):
   > "Stops requests containing PII outright. To **anonymize or tokenize** PII while keeping the agent working, configure under Settings → PII Protection."
5. **Cross-link banner in Settings → PII Protection**:
   > "Need to **block** requests outright? Create a Guardrail Policy with a Sensitive Data Block rule."
6. **Decision matrix in Studio docs / onboarding** — see PRD §4.
7. **Migration** — pre-launch posture: **drop existing tester entries** rather than convert. No customers in v1 means no migration burden; cleaner schema; no need for a one-time banner. See PRD §6.

### 3.2 What we do NOT change

- Settings → PII Protection: unchanged behavior, just adds a banner.
- Guardrails action enum at the schema level: `redact` remains valid for custom rules.
- Guardrail policy inheritance (tenant → project → agent): unchanged.
- The `BuiltinPIIProvider` detection code path: unchanged.
- `pii-detector.ts` / `PIIRecognizerRegistry` from ABLP-921: unchanged.
- The other three presets (Content Safety, Prompt Injection, Topic Restriction): unchanged.

---

## 4. Consequences

### 4.1 Positive

- **Mental model is teachable in one word per screen**: "handle" (Settings) vs. "stop" (Guardrails). Users can predict which screen to use for any PII task.
- **Action vocabulary collision eliminated.** No more two `redact`s doing different things.
- **Steelman arguments #1 and #4 preserved** — block/escalate persona and tenant-wide enforcement remain first-class capabilities.
- **Codebase simplification** — preset definition shrinks; allowed action enum narrows.
- **Industry coherence** — we ship a defensible model (Azure-style) instead of an incoherent hybrid.

### 4.2 Negative / Trade-offs

- **Users coming from Bedrock or Lakera** (who use the unified model) need to learn our split. Mitigated by the decision matrix in docs.
- **Naming change is irreversible-ish** — once we ship "Sensitive Data Block", we can't easily revert. Mitigated by pre-launch status (no customers).
- **Cross-link maintenance** — the two screens now have explicit references to each other. Future renames require coordinated updates.

### 4.3 Risks

| Risk                                                                                                                | Likelihood | Mitigation                                                                        |
| ------------------------------------------------------------------------------------------------------------------- | ---------- | --------------------------------------------------------------------------------- |
| Users still confuse the two surfaces post-rename                                                                    | Medium     | Decision matrix + onboarding + inline helper text + cross-link banners.           |
| Future product asks to add `redact` back to the guardrail preset                                                    | Low        | Document this ADR as rationale; require revisiting this decision explicitly.      |
| Tenant admins who currently configure tenant-level "PII Protection" guardrails miss the rename                      | Low        | Drop pre-launch entries; no migration to fail.                                    |
| ABLP-921 confidence thresholds eventually make Settings PII able to express blocking, re-opening unification debate | Medium     | Revisit this ADR if/when Settings PII gains action semantics beyond render modes. |

---

## 5. Alternatives Considered

### 5.1 Option A′ — Remove the guardrail row entirely

PII is exclusively a Settings concern. Delete `pii_protection` preset; no Sensitive Data Block.

**Rejected because:** Loses steelman #1 (hard-block scenario) and #4 (tenant-wide enforcement). Compliance leads who need "refuse all messages with SSNs" would have no path. The Settings → PII Protection action model (`tokenize`, `render`, etc.) is not designed to refuse — only to handle.

### 5.2 Option B (originally proposed) — Keep current, layer it

Document evaluation order: Guardrail PII runs first (can block), then Settings PII (handles the rest). Add UX banner cross-linking.

**Rejected because:** Preserves the `redact`/`redact` collision. Does not solve the customer-journey failures. Documentation cannot rescue a UI that uses the same word to mean two things.

### 5.3 Option C — Inverted: move all PII config under Guardrails

Kill Settings → PII Protection. Move vault, render modes, consumer access into a guardrail rule type.

**Rejected because:** The vault + render-per-consumer model is too rich for the guardrail action abstraction. Force-fitting it would require expanding the guardrail action enum to ~10 values and introducing rule-type-specific config schemas. Loss of project-level always-on semantics — every project would need a guardrail policy attached. Higher migration cost, lower clarity.

### 5.4 Option D — Unify (Bedrock-style)

One screen for all PII config. Combine the toggle-card UI with vault/render config.

**Rejected because:** Two distinct jobs (gate vs. handle) deserve two distinct screens. Unifying would either over-load one screen with conflicting controls (block + tokenize + render modes + thresholds all visible at once) or hide one job behind the other. Industry precedent: Azure separates; Bedrock unifies but uses a simpler action model (no reversible vault).

---

## 6. Implementation Outline

Full breakdown in `docs/features/sub-features/guardrails-sensitive-data-block.prd.md`. Summary:

1. **Studio UI changes** (`apps/studio/src/components/guardrails/GuardrailPolicyForm.tsx`, `RuleCard.tsx`, i18n strings) — rename, helper text, restricted action enum for this preset.
2. **Settings banner** (`apps/studio/src/app/projects/[id]/settings/pii-protection/...`).
3. **Pre-launch cleanup script** (one-off Mongo script or migration) — delete tester `pii_protection` rules from existing guardrail policies; no customer migration logic.
4. **i18n updates** (`packages/i18n/locales/en/studio.json`) — new labels.
5. **Tests** — update guardrail policy form tests; add E2E covering decision-matrix journey (block vs. handle).
6. **Docs** — add decision matrix to onboarding / Studio in-app help.

---

## 7. Open Items (post-decision)

- **Visual rendering of "escalate"** — Guardrails currently shows `block` (red) and `warn` (amber). What color/icon does `escalate` use? Out of scope for this ADR; addressed in the PRD.
- **API/SDK contract impact** — does any external SDK or API caller reference `pii_protection` as a preset key? Verify before code changes.
- **Telemetry continuity** — guardrail evaluation traces currently tag rule category as `pii`. Decide whether to keep `pii` as the trace tag or switch to `sensitive_data_block` for clarity vs. continuity.

---

## 8. Sign-off

| Role        | Owner  | Status                                     |
| ----------- | ------ | ------------------------------------------ |
| Product     | Girish | Decision recorded                          |
| Engineering | TBD    | Pending review                             |
| Design      | TBD    | Wireframes ready (see companion file)      |
| Compliance  | TBD    | Pending review of steelman #1 preservation |

---

## 9. References

- Companion PRD: `docs/features/sub-features/guardrails-sensitive-data-block.prd.md`
- Companion wireframes: `docs/features/sub-features/guardrails-sensitive-data-block.wireframes.html`
- Earlier branch: `fix/ABLP-723-guardrails-project-state-isolation` (PR #989) — state isolation work; this ADR is architectural follow-up to the surface confusion observed there.
- ABLP-921 tiered recognizers (PR #926) — adds confidence scoring; informs steelman #5.
