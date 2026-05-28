# Feature Spec: Configuration Management

- **Feature ID**: #45
- **Status**: PLANNED
- **Owner**: Platform Team
- **Created**: 2026-03-22
- **Last Updated**: 2026-03-22

---

## 1. Problem Statement

The ABL platform currently manages configuration across multiple fragmented layers:

1. **Static Zod schemas** in `packages/config/` validated at startup but not dynamically updatable.
2. **Tenant config services** duplicated in both `apps/runtime/src/services/tenant-config.ts` and `apps/studio/src/services/tenant-config.ts` with divergent capabilities (runtime has Redis caching, DB resolution, project overrides; studio has only in-memory plan defaults).
3. **Environment variables** managed per-project via `apps/runtime/src/routes/environment-variables.ts` with encryption, but no centralized visibility across projects.
4. **Admin config** exposed read-only through `apps/admin/src/app/api/config/route.ts` with vault overlay but no mutation API (mutations require GitOps).
5. **Feature flags** have no first-class system -- the only concrete evidence is the recent removal of the ad-hoc `AUTH_PROFILE_ENABLED` env flag, which had been managed manually through environment variables and code branches.
6. **Project-level runtime config** (`ProjectRuntimeConfig` model) and **config variables** (`ProjectConfigVariable` model) exist but lack a unified query/mutation API with proper audit logging, versioning, and rollback.

This fragmentation leads to:

- Configuration drift between environments (dev/staging/prod)
- No audit trail for who changed what configuration and when
- No ability to do canary rollouts of configuration changes
- Feature flag management is ad-hoc (env vars, code branches)
- No configuration validation before propagation to running services
- Runtime service restarts required for most config changes

## 2. Scope

### 2.1 In Scope

- **FR-001**: Unified Configuration API -- single REST API surface for reading and writing platform, tenant, and project configurations with tenant/project isolation.
- **FR-002**: Configuration Hierarchy -- layered resolution: platform defaults -> tenant overrides -> project overrides -> environment-specific overrides, with clear precedence rules.
- **FR-003**: Feature Flag System -- first-class feature flags with typed values (boolean, string, number, JSON), targeting rules (tenant, project, percentage rollout, user cohort), and kill switches.
- **FR-004**: Configuration Versioning -- every config change creates a versioned snapshot, enabling diff, rollback to any prior version, and audit trail.
- **FR-005**: Real-time Configuration Propagation -- config changes propagate to running services without restart via Redis pub/sub + ConfigWatcher integration (existing `packages/config/src/watcher.ts`).
- **FR-006**: Configuration Validation -- Zod schema validation before persisting any change; dry-run mode for validating proposed changes without applying them.
- **FR-007**: Audit Logging -- every configuration read (for sensitive paths) and write is logged with actor, timestamp, old/new values (sensitive values masked), and request context.
- **FR-008**: Environment Management -- configuration scoped per environment (dev, staging, prod, test), with promotion workflows (copy config from one env to another with diff preview).
- **FR-009**: Admin Dashboard Integration -- extend `apps/admin/` with configuration management UI: browse, search, edit, diff, rollback, feature flag management.
- **FR-010**: Configuration Import/Export -- JSON/YAML export of full configuration snapshots for environment seeding, disaster recovery, and GitOps integration.

### 2.2 Out of Scope

- **Secret management**: Handled by existing vault providers (`packages/config/src/vault/`). This feature manages non-secret configuration.
- **Environment variable encryption**: Already implemented in the env-vars route with AES-256-GCM.
- **Sizing calculator**: Separate concern (`packages/sizing-calculator/`).
- **i18n configuration**: Managed by `packages/i18n/`.
- **ABL DSL configuration syntax**: Compile-time `{{config.KEY}}` resolution remains in the compiler.
- **Infrastructure provisioning**: Terraform/Helm configuration in `abl-platform-infra` and `abl-platform-deploy` repos.

### 2.3 Dependencies

| Dependency                              | Package                                      | Status                      |
| --------------------------------------- | -------------------------------------------- | --------------------------- |
| Config package (schemas, loader, vault) | `packages/config/`                           | Existing                    |
| Tenant config service (runtime)         | `apps/runtime/src/services/tenant-config.ts` | Existing, to extend         |
| Database models                         | `packages/database/`                         | Existing, new models needed |
| Redis pub/sub                           | `packages/redis/`                            | Existing                    |
| Admin dashboard                         | `apps/admin/`                                | Existing, to extend         |
| Audit logging                           | `apps/runtime/src/repos/auth-repo.ts`        | Existing                    |
| Auth middleware                         | `packages/shared-auth/`                      | Existing                    |

## 3. User Stories

### US-001: Platform Admin Views All Configuration

**As a** platform administrator, **I want to** view all configuration values across environments with their effective resolution chain, **so that** I can understand what configuration is active and where each value comes from.

**Acceptance Criteria:**

- Can browse configuration by category (platform, tenant, project)
- Each value shows its source (default, tenant override, project override)
- Sensitive values are masked; requires explicit "reveal" action with audit log
- Supports filtering by environment (dev/staging/prod)

### US-002: Platform Admin Manages Feature Flags

**As a** platform administrator, **I want to** create, toggle, and target feature flags without code deployments, **so that** I can control feature rollouts and quickly disable problematic features.

**Acceptance Criteria:**

- Can create boolean/string/number/JSON feature flags
- Can set targeting rules: all tenants, specific tenants, percentage rollout
- Changes take effect within 30 seconds without service restart
- Kill switch instantly disables a flag across all targets
- Audit log records all flag changes with before/after values

### US-003: Tenant Admin Manages Tenant Configuration

**As a** tenant administrator, **I want to** view and override configuration values for my tenant within plan limits, **so that** I can customize the platform behavior for my organization.

**Acceptance Criteria:**

- Can only modify values allowed by their plan tier
- Cannot exceed plan limits (e.g., FREE cannot set maxAgentsPerProject > 3)
- Changes are validated against Zod schemas before applying
- Cross-tenant access returns 404 (not 403)
- Changes propagate to running services within 30 seconds

### US-004: Developer Promotes Configuration Between Environments

**As a** developer, **I want to** compare configuration between environments and promote changes from dev to staging to prod, **so that** configuration is consistent across environments.

**Acceptance Criteria:**

- Side-by-side diff view between any two environments
- Selective promotion (choose which keys to promote)
- Dry-run validation before promotion
- Promotion creates audit log entry with diff summary
- Blocked if target environment has schema validation errors

### US-005: Developer Rolls Back Configuration

**As a** developer, **I want to** view configuration change history and roll back to any previous version, **so that** I can quickly recover from bad configuration changes.

**Acceptance Criteria:**

- Configuration history shows all changes with actor, timestamp, diff
- Can roll back to any previous version with one action
- Rollback creates a new version (not destructive rewrite of history)
- Rollback validates the target version against current schema
- Post-rollback, changes propagate within 30 seconds

### US-006: System Enforces Configuration Validation

**As a** platform operator, **I want** all configuration changes to be validated against schemas before being applied, **so that** invalid configuration cannot break running services.

**Acceptance Criteria:**

- Zod schema validation runs on every config write
- Dry-run endpoint validates without persisting
- Schema migration support: new fields with defaults do not break existing configs
- Validation errors return structured error responses with path, expected type, received value

## 4. Functional Requirements

| ID     | Requirement                                                                   | Priority | Story          |
| ------ | ----------------------------------------------------------------------------- | -------- | -------------- |
| FR-001 | Unified Configuration API with CRUD operations scoped by tenant/project       | P0       | US-001         |
| FR-002 | Configuration hierarchy: platform -> tenant -> project -> env with precedence | P0       | US-001, US-003 |
| FR-003 | Feature flag system with typed values and targeting rules                     | P0       | US-002         |
| FR-004 | Configuration versioning with immutable snapshots                             | P0       | US-005         |
| FR-005 | Real-time propagation via Redis pub/sub (< 30s latency)                       | P1       | US-003, US-005 |
| FR-006 | Zod schema validation with dry-run mode                                       | P0       | US-006         |
| FR-007 | Audit logging for all config reads (sensitive) and writes                     | P0       | US-001, US-002 |
| FR-008 | Environment management with diff and promotion workflows                      | P1       | US-004         |
| FR-009 | Admin dashboard UI for configuration management                               | P1       | US-001, US-002 |
| FR-010 | Configuration import/export (JSON/YAML)                                       | P2       | US-004         |

## 5. Non-Functional Requirements

| ID      | Requirement                    | Target                                              |
| ------- | ------------------------------ | --------------------------------------------------- |
| NFR-001 | Config read latency (cached)   | < 5ms (p99)                                         |
| NFR-002 | Config read latency (uncached) | < 50ms (p99)                                        |
| NFR-003 | Config write latency           | < 200ms (p99)                                       |
| NFR-004 | Propagation latency            | < 30 seconds                                        |
| NFR-005 | Config version retention       | 90 days minimum                                     |
| NFR-006 | Concurrent config readers      | 10,000+ per pod                                     |
| NFR-007 | API availability               | 99.9% (config reads must not block agent execution) |
| NFR-008 | Feature flag evaluation        | < 1ms per flag (hot path in agent execution)        |

## 6. Existing Code Inventory

| Component                   | Location                                                        | Relevance                                                |
| --------------------------- | --------------------------------------------------------------- | -------------------------------------------------------- |
| Config package              | `packages/config/src/`                                          | Core schemas, loader, vault, watcher, sealer             |
| Tenant config types         | `packages/config/src/tenant-config-types.ts`                    | Plan, TenantLimits, TenantFeatures, TenantSecurityConfig |
| Runtime tenant config       | `apps/runtime/src/services/tenant-config.ts`                    | Redis-cached, DB-backed, plan-based resolution           |
| Studio tenant config        | `apps/studio/src/services/tenant-config.ts`                     | Simplified in-memory version                             |
| Env variables route         | `apps/runtime/src/routes/environment-variables.ts`              | CRUD with encryption, per-project                        |
| Admin config API            | `apps/admin/src/app/api/config/route.ts`                        | Read-only config with vault overlay                      |
| Admin tenant config API     | `apps/admin/src/app/api/tenant-config/route.ts`                 | Proxy to runtime                                         |
| Config watcher              | `packages/config/src/watcher.ts`                                | Poll-based change detection                              |
| Config diff                 | `packages/config/src/validation/config-diff.ts`                 | Deep object diff with sensitive masking                  |
| Config sealer               | `packages/config/src/sealer.ts`                                 | Deep freeze / read-only proxy                            |
| Config loader               | `packages/config/src/loader.ts`                                 | Zod validation, vault integration, reload                |
| ProjectRuntimeConfig model  | `packages/database/src/models/project-runtime-config.model.ts`  | Per-project runtime settings                             |
| ProjectConfigVariable model | `packages/database/src/models/project-config-variable.model.ts` | Per-project key-value config                             |
| Tenant model                | `packages/database/src/models/tenant.model.ts`                  | LLM policy, settings, retention                          |
| Auth profile flag removal   | `packages/shared/src/services/auth-profile/dual-read.ts`        | Evidence of an ad-hoc env-flag pattern being retired     |

## 7. Risks and Mitigations

| Risk                                                   | Likelihood | Impact | Mitigation                                                         |
| ------------------------------------------------------ | ---------- | ------ | ------------------------------------------------------------------ |
| Config change breaks running services                  | Medium     | High   | Schema validation + dry-run + rollback within 30s                  |
| Cache inconsistency between pods                       | Medium     | Medium | Redis pub/sub invalidation with TTL fallback                       |
| Feature flag evaluation latency impacts agent response | Low        | High   | In-memory cache with background refresh; < 1ms target              |
| Migration from scattered config to unified system      | High       | Medium | Incremental migration: new API wraps existing services first       |
| Audit log volume for high-traffic flag evaluations     | Medium     | Low    | Only log writes and sensitive reads; flag evaluations use counters |

## 8. Success Metrics

| Metric                                           | Baseline               | Target                |
| ------------------------------------------------ | ---------------------- | --------------------- |
| Config-related incidents (wrong config deployed) | ~2/month               | 0/month               |
| Time to toggle feature flag                      | Minutes (code deploy)  | < 30 seconds          |
| Config environments in sync                      | Manual verification    | Automated diff alerts |
| Config change audit coverage                     | ~20% (env vars only)   | 100%                  |
| Mean time to rollback bad config                 | 10+ minutes (redeploy) | < 1 minute            |

## 9. Open Questions

| #    | Question                                                                       | Status  | Decision                                                                   |
| ---- | ------------------------------------------------------------------------------ | ------- | -------------------------------------------------------------------------- |
| OQ-1 | Should config changes require approval workflows for production?               | DECIDED | No for v1; add in v2 as optional governance layer                          |
| OQ-2 | Should feature flags support A/B testing with metrics?                         | DECIDED | Out of scope for v1; flags are boolean/targeting only                      |
| OQ-3 | Should the unified config API replace or wrap existing tenant-config services? | DECIDED | Wrap first (backward compatible), then migrate callers incrementally       |
| OQ-4 | How should config schema evolution be handled (adding/removing fields)?        | DECIDED | Zod schemas with `.default()` for new fields; removal requires migration   |
| OQ-5 | Should config propagation use Redis pub/sub or polling?                        | DECIDED | Redis pub/sub for instant notification + ConfigWatcher polling as fallback |
