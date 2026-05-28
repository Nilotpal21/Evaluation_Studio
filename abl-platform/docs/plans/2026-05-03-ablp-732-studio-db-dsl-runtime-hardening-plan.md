# LLD: ABLP-732 Studio to DB to DSL to Runtime Hardening

**Status**: IN PROGRESS
**Date**: 2026-05-03

## Design Decisions

| #    | Decision                                                                                                              | Rationale                                                                                                                                  |
| ---- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| D-1  | Treat Studio import, Runtime project-io import, direct tool creation, and runtime loading as the same trust boundary. | Tool bindings are persisted as DSL strings, so every save/import path must run the same structural and referential checks before DB write. |
| D-2  | Generated DSL must be emitted through safe quoting, never raw interpolation.                                          | SearchAI names/descriptions are user-controlled and parser property extraction is line-oriented with last-write-wins behavior.             |
| D-3  | Auto-created SearchAI tools are part of KB/index creation success.                                                    | Returning a KB/index before its ProjectTool exists creates immediate Studio-to-runtime drift.                                              |
| D-4  | Peer DSL parse errors are blocking version errors.                                                                    | Version creation compiles and caches peer IR; silently dropping malformed peers makes runtime state incomplete or stale.                   |
| D-5  | SearchAI management routes must honor both `projectId` and API-key `projectScope`.                                    | Runtime execution is project-scoped; allowing management APIs to mutate tenant-wide indexes recreates cross-project binding drift.         |
| D-6  | SearchIndex + generated ProjectTool lifecycle must be treated as one logical write.                                   | If registration fails after the SearchIndex exists, later retries can see slug conflicts while runtime still has no generated tool.        |
| D-7  | Index deletion must invalidate runtime ownership/discovery caches before returning success.                           | Runtime ownership cache TTLs are safety nets, not correctness guarantees for deleted project-scoped resources.                             |
| D-8  | Runtime-backed Studio tool tests return sanitized user-facing errors only.                                            | Internal URLs, tenant/project IDs, and remediation detail belong in logs/traces, not the Studio Test button.                               |
| D-9  | Every SearchAI route that accepts `indexId` must share one project-aware index-ownership contract.                    | CRUD hardening is incomplete if sources/documents/uploads/ingest routes can still access same-tenant cross-project indexes.                |
| D-10 | SearchAI delete success requires a complete lifecycle transition, not just SearchIndex removal.                       | Deleting the index before unregister/cache cleanup creates an unrecoverable stale ProjectTool path on partial failure.                     |
| D-11 | User-facing Studio test errors must be sanitized at both the runtime response path and the Studio network path.       | Runtime can sanitize its own responses, but fetch/abort failures are generated in Studio and never pass through runtime sanitizers.        |

## Slice Plan

### Slice 1: Runtime Project-IO Binding Validation

**Goal**: Runtime import/preview passes an async validator equivalent to Studio import.

**Files**:

- `apps/runtime/src/routes/project-io.ts`
- `apps/runtime/src/__tests__/project-io-routes.test.ts`

**Test Lock**:

- Assert `/import/preview` and `/import` pass `validateToolBindingForSave` into the shared planner.

**Exit Criteria**:

- Focused project-io route tests pass.
- Runtime build/typecheck for changed route passes or any unrelated blockers are documented.

### Slice 2: Safe SearchAI DSL Generation

**Goal**: SearchAI-generated DSL cannot inject or override binding properties via KB/index name or description.

**Files**:

- `apps/search-ai/src/services/searchai-tool-registration.ts`
- `apps/search-ai/src/services/__tests__/searchai-tool-registration.test.ts`

**Test Lock**:

- Register a KB name containing a newline and `index_id:` injection attempt; parsed DSL must still bind the real index and tenant.

**Exit Criteria**:

- Focused SearchAI registration tests pass.

### Slice 3: Await SearchAI Tool Registration

**Goal**: KB/index create/update paths do not return success before generated ProjectTool registration has completed.

**Files**:

- `apps/search-ai/src/routes/indexes.ts`
- `apps/search-ai/src/routes/knowledge-bases.ts`
- route/service tests

**Test Lock**:

- Registration failures propagate from `registerSearchAITool`.
- Create route awaits registration before responding.

**Exit Criteria**:

- Focused SearchAI route and registration tests pass.

### Slice 4: Peer DSL Parse Fail Closed

**Goal**: Version creation blocks malformed peer DSL before compilation/cache.

**Files**:

- `apps/runtime/src/services/version-service.ts`
- `apps/runtime/src/__tests__/version-service-ir-purity.test.ts`

**Test Lock**:

- Malformed peer DSL returns `compileErrors`, creates no version, and caches no IR.

**Exit Criteria**:

- Focused version-service tests pass.

### Slice 5: Project-Scoped SearchAI Index CRUD

**Goal**: SearchAI index management matches runtime execution isolation for user tokens and project-scoped API keys.

**Files**:

- `apps/search-ai/src/routes/indexes.ts`
- `apps/search-ai/src/routes/knowledge-bases.ts`
- `apps/search-ai/src/routes/project-scope.ts`
- route tests

**Test Lock**:

- List filters include `projectId: { $in: projectScope }` for project-scoped API keys.
- Create with a body `projectId` outside `projectScope` returns a non-leaky 404 and does not create a SearchIndex.
- Update/delete filters include the resolved project scope.

**Exit Criteria**:

- Project-scoped SearchAI CRUD cannot create, mutate, or delete indexes outside the authenticated scope.

### Slice 6: Atomic SearchAI Tool Lifecycle

**Goal**: KB/index create and delete routes do not leave long-lived SearchIndex ↔ ProjectTool drift.

**Files**:

- `apps/search-ai/src/routes/indexes.ts`
- `apps/search-ai/src/routes/knowledge-bases.ts`
- `apps/search-ai/src/services/searchai-tool-registration.ts`

**Test Lock**:

- Failed generated-tool registration removes the just-created SearchIndex and canonical schema before responding.
- Delete routes await generated-tool unregister and runtime cache invalidation before responding.

**Exit Criteria**:

- Create failures are compensating-cleaned, and delete success means management DB state and runtime caches have both been handled.

### Slice 7: Sanitized Internal Tool Errors

**Goal**: Runtime-backed Studio tool tests preserve raw diagnostics in logs but return only safe user copy.

**Files**:

- `apps/runtime/src/routes/internal-tools.ts`
- `apps/runtime/src/routes/__tests__/internal-tools-project-scope.test.ts`

**Test Lock**:

- A raw workflow/SearchAI/tool loading failure containing URLs and tenant/project IDs returns `TOOL_EXECUTION_FAILED` with generic safe text.

**Exit Criteria**:

- Studio Test button cannot display raw internal execution details from the internal tool route.

### Slice 8: SearchAI Per-Index Ownership Closure

**Goal**: All per-index SearchAI management paths fail closed using tenant plus project scope.

**Files**:

- `apps/search-ai/src/routes/project-scope.ts`
- `apps/search-ai/src/routes/sources.ts`
- `apps/search-ai/src/routes/documents.ts`
- adjacent SearchAI route families that verify `SearchIndex` by `indexId`

**Test Lock**:

- Conflicting `projectId` and `projectScope` resolves to a no-match DB filter.
- Source creation scopes `SearchIndex.findOne` by API-key `projectScope`.
- Document listing scopes `SearchIndex.findOne` by API-key `projectScope`.

**Exit Criteria**:

- Representative per-index routes prove projectScope is enforced, and the shared helper is reusable for remaining index routes.

### Slice 9: SearchAI Delete Lifecycle Closure

**Goal**: Delete paths avoid deleting SearchIndex before generated-tool cleanup can fail.

**Files**:

- `apps/search-ai/src/routes/indexes.ts`
- `apps/search-ai/src/routes/knowledge-bases.ts`
- route tests

**Test Lock**:

- If generated-tool unregister fails, direct index delete does not remove the SearchIndex first.
- Runtime cache invalidation runs after successful SearchIndex removal even when no generated tool existed.

**Exit Criteria**:

- A failed unregister no longer leaves a deleted index with a live generated ProjectTool and stale runtime cache.

### Slice 10: Studio Tool-Test Network Sanitization

**Goal**: Runtime-backed tool tests sanitize both runtime response errors and Studio-generated fetch failures.

**Files**:

- `apps/studio/src/services/tool-test-service.ts`
- `apps/studio/src/__tests__/tool-test-service.test.ts`

**Test Lock**:

- A failed `fetch()` containing an internal runtime URL returns generic safe ToolExecutionError copy.

**Exit Criteria**:

- Studio Tool Test never surfaces internal runtime URLs/hostnames for SearchAI/workflow tool tests.

### Slice 11: KB Linked-Index Project Consistency

**Goal**: KB detail responses do not embed indexes outside the KB project.

**Files**:

- `apps/search-ai/src/routes/knowledge-bases.ts`
- `apps/search-ai/src/routes/__tests__/knowledge-bases.test.ts`

**Test Lock**:

- KB detail fetches the linked SearchIndex with project scope and returns `index: null` for mismatched legacy links.

**Exit Criteria**:

- Scoped KB responses cannot leak cross-project SearchIndex config through denormalized `searchIndexId`.

## Acceptance

- All regression tests fail before their slice fix and pass after.
- Changed files are formatted with Prettier.
- No unrelated worktree changes are reverted or overwritten.
