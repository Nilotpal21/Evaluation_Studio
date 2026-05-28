# Environment Configuration System — Review Findings

**Date**: 2026-03-17
**Document reviewed**: `docs/plans/environment-configuration-system.md`
**Status**: Design gaps identified — requires revision before implementation

---

## Summary

The environment configuration system plan defines a comprehensive architecture: 9 problems, 6 implementation phases, 3-tier validation, deployment identity, environment JSON defaults, and a Phase 2 activation checklist. The individual components are well-designed. However, this review identified structural gaps in the plan's design around customer config delivery, boot sequence ordering, and production safety guardrails.

All findings below are about **gaps in the plan's design itself**, not about the current codebase (which the plan explicitly intends to change).

---

## Finding 1: Environment JSON Files Contain Only Behavioral Defaults

**Observation**: The environment JSON files described in the plan contain exclusively non-secret operational settings:

| File              | Contents                                                                                   |
| ----------------- | ------------------------------------------------------------------------------------------ |
| `base.json`       | `server.host`, `redis.enabled`, `observability.loggingLevel`, `archive.compressionEnabled` |
| `dev.json`        | `env`, `loggingLevel: "debug"`, feature flags (all enabled)                                |
| `staging.json`    | `env`, `loggingLevel: "info"`, `traceSamplingRate: 0.5`, debug traces off                  |
| `production.json` | `env`, `loggingLevel: "warn"`, `traceSamplingRate: 0.1`, debug traces off                  |
| Region files      | `region.name`, `dataResidency`, `gdprEnabled`                                              |

No database URLs, Redis URLs, API keys, JWT secrets, or any infrastructure connection details appear in any JSON file. This is intentional — secrets should not be in git. But it means the JSON layer provides no defaults for the most critical config fields (the ones whose absence crashes the app).

**Implication**: The environment JSON files solve the "behavioral tuning" problem (log levels, feature flags, sampling rates) but do not address the "missing infrastructure config" problem. If a K8s Secret or Vault path is misconfigured, the JSON layer offers no fallback. The plan should explicitly state this boundary — what the JSON layer is responsible for and what it is not.

---

## Finding 2: No Guardrails Against Bad Production Default Changes

**Scenario**: A developer changes `production.json` to set `loggingLevel: "debug"` or `traceSamplingRate: 1.0`. The commit passes CI, gets merged, gets baked into the Docker image, and every production pod picks up debug-level logging — causing potential performance issues and log volume cost increases.

**What the plan describes**: `validateProductionConfig()` checks for security issues (wildcard CORS, default JWT secret, weak encryption keys). It does not describe enforcement of operational constraints like allowed log levels or maximum sampling rates for production.

**What's missing**: A policy layer that enforces operational boundaries on production defaults:

- `observability.loggingLevel` must be `warn` or `error` in production
- `observability.traceSamplingRate` must be <= 0.2 in production
- `features.debugTracesEnabled` must be `false` in production

Without this, the only protection is PR review — which doesn't scale and is easy to miss. The plan's CI validation step (`validate-config.ts`) would be the natural place for these checks, but it is not described.

---

## Finding 3: Customer Overlay File Approach Does Not Work

**What the plan says**: `resolveConfigLayers()` loads a customer overlay from `environments/customers/${identity.customerId}.json`:

```typescript
if (identity.customerId) {
  const customerFile = `environments/customers/${identity.customerId}.json`;
  if (existsSync(customerFile)) layers.push(customerFile);
}
```

**Why this doesn't work**:

| Deployment type  | Problem                                                                                                                                                  |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `private-vpc`    | Customer owns the infrastructure. They cannot inject files into a path hardcoded inside our Docker image. We cannot put their config in our source repo. |
| `saas-dedicated` | We ship one Docker image to all customers. We cannot bake per-customer JSON files into a shared image without rebuilding per customer.                   |
| `on-premise`     | Same as private-vpc — customer-managed, no access to our build pipeline.                                                                                 |

**Impact**: The `resolveConfigLayers()` function's customer overlay path (`environments/customers/`) is unusable for all multi-customer deployment types. The plan needs a different delivery mechanism for customer-specific config.

---

## Finding 4: Plan Contradicts Itself on Customer Config

The plan contains two incompatible statements about customer configuration:

**Statement A** — The audit finding and resolution:

> "Customer config files in git don't scale" → Resolution: "Customer overrides stored in MongoDB `customer_configs` collection. Allows runtime updates without redeployment."

**Statement B** — The `resolveConfigLayers()` function described in the plan still loads customer config from files:

```typescript
const customerFile = `environments/customers/${identity.customerId}.json`;
```

**The deeper problem**: MongoDB cannot serve pre-boot configs. The config system needs values like log level, Vault address, observability settings, and encryption keys before it can connect to MongoDB. These cannot come from MongoDB.

The plan does not resolve this contradiction. The audit acknowledged the file-based approach doesn't scale and proposed MongoDB, but MongoDB doesn't work for the pre-boot config category. The `resolveConfigLayers()` function was not updated to reflect the audit resolution.

---

## Finding 5: No Two-Phase Config Loading

**The ordering problem**: The plan presents a single config resolution chain:

```
environment JSON defaults → Vault secrets → env var overrides → MongoDB customer overrides
```

But this is not a flat pipeline. There is a dependency order:

1. You need Vault address and K8s auth config to connect to Vault
2. You need Vault to get database URLs and encryption keys
3. You need database URL to connect to MongoDB
4. You need MongoDB to read customer overrides

**What configs are needed at each phase**:

| Phase         | Configs needed                                                     | Can come from                  |
| ------------- | ------------------------------------------------------------------ | ------------------------------ |
| **Pre-Vault** | `VAULT_ADDR`, `VAULT_K8S_ROLE`, `DEPLOYMENT_*`, `LOG_LEVEL`        | Env vars (Helm), JSON defaults |
| **Pre-DB**    | `DATABASE_URL`, `REDIS_URL`, `ENCRYPTION_MASTER_KEY`, `JWT_SECRET` | Vault, env vars                |
| **Post-DB**   | Tenant feature flags, per-tenant rate limits, model preferences    | MongoDB                        |

The plan does not distinguish between these phases. It treats the resolution chain as a single merge, which creates a chicken-and-egg problem: you cannot load customer config from MongoDB if the customer's database URL is one of the configs you need to load.

**What the plan needs**: An explicit multi-phase loading model:

- **Phase 1 (bootstrap)**: Env vars + JSON defaults → enough to initialize logging, connect to Vault
- **Phase 2 (secrets)**: Vault secrets → infrastructure credentials (DB URLs, API keys, encryption keys)
- **Phase 3 (runtime)**: MongoDB → tenant/customer business logic overrides (feature flags, rate limits, model preferences)

Each phase should clearly document which config fields it resolves and what sources are available.

---

## Finding 6: Customer VPC Pre-Boot Config Has No Delivery Mechanism

**The question**: How does a customer VPC deployment set log level to `warn` or enable GDPR?

**What the plan offers**:

1. Customer overlay JSON file — doesn't work (Finding 3)
2. MongoDB customer overrides — doesn't work for pre-boot configs (Finding 5)
3. Env vars — works, but the plan doesn't describe this as a path for customer config

**What would actually work**: The customer sets env vars through their own Helm values:

```yaml
LOG_LEVEL: 'warn'
REGION_DATA_RESIDENCY: 'true'
```

This is the only viable mechanism for customer VPC pre-boot config, but the plan doesn't frame it this way. The `resolveConfigLayers()` function with its `environments/customers/` path implies file-based overlays are the intended mechanism.

**What the plan should say**: For `private-vpc` and `on-premise`, the customer controls all config through their own Helm values and env vars. The platform provides the schema and defaults; the customer provides the values. No customer-specific files exist in our repos or images. The Config Resolution Chain table should reflect this — currently it says "Customer-provided config file" for private-vpc without specifying how that file is delivered or loaded.

---

## Finding 7: Environment JSON Files Accept Infrastructure Values Without Restriction

**Scenario**: A developer adds a database URL to `production.json` and pushes it:

```json
{
  "database": { "url": "mongodb://my-personal-db:27017/stolen_data" },
  "observability": { "loggingLevel": "warn" }
}
```

The plan's config resolution order is: JSON defaults (lowest) → Vault secrets → env vars (highest). If the env var `DATABASE_URL` is not set and Vault doesn't provide it, the malicious URL from the JSON file becomes the active config.

**What the plan's validation catches**:

| Check                                       | Result                                                                            |
| ------------------------------------------- | --------------------------------------------------------------------------------- |
| Zod schema validation                       | Passes — `database.url` is a valid optional string                                |
| `validateProductionConfig()`                | Passes — `database.url` is present, no "not configured" error                     |
| Cross-service validation                    | Passes — all services read the same `production.json`, MongoDB host is consistent |
| SSRF URL validation (`validateUrlSafety()`) | Passes — only checks for metadata endpoints (`169.254.169.254`) and localhost     |
| Startup MongoDB connectivity                | Passes — the external DB is reachable                                             |

**The deployment succeeds. No validation in the plan catches this.**

The plan implicitly assumes that environment JSON files only carry behavioral defaults (log levels, feature flags). But the Zod schema accepts `database.url`, `redis.url`, `jwt.secret`, and other infrastructure/secret fields in the JSON layer — there is no enforcement that these fields are excluded. A malicious or careless change to `production.json` can inject infrastructure values that take effect when higher-priority sources (Vault, env vars) don't provide them.

**What's missing**:

- A schema-level or CI-level restriction on which fields are allowed in environment JSON files — infrastructure and secret fields (`database.url`, `redis.url`, `jwt.secret`, `encryption.masterKey`, LLM API keys) should be rejected if present in the JSON layer
- Alternatively, a separate "safe defaults" schema that only permits behavioral fields, used to validate the JSON files independently from the full app config schema

---

## Summary of Gaps

| #   | Finding                                                                                     | Severity    | Area          |
| --- | ------------------------------------------------------------------------------------------- | ----------- | ------------- |
| 1   | JSON files contain only behavioral defaults — no fallback for critical infra config         | Observation | Design        |
| 2   | No guardrails against bad production default changes (log level, sampling rate)             | Medium      | CI Validation |
| 3   | Customer overlay file approach doesn't work for any multi-customer deployment               | High        | Design        |
| 4   | Plan contradicts itself — audit says MongoDB, code says files, neither works fully          | High        | Design        |
| 5   | No multi-phase config loading — boot dependency order not addressed                         | High        | Design        |
| 6   | Customer VPC pre-boot config has no described delivery mechanism                            | High        | Design        |
| 7   | JSON files accept infrastructure/secret values without restriction — data exfiltration risk | High        | CI Validation |

Findings 3–6 are interconnected. The root cause is that the plan does not distinguish between **pre-boot config** (infrastructure, observability, secrets) and **post-boot config** (tenant business logic). Once that distinction is made, the delivery mechanism for each category becomes clear:

- **Pre-boot**: env vars (Helm) + JSON defaults + Vault — customer controls via their Helm values
- **Post-boot**: MongoDB tenant/customer overrides — loaded after DB connects

Findings 2 and 7 are related. The JSON layer has no enforcement of what it should and should not contain. Finding 2 is about operational values being set to bad-but-valid settings (debug logging in production). Finding 7 is about infrastructure/secret values being injected into a layer meant only for behavioral defaults — a more severe problem because it can lead to data exfiltration if higher-priority sources don't override them.

---

## Recommendations

1. **Define a multi-phase boot sequence** explicitly in the plan: bootstrap (env vars + JSON defaults) → secrets (Vault) → runtime overrides (MongoDB). Make it clear which configs belong to which phase and what sources are available at each phase.

2. **Drop the customer overlay file approach** (`environments/customers/`). For `private-vpc` and `on-premise`, document that the customer controls config through their Helm values. For `saas-dedicated`, use per-customer Vault KV paths or K8s ConfigMaps in the deploy repo — not files in the source repo.

3. **Resolve the MongoDB contradiction**: State explicitly that MongoDB customer overrides are only viable for post-boot tenant config (feature flags, rate limits, model preferences). Pre-boot config (log level, GDPR, observability) must come from env vars or Vault. Update `resolveConfigLayers()` to remove the customer file path, and document the MongoDB customer config as a separate post-boot loading step.

4. **Add production policy validation**: The `validate-config.ts` CI script should enforce operational constraints on `production.json` (log level, sampling rate, debug flags), not just security checks. Define allowed ranges for production operational settings.

5. **Restrict allowed fields in JSON layer**: Define a "safe defaults" schema or field allowlist for environment JSON files. Infrastructure fields (`database.url`, `redis.url`, `jwt.secret`, `encryption.masterKey`, LLM API keys) must be rejected in CI if present in any JSON file. These values should only come from Vault or env vars, never from the JSON layer in source control.

6. **Document the JSON layer boundary**: State explicitly that environment JSON files carry behavioral/operational defaults only — not infrastructure connection strings or secrets. Enforce this boundary in CI (recommendation 5), not just by convention.
