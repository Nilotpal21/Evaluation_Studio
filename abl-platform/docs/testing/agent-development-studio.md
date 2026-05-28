# Feature Test Guide: Agent Development (Studio)

**Feature**: Studio IDE -- project dashboard, agent editor, compilation, import/export, git sync, settings, tools, topology
**Owner**: Platform team
**Branch**: develop
**Related Feature Doc**: [docs/features/agent-development-studio.md](../features/agent-development-studio.md)
**First tested**: 2026-03-18
**Last updated**: 2026-03-22
**Overall status**: STABLE (unit/integration), PARTIAL (browser E2E)

---

## Current State (as of 2026-03-22)

The Studio development surface has broad unit and integration coverage for project IO, git providers, export/import validators, settings APIs, editor stores, and API routes. Browser coverage exists for git/import/tool/workflow flows. There is no single E2E suite covering the full create/edit/compile/save/publish authoring journey. Section-level surgical editing, topology rendering, and DSL overlay workflows lack dedicated integration tests.

### Quick Health Dashboard

| Area                             | Status     | Last Verified | Notes                                         |
| -------------------------------- | ---------- | ------------- | --------------------------------------------- |
| Import/export engine             | PASS       | 2026-03-22    | Project IO round-trip coverage is strong      |
| Git sync services                | PASS       | 2026-03-22    | Provider + sync-service tests exist           |
| Settings working copy/versioning | PASS       | 2026-03-22    | Runtime route coverage exists                 |
| Studio export/import APIs        | PASS       | 2026-03-22    | API tests exist                               |
| Browser git/import flows         | PASS       | 2026-03-22    | Playwright coverage exists                    |
| ABL compilation pipeline         | PASS       | 2026-03-22    | Unit tests for compile route exist            |
| Agent editor stores              | PASS       | 2026-03-22    | Editor-store, agent-detail-store covered      |
| Section-level surgical editing   | PARTIAL    | 2026-03-22    | Hook tested, no integration test for edit API |
| Topology canvas rendering        | NOT TESTED | --            | Component exists, no dedicated tests          |
| DSL overlay save workflow        | PASS       | 2026-03-22    | `dsl-overlay-save.test.tsx` exists            |
| Agent version diff               | PARTIAL    | 2026-03-22    | Store covered, no E2E for diff workflow       |
| Project creation + onboarding    | PARTIAL    | 2026-03-22    | Onboarding components tested individually     |
| Real-time collaborative editing  | NOT TESTED | --            | Not implemented                               |

## Coverage Goals

This feature will be well covered when the repo proves:

- Full create/edit/compile/save/publish authoring journeys (E2E)
- Surgical section editing round-trips (integration: edit API -> DSL mutation -> recompile)
- Project import/export and git-sync flows across the supported provider matrix
- Project settings working-copy and snapshot behavior with promotion lifecycle
- Project-scoped permission and isolation behavior across the authoring surface
- Topology rendering correctness for various agent graph shapes
- DSL overlay editing with parse error recovery
- Agent version history and diff workflows

---

## Coverage Matrix

| FR    | Description                                                   | Unit | Integration | E2E | Manual | Status     |
| ----- | ------------------------------------------------------------- | ---- | ----------- | --- | ------ | ---------- |
| FR-1  | Project dashboard with search, create                         | x    | x           |     |        | PARTIAL    |
| FR-2  | Unified agent editor with 17 section editors                  | x    |             |     |        | PARTIAL    |
| FR-3  | ABL compile via /api/abl/compile with rate limiting           | x    | x           |     |        | COVERED    |
| FR-4  | DSL overlay editor for raw code editing                       | x    |             |     |        | PARTIAL    |
| FR-5  | Topology canvas for multi-agent graph                         |      |             |     |        | NOT TESTED |
| FR-6  | Layered project import/export with manifest/lockfile          | x    | x           | x   |        | COVERED    |
| FR-7  | Bidirectional git sync with 4 providers                       | x    | x           | x   |        | COVERED    |
| FR-8  | Settings working copy + versioned snapshots with promotion    | x    | x           |     |        | COVERED    |
| FR-9  | Permission gating via requireProjectPermission                | x    | x           |     |        | PARTIAL    |
| FR-10 | Project settings UI with 10 tabs                              | x    |             |     |        | PARTIAL    |
| FR-11 | Agent version management (history, diff, restore)             | x    |             |     |        | PARTIAL    |
| FR-12 | Architect AI-assisted workflows                               | x    |             |     |        | PARTIAL    |
| FR-13 | Project-level tool management (CRUD, test, import, export)    | x    | x           | x   |        | COVERED    |
| FR-14 | MCP server management (CRUD, test connection, tool discovery) | x    | x           |     |        | PARTIAL    |

---

## E2E Test Scenarios (Minimum 5)

### E2E-1: Full Agent Authoring Journey (create project -> create agent -> edit -> compile -> save -> verify)

**Preconditions**: Authenticated user with valid tenant, Studio and Runtime running on random ports with full middleware.

**Steps**:

1. `POST /api/projects` with `{ name: "E2E Test Project", description: "..." }` -- create project, capture `projectId`.
2. `POST /api/projects/{projectId}/agents` with `{ name: "test-agent", agentPath: "agents/test-agent.abl" }` -- create agent, capture `agentId`.
3. `PUT /api/projects/{projectId}/agents/{agentId}/dsl` with valid ABL DSL content including AGENT, GOAL, TOOLS sections.
4. `POST /api/abl/compile` with `{ dsl: <content>, projectId }` -- verify `success: true`, `ir` is non-null, `errors` is empty.
5. `POST /api/projects/{projectId}/agents/{agentId}/edit` with `{ edits: [{ section: "identity", data: { goal: "Updated goal" } }] }` -- verify surgical edit returns updated `dslContent`.
6. `GET /api/projects/{projectId}/agents/{agentId}` -- verify DSL content reflects the surgical edit.
7. `GET /api/projects/{projectId}/topology` -- verify topology includes the new agent node.

**Expected Result**: Agent is created, DSL compiled successfully, section edit mutates DSL correctly, topology reflects new agent.

**Auth Context**: `tenantId: test-tenant`, `projectId: {created}`, `userId: test-user` with `editor` role.

**Isolation Check**: `GET /api/projects/{projectId}/agents/{agentId}` with a different `tenantId` returns 404.

### E2E-2: Project Import/Export Round-Trip with Layer Selection

**Preconditions**: Project with at least 2 agents, 1 tool, and configured settings. Studio and Runtime running.

**Steps**:

1. `POST /api/projects/{projectId}/export/preview` -- verify returns layer inventory with agents, tools, settings layers.
2. `POST /api/projects/{projectId}/export` with `{ layers: ["agents", "tools", "settings"] }` -- capture archive blob.
3. `POST /api/projects/{newProjectId}/import/preview` with the archive -- verify preview shows correct agent/tool/settings counts.
4. `POST /api/projects/{newProjectId}/import/apply` with the archive -- verify import succeeds.
5. `GET /api/projects/{newProjectId}/agents` -- verify same agent names as source.
6. `GET /api/projects/{newProjectId}/settings` -- verify settings match source.
7. `GET /api/projects/{newProjectId}/tools` -- verify tools match source.

**Expected Result**: Full project round-trip preserves agents, tools, and settings with manifest integrity.

**Auth Context**: `tenantId: test-tenant`, `userId: test-user` with `owner` role on both projects.

**Isolation Check**: Export from project A, attempt import into project B owned by different tenant -- returns 404.

### E2E-3: Git Push/Pull with Conflict Detection

**Preconditions**: Project with git integration configured (mocked git provider or test repository). Runtime running.

**Steps**:

1. `GET /api/projects/{projectId}/git` -- verify integration status is `active`.
2. `POST /api/projects/{projectId}/git/push` with `{ message: "E2E test push" }` -- verify `success: true`, `commitSha` returned.
3. Simulate remote change (modify file in test repo or via provider mock).
4. `POST /api/projects/{projectId}/git/pull` -- verify pull detects changes.
5. If conflicts detected: verify `SyncResult.conflicts` array is populated with file paths and conflict types.
6. `GET /api/projects/{projectId}/git/status` -- verify status reflects last sync.
7. `GET /api/projects/{projectId}/git/history` -- verify commit history includes the push.

**Expected Result**: Push creates remote commit, pull detects remote changes, conflicts are surfaced structured (not swallowed).

**Auth Context**: `tenantId: test-tenant`, `userId: test-user` with `editor` role.

**Isolation Check**: `GET /api/projects/{projectId}/git` with wrong tenant returns 404.

### E2E-4: Settings Version Lifecycle (create snapshot -> promote -> verify active)

**Preconditions**: Project with existing settings working copy. Runtime running.

**Steps**:

1. `PUT /api/projects/{projectId}/settings` with `{ enableThinking: true, thinkingBudget: 4096, compactionThreshold: 0.8 }` -- update working copy.
2. `GET /api/projects/{projectId}/settings` -- verify working copy reflects update.
3. `POST /api/projects/{projectId}/settings/versions` with `{ version: "1.0.0", changelog: "Enable thinking" }` -- create snapshot.
4. `GET /api/projects/{projectId}/settings/versions` -- verify version `1.0.0` exists with status `draft`.
5. `POST /api/projects/{projectId}/settings/versions/1.0.0/promote` with `{ targetStatus: "active" }` -- promote.
6. `GET /api/projects/{projectId}/settings/versions` -- verify version `1.0.0` has status `active`.
7. Attempt promotion of a non-existent version -- verify 404.

**Expected Result**: Settings working copy is updateable, snapshots are creatable, lifecycle promotion works through draft -> active.

**Auth Context**: `tenantId: test-tenant`, `userId: test-user` with `owner` role.

**Isolation Check**: `GET /api/projects/{projectId}/settings/versions` with different `tenantId` returns 404.

### E2E-5: Tool Management CRUD with Test Execution

**Preconditions**: Project exists. Studio and Runtime running.

**Steps**:

1. `POST /api/projects/{projectId}/tools` with HTTP tool definition `{ name: "weather-api", description: "Get weather", toolType: "http", httpBinding: { endpoint: "https://api.example.com/weather", method: "GET" }, parameters: [...] }` -- capture `toolId`.
2. `GET /api/projects/{projectId}/tools` -- verify tool appears in list.
3. `GET /api/projects/{projectId}/tools/{toolId}` -- verify tool detail matches creation input.
4. `PUT /api/projects/{projectId}/tools/{toolId}` with updated description -- verify update.
5. `POST /api/projects/{projectId}/tools/{toolId}/test` with test parameters -- verify test execution returns result (or structured error if endpoint is unreachable).
6. `POST /api/projects/{projectId}/tools/{toolId}/duplicate` -- verify new tool created with modified name.
7. `DELETE /api/projects/{projectId}/tools/{toolId}` -- verify deletion.
8. `GET /api/projects/{projectId}/tools/{toolId}` -- verify 404 after deletion.

**Expected Result**: Full tool lifecycle (create, read, update, test, duplicate, delete) works through HTTP API.

**Auth Context**: `tenantId: test-tenant`, `userId: test-user` with `editor` role.

**Isolation Check**: `GET /api/projects/{projectId}/tools/{toolId}` with different project returns 404.

### E2E-6: MCP Server Discovery and Tool Testing

**Preconditions**: Project with MCP server configured. Studio running.

**Steps**:

1. `POST /api/projects/{projectId}/mcp-servers` with `{ name: "test-mcp", url: "http://localhost:9999", type: "sse" }` -- capture `serverId`.
2. `POST /api/projects/{projectId}/mcp-servers/{serverId}/test-connection` -- verify connection test result (success or structured error).
3. `POST /api/projects/{projectId}/mcp-servers/{serverId}/tools/discover` -- verify tool discovery returns tool list.
4. `GET /api/projects/{projectId}/mcp-servers/{serverId}/tools` -- verify discovered tools are listed.
5. `DELETE /api/projects/{projectId}/mcp-servers/{serverId}` -- verify cleanup.

**Expected Result**: MCP server lifecycle with connection testing and tool discovery works end-to-end.

**Auth Context**: `tenantId: test-tenant`, `userId: test-user` with `editor` role.

**Isolation Check**: Access MCP server from different project returns 404.

### E2E-7: Project Dashboard and Navigation

**Preconditions**: Multiple projects exist for the authenticated user. Studio running.

**Steps**:

1. `GET /api/projects` -- verify returns project list with `agentCount`, `sessionCount`.
2. Create a new project via `POST /api/projects` with `{ name: "Navigation Test" }`.
3. `GET /api/projects` -- verify new project appears.
4. `GET /api/projects/{projectId}/agents` -- verify empty agent list for new project.
5. `GET /api/projects/{projectId}/topology` -- verify empty topology for new project.
6. `DELETE /api/projects/{projectId}` (if supported) or verify project detail returns.

**Expected Result**: Project listing, creation, and per-project resource access work through the API.

**Auth Context**: `tenantId: test-tenant`, `userId: test-user`.

**Isolation Check**: `GET /api/projects` with different tenant returns only that tenant's projects.

---

## Integration Test Scenarios (Minimum 5)

### INT-1: ABL Compilation Pipeline (parse + compile + config variable resolution)

**Boundary**: Studio `/api/abl/compile` route -> `@abl/core` parser -> `@abl/compiler` -> config variable repo.

**Setup**: Studio API running, MongoDB available for config variable lookup.

**Steps**:

1. Create config variables for a project via `POST /api/projects/{projectId}/config-variables`.
2. Submit DSL containing `{{VAR_NAME}}` references to `/api/abl/compile` with `projectId`.
3. Verify compiled IR resolves config variable values.
4. Submit malformed DSL -- verify structured parse errors with line/column.
5. Submit DSL exceeding 500KB -- verify 400 response.
6. Submit 31 requests in under 60 seconds -- verify rate limit (429) on the 31st.

**Expected Result**: Compilation resolves config vars, reports structured errors, enforces size/rate limits.

**Failure Mode**: If compiler throws, the route returns `{ success: false, errors: [...] }` without 500.

### INT-2: Surgical Section Edit Round-Trip (edit -> DSL mutation -> recompile)

**Boundary**: Studio edit route -> ABL serializer -> DSL content -> recompile.

**Setup**: Studio API running, project with an existing agent containing valid DSL.

**Steps**:

1. `GET /api/projects/{projectId}/agents/{agentId}` -- capture current DSL.
2. `POST /api/projects/{projectId}/agents/{agentId}/edit` with identity section edit (change goal text).
3. Verify response contains updated `dslContent` with the new goal.
4. `POST /api/abl/compile` with the updated DSL -- verify IR reflects the change.
5. Send an edit for a non-existent section -- verify appropriate error response.
6. Send concurrent edits from two requests -- verify both are applied (or one gets a conflict error).

**Expected Result**: Section edits correctly mutate DSL, recompilation succeeds, and the round-trip is faithful.

**Failure Mode**: If serializer produces invalid DSL, compilation should fail with structured errors, not crash.

### INT-3: Project Settings Working Copy + Version Promotion

**Boundary**: Runtime project-settings route -> MongoDB -> version lifecycle.

**Setup**: Runtime API running, MongoDB available.

**Steps**:

1. `PUT /api/projects/{projectId}/settings` with thinking enabled and specific budget.
2. `GET /api/projects/{projectId}/settings` -- verify persistence.
3. `POST /api/projects/{projectId}/settings/versions` -- create draft snapshot.
4. `GET /api/projects/{projectId}/settings/versions` -- verify draft version appears.
5. Promote version to `testing` then to `active` -- verify status transitions.
6. Attempt to promote a deprecated version -- verify rejection.
7. Verify `sourceHash` changes when settings content changes but not on re-snapshot of same content.

**Expected Result**: Settings CRUD, version creation, and lifecycle promotion work correctly with proper status transitions.

**Failure Mode**: If MongoDB is unavailable, operations return structured error responses (not unhandled exceptions).

### INT-4: Project Export with Manifest Integrity and Layer Size Limits

**Boundary**: `packages/project-io` exporter -> manifest generator -> lockfile generator.

**Setup**: Project with agents, tools, settings, and channels.

**Steps**:

1. Export project with all layers -- verify manifest.v2.json contains layer inventory.
2. Verify lockfile.v2.json contains content hashes for each file.
3. Verify agents/\*.abl files are present and parseable.
4. Verify layer size limits (`LAYER_SIZE_LIMITS`) are enforced -- if a layer exceeds the limit, export should warn or fail gracefully.
5. Re-export same project -- verify lockfile hashes are identical (deterministic export).
6. Export with selective layers (agents only) -- verify only agent files are present.

**Expected Result**: Export produces a valid, deterministic archive with manifest integrity and size enforcement.

**Failure Mode**: If an agent has unparseable DSL, export still succeeds with that agent's raw content preserved.

### INT-5: Git Provider Circuit Breaker Behavior

**Boundary**: `packages/project-io` git-sync-service -> git-circuit-breaker -> git-provider.

**Setup**: Mock git provider that simulates failures.

**Steps**:

1. Configure circuit breaker with low failure threshold (e.g., 3 failures).
2. Trigger 3 consecutive provider failures (simulated network errors).
3. Verify circuit breaker opens -- subsequent requests fail fast without calling provider.
4. Wait for recovery timeout.
5. Verify circuit breaker enters half-open state -- allows one probe request.
6. If probe succeeds, verify circuit closes and normal operation resumes.

**Expected Result**: Circuit breaker protects against cascading provider failures with proper open/half-open/closed transitions.

**Failure Mode**: Circuit breaker state transitions are logged via `createLogger('git-circuit-breaker')`.

### INT-6: Project Membership and Permission Gating

**Boundary**: Studio API routes -> `requireProjectPermission` middleware -> `project_members` collection.

**Setup**: Studio API running, MongoDB with project and membership records.

**Steps**:

1. Create project as user A (owner).
2. Add user B as `viewer` member.
3. As user B, `GET /api/projects/{projectId}/agents` -- verify success (viewer can read).
4. As user B, `POST /api/projects/{projectId}/agents` -- verify 403 (viewer cannot create).
5. As user C (not a member), `GET /api/projects/{projectId}/agents` -- verify 404 (not found, not 403).
6. Add user B as `editor`, retry create -- verify success.

**Expected Result**: Permission gating enforces role-based access with proper HTTP status codes.

**Failure Mode**: Missing membership returns 404 (not 403) to avoid leaking project existence.

### INT-7: Import Preview and Doctor for Malformed Archives

**Boundary**: Studio import routes -> `packages/project-io` importer -> validation pipeline.

**Setup**: Studio API running.

**Steps**:

1. Submit a valid archive to `/import/preview` -- verify preview shows correct counts.
2. Submit a corrupt archive (invalid JSON manifest) -- verify structured error.
3. Submit an archive with missing lockfile -- verify doctor endpoint diagnoses the issue.
4. Submit an archive with hash mismatches -- verify validation catches integrity failure.
5. Submit a V1 archive to V2 importer -- verify backward compatibility or structured upgrade error.

**Expected Result**: Import pipeline validates archives thoroughly and produces actionable error messages.

**Failure Mode**: Malformed archives produce structured errors, never unhandled exceptions.

---

## Security & Isolation Tests

- [x] Cross-tenant project access returns 404 (project-repo uses `findOne({_id, tenantId})`)
- [x] Cross-project agent access returns 404 (agents are project-scoped)
- [ ] Cross-user API key access returns 404 (API keys filtered by `createdBy`)
- [x] Missing auth returns 401 (`requireAuth` on all routes)
- [ ] Insufficient permissions return 403 (viewer attempting writes)
- [x] Input validation rejects malformed data (Zod schemas on route handlers)
- [ ] DSL size limit (500KB) enforced on compile endpoint
- [ ] Rate limiting enforced on compile endpoint (30 req/60s)
- [ ] Git credential `secretId` is never exposed in API responses

---

## Performance & Load Tests

- [ ] Compilation latency P95 < 500ms for agents under 50KB DSL
- [ ] Section edit round-trip (debounce + API + recompile) < 1s
- [ ] Project export for 50-agent project < 5s
- [ ] Project import for 50-agent project < 10s
- [ ] Git sync push with 100-file diff < 15s

---

## Test Infrastructure

### Required Services

- Studio (Next.js) on random port with full middleware chain
- Runtime (Express) on random port
- MongoDB (MongoMemoryServer for integration, real for E2E)
- Redis (optional, for rate limiting tests)

### Data Seeding Strategy

- Create projects, agents, tools, and settings via POST API endpoints
- No direct DB access in E2E tests
- Seed data includes structured ABL DSL content with multiple sections, not just plain strings

### Environment Variables

- `MONGODB_URI` -- MongoDB connection string
- `REDIS_URL` -- Redis connection string (optional)
- `ENCRYPTION_MASTER_KEY` -- Required for credential operations

### CI Configuration

- Integration tests: `pnpm --filter @agent-platform/project-io test` and `pnpm --filter studio test`
- E2E tests: `pnpm --filter studio e2e` (requires running services)

---

## Test File Mapping

| Test File                                                           | Type        | Covers            |
| ------------------------------------------------------------------- | ----------- | ----------------- |
| `packages/project-io/src/__tests__/export-import-roundtrip.test.ts` | integration | FR-6              |
| `packages/project-io/src/__tests__/git-sync-service.test.ts`        | integration | FR-7              |
| `packages/project-io/src/__tests__/project-importer-v2.test.ts`     | integration | FR-6              |
| `apps/studio/src/__tests__/api-export-routes.test.ts`               | integration | FR-6              |
| `apps/studio/src/__tests__/api-export-async-routes.test.ts`         | integration | FR-6              |
| `apps/studio/src/__tests__/api-git-routes.test.ts`                  | integration | FR-7              |
| `apps/studio/src/__tests__/api-projects.test.ts`                    | integration | FR-1, FR-9        |
| `apps/studio/src/__tests__/api-tool-routes.test.ts`                 | integration | FR-13             |
| `apps/studio/src/__tests__/api-mcp-routes.test.ts`                  | integration | FR-14             |
| `apps/studio/src/__tests__/editor-store.test.ts`                    | unit        | FR-2, FR-4        |
| `apps/studio/src/__tests__/agent-detail-store.test.ts`              | unit        | FR-2              |
| `apps/studio/src/__tests__/project-store.test.ts`                   | unit        | FR-1              |
| `apps/studio/src/__tests__/agent-editor-*.test.ts*`                 | unit        | FR-2              |
| `apps/studio/src/__tests__/dsl-overlay-save.test.tsx`               | unit        | FR-4              |
| `apps/studio/src/__tests__/section-edit-hook.test.ts`               | unit        | FR-2              |
| `apps/runtime/src/__tests__/project-settings-route.test.ts`         | integration | FR-8              |
| `apps/studio/e2e/git-bitbucket-e2e.spec.ts`                         | e2e         | FR-7              |
| `apps/studio/e2e/curl-import.spec.ts`                               | e2e         | FR-6              |
| `apps/studio/e2e/full-platform-e2e.spec.ts`                         | e2e         | FR-1, FR-2, FR-13 |
| `apps/studio/e2e/tool-api.spec.ts`                                  | e2e         | FR-13             |
| `apps/studio/e2e/workflow-create-execute.spec.ts`                   | e2e         | (adjacent)        |

---

## Open Testing Questions

1. Should topology canvas rendering be tested via visual regression (Playwright screenshots) or component unit tests with mock data?
2. What is the appropriate test fixture for MCP server discovery -- real MCP server, mock server, or recorded responses?
3. Should the git integration E2E tests use a real test repository (e.g., on GitHub) or a fully mocked provider?
4. How should concurrent editing scenarios be tested -- multiple HTTP clients hitting the edit endpoint simultaneously?
5. Should compilation latency targets be enforced in CI via performance benchmarks?

---

## Known Gaps

- No single E2E suite covering the full create/edit/compile/save/publish authoring journey
- Topology canvas has no dedicated test coverage
- Agent version diff workflow has no E2E coverage
- Concurrent editing conflict resolution not tested
- Architect-assisted onboarding flow tested at component level but not E2E
- Rate limiting on compilation endpoint not tested in integration
- Git webhook signature verification not tested for GitLab/generic providers

## Suggested Commands

```bash
# Project IO tests
pnpm --filter @agent-platform/project-io test

# Studio unit/integration tests
pnpm --filter studio test

# Studio E2E tests (requires running services)
pnpm --filter studio e2e

# Runtime settings tests
pnpm --filter runtime test -- project-settings

# Specific test patterns
pnpm --filter studio test -- editor-store
pnpm --filter studio test -- api-export
pnpm --filter studio test -- api-git
```

## References

- Related feature doc: [docs/features/agent-development-studio.md](../features/agent-development-studio.md)
- E2E test standards: See CLAUDE.md "E2E Test Standards"
- Test spec playbook: `docs/sdlc/test-spec-playbook.md`
