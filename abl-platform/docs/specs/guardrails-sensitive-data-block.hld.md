# HLD: Guardrails — Sensitive Data Block

**Doc Type**: High-Level Design (Phase 3)
**Feature**: [Guardrails Sensitive Data Block](../features/sub-features/guardrails-sensitive-data-block.md)
**Test Spec**: [`guardrails-sensitive-data-block.md`](../testing/sub-features/guardrails-sensitive-data-block.md)
**Status**: APPROVED
**Owner(s)**: Eng — TBD; Product — Girish
**JIRA**: ABLP-723 (reuse — supersedes unmerged PR #989)
**Last Updated**: 2026-05-18

---

## 1. Problem Statement

The Guardrails subsystem and Settings → PII Protection currently expose **two overlapping PII surfaces** to operators, with conflicting verbs and three latent defects: (a) policies can be activated with zero enabled rules; (b) rules can be enabled without all required fields; (c) the `builtin-pii` provider blocks PII monolithically with no entity granularity.

This HLD designs the architecture that delivers:

1. **Sharply separated PII surfaces**: Guardrails for _stop_ (block/warn/escalate); Settings for _handle_ (mask/tokenize/render-per-consumer). No overlapping action vocabulary. (FR-1.x, FR-2.x)
2. **Entity-level granularity** on the Sensitive Data Block preset, backed by the ABLP-921 recognizer registry. (FR-6.x, FR-10.x)
3. **Two integrity gates**: policies can only be `active` with ≥1 enabled rule; rules can only be `enabled` when all required fields are populated. (FR-7.x, FR-8.x)
4. **Decision matrix UX**: a first-run modal teaches the "stop vs. handle" mental model, with 90-day-TTL cross-link banners between surfaces. (FR-3.x)
5. **Pre-launch posture**: schema changes are additive; no migration script; no feature flag; cleanup script removes tester data.

All design decisions trace back to: (a) the canonical 45-FR feature spec, (b) 12 user decisions in `clarifying-questions.md`, (c) Phase-2 test spec's 14 E2E + 11 integration scenarios, and (d) a Phase-3 explorer-agent architecture map of the existing guardrails subsystem.

---

## 2. Alternatives Considered

### Alternative A — Full Unification (REJECTED in Phase 0 ADR §5.4)

Merge Guardrails and Settings PII Protection into a single screen (Bedrock-style "Sensitive Information Filters"). Block/mask/tokenize/redact all chosen on the same row.

- **Pros**: Single mental model; no cross-link UX; no terminology overlap.
- **Cons**: Forces a 2D matrix (per-entity × per-action) that doesn't fit the 1D Guardrail rule model; breaks the existing Settings PII Protection vault contract; collapses the `block` vs. `tokenize` distinction that the platform's two consumer-render-modes already enforce; high migration risk for the existing `pii_redaction.packs` runtime config.
- **Effort**: L (~25 dev-days).
- **Verdict**: Rejected — ADR §5.4 captured the rationale. Settings vault tokenization is reversible and consumer-aware; Guardrails block is not. Conflating them loses architectural information.

### Alternative B — Lifecycle-Verb Permission Model from Day One (REJECTED for v1)

Introduce `guardrail:activate` as a separate permission from `guardrail:write` immediately. Migrate every existing role grant via a backfill script. Establish maker-checker workflow infrastructure.

- **Pros**: Defense-in-depth from day one; aligns with the codebase's 4 precedent patterns (`version:promote`, `prompt:promote`, `deployment:retire`, `module:publish`); supports custom "safety reviewer" / "compliance approver" roles.
- **Cons**: Ships ~50 lines of additional migration logic + 10 production-line changes + role-grant audit. **Pre-launch posture means zero existing role grants exist** — the immediate value of the split is zero, and the cost of adding it later (when role grants do exist) is materially the same as adding it now (additive migration + flip the route check, ~2 dev-days either way).
- **Effort**: S (~2 dev-days).
- **Verdict**: Rejected for v1 per user decision (Q-HLD-A1, 2026-05-15). HLD §4 concern #4 documents the exact additive extension path so future implementation is a 6-step runbook rather than a re-derivation. Activation route stays on `guardrail:write` for v1.

### Alternative C — Selected — Server-side Gate + Provider-Level Filter + Studio Form Polish (CHOSEN)

Three orthogonal additive changes:

- **Server-side activation/rule gate** in the existing routes (rejects incomplete state with structured error codes).
- **Provider-level entity filter** inside `BuiltinPIIProvider.evaluate()` keyed on a new `request.context.allowedEntityTypes` field.
- **Studio form polish** (rename preset, restrict action enum, add EntityMultiselect + FailModeSelector + DecisionMatrixModal).

- **Pros**: Each change is additive. No schema migration. No new permissions. Existing 4-precedent pattern for lifecycle-verb permissions is _documented_ in §4 concern #4 for future extension. Aligns with existing `pii-patterns.ts` route conventions. Reuses `RuntimeApiHarness` and `BuiltinPIIProvider` infrastructure.
- **Cons**: The Studio form must be extended in 3-4 places (preset row, RuleCard, GuardrailsConfigPage, PIIProtectionTab); ~10 dev-days total. Three new schema fields (`enabled`, `presetKey`, `entities`, `actionMessage`) require the Studio `passthroughRules` mechanism to be adjusted so they round-trip as first-class fields rather than pass-throughs.
- **Effort**: M (~10 dev-days).
- **Verdict**: Chosen. Recommendation rationale: minimum-viable change with clear extension hooks; consistent with platform invariants; aligned with the user-decided forward-extensibility plan for permissions.

---

## 3. Architecture

### 3.1 System Context

```
┌──────────────────────────────────────────────────────────────────────────┐
│                            Studio (apps/studio)                          │
│                                                                          │
│  ┌────────────────────────────┐    ┌────────────────────────────────┐    │
│  │ GuardrailPolicyForm        │    │ PIIProtectionTab (Settings)   │    │
│  │  • SDB preset row          │    │  • Cross-link banner          │    │
│  │  • EntityMultiselect       │    │  • 90-day TTL                 │    │
│  │  • FailModeSelector        │    │                               │    │
│  │  • RuleCard (enable gate)  │    │                               │    │
│  │  • DecisionMatrixModal     │    │                               │    │
│  └─────────────┬──────────────┘    └────────────────────────────────┘    │
│                │                                                         │
│  ┌─────────────▼──────────────┐    ┌─────────────────────────┐           │
│  │ apps/studio/src/api/       │    │ packages/shared/        │           │
│  │  • pii-entities.ts (NEW)   │    │   validation/           │           │
│  │  • useGuardrails.ts        │    │  • guardrail-rule-      │           │
│  │    (extended)              │    │    validation.ts (NEW)  │           │
│  └─────────────┬──────────────┘    └────────────┬────────────┘           │
└────────────────┼────────────────────────────────┼────────────────────────┘
                 │ HTTPS / apiFetch               │ ESM import
                 │                                │ (also imported by runtime)
┌────────────────▼────────────────────────────────▼────────────────────────┐
│                    Runtime (apps/runtime — port 3112)                    │
│                                                                          │
│  ┌─────────────────────────────────────────────────────────────────┐     │
│  │ routes/                                                         │     │
│  │  • guardrail-policies.ts (EXTENDED — activation+rule gates,     │     │
│  │    auto-deactivation)                                           │     │
│  │  • pii-entities.ts (NEW — entity catalog endpoint)              │     │
│  └─────────────────┬─────────────────────┬──────────────────────────┘    │
│                    │                     │                               │
│  ┌─────────────────▼──┐  ┌───────────────▼──────────────────┐            │
│  │ services/guardrails│  │ services/execution/              │            │
│  │  • pipeline-factory│  │   reasoning-executor.ts          │            │
│  │   (loads+delegates)│  │  (emits guardrail_input_blocked  │            │
│  │  • policy-resolver │  │   with new `presetKey` field)    │            │
│  │   (toSynthGuardrail│  │                                  │            │
│  │    -- IR mapping)  │  │                                  │            │
│  │  • trace-events.ts │  │                                  │            │
│  └─────────────────┬──┘  └──────────────────────────────────┘            │
└────────────────────┼─────────────────────────────────────────────────────┘
                     │ in-process call
┌────────────────────▼─────────────────────────────────────────────────────┐
│              packages/compiler/src/platform/                             │
│                                                                          │
│  ┌─────────────────────────────────────────────────────────────────┐     │
│  │ guardrails/                                                     │     │
│  │  • pipeline.ts (executes Guardrail[], reads failMode at L598)   │     │
│  │  • providers/builtin-pii.ts (EXTENDED — post-detection          │     │
│  │    entity filter on request.context.allowedEntityTypes)         │     │
│  │  • tier2-evaluator.ts (populates context.allowedEntityTypes     │     │
│  │    from guardrail.entities)                                     │     │
│  └─────────────────┬───────────────────────────────────────────────┘     │
│                    │ uses                                                │
│  ┌─────────────────▼───────────────────────────────────────────────┐     │
│  │ security/recognizer-packs/                                      │     │
│  │  • core.ts, us.ts, eu.ts, apac.ts, financial.ts, medical.ts,    │     │
│  │    network.ts, international-phone.ts (EACH gets new            │     │
│  │    ENTITIES export — static metadata)                           │     │
│  │  • catalog.ts (NEW — aggregator: listEnabledPIIEntities(enabledPacks))│     │
│  │  • pii-recognizer-registry.ts (UNCHANGED — detection runtime)   │     │
│  └─────────────────────────────────────────────────────────────────┘     │
└──────────────────────────────────────────────────────────────────────────┘

                                  ┌──────────────────────────────────┐
                                  │  MongoDB                          │
                                  │   • guardrail_policies            │
                                  │     (additive fields: entities?,  │
                                  │      enabled?, presetKey?,        │
                                  │      actionMessage?; failMode     │
                                  │      default flip 'closed'→'open')│
                                  │   • project_runtime_configs       │
                                  │     (pii_redaction.packs read by  │
                                  │      catalog endpoint)            │
                                  └──────────────────────────────────┘
```

### 3.2 Component Diagram (responsibilities)

**Studio side**:

- `EntityMultiselect.tsx` (NEW): renders quick-preset radio + scrollable entity list. Consumes catalog via `usePIIEntities(projectId)` SWR hook.
- `DecisionMatrixModal.tsx` (NEW): WCAG APG dialog. localStorage-gated auto-open on first visit.
- `FailModeSelector.tsx` (NEW): radio with consequence disclosure.
- `RuleCard.tsx` (EXTENDED): enable toggle disabled when `validateRule()` returns invalid; tooltip lists missing fields.
- `GuardrailPolicyForm.tsx` (EXTENDED): rename `pii_protection` → `sensitive_data_block` preset; serialize new fields; consume `validateRule()`.
- `GuardrailsConfigPage.tsx` (EXTENDED): green-dot chips on policy list; auto-deactivation toast.
- `PIIProtectionTab.tsx` (EXTENDED): 90-day-TTL cross-link banner.
- `pii-entities.ts` (NEW): Studio API proxy + SWR hook for catalog.

**Runtime side**:

- `pii-entities.ts` (NEW route): `GET /api/projects/:projectId/pii-entities`. Reads pack-enable state from `project_runtime_configs.pii_redaction.packs`, calls `listEnabledPIIEntities()` from compiler-layer aggregator.
- `guardrail-policies.ts` (EXTENDED): `normalizeRules()` populates `enabled`/`presetKey`/`actionMessage`/`entities` (no longer passthrough). PUT handler runs `validateRule()` server-side, returns `RULE_INCOMPLETE`. Activate handler runs activation gate, returns `NO_ENABLED_RULES`. Auto-deactivation logic in PUT handler when last enabled rule is disabled.
- `trace-events.ts` (EXTENDED): two new factories `traceGuardrailActivationBlocked()` and `traceGuardrailAutoDeactivation()`. Existing `guardrail_input_blocked` / `guardrail_output_blocked` event data gains `presetKey?: string`.

**Compiler side**:

- `builtin-pii.ts` (EXTENDED): post-detection filter using `request.context.allowedEntityTypes`.
- `tier2-evaluator.ts` (EXTENDED): populates `request.context.allowedEntityTypes` from `guardrail.entities`.
- `catalog.ts` (NEW): pure-function aggregator over pack `ENTITIES` exports.
- Each pack file gets an `ENTITIES: ReadonlyArray<EntityCatalogEntry>` export.

**Shared side**:

- `packages/shared/src/validation/guardrail-rule-validation.ts` (NEW): pure `validateRule(rule): { valid, missingFields }`. Imported by Studio form and runtime route.

### 3.3 Data Flow — Block-on-SSN

```
1. Studio form: User creates an SDB policy with rule { entities: ['us_ssn'], ... }
   ↓ POST /api/projects/:projectId/guardrail-policies
2. Route handler (apps/runtime/src/routes/guardrail-policies.ts):
   a. requireRouteScopePermission(req, res, context, 'guardrail:write') → OK
   b. normalizeRules() — promotes form fields to schema first-class (no passthrough for new keys)
   c. validateRule() per rule — server-side enforcement of FR-8.1
   d. GuardrailPolicy.create(...) with new schema fields persisted
3. User activates: POST .../guardrail-policies/:id/activate
   a. requireRouteScopePermission(req, res, context, 'guardrail:write') → OK [today; future: 'guardrail:activate' — §4 concern #4]
   b. Activation gate: count enabled rules. If 0 → 400 { code: 'NO_ENABLED_RULES' } + trace event
   c. deactivateSiblingPolicies() + findOneAndUpdate({status:'active', isActive:true})
4. End-user message arrives at runtime; agent execution begins:
   ↓ runtime/src/services/execution/reasoning-executor.ts
5. `pipeline-factory.ts` loads active policies and delegates to `GuardrailPolicyResolver`; the mapping function is `toSyntheticGuardrail()` in `apps/runtime/src/services/guardrails/policy-resolver.ts` L126-152, which now propagates `rule.entities` → `guardrail.entities`. Intermediate `PolicyRule` type at `policy-resolver.ts` L11-27 gains `entities?`, `enabled?`, `presetKey?`, `actionMessage?` so the mapping compiles.
6. pipeline.ts executes Tier-2 (model) for the SDB rule
7. tier2-evaluator.ts constructs GuardrailEvalRequest with context.allowedEntityTypes = guardrail.entities
8. BuiltinPIIProvider.evaluate(request):
   a. detectPII(content) — returns ALL detections (us_ssn match + any other entity types)
   b. POST-FILTER: const allowed = new Set(request.context.allowedEntityTypes); detections.filter(d => allowed.has(d.type))   // Set for O(1) lookup; using d.type (not d.entityType) — see LLD §5.3 R3-F1
   c. score = filteredDetections.length > 0 ? 1.0 : 0.0
9. pipeline.ts: score ≥ threshold (0.7) → ACTION.block
10. reasoning-executor.ts L1904 emits guardrail_input_blocked event with data.presetKey = 'sensitive_data_block'
11. HTTP response returns the blocked envelope with rule.actionMessage
```

### 3.4 Sequence Diagram — Auto-Deactivation Race

```
T1 user                T2 user                   Route handler           MongoDB
   │                      │                            │                      │
   │ PUT /:id             │                            │                      │
   │  rules[0].enabled=   │                            │                      │
   │  false               │                            │                      │
   │  ──────────────────────────────────────────────────►                     │
   │                      │ PUT /:id                   │                      │
   │                      │  rules[1].enabled=         │                      │
   │                      │  false                     │                      │
   │                      │  ──────────────────────────►                      │
   │                      │                            │                      │
   │                      │                       normalizeRules,             │
   │                      │                       validateRule                │
   │                      │                            │                      │
   │                      │                       count enabled = 1           │
   │                      │                            │                      │
   │                      │           findOneAndUpdate({                      │
   │                      │             $set: { rules, isActive: true* } })   │
   │                      │             *unchanged since 1 still enabled      │
   │                      │                            │ ───────────────────► │
   │                      │                            │ ◄─── updated doc ─── │
   │                      │                            │                      │
   │                      │                       normalizeRules,             │
   │                      │                       validateRule                │
   │                      │                            │                      │
   │                      │                       READ stale state from req:  │
   │                      │                       count enabled = 0 in body   │
   │                      │                            │                      │
   │                      │           findOneAndUpdate({                      │
   │                      │             $set: { rules, isActive: false,       │
   │                      │                    status: 'draft' } })           │
   │                      │             autoDeactivated: true                 │
   │                      │                            │ ───────────────────► │
   │                      │                            │ ◄─── updated doc ─── │
   │                      │                            │                      │
   │                      │  ◄─ 200 autoDeactivated:true                      │
   │ ◄─ 200 unchanged isActive                         │                      │
```

**Atomicity guarantee**: Each `findOneAndUpdate` is a single-document Mongo op (atomic). The post-update enabled-rule count is computed from the request body's `rules` array, applied as part of the `$set`. There is no window where the persisted state is `isActive: true && rules.every(r => !r.enabled)`. The single-doc atomicity is sufficient (D-3 from HLD oracle pass).

### 3.5 Surface Semantics & Ownership

| Asset                                    | Source of Truth                                                                                   | Design-time Surface                                 | Runtime Materialization                                                                                | Local-only?                                        |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------- |
| `IGuardrailRule.entities[]`              | `guardrail_policies` (Mongo)                                                                      | `EntityMultiselect` (Studio)                        | Post-detection filter in `BuiltinPIIProvider`                                                          | NO — persisted                                     |
| Entity catalog metadata                  | `recognizer-packs/<pack>.ts` `ENTITIES` exports                                                   | `EntityMultiselect` via `usePIIEntities(projectId)` | Compiler-layer `listEnabledPIIEntities()` resolves to recognizer functions                             | NO — but read-only from Studio (engineering-owned) |
| `presetKey` value `sensitive_data_block` | `GuardrailPolicyForm.createPresetRules()` (form) + `guardrail_policies.rules[].presetKey` (Mongo) | Hidden — set automatically                          | Used by trace events for filtering                                                                     | NO — persisted                                     |
| Decision matrix copy                     | i18n keys (`guardrails.help.sensitiveDataBlock`, `settings.help.piiProtection`)                   | `DecisionMatrixModal`                               | Not runtime-relevant                                                                                   | YES — Studio-only                                  |
| Banner dismissal state                   | `localStorage` (`settings-pii-banner-dismissed`, `decision-matrix-dismissed`)                     | `PIIProtectionTab` / `DecisionMatrixModal`          | Not runtime-relevant                                                                                   | YES — client-only                                  |
| `failMode`                               | `guardrail_policies.settings.failMode` (Mongo)                                                    | `FailModeSelector` (Studio)                         | `pipeline.ts` L598 reads on every execution                                                            | NO — persisted                                     |
| `kind: 'both'`                           | Form-only state (`RuleData.kind`)                                                                 | `RuleCard` checkboxes                               | NEVER persisted — `serializeRule()` (Studio) and `normalizeRules()` (Runtime) both expand to two rules | YES — form-only                                    |

### 3.6 Activation & Reachability Path

This feature has **four reachability hops** that all must land for the entity-filter behavior to reach production (per oracle pass Q-HLD-14):

1. **Schema** — `IGuardrailRule.entities?: string[]` added to `packages/database/src/models/guardrail-policy.model.ts`. Without this, Mongoose silently strips the field on save (strict mode default).
2. **Policy resolver** — Mapping from `IGuardrailRule` (Mongo) → `Guardrail` IR (compiler) happens in `toSyntheticGuardrail()` at `apps/runtime/src/services/guardrails/policy-resolver.ts` L126-152 (NOT in `pipeline-factory.ts`, which only loads policies and delegates to `GuardrailPolicyResolver`). The function must propagate `rule.entities` → `guardrail.entities` (add `entities: rule.entities,` at approximately L148). The `Guardrail` interface at `packages/compiler/src/platform/ir/schema.ts` L1603-1637 gains `entities?: string[]`. **Intermediate `PolicyRule` type** at `policy-resolver.ts` L11-27 must also gain the new fields (`entities?: string[]`, `enabled?: boolean`, `presetKey?: string`, `actionMessage?: string`) so the Mongo → resolver → IR chain compiles end-to-end.
3. **Tier-2 evaluator** — `tier2-evaluator.ts` L172-179 constructs `GuardrailEvalRequest`. It must populate `request.context.allowedEntityTypes = guardrail.entities ?? undefined`. Without this, the provider never sees the filter.
4. **Provider** — `BuiltinPIIProvider.evaluate()` at `builtin-pii.ts` L23-42 reads `request.context?.allowedEntityTypes` and filters `result.detections` to entities in that list.

**Reachability proof**: Test spec E2E-1 (POST SSN message → blocked) + E2E-1 step 4 (POST email-only message → NOT blocked, because rule's entities don't include `email_address`). If any of the 4 hops is missing, E2E-1 step 4 fails (email would be blocked if the filter is absent OR if the entity passthrough fails).

**Auto-deactivation reachability**: 3 observable signals (per oracle Q-HLD-15):

- HTTP response includes `autoDeactivated: true`
- Trace event `guardrail_auto_deactivation` with `{ policyId, ruleId, undone }`
- GET on policy returns `isActive: false, status: 'draft'`

Monitoring alert: **zero `guardrail_auto_deactivation` events after 30 days in production** triggers investigation (silent no-op). Caveat: zero events could equally mean "no one disabled the last enabled rule on an active policy" (plausible benign state) — operator must verify against the code-path-exercise health check (deferred to post-launch operational readiness; coarse signal in v1, not a definitive failure detector).

---

## 4. The 12 Architectural Concerns

### Structural Concerns

#### Concern #1 — Tenant Isolation

- **Scope**: All `guardrail_policies` queries are tenant-scoped via the `tenantIsolationPlugin` (`packages/database/src/mongo/plugins/tenant-isolation.plugin.ts`). The collection has compound index `{ tenantId:1, name:1, 'scope.type':1, 'scope.projectId':1, 'scope.agentDefId':1 }` (unique).
- **Route enforcement**: Both mounts (`/api/projects/:projectId/guardrail-policies` and `/api/guardrail-policies`) use the local `requireRouteScopePermission()` helper. Helper dispatches to `requirePermissionInline` (tenant) or `requireProjectPermission` (project) depending on `req.params.projectId` presence.
- **Cross-tenant access**: Returns **404** (not 403), via the `buildScopedPolicyFilter()` helper which combines `tenantId` + scope filters in the Mongo query. Mongo returns nothing → route returns `NOT_FOUND`. Per CLAUDE.md Core Invariant 1.
- **New entity catalog endpoint**: Same isolation pattern. The `pii_redaction.packs` runtime-config is also tenant+project scoped.

#### Concern #2 — Data Access Pattern

- **Repository layer**: None for guardrail policies — direct Mongoose model access via `GuardrailPolicy` (from `packages/database`). Existing route pattern (`GuardrailPolicy.findOne(buildScopedPolicyFilter(...))`) is preserved.
- **Caching**: No caching on policy CRUD writes. Pipeline policy resolution uses `policy-epoch.ts` (Redis-backed monotonic counter) for cache invalidation. Auto-deactivation bumps the epoch via `bumpAffectedPolicyEpochs()`.
- **Entity catalog caching**: Studio side uses SWR with `revalidateOnFocus: false` per FR-10.2. Server side: stable per `(projectId, pack-enable-state)`. Optional in-process cache with 60s TTL keyed on `(projectId, configHash)` if profiling shows the registry walk dominates — out of scope for v1 absent measurement.
- **Recognizer pack metadata**: New `ENTITIES` arrays are static `const ReadonlyArray<EntityCatalogEntry>` exports. Aggregated by `catalog.ts` at module load — effectively cached for the process lifetime.

#### Concern #3 — API Contract

- **Routes** (verified against `apps/runtime/src/routes/guardrail-policies.ts` and `server.ts` L1248-1250):

| Method | Path                                                       | Permission         | New / Extended                                                             |
| ------ | ---------------------------------------------------------- | ------------------ | -------------------------------------------------------------------------- |
| GET    | `/api/projects/:projectId/pii-entities`                    | `pii-pattern:read` | **NEW** (`apps/runtime/src/routes/pii-entities.ts`)                        |
| GET    | `/api/projects/:projectId/guardrail-policies`              | `guardrail:read`   | unchanged                                                                  |
| POST   | `/api/projects/:projectId/guardrail-policies`              | `guardrail:write`  | extended (`normalizeRules` promotes new fields; `validateRule()` enforces) |
| GET    | `/api/projects/:projectId/guardrail-policies/:id`          | `guardrail:read`   | unchanged                                                                  |
| PUT    | `/api/projects/:projectId/guardrail-policies/:id`          | `guardrail:write`  | extended (rule completeness gate + auto-deactivation)                      |
| POST   | `/api/projects/:projectId/guardrail-policies/:id/activate` | `guardrail:write`  | extended (activation gate)                                                 |
| DELETE | `/api/projects/:projectId/guardrail-policies/:id`          | `guardrail:write`  | unchanged                                                                  |

Tenant-scoped mounts at `/api/guardrail-policies/...` (no `:projectId`) share the same router; route handlers detect scope via `getRouteScopeContext()`.

- **Error envelope** (universal): `{ success: false, error: { code: string, message: string, missingFields?: string[] } }`. Codes:
  - Route-specific (this feature): `NO_ENABLED_RULES`, `RULE_INCOMPLETE`, `INVALID_ACTION_MESSAGE`, `ACTION_MESSAGE_TOO_LONG`.
  - Platform/middleware (inherited): `UNAUTHORIZED` (401, missing or invalid token), `INSUFFICIENT_PERMISSIONS` (403), `NOT_FOUND` (404, includes cross-scope hits per Core Invariant 1), `TENANT_ACCESS_DENIED` (403, when tenant context is missing in a tenant-required route).
  - No stack traces in any response.
- **Catalog response shape**: `{ success: true, data: { entities: Array<{ id: string, label: string, pack: string, tier: 1|2|3, description?: string }> } }`. Sorted by `(pack, tier, label)`.
- **Versioning**: No version flag introduced. New schema fields are optional; old clients sending requests without them continue to work.

#### Concern #4 — Security Surface

**Auth**:

- All routes go through `authMiddleware` + `requireFeature('guardrails')` (already in place for guardrail routes).
- Catalog endpoint follows the `pii-patterns.ts` precedent (uses `pii-pattern:read`, not `guardrail:read`).
- New permission `pii-pattern:read` is NOT new — seeded via migration `20260509_029`.

**Input validation**:

- `actionMessage`: 500-char max; UTF-8 enforced; null bytes rejected (`\x00`); HTML stripped on save. Validation lives in the runtime route handler AND in `validateRule()` (pure function in `packages/shared`). Universal envelope on rejection.
- `entities[]`: array of strings; each entity ID must be ≤ 64 chars; total array ≤ 50 entities. **Enforcement location**: `validateRule()` in `packages/shared/src/validation/guardrail-rule-validation.ts` — it already enforces `entities.length > 0` for PII rules (FR-8.1); extend it to also enforce `entities.length ≤ 50` and `entities.every(id => id.length ≤ 64)`. Same function runs client-side (Studio form) and server-side (PUT/POST route handler), so the bound is enforced symmetrically. Catalog-membership check (entity ID exists in current pack-enable catalog) is enforced at Studio save-time only, not server-side (per FR-10.4: unknown IDs are silently skipped at runtime — supports the disabled-pack-entity warning UX).
- Standard Zod schemas; `z.string().min(1)` for IDs (CLAUDE.md: no CUID/CUID2/NanoID/ULID validators).

**Rate limiting**: `tenantRateLimit('request')` middleware applies to all `/api/projects/:projectId/...` routes (existing platform middleware). The new `pii-entities` route inherits this — verified against the `pii-patterns.ts` precedent.

**Threats covered** (mapped to test spec §8.3):

- T1 (zero-entity rule) — `validateRule()` rejects
- T2 (pack-disabled silent skip) — UI warning on rule re-open (FR-10.4)
- T3 (XSS in actionMessage) — server-side strip + React escaping
- T4 (API bypass of UI gates) — server-side `validateRule()` + activation gate
- T5 (cross-project catalog leak) — 404 via tenant-isolation
- T6 (race on auto-deactivation) — single-doc atomicity
- T7 (telemetry PII leak) — events store entity IDs only, no matched substrings
- T8 (catalog rate-limit enumeration) — inherits platform middleware
- T9 (log injection via actionMessage) — `createLogger` JSON-escapes; null bytes rejected

**Future extension hook — `guardrail:activate` permission split** (per user decision Q-HLD-A1, deferred for maker-checker introduction):

> The activation route currently uses `guardrail:write` (same as create/update/delete). When maker-checker workflow is introduced, follow this additive runbook:
>
> 1. Add `'guardrail:activate'` to `PERMISSION_REGISTRY` in `packages/shared-auth/src/rbac/role-permissions.ts` (alongside `'guardrail:read'`, `'guardrail:write'`).
> 2. Grant the new permission to existing built-in roles that have `guardrail:write` today (admin, developer). This preserves current behavior for all built-in roles.
> 3. Migration script: `$addToSet guardrail:activate` for every role grant that has `guardrail:write` (template: `packages/database/src/migrations/scripts/20260509_029_seed_admin_guardrail_pii_permissions.ts`).
> 4. Flip `apps/runtime/src/routes/guardrail-policies.ts` L1352 from `'guardrail:write'` to `'guardrail:activate'`.
> 5. Custom roles can then opt to drop `:activate` to enforce four-eyes.
> 6. New `safety-approver` / `compliance-reviewer` role becomes possible.
>
> Test spec INT-11 F-1 is the future test case (deferred). Precedent: `version:promote`, `prompt:promote`, `deployment:retire`, `module:publish`.

### Behavioral Concerns

#### Concern #5 — Error Model

- **`NO_ENABLED_RULES`** (FR-7.3): 400 — activate attempt against a policy with no enabled rules. UI prevents but server enforces. Action message i18n-keyed: `guardrails.error.noEnabledRules`.
- **`RULE_INCOMPLETE`** (FR-8.4): 400 with `missingFields: string[]`. PUT attempt with an enabled rule missing required fields. Server runs `validateRule()`; client runs the same function via UI.
- **`INVALID_ACTION_MESSAGE`**: 400 — actionMessage contains null bytes / control chars / fails UTF-8 / is empty when rule enabled.
- **`ACTION_MESSAGE_TOO_LONG`**: 400 — >500 chars.
- **Block response**: Open Question Q-1 — the runtime's response shape when a guardrail blocks a message is implementation-dependent. The LLD must decide between (a) 200 with `blocked: true` body (matches existing Content Safety pattern from `reasoning-executor.ts` L1903-1913), or (b) 4xx with the standard error envelope. Likely (a) per existing precedent — the request was _processed_, only the _response_ was rejected.
- **User experience**: All errors surface as toasts on the Studio side with action message + remediation guidance. Settings PII Protection banner is the cross-link for the compliance-lead persona.

#### Concern #6 — Failure Modes

**`failMode: 'open'` (default after this feature)** — detector throws / times out → request passes through (no PII enforcement). Trace event with `reason: 'detector_failure'`. Voice-safe.

**`failMode: 'closed'` (opt-in)** — detector failure → block with `actionMessage`. Compliance-safe; risk of dropped voice calls (disclosure copy explains).

**Catalog endpoint unavailable** — Studio multiselect renders "Loading entities…" with retry; Save disabled until catalog loads.

**Disabled-pack entity in saved rule** — Runtime silently skips unknown IDs (other entities continue to match — see post-detection filter logic). Policy editor surfaces yellow warning on rule card re-open. Soft Journey-D-class failure (GAP-003).

**Auto-deactivation race** — Single MongoDB document update is atomic. The post-update enabled-rule count is computed inside the same `findOneAndUpdate` call's body. No transactional update required (D-3 from HLD oracle).

**False-negative filter bug** (per oracle D-7, highest-risk failure): If the entity ID matching logic has a bug (case mismatch, normalization issue, stale catalog reference), the policy silently fails to fire. The policy appears active and configured, but enforcement is absent.

- **Mitigation 1**: INT-2's 8-case entity-filter test matrix exercises the boundary cases.
- **Mitigation 2**: `undefined` entities (backward-compat) means "match all" (no filter); empty array (`[]`) means "match none" (defensive default).
- **Mitigation 3**: Entity ID comparison uses strict string equality via `Set.has()`; never `==`/`startsWith`/`Array.includes`. (LLD R2-F6 standardized on `Set.has` for O(1) lookup; the detection element field is `type`, not `entityType` — LLD R3-F1.)
- **Mitigation 4**: Trace event includes the entities IDs (`{ ruleEntities: ['us_ssn', ...] }`) so post-incident forensics can verify the filter saw the expected entity set.

#### Concern #7 — Idempotency

- **POST `/api/projects/:projectId/guardrail-policies`** (create): Not idempotent. Two POSTs with the same name → second returns 409 via the unique index on `{ tenantId, name, 'scope.type', 'scope.projectId', 'scope.agentDefId' }`. Existing behavior preserved.
- **PUT `/:id`** (update): Idempotent. Same body → same final state. The auto-deactivation flag in the response is set based on the **pre-update** active state vs. post-update enabled-rule count — repeated calls report `autoDeactivated: true` only on the call that actually changed state.
- **POST `/:id/activate`**: Idempotent. Already-active policy returns 200 with current state. Empty policy returns 400 `NO_ENABLED_RULES` regardless of how many times called.
- **DELETE `/:id`**: Idempotent. Missing policy returns 404.
- **GET `/pii-entities`**: Idempotent. Catalog is a function of `(projectId, pack-enable-state)`; identical for repeated calls.

#### Concern #8 — Observability

**Trace events**:

- `guardrail_input_blocked` (existing) — extended data shape: `{ ..., presetKey?: string }`. Emitted at `reasoning-executor.ts` L1904.
- `guardrail_output_blocked` (existing) — same extension. Emitted at L3485.
- `guardrail_violation` (existing) — emitted by `traceGuardrailViolation()` factory.

**`presetKey` propagation chain** (4 sites that must carry the field end-to-end — LLD R3-F2 caught that the original HLD claim "EvaluationOutcome already passes guardrail through" was false):

1. IR `Guardrail.presetKey` — set by `toSyntheticGuardrail()` from `IGuardrailRule.presetKey`.
2. `GuardrailViolation.presetKey` — added in `packages/compiler/src/platform/guardrails/types.ts:27-49`; populated in `tier2-evaluator.ts:136-152` violation construction.
3. `OutputGuardrailResult.violation.presetKey` — added in `apps/runtime/src/services/execution/output-guardrails.ts:27-38, :97-101`; surfaced through the projection.
4. Trace event `data.presetKey` — `reasoning-executor.ts:1904` (input) and `:3485` (output) read from the violation and emit the field.

If any of the 4 sites omits `presetKey`, trace-event filtering by `presetKey === 'sensitive_data_block'` silently misses events — see LLD §5.8a-d for the precise diffs.

- `guardrail_activation_blocked` (NEW) — emitted when activation gate fires. Data: `{ policyId, reason: 'no_enabled_rules' }`.
- `guardrail_auto_deactivation` (NEW) — emitted when last enabled rule is disabled. Data: `{ policyId, ruleId, undone: boolean }`.

Both new event types must be registered in `GUARDRAIL_TRACE_EVENT_TYPES` at `packages/shared-kernel/src/constants/trace-event-registry.ts` L167-188. The HLD acknowledges this is a cross-boundary field/event registration — field-propagation-lint will flag it; this is expected behavior.

**Logs**: `createLogger('guardrails')` from `@abl/compiler/platform`. No PII in logs (entity IDs only). Action messages are passed as structured fields, not concatenated into log lines (mitigates T9).

**Metrics** (post-launch dashboards):

- `guardrail_input_blocked` + `guardrail_output_blocked` rate (filtered by `presetKey: 'sensitive_data_block'`) per project per day — sudden 10× spike triggers misconfigured-rule alert
- Active policies per project (track adoption)
- `validateRule()` rejection rate per checkType (form-side telemetry)
- Catalog endpoint p95 latency (target < 50ms)
- Auto-deactivation rate per project per week (via `guardrail_auto_deactivation` event)
- Undo rate = (count `guardrail-policy:reactivated` audit logs with `undone: true`) / (count `guardrail_auto_deactivation` events with `undone: false`)
- **Time-to-undo distribution** (LLD R6-F5): computed offline from audit log timestamp diff between `guardrail-policy:auto-deactivated` and `guardrail-policy:reactivated` events sharing the same `policyId`. Useful for post-launch toast-window tuning (today hard-coded to 5s).
- Activation gate fire rate (via `guardrail_activation_blocked` event) — proxy for incomplete-rule UX gaps

#### Concern #9 — Performance Budget

| Operation                          | Target                | Notes                                        |
| ---------------------------------- | --------------------- | -------------------------------------------- |
| `BuiltinPIIProvider.evaluate()`    | p95 ≤ 5ms, p99 ≤ 10ms | Tier-1 budget per `GUARDRAILS_SPEC.md` §10.1 |
| Post-detection entity filter       | sub-millisecond       | O(n) over ≤37 entities                       |
| Catalog endpoint                   | p95 ≤ 50ms            | New; tracked in monitoring post-launch       |
| `validateRule()`                   | < 1ms                 | Pure function; no I/O                        |
| Policy list with chips             | < 100ms render        | At most ~10 policies × ~4 chips = 40 chips   |
| Auto-deactivation findOneAndUpdate | p95 ≤ 50ms            | Same Mongo profile as existing PUT           |

**Payload sizes**:

- Catalog response: ≤ 8 KB (37 entities × ~200 bytes each + metadata)
- Policy body: ≤ 32 KB (existing platform limit; new fields are minimal additions)
- `actionMessage`: ≤ 500 chars (FR-6.9)

**Batch limits**: No batching introduced. Single-policy operations.

#### Concern #10 — Migration Path

**Schema additive — no migration script** (per feature spec §7).

- New `IGuardrailRule` fields (`entities?`, `enabled?`, `presetKey?`, `actionMessage?`) — all optional. Existing rules without them behave as today. **`enabled` has no Mongoose default** (schema declares `enabled?: boolean` with no `default`): existing documents hydrated through the Mongoose schema after this feature deploys will have `enabled: undefined` (not populated on read). The activation gate and resolver use `rule.enabled !== false` — i.e. `undefined` is treated as **enabled** (backward-compatible with legacy rules), and only explicit `false` disables a rule. This preserves the pre-launch posture and ensures legacy rules continue to function. (Corrected during LLD R2-F5; previously specified `default: false` which would have silently disabled all legacy rules on hydration.)
- `IGuardrailSettings.failMode` — existing field; **schema default flipped from `'closed'` to `'open'`**. Pre-existing rows already have `'closed'` persisted; the default only applies to new policies.
- `kind` enum — **unchanged** (5 values: `'input' | 'output' | 'tool_input' | 'tool_output' | 'handoff'`). The Studio "Applies To = both" UI is form-only; `serializeRule()` and `normalizeRules()` both already expand `'both'` to two persisted rules.

**Pre-deploy cleanup script** — `tools/cleanup-pii-guardrail-presets.ts` (NEW):

- Removes existing tester `pii_protection`-preset rules with `action: 'redact'` from dev/staging MongoDB.
- Idempotent; `--dry-run` mode reports affected rows; `--confirm` flag required to write.
- No production data exists (pre-launch); script handles dev/staging only.
- Tested via 4 scenarios (CL-1 through CL-4 in test spec).

**Recognizer pack metadata addition** — each `recognizer-packs/<pack>.ts` adds an `ENTITIES: ReadonlyArray<EntityCatalogEntry>` export. Additive; existing `register()` function unchanged. The new `catalog.ts` aggregator module is created.

#### Concern #11 — Rollback Plan

**Rollback shape** (per feature spec §C.4):

- Schema changes are additive; older code reading the new optional fields sees `undefined` and behaves as today.
- `failMode` default revert (`'open'` → `'closed'`) only affects new policies; existing rows with `'open'` persisted are unaffected.
- New routes (`/pii-entities`) and new components are introduced wholesale; rolling back removes them entirely (no half-state).
- Telemetry: the `presetKey` field on existing block events is optional; rollback removes the emission of the new value (existing dashboards filtering by `guardrailName` continue to work).

**Rollback procedure**:

1. Revert the Studio + Runtime + Compiler PRs.
2. Run the cleanup script in `--restore` mode (if any tester data was created post-deploy that needs to be preserved by other means — out of scope for v1).
3. No DB migration to reverse (schema is additive).
4. No customer impact (pre-launch).

**Time to rollback**: < 1 hour from decision to deployed revert (standard CI/CD path).

#### Concern #12 — Test Strategy

The full test plan is at [`docs/testing/sub-features/guardrails-sensitive-data-block.md`](../testing/sub-features/guardrails-sensitive-data-block.md). Summary:

| Test Type                  | Count                       | Files                                                                                                                         |
| -------------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| E2E (Runtime HTTP-only)    | 14 executable + 1 cross-ref | 4 new `*.e2e.test.ts` files                                                                                                   |
| E2E (Studio Playwright)    | 1 comprehensive             | `apps/studio/e2e/guardrails-sensitive-data-block.spec.ts`                                                                     |
| Integration                | 11                          | 9 new files in `apps/runtime/src/__tests__/integration/guardrails/` + extension to existing `policy-rbac.integration.test.ts` |
| Unit (validateRule matrix) | ~34 cases                   | `packages/shared/src/__tests__/validation/guardrail-rule-validation.test.ts`                                                  |
| Unit (helpers)             | 3 modules                   | Banner-TTL, preset-defaults, default-message                                                                                  |
| Component                  | 10 scenarios                | 6 Studio component test files                                                                                                 |
| Cleanup script             | 4                           | `tools/__tests__/cleanup-pii-guardrail-presets.test.ts`                                                                       |
| **Total**                  | **77+ scenarios**           | **25 test files**                                                                                                             |

**Coverage**:

- All 45 FRs in the coverage matrix
- All 9 §C.3 threats have ≥1 automated scenario
- All 5 §C.2 fail-closed contract rows have coverage
- All 7 user stories mapped to scenarios

**Per CLAUDE.md test architecture**: E2E uses HTTP API only via `RuntimeApiHarness`; real `MongoMemoryServer`; mock LLM via external HTTP server (`startMockLLM()`); no `vi.mock` of platform components; `validateRule()` is tested as a pure function with zero mocks.

---

## 5. Data Model

### Modified collection: `guardrail_policies`

**Schema location**: `packages/database/src/models/guardrail-policy.model.ts`.

**`IGuardrailRule` changes** (additive — see test spec §1 and feature spec §9):

```typescript
export interface IGuardrailRule {
  // Existing fields (UNCHANGED):
  guardrailName: string;
  override: 'disable' | 'threshold' | 'action' | 'severity_actions' | 'define';
  threshold?: number;
  action?: Record<string, unknown>; // Mixed; in practice a string in Studio rules
  severityActions?: Record<string, unknown>;
  kind?: 'input' | 'output' | 'tool_input' | 'tool_output' | 'handoff'; // UNCHANGED
  tier?: 'local' | 'model' | 'llm';
  provider?: string;
  category?: string;
  check?: string;
  llmCheck?: string;
  description?: string;
  priority?: number;
  message?: string;

  // NEW fields (additive, optional):
  presetKey?: string; // e.g., 'sensitive_data_block'
  enabled?: boolean; // no Mongoose default (undefined); promoted from form-only to schema; resolver/gate predicate is `enabled !== false` so undefined = enabled (legacy-rule compat)
  entities?: string[]; // canonical PII entity IDs
  actionMessage?: string; // user-facing block message (500 char max)
}
```

**`IGuardrailSettings` changes**:

- `failMode` schema default **changed** from `'closed'` to `'open'` (FR-5.4). Existing rows unaffected (Mongoose defaults apply only at insert).
- All other fields unchanged.

**Indexes** (UNCHANGED — verified at model L270-282):

- `{ tenantId:1, name:1, 'scope.type':1, 'scope.projectId':1, 'scope.agentDefId':1 }` (unique compound)
- `{ tenantId:1, 'scope.projectId':1, status:1 }`
- `{ tenantId:1, 'scope.agentDefId':1 }`
- `{ tenantId:1, isActive:1 }`

### Modified IR type: `Guardrail`

**Location**: `packages/compiler/src/platform/ir/schema.ts` L1603-1637.

**Addition**: `entities?: string[]` — propagated from `IGuardrailRule.entities` by `toSyntheticGuardrail()` in `apps/runtime/src/services/guardrails/policy-resolver.ts` L126-152 during policy resolution (the mapping is invoked from `pipeline-factory.ts`, which only loads policies and delegates to `GuardrailPolicyResolver`). This is the IR-level representation that the pipeline executes against.

### New module: `EntityCatalogEntry`

**Location**: `packages/compiler/src/platform/security/recognizer-packs/catalog.ts` (NEW).

```typescript
export interface EntityCatalogEntry {
  id: string; // e.g., 'us_ssn' (canonical, stable)
  label: string; // e.g., 'US Social Security Number'
  pack: PackName; // from PACK_NAMES (shared validation)
  tier: 1 | 2 | 3; // detection capability level
  description?: string;
}

export function listEnabledPIIEntities(
  enabledPacks: ReadonlyArray<PackName>,
): EntityCatalogEntry[] {
  // Aggregates ENTITIES exports from enabled packs; sorted by (pack, tier, label).
}
```

Each `recognizer-packs/<pack>.ts` gets an `export const ENTITIES: ReadonlyArray<EntityCatalogEntry>` alongside the existing `register()` function.

### Key Relationships

- `IGuardrailRule.entities[]` → references canonical IDs in `recognizer-packs/<pack>.ts` `ENTITIES`. No foreign-key enforcement at the schema level.
- `IGuardrailSettings.failMode` → consumed by `packages/compiler/src/platform/guardrails/pipeline.ts` L598.
- `project_runtime_configs.pii_redaction.packs[]` → read by `pii-entities.ts` route handler to determine catalog scope.

---

## 6. API Design

### New route: `GET /api/projects/:projectId/pii-entities`

- **File**: `apps/runtime/src/routes/pii-entities.ts` (NEW)
- **Mount**: `apps/runtime/src/server.ts` adjacent to L1250 (`pii-patterns` mount)
- **Middleware chain**: `authMiddleware` → `tenantRateLimit('request')` → `requireFeature('guardrails')` → `requireRouteScopePermission(req, res, context, 'pii-pattern:read')`
- **Request**: No body. Optional query: `?packs=us,core` to filter (defaults to project's enabled packs)
- **Response (200)**:
  ```json
  {
    "success": true,
    "data": {
      "entities": [
        { "id": "us_ssn", "label": "US Social Security Number", "pack": "us", "tier": 1, "description": "Social Security Number (SSN/TIN)" },
        ...
      ]
    }
  }
  ```
- **Error responses**:
  - 401 `{ success: false, error: { code: 'UNAUTHORIZED', message: '...' } }` (missing auth)
  - 403 `{ success: false, error: { code: 'INSUFFICIENT_PERMISSIONS', message: '...' } }` (missing `pii-pattern:read` for a project the user IS a member of)
  - 404 `{ success: false, error: { code: 'NOT_FOUND', message: 'Project not found' } }` (cross-project access)
- **Middleware ordering (critical)**: The 403 applies only when the user's token resolves to the _same_ project as `:projectId` but lacks `pii-pattern:read`. Cross-project access (token resolves to a _different_ project, or no project) returns **404 not 403** per CLAUDE.md Core Invariant 1. The middleware chain MUST check project membership before checking permission — matches the `pii-patterns.ts` precedent. LLD must wire `requireRouteScopePermission` such that the `findOne({tenantId, projectId})` ownership check fails first (yielding 404) before the permission-string check runs (yielding 403).

### Extended route: `PUT /api/projects/:projectId/guardrail-policies/:id`

**File**: `apps/runtime/src/routes/guardrail-policies.ts` L1132.

**New behavior**:

1. After `normalizeRules()` (which now promotes `entities`/`enabled`/`presetKey`/`actionMessage` to first-class fields), run `validateRule()` on each rule.
2. If any `enabled: true` rule fails validation → 400 `{ success: false, error: { code: 'RULE_INCOMPLETE', message: <i18n>, missingFields: string[] } }`. Atomic — no partial write.
3. After successful update, count enabled rules. If pre-update state was `isActive: true` AND post-update enabled count is 0 → set `isActive: false, status: 'draft'` in the same `findOneAndUpdate`. Response includes `autoDeactivated: true, originalRuleId: <last-disabled-rule-id>`.

### Extended route: `POST /api/projects/:projectId/guardrail-policies/:id/activate`

**File**: `apps/runtime/src/routes/guardrail-policies.ts` L1339.

**Permission**: `guardrail:write` (today; see §4 concern #4 for deferred `guardrail:activate` split).

**New behavior**:

1. After existing `findOne` ownership check, count enabled rules.
2. If 0 → 400 `{ success: false, error: { code: 'NO_ENABLED_RULES', message: <i18n> } }`. Trace event `guardrail_activation_blocked` with `reason: 'no_enabled_rules'`.
3. Otherwise proceed with existing `deactivateSiblingPolicies` + activation logic.

### Extended event payloads

**`guardrail_input_blocked`** (existing) — data shape gains `presetKey?: string`. Emitted at `reasoning-executor.ts` L1904.

**`guardrail_output_blocked`** (existing) — same. Emitted at L3485.

### New event types

**`guardrail_activation_blocked`** — data: `{ policyId: string, reason: 'no_enabled_rules' }`. Factory in `trace-events.ts`.

**`guardrail_auto_deactivation`** — data: `{ policyId: string, ruleId: string, undone: boolean }`. Factory in `trace-events.ts`.

Both new event types registered in `GUARDRAIL_TRACE_EVENT_TYPES` at `packages/shared-kernel/src/constants/trace-event-registry.ts` L167-188.

---

## 7. Cross-Cutting Concerns

### Audit Logging

- Existing audit pattern preserved. The `guardrail-policies.ts` route emits audit log entries with action strings (e.g., `guardrail-policy:activate`, `guardrail-policy:update`) — **these are audit-log action namespaces, NOT RBAC permissions**. Clarified in §4 concern #4 and Phase-1 SDLC log §1 C5.
- Compliance audit logging for block events deferred (GAP-002 in feature spec; tracked in §15 Open Question #1).

### Rate Limiting

- All new routes inherit `tenantRateLimit('request')` middleware (existing platform middleware on all `/api/projects/:projectId/...` mounts).
- Catalog endpoint additionally benefits from SWR client-side caching with `revalidateOnFocus: false` (further reduces server load).

### Caching

- **Server-side**: Pipeline policy resolution uses `policy-epoch.ts` Redis counter. Bumped on policy update + auto-deactivation. No new caching layer introduced.
- **Client-side**: SWR for catalog (per project session). Banner-dismissal localStorage (90-day TTL, FR-2.3).
- **Recognizer pack metadata**: Loaded at module load; effectively cached for process lifetime.

### Encryption

- At rest: inherited from MongoDB-at-rest encryption.
- In transit: HTTPS via existing platform TLS.
- `actionMessage` is user-controlled but not a secret. No additional encryption needed.

---

## 8. Dependencies

### Upstream (this feature depends on)

| Dependency                                                          | Status | Risk                                                           |
| ------------------------------------------------------------------- | ------ | -------------------------------------------------------------- |
| ABLP-921 (PII Tiered Recognizers, BETA) — recognizer-packs source   | EXISTS | Low — pack files already exist with 37 entities across 8 packs |
| Existing `BuiltinPIIProvider` and `detectPII()`                     | EXISTS | Low — additive change to provider; no behavioral break         |
| Existing `failMode` mechanism in `pipeline.ts` L598                 | EXISTS | Low — schema-default flip only                                 |
| Existing `RuntimeApiHarness` + `startMockLLM()` test infrastructure | EXISTS | Low — reuse                                                    |
| `packages/shared-auth` permission registry                          | EXISTS | Low — no new permissions in v1                                 |
| `tenantIsolationPlugin` + `requireRouteScopePermission`             | EXISTS | Low — reuse                                                    |

### Downstream (depends on this feature)

| Consumer                                                                                 | Impact                                                                           | Mitigation                                                                                                     |
| ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Future maker-checker / approval workflow                                                 | The `guardrail:activate` extension hook (§4 concern #4) is the integration point | Documented in HLD with 6-step runbook                                                                          |
| Future third-party PII provider integration (Microsoft Presidio, AWS Comprehend Medical) | Schema is forward-compatible via namespaced IDs (`presidio.person`)              | Out of scope for v1; tracked as feature spec §15 Open Question #3                                              |
| Analytics dashboards filtering by guardrail rule category                                | `presetKey` field addition unlocks filtering                                     | Field-propagation-lint will flag the field addition; existing dashboards filter by `guardrailName` (unchanged) |

---

## 9. Open Questions & Decisions Needed

| ID  | Question                                                                                                          | Owner                    | Target Phase                               |
| --- | ----------------------------------------------------------------------------------------------------------------- | ------------------------ | ------------------------------------------ |
| Q-1 | HTTP status code for guardrail block response (200 with `blocked:true` body vs. 4xx with error envelope)          | Eng                      | LLD                                        |
| Q-2 | Faulty-recognizer fixture mechanism for failMode E2E tests (must avoid `vi.mock` of platform components)          | Eng                      | LLD                                        |
| Q-3 | Trace store query API for test assertions (test-only `GET /api/__test__/trace-events` or DI emitter subscription) | Eng                      | LLD                                        |
| Q-4 | Auto-deactivation Undo HTTP shape (sugar route vs. PUT+activate sequence)                                         | Eng                      | LLD                                        |
| Q-5 | Tenant-scoped route path verification (E2E-9 — `/api/guardrail-policies` mount confirmed to accept tenant scope)  | Eng                      | LLD                                        |
| Q-6 | Compliance sign-off on `failMode: 'open'` default for voice channels (HIPAA / 911-adjacent)                       | Compliance counsel       | Pre-implementation (FR-6.7 commit blocker) |
| Q-7 | Compliance audit-logging for block events (GAP-002 — beyond trace events)                                         | Compliance counsel + Eng | Post-v1                                    |
| Q-8 | Future third-party PII provider UI (generalized namespaced IDs vs. per-provider selector)                         | Product + Eng            | Future provider integration                |

Q-1, Q-2, Q-3, Q-4, Q-5 are LLD-phase concerns. Q-6, Q-7, Q-8 are external dependencies.

### Cross-phase corrections cascaded from HLD reconnaissance

The HLD Phase-0 explorer pass discovered terminology gaps in the upstream specs. These were applied as in-place corrections during HLD authoring:

- **Phantom trace event name `guardrail.evaluation.block`** in feature spec §12 Observability (lines 425-430 / 471 area) does not exist in the codebase. The actual events are `guardrail_input_blocked` and `guardrail_output_blocked` (extended with optional `presetKey?: string` by this feature). Feature spec and test spec corrections applied in this HLD's commit batch.
- **`guardrail.activation.blocked` / `guardrail.auto_deactivation` dot-notation** in feature spec FR-7.5 conflicts with the existing `GUARDRAIL_TRACE_EVENT_TYPES` registry which uses underscore convention exclusively (20 events at HLD authoring time; **now 22** after this feature added `guardrail_activation_blocked` / `guardrail_auto_deactivation` — see `packages/shared-kernel/src/constants/trace-event-registry.ts` L167-190). Renamed throughout to `guardrail_activation_blocked` / `guardrail_auto_deactivation`. Feature spec and test spec corrections applied.
- **Phantom permission strings `guardrail-policy:*`** in feature spec §12 and test spec INT-11 were audit-log action names, not RBAC permissions. Already corrected in pre-HLD prep (see Q-HLD-A1 in clarifying-questions.md Batch 3).

---

## 10. Post-Implementation Notes (added 2026-05-18)

Implementation landed in a 12-commit series on `discuss/guardrails-pii-consolidation` (ABLP-723). Key deviations from the HLD as-designed:

1. **`failMode` default flip sites**: HLD anticipated 3 sites; implementation flipped at 4 sites (schema default, model default, policy-resolver fallback, and tier2-evaluator fallback).
2. **Config key path**: The runtime config key is `pii_redaction.enabled_recognizer_packs` (see `project-pii-config.ts:143-144`), not `pii_redaction.packs` as referenced in HLD §2 Alternative A.
3. **Studio UI component consolidation**: The HLD's §3 assumed separate `EntityMultiselect.tsx`, `DecisionMatrixModal.tsx`, and `FailModeSelector.tsx` components. Implementation consolidated all entity selection and SDB preset UI into `GuardrailPolicyForm.tsx` rather than shipping separate files.
4. **Studio PII entities API proxy**: The HLD assumed `apps/studio/src/api/pii-entities.ts` as a Studio-side proxy. Implementation wires the entity list directly from the runtime route `GET /api/projects/:projectId/pii-entities` without a Studio-side proxy file.
5. **Test commit split**: LLD §10 commit #11 (tests) was split into two commits (10a: unit+integration, 10b: e2e) to respect the 40-file commit-scope guard.
6. **`it.todo` markers**: 8 test scenarios are stubbed with `it.todo` pending deferred JIRA sub-tasks (FR-2.1, FR-2.2, FR-3.x modal, FR-7.2, FR-8.3, FR-9.x, FR-10.2, FR-10.4). Feature status is ALPHA, not BETA, until these land.

Data-flow audit: 2 rounds, PASS. PR reviewer: 2 rounds, APPROVED. ~215 assertions across ~20 test files.

---

## 11. References

- **Feature spec**: [`docs/features/sub-features/guardrails-sensitive-data-block.md`](../features/sub-features/guardrails-sensitive-data-block.md) — 45 FRs, 18 sections + §C Critical Feature Gate. 5-round audit history (R3 FAIL → fixed → R4 NEEDS_REVISION → fixed → R5 PASS).
- **Test spec**: [`docs/testing/sub-features/guardrails-sensitive-data-block.md`](../testing/sub-features/guardrails-sensitive-data-block.md) — 14 E2E + 11 Integration + ~34 unit + 10 component + 4 cleanup scenarios; 2-round audit PASS.
- **ADR**: [`docs/architecture/2026-05-14-guardrails-pii-separation-adr.md`](../architecture/2026-05-14-guardrails-pii-separation-adr.md) — steelman analysis, industry comparison, 4 rejected alternatives.
- **PRD (exploratory)**: [`docs/features/sub-features/guardrails-sensitive-data-block.prd.md`](../features/sub-features/guardrails-sensitive-data-block.prd.md) — superseded by feature spec; preserved for journey transcripts.
- **Wireframes**: [`docs/features/sub-features/guardrails-sensitive-data-block.wireframes.html`](../features/sub-features/guardrails-sensitive-data-block.wireframes.html) — 12 side-by-side before/after screens.
- **Parent feature**: [`docs/features/guardrails.md`](../features/guardrails.md)
- **Related — Settings PII Protection**: [`docs/features/pii-detection.md`](../features/pii-detection.md)
- **ABLP-921 dependency**: [`docs/features/sub-features/pii-detection-tiered-recognizers.md`](../features/sub-features/pii-detection-tiered-recognizers.md) — 37-entity recognizer registry.
- **Canonical guardrails architecture**: [`docs/architecture/GUARDRAILS_SPEC.md`](../architecture/GUARDRAILS_SPEC.md).
- **Pre-pull-request reference (unmerged)**: PR #989 `fix/ABLP-723-guardrails-project-state-isolation` — initial state-isolation work; this CR subsumes its validation logic via shared `validateRule()`.
- **Clarifying questions log**: [`docs/sdlc-logs/guardrails-sensitive-data-block/clarifying-questions.md`](../sdlc-logs/guardrails-sensitive-data-block/clarifying-questions.md) — 13 user decisions (12 Phase 1-2 + Q-HLD-A1).
- **Phase-1 SDLC log**: [`docs/sdlc-logs/guardrails-sensitive-data-block/feature-spec.log.md`](../sdlc-logs/guardrails-sensitive-data-block/feature-spec.log.md).
- **Phase-2 SDLC log**: [`docs/sdlc-logs/guardrails-sensitive-data-block/test-spec.log.md`](../sdlc-logs/guardrails-sensitive-data-block/test-spec.log.md).
