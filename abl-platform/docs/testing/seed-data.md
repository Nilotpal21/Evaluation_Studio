# Test Spec: Seed Data Infrastructure

**Feature:** [Seed Data Infrastructure](../features/seed-data.md)
**Status:** ALPHA
**Created:** 2026-03-23
**Last Updated:** 2026-04-03

---

## Coverage Matrix

| Component                                      | Unit Tests | Integration Tests | E2E Tests |
| ---------------------------------------------- | ---------- | ----------------- | --------- |
| `upsert-helpers.ts` (shared module)            | 8          | 2                 | --        |
| `seed-mongo.ts` (main orchestrator)            | 3          | 4                 | 2         |
| `seed-examples.ts` (project + agent seeding)   | 4          | 2                 | 1         |
| `seed-inline-tools.ts` (inline DSL extraction) | 4          | 2                 | 1         |
| `seed-pipelines.ts` (internal helper)          | 3          | 2                 | 1         |
| `seed-prompt-templates.ts` (internal helper)   | 3          | 2                 | 1         |
| Runtime project settings `promptDefaults`      | 2          | 3                 | 2         |
| Studio advanced settings default loading       | 1          | 1                 | 1         |
| Production wipe guard                          | 3          | 1                 | --        |
| Seed version tracking (`_seed_meta`)           | 3          | 2                 | 1         |
| **Totals**                                     | **34**     | **20**            | **10**    |

## E2E Test Scenarios

All E2E tests interact via HTTP API only. No mocks. No direct DB access. Real servers on random ports.

### E2E-1: Full Dev Seed Pipeline End-to-End

**Description:** Run `pnpm seed:dev` against a real MongoDB instance, then verify both platform defaults and dev-only example content exist via the runtime API.

**Preconditions:** Clean MongoDB instance (or `--fresh` flag).

**Steps:**

1. Start MongoDB via Docker or MongoMemoryReplSet
2. Run `pnpm seed:dev` (or invoke `main()` programmatically with `--dev`)
3. Start runtime server on random port
4. `GET /api/projects/proj-travel/settings` -- verify `promptDefaults.llm_prompt.entity_extraction` is returned
5. `GET /api/projects` -- verify example projects exist (travel, guardrails, etc.)
6. `GET /api/projects/proj-travel/agents` -- verify agents seeded
7. Verify ResourceType records via admin API

**Expected:** Curated example projects exist only in the dev workspace, tenant defaults are present, and prompt templates are accessible.

### E2E-2: Idempotent Re-Seed

**Description:** Run `pnpm seed:dev` twice and verify no duplicate records are created.

**Steps:**

1. Run `pnpm seed:dev` -- record counts of all collections
2. Run `pnpm seed:dev` again
3. Compare collection counts -- must be identical
4. Verify updated timestamps changed but record IDs unchanged

**Expected:** Zero new records on second run. Same IDs. Updated `updatedAt` timestamps.

### E2E-3: Seed Version Gating

**Description:** Verify `SEED_VERSION` mechanism correctly gates wipe operations.

**Steps:**

1. Run `SEED_VERSION=v1 pnpm seed:core` -- seeds and records version
2. Run `SEED_VERSION=v1 pnpm seed:core` -- should skip wipe (version matches)
3. Run `SEED_VERSION=v2 pnpm seed:core` -- should wipe and re-seed
4. Verify `_seed_meta.seed_version` is `v2`

**Expected:** Version match skips wipe. Version mismatch triggers wipe + re-seed.

### E2E-4: Project Settings Prompt Defaults with PromptCatalog Fallback

**Description:** Verify the project settings API returns prompt defaults needed by Studio, with PromptCatalog-backed values available even when prompt template rows are missing.

**Steps:**

1. Seed prompt templates
2. Start runtime server
3. `GET /api/projects/:projectId/settings`
4. Verify `promptDefaults` includes the advanced-settings keys with correct content
5. Verify returned defaults still exist when prompt template rows are absent
6. Verify PromptCatalog-backed fallback provides the value

**Expected:** The settings response includes `promptDefaults` populated from platform defaults, with PromptCatalog-backed fallback behavior when DB rows are missing.

### E2E-5: Existing Workspace Bootstrap via `--workspace-email`

**Description:** Seed tenant-critical defaults into an existing signed-up workspace and verify it stays isolated from the dev fixtures flow.

**Steps:**

1. Create a non-dev workspace through the normal signup flow
2. Run `pnpm tsx packages/database/seed-mongo.ts --workspace-email <workspace-owner-email>`
3. Verify the target workspace has roles, prompt templates, `TenantLLMPolicy`, and tenant pipeline configs
4. Verify curated dev example projects were not added to that workspace
5. Verify `tenant-dev-001` data is unchanged
6. Optionally repeat with `SEED_EMAIL=<workspace-owner-email>` and verify the deprecated compatibility path still works
7. Verify queries remain tenant-scoped (no cross-workspace leakage)

**Expected:** Complete tenant isolation. Tenant bootstrap adds only operational defaults, not dev fixtures.

### E2E-6: Production Wipe Guard

**Description:** Verify that `--fresh` is refused in production environments.

**Steps:**

1. Set `NODE_ENV=production`
2. Run `seed-mongo.ts --fresh`
3. Verify process exits with error code and error message
4. Verify no database operations were performed

**Expected:** Exit code 1. Error message: "FATAL: database wipe is not allowed in production".

### E2E-7: Dry Run Mode

**Description:** Verify `--dry-run` lists planned operations without writing to DB.

**Steps:**

1. Run `seed-mongo.ts --dry-run` (once dry-run is implemented)
2. Capture stdout
3. Verify output contains planned operations (collection names, filter criteria)
4. Verify DB has zero new records

**Expected:** Descriptive output. Zero DB writes.

### E2E-8: Example Tool Extraction and Storage

**Description:** Verify the example seeding flow correctly extracts tools from both `.tools.abl` files and inline agent `TOOLS:` blocks, then creates `project_tools` records.

**Steps:**

1. Run `seed-mongo.ts --dev` to create projects with agents
2. Query `project_tools` collection via API
3. Verify tools sourced from `.tools.abl` files are present
4. Verify inline agent tools are also present when no standalone `.tools.abl` definition exists
5. Verify tools have correct `toolType` (http, sandbox, mcp, searchai)
6. Verify tool DSL content includes sandbox code or HTTP config as appropriate

**Expected:** All valid project tools are extracted during example seeding and stored as `project_tools`.

### E2E-9: Pipeline Definitions and Configs

**Description:** Verify platform/core seed creates pipeline definitions, and tenant bootstrap creates tenant-level configs through the internal pipeline helper.

**Steps:**

1. Run `pnpm seed:core`
2. Query pipeline definitions -- verify all builtin definitions are present
3. Create or identify a tenant, then run `pnpm tsx packages/database/seed-mongo.ts --tenant <tenantId>`
4. Query pipeline configs for that tenant -- verify one per pipeline type
5. Verify configs default to `enabled: false`

**Expected:** Core seed creates builtin definitions only. Tenant bootstrap creates one disabled config per type for the targeted workspace.

### E2E-10: Project Settings Default Payload

**Description:** Verify the project settings API returns prompt defaults in the same response as editable settings.

**Steps:**

1. Start runtime server
2. `GET /api/projects/:projectId/settings`
3. Verify `settings` and `promptDefaults` are both present in one response

**Expected:** A single authenticated request returns both working-copy settings and prompt defaults.

## Integration Test Scenarios

### INT-1: Shared Upsert Helper -- Insert Then Update

**Preconditions:** MongoMemoryServer running.

**Steps:**

1. Call `upsertOne(Model, filter, createData)` -- new record
2. Verify record created with all fields
3. Call `upsertOne(Model, filter, createData, updateData)` -- existing record
4. Verify `$set` fields updated, `$setOnInsert` fields unchanged

**Expected:** First call inserts. Second call updates only `updateData` fields.

### INT-2: Shared Upsert Helper -- ID Immutability

**Steps:**

1. Call `upsertOne` with `_id` in `createData`
2. Verify `_id` in `$setOnInsert` (not `$set`)
3. Call again with different `_id` in `createData`
4. Verify `_id` unchanged (original value preserved)

**Expected:** `_id` is never overwritten on existing records.

### INT-3: Seed Prompt Templates -- Full Catalog Coverage

**Steps:**

1. Call `seedPromptTemplates()` against MongoMemoryServer
2. Query all prompt_template records
3. Verify every key in PromptCatalog has a corresponding DB record
4. Verify categories are correctly assigned

**Expected:** 1:1 mapping between PromptCatalog entries and DB records.

### INT-4: Seed Mongo -- ResourceType Operations

**Steps:**

1. Run seed with ResourceType data
2. Query ResourceType records
3. Verify 10 resource types: tenant, project, agent, tool, environment, knowledge_base, workflow, deployment, api_key, secret
4. Verify each has correct operations array

**Expected:** All resource types with complete operation definitions.

### INT-5: Seed Mongo -- LLM Credential Conditional Creation

**Steps:**

1. Run seed WITHOUT `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`
2. Verify no LLMCredential records created
3. Set `ANTHROPIC_API_KEY=test-key`
4. Run seed again
5. Verify Anthropic credential created, OpenAI not created

**Expected:** Credentials only created when env vars are set.

### INT-6: Tool DSL Extraction -- All 4 Formats

**Steps:**

1. Feed each DSL format (inline signature, NAME block, key-value, simple list) to `extractToolsFromDsl()`
2. Verify correct tool name, signature, description, toolType for each
3. Verify HTTP tools preserve endpoint and auth config

**Expected:** All 4 DSL formats correctly parsed.

### INT-7: Tool Name Validation

**Steps:**

1. Feed DSL with valid tool names (`search_hotels`, `get_balance`)
2. Feed DSL with invalid tool names (`SearchHotels`, `123_bad`, `a`)
3. Verify valid names accepted, invalid names rejected

**Expected:** Only names matching `^[a-z][a-z0-9_]{0,62}[a-z0-9]$` accepted.

### INT-8: Seed Version Tracking

**Steps:**

1. Run seed with `SEED_VERSION=v1`
2. Query `_seed_meta` collection
3. Verify `{ key: 'seed_version', value: 'v1', appliedAt: <date> }`
4. Run seed with `SEED_VERSION=v1` again
5. Verify `shouldWipe` is false (version matches)

**Expected:** Version stored and compared correctly.

### INT-9: Pipeline Config Upsert Does Not Overwrite Tenant Customizations

**Steps:**

1. Seed tenant pipeline configs (all `enabled: false`)
2. Manually update one config to `enabled: true, config: { threshold: 0.8 }`
3. Re-run `seedPipelines()`
4. Verify `enabled` and `config` are still `true` and `{ threshold: 0.8 }`

**Expected:** Only `updatedBy` field changes on re-run. Tenant customizations preserved.

### INT-10: Project Settings Prompt Defaults -- Authentication Required

**Steps:**

1. `GET /api/projects/:projectId/settings` without auth header
2. Verify 401 response
3. `GET /api/projects/:projectId/settings` with valid auth
4. Verify 200 response

**Expected:** Auth middleware enforced.

### INT-11: Project Settings Prompt Defaults -- Rate Limiting

**Steps:**

1. Send 100+ requests rapidly to `GET /api/projects/:projectId/settings`
2. Verify rate limit response (429) after threshold

**Expected:** Tenant rate limiting applied.

### INT-12: Project Settings Prompt Defaults -- Present by Default

**Steps:**

1. `GET /api/projects/:projectId/settings`
2. Verify response contains `{ success: true, settings: {...}, promptDefaults: {...} }`
3. Verify `promptDefaults` includes expected advanced-settings keys

**Expected:** Prompt defaults are always included in the authenticated settings response.

### INT-13: Prompt Defaults Mapping

**Steps:**

1. Fetch project settings for a seeded project
2. Verify `promptDefaults` includes `llm_prompt`, `tool_description.shared`, and `escalation` keys used by Studio
3. Verify each value matches the expected PromptCatalog-backed default
4. Verify unknown keys are not included

**Expected:** The settings API exposes the curated PromptCatalog-backed defaults Studio needs, and no unsupported keys are returned.

### INT-14: Project Agent DSL Loading from examples/

**Steps:**

1. Verify examples directory structure
2. Run seed for a project with agents in root and `agents/` subdirectory
3. Verify both root and subdirectory agents are loaded
4. Verify `agentPath` format is `<dir>/<subdir><name>`

**Expected:** Agents from both locations loaded with correct paths.

### INT-15: Debug Token Rotation on Re-Seed

**Steps:**

1. Run seed -- record debug token value
2. Run seed again -- record new debug token value
3. Verify tokens are different (new random bytes each run)
4. Verify token ID (`debug-dev-001`) is preserved

**Expected:** Token value rotated. Token record ID unchanged.

## Unit Test Scenarios

Unit tests for pure functions (no DB, no I/O).

- `extractToolsSection()` -- extracts TOOLS: block from DSL
- `extractToolsFromDsl()` -- parses all 4 formats
- `parseInlineSignatureTool()` -- Format A parsing
- `parseNameBlockTool()` -- Format B parsing
- `parseKeyValueTool()` -- Format C parsing
- `buildSandboxDsl()` -- generates sandbox tool DSL
- `buildOriginalDsl()` -- preserves HTTP/MCP DSL
- `isValidToolName()` -- regex validation
- `computeSourceHash()` -- deterministic SHA-256
- `buildSeedEntries()` -- PromptCatalog flattening
- `getCatalogFallback()` -- key-to-category routing
- `generateValue()` -- random bytes generation for secrets

## Test Infrastructure

- **MongoDB:** MongoMemoryReplSet for integration tests (replica set required for transactions)
- **Runtime server:** Started on `{ port: 0 }` with full middleware chain
- **Auth:** Dev token authentication for E2E tests
- **Cleanup:** Each test drops its database before running
