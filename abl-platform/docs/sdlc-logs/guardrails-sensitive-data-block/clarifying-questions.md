# Clarifying Questions & User Decisions — Guardrails Sensitive Data Block

**Date**: 2026-05-15
**Phase**: Feature Spec (Phase 1)
**Owner**: Girish (PM)
**Purpose**: Permanent reference for every clarifying question raised during the feature spec phase, the Oracle recommendation (when applicable), and the user's final decision. Source of truth for future SDLC phases (test spec, HLD, LLD, implementation) — refer here when a downstream phase asks "why was X decided this way?".

---

## How decisions were classified

The product-oracle agent uses the **Decision Classification Protocol**:

- **ANSWERED** — found in code, docs, or earlier conversation.
- **INFERRED** — strongly implied by adjacent decisions or platform conventions.
- **DECIDED** — Oracle made the call (PM-voice / CPO-voice judgment with rationale).
- **AMBIGUOUS** — Oracle could not commit; escalated to user.

Only AMBIGUOUS items appear below — these are the questions the user personally answered. ANSWERED / INFERRED / DECIDED items are in the phase log's §1 Pass 1 / Pass 2 summary (`feature-spec.log.md`).

---

## Batch 1 — Mid-PRD Refinement Questions

These were resolved before the Feature Spec was started, while the PRD was being expanded with the May 15 requirements.

### Q-PRD-1: Default entity selection for the "High-risk only" preset

**Context**: The Sensitive Data Block UI exposes a quick-preset radio (`High-risk only` / `All PII` / `Custom`). The "high-risk group" candidate pool is `us_ssn`, `credit_card`, `bank_account`, `us_passport`, `us_drivers_license`, `iban`. Which of these should be **pre-selected** by default when the user picks `High-risk only`?

**Options considered**:

- All 6 high-risk entities pre-selected (broadest default)
- SSN only pre-selected (narrowest default, leaves headroom to add more)
- No pre-selection — user must check at least one (most explicit, most clicks)

**User decision**: **SSN only, pre-selected**.

> "i am fine with the 'High-risk only' may be SSN only as the deault entities to be enabled foe the sensitive data block."

**Rationale**: SSN is the highest-volume PII type in customer-care channels and the most commonly cited audit failure mode. Pre-selecting only SSN gives a sensible default without over-restricting the agent (a customer-care flow that accepts credit cards for verification doesn't want bank_account or DL flagged unless explicitly enabled).

**Encoded in spec as**: FR-6.2 — "`High-risk only` preset MUST pre-select **SSN only** as the default. The 'high-risk group' (candidate pool visible under this preset) comprises: `us_ssn`, `credit_card`, `bank_account`, `us_passport`, `us_drivers_license`, `iban`."

---

### Q-PRD-2: Per-tenant pack visibility

**Context**: The PII recognizer registry has 8 packs (`us`, `eu`, `apac`, `financial`, `medical`, `network`, `core`, `intl-phone`). When a tenant's projects span multiple regions, should pack visibility be restricted at the tenant level (e.g., a US-only tenant doesn't even see EU packs), or should all 8 packs be visible to every project (with per-project enablement)?

**Options considered**:

- Per-tenant pack scoping (admin restricts which packs tenants/projects can enable)
- All packs available everywhere; per-project enablement only

**User decision**: **All 8 packs available to every tenant/project**. No tenant-level pack restriction.

> "no per-tenenat pack. all entities available for everyone"

**Rationale**: Keeps the model simple. Avoids a per-tenant admin scope for pack visibility. Projects within a tenant can still enable/disable packs independently via Settings → PII Protection.

**Encoded in spec as**: §11 Configuration — Pack-enable state lives at `project_runtime_configs.pii_redaction.packs` (project-scoped). Catalog endpoint filters by the project's enabled packs (FR-10.1), with no tenant-level filter.

---

### Q-PRD-3: Auto-deactivation UX on disabling the last enabled rule

**Context**: When a user disables the last `enabled: true` rule on an active policy, the policy becomes effectively no-op while still appearing as "Active." Options for resolving the broken state:

**Options considered**:

- (a) Refuse to disable the last rule (force the user to deactivate the policy first)
- (b) Auto-deactivate the policy silently
- (c) Auto-deactivate with a transient toast notification + Undo
- (d) Open a confirmation dialog before disabling

**User decision**: **Auto-deactivate with a 5-second Undo toast** (option c).

> "auto-deactivation, toast with 5s undo is fine"

**Rationale**: Toast-with-Undo strikes the balance — no modal interruption, but the user retains an immediate escape hatch. Sidesteps the failure mode where "Active but no rules" persists in the policy list.

**Encoded in spec as**: FR-7.4 — "If the user disables the last enabled rule on an active policy, the policy MUST be auto-deactivated with a 5-second Undo toast: _'Policy {name} was deactivated. The last enabled rule was disabled.'_ Undo MUST re-enable the rule AND re-activate the policy atomically."

---

## Batch 2 — Feature Spec Oracle Pass 2 (UX-expert + CPO with web search)

These 9 questions were surfaced during the second Oracle pass on the feature spec. The user was asked to answer each via the `AskUserQuestion` mechanism. Oracle's recommended option (where one was offered) is shown alongside the user's pick.

### Q-FS-1 (UX-1): Decision matrix modal — auto-open vs opt-in?

**Context**: A "decision matrix" modal explains the mental model "Guardrails = stop, Settings = handle." How should it surface to first-time users?

**Options considered**:

- (a) Opt-in only — user clicks `?` icon to open (Pass 1's choice, justified by misapplied WCAG 2.2.2)
- (b) First-run auto-open — modal opens automatically on first visit, persists dismissal in localStorage

**Oracle recommendation (after web research)**: Auto-open. WCAG 2.2.2 covers parallax/animation, not nav-triggered modals — Pass 1's justification was technically wrong. Auto-open is consistent with standard onboarding patterns (Bedrock, Vellum, Humanloop all use first-run modals for novel concepts).

**User decision**: **Auto-open** (option b).

**Encoded in spec as**: FR-3.1 — "A first-visit modal MUST open automatically on the first visit (per user) to **either** Guardrails policy form **or** Settings → PII Protection, displaying the decision matrix… Dismissal MUST be persisted in `localStorage` (`decision-matrix-dismissed: <epoch_ms>`)."

---

### Q-FS-2 (UX-2): Naming the preset — "Sensitive Data Block" or competitor-aligned alternative?

**Context**: AWS Bedrock calls this "Sensitive Information Filters" (plural noun). Lakera calls it "Data Leakage Prevention." Aporia calls it "PII Protection." The Round 1 working name was "Sensitive Data Block" (a verb-among-nouns choice — most presets are noun phrases).

**Options considered**:

- (a) Keep "Sensitive Data Block" (current)
- (b) Rename to "Sensitive Information Filter" (Bedrock-aligned, noun phrase)
- (c) Rename to "PII Block" (terse + accurate)
- (d) Rename to "Data Protection" (Lakera-aligned, vague)

**Oracle recommendation**: Genuinely AMBIGUOUS — verb-noun problem real, but competitor alignment isn't strictly necessary if internal naming is clear.

**User decision**: **Keep "Sensitive Data Block"** (option a).

**Rationale (user-implied)**: Internal consistency over competitor mimicry. "Block" is the verb the action vocabulary uses, so naming the preset after the action is intentional. SEO aliases in public docs (FR-12.3) cover discoverability.

**Encoded in spec as**: §1 / §FR-1.1 — preset name `sensitive_data_block`. Public-docs SEO aliases ("PII Guardrail", "PII Filter", "Block PII messages") in §13 Delivery Plan 12.3.

---

### Q-FS-3 (UX-3): Banner persistence — permanent vs TTL?

**Context**: The Settings → PII Protection page gets a cross-link banner pointing to Guardrails. Once the user dismisses it, should it stay dismissed forever, or re-surface periodically?

**Options considered**:

- (a) Dismiss-forever (most quiet, risks user forgetting the dual-surface model)
- (b) 30-day TTL re-surface (most aggressive, may feel naggy)
- (c) 90-day TTL re-surface (compliance-audit cadence — quarterly review aligns with this)

**Oracle recommendation**: 90-day TTL — aligns with the compliance-audit cycle (User Story #6 explicitly asks for this).

**User decision**: **90-day TTL re-surface** (option c).

**Encoded in spec as**: FR-2.3 — "Banner dismissal MUST be persisted in `localStorage` as `{dismissedAt: <epoch_ms>}`. The banner MUST re-surface 90 days after dismissal. On render, check `Date.now() - dismissedAt > 90 * 24 * 60 * 60 * 1000`."

---

### Q-FS-4 (UX-5): Default action-message copy — keep concise or improve?

**Context**: When a Sensitive Data Block rule fires, the user sees `actionMessage`. The PRD's draft copy was _"This message cannot be processed."_ — concise but channel-blind (sounds wrong in voice; sounds accusatory in chat).

**Options considered**:

- (a) Keep current copy (terse, fast to ship)
- (b) Improve to channel-neutral copy

**Oracle recommendation**: Improve. Default copy gets tested in every customer trial; getting it right pre-launch avoids per-customer rework.

**User decision**: **Improve to channel-neutral copy** (option b).

**Encoded in spec as**: FR-6.6 — Default action message: _"This message contains information that cannot be processed in this channel. Please contact us through an alternative channel for further assistance."_

---

### Q-FS-5 (CPO-1): Primary persona — single or co-equal?

**Context**: The PRD framed Compliance Lead as the primary buying persona. Competitive research showed AI-platform vendors (Vellum, Humanloop, Langfuse, Helicone) target AI engineers as the configurer persona. Should the feature spec follow PRD's compliance-first framing, or shift?

**Options considered**:

- (a) Compliance Lead primary (PRD framing)
- (b) AI Engineer primary (competitor norm)
- (c) Both co-equal, explicit in spec (no priority tiebreaker)

**Oracle recommendation**: Co-equal — the dual-persona reality is real (the buying-vs-configuring distinction matters), and pretending one is primary will misalign the UX team.

**User decision**: **Both co-equal, explicit in spec** (option c).

**Encoded in spec as**: §3 User Stories — "Personas: **Compliance Lead** (regulatory mandate owner) and **AI Engineer** (configurer) are **co-equal primary personas**. **Project Owner** (operator) and **Tenant Admin** (cross-project policy author) are secondary."

---

### Q-FS-6 (CPO-2): Scope tiebreaker — phase or ship full v1?

**Context**: Full v1 was estimated at ~10 dev-days. A phased option was sketched: ship rename + multiselect first, defer gates + decision matrix to a follow-up sprint.

**Options considered**:

- (a) Full v1 in one wave (~10 dev-days)
- (b) Phase 1: rename + multiselect (~5 days); Phase 2: gates + matrix (~5 days)

**Oracle recommendation**: Genuinely AMBIGUOUS — depends on capacity and dependency on ABLP-921 BETA stability.

**User decision**: **Full v1 in one wave** (option a).

**Rationale (user-implied)**: Pre-launch posture eliminates migration cost; shipping the gates separately would mean shipping a feature where "Active" can still be a meaningless badge. Internal coherence preferred over phased releases.

**Encoded in spec as**: §13 Delivery Plan — single 13-task v1 plan, no phasing. §15 Open Questions does NOT include phasing as an open item.

---

### Q-FS-7 (CPO-5): Pricing / packaging wedge — gate as paid tier?

**Context**: Tenant-wide Sensitive Data Block inheritance could be packaged as an enterprise-tier-only feature (revenue wedge). Or it could ship as a free baseline capability with no gating.

**Options considered**:

- (a) Gate tenant-wide enforcement to enterprise tier
- (b) Gate entity multiselect to enterprise tier (binary "all PII" for free, granular for paid)
- (c) No gating, no documented wedge

**Oracle recommendation**: No gating documented — pre-launch and there's no validated wedge to test.

**User decision**: **No gating, no documented wedge** (option c).

**Encoded in spec as**: §2.7 Non-Goals — "Pricing/packaging gating (e.g., tenant-wide enforcement as paid tier). No wedge documented."

---

### Q-FS-8 (CPO-6): Voice channel fail mode — fail-open or fail-closed default?

**Context**: When the `builtin-pii` detector throws or times out, what's the safe default — pass through (fail-open, voice-channel safe) or block (fail-closed, compliance safe)?

**Options considered**:

- (a) Global default fail-closed (compliance-safe; voice calls can drop)
- (b) Global default fail-open (voice-safe; PII may leak on detector failure)
- (c) Per-policy `failMode` field, fail-open default + UI disclosure

**Oracle recommendation**: Per-policy field with fail-open default + UI disclosure — gives compliance leads explicit control without forcing every project into a tradeoff they may not understand.

**User decision**: **Per-policy `failMode` field, fail-open default + UI disclosure** (option c).

**Encoded in spec as**: FR-5.4 — `IGuardrailSettings.failMode` schema default flips from `'closed'` to `'open'`. FR-6.7 — `failMode` selector with disclosure copy: _"Fail-closed means requests are blocked if PII detection fails. Recommended for text channels. May disrupt voice calls."_ Default: Open.

**Open dependency**: §15 Open Question #1 — compliance counsel sign-off on the `'open'` default before code commit on FR-6.7.

---

### Q-FS-9 (NEW-A): Entity catalog — global or project-scoped?

**Context**: The new `/api/projects/:projectId/pii-entities` endpoint returns the catalog of entity IDs the user can pick from in the multiselect. Should it return all 37 entities regardless of project state, or filter by the project's enabled packs?

**Options considered**:

- (a) Global catalog (all 37 entities, all 8 packs visible)
- (b) Filter to only enabled-pack entities (project-scoped)

**Oracle recommendation**: Project-scoped — otherwise a user could pick `eu_passport`, save the rule, then disable the EU pack in Settings, leaving a silent-never-match dangling reference. Project-scoping forces the catalog and policy editor to reflect actual project state.

**User decision**: **Filter to only enabled-pack entities** (option b).

**Encoded in spec as**: FR-10.1 — "Returns the list of PII entities AVAILABLE TO THIS PROJECT (filtered by enabled packs)." FR-10.4 — "If a saved rule references an entity ID NOT in the catalog (because the pack was later disabled), the policy editor MUST display a warning on the rule card."

---

## Batch 3 — HLD Phase Questions

### Q-HLD-A1: Permission model for `POST /:id/activate` — keep bundled or split?

**Date asked**: 2026-05-15 (during HLD oracle pass)

**Context**: Today, the guardrail-policy mutation routes (POST, PUT, POST `/:id/activate`, DELETE) all share a single permission: `guardrail:write`. Defined at `packages/shared-auth/src/rbac/role-permissions.ts`, seeded by migration `20260509_029`. The codebase has 4 precedents for splitting lifecycle verbs from basic CRUD: `version:promote`, `prompt:promote`, `deployment:retire`, `module:publish`.

Discovered during HLD research (via codebase exploration agent):

- The feature spec and test spec drafts had referenced fictitious permission names (`guardrail-policy:update`, `guardrail-policy:activate`) — these exist only as **audit-log action strings**, not RBAC permissions.
- Test spec INT-11 was written assuming the fine-grained model already existed.
- The actual codebase has only `guardrail:read` and `guardrail:write`.

**Options considered**:

1. Keep bundled (`guardrail:write` covers all mutations) — current code; simplest.
2. Split now (`guardrail:activate` as separate permission) — defense-in-depth; enables maker-checker.
3. Defer the decision; HLD documents both options.

**Oracle recommendation (with evidence)**: Split. Codebase has 4 precedents for the pattern; migration cost is ~10 production lines + ~50-line migration script; risk is low; future "safety reviewer" / "compliance approver" custom-role becomes possible.

**User decision**: **Keep `guardrail:write` today; design the HLD so the extension is additive when maker-checker is introduced** (option 1 + forward-extensibility plan).

> _"I am open to keep it as is today i.e. `guardrail:write`, but I want to be open for extension tomorrow the way you mentioned about the maker-checker process."_

**Rationale**: Pre-launch posture eliminates the urgency. No customers means no role-grant audit needed. Shipping the minimum keeps the activation gate (FR-7) cleanly testable today against the existing permission. The HLD documents the exact additive change for the future implementer.

**Encoded as**:

- HLD §4 concern #4 (Security Surface): "Future extension hook — `guardrail:activate`" subsection with the 6-step runbook (add to PERMISSION_REGISTRY → add to role definitions → migration script → flip route check → enable custom-role granularity → support new reviewer role).
- Feature spec §12 (correction): `guardrail-policy:update` → `guardrail:read` / `guardrail:write`. Activate uses `guardrail:write` today; deferred split noted.
- Test spec INT-11 (correction): permission matrix updated to `guardrail:read` / `guardrail:write` + `pii-pattern:read`. Case 3 reframed as FUTURE test (F-1), deferred to maker-checker rollout.
- Phase-1 SDLC log §1 C5 (correction): clarified that `guardrail-policy:*` strings are audit-log action names, not permissions.

**Related corrections cascaded from this decision** (independent doc-truth fixes, not the decision itself):

1. Feature spec §12 permission string corrected
2. Test spec INT-11 reauthored with real permission names + future-test note
3. Phase-1 SDLC log §1 C5 corrected

These three corrections would have been required regardless of which option was chosen — they reflect actual codebase reality.

---

## Summary Table — All User Decisions

| #        | Topic                              | Decision                                                                                                 | Encoded At        |
| -------- | ---------------------------------- | -------------------------------------------------------------------------------------------------------- | ----------------- |
| Q-PRD-1  | Default high-risk entity selection | SSN only pre-selected                                                                                    | FR-6.2            |
| Q-PRD-2  | Per-tenant pack visibility         | All packs available to every tenant; project-scoped enablement only                                      | §11 Configuration |
| Q-PRD-3  | Auto-deactivation UX               | Auto-deactivate + 5s Undo toast                                                                          | FR-7.4            |
| Q-FS-1   | Decision matrix modal              | First-run auto-open with localStorage gate                                                               | FR-3.1            |
| Q-FS-2   | Preset name                        | Keep "Sensitive Data Block"                                                                              | FR-1.1            |
| Q-FS-3   | Settings banner TTL                | 90-day re-surface                                                                                        | FR-2.3            |
| Q-FS-4   | Default action message             | Channel-neutral copy                                                                                     | FR-6.6            |
| Q-FS-5   | Primary persona                    | Compliance Lead + AI Engineer co-equal                                                                   | §3 User Stories   |
| Q-FS-6   | Scope phasing                      | Full v1 in one wave                                                                                      | §13 Delivery Plan |
| Q-FS-7   | Pricing wedge                      | No gating                                                                                                | §2.7 Non-Goals    |
| Q-FS-8   | Voice fail mode                    | Per-policy `failMode`, fail-open default + disclosure                                                    | FR-5.4, FR-6.7    |
| Q-FS-9   | Entity catalog scope               | Project-scoped (filter by enabled packs)                                                                 | FR-10.1, FR-10.4  |
| Q-HLD-A1 | Activate-route permission          | Keep `guardrail:write` today; HLD documents `guardrail:activate` as deferred extension for maker-checker | HLD §4 concern #4 |

---

## How to use this document in future phases

1. **Test Spec phase**: When writing test scenarios for FR-6.2 / FR-3.1 / FR-10.1 / etc., refer here for the _intended_ user behavior, not just the FR text. The "why" is captured here.
2. **HLD / LLD phase**: When making architecture trade-offs, check whether any decision in this file is implicated. If your design contradicts a recorded user decision, surface that as a change-request to the user — do not silently override.
3. **Implementation phase**: If you encounter an edge case not covered by the FR text (e.g., "what should happen if the user has zero packs enabled?"), check this file first. If it's not answered, raise a new clarifying question and append to this file under "Batch 3 — Implementation phase questions."
4. **Future maintenance**: If a decision here is later overridden by a new product decision, do NOT delete the original entry. Add a `~~strikethrough~~` line and a follow-up entry noting the change, with date and reason. Decision history matters for compliance and audit.
