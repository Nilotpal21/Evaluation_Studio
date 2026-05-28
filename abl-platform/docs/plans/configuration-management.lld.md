# Configuration Management — Low-Level Design

## Implementation Structure

Configuration Management is implemented across 4 key files: the TenantConfigService (resolution + caching), feature gate middleware (entitlement enforcement), project runtime config routes (per-project settings), and admin config routes (override management). All share types from `@agent-platform/config`.

## Key Files

| File                                                | Purpose                                                                                                                                                                                                                                                                       |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/runtime/src/services/tenant-config.ts`        | `TenantConfigService`: resolve(tenantId), setOverrides(), invalidateCache(). Constants: `PLAN_LIMITS` (4 tiers x 16 quota fields), `PLAN_FEATURES` (4 tiers x 10 feature flags), `DEFAULT_SECURITY` (4 tiers x 8 security settings). Redis cache: `cfg:{tenantId}`, TTL 300s. |
| `apps/runtime/src/middleware/feature-gate.ts`       | `requireFeature(featureName)` — fail-open Express middleware. Resolves features from Deal + Subscription. `createModuleFeatureGate(featureName)` — fail-closed alternative. `PLAN_FEATURES` re-exported from `@agent-platform/shared-kernel`.                                 |
| `apps/runtime/src/routes/project-runtime-config.ts` | GET/PUT for per-project runtime config. Zod schemas: extractionConfigSchema, multiIntentConfigSchema, inferenceConfigSchema, conversionConfigSchema, piiRedactionConfigSchema, pipelineConfigSchema. Defaults: `PLATFORM_DEFAULTS`.                                           |
| `apps/runtime/src/routes/platform-admin-config.ts`  | Admin CRUD: GET /plans, GET /:tenantId (resolved), PUT/DELETE /:tenantId/overrides, PUT/DELETE /:tenantId/projects/:projectId/overrides. Uses `getTenantConfigService()` + `PLAN_LIMITS`. Redis cache invalidation + audit logging on mutations.                              |
| `@agent-platform/config`                            | Shared types: `Plan`, `TenantLimits`, `TenantFeatures`, `TenantSecurityConfig`, `TenantConfig`                                                                                                                                                                                |

### Plan Defaults (Key Values)

| Quota                 | FREE | TEAM | BUSINESS | ENTERPRISE     |
| --------------------- | ---- | ---- | -------- | -------------- |
| maxConcurrentSessions | 5    | 50   | 500      | -1 (unlimited) |
| maxAgentsPerProject   | 3    | 20   | 100      | -1             |
| requestsPerMinute     | 60   | 300  | 1,000    | 5,000          |
| tokensPerMinute       | 50K  | 200K | 500K     | -1             |
| messagesPerMonth      | 1K   | 50K  | 500K     | -1             |
| traceRetentionDays    | 7    | 30   | 90       | 365            |

### Feature Flags (10 flags)

| Flag              | FREE  | TEAM  | BUSINESS | ENTERPRISE |
| ----------------- | ----- | ----- | -------- | ---------- |
| customModels      | false | true  | true     | true       |
| ssoEnabled        | false | false | true     | true       |
| mfaEnabled        | false | true  | true     | true       |
| auditLogExport    | false | false | true     | true       |
| dataResidency     | false | false | false    | true       |
| customDomains     | false | false | true     | true       |
| prioritySupport   | false | false | true     | true       |
| advancedAnalytics | false | false | true     | true       |
| advancedNlu       | false | false | false    | true       |
| archiveEnabled    | false | false | true     | true       |

### Resolution Chain

1. `PLAN_LIMITS[planTier]` + `PLAN_FEATURES[planTier]` + `DEFAULT_SECURITY[planTier]` -- base
2. `Subscription.tenantQuotas` -- per-tenant overrides (admin-set)
3. Tenant model settings -- per-tenant model config
4. In-memory overrides -- ephemeral (testing/debugging)
5. Project-level overrides via `resolveEffectiveLimits()` -- per-project

### Project Runtime Config Defaults

```
PLATFORM_DEFAULTS = {
  extraction: { strategy: 'auto', correction_detection: 'ml', sidecar_timeout_ms: 500, ... },
  multi_intent: { enabled: true, strategy: 'primary_queue', max_intents: 3, ... },
  inference: { confidence: 0.8, confirm: true, model_tier: 'fast', ... },
  conversion: { currency_mode: 'static' },
  pii_redaction: { enabled: true, redact_input: true, redact_output: false },
}
```

## Test Files

| File                                                                 | Scenarios                                                                                               |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `apps/runtime/src/__tests__/platform-admin-config.test.ts`           | 9 scenarios: plan defaults, resolved config, overrides CRUD, validation, project overrides, auth, audit |
| `apps/runtime/src/middleware/__tests__/feature-gate-modules.test.ts` | Module-level feature gating                                                                             |

## Known Gaps

| ID      | Gap                                       | Severity | Notes                                   |
| ------- | ----------------------------------------- | -------- | --------------------------------------- |
| GAP-001 | No unit tests for TenantConfigService     | Medium   | Core resolve chain untested             |
| GAP-002 | No test for Redis cache hit/miss/TTL      | Medium   | Performance path untested               |
| GAP-003 | No test for feature gate fail-open/closed | Medium   | Error handling behavior untested        |
| GAP-004 | No test for project runtime config routes | Medium   | GET/PUT endpoints untested              |
| GAP-005 | No E2E test for plan-based feature gating | High     | Critical governance untested end-to-end |
