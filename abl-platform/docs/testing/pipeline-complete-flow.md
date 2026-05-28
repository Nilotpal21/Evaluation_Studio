# Feature Test Guide: Pipeline Complete Flow

**Feature**: Pipeline V2 — multi-pipeline, new stage types, CEL conditions, default/custom protection, flow routing
**Owner**: Search AI team
**Branch**: feat/pipeline-complete-flow-redesign
**First tested**: 2026-04-17
**Last updated**: 2026-04-17
**Overall status**: STABLE

---

## Current State (as of 2026-04-17)

All core pipeline scenarios pass E2E. The default pipeline creates correctly with 3 flows (Rich Docs P:10, Text Docs P:5, Default catch-all P:0) and the V2 stage types (content-intelligence, visual-analysis). Multi-pipeline works — custom pipelines can be created alongside the default. Default pipeline protection is enforced (can't delete, can't remove stages, can't change isDefault). Flow selection routing works correctly across PDF, text, and unknown document types. CEL validation works for both valid and invalid expressions. Provider schemas return correct configs for all new stage types. Three bugs were found and fixed during testing.

### Quick Health Dashboard

| Area                         | Status | Last Verified | Notes                                                                  |
| ---------------------------- | ------ | ------------- | ---------------------------------------------------------------------- |
| Pipeline CRUD                | PASS   | 2026-04-17    | Create default, create custom, update, delete                          |
| Default Pipeline Protection  | PASS   | 2026-04-17    | Can't delete, can't remove stages, can't change isDefault              |
| Custom Pipeline Full Control | PASS   | 2026-04-17    | Add/remove stages, custom-script, http-webhook with outputType         |
| Validation                   | PASS   | 2026-04-17    | Stage sequence, new types, utility stages, CEL                         |
| Publishing                   | PASS   | 2026-04-17    | Publish custom, default not archived (after bug fix)                   |
| Flow Selection / Routing     | PASS   | 2026-04-17    | PDF→Rich Docs, text→Text Docs, unknown→Default, custom-api→Custom flow |
| Multi-Flow Operations        | PASS   | 2026-04-17    | Add 4th flow with rules, flow selection matches                        |
| Delete & Fallback            | PASS   | 2026-04-17    | Delete custom activates default as fallback                            |
| CEL Validation               | PASS   | 2026-04-17    | Valid CEL accepted, invalid CEL rejected                               |
| Provider Schemas             | PASS   | 2026-04-17    | extraction, content-intelligence, visual-analysis all return schemas   |
| Fallback Status              | PASS   | 2026-04-17    | Reports valid:true for correct pipeline                                |
| Embedding Providers          | PASS   | 2026-04-17    | 4 providers returned (bge-m3, openai, cohere, custom)                  |
| DB State Consistency         | PASS   | 2026-04-17    | All records match API responses                                        |

---

## Test Coverage Map

### Pipeline CRUD

- [x] Create default pipeline — `Iteration 1 PASS`
- [x] Get all pipelines (no filter) — `Iteration 1 PASS`
- [x] Get active pipeline (?active=true) — `Iteration 1 PASS`
- [x] Create custom pipeline with name — `Iteration 1 PASS`
- [x] Get all pipelines (2 returned) — `Iteration 1 PASS`
- [x] Update custom pipeline (version increments) — `Iteration 1 PASS`

### Default Pipeline Protection

- [x] DELETE default pipeline → 400 CANNOT_DELETE_DEFAULT_PIPELINE — `Iteration 1 PASS`
- [x] Remove stages from default → 400 CANNOT_REMOVE_DEFAULT_STAGE — `Iteration 1 PASS`
- [x] Customize default config (change providerConfig) → succeeds — `Iteration 1 PASS`
- [x] Change isDefault flag → 400 CANNOT_CHANGE_DEFAULT_FLAG — `Iteration 1 PASS`

### Custom Pipeline Full Control

- [x] Add custom-script stage — `Iteration 1 PASS`
- [x] Remove stage from custom — `Iteration 1 PASS`
- [x] Add http-webhook with outputType/mode/entryPoint — `Iteration 1 PASS`

### Validation

- [x] Validate correct pipeline → valid:true — `Iteration 1 PASS`
- [x] Invalid stage sequence (chunking before extraction) → INVALID_STAGE_SEQUENCE — `Iteration 1 PASS`
- [x] Pipeline with content-intelligence + visual-analysis → valid — `Iteration 1 PASS`
- [x] Utility stage (custom-script) at any position → no sequence error — `Iteration 1 PASS`

### Publishing

- [x] Publish custom pipeline → active — `Iteration 1 PASS`
- [x] Default pipeline NOT archived after custom publish — `Iteration 1 PASS (after bug fix)`

### Flow Selection & Routing

- [x] PDF → Rich Documents (P:10) — `Iteration 1 PASS`
- [x] text/plain → Text Documents (P:5) — `Iteration 1 PASS`
- [x] Unknown type → Default (P:0) — `Iteration 1 PASS`
- [x] source.connector=custom-api → Custom API Flow (P:15) — `Iteration 1 PASS`

### Multi-Flow Operations

- [x] Add 4th flow with custom selection rules — `Iteration 1 PASS`
- [x] Flow selection matches new flow — `Iteration 1 PASS`

### Delete & Fallback

- [x] Delete custom pipeline → success — `Iteration 1 PASS`
- [x] Fallback activates default — `Iteration 1 PASS`
- [x] Only default pipeline remains — `Iteration 1 PASS`

### CEL Validation

- [x] CEL executionCondition on stage accepted — `Iteration 1 PASS`
- [x] Invalid CEL in selectionRules → INVALID_CEL_EXPRESSION — `Iteration 1 PASS`

### Provider Schemas

- [x] Extraction providers: docling, llamaindex, http-webhook, javascript-sandbox — `Iteration 1 PASS`
- [x] Content-intelligence provider + 9 config fields — `Iteration 1 PASS`
- [x] Visual-analysis provider + 7 config fields — `Iteration 1 PASS`

### Fallback Status & Embedding

- [x] Fallback status → valid:true — `Iteration 1 PASS`
- [x] Embedding providers: 4 returned — `Iteration 1 PASS`

### Not Yet Tested

- [ ] Re-publish after modifying pipeline (reindex analysis)
- [ ] Embedding config change + reindex trigger
- [ ] Cross-tenant isolation
- [ ] Concurrent pipeline edits (optimistic concurrency)
- [ ] Pipeline with >50 flows (limit validation)
- [ ] Trigger pipeline for document/source endpoints

---

## Open Gaps

- **GAP-001**: Cross-tenant isolation not tested (need second tenant)
- **GAP-002**: Pipeline trigger endpoints (trigger-pipeline for doc/source) not tested
- **GAP-003**: Reindex flow after publish not tested (requires documents in KB)

---

## Iteration Log

### Iteration 1 — 2026-04-17

**Scope**: Full E2E testing of pipeline CRUD, protection, validation, publishing, routing, CEL, providers
**Branch**: feat/pipeline-complete-flow-redesign
**Duration**: ~30min
**Tested by**: Claude Code (agent)

#### Results

| #   | Test                            | Expected                      | Actual                                | Status |
| --- | ------------------------------- | ----------------------------- | ------------------------------------- | ------ |
| 1   | Create default pipeline         | 3 flows, isDefault:true       | 3 flows, correct structure            | PASS   |
| 2   | GET all pipelines               | Returns pipeline list         | 1 pipeline returned                   | PASS   |
| 2b  | GET ?active=true                | Returns active pipeline       | Active pipeline returned              | PASS   |
| 3   | Create custom pipeline          | isDefault:false, draft        | Correct                               | PASS   |
| 4   | GET all (2 pipelines)           | 2 returned                    | 2 returned                            | PASS   |
| 5   | Update custom (version++)       | Version increments            | 1→2                                   | PASS   |
| 6   | DELETE default → blocked        | 400                           | CANNOT_DELETE_DEFAULT_PIPELINE        | PASS   |
| 7   | Remove stages default → blocked | 400                           | CANNOT_REMOVE_DEFAULT_STAGE           | PASS   |
| 8   | Customize default config        | Success                       | chunkSize updated to 500              | PASS   |
| 9   | Change isDefault flag → blocked | 400                           | CANNOT_CHANGE_DEFAULT_FLAG            | PASS   |
| 10  | Add custom-script to custom     | Accepted                      | Stage added correctly                 | PASS   |
| 11  | Remove stage from custom        | Success                       | Stage removed                         | PASS   |
| 12  | Add webhook with outputType     | Saved correctly               | mode/outputType/entryPoint saved      | PASS   |
| 13  | Validate default pipeline       | valid:true                    | valid:true (after bug fix)            | PASS   |
| 14  | Invalid sequence                | INVALID_STAGE_SEQUENCE        | Correct error                         | PASS   |
| 15  | CI + VA stages valid            | valid:true                    | valid:true                            | PASS   |
| 16  | Utility stage any position      | No sequence error             | Correct                               | PASS   |
| 17  | Publish custom                  | active                        | active, version 3                     | PASS   |
| 18  | Default not archived            | Default still exists          | Exists after bug fix                  | PASS   |
| 19  | PDF → Rich Docs                 | Rich Documents P:10           | Correct match                         | PASS   |
| 20  | text/plain → Text Docs          | Text Documents P:5            | Correct match                         | PASS   |
| 21  | Unknown → Default               | Default P:0                   | Correct match                         | PASS   |
| 22  | Add 4th flow                    | 4 flows                       | Custom API Flow added                 | PASS   |
| 23  | custom-api → new flow           | Custom API Flow P:15          | Correct match                         | PASS   |
| 24  | Delete custom                   | Success                       | Deleted, fallback activated           | PASS   |
| 25  | Fallback active                 | Default active                | Default pipeline active               | PASS   |
| 26  | Only default left               | 1 pipeline                    | 1 pipeline (default)                  | PASS   |
| 27  | CEL on stage                    | Accepted                      | valid:true                            | PASS   |
| 28  | Invalid CEL                     | INVALID_CEL_EXPRESSION        | Correct error                         | PASS   |
| 29  | Extraction schemas              | 4 providers                   | docling, llamaindex, webhook, sandbox | PASS   |
| 30  | CI schema                       | content-intelligence provider | 9 config fields                       | PASS   |
| 31  | VA schema                       | visual-analysis provider      | 7 config fields                       | PASS   |
| 32  | Fallback status                 | valid:true                    | valid:true                            | PASS   |
| 33  | Embedding providers             | ≥1 provider                   | 4 providers                           | PASS   |

#### Bugs Found & Fixed

- **BUG-001**: Default template used `field: 'mimeType'` instead of `document.mimeType` in selectionRules
  - **File**: `apps/search-ai/src/services/pipeline-orchestration/default-pipeline-template.ts`
  - **Fix**: Changed all `field: 'mimeType'` to `field: 'document.mimeType'`
  - **Verified**: Test 13 passes after fix

- **BUG-002**: LlamaIndex providerConfig was `{}` which Mongoose stored as `undefined`, failing validation
  - **File**: `apps/search-ai/src/services/pipeline-orchestration/default-pipeline-template.ts`
  - **Fix**: Changed to `{ maxContentLength: 10000000 }`
  - **Verified**: Test 13 passes after fix

- **BUG-003**: Publish route archived the default pipeline (it should never be archived)
  - **File**: `apps/search-ai/src/routes/pipelines.ts` line 751
  - **Root Cause**: `updateMany` filter didn't exclude `isDefault: true` pipelines
  - **Fix**: Added `isDefault: { $ne: true }` to the archive filter
  - **Verified**: Test 18 passes after fix

- **BUG-004** (pre-existing): Old unique index `{ tenantId, knowledgeBaseId }` blocked multi-pipeline
  - **Location**: MongoDB search_ai collection
  - **Fix**: Dropped the old index manually. New indexes `{ tenantId, knowledgeBaseId, name }` and partial `{ isDefault: true }` are correct.
  - **Note**: This index migration needs to be automated for deployments

---

## Test Environment

- SearchAI: localhost:3113 (PM2, tsx dev mode)
- MongoDB: localhost:27018 (Docker, search_ai database)
- Auth: DEV_BYPASS_AUTH=true, x-tenant-id: tenant-dev-001
- Test project: proj-search-ai-strategies
- Test KB: 019d9628-daa3-7a2c-abe7-156f86e0cece (name: Pipeline)
- Default pipeline ID: 019daa31-2676-7a55-af24-5383173b623d
