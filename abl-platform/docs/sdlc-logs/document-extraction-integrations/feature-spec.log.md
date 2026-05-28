# Oracle Answers: Document Extraction Integrations

**Feature:** document-extraction-integrations
**Phase:** Feature Spec
**Date:** 2026-05-14
**Oracle model:** Opus 4.6

---

## Context Consulted

- `CLAUDE.md` -- core invariants, commit discipline, test architecture
- `docs/features/README.md` -- feature index, lifecycle statuses
- `docs/features/multimodal-processing.md` -- Docling in search-AI context
- `docs/features/connectors.md` -- connector platform (BETA), AP adapter, auth adapters
- `docs/features/auth-profiles.md` -- auth profile schema, Phase 1-3 types
- `docs/features/workflows.md` -- workflow engine scope, node types
- `docs/features/workflow-integration-node.md` -- integration node (ALPHA)
- `/home/karthikeya.andhoju/Desktop/docling-azure-di-integration-plan.md` -- full 1008-line plan
- `packages/shared/src/types/workflow-schemas.ts` -- IntegrationNodeConfigSchema, DocIntelligenceNodeConfigSchema, NodeTypeSchema
- `packages/shared/src/validation/auth-profile.schema.ts` -- ApiKeyConfigSchema, connectionConfig field
- `packages/shared-kernel/src/types/workflow-types.ts` -- STUB_NODE_TYPES, HIDDEN_NODE_TYPES, NodeType union
- `apps/workflow-engine/src/routes/workflow-callbacks.ts` -- callback route with mandatory HMAC
- `apps/workflow-engine/src/executors/async-webhook-executor.ts` -- async webhook executor
- `apps/workflow-engine/src/handlers/workflow-handler.ts:2820-2930` -- callbackSecret generation, encryption, HMAC flow
- `apps/workflow-engine/src/constants.ts` -- DEFAULT_CALLBACK_TIMEOUT_MS = 24h
- `apps/search-ai/src/workers/docling-extraction-worker.ts` -- createDoclingExtractionWorker(concurrency = 3)
- `apps/search-ai/src/server.ts:548` -- INGESTION_MAX_CONCURRENT_JOBS env var (default 5)
- `apps/studio/src/lib/feature-resolver.ts` -- isFeatureEnabled via Deal + Subscription + PLAN_FEATURES
- `apps/studio/src/components/workflows/canvas/config/GenericNodeConfig.tsx:105` -- local STUB_NODE_TYPES
- `packages/connectors/src/loader.ts` -- PIECE_PACKAGES array
- `packages/connectors/src/adapters/activepieces/auth-adapters/` -- jira-cloud.ts, servicenow.ts

---

## Answers

### S1: Default project state for Docling toggle

**Classification**: DECIDED
**Answer**: Default to **Off** (explicit opt-in) for all projects, both new and existing. The plan section 12 Q3 suggests "On for existing tenants to preserve behavior parity with search-AI," but this is a false equivalence: the search-AI Docling pipeline (multimodal-processing, ALPHA) is always-on for ingestion because it operates on knowledge-base documents the admin explicitly uploaded. The workflow Docling connector is a different thing -- it allows any workflow designer to fetch and extract arbitrary public URLs, consuming shared GPU-backed Docling pods. Defaulting to On would silently expose a new GPU-cost vector and a new SSRF attack surface to every project without admin awareness. The plan's own rate-limit derivation (section 7.6) acknowledges that concurrent-tenant load is a real concern. Requiring a single toggle-flip is low friction; the risk of surprise GPU cost and unintended attack surface is high. Off is the safer default; per CLAUDE.md principle "prefer the more secure option."
**Source**: Plan section 12 Q3; CLAUDE.md decision principles 4 (prefer more secure) and 6 (document the decision); plan section 7.6 noisy-neighbor analysis
**Confidence**: HIGH

---

### S2: Relationship between this feature and multimodal-processing

**Classification**: INFERRED
**Answer**: The relationship is **shares infrastructure with**, not **depends on**. Both features call the same Docling Python service at port 8080 and share the same search-AI worker process/pods, but they serve different consumers (search-AI ingestion vs. workflow execution) through different queues (`search-docling-extraction` vs. `workflow-docling-extraction`), different job modes, and different output destinations (Mongo/S3/downstream-stages vs. callback-POST-to-workflow-engine). The feature spec should describe the boundary as: "multimodal-processing owns the search-AI ingestion pipeline (full extraction + enrichment + embedding); document-extraction-integrations owns the workflow-triggered extraction-only path. Both share the Docling Python service and the search-AI worker process. The two-queue topology (section 5.0 of the plan) enforces isolation -- neither path can starve the other." The spec should NOT promote a unified "Document Extraction sub-system" in v2 -- the two paths have fundamentally different lifecycles, output shapes, and consumers. Premature unification would couple the search-AI pipeline to workflow-engine changes. Instead, note the shared infrastructure as a deployment coupling to monitor.
**Source**: `docs/features/multimodal-processing.md` sections 1, 5, 8 (BullMQ queues); plan sections 1, 5.0, 5.6
**Confidence**: HIGH

---

### S3: Doc type -- major feature, sub-feature, or under connectors.md?

**Classification**: DECIDED
**Answer**: Major feature at `docs/features/document-extraction-integrations.md`. Rationale: (1) this touches 5+ packages (connectors, shared, shared-kernel, search-ai, workflow-engine, studio), (2) it introduces a new queue topology, new AP piece, new auth adapter, new project toggle API, and new Studio UI, (3) it has its own 13-day delivery plan with 6 phases, (4) the connectors.md feature spec is already 627 lines and covers the general connector platform -- bolting document extraction onto it would obscure both features. For comparison, `workflow-integration-node.md` is already a separate major feature even though it is also "just" using the connector platform. This is appropriately a peer major feature.
**Source**: `docs/features/README.md` feature index (shows existing precedent: workflow-integration-node is #91 as a separate major feature); `docs/features/connectors.md` (already 627+ lines); `docs/features/AUTHORING_GUIDE.md` criteria
**Confidence**: HIGH

---

### S4: Status and timeline driver

**Classification**: AMBIGUOUS
**Answer**: No explicit customer ask, competitive-gap doc, or roadmap artifact referencing this feature was found in `docs/features/`, `docs/plans/`, or recent commits. The branch name `feature/wf/ocrnode` and the plan file's "Draft for team review" header suggest this is an internally-driven initiative. The `doc_intelligence` NodeType has been in the codebase as a stub/hidden node since at least the workflow engine's initial build (it appears in `STUB_NODE_TYPES` and `HIDDEN_NODE_TYPES` in shared-kernel). The most likely drivers are: (a) fulfilling the stub node promise, (b) enabling workflow-based document processing use cases that customers have verbally requested, and/or (c) competitive parity with platforms that offer document extraction in their automation builders. The plan estimates 13 dev-days + 3 calendar weeks to beta. Status PLANNED is correct for the feature spec phase.
**Source**: Branch name `feature/wf/ocrnode`; plan section 8 timeline; `packages/shared-kernel/src/types/workflow-types.ts:44-52` (STUB_NODE_TYPES includes doc_intelligence); no matching JIRA key or roadmap doc found
**Confidence**: LOW

**Why Ambiguous**: The business motivation (enterprise customer ask vs. internal initiative vs. competitive gap) affects spec priority language and acceptance criteria stringency. The user should specify this for the feature spec's "Problem Statement" section.

---

### S5: Existing prior attempts (orphan doc_intelligence NodeType)

**Classification**: ANSWERED
**Answer**: Yes, there is a prior attempt. The `doc_intelligence` NodeType exists in `NodeTypeSchema` at `packages/shared/src/types/workflow-schemas.ts:31`, has a minimal `DocIntelligenceNodeConfigSchema` (`{ documentSource: string }`) at line 307, is listed in `STUB_NODE_TYPES` and `HIDDEN_NODE_TYPES` in `packages/shared-kernel/src/types/workflow-types.ts:44-67`, has UI icon mapping in `WorkflowNodeComponent.tsx:63` and `ConfigPanel.tsx:59`, has color/label metadata in `workflow-types.ts:97/124/151`, and is referenced in the `STUB_NODE_TYPES` local array in `GenericNodeConfig.tsx:105`. However, it is NOT wired to `NODE_TYPE_TO_STEP_TYPE` in `canvas-to-steps.ts` (grep returned no results for `doc_intelligence` in that file), meaning it cannot execute. The plan routes document extraction through the existing `integration` node type (via `connector_action` step type), not through `doc_intelligence`. The feature spec should note this orphan node type explicitly and recommend either (a) keeping it as-is (plan's implicit choice) or (b) removing it from `HIDDEN_NODE_TYPES` and repurposing it, and should document the decision.
**Source**: `packages/shared/src/types/workflow-schemas.ts:31,307,334`; `packages/shared-kernel/src/types/workflow-types.ts:37,44-47,61,97,124,151`; `apps/studio/src/components/workflows/canvas/config/GenericNodeConfig.tsx:105`; `apps/workflow-engine/src/services/canvas-to-steps.ts` (no match for doc_intelligence)
**Confidence**: HIGH

---

### U1: Primary personas

**Classification**: INFERRED
**Answer**: The plan's three personas (workspace admin, workflow designer, end-user) are the correct primary set. Recommend adding two secondary personas for completeness in the spec: (1) **Platform operator / on-call engineer** -- monitors queue depth alerts, rate-limit rejection rates, callback delivery failures, and HPA scaling; responds to capacity issues; this is warranted because the feature introduces a new queue topology and cross-service callback pattern that needs operational runbooks. (2) **Tenant billing admin** -- reviews Azure DI usage/cost-cap in Project Settings; this matters because Azure DI has per-extraction billing and the plan includes a soft cost cap with 80% warning. Do NOT add "finance on Azure DI cost cap" as a separate persona -- the billing admin covers that concern. Canonical list: workspace admin, workflow designer, end-user (runtime), platform operator (ops), tenant billing admin.
**Source**: Plan section 3 (3 personas); plan section 7.3 (observability metrics, alert thresholds); plan section 7.4 (cost cap + usage tracking); `docs/features/connectors.md` section 3 (does not list ops persona -- this feature's queue topology warrants one)
**Confidence**: HIGH

---

### U2: Performance targets -- are plan section 7.5 numbers appropriate?

**Classification**: INFERRED
**Answer**: The plan's targets (p50 < 8s, p95 < 25s, p99 < 60s for a 10-page PDF on Docling) are reasonable and aligned with what can be inferred from the codebase, but they should be labeled as provisional until validated against the capacity report. Key evidence: (1) `multimodal-processing.md` NFR-01 targets "< 30s for 50-page PDF" -- extrapolating linearly, a 10-page PDF would be ~6s, which aligns with the plan's p50 < 8s. (2) The existing worker has a 30-minute hard cap at `docling-extraction-worker.ts:586-587` (referenced in plan), confirming long-tail extractions exist. (3) The plan's workflow path adds overhead vs. direct search-AI extraction: SSRF validation, HEAD probe, BullMQ enqueue, queue wait, callback POST -- probably 1-3s of overhead, making the 8s p50 target tighter than the search-AI path's effective latency. (4) The capacity report PDF (`docling-extraction-capacity-report-2026-05-10.pdf`) is referenced but is a local desktop file I cannot read -- the spec should note that targets are provisional pending capacity-report validation. The targets are not too aggressive for a spec; they are aspirational but achievable.
**Source**: `docs/features/multimodal-processing.md` NFR-01 ("< 30s for 50-page PDF"); plan section 7.5; `apps/search-ai/src/workers/docling-extraction-worker.ts` (30-min cap reference)
**Confidence**: MEDIUM

---

### U3: Must-have vs nice-to-have for v1

**Classification**: DECIDED
**Answer**: The plan's must-have set is correct. Confirm the following as v1 must-haves: single `extract_document` action, public URL only, project toggle (Docling), AuthProfile-based Azure DI, normalized envelope, SSRF protection (two-layer), HMAC callback verification, inline envelope cap (50 MB), Restate replay safety. **The per-tenant Docling rate limit (10/min + 5 burst) is a v1 MUST-HAVE, not deferrable.** Rationale: the plan itself identifies this as closing an unmitigated noisy-neighbor risk (AF-105) that was explicitly flagged in three separate audit/architecture documents (`docs/2026-03-25-architecture-fitness-remediation-backlog.md:324`, `docs/audit/tenant-isolation-review-2026-03-18.md:490`, `docs/plans/tenant-isolation-hardening-plan.md:505`). Shipping a new shared-resource consumer without tenant fairness would be the second known instance of the anti-pattern. The rate-limiter is ~50 LOC wrapping an existing dependency (`rate-limiter-flexible` already in use at `mcp-auth-resolver.ts:248-276`). Deferring it would introduce a known P2 security/fairness gap at GA. Keep it in v1.
**Source**: Plan sections 7.6 (rate limit), 2 (non-goals), 12 Q4 (cost cap); AF-105 reference in plan; `packages/shared/src/services/mcp-auth-resolver.ts:248-276` (existing RateLimiterRedis pattern)
**Confidence**: HIGH

---

### U4: Scale requirements

**Classification**: DECIDED
**Answer**: The plan's scale numbers (5 HPA pods, ~10 concurrent tenants, ~60 extractions/min cluster capacity) are **best-guess placeholders**, not grounded in production traffic data for this specific feature (which does not exist yet). The plan acknowledges this explicitly in section 7.6: "Re-tune in Phase 5 beta" and "the number is a derived best-guess." For the feature spec, state them as "initial design targets based on current cluster sizing" with a note that Phase 5 beta soak will validate and lock the final numbers. The existing search-AI Docling HPA target is set via `INGESTION_MAX_CONCURRENT_JOBS` (default 5 at `apps/search-ai/src/server.ts:548`), and the worker's `createDoclingExtractionWorker(concurrency = 3)` default confirms 3 concurrent slots are the current baseline. The plan's 3+2 split preserving 5 total per pod is consistent with current infrastructure. Expected QPS at GA is unknown and should be treated as a monitoring-driven discovery during beta.
**Source**: Plan section 7.6 (derivation math, "placeholder -- confirm with the deploy repo"); `apps/search-ai/src/server.ts:548`; `apps/search-ai/src/workers/docling-extraction-worker.ts:660`
**Confidence**: MEDIUM

---

### U5: Interactions with existing features

**Classification**: ANSWERED
**Answer**: The plan's interaction list is nearly complete. Confirmed touchpoints: `connectors` (connector platform -- AP adapter, auth adapters, catalog, connection resolver), `auth-profiles` (Azure DI credential storage, encryption, key rotation), `multimodal-processing` (shared Docling infra), `workflow-engine` (`async_webhook` step, callback route, Restate durable promises), `audit-logging` (extraction audit events). Additional interactions the spec should call out: (1) **workflow-integration-node** (ALPHA, `docs/features/workflow-integration-node.md`) -- this feature extends the integration node's capabilities by adding two new connectors and extending the timeout schema; the integration node feature is a direct dependency. (2) **rate-limiting** (BETA, `docs/features/rate-limiting.md`) -- the per-tenant RateLimiterRedis for Docling follows the same pattern. (3) **encryption-at-rest** -- Azure DI credentials encrypted via the existing tenant encryption facade. (4) **tracing-observability** -- TraceEvents emitted per extraction. NOT in scope: channels (extraction does not interact with channel routing), agent runtime (this is workflow-engine only per plan non-goal #4), search-AI ingestion path (explicitly untouched).
**Source**: `docs/features/workflow-integration-node.md` (extends integration node); `docs/features/connectors.md` section 5 (integration matrix); plan sections 6, 7.2, 7.3
**Confidence**: HIGH

---

### T1: IntegrationNodeConfigSchema timeout extension (5-1800s)

**Classification**: DECIDED
**Answer**: The extension from `max(300)` to `max(1800)` is acceptable as a platform-wide schema change, but it should be done carefully. Rationale: (1) The `IntegrationNodeConfigSchema.timeout` at `workflow-schemas.ts:168` currently has `min(5).max(300).default(60)`. Changing `max(300)` to `max(1800)` affects ALL integration nodes, not just document extraction. (2) This is safe because the timeout is a per-step upper bound, not a resource reservation -- a higher max doesn't change behavior for existing workflows that use the 60s default. (3) Existing workflows serialized with `timeout: 60` (or any value 5-300) will continue to validate. (4) The default stays at 60s, so no behavioral change for existing workflows. (5) The Restate `async_webhook` parking pattern means long timeouts are cheap (journal entry, not held thread), as the plan notes. Migration story: none needed -- the schema change is backward compatible (wider max, same default). The spec should note this as a platform-wide schema change and explain the rationale (long-running document extraction, especially Azure DI on 100+ page PDFs). Do NOT create a separate step type just for a higher timeout -- that would be unnecessary complexity.
**Source**: `packages/shared/src/types/workflow-schemas.ts:162-169` (current schema); plan section 7.1 (timeout rationale); `apps/workflow-engine/src/handlers/workflow-handler.ts:2921-2929` (raceTimeout + async_webhook parking)
**Confidence**: HIGH

---

### T2: The orphan doc_intelligence NodeType

**Classification**: DECIDED
**Answer**: Option (b) -- leave it as-is (orphan/stub/hidden) for v1. Do NOT repurpose or delete it. Rationale: (1) The plan routes document extraction through the `integration` node type, which is already functional (ALPHA, wired to `connector_action` step type via `canvas-to-steps.ts`). This is the right architectural choice because it reuses the entire connector platform (connection resolution, auth profiles, dynamic action forms, catalog). (2) Repurposing `doc_intelligence` would require wiring it in `canvas-to-steps.ts`, creating a new step type, and duplicating much of the connector execution path -- significant effort for no user benefit. (3) Deleting it would be a breaking change (removes a value from `NodeTypeSchema` enum, removes entries from `NODE_CONFIG_SCHEMAS`, etc.) and violates the "feature commits are additive" rule. (4) The spec should document the orphan's existence and state: "The `doc_intelligence` NodeType exists as a stub/hidden node. This feature does not use it; document extraction is implemented as `integration`-typed connector actions. The stub may be cleaned up or repurposed in a future refactor." This is the lowest-risk, most reversible option.
**Source**: `packages/shared-kernel/src/types/workflow-types.ts:44-67` (STUB + HIDDEN); `packages/shared/src/types/workflow-schemas.ts:307-334` (schema + map); CLAUDE.md "feature commits are additive"
**Confidence**: HIGH

---

### T3: HMAC for worker-to-engine callback

**Classification**: ANSWERED
**Answer**: The existing `async_webhook` flow already handles this. The workflow handler at `workflow-handler.ts:2833-2842` generates a per-step HMAC secret inside a `ctx.run` lambda (so Restate journals only the ciphertext), then passes the plaintext as `x-callback-secret` header in the outbound webhook request. The callback route at `workflow-callbacks.ts:87-129` mandates HMAC verification -- it rejects callbacks without a `callbackSecret` on the step (line 89-95), requires `x-callback-signature` and `x-callback-timestamp` headers, and calls `verifyWebhookSignature()` with timing-safe comparison. For the Docling worker callback, the plan needs to ensure: (1) when the workflow step enqueues the BullMQ job, it includes the `callbackSecret` (encrypted) in the job payload so the worker can sign its callback POST; (2) the worker decrypts the secret and signs the POST body with HMAC-SHA256, setting `x-callback-signature` and `x-callback-timestamp` headers. The plan does not explicitly describe this, but the mechanism exists and is mandatory -- the spec should call it out. The worker will need the tenant's encryption key to decrypt the secret, OR the step should pass the plaintext secret in the job payload (encrypted at rest in Redis via BullMQ). The simpler approach: pass the plaintext HMAC secret in the BullMQ job data (Redis is already treated as a trusted internal store), and the worker signs with it directly. The callback route will verify.
**Source**: `apps/workflow-engine/src/handlers/workflow-handler.ts:2833-2891` (secret generation + encryption + header injection); `apps/workflow-engine/src/routes/workflow-callbacks.ts:87-129` (mandatory HMAC verification); `apps/workflow-engine/src/constants.ts:21` (24h timeout)
**Confidence**: HIGH

---

### T4: AuthProfile schema for Azure DI

**Classification**: ANSWERED
**Answer**: Confirmed -- the plan's approach is correct and the platform-wide AuthProfile schema does NOT need to change. The Azure DI piece declares its auth shape via `PieceAuth.CustomAuth({ props: { endpoint, apiKey, apiVersion, defaultModel } })` inside the AP piece package. Studio's `DynamicActionForm` auto-renders these fields via the existing `mapProperty` path in `runtime-adapter.ts`. The platform AuthProfile stores the credential using the existing `api_key` auth type: `apiKey` goes into the encrypted `secrets` field; `endpoint`, `apiVersion`, and `defaultModel` go into `connectionConfig` (`Record<string, string>`, already present on `ApiKeyConfigSchema` at `auth-profile.schema.ts:173`). The auth-adapter shim (`azure-document-intelligence.ts`) bridges between the resolved AuthProfile and the AP CustomAuth shape at call time -- exactly the same pattern as `jira-cloud.ts` and `servicenow.ts` (the only two existing files in `packages/connectors/src/adapters/activepieces/auth-adapters/`). This is the right approach: it preserves encryption-at-rest, audit trail, key rotation, and workspace-sharing semantics without schema changes.
**Source**: `packages/shared/src/validation/auth-profile.schema.ts:168-175` (ApiKeyConfigSchema with connectionConfig); `packages/connectors/src/adapters/activepieces/auth-adapters/` (jira-cloud.ts, servicenow.ts); plan section 4.5
**Confidence**: HIGH

---

### T5: Deployment/migration strategy -- feature flag gating pattern

**Classification**: INFERRED
**Answer**: The plan says `WORKFLOW_DOC_EXTRACTION_INTEGRATIONS_ENABLED` but does not specify the gating mechanism. Based on codebase patterns, the platform uses TWO feature-flag mechanisms: (1) environment variable flags (simple boolean env vars checked at boot or per-request, e.g., the removed `AUTH_PROFILE_ENABLED`), and (2) the `isFeatureEnabled()` resolver in `apps/studio/src/lib/feature-resolver.ts` which checks Deal features and Subscription plan tiers against `PLAN_FEATURES` from `@agent-platform/shared-kernel`. There is NO GrowthBook or percentage-based rollout system in the codebase. The recommended approach for this feature: use the `isFeatureEnabled()` pattern (Deal/Subscription-based) for the Studio UI gating (connector visibility in the Integration Picker), and an environment variable (`WORKFLOW_DOC_EXTRACTION_INTEGRATIONS_ENABLED=true|false`) on the workflow-engine and search-AI services for the backend gating. Rollout: staging (env var ON) -> internal tenants (add feature to internal Deal records) -> beta soak (5 business days per plan Phase 5) -> GA (flip env var default to ON, add to all subscription plan tiers in `PLAN_FEATURES`). This matches the auth-profiles precedent where the env flag was eventually removed and the feature became always-on.
**Source**: `apps/studio/src/lib/feature-resolver.ts` (Deal + Subscription + PLAN_FEATURES pattern); `docs/features/auth-profiles.md:31` ("AUTH_PROFILE_ENABLED feature flag has been removed"); plan section 11 (rollback via flag)
**Confidence**: MEDIUM

---

### T6: Two-queue topology -- concurrency split configurability

**Classification**: DECIDED
**Answer**: The concurrency split SHOULD be env-configurable, not hard-coded. The plan acknowledges the trade-off (section 5.0: "per-pod efficiency drops to 60% under one-queue skew") and explicitly notes "re-tune in Phase 5 beta." Hard-coding the split at 3+2 makes re-tuning require a code change + deploy, which is operationally expensive. Recommend: two new env vars `DOCLING_INGESTION_CONCURRENCY` (default 3) and `DOCLING_WORKFLOW_CONCURRENCY` (default 2), constrained so their sum does not exceed `INGESTION_MAX_CONCURRENT_JOBS` (which remains the total per-pod cap, default 5). This preserves the existing `INGESTION_MAX_CONCURRENT_JOBS` env var's semantics while allowing operators to tune the split without code changes. The current code at `apps/search-ai/src/workers/docling-extraction-worker.ts:660` already accepts `concurrency` as a parameter to `createDoclingExtractionWorker()`, and `apps/search-ai/src/server.ts:548` reads `INGESTION_MAX_CONCURRENT_JOBS` from env. Extending this pattern is natural. The spec should document the default split (3+2) and the configurability mechanism.
**Source**: `apps/search-ai/src/workers/docling-extraction-worker.ts:659-660` (concurrency param); `apps/search-ai/src/server.ts:548` (env var pattern); plan section 5.0, R14
**Confidence**: HIGH

---

### T7: Azure DI -- BYO-credentials only

**Classification**: ANSWERED
**Answer**: Confirmed -- BYO-credentials only via AuthProfile. The plan section 3.1 step 3 says the admin fills in their own Azure endpoint + API key. Plan section 5.9.6 confirms "the URL must be publicly fetchable from Azure's network." Plan section 2 non-goals exclude multi-region and custom models. There is no Azure-DI-as-a-service path; the platform does not provision or manage Azure DI subscriptions on behalf of tenants. Each tenant brings their own Azure DI resource. The spec should state this clearly: "Azure DI is BYO-credentials only. The platform does not provision or manage Azure DI subscriptions. Tenants configure their own Azure DI endpoint and API key via an AuthProfile."
**Source**: Plan sections 2 (non-goals), 3.1 (Azure DI setup UX), 4.5 (auth bridge), 5.9.6 (URL handling constraint)
**Confidence**: HIGH

---

### T8: Azure DI per-project cost-cap counter storage

**Classification**: DECIDED
**Answer**: The plan (section 7.4) says "Mongo counter increments on every successful Azure DI extraction" but does not specify the collection. Based on codebase patterns, there is no existing dedicated usage-counter collection for per-project cost tracking. The recommended approach: store the counter on the `ConnectorConnection` document (which already exists per-project for the Azure DI connection, has `tenantId` and `projectId` fields, and is the natural owner of per-connection usage state). Add fields: `usageCount: number` (incremented atomically via `$inc`), `usagePeriodStart: Date` (first day of the current month), `usageSoftCap: number` (default 1000), `usageHardCap: number | null`. Monthly reset: a simple check at increment time -- if `usagePeriodStart` is in a previous month, reset `usageCount` to 0 and update `usagePeriodStart`. This avoids a scheduled cron job for monthly resets and uses Mongo's atomic `$inc` for concurrency safety. Alternative: a new `IntegrationUsage` collection. But the simpler approach (fields on ConnectorConnection) avoids a new collection and keeps the counter co-located with the connection it tracks. The spec should state the storage mechanism and monthly reset strategy.
**Source**: `docs/features/connectors.md` section 6.1 (ConnectorConnection model -- tenantId, projectId, connectorName); plan section 7.4; no existing usage-counter collection found via grep
**Confidence**: MEDIUM

---

## Decisions Made (for DECIDED items)

| #    | Decision                                                                                                    | Rationale                                                                                                                | Risk   |
| ---- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------ |
| D-S1 | Docling toggle defaults to OFF for all projects                                                             | New GPU-cost vector + SSRF surface should require explicit opt-in; low friction (single toggle), high risk if accidental | Low    |
| D-S3 | Major feature at `docs/features/document-extraction-integrations.md`                                        | Touches 5+ packages, new queue topology, own delivery plan; connectors.md too large to absorb                            | Low    |
| D-U1 | Add platform operator and tenant billing admin as secondary personas                                        | New queue topology + Azure DI cost cap need ops and billing visibility                                                   | Low    |
| D-U3 | Per-tenant Docling rate limit is v1 MUST-HAVE                                                               | Closes AF-105 noisy-neighbor gap flagged in 3 audit docs; ~50 LOC wrapping existing dep                                  | Low    |
| D-U4 | Scale numbers (5 pods, 10 tenants, 60 extractions/min) are provisional targets                              | No production traffic data yet; lock in Phase 5 beta                                                                     | Low    |
| D-T1 | Extend IntegrationNodeConfigSchema timeout max from 300 to 1800 (platform-wide)                             | Backward compatible (wider max, same default); Restate parking makes long timeouts cheap                                 | Low    |
| D-T2 | Leave orphan doc_intelligence NodeType as-is; do not repurpose or delete                                    | Lowest risk, most reversible; integration node type is the right routing path                                            | Low    |
| D-T6 | Concurrency split should be env-configurable (DOCLING_INGESTION_CONCURRENCY + DOCLING_WORKFLOW_CONCURRENCY) | Enables operational tuning without code change; follows existing INGESTION_MAX_CONCURRENT_JOBS pattern                   | Low    |
| D-T8 | Store Azure DI cost counter on ConnectorConnection document with atomic $inc and month-boundary reset       | Avoids new collection; co-locates counter with connection; concurrency-safe via Mongo $inc                               | Medium |

---

## Escalations (for AMBIGUOUS items -- requires user input)

| #    | Question                                                                                                   | Why It's Ambiguous                                                                                                                           | Options                                                                                                                                                                                                                                           |
| ---- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A-S4 | What is the business driver for this feature (enterprise customer ask, competitive gap, internal cleanup)? | No JIRA ticket, roadmap doc, or customer reference found. The motivation affects the spec's Problem Statement framing and priority language. | Option A: Enterprise customer ask (name the customer or use case) / Option B: Internal initiative to fulfill the stub `doc_intelligence` node promise / Option C: Competitive parity with other automation platforms offering document extraction |

**User resolution (2026-05-15):** User did not select a specific driver; framed the spec as "a complete new feature draft based on the integration plan". The spec's Problem Statement now uses a neutral platform-completeness framing that captures the orphan `doc_intelligence` stub + workflow-engine document-processing capability gap.

---

## Audit Suite Results

### Pass 1 — phase-auditor (Round 1)

**Verdict:** APPROVED with no CRITICAL findings.

| Severity | Finding                                                                                                         | Resolution                                                                                              |
| -------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| HIGH     | FS-2 Provider value inconsistency — plan uses `azure-doc-intelligence`, spec uses `azure-document-intelligence` | Resolved: added "Known divergences from source plan" block to §18 documenting the deliberate departure. |
| HIGH     | FS-2 `callbackSecret` plaintext-in-Redis vs existing encrypt-on-step pattern needs explicit justification       | Resolved: §7 Technical Considerations now contains a multi-point deliberate-justification paragraph.    |
| HIGH     | FS-1/FS-10 Feature Area header lists `agent lifecycle` but Impact Matrix marks Agent lifecycle as NONE          | Resolved: removed from header; added explicit exclusion parenthetical.                                  |
| HIGH     | FS-3 FR-11 rate-limit scope (tenant vs project) was implicit                                                    | Resolved: FR-11 step 4 now explicitly states tenant-scoped + cross-refs Open Question #6.               |
| MEDIUM   | FS-2 `ssrf-validator.ts:402-454` line range imprecise                                                           | Resolved: §18 now calls out both `:402` and `:454` separately.                                          |
| MEDIUM   | FS-2 `auth-profile.schema.ts:267` reference incorrect                                                           | Resolved: §18 now correctly labels what's at each line.                                                 |
| MEDIUM   | FS-9 Testing guide source-plan path is desktop-local                                                            | Resolved: §1 of testing guide notes author-local path + planned copy to `docs/plans/`.                  |

### Pass 2 — phase-auditor (Round 2, fresh-eyes pass)

**Verdict:** APPROVED with no CRITICAL or HIGH findings.

| Severity | Finding                                                                                             | Resolution                                                                                 |
| -------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| MEDIUM   | FS-3 / API-AUTH — `GET .../docling/quota` missing auth requirement label in API table               | Resolved: added `Requires 'integrations:read'.` to the row.                                |
| MEDIUM   | FS-9 / XP-2 — Testing guide E2E-1 mentions BullMQ queue introspection (violates HTTP-only E2E rule) | Flagged for the test-spec phase; this is a testing-guide artifact issue, not feature-spec. |

### Pass 3 — Platform Audit (general-purpose)

**Verdict:** APPROVED with findings.

| Severity | Finding                                                                                                                                                                                                    | Resolution                                                                                                                                             |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| MEDIUM   | Workflow-engine routes don't currently use `requireProjectPermission` (only Studio does)                                                                                                                   | Resolved: added GAP-011 documenting the LLD-phase choice — either introduce Express middleware or accept `requireTenantProject()`-only scoping.        |
| MEDIUM   | `encryption-manifest.ts` needs new entry for `workflow-docling-extraction` queue                                                                                                                           | Resolved: added to Key Implementation Files §10 + GAP-012.                                                                                             |
| MEDIUM   | Auth-adapter pattern mismatch — existing `jira-cloud.ts` / `servicenow.ts` are `require.cache` monkey-patches for third-party AP packages, but Azure DI is from-scratch and needs a pure data-mapping shim | Resolved: FR-14 now explicitly clarifies "NOT a `require.cache` monkey-patch" and references `context-translator.ts:211-290` as the integration point. |
| LOW      | Error response shape — confirm structured `{ success, data?, error: { code, message } }` envelope                                                                                                          | Already specified in §12 via typed-error codes; documented as project convention.                                                                      |
| LOW      | Docling worker-to-service "TLS" claim mislabels HTTP loopback                                                                                                                                              | Acknowledged in §12 (current text already qualifies "loopback in v1 — `http://`").                                                                     |
| LOW      | Queue naming convention — `search-*` prefix today vs proposed `workflow-docling-extraction`                                                                                                                | Accepted as deliberate convention break to signal queue ownership.                                                                                     |
| LOW      | GAP-009 (platform-wide timeout extension) underspecified                                                                                                                                                   | Documented; long timeouts are cheap under Restate parking pattern across all integration connectors.                                                   |

**Invariant compliance:** all 7 CLAUDE.md core invariants verified PASS (tenant / project / user isolation, centralized auth, stateless distributed, stateless agent runtime, traceability, compliance, performance).

### Pass 4 — Industry Research Audit (general-purpose, WebSearch/WebFetch)

**Verdict:** 14 findings; spec is mainstream and well-aligned with industry practice; one significant divergence (50 MB inline cap vs Temporal's 2 MB).

| Tag         | Severity | Finding                                                                                                                                  | Resolution                                                                                                                   |
| ----------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| IMPROVEMENT | High     | DNS rebinding TOCTOU gap — spec doesn't explicitly mandate that `assertUrlSafeForSSRF` uses DNS pinning (OWASP-cited; 4+ 2025-2026 CVEs) | Resolved: §12 Security now explicitly mandates DNS pinning verification as an LLD gate.                                      |
| GAP         | Medium   | No dead-letter queue / poison-pill handling for BullMQ extraction-only jobs                                                              | Logged as a future hardening item; for v1 the `attempts: 1` + callback-timeout-with-engine-retry is the documented behavior. |
| RISK        | High     | 50 MB inline envelope cap vs Temporal's 2 MB norm                                                                                        | §12 Reliability now includes an industry comparison note + GAP-002 / R13 escalation hooks.                                   |
| IMPROVEMENT | Medium   | Missing extraction-accuracy / per-format success-rate metrics in §14                                                                     | Logged in Open Question #8 (recommended addition during beta soak; can be parity test extension).                            |
| IMPROVEMENT | Low      | Missing adoption-quality metrics (retention, time-to-first-extraction)                                                                   | Logged in Open Question #5 GA-criteria detail.                                                                               |
| GAP         | Medium   | No system-level backpressure beyond per-tenant rate limit                                                                                | Logged for v2; HPA + per-queue depth alerts are the v1 backpressure surface.                                                 |
| RISK        | Low      | HMAC plaintext in Redis — concrete hardening trigger needed                                                                              | §7 deliberate-justification paragraph now mentions the hardening-trigger condition explicitly.                               |
| IMPROVEMENT | Medium   | Azure DI `ctx.store` 24h TTL silent double-billing window                                                                                | Existing GAP-006 covers this; v2 escalation: use MongoDB with 7d retention.                                                  |
| GAP         | Medium   | In-process circuit breaker is lost on pod restart                                                                                        | Resolved: FR-17(c) clarifies in-process-only for v1; added GAP-013 + v2 migration path to `@agent-platform/circuit-breaker`. |
| IMPROVEMENT | Low      | No human-in-the-loop / overall-confidence field in envelope                                                                              | Logged for v2; out of scope for v1.                                                                                          |
| IMPROVEMENT | Medium   | Missing `pages` parameter for page-range extraction (cost + perf control)                                                                | Resolved: FR-4 now includes `pages` optional parameter.                                                                      |
| RISK        | Low      | Reserved concurrency 3+2 wastes 40% under skew; slot-borrowing as v2 mitigation                                                          | Already documented in GAP-005 + R14.                                                                                         |
| GAP         | Low      | No HEAD-probe timeout separate from extraction timeout                                                                                   | Resolved: FR-17(a) and FR-11 step 3 now specify 10s HEAD-probe timeout.                                                      |
| IMPROVEMENT | Low      | Month-boundary counter reset needs atomic CAS                                                                                            | Resolved: FR-18 now specifies conditional `findOneAndUpdate` CAS.                                                            |

### Pass 5 — OSS Library Audit (general-purpose, WebSearch/WebFetch)

**Verdict:** One high-value swap (custom Azure DI token-bucket → `RateLimiterMemory`). All other custom implementations justified.

| Custom Implementation                        | OSS Replacement Candidate                                                                                                      | Recommendation                                                                                                                                              | Action Taken                                                                        |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Azure DI in-process token-bucket (FR-17b)    | `rate-limiter-flexible` `RateLimiterMemory` (already a dependency)                                                             | **REPLACE** — zero dependency cost; identical API to Docling `RateLimiterRedis`; precedent at `apps/multimodal-service/src/security/upload-rate-limiter.ts` | Resolved: FR-17(b) now specifies `RateLimiterMemory`.                               |
| Azure DI in-process circuit breaker (FR-17c) | `opossum` (Apache-2.0, ~1.6k stars), `cockatiel` (MIT, ~1.7k stars), `@agent-platform/circuit-breaker` (Redis-backed, in-repo) | **KEEP custom for v1**; document v2 migration to `@agent-platform/circuit-breaker` for cross-pod consistency                                                | Resolved: FR-17(c) + GAP-013 document the in-process scope and v2 migration.        |
| Streaming URL → Docling helper (FR-9c/d)     | Existing `safeFetch` from `@agent-platform/shared-kernel/security` (returns `Readable`, SSRF-baked) + Node native `pipeline()` | **KEEP minimal custom; build on `safeFetch`**                                                                                                               | Logged for LLD phase; spec's §10 implementation files entry is sufficient guidance. |
| SSRF guard                                   | `ssrf-req-filter` (~30 stars, abandoned), `got-ssrf` (2 yrs stale)                                                             | **No external lib** — the in-repo `assertUrlSafeForSSRF` is more comprehensive                                                                              | Already specified.                                                                  |
| Document extraction engine                   | Unstructured.io (Apache-2.0), Marker (GPL — INCOMPATIBLE), PyMuPDF (AGPL — INCOMPATIBLE)                                       | **Keep Docling** (MIT, 37k stars, IBM-backed, already deployed)                                                                                             | Already specified — Docling is untouched per non-goal #6.                           |
| Azure DI SDK                                 | `@azure-rest/ai-document-intelligence` (Microsoft official)                                                                    | **No SDK** — SDK's `LongRunningOperation` wrapper conflicts with `ctx.store`-based replay safety                                                            | Already specified — spec uses raw REST.                                             |

---

## Final Status

- **Audit verdict:** APPROVED (no CRITICAL or HIGH unresolved). All 5 passes complete.
- **Spec status:** PLANNED — ready to advance to test-spec phase.
- **Outstanding for next phases:**
  - LLD must verify SSRF DNS-pinning (Industry Finding 1).
  - LLD must decide on `requireProjectPermission` Express middleware vs `requireTenantProject()`-only (GAP-011).
  - Test spec must ensure E2E scenarios use HTTP-only interaction (no BullMQ introspection — Round-2 MEDIUM).
