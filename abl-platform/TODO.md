# ABL Platform — Consolidated TODO

> **Last Updated**: 2026-03-23
> Generated from codebase scan of all TODO/FIXME/HACK annotations across apps/ and packages/, plus manual follow-up items from the platform feature-doc audit.
>
> **SDLC Pipeline Status**: 62/76 features have completed the full 4-phase pipeline (feature-spec → test-spec → HLD → LLD) with audit loops. See `docs/sdlc-backlog.md` for details.

---

## P0 — Critical (Blocking or Security)

### Search-AI Auth Architecture

- **File**: `apps/search-ai/src/middleware/jwt-only-auth.ts`
- **Issue**: Temporary JWT-only auth because search_ai database lacks User/Tenant/TenantMember tables. Cannot use unified auth middleware.
- **Fix**: Implement Studio API Gateway pattern (Option B) or migrate to shared database.

### Voice Feature Gating

- **File**: `apps/runtime/src/routes/voice.ts` (lines 216, 251, 358, 391, 431, 467)
- **Issue**: `requireFeature('voice_channels')` commented out pending subscription management deployment.
- **Fix**: Re-enable once subscription management is live.

### Token Store & Verifier Registry

- **File**: `apps/runtime/src/server.ts:1166`
- **Issue**: "Wire full verifier registry and Redis token store when available"
- **Fix**: Implement Redis-backed token store and integrate verifier registry.

---

## P1 — High Priority (Important Features & Integrations)

### Runtime Engine

- [ ] **Session compaction model config** — `services/session/compaction-engine.ts:257` — Use cheap `config.compactionModel` instead of primary LLM for summarization.
- [ ] **Flow delegation with resume** — `services/execution/flow-step-executor.ts:2739` — Implement delegation resume flow.
- [ ] **Alert delivery SMTP** — `services/alert-delivery.ts:222` — Integrate with SMTP/transactional email provider.
- [ ] **A2A SDK integration** — `services/execution/routing-executor.ts:36,1260,1284` — Re-enable when a2a-js SDK fixes SSE generator teardown; type SDKMessage/AgentThread.
- [ ] **Voice TTS error tracking** — `services/voice/korevg/korevg-session.ts:1433,1624` — Track TTS errors and slot filling counts.
- [ ] **Guardrails project scope** — `services/guardrails/pipeline-factory.ts:386,400` — Wire projectId and webhook config from DB.

### SearchAI Pipeline

- [ ] **Vector search** — `routes/search.ts:60` — Implement vector store integration.
- [ ] **Permission-filtered hybrid search** — `routes/search.ts:139` — Add permission filtering to hybrid search.
- [ ] **CEL syntax validation** — `services/pipeline-validation/validation.service.ts:689` — Add proper CEL validation with @marcbachmann/cel-js.
- [ ] **S3 document download** — `workers/docling-extraction-worker.ts:521` — Implement S3 download for document extraction.
- [ ] **Async job processing** — `routes/jobs.ts:113` — Enqueue jobs via BullMQ instead of synchronous processing.
- [ ] **Mapping transform preview** — `routes/mappings.ts:797` — Apply mapping transforms to sample data.
- [ ] **Webhook OAuth renewal** — `scheduler/webhook-renewal.ts:66,146` — Load OAuth tokens from EndUserOAuthToken model.

### SearchAI Structured Data

- [ ] **Vector search with embeddings** — `services/structured-data/table-discovery.ts:103`
- [ ] **Semantic search with embeddings** — `services/structured-data/query-router.ts:229`
- [ ] **Text-to-SQL via LLM** — `services/structured-data/query-router.ts:247`
- [ ] **Hybrid structured search** — `services/structured-data/query-router.ts:265`

### SearchAI Taxonomy

- [ ] **YAML parsing** — `services/taxonomy-loader.service.ts:264,289`
- [ ] **LLM-based unstructured parsing** — `services/taxonomy-loader.service.ts:581`
- [ ] **Disambiguation keywords** — `services/taxonomy-loader.service.ts:590`

### Sentence Alignment

- [ ] **Real tokenizer** — `services/tree-builder/sentence-aligner.ts:135` — Replace fake tokenizer with tiktoken or actual tokenizer.

---

## P2 — Medium Priority (Quality, UX, Tech Debt)

### Studio

- [ ] **Project template selection** — `components/projects/ProjectDashboard.tsx:56`
- [ ] **Connector brand icons** — `components/connections/ConnectorLogo.tsx:31` — Replace generic icons with actual SVGs.
- [ ] **Keyboard shortcuts modal** — `components/CommandPalette.tsx:211`
- [ ] **OpenAPI UI self-hosting** — `app/api/openapi/route.ts:10,19` — Self-host swagger-ui assets instead of CDN.
- [ ] **Pipeline cancellation** — `lib/pipeline-service.ts:41,74` — Wire up Restate cancel API.
- [ ] **S3 multi-region buckets** — `services/archive/s3-archive-store.ts:171` — Data residency region lookup.
- [ ] **Git webhook async** — `app/api/webhooks/git/[projectId]/route.ts:124` — Move to BullMQ background job.
- [ ] **SSRF validation DRY** — `app/api/projects/[id]/git/route.ts:83` — Consolidate with `agent-transfer/ssrf-guard.ts`.
- [ ] **Webhook rate limiting** — Not yet implemented on webhook routes.
- [ ] **Token in URL** — `contexts/WebSocketContext.tsx:539` — Move token from URL query to header/cookie.
- [ ] **Share token permissions** — `app/api/sdk/share/route.ts:200` — Allow configurable permission scope.

### Runtime

- [ ] **Session resolution in HTTP** — `routes/chat.ts:853` — Use `resolveSession()` from SessionStore.
- [ ] **Admin proxy decoupling** — `proxy.ts:36` — Remove once Admin connects to Runtime directly.
- [ ] **Mongo workflow tests** — `__tests__/workflow-routes.test.ts:97,105` — Migrate to MongoWorkflowDefinitionStore.
- [ ] **Mongo contact tests** — `__tests__/contact-routes.test.ts:139,147` — Migrate to MongoContactStore.

### TraceStore Instrumentation (~40 occurrences)

- [ ] **Schema discovery services** — All files in `packages/search-ai-internal/src/services/` need TraceEvent emission: CSVSchemaDiscovery, GoogleSheetsSchemaDiscovery, JSONSchemaDiscovery, SharePointSchemaDiscovery, TemplateEnumEnrichment, DiscoveredSchemaPersistence, RuleBasedMapping.
- [ ] **Circuit breaker registry** — `services/mapping-suggestion/circuit-breaker-registry.ts:85`

---

## P3 — Future / Deferred

### Connectors

- [ ] **Activepieces importer** — `connectors/src/adapters/activepieces/importer.ts:42` — Placeholder implementation.
- [ ] **SharePoint pause/resume** — `connectors/sharepoint/src/sharepoint-connector.ts:235,243` — Checkpoint logic.
- [ ] **SharePoint webhooks** — `connectors/sharepoint/src/sharepoint-connector.ts:344,352` — Multi-drive webhook setup.
- [ ] **SharePoint nested groups** — `permissions/sharepoint-permission-crawler.ts:262` — Handle Group → Group nesting.

### Compiler Platform Stores

- [ ] **LangSmith integration** — `platform/stores/trace-store.ts:477`
- [ ] **PostgreSQL trace store** — `platform/stores/trace-store.ts:480`
- [ ] **PostgreSQL agent registry** — `platform/stores/agent-registry.ts:460`
- [ ] **PostgreSQL conversation store** — `platform/stores/conversation-store.ts:373`
- [ ] **MongoDB conversation store** — `platform/stores/conversation-store.ts:376`
- [ ] **Redis fact store** — `platform/stores/fact-store.ts:503`
- [ ] **PostgreSQL fact store** — `platform/stores/fact-store.ts:508`

### Pipeline Engine

- [ ] **ClickHouse ReplicatedMergeTree** — `pipeline/schemas/init-eval-tables.ts:9` — For clustered deployments.
- [ ] **Warm tier storage** — `pipeline/schemas/init-eval-tables.ts:174` — When storage policies configured.
- [ ] **Legacy Temporal workflow** — `pipeline/services/run-legacy-workflow.service.ts:31`

### Agent Transfer

- [ ] **Agent disconnect event** — `adapters/kore/index.ts:319` — Add `agent_disconnect` handling.
- [ ] **XO agent_exited mapping** — `types.ts:74` — Wire when SmartAssist exposes the event.

### Other

- [ ] **NL parser API fields** — `nl-parser/src/generator.ts:384` — Wire up public API contract fields.
- [ ] **Permission graph depth** — `search-ai-internal/permissions/permission-graph-client.ts:850` — averageGroupDepth/maxGroupDepth.
- [ ] **CEL test fixes** — `search-ai/services/flow-selection/__tests__/flow-selection.service.test.ts:523,542,579,598`

---

## Architecture — Incomplete Phase Work

Multi-phase implementation plans where Phase 1 is complete but later phases are pending.
Source: `docs/architecture/`, `docs/archive/plans-2026-02/`.

### Design Compilation & Persistence (`docs/architecture/design-compilation-persistence.md`)

- [x] **Phase 1**: VersionService + compile-at-version-time + REST API
- [ ] **Phase 2**: DeploymentService + manifest resolution + deploy API
- [ ] **Phase 3**: SDK handler + deployment-aware session creation
- [ ] **Phase 4**: Session persistence wiring (use SessionStore instead of in-memory Map)
- [ ] **Phase 5**: Git integration + file watcher
- [ ] **Phase 6**: Studio UI/UX for deployments

### Runtime Architecture (`docs/architecture/RUNTIME_ARCHITECTURE.md`)

- [x] **Phase 1**: Precompilation (VersionService)
- [x] **Phase 2**: Express routing + middleware stack
- [ ] **Phase 3**: Hot reload (file watcher + WebSocket broadcast + UI auto-refresh)
- [ ] **Phase 5**: Deployment service + manifest resolution

### Centralized Auth (`docs/archive/plans-2026-02/2026-02-22-centralized-auth-design.md`)

- [x] **Phases 1–3**: Auth middleware refactoring, user-level data ownership, session ownership
- [ ] **Phase 4**: SDK/API key access models

### Data Architecture (`docs/architecture/DATA_ARCHITECTURE.md`)

- [x] **Phase 1–2**: MongoDB + ClickHouse + TraceStore
- [ ] **Phase 3**: OTEL pipeline for trace/metric collection to ClickHouse
- [ ] **Phase 4**: Prisma removal (stores independent of Prisma)

### Observability & Tracing (`docs/architecture/OBSERVABILITY_AND_TRACING.md`)

- [x] Core TraceStore + event types
- [ ] Guardrail events wiring (types defined, not connected at runtime)
- [ ] Verbosity control (design complete, not wired into session creation)
- [ ] Arch diagnostic patterns (8 patterns designed, not integrated)

### Channel System (`docs/architecture/CHANNEL_SYSTEM_ARCHITECTURE.md`)

- [x] Phase 1: Channel registry, WhatsApp, Twilio SMS, voice
- [ ] Phase 2: Server-side RichContent format selection
- [ ] Chat route session resolution (when SessionStore available in HTTP path)

### Execution Model Redesign (`docs/archive/plans-2026-02/2026-02-19-executor-unification-design.md`)

- [ ] Replace shared-mutable-session with isolated child sessions
- [ ] Parallel fan-out via `Promise.allSettled`
- [ ] Executors not yet created: `gather-executor`, `complete-executor`, `handoff-executor`, `delegate-executor`, `flow-executor`

### ABL YAML + CEL Migration

- [ ] Replace custom expression engine with CEL (`@marcbachmann/cel-js`)
- [ ] Dual parser: legacy `.abl` + YAML
- [ ] CEL deprecation criteria defined, not enforced

### Workflow Engine — Restate (`docs/archive/plans-2026-02/`)

- [ ] Replace 4 hardcoded Temporal workflows with dynamic Restate-based pipeline orchestration
- [ ] Restate client wiring (5 TODOs in `apps/workflow-engine`)

### Voice (`apps/runtime/TODO-voice.md`)

- [x] Browser-to-server WebSocket, Deepgram STT, ElevenLabs TTS, basic barge-in
- [ ] Latency improvements (target <500ms) — 4 items
- [ ] Barge-in refinements (silence detection, state machine) — 3 items
- [ ] Twilio integration (media handler, mulaw, DTMF, call control) — 5 items
- [ ] Audio quality (echo cancellation, noise suppression) — 2 items
- [ ] Testing (unit, integration, load, browser compat) — 4 items

---

## Release Tooling — Remaining Work

- [x] `apx release cut/finalize/status/changelog` — implemented
- [x] `apx hotfix create/finalize` — implemented
- [x] Jira client (`scripts/jira-client.ts`) — implemented
- [x] Branch protection (`.husky/pre-push`) — implemented
- [x] Release documentation (`docs/release-process.md`) — complete
- [ ] **Harness CI pipeline for release branches** — Add conditional stage to `ci-build.yaml` for `release/*` branches (full test suite, version-tagged Docker images)
- [ ] **Harness deploy pipeline on tag** — Auto-update `abl-platform-deploy` Helm values when `v*` tag is pushed
- [ ] **Jira transition automation** — Auto-transition tickets to "Done" when release is finalized (transition name TBD)
- [ ] **Bitbucket branch permissions** — Configure in Bitbucket UI per `docs/release-process.md` recommendations

---

## SDLC Pipeline — Completed (2026-03-22 to 2026-03-23)

All 76 features are being re-run through the proper SDLC pipeline with product-oracle, phase-auditors, and full audit loops. As of 2026-03-23:

| Priority     | Features | Done   | Remaining |
| ------------ | -------- | ------ | --------- |
| P0 Critical  | 12       | 12     | 0         |
| P1 Important | 16       | 16     | 0         |
| P2 Standard  | 25       | 25     | 0         |
| P3 Low       | 23       | 23     | 0         |
| **Total**    | **76**   | **76** | **0**     |

Key security findings surfaced by the pipeline:

- **Alerts**: SQL injection in custom query builder
- **EventStore**: Cross-tenant wildcard subscription vulnerability
- **Knowledge Graph**: Cypher injection in Neo4j queries
- **Platform Admin**: JWT not verified on admin routes
- **Web Crawling**: Tenant isolation bypass in crawl-history routes (reads tenantId from query params)
- **CORS**: Production middleware uses single frontendUrl instead of configured origins array
- **Contacts**: `findByIdAndDelete` bypasses tenant isolation
- **Device Auth**: TOCTOU race in concurrent token polling

Full tracking: `docs/sdlc-backlog.md`
Per-feature logs: `docs/sdlc-logs/<feature>/`
Test specs: `docs/testing/<feature>.md`
HLDs: `docs/specs/<feature>.hld.md`
LLDs: `docs/plans/2026-03-2*-<feature>-impl-plan.md`

---

## Summary

| Priority          | Count    | Description                                             |
| ----------------- | -------- | ------------------------------------------------------- |
| **P0**            | 3        | Security/blocking issues                                |
| **P1**            | 22       | Core feature gaps and integrations                      |
| **P2**            | 28       | Quality, UX, tech debt                                  |
| **P3**            | 18       | Future/deferred capabilities                            |
| **Architecture**  | 30+      | Incomplete phase work across 10 multi-phase plans       |
| **Release**       | 4        | CI/CD and Bitbucket configuration                       |
| **SDLC Pipeline** | 76/76    | Features with full spec/test/HLD/LLD pipeline complete  |
| **Total**         | **103+** | Unique items (excluding ~40 TraceStore instrumentation) |
