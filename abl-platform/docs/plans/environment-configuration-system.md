# Environment Configuration System

## Problems & Solutions

The platform has 5 deployment targets (local dev, dev/staging K8s, private VPC, customer-specific SaaS, multi-region production) but config management is ad-hoc. Below are the 9 concrete problems, what goes wrong because of each, and the implemented solution.

### Problem 1: 34 direct `process.env` reads bypass the typed config system

**What goes wrong**: `server.ts` has lines like `process.env.MONGODB_URL || 'mongodb://localhost:27017'`. These hardcoded defaults drift from environment defaults. New developers copy-paste the pattern. No validation runs on these values. A typo in a K8s Secret name silently falls through to the hardcoded default, and the service connects to localhost instead of the production cluster.

**Solution**: Every env var read goes through `mapEnvToConfig()` with a declarative mapping. The `BASE_ENV_MAPPING` + per-app mapping covers all 300+ env vars. An ESLint rule blocks new `process.env` outside config entry points. The `EnvProvider` is filtered to an allowlist — `getAll()` only returns vars in `BASE_ENV_MAPPING`, preventing accidental leakage of unrelated env vars (like `AWS_SECRET_ACCESS_KEY` from CI).

### Problem 2: No environment-specific config files

**What goes wrong**: Every deployment target gets the same defaults. Dev has production-strict timeouts. Staging has dev-relaxed CORS. Engineers manually set 40+ env vars per environment. When a new required var is added, every environment's K8s Secrets must be updated — but there's no checklist, so staging gets missed and breaks on the next deploy.

**Solution**: JSON files in `packages/config/environments/` provide layered defaults:

```
base.json → dev.json → (optional) regions/eu-west-1.json
```

These are baked into the Docker image at build time. The loader merges layers in order: base → environment → region. Env vars and Vault secrets override these defaults. Customer-specific config is loaded from MongoDB post-boot (Phase C), not from files. A `generate-env-template.ts` script auto-generates `.env.template` from Zod schemas so templates never drift.

### Problem 3: No config versioning — no schema version, no config hash for rollback

**What goes wrong**: After deploying v2.3.1, you realize it introduced a regression and want to rollback to v2.3.0. But v2.3.0's config schema expects a field that was renamed in v2.3.1. The rollback succeeds (Helm reverts the image tag) but the service crashes because the ConfigMap still has the new field name. There's no way to know, before rolling back, whether the old schema is compatible with the current config state.

**Solution**: Every Docker image embeds a `BUILD_MANIFEST` with `productVersion`, `buildHash`, `buildTimestamp`, and `configSchemaVersion`. On startup, the service validates that the running config schema version is compatible with the build manifest. A deterministic SHA-256 config hash (sensitive fields excluded) is computed and stored in `ConfigMeta`. The hash enables drift detection: if the hash changes without a redeployment, something mutated the config.

### Problem 4: No cross-service validation

**What goes wrong**: Studio is configured with `RUNTIME_URL=http://localhost:3112` but Runtime is listening on port 3113 (someone changed it in the Helm values). Studio's HTTP calls to Runtime fail with connection refused. Or: Runtime generates JWT tokens with `JWT_SECRET=abc` but Studio validates them with `JWT_SECRET=xyz` (different K8s Secrets). Users get "invalid token" errors. Both bugs take hours to diagnose because nothing checks consistency across services.

**Solution**: `validateCrossServiceConfig()` loads all service configs and checks:

- JWT secret identical across all services
- MongoDB host identical (prevents split-brain)
- Redis host identical
- Studio's runtime URL port matches Runtime's actual port

This runs in CI (every commit) and at startup (as part of Tier 2 validation). Mismatches block deployment.

### Problem 5: No feature flag system

**What goes wrong**: Feature flags are scattered `FEATURE_*` env vars with no per-tenant or per-environment awareness. Enabling voice for one tenant means setting `FEATURE_VOICE_ENABLED=true` globally. There's no way to enable a feature for staging without enabling it in production too (same env var). Per-tenant feature rollout requires code changes.

**Solution**: Extend existing `TenantFeatures` with environment-level defaults instead of building a new system. Resolution chain: environment defaults (from `dev.json`/`staging.json`/`production.json`) → tenant plan features → per-tenant overrides (from MongoDB). Existing `FEATURE_*` vars continue to work during migration as the top-level override.

### Problem 6: No config drift detection

**What goes wrong**: An operator updates a K8s ConfigMap to change a Redis URL. The running pods still have the old config in memory. New pods get the new config. The fleet is now split-brained: some pods talk to old Redis, some to new Redis. Nobody notices until data inconsistency reports come in.

**Solution**: `ConfigWatcher` polls for hash changes and triggers atomic reloads. The reload uses double-buffer swap (new config loaded first, then reference swapped — config is never null). An `isReloading` flag prevents concurrent reloads. Exponential backoff (up to 5 minutes) prevents hammering a down Vault. Prometheus metrics (`config_drift_detected_total`, `config_reload_duration_seconds`) emit on every check.

### Problem 7: Vault provider lacks production-grade auth/rotation

**What goes wrong**: The Vault provider requires a static `VAULT_TOKEN` env var. In K8s, this token is stored in a Secret. When the token expires, the service can't re-authenticate — it just keeps serving stale cached secrets. There's no lease tracking, no rotation, no K8s service account auth. The cache has no TTL, so if Vault is sealed for maintenance, the service runs on stale secrets indefinitely with no alert.

**Solution**: `HashiCorpVaultProvider` now supports:

- **K8s auth**: Reads SA JWT from `/var/run/secrets/...`, exchanges for Vault token via `POST /v1/auth/kubernetes/login`, refreshes every 60s
- **Cache TTL**: Default 1 hour. On expiry, force re-fetch. If Vault unreachable, serve stale + emit alert
- **Lease tracking**: Extracts `lease_duration` from Vault response, forces re-fetch when lease expires
- **TLS**: `VAULT_CACERT` for custom CA, HTTPS enforcement in production, `VAULT_SKIP_VERIFY` for dev only
- **Composite provider resilience**: Throws if ALL providers fail (instead of silently returning empty), tracks succeeded/failed providers

### Problem 8: No degraded mode — service crashes or serves stale data

**What goes wrong**: Vault goes down during a network partition. The service either crashes (if validation is strict) or silently serves stale config (if validation is relaxed). WebSocket clients stay connected receiving stale data. There's no health signal to the load balancer, no client notification, no auto-recovery.

**Solution**: `DegradedModeManager` implements a state machine:

- **Trigger**: Startup validation failure (Vault unreachable, DB down, schema incompatible)
- **While degraded**: `/health` returns 503, new WebSocket connections rejected, active WebSockets closed with code 1013 ("try again later"), background job dispatch paused
- **Revalidation**: Every 30s, re-run all checks. If all pass, auto-exit degraded mode
- **Max duration**: After 5 minutes degraded, emit critical alert and stop revalidation timer (prevents infinite polling of a permanently-down dependency)

### Problem 9: Config reload race condition

**What goes wrong**: `reloadConfig()` sets `config = null` before loading the new config. Any request that calls `getConfig()` during that 50-200ms window gets a "Configuration not loaded" error and returns 500 to the user. If the reload itself fails (Vault timeout), config stays null permanently until the next reload attempt. Meanwhile, the watcher has no guard against concurrent reloads — if a reload takes longer than the poll interval, a second reload fires and they race.

**Solution**: Atomic swap with double-buffer pattern. The new config is loaded into a temp variable first. Only after successful load + validation does the reference swap. If the load fails, the old config, meta, and provider are all restored. The watcher has an `isReloading` flag that skips the poll cycle if a previous reload is still in-flight, with a `finally` block to guarantee reset.

---

## Current State (What Already Exists)

The `@agent-platform/config` package has a strong foundation:

| Component                  | Status       | Location                                                              |
| -------------------------- | ------------ | --------------------------------------------------------------------- |
| Zod schema validation      | **Complete** | `schemas/base-app.schema.ts` — 16 composable sub-schemas              |
| Composable per-app schemas | **Complete** | `compose.ts` — runtime/studio extend base                             |
| Vault provider abstraction | **Complete** | `vault/` — 7 providers (Env, File, Vault, AWS, Azure, K8s, Composite) |
| Production validation      | **Complete** | `validation/production-checks.ts` — blocks insecure defaults          |
| Config diff with redaction | **Complete** | `validation/config-diff.ts`                                           |
| Config watcher (polling)   | **Complete** | `watcher.ts` — concurrency guard + exponential backoff                |
| Config sealer (immutable)  | **Complete** | `sealer.ts` — deepFreeze in prod                                      |
| Tenant config (plan-based) | **Complete** | `apps/runtime/src/services/tenant-config.ts`                          |
| Config hash                | **Complete** | `version/config-hash.ts` — deterministic SHA-256                      |
| Degraded mode manager      | **Complete** | `health/degraded-mode.ts` — state machine with revalidation           |
| Cross-service validation   | **Complete** | `validation/cross-service.ts` — JWT, DB, Redis consistency            |
| URL safety validation      | **Complete** | `validation/url-safety.ts` — SSRF protection                          |
| Deployment identity schema | **Complete** | `schemas/deployment-identity.schema.ts` — 4 fields + build manifest   |
| Observability metrics      | **Complete** | `observability/metrics.ts` — metric definitions + noop emitter        |
| Environment defaults       | **Complete** | `environments/*.json` — base, dev, staging, production, 3 regions     |

---

## Architecture

```
                         CONFIG SOURCES
         ┌──────────────────────────────────────────┐
         │  Local Dev:    .env files                 │
         │  Dev/Staging:  K8s ConfigMaps + Vault     │
         │  Private VPC:  Customer Vault + K8s       │
         │  SaaS Prod:    Vault (primary) + K8s      │
         └──────────┬───────────────────────────────┘
                    │
                    ▼
         ┌─────────────────────────────────┐
         │   CompositeVaultProvider         │
         │   (auto-configured chain)        │
         │   1. Vault (HashiCorp/AWS/Azure) │
         │   2. K8s Secret volumes          │
         │   3. Environment variables       │
         │   4. File provider (.env)        │
         └──────────┬──────────────────────┘
                    │
                    ▼
         ┌─────────────────────────────────┐
         │   Config Loader Pipeline         │
         │                                  │
         │   ① Environment defaults (JSON)  │
         │   ② Vault secrets (merged)       │
         │   ③ Zod schema validation        │
         │   ④ Production safety checks     │
         │   ⑤ Schema version compatibility │
         │   ⑥ Seal config (immutable)      │
         │   ⑦ Emit ConfigMeta + hash       │
         └──────────┬──────────────────────┘
                    │
         ┌──────────┴──────────┐
         ▼                     ▼
  Infrastructure Config    Tenant Runtime Config
  (sealed, per-service)    (dynamic, per-tenant)
```

---

## Config Loading: Three-Phase Boot Sequence

Config resolution is NOT a flat merge. There is a strict dependency order — you need Vault credentials before you can read secrets, and you need database credentials before you can read MongoDB. The system loads config in three explicit phases:

### Phase A: Bootstrap (env vars + JSON defaults)

**Available sources**: Environment variables (from Helm/K8s), environment JSON files (baked into Docker image)

**What gets resolved**:

- Deployment identity (`DEPLOYMENT_ENVIRONMENT`, `DEPLOYMENT_REGION`, `DEPLOYMENT_TYPE`, `CUSTOMER_ID`)
- Vault connection (`VAULT_ADDR`, `VAULT_K8S_AUTH`, `VAULT_K8S_ROLE`)
- Logging and observability (`LOG_LEVEL`, `OTEL_*`, `SENTRY_DSN`)
- Server binding (`PORT`, `HOST`, `NODE_ENV`)
- Feature flags (from env JSON defaults)
- Region and data residency settings

**What cannot be resolved yet**: Database URLs, Redis URLs, API keys, encryption keys, JWT secrets — these require Vault or are set as env vars directly.

### Phase B: Secrets (Vault + env var overrides)

**Triggered after**: Vault address and auth are available from Phase A

**Available sources**: HashiCorp Vault (via K8s auth or token), AWS Secrets Manager, Azure Key Vault, K8s Secret volumes, environment variables

**What gets resolved**:

- `DATABASE_URL`, `REDIS_URL` — infrastructure connection strings
- `JWT_SECRET`, `ENCRYPTION_MASTER_KEY` — security credentials
- `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` — LLM provider keys
- All other secret/infrastructure values

**After this phase**: Zod schema validation runs. Production safety checks run. Config is sealed (immutable). `getConfig()` becomes available. Startup connectivity checks run (MongoDB ping, Redis ping). If any check fails, DegradedModeManager activates.

### Phase C: Runtime Overrides (MongoDB — post-boot only)

**Triggered after**: Database connection is established from Phase B credentials

**Available sources**: MongoDB `tenant_configs` collection, MongoDB `customer_configs` collection (post-GA)

**What gets resolved**:

- Per-tenant feature flags (plan-based: FREE/TEAM/BUSINESS/ENTERPRISE)
- Per-tenant rate limits and quotas
- Per-tenant model preferences and LLM provider overrides
- Per-customer infrastructure overrides (post-GA: custom Vault paths, dedicated DB endpoints)

**What CANNOT be resolved here**: Pre-boot config (log level, Vault address, region settings, encryption keys). These must come from Phase A or B. By the time MongoDB is reachable, the service is already running with its sealed infrastructure config.

### What Each Source Provides

| Config Category             | Phase A (env + JSON) | Phase B (Vault) | Phase C (MongoDB)    |
| --------------------------- | -------------------- | --------------- | -------------------- |
| Server binding (port, host) | Yes                  | —               | —                    |
| Logging/observability       | Yes                  | —               | —                    |
| Feature flags (defaults)    | Yes                  | —               | Per-tenant overrides |
| Region/data residency       | Yes                  | —               | —                    |
| Vault connection info       | Yes (env vars only)  | —               | —                    |
| Database URLs               | —                    | Yes             | —                    |
| Redis URLs                  | —                    | Yes             | —                    |
| JWT/encryption keys         | —                    | Yes             | —                    |
| LLM API keys                | —                    | Yes             | —                    |
| Tenant rate limits          | —                    | —               | Yes                  |
| Tenant model preferences    | —                    | —               | Yes                  |
| Customer infra overrides    | —                    | —               | Yes (post-GA)        |

---

## Deployment Identity — "Who Am I?"

Every running instance must know its full identity. This isn't just `NODE_ENV=production` — it's the complete context that determines which configs, secrets, Vault paths, feature flags, and validation rules apply.

### The DeploymentIdentity Schema

```typescript
// packages/config/src/schemas/deployment-identity.schema.ts

// Runtime identity — set via Helm environment variables
export const DeploymentIdentitySchema = z.object({
  environment: z.enum(['dev', 'staging', 'production']),
  region: z.string().min(1), // "us-east-1", "eu-west-1", etc.
  deploymentType: z.enum([
    'shared-dev',
    'saas-multi-tenant',
    'saas-dedicated',
    'private-vpc',
    'on-premise',
  ]),
  customerId: z.string().optional(), // Set for dedicated/private-vpc/on-premise
  vaultPath: z.string().optional(), // Override Vault path for private-vpc/on-premise
});

// Build identity — embedded in Docker image at compile time
export const BuildManifestSchema = z.object({
  productVersion: z.string(), // "2.3.1" — from git tag
  buildHash: z.string(), // "g1h2i3j4" — monorepo commit SHA
  buildTimestamp: z.string(), // ISO 8601
  configSchemaVersion: z.string(), // "2.0.0" — from packages/config
});
```

> **Note**: Version and hash come from `BUILD_MANIFEST` (compile-time, baked into the Docker image), not from runtime environment variables. Only the 4 identity fields above are set via Helm env vars.

### How Identity Flows to Config Resolution

```
                     DEPLOYMENT_TYPE=saas-dedicated
                     CUSTOMER_ID=acme-corp
                     REGION=eu-west-1
                              │
                              ▼
              ┌───────────────────────────────┐
              │     DeploymentIdentity        │
              │                               │
              │  env: production               │
              │  region: eu-west-1             │
              │  type: saas-dedicated          │
              │  customer: acme-corp           │
              └──────────┬────────────────────┘
                         │
           ┌─────────────┼─────────────────────┐
           ▼             ▼                     ▼
    ┌──────────┐  ┌──────────────┐  ┌─────────────────┐
    │ Vault    │  │ Environment  │  │ Customer        │
    │ Path     │  │ Defaults     │  │ Overrides       │
    │          │  │              │  │                 │
    │ Derived: │  │ Derived:     │  │ Derived:        │
    │ secret/  │  │ production + │  │ MongoDB:        │
    │ data/    │  │ eu-west-1    │  │ customer_config │
    │ customers│  │ defaults     │  │ {customerId:    │
    │ /acme/   │  │              │  │  "acme-corp"}   │
    └──────────┘  └──────────────┘  └─────────────────┘
```

### Config Resolution Chain (Identity-Aware)

| Deployment Type     | Vault Path                                | Config Defaults                | Customer Overrides                                                                                                                   | Feature Flags             |
| ------------------- | ----------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------- |
| `shared-dev`        | `secret/data/abl-platform/dev/`           | `environments/dev.json`        | None                                                                                                                                 | All enabled               |
| `saas-multi-tenant` | `secret/data/abl-platform/prod/{region}/` | `environments/production.json` | Per-tenant in MongoDB (plan-based) — Phase C                                                                                         | Plan-based                |
| `saas-dedicated`    | `secret/data/customers/{customerId}/`     | `environments/production.json` | MongoDB `customer_configs` collection — Phase C. Pre-boot config via per-customer Vault KV path.                                     | Plan + customer overrides |
| `private-vpc`       | Customer Vault at `{vaultPath}`           | `environments/production.json` | Customer controls all config via their own Helm values + env vars. Post-boot overrides in MongoDB if connected to our control plane. | Customer-controlled       |
| `on-premise`        | Local Vault or file-based                 | Customer-managed               | Customer-managed entirely. Platform provides schema and defaults; customer provides all values via env vars.                         | Customer-managed          |

### Identity-to-Vault Path Mapping

```typescript
function resolveVaultBasePath(identity: DeploymentIdentity): string {
  if (identity.vaultPath) return identity.vaultPath;

  switch (identity.deploymentType) {
    case 'shared-dev':
      return `secret/data/abl-platform/dev`;
    case 'saas-multi-tenant':
      return `secret/data/abl-platform/prod/${identity.region}`;
    case 'saas-dedicated':
    case 'private-vpc':
      return identity.customerId
        ? `secret/data/customers/${identity.customerId}`
        : `secret/data/abl-platform/prod/${identity.region}`;
    case 'on-premise':
      return `secret/data/local`;
  }
}
```

### Identity-Aware Environment Defaults

```typescript
function resolveConfigLayers(identity: DeploymentIdentity): string[] {
  const layers = ['environments/base.json'];
  layers.push(`environments/${identity.environment}.json`);

  const regionFile = `environments/regions/${identity.region}.json`;
  if (existsSync(regionFile)) layers.push(regionFile);

  // Customer-specific config is loaded from MongoDB in Phase C (post-boot),
  // not from files. For private-vpc and on-premise, the customer controls
  // pre-boot config through their own Helm values and env vars.
  return layers;
}
```

### JSON Layer Boundary — What Goes Where

Environment JSON files carry **behavioral and operational defaults only**. They must NEVER contain infrastructure connection strings, secrets, or credentials. This boundary is enforced in CI.

**Allowed in JSON files** (behavioral defaults):

- Logging level, trace sampling rate
- Feature flags (enabled/disabled)
- Region metadata (name, data residency flag)
- Server settings (host binding, keepalive timeouts)
- Compression, archive settings
- Observability on/off toggles

**Rejected in JSON files** (must come from Vault or env vars):

- `database.url`, `redis.url` — infrastructure connection strings
- `jwt.secret`, `encryption.masterKey` — security credentials
- `llm.anthropicApiKey`, `llm.openaiApiKey` — API keys
- `oauth.*.clientSecret` — OAuth credentials
- Any field listed in `SENSITIVE_PATHS`

The CI script `validate-config.ts` validates that no JSON file contains fields from the restricted list. If a restricted field is found, the build fails with an actionable error message.

### How Services Discover Their Identity

Identity is set via environment variables injected by the deployment system (Helm/ArgoCD/Terraform):

```yaml
# Helm values (abl-platform-deploy repo)
deploymentIdentity:
  environment: production
  region: eu-west-1
  deploymentType: saas-dedicated
  customerId: acme-corp
  # productVersion, buildHash, configSchemaVersion are baked into Docker image at build time
```

These become env vars via Helm template:

```yaml
# templates/deployment.yaml
env:
  - name: DEPLOYMENT_ENVIRONMENT
    value: { { .Values.deploymentIdentity.environment } }
  - name: DEPLOYMENT_REGION
    value: { { .Values.deploymentIdentity.region } }
  - name: DEPLOYMENT_TYPE
    value: { { .Values.deploymentIdentity.deploymentType } }
  - name: CUSTOMER_ID
    value: { { .Values.deploymentIdentity.customerId | default "" } }
```

### Version Compatibility Matrix

```
Product v2.3.1 (config schema 2.0.0)
    │
    ├── Requires: @agent-platform/config >=2.0.0
    ├── Requires: @abl/compiler >=1.5.0 (for new IR fields)
    ├── Requires: Vault API v2 (for KV2 versioned secrets)
    └── Requires: MongoDB >=7.0 (for $merge pipeline stage)
```

On startup, each service:

1. Loads `DeploymentIdentity` from env vars
2. Loads `BUILD_MANIFEST` (compile-time)
3. Validates: `identity.configSchemaVersion` >= `BUILD_MANIFEST.configSchemaVersion`
4. Logs: full identity + build manifest to structured log
5. Reports: identity in `/admin/config` endpoint

If validation fails, service enters **degraded mode** (503, no traffic, logs mismatch) rather than crashing.

---

## Deployment Target Matrix

|                     | Local Dev        | Dev/Staging         | Private VPC          | Customer SaaS          | Production          |
| ------------------- | ---------------- | ------------------- | -------------------- | ---------------------- | ------------------- |
| **Config source**   | `.env` files     | K8s ConfigMaps      | Customer K8s + Vault | Vault + MongoDB        | Vault + K8s         |
| **Secrets**         | Plaintext `.env` | K8s Secrets + Vault | Customer Vault       | Per-tenant Vault paths | Vault with K8s auth |
| **Validation**      | Warn only        | Strict              | Strict               | Strict                 | Strict + region     |
| **Drift detection** | Off              | On (warn)           | On (warn)            | On (alert)             | On (block)          |
| **Config version**  | Any              | Must match          | Customer-managed     | Must match             | Must match          |
| **Feature flags**   | All enabled      | Per-flag defaults   | Customer overrides   | Per-tenant             | Plan-based          |

---

## File Structure

```
packages/config/
├── src/
│   ├── version/
│   │   └── config-hash.ts         # Deterministic SHA-256 config hashing
│   │
│   ├── health/
│   │   └── degraded-mode.ts       # DegradedModeManager state machine
│   │
│   ├── observability/
│   │   └── metrics.ts             # Metric definitions + noop emitter
│   │
│   ├── validation/
│   │   ├── cross-service.ts       # Cross-service consistency (URLs, shared secrets)
│   │   ├── production-checks.ts   # Production safety checks + encryption key validation
│   │   ├── url-safety.ts          # SSRF protection for outbound URLs
│   │   ├── region-checks.ts       # EU data residency validation
│   │   ├── config-diff.ts         # Config diff with redaction + array support
│   │   └── ci-validator.ts        # CI entry point: validate config per environment
│   │
│   ├── schemas/
│   │   ├── deployment-identity.schema.ts  # 4-field identity + build manifest
│   │   └── base-app.schema.ts     # 16 composable sub-schemas
│   │
│   └── vault/
│       ├── hashicorp-vault.ts     # K8s auth, cache TTL, lease tracking, TLS
│       ├── composite-provider.ts  # Multi-provider with error tracking
│       ├── env-provider.ts        # Allowlist-filtered env vars
│       ├── aws-secrets.ts         # AWS Secrets Manager
│       ├── azure-keyvault.ts      # Azure Key Vault
│       ├── k8s-secret-provider.ts # K8s secret volume mounts
│       └── file-provider.ts       # File-based (.env)
│
├── environments/                   # Non-secret defaults per environment
│   ├── base.json
│   ├── dev.json
│   ├── staging.json
│   ├── production.json
│   └── regions/
│       ├── us-east-1.json
│       ├── eu-west-1.json
│       └── ap-southeast-1.json
│
└── scripts/
    ├── validate-config.ts          # CI: validate all env configs
    ├── diff-environments.ts        # CLI: diff two environments
    └── generate-env-template.ts    # Auto-generate .env.template from Zod schema
```

---

## Implementation Phases

### Phase 1: Eliminate `process.env` Bypasses

**Goal**: Every env var access goes through the typed config system.

- Add MongoDB, ClickHouse, encryption, and feature toggle schemas to `BaseAppConfigSchema`
- Add env mappings for all 34+ direct `process.env` reads in `server.ts`
- Replace `process.env.MONGODB_URL || '...'` with `config.database.url`
- Add CI lint rule: no new `process.env` outside config entry points

### Phase 2: Environment Defaults + Template Generation

**Goal**: One source of truth per environment, auto-generated `.env` templates.

- Create `environments/{base,dev,staging,production}.json`
- Implement `resolveEnvironmentDefaults()` in the loader
- Create `generate-env-template.ts` that walks Zod schemas → `.env.template`

### Phase 3: Config Versioning + Health Reporting

**Goal**: Know exactly what config is running; detect drift.

- Implement `BUILD_MANIFEST` generation at build time (monorepo commit SHA)
- Implement deterministic config hashing (sorted keys, secrets excluded)
- Add `configSchemaVersion`, `configHash` to `ConfigMeta`
- Create `/health` (lightweight, no auth) and `/admin/config` (detailed, OWNER role, redacted) endpoints

### Phase 4: Enhanced Vault Providers

**Goal**: Production-ready secret management with rotation.

- K8s auth method (SA JWT exchange + 60s token refresh)
- Cache TTL (1h default) with stale-serve + alert
- Lease tracking and renewal
- TLS validation (VAULT_CACERT, HTTPS enforcement)
- Composite provider error tracking (throws if all fail)

### Phase 5: Cross-Service Validation + Degraded Mode + CI Pipeline

**Goal**: Catch config mistakes before deployment. Graceful failure when infrastructure is down.

- `validateCrossServiceConfig()` for JWT, DB, Redis consistency
- `DegradedModeManager` with listener pattern, revalidation, max-duration threshold
- `validate-config.ts` CI script + Harness pipeline step
- Startup validation (MongoDB, Redis, ClickHouse, Vault connectivity)

### Phase 6: Runtime Monitoring + Metrics

**Goal**: Operational visibility into config health.

- Prometheus metrics: drift count, reload duration, secret expiry, health status
- `/admin/config` endpoint with field-level redaction
- Config change audit trail in `ConfigMeta.changeHistory`

---

## Human Error Prevention

| Mechanism                                    | What It Prevents                                          |
| -------------------------------------------- | --------------------------------------------------------- |
| **Typed config** (Zod + TypeScript)          | Wrong value types, missing required fields                |
| **Environment defaults** (JSON files in git) | Copy-paste between environments                           |
| **Auto-generated templates**                 | Stale .env.example files                                  |
| **Production validation**                    | Insecure defaults, wildcard CORS, missing encryption keys |
| **Cross-service validation**                 | URL mismatches, inconsistent shared secrets               |
| **Config diff tool**                         | Unintended changes between environments                   |
| **Schema version check**                     | Running old code with new config or vice versa            |
| **Drift detection**                          | Config changed after deployment without redeployment      |
| **Sealed config**                            | Runtime mutation of config values                         |
| **Vault policies**                           | Unauthorized secret access, missing rotation              |
| **CI validation step**                       | Deploying with invalid or incomplete config               |
| **SSRF URL validation**                      | Config injection via cloud metadata endpoints             |
| **Encryption key entropy check**             | Weak/sequential/repeated-character encryption keys        |
| **EnvProvider allowlist**                    | Leaking unrelated env vars (CI secrets, AWS keys)         |

---

## Rollback Safety

```
Deployment v2.3.1 (config schema 2.0.0, hash: a1b2c3d4)
    │
    ├── Code: git tag v2.3.1
    ├── Config: environments/production.json @ commit abc123
    ├── Secrets: Vault KV version 7
    └── Meta: { productVersion: "2.3.1", configSchemaVersion: "2.0.0", configHash: "a1b2c3d4" }

Rollback to v2.3.0:
    ├── Code: git checkout v2.3.0 (includes environments/production.json from that version)
    ├── Secrets: Vault KV version 6 (Vault maintains version history)
    ├── Schema check: v2.3.0 requires config schema >=2.0.0 ✓
    └── Drift check: config hash matches expected for v2.3.0 ✓
```

---

## Validation Strategy — 3 Tiers

### Tier 1: Build-Time (CI — every commit)

Zero infrastructure required. Catches all static config errors.

| Check                         | What It Catches                                                                                                                      |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Schema parse                  | Missing required vars, wrong types, invalid enums                                                                                    |
| Default safety                | Insecure defaults in production config (placeholder passwords, wildcard CORS)                                                        |
| Template drift                | `.env.template` out of sync with Zod schema                                                                                          |
| Cross-service URLs            | Studio runtime URL doesn't match runtime port                                                                                        |
| Shared secret consistency     | JWT secret or encryption key differs between services                                                                                |
| Schema version bump           | Schema changed but version not bumped                                                                                                |
| No process.env bypass         | Direct env access outside config system                                                                                              |
| Helm values validation        | Rendered manifests have all required env vars (against schema)                                                                       |
| Rollback compatibility        | Target version's schema can read current DB state                                                                                    |
| SSRF URL check                | Configurable URLs point to cloud metadata endpoints                                                                                  |
| Encryption key strength       | Keys with low entropy, repeated characters, sequential patterns                                                                      |
| Production policy enforcement | `loggingLevel` must be `warn` or `error` in production.json. `traceSamplingRate` must be <= 0.2. `debugTracesEnabled` must be false. |
| JSON layer field restriction  | Infrastructure/secret fields in environment JSON files (data exfiltration risk)                                                      |

```bash
npx tsx packages/config/scripts/validate-config.ts \
  --env dev --env staging --env production \
  --cross-service --check-templates --check-bypasses --check-helm
```

### Tier 2: Startup (Service boot — before accepting traffic)

Runs with real infrastructure. Catches connectivity and compatibility issues.

| Check                     | What It Catches                                             |
| ------------------------- | ----------------------------------------------------------- |
| MongoDB connectivity      | Wrong connection string, auth failure, replica set mismatch |
| Redis connectivity        | Wrong host, missing password, TLS mismatch                  |
| ClickHouse connectivity   | Wrong endpoint, auth failure                                |
| Vault reachability        | Vault sealed, token expired, network unreachable            |
| Secret decryption         | Encryption key wrong — credentials can't be read            |
| Schema compatibility      | Running code expects config fields that don't exist         |
| LLM provider reachability | API key invalid, provider endpoint unreachable              |

**Degraded mode on failure**: `/health` returns 503. WebSocket connections closed with 1013. Periodic re-validation every 30s. Auto-recovery when infrastructure returns. Timer stops after 5 minutes if recovery fails.

### Tier 3: Runtime (Continuous — during operation)

Catches issues that develop over time AND fleet-wide inconsistencies.

| Check                    | What It Catches                                           |
| ------------------------ | --------------------------------------------------------- |
| Config drift             | ConfigMap changed without restart                         |
| Secret/cert expiry       | Vault lease or TLS certificate approaching expiration     |
| Dependency health        | MongoDB/Redis/Vault/ClickHouse degraded or down           |
| Version skew (fleet)     | Services running different versions after partial rollout |
| Customer config validity | Customer overrides reference removed config keys          |
| Config monitor health    | The monitor itself is running and emitting metrics        |

**Observability**: Every check emits structured log + Prometheus metric (`config_drift_detected_total`, `config_secret_expiry_seconds`, `startup_validation_failures_total`). Admin UI Config Dashboard polls `/admin/config` from all services.

---

## Audit Findings & Resolutions

Three independent auditors reviewed the plan, followed by a 3-pass review cycle (find issues → fix → verify). Key findings and resolutions:

### Adopted Simplifications

| Finding                                               | Resolution                                                                                                       |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| **DeploymentIdentity has 12 fields, most derivable**  | Simplified to 4 runtime fields + optional `vaultPath`. Version/hash embedded in Docker image at build time.      |
| **Per-module build hashes are over-engineered**       | Replaced with single monorepo commit hash. If any package changes, the commit hash changes.                      |
| **6 validation tiers overlap significantly**          | Collapsed to 3 tiers: Build (CI), Startup (service boot), Runtime (continuous).                                  |
| **Customer config files in git don't scale**          | Customer overrides stored in MongoDB `customer_configs` collection. Allows runtime updates without redeployment. |
| **New FeatureFlagResolver duplicates TenantFeatures** | Extend existing `TenantFeatures` with environment-level defaults instead of new module.                          |
| **`node-vault` dependency unnecessary**               | Keep fetch-based Vault implementation. K8s auth with ~30 lines of fetch + JWT parsing.                           |

### Critical Fixes Applied

| Finding                                                     | Resolution                                                                                              |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| **Config reload race condition** — config nulled mid-reload | Atomic swap: load new first, then swap. Provider restored on failure. Config never null.                |
| **Watcher allows concurrent reloads**                       | `isReloading` flag + exponential backoff (up to 5min). Recursive `setTimeout` instead of `setInterval`. |
| **Vault sealed = indefinite stale cache**                   | Cache TTL (1h default). Re-fetch on expiry. Stale-serve + alert if Vault unreachable.                   |
| **Validation errors are warnings, not blockers**            | `throwOnError: true` default. `unsafe: true` suppresses only in dev.                                    |
| **`/admin/config` auth underspecified**                     | Field-level redaction. Vault paths show `secret/data/***` pattern only. Require platform OWNER role.    |
| **Degraded mode doesn't handle WebSocket connections**      | Close active WebSockets with 1013. New connections rejected. Timer stops after max duration.            |
| **EnvProvider leaks all env vars**                          | `getAll()` filtered to `BASE_ENV_MAPPING` allowlist + essential vars.                                   |
| **No URL validation (SSRF risk)**                           | `validateUrlSafety()` blocks metadata endpoints (`169.254.169.254`) and localhost in production.        |
| **Encryption key validation weak**                          | Requires 64 hex chars, 16+ unique chars, rejects sequential and repeated patterns.                      |
| **No config hash for drift/rollback**                       | Deterministic SHA-256 hash (sensitive fields excluded) in `version/config-hash.ts`.                     |
| **No cross-service validation**                             | `validateCrossServiceConfig()` checks JWT, MongoDB, Redis consistency across services.                  |
| **No observability metrics defined**                        | `ConfigMetricEmitter` interface + constants + `NoopMetricEmitter`.                                      |
| **Provider not restored on reload failure**                 | Catch block restores `provider = previousProvider` + populates `meta.lastReloadError`.                  |
| **`loadDeploymentIdentity()` throws opaque Zod error**      | Try-catch wraps parse with descriptive error message including valid enum values.                       |
| **DegradedModeManager timer leak at max duration**          | `stopRevalidation()` called when `maxDegradedMs` exceeded.                                              |
| **Region checks used fragile string matching**              | Proper URL parsing with `new URL()`, checks hostname against known EU region patterns.                  |

### Acknowledged Gaps (deferred to post-GA)

| Finding                                       | Status                                                                                                                                                                                                                                                                                      |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Blue-green / canary deployment config support | Deferred — handled by Helm/ArgoCD at infrastructure level, not config system                                                                                                                                                                                                                |
| Multi-region failover config                  | Deferred — requires DR architecture design first                                                                                                                                                                                                                                            |
| Air-gapped environment support                | Deferred — FileProvider exists as fallback, will document for on-premise customers                                                                                                                                                                                                          |
| OTEL/tracing configuration completeness       | Deferred — current ObservabilityConfigSchema covers basics                                                                                                                                                                                                                                  |
| Channel-specific config registry              | Deferred — channels use per-channel env vars, will centralize later                                                                                                                                                                                                                         |
| Admin UI Config Dashboard                     | Deferred to post-GA — `/admin/config` endpoint implemented first                                                                                                                                                                                                                            |
| Customer-specific configuration               | Post-GA. Pre-boot config (log level, Vault address, observability) comes from Helm env vars — customer controls via their values file. Post-boot config (feature flags, rate limits, model preferences) comes from MongoDB `customer_configs` after DB connection is established (Phase C). |

---

## Appendix A: End-to-End Deployment Guide (Dev & Staging Examples)

### How the Config System Flows

```
Helm values (abl-platform-deploy repo)
  → K8s env vars injected into pods
    → DeploymentIdentity loaded from 4 env vars
      → Environment defaults (base.json → dev.json / staging.json) loaded
        → Vault secrets merged (K8s auth in staging, env vars in dev)
          → Zod validation → seal → getConfig()
```

### What Changes in Harness CI/CD

#### 1. Add Config Validation CI Step

In `.harness/pipelines/ci-build.yaml`, after the "Build and Test" stage:

```yaml
- step:
    type: Run
    name: Validate Config
    spec:
      command: |
        npx tsx packages/config/scripts/validate-config.ts \
          --env dev --env staging --env production \
          --cross-service --check-templates
```

This validates: all environment JSON files parse correctly, cross-service consistency (JWT secrets match, DB URLs match), `.env.template` stays in sync with Zod schemas.

#### 2. Add Deployment Identity Env Vars to Helm Templates

In `abl-platform-deploy`, update the Helm deployment template:

```yaml
# helm/abl-platform-stack/templates/deployment.yaml
env:
  - name: DEPLOYMENT_ENVIRONMENT
    value: { { .Values.deploymentIdentity.environment } }
  - name: DEPLOYMENT_REGION
    value: { { .Values.deploymentIdentity.region } }
  - name: DEPLOYMENT_TYPE
    value: { { .Values.deploymentIdentity.deploymentType } }
  - name: CUSTOMER_ID
    value: { { .Values.deploymentIdentity.customerId | default "" } }
```

#### 3. Add Vault K8s Auth Env Vars (Staging/Prod Only)

```yaml
env:
  - name: VAULT_K8S_AUTH
    value: { { .Values.vault.k8sAuth | quote } }
  - name: VAULT_K8S_ROLE
    value: { { .Values.vault.k8sRole | default "abl-platform" } }
  - name: VAULT_ADDR
    value: { { .Values.vault.addr } }
```

---

### Dev Environment

**What it is**: Shared dev cluster (`agents-dev.kore.ai`) — all engineers share, relaxed validation.

#### Helm Values (`values-dev.yaml`)

```yaml
deploymentIdentity:
  environment: dev
  region: us-east-1
  deploymentType: shared-dev

vault:
  k8sAuth: 'false' # Dev uses env vars, not Vault
  addr: ''

runtime:
  env:
    NODE_ENV: development
    PORT: '3112'
    MONGODB_URL: 'mongodb://mongo:27017/abl_platform'
    REDIS_URL: 'redis://redis:6379'
    JWT_SECRET: 'dev-jwt-secret-change-in-production'
    ENCRYPTION_MASTER_KEY: '' # Optional in dev
    ANTHROPIC_API_KEY: '<shared-dev-key>'
    FEATURE_VOICE_ENABLED: 'true'
    FEATURE_STREAMING_ENABLED: 'true'
    FEATURE_DEBUG_TRACES: 'true'
```

#### What Happens at Startup

1. **Identity loaded**: `{ environment: 'dev', region: 'us-east-1', deploymentType: 'shared-dev' }`
2. **Config layers merged**: `base.json` → `dev.json` (enables debug traces, debug logging, all features on)
3. **Vault**: Skipped (K8s auth disabled). All secrets come from env vars
4. **Validation**: Warns only (dev mode) — missing encryption key is a warning, not a blocker
5. **Config sealed**: Frozen, `getConfig()` works

#### What You Provision

| Resource          | How                                        | Notes                                   |
| ----------------- | ------------------------------------------ | --------------------------------------- |
| MongoDB           | Already in AKS (Helm subchart or external) | No change                               |
| Redis             | Already in AKS                             | No change                               |
| ClickHouse        | Already in AKS                             | No change                               |
| Vault             | **Not needed**                             | Dev uses env vars via K8s Secrets       |
| K8s Secrets       | One Secret per app with env vars           | Same as today                           |
| Environment JSONs | **Automatic** — baked into Docker image    | `packages/config/environments/dev.json` |

**Nothing new to provision for dev** — the environment defaults are in the Docker image, and secrets stay as K8s Secrets.

---

### Staging Environment

**What it is**: Production-like (`abl-staging.kore.ai`) — strict validation, real Vault, real infrastructure.

#### Helm Values (`values-staging.yaml`)

```yaml
deploymentIdentity:
  environment: staging
  region: us-east-1
  deploymentType: saas-multi-tenant

vault:
  k8sAuth: 'true'
  k8sRole: 'abl-platform'
  addr: 'https://vault.staging.kore.ai:8200'

runtime:
  env:
    NODE_ENV: production # Staging runs in production mode
    PORT: '3112'
    MONGODB_URL: '' # Comes from Vault
    REDIS_URL: '' # Comes from Vault
    JWT_SECRET: '' # Comes from Vault
    ENCRYPTION_MASTER_KEY: '' # Comes from Vault
    ANTHROPIC_API_KEY: '' # Comes from Vault
```

#### What Happens at Startup

1. **Identity loaded**: `{ environment: 'staging', region: 'us-east-1', deploymentType: 'saas-multi-tenant' }`
2. **Config layers merged**: `base.json` → `staging.json` (prod-like limits, shorter retention, 50% trace sampling)
3. **Vault path derived**: `resolveVaultBasePath()` → `secret/data/abl-platform/prod/us-east-1`
4. **K8s auth**: Pod reads SA JWT from `/var/run/secrets/...`, exchanges for Vault token
5. **Secrets fetched**: `MONGODB_URL`, `JWT_SECRET`, `ENCRYPTION_MASTER_KEY`, etc. from Vault KV v2
6. **Validation**: Strict — missing encryption key **blocks startup**, enters degraded mode
7. **Config sealed**: Frozen, cache TTL = 1 hour, lease tracked

#### What You Provision

| Resource            | How                                                | Notes                |
| ------------------- | -------------------------------------------------- | -------------------- |
| **HashiCorp Vault** | Deploy in staging AKS or use HCP Vault             | **New**              |
| **Vault K8s Auth**  | Enable K8s auth method                             | One-time setup       |
| **Vault Role**      | Create role `abl-platform` bound to ServiceAccount | One-time setup       |
| **Vault Secrets**   | Write to `secret/data/abl-platform/prod/us-east-1` | One-time + rotations |
| **ServiceAccount**  | `abl-platform` SA in app namespace                 | Helm creates this    |
| MongoDB             | Already in AKS (replica set)                       | No change            |
| Redis               | Already in AKS (with password)                     | No change            |
| ClickHouse          | Already in AKS                                     | No change            |

#### Vault Setup Commands (One-Time)

```bash
# 1. Enable K8s auth
vault auth enable kubernetes

# 2. Configure K8s auth (point to AKS cluster)
vault write auth/kubernetes/config \
  kubernetes_host="https://kubernetes.default.svc:443" \
  kubernetes_ca_cert=@/var/run/secrets/kubernetes.io/serviceaccount/ca.crt

# 3. Create policy
vault policy write abl-platform - <<EOF
path "secret/data/abl-platform/prod/*" {
  capabilities = ["read", "list"]
}
EOF

# 4. Create role bound to ServiceAccount
vault write auth/kubernetes/role/abl-platform \
  bound_service_account_names=abl-platform \
  bound_service_account_namespaces=abl-staging \
  policies=abl-platform \
  ttl=1h

# 5. Write secrets
vault kv put secret/abl-platform/prod/us-east-1 \
  MONGODB_URL="mongodb+srv://admin:***@staging-cluster.mongodb.net/abl_platform" \
  REDIS_URL="redis://:***@staging-redis:6379" \
  JWT_SECRET="$(openssl rand -base64 64)" \
  ENCRYPTION_MASTER_KEY="$(openssl rand -hex 32)" \
  ANTHROPIC_API_KEY="sk-ant-***" \
  OPENAI_API_KEY="sk-***"
```

---

### Side-by-Side Comparison

| Aspect                   | Dev                 | Staging                                   |
| ------------------------ | ------------------- | ----------------------------------------- |
| `DEPLOYMENT_ENVIRONMENT` | `dev`               | `staging`                                 |
| `DEPLOYMENT_TYPE`        | `shared-dev`        | `saas-multi-tenant`                       |
| Vault                    | Not used (env vars) | HashiCorp with K8s auth                   |
| Validation               | Warn only           | Strict (blocks startup)                   |
| Debug traces             | Enabled             | Disabled                                  |
| Log level                | `debug`             | `info`                                    |
| Trace sampling           | 100%                | 50%                                       |
| Feature flags            | All on              | All on (same as prod)                     |
| Encryption key           | Optional            | **Required**                              |
| Config defaults file     | `dev.json`          | `staging.json`                            |
| Vault path               | N/A                 | `secret/data/abl-platform/prod/us-east-1` |
| Cache TTL                | N/A                 | 1 hour                                    |
| Degraded mode            | Disabled            | Active (503 + WS 1013)                    |

### What You DON'T Need to Change

- **App code** — all apps already use `loadConfig()` from `@agent-platform/config`. The new env defaults, identity loading, and vault path resolution happen inside the config package automatically.
- **Docker images** — the environment JSON files are baked in (`packages/config/environments/` gets compiled into the package).
- **Existing env vars** — all current env vars continue to work. The new system adds layering on top.

---

## Appendix B: Phase 2 Activation Checklist

Everything built so far is inert — functions exist but aren't called from the app startup path yet. Phase 2 wires the new infrastructure into the actual runtime.

### Action 1: Wire Environment Defaults into the Loader (P0 — 1 day)

**File**: `packages/config/src/loader.ts`

Currently `loadConfig()` reads env vars directly. Add a step before Zod validation that:

1. Calls `loadDeploymentIdentity()` to get the identity from env vars (defaults to dev if unset)
2. Calls `resolveConfigLayers(identity)` to get the layer list (`[base.json, dev.json, ...]`)
3. Reads and deep-merges the JSON files in order
4. Uses the merged defaults as the base, with env vars + Vault secrets overriding on top

```typescript
// In loadConfig(), before Zod parse:
const identity = loadDeploymentIdentity();
const layers = resolveConfigLayers(identity);
const envDefaults = deepMerge(...layers.map(loadJsonFile));
const rawConfig = mapEnvToConfig({ ...envDefaults, ...envValues }, mergedMapping);
```

Config hash should also be wired in: after `loadConfig()` succeeds, call `computeConfigHash(config)` and store it in `meta.configHash`. This enables drift detection — the watcher compares the stored hash against a fresh computation.

### Action 2: Add `DEPLOYMENT_*` Env Vars to Helm Values (P0 — 30 min)

**Repo**: `abl-platform-deploy`

Add to `helm/abl-platform-stack/values-dev.yaml`:

```yaml
deploymentIdentity:
  environment: dev
  region: us-east-1
  deploymentType: shared-dev
```

Add to `helm/abl-platform-stack/values-staging.yaml`:

```yaml
deploymentIdentity:
  environment: staging
  region: us-east-1
  deploymentType: saas-multi-tenant
```

Update the Helm deployment template (`templates/deployment.yaml`) to inject these as env vars for every app pod:

```yaml
env:
  - name: DEPLOYMENT_ENVIRONMENT
    value: { { .Values.deploymentIdentity.environment } }
  - name: DEPLOYMENT_REGION
    value: { { .Values.deploymentIdentity.region } }
  - name: DEPLOYMENT_TYPE
    value: { { .Values.deploymentIdentity.deploymentType } }
  - name: CUSTOMER_ID
    value: { { .Values.deploymentIdentity.customerId | default "" } }
```

### Action 3: Create Config Validation CI Script + Harness Step (P1 — 1 day)

**File to create**: `packages/config/scripts/validate-config.ts`

Script that:

1. Loads each environment's JSON defaults (`dev.json`, `staging.json`, `production.json`)
2. Parses them through the Zod `BaseAppConfigSchema` to catch schema errors
3. Runs `validateCrossServiceConfig()` across all service configs
4. Runs `validateProductionConfig()` on the production defaults
5. Exits with code 1 if any errors found

**Harness step** to add in `.harness/pipelines/ci-build.yaml` after "Build and Test":

```yaml
- step:
    type: Run
    name: Validate Config
    spec:
      command: |
        npx tsx packages/config/scripts/validate-config.ts \
          --env dev --env staging --env production \
          --cross-service
```

### Action 4: Wire DegradedModeManager into App Startup (P1 — 1 day)

**Files**: `apps/runtime/src/server.ts`, `apps/search-ai/src/server.ts`, etc.

After `loadConfig()`:

1. Create a `DegradedModeManager` instance
2. Run startup validation checks (MongoDB ping, Redis ping, Vault reachability)
3. If any check fails, call `degradedModeManager.enter(reason)`
4. Register a WebSocket listener that rejects connections when degraded
5. Register a health endpoint handler that returns 503 when degraded
6. Add revalidation checks so the service auto-recovers

```typescript
const degradedMode = new DegradedModeManager();

degradedMode.addRevalidationCheck(async () => {
  await mongoose.connection.db.admin().ping();
  return true;
});

degradedMode.addListener({
  onEnterDegradedMode(reason) {
    wsServer.closeAll(1013, `Service degraded: ${reason}`);
  },
  onExitDegradedMode() {
    log.info('Service recovered from degraded mode');
  },
});
```

### Action 5: Generate `.env.template` from Schemas (P2 — half day)

**File to create**: `packages/config/scripts/generate-env-template.ts`

Script that walks the Zod schemas (`BaseAppConfigSchema` + per-app extensions) and outputs a `.env.template` per app with:

- All env var names (from `BASE_ENV_MAPPING` + app mapping)
- Type annotation (string, number, boolean, enum values)
- Default value (if any)
- Whether the var is required in production
- Grouped by section (server, database, redis, jwt, llm, etc.)

Run in CI to detect template drift: compare generated output against committed `.env.template` files.

### Action 6: Set Up Vault for Staging (P2 — half day)

Run the one-time Vault setup commands (see Appendix A, "Vault Setup Commands"):

1. `vault auth enable kubernetes`
2. Configure K8s auth pointing to the AKS cluster
3. Create `abl-platform` policy with read access to `secret/data/abl-platform/prod/*`
4. Create role bound to `abl-platform` ServiceAccount in `abl-staging` namespace
5. Write initial secrets (`MONGODB_URL`, `REDIS_URL`, `JWT_SECRET`, `ENCRYPTION_MASTER_KEY`, LLM API keys)

Add Vault env vars to staging Helm values:

```yaml
vault:
  k8sAuth: 'true'
  k8sRole: 'abl-platform'
  addr: 'https://vault.staging.kore.ai:8200'
```

### Priority Summary

| Priority | Action                                        | Effort   | What It Enables                                   |
| -------- | --------------------------------------------- | -------- | ------------------------------------------------- |
| **P0**   | Wire env defaults + config hash into loader   | 1 day    | Identity-aware config resolution, drift detection |
| **P0**   | Add `DEPLOYMENT_*` to Helm values             | 30 min   | Pods know their environment/region/type           |
| **P1**   | Create `validate-config.ts` + Harness CI step | 1 day    | Catches misconfigs before deployment              |
| **P1**   | Wire degraded mode into app startup           | 1 day    | Graceful 503 + WS 1013 instead of crashes         |
| **P2**   | Generate `.env.template` from schemas         | Half day | Prevents template drift                           |
| **P2**   | Set up Vault for staging                      | Half day | Staging uses real secret management               |
