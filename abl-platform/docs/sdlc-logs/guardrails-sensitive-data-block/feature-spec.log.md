# Feature-Spec Phase Log — Guardrails Sensitive Data Block

**Date**: 2026-05-15
**Branch**: `discuss/guardrails-pii-consolidation`
**Owner**: Girish (PM)
**Phase**: 1 (Feature Spec)
**Inputs**: ADR (`docs/architecture/2026-05-14-guardrails-pii-separation-adr.md`), PRD (`docs/features/sub-features/guardrails-sensitive-data-block.prd.md`), Wireframes (`docs/features/sub-features/guardrails-sensitive-data-block.wireframes.html`)
**Output**: Feature spec at `docs/features/sub-features/guardrails-sensitive-data-block.md`; Testing guide at `docs/testing/sub-features/guardrails-sensitive-data-block.md`
**Clarifying-questions reference**: [`clarifying-questions.md`](clarifying-questions.md) — full Q&A log of every AMBIGUOUS item the user personally decided (12 decisions across PRD refinement + Oracle Pass 2)

---

## 1. Clarifying Questions (Decision Classification Protocol)

Two Oracle passes were run during this phase: an initial PM-voice pass and a stress-test UX+CPO pass with web-search permission. Both used the ANSWERED / INFERRED / DECIDED / AMBIGUOUS classification.

### Pass 1 (PM voice) — 19 questions

All resolved without escalation to user. Summary:

- **A1 Primary segment**: enterprise compliance leads + project owners (ANSWERED from PRD §2.2, §2.5).
- **A2 Strategic framing**: pre-launch hygiene AND competitive parity (DECIDED).
- **A3 Settings scope**: banner-only addition (ANSWERED from PRD §5.2, ADR §3.2).
- **A4 Verb pair durability**: stable for v1 (DECIDED).
- **A5 Prior attempts**: PR #989 confirmed unmerged on develop @ `291d23576` (ANSWERED).
- **B1 Buying persona**: compliance lead → revised to both compliance + AI engineer in Pass 2 (AMBIGUOUS in Pass 2).
- **B2 Scope priority**: rename + multiselect first; gates second → revised in Pass 2 (AMBIGUOUS in Pass 2).
- **B3 Latency budget**: Tier 1 (≤5ms target / ≤10ms max) — ANSWERED from `GUARDRAILS_SPEC.md` §10.1.
- **B4 Channel behavior**: channel-agnostic, inherits streaming evaluator (ANSWERED).
- **B5 Cross-feature precedence**: Guardrails gate first, Settings handle second — make explicit (ANSWERED).
- **B6 Tenant inheritance**: already supported via `IGuardrailPolicyScope.type === 'tenant'` (ANSWERED from `pipeline-factory.ts` L782-793).
- **C1 Packages**: 5 confirmed (apps/studio, apps/runtime, packages/database, packages/i18n, packages/shared).
- **C2 Schema migration**: additive only — no schema migration script (ANSWERED).
- **C3 Catalog endpoint location**: runtime route + Studio proxy (ANSWERED). [Revised in Pass 2 — A9: project-scoped, not global.]
- **C4 Server-side enforcement**: `apps/runtime/src/routes/guardrail-policies.ts` (ANSWERED).
- **C5 RBAC**: existing `guardrail:read` / `guardrail:write` permissions (defined in `packages/shared-auth/src/rbac/role-permissions.ts`, seeded by migration `20260509_029`); no new perms in v1. The activate route bundles into `guardrail:write` today; the `guardrail:activate` split is documented as a deferred extension in HLD §4 concern #4 (per HLD-phase user decision, Batch 3 of `clarifying-questions.md`). _Correction note_: the earlier wording of this decision referenced `guardrail-policy:update`/`:activate` — those strings exist only as audit-log action names, not RBAC permissions. Doc-correction applied 2026-05-15 during HLD prep.
- **C6 External SDK exposure**: zero external references (ANSWERED via grep — RESOLVED).
- **D1 Terminology table**: 14 terms confirmed (DECIDED, added 3 — preset rule / enabled rule / active policy).
- **D2 Fail-closed contract**: default `failMode: 'closed'` for policies → revised in Pass 2 (AMBIGUOUS, decided per-policy with `'open'` default).
- **D3 Threat model**: zero entities → no-op; unknown ID → silently skip; XSS → render-time escape (DECIDED).
- **D4 Rollout shape**: no feature flag, no compatibility lane, pre-deploy cleanup script (ANSWERED).
- **D5 Audit log requirements**: trace events only in v1; compliance audit logging deferred (ANSWERED).
- **E1 Market messaging**: keep in-product label; SEO aliases in docs (DECIDED → revised in Pass 2 as AMBIGUOUS).
- **E2 Onboarding modal**: opt-in `?` icon → revised in Pass 2 to first-run auto-open (DECIDED in Pass 2).
- **E3 Future third-party providers**: generalized multiselect with namespaced IDs (DECIDED).

### Pass 2 (UX Expert + CPO + web search) — re-evaluation

Pass 2 was explicitly chartered by the user to (a) wear UX-expert + CPO hats simultaneously, (b) use web search to verify competitor positioning, (c) escalate more aggressively when answers depend on product priorities.

**Web-research findings** that materially affected decisions:

- AWS Bedrock Guardrails calls the equivalent "Sensitive Information Filters" (noun phrase, plural). Lakera Guard calls it "Data Leakage Prevention." Aporia calls it "PII Protection." Azure AI Content Safety has no PII guardrail category. → AMBIGUOUS naming surfaced for user decision.
- AI-platform vendors (Vellum, Humanloop, Langfuse, Helicone) target AI engineers as the configurer persona. Our PRD's compliance-lead-first framing diverges from this norm. → AMBIGUOUS persona surfaced for user decision.
- WCAG 2.2.2 covers parallax/animation, NOT navigation-triggered modals. Pass 1's "opt-in only" justification was technically wrong. → Revised to first-run auto-open (DECIDED).

**Pass 2 DECIDED items locked in this spec**:

- D-1 — Decision matrix modal: first-run auto-open with localStorage gate (overrides Pass 1)
- D-2 — Mobile entity multiselect: out of scope v1 (accepted gap)
- D-3 — Decision matrix earns v1 complexity (kept)
- D-4 — Add 7 specific success metrics to §14
- D-5 — Action message: 500 chars, plain text only, server-side HTML strip
- D-6 — `validateRule()` extracted to `packages/shared/src/validation/guardrail-rule-validation.ts`
- D-7 — Telemetry: pre-commit grep, clean cutover if no `pii` tag refs
- - Default action message revised to channel-neutral

**Pass 2 AMBIGUOUS items escalated to user (9 total)** — all resolved via `AskUserQuestion`:

1. UX-1 Decision matrix auto-open vs opt-in → **auto-open** (now D-1)
2. UX-2 Naming (Sensitive Data Block vs Sensitive Information Filters etc.) → **keep "Sensitive Data Block"**
3. UX-3 Banner persistence (permanent vs 90-day TTL) → **90-day TTL**
4. UX-5 Default error copy → **improve to channel-neutral** (now D-default-copy)
5. CPO-1 Primary persona → **both compliance lead + AI engineer, explicit**
6. CPO-2 Scope tiebreaker → **Full v1 (~10 dev-days)**
7. CPO-5 Pricing wedge → **no gating, no documented wedge**
8. CPO-6 Voice fail mode → **per-policy `failMode` + fail-open default + UI disclosure**
9. NEW-A Entity catalog & disabled packs → **project-scoped, filter to enabled packs only**

---

## 2. Files Created / Modified

| Path                                                                         | Action    | Purpose                                                                                               |
| ---------------------------------------------------------------------------- | --------- | ----------------------------------------------------------------------------------------------------- |
| `docs/features/sub-features/guardrails-sensitive-data-block.md`              | CREATE    | Canonical feature spec (18 sections + Critical Feature Gate §C)                                       |
| `docs/testing/sub-features/guardrails-sensitive-data-block.md`               | CREATE    | Testing guide placeholder with 45-row coverage matrix, 8 E2E stubs, 6 integration stubs               |
| `docs/sdlc-logs/guardrails-sensitive-data-block/feature-spec.log.md`         | CREATE    | This file                                                                                             |
| `docs/features/sub-features/README.md`                                       | MODIFY    | Add row linking new feature spec                                                                      |
| `docs/testing/sub-features/README.md`                                        | MODIFY    | Add row linking testing guide                                                                         |
| `docs/features/sub-features/guardrails-sensitive-data-block.prd.md`          | MODIFY    | Marked as "Superseded by canonical feature spec"; open items table updated with 20 resolved decisions |
| `docs/architecture/2026-05-14-guardrails-pii-separation-adr.md`              | UNCHANGED | ADR remains canonical for the architectural decision                                                  |
| `docs/features/sub-features/guardrails-sensitive-data-block.wireframes.html` | UNCHANGED | Wireframes still match the spec (12 screens covering all features)                                    |

---

## 3. Review Findings (Round 1 — Completeness & Quality)

Standard review output contract from `pipeline.md`:

| Check                                             | Status | Note                                                                                                      |
| ------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------- |
| All 18 TEMPLATE.md sections addressed             | PASS   | §1–§18 all populated + §C Critical Feature Gate                                                           |
| Minimum 3 user stories                            | PASS   | 7 user stories covering compliance lead + AI engineer + project owner + tenant admin                      |
| Minimum 4 functional requirements (testable)      | PASS   | 40+ FRs across §4.1–§4.10 with testable "MUST" language                                                   |
| Integration matrix references 2+ related features | PASS   | 3 related features (Settings PII Protection, ABLP-921, Guardrails parent)                                 |
| Non-functional concerns address isolation         | PASS   | §12 covers project / tenant / user isolation explicitly                                                   |
| Surface semantics matrix included                 | PASS   | §8 includes the matrix (entity catalog, rule schema, preset definitions)                                  |
| Critical-feature gate satisfied                   | PASS   | §C — terminology table (14 terms), fail-closed contract, threat model (7 threats), rollout/rollback shape |
| Delivery plan: parent + numbered subtasks         | PASS   | §13 — 13 parent tasks with numbered subtasks                                                              |
| Open questions ≥1                                 | PASS   | §15 — 3 open questions (compliance sign-off, onboarding, third-party providers)                           |
| Claims grounded in code evidence                  | PASS   | Cited paths verified via Oracle exploration; Pass-1 ANSWERED items include line refs                      |

No CRITICAL or HIGH findings from Round 1. Two MEDIUM findings logged:

- (M-1) Compliance sign-off on `failMode: 'open'` default is genuinely open and tracked as §15 Open Question #1 + §16 GAP-002.
- (M-2) i18n team has not been engaged for translations; decision matrix copy is English-only at launch (GAP-004).

---

## 4. Review Findings (Round 2 — Cross-Phase Consistency)

| Check                                                 | Status | Note                                                                                                     |
| ----------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------- |
| FR numbering consistent and referenced in test matrix | PASS   | Testing guide coverage matrix (45 rows) covers every FR explicitly                                       |
| Scope boundaries match non-goals                      | PASS   | §2.1 Goals and §2.2 Non-Goals are mutually exclusive; mobile entity multiselect explicitly out (GAP-001) |
| User stories align with FRs                           | PASS   | Each user story maps to ≥2 FRs (e.g., Story #1 → FR-1, FR-6, FR-8; Story #4 → FR-7, FR-8)                |
| Implementation files exist or marked planned          | PASS   | Existing files have current paths verified; new files marked **NEW** in §10                              |
| Supported vs unsupported asset/entity types explicit  | PASS   | §8 Surface Semantics Matrix distinguishes runtime materialization, design-time, and unsupported (mobile) |
| Bugfix characterization (if applicable)               | N/A    | Not a bugfix; this is a refactor + new feature                                                           |

No CRITICAL findings. All MEDIUM findings carried forward as documented gaps.

---

## 5. Phase Handoff Packet

> Format per `docs/sdlc/pipeline.md` — Phase Handoff Packet section.

### What's in scope

Full v1 as documented in §2.1 Goals and §13 Delivery Plan (13 parent tasks, ~10 dev-days). No phasing.

### Inputs to next phase (Test Spec)

- Canonical feature spec at `docs/features/sub-features/guardrails-sensitive-data-block.md`
- Testing guide placeholder at `docs/testing/sub-features/guardrails-sensitive-data-block.md` (coverage matrix + 8 E2E stubs + 6 integration stubs to expand)
- ADR, PRD, wireframes (background context)
- Existing test patterns: `apps/runtime/src/__tests__/e2e/`, `apps/runtime/src/__tests__/execution/guardrails/policy-routes.test.ts`, `apps/studio/src/__tests__/components/guardrails/`

### Risks to surface

- (R-1) Compliance sign-off on `failMode: 'open'` default for voice channels — must be resolved before code commit on FR-6.7
- (R-2) Pack-disabled-entity warning UX is a soft Journey-D-class failure for the dropped entity (GAP-003) — Test Spec should write the warning-on-reopen scenario explicitly
- (R-3) Auto-deactivation transactional correctness (FR-7.4) — Test Spec should include race-condition harness (concurrent rule disable + concurrent policy reads)

### Open questions for Test Spec phase

- E2E test for the auto-deactivation Undo path — does the runtime API support an `?undo=true` flag on the rule re-enable, or is it a separate sequence of calls? (Implementation choice.)
- Performance benchmark for entity multiselect on a project with all 8 packs enabled (37 entities) — render time threshold?
- Studio Playwright E2E for the decision matrix modal first-run behavior — Playwright fixture strategy for localStorage isolation between tests?

### Quality gates passed

- Round 1 Completeness: PASS
- Round 2 Cross-Phase Consistency: PASS
- No CRITICAL/HIGH findings
- Code-evidence grounding: PASS (Oracle Pass 1 + Pass 2 both verified file paths and line refs)

### Status

**READY FOR TEST SPEC PHASE**

---

## 6. Package Learnings (agents.md updates pending)

Packages touched by this spec that should receive `agents.md` updates after implementation:

- `apps/studio/agents.md` — new components (`EntityMultiselect`, `DecisionMatrixModal`, `FailModeSelector`); shared validation import pattern; first-run modal localStorage pattern
- `apps/runtime/agents.md` — new route (`/api/projects/:projectId/pii-entities`); post-detection entity filter pattern; auto-deactivation transactional update
- `packages/shared/agents.md` — `validateRule()` precedent (mirroring `pii-pack-names.ts` from ABLP-921)
- `packages/database/agents.md` — additive schema fields on `IGuardrailRule` (`entities?`, `kind?`, `actionMessage?`)
- `packages/i18n/agents.md` — `guardrails.preset.sensitiveDataBlock`, `settings.help.piiProtection`, `guardrails.help.sensitiveDataBlock` key namespaces

These are updated AFTER implementation per CLAUDE.md SDLC workflow (each phase appends to relevant packages' `agents.md`). The feature-spec phase doesn't change those files yet.

---

## 5b. Round 3 Findings (phase-auditor agent — formal pass 1 of 3)

Formal auditor pass run after Rounds 1 + 2 self-reviews. Verdict: **FAIL** — 3 CRITICAL + 5 HIGH + 3 MEDIUM findings. All applied as in-place spec edits.

| Finding                                                                                        | Severity | Gate | Fix Applied                                                                                                                                       |
| ---------------------------------------------------------------------------------------------- | -------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| F-1: `IGuardrailRule` field-name divergence from Mongoose schema                               | CRITICAL | G2   | Rewrote §9 Data Model with actual schema fields + added "Schema vs. Studio-Form Field Mapping" subsection; rewrote FR-5.x to reflect ground truth |
| F-2: `kind` enum narrowing (3 values instead of existing 5) would be breaking                  | CRITICAL | G2   | Revised FR-5.3 to ADD `'both'` as a 6th value to the existing 5-value enum (additive, not breaking)                                               |
| F-3: Activate endpoint is `POST /:id/activate`, not `PATCH /:policyId/activate`                | CRITICAL | G2   | Updated FR-7.3, FR-8.4, and §8 API table to use the verified HTTP methods (`POST` for activate, `PUT` for update) and param name (`:id`)          |
| F-4: `failMode` schema default is `'closed'`, not `'open'` as spec claimed                     | HIGH     | G2   | Updated FR-5.4 and §7 Technical Considerations to explicitly document the schema default change from `'closed'` to `'open'`                       |
| F-5: Interface is `IGuardrailSettings`, not `IGuardrailPolicySettings`                         | HIGH     | G2   | Global replace across spec (4 occurrences in §4.5, §8, §11, §13)                                                                                  |
| F-6: Terminology table missing 5 key terms                                                     | HIGH     | G1   | Added entries for `guardrailName`, `override`, `checkType`, `evaluator`, and `threshold/confidenceThreshold/severityThreshold` disambiguation     |
| F-7: Wireframe screen 10 shows static "37 entities" — inconsistent with project-scoped catalog | HIGH     | G4   | Updated wireframe HTML (`All entities from your enabled packs` / `Showing 11 of {N} entities`) and added note in spec §6                          |
| F-8: Data Model indexes don't match the actual model                                           | HIGH     | G2   | Replaced indexes block with the four real indexes (verified at model L270-282)                                                                    |
| F-9: FR-7.1, FR-8.1 used MAY instead of MUST                                                   | MEDIUM   | G3   | Rephrased both as "The system MUST reject..." per RFC 2119                                                                                        |
| F-10: Threat model missing rate-limit + log-injection vectors                                  | MEDIUM   | G1   | Added threats #8 (catalog endpoint rate limit) and #9 (log injection via `actionMessage`)                                                         |
| F-11: Phase log says "44-row" but matrix has 45                                                | MEDIUM   | G4   | Corrected this log file in both §2 and §4                                                                                                         |

## 5c. Round 4 Findings (phase-auditor agent — formal pass 2 of 3)

Formal auditor pass run after Round 3 fixes. Verdict: **NEEDS_REVISION** (soft fail — 1 HIGH + 4 MEDIUM). All findings applied.

| Finding                                                                                                                                                                                                                                                                                                                           | Severity | Gate | Fix Applied                                                                                                                                                                                                |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F-1: Round 3 mistakenly proposed extending `kind` enum to add `'both'` as a 6th schema value, but `'both'` is a form-level convenience that `serializeRule()` (Studio L504-508) and `normalizeRules()` (runtime L538-543) expand to two persisted rules before write. Adding it to the schema would create dead-letter documents. | HIGH     | G8   | Reverted Round 3 change. FR-5.3, §9 Data Model, Schema-vs-Form mapping table, §11 DSL/Schema, §13 Delivery Plan 1.1, §C.4 Rollback now all state `kind` enum is unchanged and `'both'` is form-level only. |
| F-2: 3 stale PATCH refs at §12 Data Lifecycle (L479), §13 Delivery Plan 3.1 (L498), and §C.3 Threat row 4 (L672).                                                                                                                                                                                                                 | MEDIUM   | G6   | Replaced with `PUT /:id` (update) and added route line references.                                                                                                                                         |
| F-3: Schema-vs-Form mapping claimed `presetKey` was "passthrough today" but grep shows it doesn't exist anywhere in form code.                                                                                                                                                                                                    | MEDIUM   | G8   | Updated mapping row to say "not present today" with explicit list of code locations the implementer must touch (`RuleData`, `createPresetRules()`, `serializeRule()`, `FORM_SUPPORTED_RULE_KEYS`).         |
| F-4: Promoting `enabled` to schema requires changing `serializeRule()` (currently early-returns `[]` for disabled rules at L460-462) AND adding `'enabled'` to `FORM_SUPPORTED_RULE_KEYS` — not stated in spec.                                                                                                                   | MEDIUM   | G8   | Added implementation note to the `enabled` row in the Schema-vs-Form mapping table.                                                                                                                        |
| F-5: 7 stale PATCH refs in testing guide (E2E-1, E2E-2, E2E-3, E2E-4 [3x], INT-5).                                                                                                                                                                                                                                                | MEDIUM   | G9   | Replaced with the verified `POST .../:id/activate` and `PUT .../:id`.                                                                                                                                      |

## 7. Cross-Cutting Insights (for `docs/sdlc-logs/agents.md`)

- **Oracle multi-pass pattern works**: A PM-voice Pass-1 followed by a UX+CPO Pass-2 with web search uncovered three substantively wrong Pass-1 decisions (auto-open modal, persona, fail-mode default). The two-pass pattern is cheap and corrects for single-perspective biases.
- **Web search material to spec quality**: Competitor naming research (Bedrock "Sensitive Information Filters" vs our "Sensitive Data Block") would not have surfaced without explicit web-search permission. PMs should grant web search to product-oracle agents on feature-spec phases when the feature is in a well-defined market category.
- **AMBIGUOUS escalation is healthier than DECIDED**: Pass-1 forced 19 decisions to DECIDED; Pass-2 correctly identified 9 of those as actually AMBIGUOUS (PM judgment calls). Lower bar for escalation when the user invites it.
- **PRD → feature-spec transition pattern**: Mark the PRD "Superseded" with a header note pointing to the canonical spec; preserve the PRD as the journey/journey-transcripts artifact. Don't delete; don't keep two ground-truths.
