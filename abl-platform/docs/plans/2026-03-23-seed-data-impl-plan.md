# LLD + Implementation Plan: Seed Data Infrastructure

**Feature:** [Seed Data Infrastructure](../features/seed-data.md)
**HLD:** [Seed Data HLD](../specs/seed-data.hld.md)
**Test Spec:** [Seed Data Tests](../testing/seed-data.md)
**Status:** PLANNED
**Created:** 2026-03-23
**Last Updated:** 2026-03-23

---

## Phase 1: Shared Upsert Layer + Zod Validators (P0)

**Goal:** Eliminate duplicated upsert helpers across 5+ scripts. Add Zod validation to catch schema drift.

**Exit Criteria:**

- [ ] `packages/database/src/seed/upsert-helpers.ts` exists with `upsertOne()` and `upsertMany()`
- [ ] All 5 seed scripts import from shared module (zero inline upsert functions)
- [ ] `packages/database/src/seed/validators.ts` exports Zod schemas for all seed payload types
- [ ] `pnpm build --filter=@agent-platform/database` passes
- [ ] Existing `pnpm seed:all` still works (backward compatible)

### Task 1.1: Create Shared Upsert Helpers

**Files:**

- Create: `packages/database/src/seed/upsert-helpers.ts`
- Create: `packages/database/src/seed/index.ts` (barrel export)

**Implementation:**

Extract the most complete `upsertOne()` variant (from `seed-mongo.ts`) which handles:

- Simple case: `_id` to `$setOnInsert`, rest to `$set`
- Split case: `updateData` to `$set`, remaining `createData` fields to `$setOnInsert`
- `_id` immutability: always in `$setOnInsert`, never in `$set`

Add `upsertMany()` for batch operations:

```typescript
export async function upsertMany<T>(
  model: mongoose.Model<T>,
  operations: Array<{
    filter: Record<string, unknown>;
    createData: Record<string, unknown>;
    updateData?: Record<string, unknown>;
  }>,
): Promise<{ inserted: number; updated: number }> {
  // Uses bulkWrite with updateOne operations for efficiency
}
```

**Verification:** `pnpm build --filter=@agent-platform/database`

### Task 1.2: Create Zod Validators

**Files:**

- Create: `packages/database/src/seed/validators.ts`

**Implementation:**

Define Zod schemas for every seed payload type. Key rule: use `z.string().min(1)` for all ID fields (never `.cuid()`, `.cuid2()`, `.nanoid()`, `.ulid()`).

Schemas needed:

- `seedUserSchema`
- `seedTenantSchema`
- `seedTenantMemberSchema`
- `seedResourceTypeSchema`
- `seedRoleDefinitionSchema`
- `seedProjectSchema`
- `seedProjectAgentSchema`
- `seedLLMCredentialSchema`
- `seedTenantModelSchema`
- `seedTenantLLMPolicySchema`
- `seedProjectLLMConfigSchema`
- `seedProjectSettingsSchema`
- `seedModelConfigSchema`
- `seedDebugTokenSchema`
- `seedProjectToolSchema`
- `seedPromptTemplateSchema`

**Verification:** Import validators and run `.parse()` against existing seed data constants.

### Task 1.3: Refactor seed-mongo.ts to Use Shared Module

**Files:**

- Modify: `packages/database/seed-mongo.ts`

**Implementation:**

1. Replace inline `upsertOne()` with import from `./src/seed/upsert-helpers.js`
2. Add validation calls before each upsert:
   - **Fatal categories** (rbac, identity, llm): Throw on validation failure -- these records are required for platform operation
   - **Non-fatal categories** (tools, prompts, workflows): Log warning and skip record on validation failure
3. Keep all existing behavior unchanged

**Verification:** `pnpm seed:all` against local MongoDB, verify all records created.

### Task 1.4: Refactor Remaining Scripts

**Files:**

- Modify: `scripts/seed-tools.ts` -- import shared `upsertOne()`
- Modify: `scripts/seed-pipelines.ts` -- import shared `upsertOne()`
- Modify: `scripts/seed-tenant.ts` -- import shared `upsertOne()`
- Modify: `scripts/seed-travel-workflows.ts` -- import shared `upsertOne()`, fix idempotency

**Implementation for seed-travel-workflows.ts idempotency fix:**

- Replace `uuidv7()` for workflow `_id` with deterministic IDs: `wf-<projectSlug>-<workflowName>`
- Use upsert instead of insert (current script may create duplicates)

**Verification:** Run each script individually and verify behavior unchanged.

---

## Phase 2: Seed Orchestrator (P1)

**Goal:** Unified CLI that runs all seed categories in correct dependency order with flag support.

**Exit Criteria:**

- [ ] `packages/database/src/seed/orchestrator.ts` exists with category registry
- [ ] `--scope` flag filters categories
- [ ] `--dry-run` flag previews operations
- [ ] `--tenant` flag targets specific tenant
- [ ] `--fresh` flag with production guard
- [ ] `pnpm seed:all` uses orchestrator
- [ ] All categories execute in correct order

### Task 2.1: Create Category Registry

**Files:**

- Create: `packages/database/src/seed/categories/rbac.ts`
- Create: `packages/database/src/seed/categories/identity.ts`
- Create: `packages/database/src/seed/categories/llm.ts`
- Create: `packages/database/src/seed/categories/projects.ts`
- Create: `packages/database/src/seed/categories/tools.ts`
- Create: `packages/database/src/seed/categories/prompts.ts`
- Create: `packages/database/src/seed/categories/pipelines.ts`
- Create: `packages/database/src/seed/categories/workflows.ts`

**Implementation:**

Each category exports a `SeedCategory` interface:

```typescript
export interface SeedCategory {
  name: string;
  dependencies: string[]; // names of categories that must run first
  seed(ctx: SeedContext): Promise<SeedCategoryResult>;
}

export interface SeedContext {
  tenantId: string;
  userId: string;
  dryRun: boolean;
  examplesDir: string;
  env: Record<string, string | undefined>;
}

export interface SeedCategoryResult {
  inserted: number;
  updated: number;
  skipped: number;
  errors: Array<{ collection: string; filter: string; error: string }>;
}
```

Extract the relevant sections from `seed-mongo.ts` into each category file.

### Task 2.2: Build Orchestrator

**Files:**

- Create: `packages/database/src/seed/orchestrator.ts`

**Implementation:**

```typescript
// Topological sort of categories by dependencies
// Parse CLI flags: --fresh, --dry-run, --scope, --tenant, --report
// Connect to MongoDB
// Execute categories in order
// Collect and report results
```

Key behaviors:

- `--scope rbac,llm` -- only run rbac and llm categories (plus their dependencies)
- `--dry-run` -- set `ctx.dryRun = true`, each category logs planned ops instead of writing
- `--tenant <id>` -- override `ctx.tenantId`
- `--fresh` -- wipe database before seeding (with production guard)
- `--report json` -- output JSON summary to stdout

### Task 2.3: Create Seed Version Tracker

**Files:**

- Create: `packages/database/src/seed/seed-version.ts`

**Implementation:**

Extract `_seed_meta` logic from `seed-mongo.ts`:

```typescript
export async function getSeedVersion(db: Db): Promise<string | null>;
export async function setSeedVersion(db: Db, version: string): Promise<void>;
export async function shouldWipe(
  db: Db,
  requestedVersion?: string,
  fresh?: boolean,
): Promise<boolean>;
```

### Task 2.4: Update npm Scripts

**Files:**

- Modify: `package.json`

**Implementation:**

```json
{
  "seed:all": "tsx packages/database/src/seed/orchestrator.ts",
  "seed:rbac": "tsx packages/database/src/seed/orchestrator.ts --scope rbac",
  "seed:projects": "tsx packages/database/src/seed/orchestrator.ts --scope projects"
}
```

Keep backward compatibility: individual scripts still work when run directly.

---

## Phase 3: Runtime API Extension (P2)

**Goal:** Extend `/api/seed-data` to serve additional seed data categories beyond prompt templates.

**Exit Criteria:**

- [ ] `GET /api/seed-data?category=rbac` returns resource types and role definitions
- [ ] `GET /api/seed-data?category=defaults` returns default LLM policy and model config
- [ ] Existing `?keys=` param unchanged
- [ ] OpenAPI spec updated
- [ ] Rate limiting preserved

### Task 3.1: Extend Seed Data Route

**Files:**

- Modify: `apps/runtime/src/routes/seed-data.ts`

**Implementation:**

Add new route handler for `?category=` param:

```typescript
// Existing: GET /api/seed-data?keys=system_prompt.base,llm_prompt.handoff
// New:      GET /api/seed-data?category=rbac
// New:      GET /api/seed-data?category=defaults
```

Category handlers:

- `rbac`: Query `ResourceType.find({ isSystem: true })` and `RoleDefinition.find({ tenantId, isSystem: true })`
- `defaults`: Query `TenantLLMPolicy.findOne({ tenantId })` and `TenantModel.findOne({ tenantId, isDefault: true })`

**Verification:** `curl http://localhost:3112/api/seed-data?category=rbac` returns resource types.

### Task 3.2: Update Studio Proxy

**Files:**

- Modify: `apps/studio/src/app/api/seed-data/route.ts`

**Implementation:** No changes needed -- the proxy already forwards all query params.

### Task 3.3: Fix Console.log in Studio Proxy

**Files:**

- Modify: `apps/studio/src/app/api/seed-data/route.ts`

**Implementation:** Replace `console.error` with structured error handling per platform rules (Studio uses Next.js so `console.error` is acceptable in route handlers, but should include structured context).

---

## Phase 4: Tests (P0-P1)

**Goal:** Comprehensive test coverage for the seed data infrastructure.

**Exit Criteria:**

- [ ] Unit tests for upsert helpers and validators
- [ ] Integration tests against MongoMemoryServer
- [ ] E2E tests for runtime seed-data API
- [ ] All tests pass in CI

### Task 4.1: Unit Tests for Shared Modules

**Files:**

- Create: `packages/database/src/seed/__tests__/upsert-helpers.test.ts`
- Create: `packages/database/src/seed/__tests__/validators.test.ts`

**Test Cases:**

- `upsertOne()` insert path -- verify `$setOnInsert` for `_id`
- `upsertOne()` update path -- verify `$set` for update fields, `$setOnInsert` for create-only fields
- `upsertOne()` `_id` immutability -- verify `_id` never in `$set`
- Validators -- parse valid payloads, reject invalid (missing required fields, wrong types)
- Validators -- reject `.cuid()` IDs (must be `z.string().min(1)`)

### Task 4.2: Unit Tests for Tool DSL Extraction

**Files:**

- Create: `scripts/__tests__/seed-tools-extraction.test.ts`

**Test Cases:**

- Format A: inline signature parsing
- Format B: NAME block parsing
- Format C: key-value map parsing
- Format D: simple list parsing
- Tool name validation regex
- HTTP tool DSL preservation
- Sandbox tool mock code generation

### Task 4.3: Integration Tests

**Files:**

- Create: `packages/database/src/seed/__tests__/seed-integration.test.ts`

**Test Cases (against MongoMemoryServer):**

- Full seed pipeline: run orchestrator, verify all collections populated
- Idempotent re-seed: run twice, verify no duplicates
- Seed version tracking: version match skips wipe, version mismatch triggers wipe
- Conditional LLM credentials: no env var = no credential record
- Pipeline config preservation: re-seed does not overwrite `enabled` flag

### Task 4.4: E2E Tests for Runtime API

**Files:**

- Create: `apps/runtime/src/__tests__/seed-data-e2e.test.ts`

**Test Cases (real Express server on random port):**

- `GET /api/seed-data?keys=system_prompt.base` -- returns template from DB
- `GET /api/seed-data?keys=nonexistent` -- returns empty (key omitted, not error)
- `GET /api/seed-data` (no keys) -- returns `{ success: true, data: {} }`
- `GET /api/seed-data?keys=<51 keys>` -- returns 400
- `GET /api/seed-data` without auth -- returns 401
- PromptCatalog fallback: key exists in catalog but not DB -- returns catalog value

---

## Wiring Checklist

After implementation, verify these integration points:

- [ ] `package.json` `seed:all` script calls orchestrator
- [ ] `package.json` `db:init` calls migrations then seed
- [ ] `apps/runtime/src/server.ts` mounts seed-data router at `/api/seed-data`
- [ ] `apps/studio/src/app/api/seed-data/route.ts` proxies to runtime
- [ ] All category files registered in orchestrator's category registry
- [ ] `packages/database/src/seed/index.ts` exports `upsertOne`, `upsertMany`, validators
- [ ] `packages/database/package.json` includes `src/seed/` in build outputs

## Risk Register

| Risk                                       | Likelihood | Impact | Mitigation                                                |
| ------------------------------------------ | ---------- | ------ | --------------------------------------------------------- |
| Refactoring breaks `seed:all` in CI        | Medium     | High   | Run full seed in CI before merging                        |
| Zod validation rejects existing valid data | Medium     | Medium | Run validators against current seed data in tests         |
| Category extraction changes behavior       | Low        | High   | Integration tests verify record counts match before/after |
| MongoMemoryServer version mismatch         | Low        | Low    | Pin version in devDependencies                            |
