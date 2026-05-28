# Deployment Seed And Tenant Bootstrap Guide

This note is for Deployment Operations / ArgoCD owners. It explains what was fixed in the seed path, what the seed does in production, what is intentionally deferred to tenant creation time, and what must not be wired into production at all.

## Executive Summary

- Production seed is intentionally split into:
  - global deploy-time seed
  - tenant-time bootstrap
  - vault / secret seeding
- The normal runtime pod does not auto-run seed on startup. Seed must run through the dedicated migration / init job path.
- New tenants created through the normal Studio workspace creation flow already bootstrap their tenant-scoped defaults automatically.
- Production must not run the dev seed path.

## What Was Fixed

The recent seed fix restored the dedicated deployment init path rather than changing the startup model.

Two separate bugs were in the database seed path, both caused by `seed-mongo.ts` depending on helper files as reusable modules when those files had drifted from that contract:

- `packages/database/seed-prompt-templates.ts` now explicitly exports `getPromptTemplateSeedEntries()`.
  `seed-mongo.ts` uses that helper during validation to determine which prompt-template keys should exist, while `seedPromptTemplates()` continues to perform the writes.
- `scripts/rbac-tool-permissions.ts` now behaves as a safe importable helper module.
  It exports both `migrateRbacToolPermissions()` and `validateRbacToolPermissions()`, and it only runs `main()` when executed directly from the CLI.
- The failing pre-push gate was not caused by a docs issue.
  It was the real `seed-mongo.ts` entrypoint tests exposing helper-contract drift in those two files.

Additional improvements shipped with the same fix:

- `seed-mongo.ts` now runs correctly again from the dedicated seed / init container path under `tsx`.
- The seed now has explicit task execution, status, and validation behavior through the shared seed runner.
- Seed task failures now surface the underlying task reason instead of only the task ID.
- If `ENCRYPTION_MASTER_KEY` is present, the seed initializes the DEK facade before any encrypted seed writes.
- Provider API keys are no longer written into MongoDB. They are treated as vault-managed inputs.
- Dev/example environment variables now skip gracefully if the DEK facade is unavailable instead of aborting the whole seed.
- Regression coverage was added for real `seed-mongo.ts` entrypoint runs.

Important non-change:

- The runtime server pod still does not self-seed on boot. Seeding remains a dedicated init / hook concern, not normal app startup behavior.

## How The Seed Works

The public entrypoints are:

- `pnpm seed:core`
- `pnpm seed:status`
- `pnpm seed:validate`
- `pnpm seed:dev`
- `pnpm db:init:core`

Do not use `pnpm db:init` in production. `db:init` runs `seed:dev`, which includes dev-only fixtures.

At runtime, `packages/database/seed-mongo.ts` builds a task list based on CLI flags:

- default run:
  - `platform-core`
  - `rbac-tool-permissions`
- targeted tenant run with `--tenant` or `--workspace-email`:
  - `platform-core`
  - `rbac-tool-permissions`
  - `tenant-operational-defaults`
- dev run with `--dev`:
  - `platform-core`
  - `rbac-tool-permissions`
  - `dev-workspace-fixtures`
  - `e2e-workspace-fixtures`

`--status` and `--validate` inspect the same task graph without applying writes.

## Collections And State By Phase

### 1. Global Deploy-Time Seed

This is what production init should run for every environment.

Main seed tasks:

- `platform-core`
- `rbac-tool-permissions`

Mongo collections / state touched:

| Task                    | Collections / state         | Notes                                                                     |
| ----------------------- | --------------------------- | ------------------------------------------------------------------------- |
| `platform-core`         | `resource_types`            | Seeds canonical resource types and operations                             |
| `platform-core`         | `prompt_templates`          | Seeds prompt catalog rows                                                 |
| `platform-core`         | `pipeline_definitions`      | Seeds builtin pipeline definitions                                        |
| `platform-core`         | `_seed_meta`                | Records `seed_version` when `SEED_VERSION` is provided                    |
| `platform-core`         | ClickHouse analytics tables | Not Mongo; created only when `CLICKHOUSE_URL` is configured               |
| `rbac-tool-permissions` | `resource_types`            | Aligns `tool` operations and deprecates legacy `mcp` resource type        |
| `rbac-tool-permissions` | `role_definitions`          | Updates built-in role permissions across existing tenant role definitions |

What this phase does not create by default:

- no tenant records
- no tenant membership records
- no tenant-scoped LLM policy rows
- no tenant pipeline config rows
- no example/demo projects

### 2. Tenant Creation Bootstrap

This happens when a tenant is created through the normal Studio workspace creation path.

Application-created records:

- `tenants`
- `tenant_members`

Bootstrap-created records:

- `role_definitions`
- `tenant_llm_policies`
- `pipeline_configs`

The tenant bootstrap does the following:

- upserts the built-in system roles for that tenant:
  - `OWNER`
  - `ADMIN`
  - `OPERATOR`
  - `MEMBER`
  - `VIEWER`
- ensures a `tenant_llm_policies` row exists with the default policy:
  - `allowedProviders: []`
  - `credentialPolicy: org_first`
  - `monthlyTokenBudget: 10000000`
  - `dailyTokenBudget: 1000000`
  - `defaultModel: null`
  - `defaultFastModel: null`
  - `defaultVoiceModel: null`
  - `maxRequestsPerMinute: 100`
  - `allowProjectCredentials: true`
  - `platformDemoEnabled: false`
- creates one tenant-level `pipeline_configs` row per builtin pipeline type with:
  - `projectId: null`
  - `enabled: false`
  - `config: {}`
  - `backfillStatus: idle`

Current builtin pipeline types seeded per tenant:

- `anomaly_detection`
- `drift_detection`
- `friction_detection`
- `intent_classification`
- `quality_evaluation`
- `simulation`
- `hallucination_detection`
- `guardrail_analysis`
- `knowledge_gap`
- `sentiment_analysis`

Important nuance:

- The tenant LLM policy is insert-only. Existing tenant policy rows are not overwritten.
- Tenant pipeline configs are ensured, not reset. Existing configs are preserved.

### 3. Dev-Only Seed

This is the `--dev` path. It is not for production.

Collections / state touched:

- `users`
- `tenants`
- `tenant_members`
- `debug_tokens`
- `projects`
- `project_agents`
- `project_tools`
- `environment_variables`
- `agent_versions`
- `deployments`
- `model_configs`
- `project_llm_configs`
- `project_settings`

It also seeds:

- the shared dev workspace
- the dedicated e2e workspace
- optional local-only users if `seed-local-users.js` exists
- curated example projects and compiled example deployments

## What Production Will Not Seed

These are intentionally not part of the production seed path.

### Not Seeded At All In Production

- example projects
- example agents
- example tools
- example agent versions
- example deployments
- debug tokens
- local dev users
- dev workspace
- e2e workspace
- example project settings/config rows

### Not Seeded Into MongoDB In Production

- provider API keys such as `OPENAI_API_KEY` and `ANTHROPIC_API_KEY`
- tenant LLM credentials derived from provider env vars
- default tenant model rows derived from provider env vars

These are now treated as vault-managed inputs. Ops should expect them to come from the secret store / vault path, not from Mongo seed data.

### Dev-Only Encrypted Example Data

- example project `environment_variables` are only part of the dev/example seed
- even in dev, they are only written if the DEK facade is available

## What Is Seeded Later During Tenant Creation

These items are intentionally not part of the global deploy-time seed because tenants do not exist yet:

- `tenants`
- `tenant_members`
- tenant-scoped `role_definitions`
- `tenant_llm_policies`
- tenant-scoped `pipeline_configs`

For normal operations, these should be created by the application when the tenant is created. ArgoCD does not need to pre-seed these for tenants that do not exist yet.

## ArgoCD Responsibilities

### Environment Bootstrap

For a new environment, ArgoCD should do the following:

1. Ensure secrets are provisioned first.
   The seed does not populate vault / secret manager state. That is handled separately by `scripts/seed-secrets.ts` and `scripts/validate-secrets-completeness.ts`.

2. Run Mongo migrations.
   Use the dedicated migration image / job path.

3. Run the dedicated init / seed path.
   This should execute the production-safe seed flow:
   - core seed
   - RBAC alignment

4. Do not run dev seed from ArgoCD.
   Specifically, do not wire `pnpm db:init` or `pnpm seed:dev` into production.

5. Optionally run validation.
   Recommended post-sync checks:
   - `pnpm seed:status`
   - `pnpm seed:validate`

Recommended production-safe commands:

```bash
pnpm db:migrate:mongo
pnpm seed:core
pnpm seed:validate
```

Or use the runtime Dockerfile's dedicated `migrate` and `init` targets as the ArgoCD job / hook artifacts.

### New Tenant Initialization

For a normal new tenant created through Studio or the standard app flow:

- ArgoCD does not need to do anything special.
- The application creates the tenant and tenant membership rows.
- The application then bootstraps tenant defaults automatically.

For an out-of-band tenant creation flow, migrated tenant, or a tenant created before bootstrap logic was added:

- run a one-off targeted bootstrap:

```bash
pnpm tsx packages/database/seed-mongo.ts --tenant <tenantId>
pnpm tsx packages/database/seed-mongo.ts --validate --tenant <tenantId>
```

This targeted bootstrap is safe because it only applies tenant operational defaults, not dev fixtures.

## Operational Guidance

### What Ops Should Expect To See After Environment Seed

Expected global state:

- `resource_types` populated
- `prompt_templates` populated
- `pipeline_definitions` populated
- `role_definitions` updated for any already-existing tenants
- `_seed_meta.seed_version` populated if version gating is used

Expected absence:

- no dev workspace data
- no example projects
- no provider keys in MongoDB

### What Ops Should Expect To See After New Tenant Creation

Expected tenant-scoped state:

- one `tenants` row
- one or more `tenant_members` rows
- built-in `role_definitions` for that tenant
- one `tenant_llm_policies` row
- one disabled `pipeline_configs` row per builtin pipeline type

## Bottom Line

- Use ArgoCD to run environment-wide migration + core seed only.
- Do not use ArgoCD to run the dev seed path in production.
- Do not expect provider keys to appear in MongoDB.
- Do not create a per-tenant ArgoCD hook for normal tenant creation.
- Only run the targeted tenant bootstrap command for exceptional backfill / repair cases.
