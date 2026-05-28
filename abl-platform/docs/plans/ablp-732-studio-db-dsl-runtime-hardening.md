# ABLP-732 Studio to Runtime Tool DSL Hardening

## Goal

Make Project Tool authoring and reuse future-ready across the full path:

Studio authoring -> Project Tool DB record -> agent DSL insertion -> parser output -> runtime tool resolution.

The design closes the known gaps without broad refactors:

- One shared Studio snippet builder for every project-tool picker.
- One runtime-mounted name format for imported module tools.
- One importable tool-type list aligned with DB/runtime support.
- One route-level DSL consistency gate before raw DSL is persisted.
- One semantic validation step that fails malformed type-specific DSL at save time.
- One parser diagnostic path for signature-looking lines that are not valid tool signatures.

## Design

### Snippet Generation

Project tool insertion must preserve the saved DSL signature line. The snippet builder reads the first line of `dslContent` and falls back to parsed params plus `object` return type only when the signature is absent.

Owner:

- `apps/studio/src/components/abl/tool-snippets.ts`

Consumers:

- `ToolPickerDialog`
- `ToolPickerModal`

### Imported Module Tools

Imported module tools must be inserted with the runtime-mounted symbol name:

```abl
alias__tool_name()
```

Studio may display `alias.tool_name` for readability, but inserted DSL must use the mounted name because parser/runtime resolution operate on bare tool symbols.

Owner:

- `buildImportedToolReferenceSnippet()`

### Import Type Parity

The import route must accept the same project tool types supported by DB/runtime:

```ts
http | sandbox | mcp | searchai | workflow;
```

This restores export/import parity for workflow tools and avoids leaving SearchAI as a special one-way type.

Owner:

- `apps/studio/src/lib/tool-dsl-consistency.ts`
- `apps/studio/src/app/api/projects/[id]/tools/import/route.ts`

### DSL Consistency Gate

Routes that persist raw `dslContent` must reject split-brain records before they reach runtime:

- Signature name must match persisted `name`.
- DSL `type:` must match persisted `toolType`.
- DSL must start with a valid tool signature.
- DSL must include a `type:` property.

Owners:

- `PUT /api/projects/:id/tools/:toolId`
- `POST /api/projects/:id/tools/import`

Rename-only updates are treated as DSL-changing updates. When the request changes `name` but omits `dslContent`, the route rewrites the first DSL signature line to the new name and recomputes `sourceHash` before persistence.

### Semantic DSL Validation

Consistency checks are necessary but not sufficient. Persisted raw DSL must also pass the existing Project Tool validator so type-specific requirements are enforced before runtime:

- HTTP tools require endpoint and method.
- Workflow tools require `workflow_id` and `trigger_id`.
- SearchAI tools require `index_id` and `tenant_id`.
- Sandbox and MCP tools must compile to valid bindings.

Owner:

- `validateProjectToolDslForPersistence()`

### Parser Diagnostics

Agent DSL and standalone `.tools.abl` parsing must not silently skip signature-looking lines. If a line contains a call shape but the tool name is invalid, the parser emits a diagnostic instead of producing a clean parse with missing tools.

## Test-Locking Slices

### Slice 1: Project Tool Signature Preservation

Tests:

- `ToolPickerDialog - Project Tools / inserts the full tool signature from project tool DSL`
- `ToolPickerModal - Project Tools / inserts the full tool signature from project tool DSL`
- Core parser optional-return tests for agent DSL and standalone `.tools.abl`

### Slice 2: Imported Module Tool Runtime Name

Tests:

- `ToolPickerDialog - Imported Tools / imported tools are selectable via Insert button`

Expected insertion:

```abl
db_mod__run_query()
```

### Slice 3: Import Type Parity

Tests:

- `POST /api/projects/:id/tools/import / imports workflow tool exports`
- `POST /api/projects/:id/tools/import / imports searchai tool exports`

### Slice 4: Route-Level DSL Consistency

Tests:

- `PUT /api/projects/:id/tools/:toolId / rejects dslContent updates when the signature name diverges from the stored tool name`
- `POST /api/projects/:id/tools/import / rejects imports when dslContent type disagrees with the persisted toolType`

### Slice 5: Rename-Only Update Consistency

Tests:

- `PUT /api/projects/:id/tools/:toolId / rewrites dslContent and sourceHash when renaming without an explicit DSL update`

### Slice 6: Type-Specific Save-Time Validation

Tests:

- `PUT /api/projects/:id/tools/:toolId / rejects dslContent updates that fail type-specific validation`
- `POST /api/projects/:id/tools/import / rejects imports that fail type-specific DSL validation`

### Slice 7: Invalid Signature Diagnostics

Tests:

- `reports invalid dotted agent TOOLS signatures instead of silently dropping them`
- `reports invalid dotted standalone .tools.abl signatures too`

## Verification

Required loop:

1. `npx prettier --write <changed files>`
2. `pnpm exec turbo build --filter=@agent-platform/shared --filter=@abl/core --filter=@agent-platform/studio`
3. Focused Studio vitest suites for tool pickers and tool routes.
4. Focused Core parser vitest suites.

## 2026-05-05 SearchAI Project-Scope And Binding Closure

### Design Decisions

- SearchAI project routes must check `tenantContext.projectScope` before any tenant/project lookup; a denied project-scoped API key gets the same non-leaky 404 as a missing KB/schema.
- Pipeline trigger routes must derive document/source scope from the verified KB `searchIndexId`; tenant-only document/source filters are no longer acceptable in any reprocess path.
- Field mapping routes must resolve `FieldMapping -> CanonicalSchema -> SearchIndex` before list/update/delete/read mutations so mappings inherit the SearchIndex project boundary.
- Live ProjectTools must reject `{{config.*}}` identity placeholders for SearchAI/workflow bindings unless a future module-artifact validation caller explicitly opts into placeholder deferral.
- KB delete must unregister/quarantine the generated ProjectTool before deleting the SearchIndex/KB, then invalidate runtime ownership/discovery caches after the index is removed.

### Slice 8: SearchAI Pipeline Project Scope

Tests:

- `pipelines / returns 404 when API key projectScope excludes requested project`
- `pipeline-triggers / returns 404 when API key projectScope excludes requested project`

### Slice 9: Pipeline Document And Source Index Scope

Tests:

- `pipeline-triggers / single document lookup includes KB searchIndexId`
- `pipeline-triggers / source lookup and source documents include KB searchIndexId`
- `pipeline-triggers / KB-wide trigger only loads documents for KB searchIndexId`
- `pipeline-triggers / bulk reprocess only loads documents for KB searchIndexId`

### Slice 10: Mapping Schema Project Scope

Tests:

- `mappings / list by schemaId returns 404 before listing cross-project mappings`
- `mappings / patch refuses cross-project schema before mutating`
- `mappings / delete refuses cross-project schema before deleting`

### Slice 11: Placeholder Binding Fail-Closed Policy

Tests:

- `validateSearchAIToolBinding / rejects config-backed identity fields by default`
- `validateSearchAIToolBinding / allows placeholder deferral only when explicitly requested`
- `validateWorkflowToolBinding / rejects config-backed identity fields by default`
- `validateWorkflowToolBinding / allows placeholder deferral only when explicitly requested`

### Slice 12: KB Delete Lifecycle

Tests:

- `knowledge-bases / does not delete KB or index when generated tool unregister fails`

## 2026-05-05 SearchAI Route Ownership And Read Boundary Closure

### Design Decisions

- Manual pipeline execution has a single production owner: `pipeline-triggers.ts`. `pipelines.ts` must not register duplicate `trigger-pipeline` URLs because Express mount order can silently shadow hardened validation.
- Connector content purge is an index-scoped lifecycle, not a connector-only lifecycle. Every initiate/status/cancel/retry route verifies `SearchIndex` project scope, connector source ownership, and cleanup-job connector ownership before invoking the purge service.
- Chunk and query-history reads must resolve the route `indexId` through `SearchIndex` and `tenantContext.projectScope` before reading raw content or ClickHouse history.
- Module publish safety must match live import/save behavior for SearchAI/workflow identity placeholders. `{{config.*}}` placeholders in executable tool identity fields are blocking at publish time unless a future artifact materialization path exists.

### Slice 13: Pipeline Trigger Route Ownership

Tests:

- `pipelines route manifest / does not re-register manual trigger endpoints owned by pipeline-triggers`

### Slice 14: Connector Purge Index Scope

Tests:

- `connector-content-purge / rejects purge initiation when index is outside API-key project scope`
- `connector-content-purge / rejects purge initiation when connector source does not belong to route index`
- `connector-content-purge / passes route index and connector scope into purge service`
- `connector-content-purge / requires cleanup job connector ownership before status reads`
- `connector-content-purge / passes connector scope into cancel and retry operations`

### Slice 15: SearchAI Read APIs Project Scope

Tests:

- `chunks / rejects index chunk listing outside API-key project scope before reading chunks`
- `chunks / rejects document chunk listing outside API-key project scope before reading chunks`
- `chunks / rejects single chunk lookup outside API-key project scope before reading content`
- `query-history / returns 404 before ClickHouse access when index is outside project scope`

### Slice 16: Module Placeholder Contract

Tests:

- `module-publish-safety / blocks config placeholders in SearchAI identity bindings`
- `module-publish-safety / blocks config placeholders in workflow identity bindings`

## 2026-05-05 Exhaustive SearchAI Ownership Propagation Closure

### Design Decisions

- Ownership checks are now centralized in `searchai-route-ownership.ts` for route surfaces that start from a SearchIndex or ConnectorConfig. The helper resolves `ConnectorConfig -> SearchSource -> SearchIndex` and applies `tenantContext.projectId/projectScope` at the SearchIndex boundary.
- Connector management routes are treated as one family even when split across many files. Every adjacent helper route must either use the shared connector-index guard or an explicit SearchIndex project-scope guard before running a service.
- Schema discovery and canonical schema routes inherit project scope from the connector source or knowledge-base/SearchIndex id before enqueueing jobs or returning schema data.
- Attribute admin and intelligence save/crawl flows must verify the target SearchIndex with project scope before touching attribute registries, SearchSource creation, ingestion, or crawl status data.
- Document cleanup must carry the caller’s `indexId` into source-document selection and document/chunk deletion filters so a same-tenant source/document id cannot fan out into another index during cleanup.

### Slice 17: Shared Connector Ownership Helper

Tests:

- `connector-route-strictness / connector-scoped routes reject cross-project connector ownership before services run`
- `connector-route-strictness / index-scoped connector routes reject cross-project index ownership before services run`

### Slice 18: Connector Auxiliary Route Coverage

Tests:

- `connector-route-strictness / audit log rejects unknown query keys`
- `connector-route-strictness / config import preview rejects unknown body keys`
- `connector-route-strictness / config restore rejects unknown body keys`
- `connector-route-strictness / retry action rejects unknown body keys`
- `connector-route-strictness / monitoring schedule rejects unknown body keys`
- `connector-route-strictness / template list rejects unknown query keys`
- `connector-route-strictness / notification updates reject unknown body keys`
- `connector-route-strictness / presence heartbeat rejects unknown body keys`
- `connector-route-strictness / proposal section updates reject unknown body keys`
- `connector-route-strictness / security revoke rejects unknown body keys`
- `connector-route-strictness / site access checks reject unknown body keys`
- `connector-route-strictness / field-config rejects unknown nested field keys before touching business persistence`

### Slice 19: Schema And Attribute Ownership

Tests:

- `schemas-discovery / rejects schema discovery when connector index is outside projectScope`
- `attributes / rejects cross-project index access before attribute queries`

### Slice 20: Intelligence Ownership

Tests:

- `intelligence-save / returns 404 for index outside API key projectScope before creating a source`

### Slice 21: Document Cleanup Index Carrying

Tests:

- `document-cleanup.service / scopes document, chunk, and pending-delete mutations to the target index`
- `document-cleanup.service / selects source documents by source, tenant, and index before vector cleanup`
