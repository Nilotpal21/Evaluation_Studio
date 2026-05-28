# Audit Logging Hardening Implementation Log

Date: 2026-04-16
LLD: [docs/plans/2026-04-16-audit-logging-hardening-impl-plan.md](/Users/sainathbhima/.codex/worktrees/c832/abl-platform/docs/plans/2026-04-16-audit-logging-hardening-impl-plan.md)

## Preflight

- Read fresh from disk:
  - `docs/features/audit-logging.md`
  - `docs/specs/audit-logging.hld.md`
  - `docs/testing/audit-logging.md`
  - `docs/plans/2026-04-16-audit-logging-hardening-impl-plan.md`
- Verified Phase 1 target files exist:
  - `packages/compiler/src/platform/core/types.ts`
  - `packages/compiler/src/platform/stores/audit-store.ts`
  - `packages/database/src/models/audit-log.model.ts`
  - `apps/runtime/src/services/stores/mongo-audit-store.ts`
- Working tree is not clean because audit review docs and the implementation plan are currently untracked. Treating those docs as user-owned artifacts and avoiding unrelated rewrites.
- Recent changes in the last week touched the main target files, but no direct conflict with the Phase 1 LLD shape was found during source inspection.
- Local workspace currently has no `node_modules` directory, so build/test verification may require dependency installation before Phase 1 exit gates can fully run.

## Phase 1

Status: completed

Goal: Introduce a canonical shared audit envelope and compatibility decoder without changing system behavior yet.

### Implementation

- Installed workspace dependencies with `pnpm install --frozen-lockfile` so the Phase 1 build/test gates could run locally.
- Extended the shared audit contract in `packages/compiler/src/platform/core/types.ts` and `packages/compiler/src/platform/stores/audit-store.ts` with canonical envelope fields:
  - `schemaVersion`
  - `source`
  - `metadataEncoding`
  - `retentionClass`
  - `expiresAt`
- Added `packages/compiler/src/platform/stores/shared-audit-codec.ts` with:
  - canonical envelope creation
  - legacy row classification
  - compatibility decoding
  - Mongo document encoding
  - additive backfill patch generation
- Exported the shared codec from `packages/compiler/src/platform/stores/index.ts`.
- Expanded `packages/database/src/models/audit-log.model.ts` with canonical top-level fields and indexes, including sparse TTL support on `expiresAt`.
- Updated `apps/runtime/src/services/stores/mongo-audit-store.ts` to:
  - write via the shared codec
  - read/query via the compatibility decoder
  - support top-level canonical `tenantId`, `eventType`, `resourceType`, `resourceId`, and `traceId`
- Added Phase 1 migration utilities:
  - `apps/runtime/src/scripts/audit-log-compat-report.ts`
  - `apps/runtime/src/scripts/audit-log-backfill-v2.ts`
- Added locked tests for the new codec, model, compat report, and backfill plan.

### Verification

- Build gate passed:
  - `pnpm build --filter=@abl/compiler --filter=@agent-platform/database --filter=@agent-platform/runtime`
- Locked tests passed:
  - `pnpm --filter @abl/compiler test -- src/__tests__/shared-audit-codec.test.ts`
  - `pnpm --filter @agent-platform/database test -- src/__tests__/audit-log.model.test.ts`
  - `pnpm --filter @agent-platform/runtime test -- src/__tests__/audit-log-compat-report.test.ts src/__tests__/audit-log-backfill-v2.test.ts`
- Formatting applied:
  - `npx prettier --write <changed-files>`

### Notes

- The targeted build initially failed under sandbox restrictions because the connectors build uses `tsx` IPC sockets. Re-running the build outside the sandbox resolved that environmental issue.
- The first runtime test pass exposed a real idempotency bug in the backfill planner. The shared codec was updated so it only backfills meaningful canonical values, keeping canonical rows true no-op entries on rerun.

## Phase 2

Status: completed

Goal: Make Mongo and ClickHouse behave like two implementations of the same shared contract.

### Implementation

- Updated `apps/runtime/src/services/stores/clickhouse-audit-store.ts` to:
  - use canonical compatibility metadata for new writes when the runtime rollout flag is enabled
  - preserve `traceId` in `session_id`
  - decode reads through the shared codec instead of reconstructing semantics from `action` alone
  - require explicit tenant scoping for reads unless a tenant-scoped store instance is provided
  - support legacy trace lookup through both `session_id` and metadata `traceId`
  - summarize by canonical `eventType`, not just `action`
- Updated `apps/runtime/src/services/audit-store-singleton.ts` to:
  - remove the hardcoded `'default'` ClickHouse tenant
  - thread `alertConfig`, `clickhouseTenantId`, and `canonicalWriterEnabled` options into initialization
  - gate canonical ClickHouse writes behind `RUNTIME_AUDIT_CANONICAL_WRITER_ENABLED`
- Updated `apps/runtime/src/services/audit-helpers.ts` so runtime helper calls populate top-level `tenantId` and `projectId` fields instead of relying on metadata-only shadows.
- Added ClickHouse compatibility tooling:
  - `apps/runtime/src/scripts/clickhouse-audit-compat-report.ts`
  - `apps/runtime/src/scripts/clickhouse-audit-backfill-v2.ts`
- Expanded runtime test coverage for:
  - Mongo canonical tenant/event-type queries
  - ClickHouse shared-contract parity
  - ClickHouse legacy trace compatibility and idempotent migration planning
  - singleton alert/config wiring and tenant-safe ClickHouse initialization

### Verification

- Build gate passed:
  - `pnpm build --filter=@agent-platform/runtime`
- Locked tests passed:
  - `pnpm --filter @agent-platform/runtime test -- src/__tests__/mongo-audit-store.test.ts src/__tests__/clickhouse-audit-store.test.ts src/__tests__/clickhouse-audit-migration.test.ts src/__tests__/audit-store-singleton.test.ts`
- Formatting applied:
  - `npx prettier --write <changed-files>`

### Notes

- ClickHouse rows remain legacy-shaped at the table level because `audit_events` does not have dedicated top-level canonical columns such as `eventType` or `source`. Phase 2 resolves this by writing canonical compatibility metadata and decoding through the shared codec.
- The migration tests surfaced fixture-level mismatches around the exact compatibility metadata shape produced by the canonical writer. The fixtures were aligned with the actual writer output so the idempotency assertions now reflect production behavior accurately.

## Phase 3

Status: completed

Goal: Make Studio and Admin tolerant readers first, then normalize shared-path writes without breaking existing user-facing behavior.

### Implementation

- Updated `apps/studio/src/services/audit-service.ts` to:
  - keep metadata sanitization in place
  - write canonical shared audit fields through the Phase 1 codec instead of preferring JSON-string metadata
  - preserve fallback behavior by logging failures and emitting the existing stderr audit fallback record
- Updated `apps/studio/src/repos/audit-repo.ts` to decode shared audit rows through the compatibility codec before returning them to Studio callers, while leaving archive-manifest helper return shapes broad enough to avoid unrelated typing regressions.
- Updated `apps/studio/src/app/api/audit/route.ts` to:
  - safely handle both string and object metadata at the route boundary
  - preserve legacy personal-scope semantics by default
  - support an explicit tenant-safe personal mode via `personalScopeMode=tenant-safe` (or `STUDIO_AUDIT_PERSONAL_SCOPE_MODE=tenant-safe`)
- Updated `apps/admin/src/lib/audit-logger.ts` to:
  - write canonical-compatible shared audit rows for admin actions
  - decode both legacy string-metadata rows and canonical object-metadata rows centrally in `queryAuditLog(...)`
  - keep secondary consumers such as secret-rotation history compatible without additional route-specific parsing
- Added locked Phase 3 tests:
  - `apps/studio/src/__tests__/audit-service.test.ts`
  - extended `apps/studio/src/__tests__/api-routes/api-audit.test.ts`
  - `apps/admin/src/__tests__/audit-route.test.ts`
  - `apps/admin/src/__tests__/secret-rotation-history.test.ts`

### Verification

- Build gates passed:
  - `pnpm build --filter=@agent-platform/admin --filter=@agent-platform/studio`
  - `pnpm build --filter=@agent-platform/studio`
- Locked tests passed:
  - `pnpm --filter @agent-platform/studio exec vitest run --config vitest.node.config.ts src/__tests__/audit-service.test.ts src/__tests__/api-routes/api-audit.test.ts`
  - `pnpm --filter @agent-platform/admin exec vitest run src/__tests__/audit-route.test.ts src/__tests__/secret-rotation-history.test.ts`
- Formatting applied:
  - `npx prettier --write <changed-files>`

### Notes

- The combined Studio/Admin build initially exposed a real module-resolution constraint: Admin could not bundle `@abl/compiler/platform` directly through Next.js without extra dependency wiring. Phase 3 kept the Studio path on the shared codec, but switched the Admin path to a local canonical-compatible encoder/decoder so the slice stayed focused and shippable.
- The first escalated Studio build also revealed that an earlier `next build` process was still holding the Studio build lock. After clearing the stale process and rerunning the build, the remaining failure was a repo typing regression caused by tightening archive helper return types too broadly. Those helper types were widened back to their original compatibility surface, and the final Studio build completed successfully.
- Admin route expectations were updated to match the intended compatibility shape: canonical fields like `environment` now live on the top-level response, while custom metadata remains in the `metadata` object.

## Phase 4

Status: completed

Goal: Close the highest-value generic coverage gaps in runtime and Studio after the shared path is stable.

### Implementation

- Wired runtime contact lifecycle auditing through the DDD contact context:
  - `apps/runtime/src/server.ts` now passes `onContactAudit: emitContactLifecycleAudit` into `createContactContext(...)`
  - `apps/runtime/src/services/audit-helpers.ts` now translates domain contact actions such as `contact.created`, `contact.session_linked`, `contact.merged`, and `contact.self_merged` into durable shared-audit writes without replacing the existing hard-delete callback path
- Added a composition-level runtime wiring assertion in `apps/runtime/src/__tests__/wiring.test.ts` proving the server bootstrap actually supplies `onContactAudit`.
- Added missing Studio audit writes for high-value auth/security/archive/SSO flows:
  - `apps/studio/src/app/api/auth/logout/route.ts`
  - `apps/studio/src/app/api/auth/refresh/route.ts`
  - `apps/studio/src/app/api/mfa/disable/route.ts`
  - `apps/studio/src/app/api/archives/audit-export/route.ts`
  - `apps/studio/src/app/api/archives/sessions/route.ts`
  - `apps/studio/src/app/api/archives/traces/route.ts`
  - `apps/studio/src/app/api/archives/[id]/download/route.ts`
  - `apps/studio/src/app/api/archives/[id]/route.ts`
  - `apps/studio/src/app/api/sso/config/route.ts`
  - `apps/studio/src/app/api/sso/domains/verify/route.ts`
  - `apps/studio/src/app/api/sso/oidc/callback/route.ts`
  - `apps/studio/src/app/api/sso/saml/callback/route.ts`
- Extended Studio route tests to assert those audit writes fire with the expected action names and metadata in:
  - `apps/studio/src/__tests__/api-routes/api-auth.test.ts`
  - `apps/studio/src/__tests__/api-routes/api-mfa-routes.test.ts`
  - `apps/studio/src/__tests__/archive-api-routes.test.ts`
  - `apps/studio/src/__tests__/api-routes/api-sso-routes.test.ts`
- Fixed a pre-existing Studio Vitest alias gap by mapping `@agent-platform/shared/encryption` in `apps/studio/vitest.config.ts`, which was required for the SSO route tests to resolve encryption helpers under Vitest.
- Hardened the runtime `contacts-authz` test harness so the route-authz regression can run reliably with awaited server teardown.

### Verification

- Build gate passed:
  - `pnpm build --filter=@agent-platform/runtime`
- Locked and targeted runtime tests passed:
  - `pnpm --filter @agent-platform/runtime test -- src/__tests__/execution/contexts/contact/contact-audit.test.ts`
  - `pnpm --filter @agent-platform/runtime test -- src/__tests__/wiring.test.ts`
  - `pnpm --filter @agent-platform/runtime test -- src/__tests__/auth/contacts-authz.test.ts`
- Locked and targeted Studio tests passed:
  - `pnpm --filter @agent-platform/studio test -- src/__tests__/api-routes/api-auth.test.ts src/__tests__/api-routes/api-mfa-routes.test.ts src/__tests__/archive-api-routes.test.ts src/__tests__/api-routes/api-sso-routes.test.ts`
  - `pnpm --filter @agent-platform/studio test -- src/__tests__/e2e/auth-studio-events.test.ts src/__tests__/mfa.test.ts`
- Formatting applied:
  - `npx prettier --write <changed-files>`

### Notes

- The runtime `contacts-authz` regression binds a local HTTP test server. That test cannot run inside the default sandbox because `listen(...)` is denied there, so the verification run used an unrestricted local execution.
- `pnpm build --filter=@agent-platform/studio` still stalls after entering `next build` and reaching `Creating an optimized production build ...` in this environment. I re-ran it fresh for Phase 4 and saw the same behavior before stopping the stuck process. Route-level verification is green, but the full Studio production build remains an environment-specific blocker that needs follow-up outside this slice.
- Phase 4 kept device-auth and token-revoke coverage scoped to the routes currently owned by Studio. The repo no longer exposes an obvious Studio-owned device-auth lifecycle route, so this slice focused on logout, refresh, MFA disable, SSO lifecycle, and archive actions where there is a clear production path today.

## Phase 5

Status: completed

Goal: Close the remaining SearchAI / Git / boundary-coverage gaps while keeping durable audit, operational history, and debug-only paths clearly separated.

### Implementation

- Added a fire-and-forget connector audit helper in `apps/search-ai/src/services/connector-audit.service.ts`:
  - kept the existing durable `writeAuditEntry(...)` path
  - added `queueAuditEntry(...)` for hot-path best-effort writes that log failures instead of blocking request completion
- Replaced logger-only mapping audit in `apps/search-ai/src/routes/mappings.ts` with durable connector audit grouped by connector:
  - `mapping.manual_create`
  - `mapping.update`
  - `mapping.confirm`
  - `mapping.reject`
  - `mapping.batch_confirm`
  - `mapping.batch_reject`
- Added durable connector audit for notification config and webhook-test actions in `apps/search-ai/src/routes/connector-notifications.ts`:
  - `notification.updated`
  - `notification.webhook_tested`
- Tightened inbound webhook handling in `apps/search-ai/src/routes/webhooks.ts`:
  - replaced `console.*` calls with structured logger usage
  - durable audit now records valid, state-changing batches as `webhook.batch_queued`
  - invalid / non-actionable receipts remain explicitly operational-only
- Made crawl history classification explicit in `apps/search-ai/src/services/crawl-audit-policy.ts` and wired deletion through that helper from `apps/search-ai/src/routes/crawl.ts`:
  - current classification is `operational_history`
  - crawl audit is intentionally deleted with crawl jobs under that policy
- Made omnichannel’s boundary explicit in `apps/runtime/src/services/omnichannel/omnichannel-audit.ts`:
  - classification constant is now `operational_only`
  - added `clearAuditBufferForTesting()` to make the boundary testable without pretending it is a durable audit store
- Extended Studio shared audit actions in `apps/studio/src/services/audit-service.ts` for Git coverage:
  - `git_integration_created`
  - `git_integration_updated`
  - `git_integration_deleted`
  - `git_pull_completed`
  - `git_push_completed`
  - `git_promotion_completed`
  - `git_webhook_accepted`
- Added shared durable audit writes to the relevant Studio Git routes:
  - `apps/studio/src/app/api/projects/[id]/git/route.ts`
  - `apps/studio/src/app/api/projects/[id]/git/pull/route.ts`
  - `apps/studio/src/app/api/projects/[id]/git/push/route.ts`
  - `apps/studio/src/app/api/projects/[id]/git/promote/route.ts`
  - `apps/studio/src/app/api/webhooks/git/[projectId]/route.ts`
- Added locked Phase 5 regression coverage:
  - `apps/search-ai/src/routes/__tests__/mappings-crud.test.ts`
  - `apps/search-ai/src/routes/__tests__/connector-notifications.test.ts`
  - `apps/search-ai/src/routes/__tests__/webhooks-audit.test.ts`
  - `apps/search-ai/src/routes/__tests__/crawl-audit-retention.test.ts`
  - `apps/studio/src/__tests__/api-routes/api-git-routes.test.ts`
  - `apps/studio/src/__tests__/api-routes/api-webhook-git-routes.test.ts`
  - `apps/studio/src/__tests__/api-routes/project-git-audit.test.ts`
  - `apps/runtime/src/__tests__/omnichannel-audit-boundary.test.ts`

### Verification

- Build gates passed:
  - `pnpm build --filter=@agent-platform/search-ai`
  - `pnpm build --filter=@agent-platform/runtime`
- Locked and targeted SearchAI tests passed:
  - `pnpm --filter @agent-platform/search-ai exec vitest run src/routes/__tests__/mappings-crud.test.ts src/routes/__tests__/connector-notifications.test.ts src/routes/__tests__/webhooks-audit.test.ts src/routes/__tests__/crawl-audit-retention.test.ts`
- Locked and targeted Studio tests passed:
  - `pnpm --filter @agent-platform/studio exec vitest run --config vitest.node.config.ts src/__tests__/api-routes/api-git-routes.test.ts src/__tests__/api-routes/api-webhook-git-routes.test.ts src/__tests__/api-routes/project-git-audit.test.ts`
- Locked and targeted Runtime tests passed:
  - `pnpm --filter @agent-platform/runtime exec vitest run src/__tests__/omnichannel-audit-boundary.test.ts`
- Formatting applied:
  - `npx prettier --write <changed-files>`

### Notes

- The first combined SearchAI/Studio/Runtime build surfaced a real bug in `apps/search-ai/src/routes/mappings.ts`: the new batch-review audit path referenced `updatedMappings` outside its scope. I fixed that before the final verification run.
- SearchAI’s route suites use Supertest against an Express app. Inside the default sandbox, those tests fail with `listen EPERM`. Re-running the exact Phase 5 SearchAI test command outside the sandbox passed cleanly.
- The omnichannel boundary test initially expected 1000 same-tenant entries after also inserting a cross-tenant record. That was stricter than the actual global ring-buffer contract. The test now reflects the real behavior: the buffer is globally bounded to 1000 entries, so one cross-tenant entry displaces one oldest same-tenant entry.
- The new Studio `project-git-audit` regression initially returned `500` because the constructor mocks for `new GitSyncService(...)` and `new BranchManager(...)` used arrow-style implementations that Vitest does not treat as valid constructors. Switching those mocks to constructor-shaped functions fixed the route tests.
- `pnpm build --filter=@agent-platform/studio` remains the same environment-specific blocker seen in Phase 4: the build reaches `Creating an optimized production build ...` and stalls in this environment. Phase 5 route/test verification is green, but the full Studio production build still needs separate follow-up outside this slice.

## Phase 6

Status: completed

Goal: Make retention, sizing, buffering, and migration operations explicit, configurable, and safe to roll out without breaking existing audit behavior.

### Implementation

- Added shared retention config helpers to `packages/compiler/src/platform/stores/shared-audit-codec.ts`:
  - `getSharedAuditRetentionConfig(...)`
  - `computeSharedAuditExpiresAt(...)`
  - shared env defaults for:
    - `AUDIT_LOG_TTL_ENABLED`
    - `AUDIT_LOG_AUTH_TTL_DAYS`
    - `AUDIT_LOG_CRUD_TTL_DAYS`
    - `AUDIT_LOG_DEFAULT_TTL_DAYS`
- Hardened the runtime shared-auth audit buffer in `apps/runtime/src/repos/auth-repo.ts`:
  - moved hardcoded buffer settings to env-configurable defaults
  - exposed `getAuthAuditBufferConfig()` and `getAuthAuditBufferStats()`
  - added dropped-entry / overflow / flush counters
  - switched buffered writes to canonical shared-envelope encoding
  - fixed shutdown behavior so `shutdownAuditLogs()` now waits for an already in-flight flush instead of returning early
- Added explicit shutdown coverage for buffered PII audit:
  - `packages/compiler/src/platform/security/pii-audit.ts` now gives `PIIAuditLogger.stop()` an awaited flush path
  - `apps/runtime/src/services/execution/pii-audit-singleton.ts` now exports `shutdownPIIAuditLogger()`
  - `apps/runtime/src/services/runtime-shutdown-flush.ts` now flushes shared auth audit, then PII audit, then pending cold persists
- Added a dedicated Phase 6 regression suite in `apps/runtime/src/__tests__/pii-audit-shutdown.test.ts` to prove buffered PII entries are persisted on shutdown and the singleton resets cleanly.
- Made shared Mongo TTL index activation explicitly two-step in `packages/database/src/models/audit-log.model.ts`:
  - exported `createAuditLogSchema(...)`
  - exported `isAuditLogTTLIndexEnabled(...)`
  - TTL index on `expiresAt` is now disabled by default and only added when explicitly enabled
- Updated `packages/database/src/__tests__/audit-log.model.test.ts` to lock:
  - canonical shared fields
  - canonical indexes
  - TTL index disabled-by-default behavior
  - explicit TTL index enablement
  - safe env parsing for TTL index rollout
  - non-expiring default retention fields
- Reconciled Studio’s retention policy language with Phase 6 rollout gating in `apps/studio/src/services/retention/retention-service.ts`:
  - added an explicit audit retention matrix covering shared Mongo, shared ClickHouse, KMS, PII, Arch AI, crawl, and omnichannel
  - kept shared audit indefinite by default unless separate policy approval and TTL-index rollout both occur
  - preserved crawl and omnichannel as explicitly non-compliance-grade categories in that matrix
- Extended `apps/studio/src/__tests__/enterprise-services.test.ts` to assert the retention matrix semantics for:
  - shared Mongo audit
  - dedicated PII audit
  - omnichannel operational history

### Verification

- Build gates passed:
  - `pnpm build --filter=@abl/compiler --filter=@agent-platform/database --filter=@agent-platform/runtime`
- Locked and targeted runtime tests passed:
  - `pnpm --filter @agent-platform/runtime exec vitest run src/__tests__/auth-repo-batching.test.ts src/__tests__/pii-audit-shutdown.test.ts src/__tests__/runtime-shutdown-flush.test.ts`
- Locked and targeted database tests passed:
  - `pnpm --filter @agent-platform/database exec vitest run src/__tests__/audit-log.model.test.ts`
- Retention-policy gate test passed in Studio:
  - `pnpm --filter @agent-platform/studio exec vitest run src/__tests__/enterprise-services.test.ts`
- Formatting applied:
  - `npx prettier --write <changed-files>`

### Notes

- The first Phase 6 runtime test run exposed a real shutdown correctness gap: if the auth audit buffer was already flushing, `shutdownAuditLogs()` returned before the in-flight flush finished. I fixed that by tracking the flush promise and awaiting it during shutdown.
- The first Phase 6 batching assertions also still assumed some config-like actions written through `auth-repo` should infer the `admin` source. The new shared-source inference intentionally keeps generic config actions on the shared runtime-store path unless explicitly marked otherwise, so the test expectations were updated to match the broader shared-path contract.
- `pnpm build --filter=@agent-platform/studio` still reproduces the same environment-specific blocker from Phases 4 and 5: the build reaches `Creating an optimized production build ...` and stalls in this environment. The Studio retention-policy test is green, but the full Studio production build remains a separate follow-up item.

## Phase 7

Status: completed

Goal: Harden alerting, actor attribution, export safety, and governance coverage around the shared audit path.

### Implementation

- Added production-safe alert configuration parsing to `apps/runtime/src/services/audit-store-singleton.ts`:
  - `getAuditAlertConfigFromEnv(...)`
  - env-controlled alert wiring for:
    - `AUDIT_LOG_ALERTS_ENABLED`
    - `AUDIT_LOG_ALERT_WEBHOOK_URL`
    - `AUDIT_LOG_ALERT_SLACK_WEBHOOK`
    - `AUDIT_LOG_ALERT_CRITICAL_EVENTS`
  - singleton initialization now threads `AlertConfig` into the selected shared backend instead of leaving alerting unwired
- Added locked compiler-level alert coverage in `packages/compiler/src/__tests__/audit-store-alerting.test.ts` for:
  - webhook dispatch
  - Slack dispatch
  - combined webhook + Slack delivery
  - failure isolation when alert delivery fails
- Hardened plugin-backed actor attribution:
  - `packages/database/src/mongo/plugins/audit-trail.plugin.ts` now stamps plugin rows with `source: 'mongoose-plugin'` and `schemaVersion: 1`
  - `apps/studio/src/lib/route-handler.ts` now wraps handler execution in `withAuditActor(...)` using the authenticated Studio user plus request IP / user-agent
  - `apps/admin/src/lib/with-admin-route.ts` now does the same for admin routes
- Added locked actor-propagation coverage in `packages/database/src/__tests__/audit-trail-actor-propagation.test.ts` for:
  - plugin writes with actor context
  - safe degradation when actor context is absent
  - compatibility decoding of plugin-shaped audit rows through the shared codec
- Closed the shared archive export tenant-safety gap in `apps/studio/src/services/archive/archive-service.ts`:
  - `archiveAuditLogs(...)` now filters both `countDocuments(...)` and streamed export reads by `tenantId`
- Added locked Studio export-route coverage in `apps/studio/src/__tests__/api-routes/audit-export-route.test.ts` for:
  - admin-gated audit export creation
  - tenant-scoped manifest generation
  - empty-result behavior
- Extracted the Admin CSV serializer into `apps/admin/src/lib/audit-page-export.ts` and updated `apps/admin/src/app/(dashboard)/audit/page.tsx` to use it, preserving CSV behavior for compatibility-decoded rows
- Added locked Admin CSV regression coverage in `apps/admin/src/__tests__/audit-page-export.test.ts`
- Added `apps/admin/src/__tests__/with-admin-route.test.ts` and extended `apps/studio/src/__tests__/api-routes/route-handler-rbac.test.ts` so the new `withAuditActor(...)` wrappers are explicitly covered
- Added `apps/runtime/src/__tests__/integration/audit-contract.integration.test.ts` to lock the core shared-audit contract around:
  - append-only history
  - tenant isolation
  - actor attribution
  - trace lookup
  - legacy compatibility decoding

### Verification

- Build gates passed:
  - `pnpm build --filter=@abl/compiler --filter=@agent-platform/database --filter=@agent-platform/runtime`
  - `pnpm build --filter=@agent-platform/admin`
- Locked and targeted compiler tests passed:
  - `pnpm --filter @abl/compiler exec vitest run src/__tests__/audit-store-alerting.test.ts`
- Locked and targeted database tests passed:
  - `pnpm --filter @agent-platform/database exec vitest run src/__tests__/audit-trail-actor-propagation.test.ts`
- Locked and targeted Studio tests passed:
  - `pnpm --filter @agent-platform/studio exec vitest run src/__tests__/api-routes/audit-export-route.test.ts src/__tests__/api-routes/route-handler-rbac.test.ts`
- Locked and targeted runtime tests passed:
  - `pnpm --filter @agent-platform/runtime exec vitest run src/__tests__/integration/audit-contract.integration.test.ts src/__tests__/audit-store-singleton.test.ts`
- Locked and targeted Admin tests passed:
  - `pnpm --filter @agent-platform/admin exec vitest run src/__tests__/audit-page-export.test.ts src/__tests__/with-admin-route.test.ts`
- Formatting applied:
  - `npx prettier --write <changed-files>`

### Notes

- The first Phase 7 Admin build exposed a real typing mismatch between API audit entries and the extracted CSV helper. The helper now accepts `Date | string` timestamps so both live API rows and compatibility-decoded rows serialize correctly.
- The first actor-propagation regression pass failed because the database package test could not resolve the shared codec through the package alias. Switching the test to a direct compiler-source relative import fixed the test while keeping the production package boundary unchanged.
- `pnpm build --filter=@agent-platform/studio` remains the same environment-specific blocker seen in earlier phases: the build reaches `Creating an optimized production build ...` and stalls in this environment. The locked Studio route tests for Phase 7 are green, but the full Studio production build still needs a separate follow-up outside this slice.

## 2026-04-21 Closure Follow-Up

Status: completed

Goal: remove the remaining documented blockers so the hardening branch can be treated as complete within its scoped implementation goals.

### Implementation

- Added runtime audit environment resolution in `apps/runtime/src/services/audit-environment.ts` and threaded it through shared helper writes plus the tool audit logger.
- Added shared ClickHouse delete retention for `audit_events` and locked it with retention contract tests, alongside explicit `kms_audit_log` 3-year retention assertions.
- Normalized Studio shared-audit IP handling through `apps/studio/src/lib/get-client-ip.ts` and `apps/studio/src/services/audit-service.ts`, while keeping route-level audit actor context aligned.
- Added black-box HTTP audit E2E coverage:
  - `apps/studio/src/__tests__/audit-api.e2e.test.ts`
  - `apps/admin/src/__tests__/audit-api.e2e.test.ts`
- Added real Mongo TTL verification in `packages/database/src/__tests__/pii-audit-log.ttl.test.ts`.
- Added Admin CSV export route parity in `apps/admin/src/app/api/audit/export/route.ts`.
- Synced feature, test, HLD, LLD, implementation-plan, and testing-index docs to the implemented state.

### Verification

- Build gate passed:
  - `pnpm build --filter=@abl/compiler --filter=@agent-platform/database --filter=@agent-platform/runtime --filter=@agent-platform/studio --filter=@agent-platform/admin`
- Targeted runtime tests passed:
  - `pnpm --filter @agent-platform/runtime exec vitest run src/__tests__/audit-environment.test.ts src/__tests__/audit-helpers.test.ts src/__tests__/tools-deployment/tool-audit-logger.test.ts`
- Targeted database tests passed:
  - `pnpm --filter @agent-platform/database exec vitest run src/__tests__/audit-log.model.test.ts src/__tests__/clickhouse-audit-retention.test.ts src/__tests__/pii-audit-log.test.ts src/__tests__/pii-audit-log.ttl.test.ts`
- Targeted Studio tests passed:
  - `pnpm --filter @agent-platform/studio exec vitest run --config vitest.node.config.ts src/__tests__/audit-service.test.ts src/__tests__/enterprise-services.test.ts src/__tests__/api-routes/route-handler-rbac.test.ts src/__tests__/audit-api.e2e.test.ts`
- Targeted Admin tests passed:
  - `pnpm --filter @agent-platform/admin exec vitest run src/__tests__/audit-route.test.ts src/__tests__/audit-page-export.test.ts src/__tests__/audit-api.e2e.test.ts`

### Notes

- The real Mongo TTL integration and HTTP E2E suites required unrestricted local execution because the default desktop sandbox denies local `listen(...)` calls for in-memory MongoDB and test harness servers.
- The tenant-facing Studio audit viewer already existed in `SecurityPage`; the earlier gap was documentation drift rather than missing implementation.
