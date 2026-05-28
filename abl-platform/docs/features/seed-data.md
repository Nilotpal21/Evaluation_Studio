# Feature Spec: Seed Data Infrastructure

**Status:** ALPHA
**Owner:** Platform Team
**Created:** 2026-03-23
**Last Updated:** 2026-04-03

---

## Problem Statement

The ABL Platform requires a reliable, idempotent seed data system that initializes MongoDB (and optionally ClickHouse) with foundational records needed for the platform to function: resource types, prompt templates, pipeline definitions, tenant role definitions, tenant LLM policy defaults, tenant pipeline configs, curated dev-only example projects, and operational secrets. The public seed surface is now intentionally split: `packages/database/seed-mongo.ts` defaults to platform/core seed, `packages/database/seed-mongo.ts --tenant <tenantId>` or `--workspace-email <email>` applies tenant-critical defaults, and `packages/database/seed-mongo.ts --dev` adds dev-only fixtures like the dev workspace, debug token, e2e workspace, and curated examples. Studio now receives editable prompt defaults through the project settings API, backed by PromptCatalog defaults on the runtime side, and workspace creation now ensures tenant-critical defaults for every new workspace.

### Core Problems

1. **Partially unified orchestration** -- The repo now has a clear split between `seed:core` and `seed:dev`, but `seed-secrets.ts` remains a separate operational step and there is still no shared reporting or dry-run interface across all seed paths.
2. **Shared helpers are only partly extracted** -- The main `upsertOne()` helper now lives in `packages/database/src/seed/upsert-helpers.ts`, but not every remaining seed-adjacent path has been normalized around that contract.
3. **No validation layer** -- Seed scripts insert raw objects without Zod/schema validation, meaning invalid data can still be seeded silently.
4. **No dry-run or reporting** -- Only `seed-secrets.ts` supports `--dry-run`. Core/dev/tenant seed flows still lack preview mode.
5. **Tenant targeting is now explicit but still lightweight** -- `seed-mongo.ts` now supports `--tenant` and `--workspace-email`, and legacy `SEED_EMAIL` is deprecated, but there is still no richer `--scope` or reporting surface.
6. **Prompt default delivery is still specialized** -- The project settings API exposes a curated prompt-default subset for Studio, but this is still a bespoke bridge rather than a generalized configuration/defaults surface.

## Scope

### In Scope

- Keep platform/core seed separate from dev-only fixtures and examples
- Unify all seed scripts under a single orchestrator with `--scope` flags
- Extract a shared `upsert-helpers.ts` module to eliminate duplication
- Add Zod validation for all seed payloads before DB writes
- Ensure idempotency for all seed scripts (deterministic IDs, upsert-only)
- Add `--dry-run` and `--report` modes to the unified orchestrator
- Make all scripts tenant-parameterizable (no hardcoded tenant IDs)
- Add seed version tracking and production wipe guards
- Expose prompt template defaults through stable runtime APIs where Studio needs them
- Add proper E2E and integration tests for the seed pipeline

### Out of Scope

- UI for managing seed data (Studio admin panel)
- Multi-region seed data distribution
- Seed data for external third-party integrations (Slack, Jira connectors)
- ClickHouse data migration (handled by pipeline-engine separately)

## Requirements

### Functional Requirements

| ID    | Requirement                                                                                                                          | Priority |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------ | -------- |
| FR-1  | Unified CLI: `pnpm seed:core` seeds platform defaults, `pnpm seed:dev` seeds dev fixtures, and targeted tenant bootstrap is explicit | P0       |
| FR-2  | Shared `upsertOne()` helper extracted to `packages/database/src/seed/upsert-helpers.ts`                                              | P0       |
| FR-3  | All seed payloads validated against Zod schemas before DB write                                                                      | P0       |
| FR-4  | All seed scripts produce deterministic IDs (no random UUIDs for idempotent records)                                                  | P0       |
| FR-5  | `--dry-run` flag prints planned operations without DB writes                                                                         | P1       |
| FR-6  | `--scope <scope>` flag to run specific seed categories (rbac, llm, projects, tools, pipelines, prompts, secrets)                     | P1       |
| FR-7  | `--tenant <tenantId>` flag to target a specific tenant                                                                               | P1       |
| FR-8  | Seed version tracking via `_seed_meta` collection with version comparison                                                            | P1       |
| FR-9  | Production wipe guard: refuse `--fresh` when `NODE_ENV=production` or when deployment target is prod                                 | P0       |
| FR-10 | Project settings API returns prompt defaults needed by Studio without a separate seed-data endpoint                                  | P2       |
| FR-11 | Structured JSON report output (`--report json`) for CI integration                                                                   | P2       |

### Non-Functional Requirements

| ID    | Requirement                                                                                                       | Priority |
| ----- | ----------------------------------------------------------------------------------------------------------------- | -------- |
| NFR-1 | Seed execution completes in under 30 seconds for a full curated seed (example projects, prompts, pipelines, RBAC) | P1       |
| NFR-2 | All DB operations use transactions where available (replica set required)                                         | P2       |
| NFR-3 | Seed scripts must be runnable from both CLI and programmatically (exported functions)                             | P0       |
| NFR-4 | Zero data loss on re-run: upsert-only, never drop existing tenant customizations                                  | P0       |
| NFR-5 | Logging via `createLogger` (not `console.log`) for server-invoked paths                                           | P1       |

## User Stories

### US-1: Developer First-Time Setup

**As a** new developer setting up the platform locally,
**I want** a single `pnpm db:init` command that seeds everything,
**So that** I can start Studio + Runtime without manual DB intervention.

**Acceptance Criteria:**

- `pnpm db:init` runs migrations then the full dev seed flow
- All curated example projects, agents, tools, RBAC roles, LLM configs are present
- Studio loads without errors and shows seeded projects

### US-2: CI/CD Fresh Environment

**As a** CI pipeline or ArgoCD PreSync hook,
**I want** version-gated seed execution with fresh mode,
**So that** environments get re-seeded only when the seed data version changes.

**Acceptance Criteria:**

- `SEED_VERSION=v3 pnpm seed:core` compares against `_seed_meta` collection
- If version matches, skip wipe and only upsert new/changed records
- If version differs or `--fresh` is passed, wipe and re-seed
- Production environments refuse wipe operations

### US-3: Multi-Tenant Seed

**As a** platform operator onboarding a new enterprise tenant,
**I want** to seed tenant-critical defaults into that workspace,
**So that** it can function correctly without inheriting dev-only fixtures.

**Acceptance Criteria:**

- `pnpm tsx packages/database/seed-mongo.ts --tenant <id>` or `--workspace-email <email>` seeds tenant-critical defaults only
- Dev-only example projects are never seeded into arbitrary tenant bootstrap flows
- No cross-tenant data contamination

### US-4: Dry Run Validation

**As a** operator validating a seed update before deployment,
**I want** a dry-run mode that shows what would change,
**So that** I can review planned operations before committing them.

**Acceptance Criteria:**

- `pnpm seed:all --dry-run` prints all planned upserts with collection, filter, and data summary
- No DB writes occur
- Exit code 0 on success

### US-5: Studio Prompt Template Reset

**As a** Studio user who customized prompt templates,
**I want** to reset individual templates to platform defaults,
**So that** I can undo my overrides without a full re-seed.

**Acceptance Criteria:**

- `GET /api/projects/:projectId/settings` returns `promptDefaults` for editable advanced-setting prompts
- Studio "Reset to Default" uses `promptDefaults` from the settings payload
- Runtime falls back to PromptCatalog hardcoded values when DB-backed prompt templates are unavailable

## Known Issues

1. **Prompt defaults are route-specific:** The project settings API currently returns only the advanced-settings prompt defaults, not a generalized catalog/defaults payload.
2. **Targeted tenant bootstrap is still thin:** `--tenant` and `--workspace-email` now exist, but there is no richer `--scope` or `--report` surface yet.
3. **Legacy env targeting still exists for compatibility:** `SEED_EMAIL` still works, but only as a deprecated compatibility path behind the newer `--workspace-email` flag.

## Dependencies

- MongoDB connection (required)
- ClickHouse connection (optional, for pipeline analytics DDL)
- AWS Secrets Manager (optional, for `seed-secrets.ts`)
- `examples/` directory with `.abl` agent files (for dev-only project seeding)
- `packages/database` Mongoose models
- `packages/pipeline-engine` pipeline definitions
- `packages/shared` PromptCatalog

## Risks and Mitigations

| Risk                                          | Impact   | Mitigation                                                                   |
| --------------------------------------------- | -------- | ---------------------------------------------------------------------------- |
| Seed scripts modify production data           | Critical | Production wipe guard, `NODE_ENV` check, `SEED_VERSION` gating               |
| Duplicate records from non-idempotent scripts | High     | Deterministic IDs, upsert-only operations, unique index enforcement          |
| Seed data schema drift from model changes     | Medium   | Zod validation at seed time catches mismatches before DB write               |
| Large seed payload slows CI                   | Low      | `--scope` flag to seed only needed categories; parallel execution where safe |
