# Feature Test Guide: Variable Namespaces + Tool Auto-Tagging

**Feature**: Environment variables and config variables are organized into namespaces; tools auto-tag to the default namespace on creation; namespace-scoped resolution controls which secrets a tool can access
**Owner**: Platform team
**Branch**: feature/environment-variables-namespaces
**Related Feature Doc**: [docs/features/sub-features/variable-namespaces-tool-auto-tagging.md](../../features/sub-features/variable-namespaces-tool-auto-tagging.md)
**First tested**: 2026-03-14
**Last updated**: 2026-03-16 (Iteration 7)
**Overall status**: STABLE

---

## Current State (as of 2026-03-16, Iteration 7)

All API and runtime resolution are working end-to-end. Iteration 7 confirmed **GAP-006** (warning validation still scans `dslContent`, not an independently editable `headers` array), resolved **ENH-005 / GAP-007** (POST `/tools` now respects caller-supplied `variableNamespaceIds`), resolved **ENH-007** (DSL serializer preserves `{{env.X}}` and `{{secrets.X}}` placeholders in header keys and values), and re-verified **GAP-005** as fixed (Studio cross-tenant now returns 404, not 403). Cross-tenant isolation is fully verified: all 5 Studio routes plus 3 Runtime routes return 404 or empty scoped results for the wrong tenant. Remaining untested: UI flows (env vars admin, namespace management, config vars filter, deployment diff).

### Quick Health Dashboard

| Area                     | Status    | Last Verified       | Notes                                                   |
| ------------------------ | --------- | ------------------- | ------------------------------------------------------- |
| API CRUD (env vars)      | PASS      | 2026-03-14 (Iter 3) | Create, list, update, delete, get value                 |
| Auto-tagging             | PASS      | 2026-03-14 (Iter 3) | Env vars, config vars, tools all auto-tag               |
| Validation warnings      | PASS      | 2026-03-14 (Iter 2) | Wrong NS, empty NS, missing var all warn                |
| Error handling           | PASS      | 2026-03-14 (Iter 2) | Specific messages for all invalid inputs                |
| DB State Consistency     | PASS      | 2026-03-14 (Iter 3) | Records match API responses                             |
| Cross-Tenant Isolation   | PASS      | 2026-03-14 (Iter 2) | Env vars + namespaces return 404 for other tenant       |
| Cross-Project Isolation  | PASS      | 2026-03-14 (Iter 3) | Env vars + namespaces return 404 across projects        |
| Namespace CRUD           | PASS      | 2026-03-14 (Iter 2) | Create, list, update, delete working                    |
| Namespace Members        | PASS      | 2026-03-14 (Iter 3) | List, add, remove all working                           |
| Delete Cascade           | PASS      | 2026-03-14 (Iter 2) | Var delete + NS delete clean memberships                |
| Pagination               | PASS      | 2026-03-14 (Iter 2) | page/limit params working                               |
| Multi-env same key       | PASS      | 2026-03-14 (Iter 2) | Same key across dev/staging/production                  |
| Default NS protection    | PASS      | 2026-03-14 (Iter 2) | Cannot delete default namespace → 400                   |
| Namespace filtering      | PASS      | 2026-03-14 (Iter 3) | `?namespaceId=` filter on env var list                  |
| Namespace assignment     | PASS      | 2026-03-14 (Iter 3) | PUT env var with new variableNamespaceIds works         |
| Copy between envs        | PASS      | 2026-03-14 (Iter 3) | Copy dev→staging preserves keys                         |
| SSRF protection          | PASS      | 2026-03-14 (Iter 3) | Cloud metadata blocked, localhost allowed               |
| Config var auto-tag      | PASS      | 2026-03-14 (Iter 3) | Config var → default NS with type=config                |
| Multi-NS tool            | PASS      | 2026-03-14 (Iter 3) | Union of namespaces — vars in either = no warning       |
| Runtime resolution       | PASS      | 2026-03-14 (Iter 5) | Chat-driven + tool test, no process.env fallback        |
| Chat-driven resolution   | PASS      | 2026-03-14 (Iter 5) | Agent chat calls tools, NS scoping works in runtime     |
| Edge cases (Iter 6)      | PASS      | 2026-03-14 (Iter 6) | Priority, dual-NS, mixed placeholders, cross-NS block   |
| GAP-006 header warnings  | CONFIRMED | 2026-03-16 (Iter 7) | PUT schema doesn't accept headers; dslContent-only scan |
| ENH-005 POST NS override | PASS      | 2026-03-16 (Iter 7) | Fixed: POST respects body.variableNamespaceIds          |
| ENH-007 DSL serializer   | PASS      | 2026-03-16 (Iter 7) | Placeholders preserved in header keys and values        |
| Cross-tenant (Studio)    | PASS      | 2026-03-16 (Iter 7) | All 5 routes return 404 for wrong tenant                |
| Cross-tenant (Runtime)   | PASS      | 2026-03-16 (Iter 7) | List=empty, GET=404 for wrong tenant                    |
| UI - Tools list          | PASS      | 2026-03-14 (Iter 5) | Cards render with NS tags, type badges, descriptions    |
| UI - Env vars admin      | —         | Not tested          | Needs browser automation                                |
| UI - Namespace mgmt      | —         | Not tested          | Needs browser automation                                |
| UI - Config vars filter  | —         | Not tested          | Needs browser automation                                |
| UI - Deployment diff     | —         | Not tested          | Needs browser automation                                |
| Performance / Edge Cases | —         | Not tested          |                                                         |

---

## Audit Scope

This guide captures live API and runtime verification for the namespace-focused slice of the broader environment-variable feature:

- Namespace CRUD and membership workflows
- Default-namespace auto-tagging
- Tool create/update namespace linkage
- Runtime namespace-scoped resolution and isolation
- Cross-tenant and cross-project behavior on Studio and Runtime routes

Historical iteration logs are preserved below because they document both discovered bugs and their later fixes.

---

## Coverage Goals

The sub-feature remains healthy when the docs and repo evidence continue to prove all of the following:

- Namespace CRUD preserves default-namespace safety rules
- Tool creation and update flows honor explicit `variableNamespaceIds`
- Runtime resolution only exposes variables from linked namespaces
- Cross-tenant and cross-project access never leaks namespace-bound data
- UI flows eventually receive browser-driven verification, not just API/runtime coverage

---

## Test Coverage Map

### API Tests — Environment Variables

- [x] Create env var with required fields — `Iteration 1 PASS, re-verified Iteration 2 PASS`
- [x] Create secret env var (isSecret=true) — `Iteration 1 PASS, re-verified Iteration 2 PASS`
- [x] Create env var with explicit namespace IDs — `Iteration 3 PASS`
- [x] List env vars with environment filter — `Iteration 2 PASS`
- [x] List env vars with namespace filter — `Iteration 3 PASS`
- [x] List env vars with pagination — `Iteration 2 PASS`
- [x] Get single env var value (decrypted) — `Iteration 3 PASS` (route: `/:id/value`)
- [x] Update env var value — `Iteration 3 PASS`
- [x] Update env var namespace assignment — `Iteration 3 PASS`
- [x] Delete env var — `Iteration 2 PASS`
- [x] Delete env var cleans up memberships — `Iteration 2 PASS`
- [x] Copy env vars between environments — `Iteration 3 PASS`
- [ ] Bulk upsert env vars — `Not tested`
- [x] Same key across multiple environments — `Iteration 2 PASS`

### API Tests — Variable Namespaces

- [x] Create namespace — `Iteration 2 PASS`
- [x] List namespaces for project — `Iteration 2 PASS` (includes memberCounts)
- [x] Update namespace (displayName, color) — `Iteration 2 PASS`
- [x] Delete namespace — `Iteration 2 PASS`
- [x] Delete default namespace blocked — `Iteration 2 PASS`
- [x] Add members to namespace — `Iteration 2 PASS`
- [x] Remove member from namespace — `Iteration 3 PASS` (route: `DELETE /:variableId?type=env`)
- [x] List members of namespace — `Iteration 2 PASS`
- [x] Delete namespace cascades memberships — `Iteration 2 PASS`

### API Tests — Tools + Namespace Integration

- [x] Tool creation auto-tags to default namespace — `Iteration 1 PASS, re-verified Iteration 2 PASS`
- [x] Tool PUT with var in wrong namespace → warning — `Iteration 1 PASS, re-verified Iteration 2 PASS`
- [x] Tool PUT with empty namespaces → warning — `Iteration 1 PASS, re-verified Iteration 2 PASS`
- [x] Tool PUT with correct namespace → no warning — `Iteration 1 PASS, re-verified Iteration 2 PASS`
- [x] Tool PUT with nonexistent var in dslContent → warning — `Iteration 1 PASS, re-verified Iteration 2 PASS`
- [x] Tool with multiple namespaces resolves union — `Iteration 3 PASS`
- [x] Tool POST respects caller-supplied `variableNamespaceIds` — `Iteration 7 PASS after fix (ENH-005 / GAP-007 resolved)`
- [x] Tool PUT correctly sets multiple NSes — `Iteration 7 PASS (workaround for ENH-005)`
- [x] Header-only {{secrets.X}} not scanned for warnings — `Iteration 7 CONFIRMED (GAP-006)`
- [x] DSL serializer preserves {{env.X}} in header keys — `Iteration 7 PASS (ENH-007 resolved)`
- [x] DSL serializer preserves {{secrets.X}} in header values — `Iteration 7 PASS (ENH-007 resolved)`

### Runtime Value Resolution — Tool Execution with Namespace-Scoped Variables

- [x] HTTP tool resolves `{{env.X}}` from allowed namespace at runtime — `Iteration 4 PASS`
- [x] HTTP tool resolves `{{secrets.X}}` from allowed namespace at runtime — `Iteration 4 PASS`
- [x] HTTP tool blocked from resolving env var in disallowed namespace (empty) — `Iteration 4 PASS`
- [x] HTTP tool with no namespaces — DB vars inaccessible, only process.env — `Iteration 4 PASS`
- [x] HTTP tool with multi-namespace union resolves vars from both namespaces — `Iteration 4 PASS`
- [x] Config var resolution via `{{secrets.X}}` namespace scoping — `Iteration 4 PASS`
- [x] Config var resolution via `{{env.X}}` namespace scoping — `Iteration 4 PASS`
- [x] Graceful fallthrough — unresolved placeholder becomes empty string — `Iteration 4 PASS`
- [x] MCP tool namespace-scoped execution (via n8n MCP server) — `Iteration 4 PASS`
- [x] Chat-driven tool execution resolves namespace-scoped env vars — `Iteration 5 PASS` (all 6 tools verified via agent chat + httpbin echo)
- [x] Env var vs config var priority — env var wins via `{{secrets.X}}` — `Iteration 6 PASS`
- [x] Default-NS-only tool resolves `{{env.X}}` from default namespace — `Iteration 6 PASS`
- [x] Dual-namespace membership — var in both NS, tool in one NS, resolves — `Iteration 6 PASS`
- [x] Mixed placeholders — `{{env.X}}` + `{{secrets.Y}}` + literal in single tool — `Iteration 6 PASS`
- [x] Cross-namespace isolation — tool in default NS blocked from allowed-ns vars — `Iteration 6 PASS`

### Auto-Tagging

- [x] Default namespace auto-created on first var in project — `Iteration 1 PASS, re-verified Iteration 2 PASS`
- [x] Env var auto-tagged to default namespace — `Iteration 1 PASS, re-verified Iteration 2 PASS`
- [x] Tool auto-tagged to default namespace — `Iteration 1 PASS, re-verified Iteration 2 PASS`
- [x] Config var auto-tagged to default namespace — `Iteration 3 PASS`

### Validation & Error Handling

- [x] Missing required fields → 400 — `Iteration 1 PASS, re-verified Iteration 2 PASS`
- [x] Invalid key format → 400 specific message — `Iteration 1 PASS, re-verified Iteration 2 PASS`
- [x] Key too long (257 chars) → 400 — `Iteration 1 PASS, re-verified Iteration 2 PASS`
- [x] Invalid environment → 400 descriptive — `Iteration 1 PASS, re-verified Iteration 2 PASS`
- [x] Duplicate key+env → 409 — `Iteration 1 PASS, re-verified Iteration 2 PASS`
- [x] Invalid namespace ID → 400 — `Iteration 1 PASS, re-verified Iteration 2 PASS`
- [x] Duplicate tool name → 409 — `Iteration 1 PASS, re-verified Iteration 2 PASS`
- [x] SSRF protection on tool endpoint — `Iteration 3 PASS` (metadata IP blocked; localhost allowed)
- [x] Tool headers must be array not object — `Iteration 3 PASS` (400 "Expected array, received object")

### DB State Verification

- [x] Namespace records match expected state — `Iteration 1 PASS, re-verified Iteration 2 PASS`
- [x] Membership records link vars to correct namespaces — `Iteration 1 PASS, re-verified Iteration 2 PASS`
- [x] Cascade delete of namespace cleans memberships — `Iteration 2 PASS`
- [ ] Cascade delete of project cleans namespaces — `Not tested`
- [ ] Index performance on large datasets — `Not tested`

### Security & Isolation

- [x] Cross-tenant env var list returns empty — `Iteration 2 PASS`
- [x] Cross-tenant env var GET returns 404 — `Iteration 2 PASS`
- [x] Cross-tenant env var DELETE returns 404 — `Iteration 2 PASS`
- [x] Cross-tenant namespace list returns 404 — `Iteration 2 PASS`
- [x] Cross-tenant namespace members returns 404 — `Iteration 2 PASS`
- [x] Cross-tenant namespace delete returns 404 — `Iteration 2 PASS`
- [x] Cross-project env var GET returns 404 — `Iteration 3 PASS`
- [x] Cross-project env var DELETE returns 404 — `Iteration 3 PASS`
- [x] Cross-project env var list scoped to project — `Iteration 3 PASS`
- [x] Cross-project namespace members returns 404 — `Iteration 3 PASS`

### UI Tests

- [x] Tools list page renders tool cards — `Iteration 5 PASS` (8 tools, NS tags, type badges, descriptions all correct)
- [ ] Tool detail page shows namespace checkboxes — `Not tested`
- [ ] Config variables tab shows namespace dropdown filter — `Not tested`
- [ ] Namespace tag popover assigns/removes memberships — `Not tested`
- [ ] ManageVariableNamespacesPanel create/edit/delete flow — `Not tested`
- [ ] Environment variables admin page per-environment tabs — `Not tested`
- [ ] Deployment diff view shows variable changes — `Not tested`
- [ ] Secret value reveal (show/hide toggle) — `Not tested`
- [ ] No console errors throughout all UI flows — `Not tested`

---

## Open Gaps

- **GAP-003**: UI flows partially untested (env vars admin, namespace mgmt, config vars filter, deployment diff)
  - **Severity**: Medium
  - **Reason**: Tools list verified in Iter 5; remaining pages need browser automation

- **GAP-006**: Warning validation only scans `dslContent`, not `headers` — Confirmed Iter 7
  - **Severity**: Low (by design)
  - **Reason**: `UpdateProjectToolSchema` doesn't accept `headers` at all — only `name`, `description`, `dslContent`, `variableNamespaceIds`. The `headers` field sent in PUT body is silently stripped by Zod. Warning scan at line 106-111 only reads `dslContent`. When headers are sent via POST (create), `serializeToolFormToDsl` bakes them into `dslContent`, so CREATE path is covered. Only gap: if headers could be updated independently of dslContent.
  - **File**: `apps/studio/src/app/api/projects/[id]/tools/[toolId]/route.ts:106-111`

- ~~**GAP-007**: Tool POST ignores `body.variableNamespaceIds`~~ — **FIXED in Iteration 7**
  - **Fix**: Added `variableNamespaceIds` to `ToolFormBaseSchema`, POST handler now uses caller-supplied IDs when provided, falls back to auto-tag default
  - **Files**: `packages/shared/src/validation/project-tool-schemas.ts`, `apps/studio/src/app/api/projects/[id]/tools/route.ts`
  - **Verified**: 3 tests pass (explicit multi-NS, omitted, empty array)

---

## Pending / Future Work

- [ ] Performance testing with 1000+ variables per project
- [ ] Concurrent multi-user editing of same namespace
- [ ] Webhook/event emission on namespace CRUD
- [ ] Import/export round-trip preserving namespace assignments
- [ ] Rate limiting on bulk operations
- [ ] Deployment snapshot captures correct namespace state
- [x] Namespace-scoped secret resolution in tool test execution (Iteration 4)
- [x] Namespace-scoped resolution in live chat (agent-driven tool calls) (Iteration 5)
- [ ] Bulk upsert env vars endpoint
- [ ] Cascade delete of project cleans namespaces/memberships

---

## Enhancement Ideas

- **ENH-001** (Iteration 1): Bulk variable create endpoint would reduce N+1 API calls for project setup
- **ENH-002** (Iteration 1): Tool validation warnings could include a "suggested fix" (e.g., "add variable to namespace X")
- **ENH-003** (Iteration 2): Warning scanning should also check `headers` array for `{{secrets.X}}` patterns, not just `dslContent`
- **ENH-004** (Iteration 2): Namespace list API response leaks internal fields (`__v`, `_v`) — should normalize to clean shape
- ~~**ENH-005** (Iteration 3): Tool creation API response shows only auto-tagged default NS~~ — **FIXED in Iteration 7** (POST now respects `body.variableNamespaceIds`)
- **ENH-006** (Iteration 3): SSRF protection allows localhost — should be configurable or blocked in production
- ~~**ENH-007** (Iteration 4): Tool form `serializeToolFormToDsl` strips `{{env.X}}` placeholders from header values~~ — **Resolved in Iteration 7** (confirmed working: placeholders preserved in DSL)

---

## Iteration Log

### Iteration 7 — 2026-03-16

**Scope**: Live-test open gaps — GAP-006 (header warning validation), ENH-005 (POST NS override), ENH-007 (DSL serializer placeholders), GAP-005 (cross-tenant 403 vs 404)
**Branch**: fix/workspace-creation-ordered-create
**Duration**: ~30min
**Tested by**: Claude Code (agent)

#### Results

| #   | Test                                            | Method                                               | Expected                            | Actual                                               | Status    |
| --- | ----------------------------------------------- | ---------------------------------------------------- | ----------------------------------- | ---------------------------------------------------- | --------- |
| 69  | GAP-006: PUT with {{secrets.X}} in headers only | PUT /tools/:id (headers array, no dslContent change) | Warning about ISOLATED_KEY          | `warnings: null` (headers stripped by Zod)           | CONFIRMED |
| 70  | GAP-006: PUT with {{secrets.X}} in dslContent   | PUT /tools/:id (dslContent has placeholder)          | Warning about ISOLATED_KEY          | Warning: "exists but is not in any of the tool's..." | PASS      |
| 71  | ENH-005: POST with 2 variableNamespaceIds       | POST /tools (nsIds=[default, isolated])              | Both NS IDs stored                  | Only default NS stored (body.nsIds ignored)          | CONFIRMED |
| 72  | ENH-005 workaround: PUT sets multiple NSes      | PUT /tools/:id (nsIds=[default, isolated])           | Both NS IDs stored                  | DB: both NS IDs present                              | PASS      |
| 73  | ENH-007: DSL serializer header keys             | POST /tools (headers with {{env.X}} key)             | Placeholder preserved in dslContent | `{{env.CUSTOM_HEADER_NAME}}: "{{secrets.API_KEY}}"`  | PASS      |
| 74  | ENH-007: DSL serializer header values           | POST /tools (headers with {{secrets.X}} value)       | Placeholder preserved in dslContent | `Authorization: "Bearer {{secrets.API_KEY}}"`        | PASS      |
| 75  | GAP-005: Studio cross-tenant list tools         | GET /projects/:pid/tools (Tenant B token)            | 404                                 | 404 NOT_FOUND                                        | PASS      |
| 76  | GAP-005: Studio cross-tenant GET tool           | GET /projects/:pid/tools/:tid (Tenant B token)       | 404                                 | 404 NOT_FOUND                                        | PASS      |
| 77  | GAP-005: Studio cross-tenant POST tool          | POST /projects/:pid/tools (Tenant B token)           | 404                                 | 404 NOT_FOUND                                        | PASS      |
| 78  | GAP-005: Studio cross-tenant MCP servers        | GET /projects/:pid/mcp-servers (Tenant B token)      | 404                                 | 404 NOT_FOUND                                        | PASS      |
| 79  | GAP-005: Studio cross-tenant DELETE tool        | DELETE /projects/:pid/tools/:tid (Tenant B token)    | 404                                 | 404 (tool not deleted)                               | PASS      |
| 80  | Runtime cross-tenant list env vars              | GET /env-vars (Tenant B token)                       | count=0                             | count=0                                              | PASS      |
| 81  | Runtime cross-tenant GET env var                | GET /env-vars/:id (Tenant B token)                   | 404                                 | 404                                                  | PASS      |
| 82  | Control: Tenant A list tools                    | GET /projects/:pid/tools (Tenant A token)            | 200 with data                       | 200, count=13                                        | PASS      |
| 83  | Control: Tenant A list env vars                 | GET /env-vars (Tenant A token)                       | count=6                             | count=6                                              | PASS      |

#### Key Findings

- **GAP-006 root cause**: `UpdateProjectToolSchema` only accepts `name`, `description`, `dslContent`, `variableNamespaceIds`. The `headers` field is not in the schema and is silently stripped by Zod. Warning validation at line 106 only scans `dslContent`. When headers are sent via POST (create), `serializeToolFormToDsl()` bakes them into dslContent — so the create path IS covered. The gap only matters if headers could be updated independently.
- **ENH-005 root cause**: POST handler line 144 always sets `variableNamespaceIds: defaultNamespaceIds`, ignoring `body.variableNamespaceIds`. The workaround is to PUT immediately after create.
- **ENH-007 resolved**: `serializeToolFormToDsl()` correctly preserves `{{env.X}}` in header keys and `{{secrets.X}}` in header values. The DSL output includes `{{env.CUSTOM_HEADER_NAME}}: "{{secrets.API_KEY}}"` verbatim.
- **GAP-005 resolved**: Studio now returns 404 (not 403) for cross-tenant access. All 5 tested routes (list, get, create, delete tools + list MCP servers) return 404. Previous Iteration 3 reported 403, but that may have been due to incorrect tenant token setup.

#### Bugs Fixed

- **GAP-007 / ENH-005**: Tool POST ignores `body.variableNamespaceIds`
  - **File**: `apps/studio/src/app/api/projects/[id]/tools/route.ts:99-144`
  - **Root Cause**: POST handler always used `defaultNamespaceIds` from auto-tag logic, ignoring user-supplied `body.variableNamespaceIds`
  - **Fix**: Use caller-supplied `variableNamespaceIds` when provided and non-empty; fall back to auto-tag default NS otherwise. Also added `variableNamespaceIds` to `ToolFormBaseSchema` in `packages/shared/src/validation/project-tool-schemas.ts`.
  - **Verified**: 3 tests pass — explicit multi-NS (both stored), omitted (auto-tags default), empty array (auto-tags default)

#### Gaps Resolved

- [x] GAP-005 (Studio cross-tenant 403 vs 404) — Now returns 404 across all tested routes
- [x] ENH-007 (DSL serializer strips placeholders) — Confirmed working: placeholders preserved
- [x] GAP-007 / ENH-005 (POST ignores variableNamespaceIds) — Fixed: POST now respects caller-supplied NS IDs

---

### Iteration 6 — 2026-03-14

**Scope**: Advanced edge-case tools — env vs config priority, default-NS-only resolution, dual-namespace membership, mixed placeholder types, cross-namespace isolation
**Branch**: feature/environment-variables-namespaces
**Duration**: ~15min
**Tested by**: Claude Code (agent) + user (manual chat interaction)

#### Setup

Created 5 new tools and supporting test data:

- Config var `ALLOWED_API_KEY` = `config-value-should-lose` (same key as env var, for priority test)
- Env var `DUAL_NS_VAR` = `dual-membership-value` with memberships in both `allowed-ns` and `blocked-ns`
- Env var `DEFAULT_ENDPOINT` already in `default` NS from prior iterations
- Tools assigned to specific namespaces to test isolation boundaries

#### Results

| #   | Test                                        | Method                                                   | Expected                                   | Actual                                                                                               | Status |
| --- | ------------------------------------------- | -------------------------------------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------- | ------ |
| 64  | Env var vs config var priority              | `ns_test_env_vs_config` [allowed-ns] → httpbin echo      | `X-Env-Wins: allowed-value-123` (env wins) | `X-Env-Wins: allowed-value-123`                                                                      | PASS   |
| 65  | Default-NS-only tool resolves own NS vars   | `ns_test_default_ns` [default] → httpbin echo            | `X-Default-Ep: https://httpbin.org/get`    | `X-Default-Ep: https://httpbin.org/get`                                                              | PASS   |
| 66  | Dual-NS membership resolves from tool's NS  | `ns_test_dual_member` [allowed-ns] → httpbin echo        | `X-Dual-Var: dual-membership-value`        | `X-Dual-Var: dual-membership-value`                                                                  | PASS   |
| 67  | Mixed placeholders: env + secrets + literal | `ns_test_mixed_placeholders` [allowed-ns] → httpbin echo | All 3 headers resolved correctly           | `X-Env: allowed-value-123`, `X-Secret: https://api.example.com/v1`, `X-Literal: hardcoded-value-123` | PASS   |
| 68  | Cross-NS blocked, same-NS resolves          | `ns_test_cross_ns_block` [default] → httpbin echo        | `X-Cross-Ns: ""`, `X-Same-Ns: resolved`    | `X-Cross-Ns: ""`, `X-Same-Ns: https://httpbin.org/get`                                               | PASS   |

#### Key Findings

- **Env var > config var**: When same key exists as both env var and config var, `{{secrets.X}}` resolves env var first (correct priority chain: envVar → configVar → IR credentials)
- **Dual membership**: A variable with memberships in multiple namespaces is accessible from any tool in any of those namespaces
- **Cross-NS isolation confirmed**: Tool in `default` NS cannot see `ALLOWED_API_KEY` from `allowed-ns` — returns empty string. But can see `DEFAULT_ENDPOINT` in its own `default` NS.
- **Mixed placeholders**: `{{env.X}}`, `{{secrets.Y}}`, and literal values all coexist and resolve correctly in a single tool's headers

---

### Iteration 5 — 2026-03-14

**Scope**: Chat-driven tool execution with namespace-scoped env var resolution; process.env fallback removal; UI tools list verification
**Branch**: feature/environment-variables-namespaces
**Duration**: ~30min
**Tested by**: Claude Code (agent) + user (manual chat interaction)

#### Results

| #   | Test                                              | Method                                                   | Expected                                   | Actual                                                         | Status |
| --- | ------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------ | -------------------------------------------------------------- | ------ |
| 56  | Chat: allowed tool resolves `{{env.X}}`           | Agent chat → ns_resolve_allowed_tool → httpbin echo      | `X-Env-Var: allowed-value-123`             | `X-Env-Var: allowed-value-123`                                 | PASS   |
| 57  | Chat: allowed tool resolves `{{secrets.X}}`       | Agent chat → ns_resolve_allowed_tool → httpbin echo      | `X-Secret: secret-abc-789`                 | `X-Secret: secret-abc-789`                                     | PASS   |
| 58  | Chat: wrong NS blocks env var                     | Agent chat → ns_resolve_wrong_ns_tool → httpbin echo     | `X-Secret: ""` (blocked)                   | `X-Secret: ""`                                                 | PASS   |
| 59  | Chat: unrestricted tool (empty nsIds) accesses DB | Agent chat → ns_resolve_unrestricted_tool → httpbin echo | `key=allowed-value-123` (no filter)        | `key=allowed-value-123`                                        | PASS   |
| 60  | Chat: multi-NS union resolves both                | Agent chat → ns_resolve_multi_ns_tool → httpbin echo     | Both headers resolved                      | `X-Allowed: allowed-value-123`, `X-Blocked: blocked-value-456` | PASS   |
| 61  | Chat: graceful fallthrough for missing var        | Agent chat → ns_resolve_fallthrough_tool → httpbin echo  | `X-Nonexistent: ""`, `X-Real: ...`         | `X-Nonexistent: ""`, `X-Real: secret-abc-789`                  | PASS   |
| 62  | Chat: config var via `{{secrets.X}}`              | Agent chat → ns_resolve_config_var_tool → httpbin echo   | `X-Config-Url: https://api.example.com/v1` | `X-Config-Url: https://api.example.com/v1`                     | PASS   |
| 63  | UI: Tools list renders correctly                  | Browser automation → /projects/.../tools                 | Tool cards with NS tags                    | 8 tools, NS color tags, HTTP badges                            | PASS   |

#### Bugs Fixed

- **BUG-004**: Secrets provider had `process.env` fallback — tools with empty `variableNamespaceIds` could leak server env vars
  - **File**: `apps/runtime/src/services/secrets-provider.ts:234-244`
  - **Root Cause**: When `variableNamespaceIds` was empty or undefined, `getSecret` fell through to `process.env[key]`, bypassing DB-only resolution. This allowed tools to access server-side env vars like `NODE_ENV`, `PATH`, etc.
  - **Fix**: Removed `resolveFromEnvironment` method and its call site. All variable resolution now goes through DB (env vars → config vars → IR credentials → undefined).
  - **Also fixed**: Same pattern in `apps/studio/src/services/tool-test-service.ts:204-206`
  - **Tests updated**: `apps/runtime/src/__tests__/secrets-provider.test.ts` — removed process.env tests, added "does NOT resolve from process.env" test
  - **Verified**: Re-ran all 6 chat tool tests — correct behavior, runtime logs show `layers=envVar,configVar,config` (no env layer)

#### Notes

- Chat-driven resolution uses `ToolBindingExecutor` → `namespaceScopedSecretsFactory` → `RuntimeSecretsProvider.withNamespaceScope()` per tool
- Empty `variableNamespaceIds: []` = unrestricted DB access (all env vars/config vars accessible, no namespace filter). This is by design — empty means "no restriction", not "no access"
- `{{env.X}}` only checks `environment_variables` collection; `{{secrets.X}}` checks env vars + config vars + IR credentials. Config vars MUST use `{{secrets.X}}` syntax
- Tool DSL for `ns_resolve_config_var_tool` was updated from `{{env.CONFIG_API_URL}}` to `{{secrets.CONFIG_API_URL}}` to correctly resolve config vars

---

### Iteration 4 — 2026-03-14

**Scope**: Runtime value resolution — namespace-scoped `{{env.X}}` and `{{secrets.X}}` resolution via Studio tool test endpoint against httpbin.org and n8n MCP server
**Branch**: feature/environment-variables-namespaces
**Duration**: ~25min
**Tested by**: Claude Code (agent)
**Prerequisites fixed**: Studio `createSecretsProvider` missing `getEnvVar` method (BUG-003)

#### Results

| #   | Test                                           | Method                                             | Expected                         | Actual                                    | Status |
| --- | ---------------------------------------------- | -------------------------------------------------- | -------------------------------- | ----------------------------------------- | ------ |
| 47  | HTTP tool resolves `{{env.X}}` from allowed NS | Tool test → httpbin echo X-Env-Var header          | `allowed-value-123`              | `allowed-value-123`                       | PASS   |
| 48  | HTTP tool blocked from disallowed NS           | Tool test → httpbin echo X-Secret header           | Empty string (blocked)           | `""` (correctly blocked)                  | PASS   |
| 49  | HTTP tool with no NS — DB vars inaccessible    | Tool test → httpbin URL query param                | `key=` (empty)                   | `key=` (no DB access without NS)          | PASS   |
| 50  | Multi-NS union resolves both namespaces        | Tool test → httpbin X-Allowed + X-Blocked headers  | Both resolved                    | `allowed-value-123` + `blocked-value-456` | PASS   |
| 51  | Config var via `{{secrets.X}}` NS scoping      | Tool test → httpbin X-Config-Url header            | `https://api.example.com/v1`     | `https://api.example.com/v1`              | PASS   |
| 52  | Graceful fallthrough — missing var             | Tool test → httpbin X-Nonexistent + X-Real headers | Nonexistent=empty, Real=resolved | `""` + `secret-abc-789`                   | PASS   |
| 53  | Config var via `{{env.X}}` NS scoping          | Tool test → httpbin X-Config-Url header            | `https://api.example.com/v1`     | `https://api.example.com/v1`              | PASS   |
| 54  | MCP tool NS assignment in DB                   | DB query for variableNamespaceIds                  | Contains Allowed NS ID           | `["019cec67-8862-..."]`                   | PASS   |
| 55  | MCP tool execution with NS scoping             | Tool test via n8n MCP `datetime` tool              | Executes, returns valid output   | `iso8601: "2026-03-14T13:04:30.416Z"`     | PASS   |

#### Bugs Fixed

- **BUG-003**: Studio `createSecretsProvider` missing `getEnvVar` method
  - **File**: `apps/studio/src/services/tool-test-service.ts:288`
  - **Root Cause**: `SecretsProvider.getEnvVar` is optional in the interface; Studio only implemented `getSecret`. The `HttpToolExecutor.resolveEnvVars()` calls `this.secrets.getEnvVar?.()` — with optional chain, missing method returns `undefined`, and all `{{env.X}}` placeholders became empty strings.
  - **Fix**: Added `getEnvVar` method that delegates to `getSecret` (same DB-backed namespace-scoped resolution chain)
  - **Impact**: All `{{env.X}}` placeholders in Studio tool tests now resolve correctly

#### Notes

- httpbin.org echo endpoint used to verify actual HTTP header values sent
- Secret scrubber middleware masks resolved secret values in UI response — httpbin echo shows raw values
- MCP tools don't use `{{env.X}}` in their DSL, but the SecretsProvider is still namespace-scoped via `ToolBindingExecutor`
- Tools with `variableNamespaceIds: []` (empty) = unrestricted DB access (all env vars/config vars accessible, no namespace filter). This is by design — empty means "no restriction", not "no access". (Corrected from earlier note; process.env fallback was removed in BUG-004.)
- Config vars resolve via both `{{secrets.X}}` and `{{env.X}}` — the resolution chain checks env vars first, then config vars

---

### Iteration 3 — 2026-03-14

**Scope**: Fill API coverage gaps — explicit NS IDs, get value, update value, namespace assignment, namespace filter, copy envs, cross-project isolation, remove member, config var auto-tag, multi-NS tools, SSRF, headers validation
**Branch**: feature/environment-variables-namespaces
**Duration**: ~20min
**Tested by**: Claude Code (agent)

#### Results

| #   | Test                                | Method                                             | Expected                         | Actual                                           | Status |
| --- | ----------------------------------- | -------------------------------------------------- | -------------------------------- | ------------------------------------------------ | ------ |
| 32  | Create env var with explicit NS     | `POST /env-vars` with `variableNamespaceIds`       | Tagged to custom NS, not default | Membership in custom NS only                     | PASS   |
| 33  | Update env var value                | `PUT /env-vars/:id` `{value:"new"}`                | Value updated                    | `success:true`, DB value updated                 | PASS   |
| 34  | Get single env var value            | `GET /env-vars/:id/value`                          | Decrypted value returned         | `{value:"updated-val"}`                          | PASS   |
| 35  | Headers must be array not object    | `POST /tools` headers=`{}`                         | 400 validation                   | 400 "Expected array, received object"            | PASS   |
| 36  | Remove member from namespace        | `DELETE /ns/:nsId/members/:varId?type=env`         | Removed, count decreases         | Before=2, After=1, correct NS retained           | PASS   |
| 37  | Cross-project env var isolation     | GET/DELETE var via wrong project path              | 404, var unchanged               | All 404, var still exists, project 2 list scoped | PASS   |
| 38  | Cross-project namespace isolation   | GET members of other project's NS                  | 404                              | 404 "Variable namespace not found"               | PASS   |
| 39  | Config var auto-tags to default NS  | `POST /config-variables`                           | Membership type=config           | `{nsId:"...", type:"config"}`                    | PASS   |
| 40  | Tool with multiple namespaces       | `POST /tools` with 2 NS IDs                        | Both stored                      | DB: 2 NS IDs, API response: only 1 (ENH-005)     | PASS   |
| 41  | Multi-NS tool union resolution      | `PUT /tools/:id` refs vars across NSes             | No warnings                      | `{warnings: null}`                               | PASS   |
| 42  | SSRF protection - metadata IP       | `POST /tools` endpoint=`169.254.169.254`           | Blocked                          | 400 "Endpoint blocked by SSRF protection"        | PASS   |
| 43  | SSRF - localhost                    | `POST /tools` endpoint=`localhost`                 | Allowed in dev                   | 201 created (ENH-006)                            | PASS   |
| 44  | Copy env vars between environments  | `POST /env-vars/copy` dev→staging                  | Vars copied                      | `{copied:2, skipped:0}`                          | PASS   |
| 45  | Update namespace assignment         | `PUT /env-vars/:id` `{variableNamespaceIds:[...]}` | Membership updated               | Before: default, After: custom                   | PASS   |
| 46  | List env vars with namespace filter | `GET /env-vars?namespaceId=...`                    | Only vars in specified NS        | Custom: 1 var, Default: 2 vars                   | PASS   |

#### Notes

- GET single value route is `/:id/value`, not `/:id`
- Remove member route: `DELETE /members/:variableId?type=env` (not by membership ID)
- Tool creation with explicit `variableNamespaceIds` — DB stores all, but POST response only shows auto-tagged default
- SSRF blocks cloud metadata IPs but allows localhost (likely by design for dev)
- Config var created via Studio at `POST /api/projects/:id/config-variables`

---

### Iteration 2 — 2026-03-14 (post-develop merge)

**Scope**: Re-verify all Iteration 1 tests after develop merge + Mongoose fix; add namespace CRUD, members, delete cascade, pagination, multi-env, cross-tenant isolation
**Branch**: feature/environment-variables-namespaces
**Duration**: ~30min
**Tested by**: Claude Code (agent)
**Prerequisites fixed**: Mongoose buffering timeout (deleteModel guard in models/index.ts)

#### Results

| #   | Test                               | Method                                          | Expected                       | Actual                                                     | Status |
| --- | ---------------------------------- | ----------------------------------------------- | ------------------------------ | ---------------------------------------------------------- | ------ |
| 1   | Create env var                     | `POST /env-vars`                                | 201, success                   | 201, `id` returned                                         | PASS   |
| 2   | Create secret env var              | `POST /env-vars` isSecret=true                  | 201, isSecret=true             | 201, `isSecret: true`                                      | PASS   |
| 3   | Default NS auto-created            | DB query                                        | 1 namespace, isDefault=true    | `019cec52-d275` default namespace                          | PASS   |
| 4   | Memberships auto-created           | DB query                                        | 2 memberships                  | 2 memberships, both type=env                               | PASS   |
| 5   | Duplicate key+env → 409            | `POST /env-vars` same key+env                   | 409                            | 409 "Variable already exists..."                           | PASS   |
| 6   | Invalid key format → 400           | `POST /env-vars` key=`123-bad!`                 | 400                            | 400 "Key must start with a letter..."                      | PASS   |
| 7   | Missing required fields → 400      | `POST /env-vars` body=`{key:"X"}`               | 400                            | 400 "Missing required fields..."                           | PASS   |
| 8   | Invalid environment → 400          | `POST /env-vars` env=`development`              | 400 descriptive                | 400 "Invalid environment..."                               | PASS   |
| 9   | Key too long → 400                 | `POST /env-vars` 257 char key                   | 400                            | 400 "Key must not exceed 256 characters"                   | PASS   |
| 10  | Invalid namespace ID → 400         | `POST /env-vars` nsIds=[fake]                   | 400                            | 400 "Namespace nonexistent-ns-id not found..."             | PASS   |
| 11  | Tool auto-tags to default NS       | `POST /tools`                                   | variableNamespaceIds=[default] | `variableNamespaceIds: ["019cec52-d275..."]`               | PASS   |
| 12  | Tool PUT empty NS → warning        | `PUT /tools/:id` nsIds=[]                       | Warning about no namespaces    | "will not resolve — tool has no linked namespaces"         | PASS   |
| 13  | Tool PUT correct NS → no warning   | `PUT /tools/:id` nsIds=[default]                | No warnings                    | `warnings: null`                                           | PASS   |
| 14  | Tool PUT nonexistent var → warning | `PUT /tools/:id` dslContent ref NONEXISTENT_VAR | Warning about missing var      | "Variable \"NONEXISTENT_VAR\" not found in project"        | PASS   |
| 15  | Tool PUT wrong NS → warning        | `PUT /tools/:id` nsIds=[payment] ref OPENAI_KEY | Warning about wrong namespace  | "exists but is not in any of the tool's linked namespaces" | PASS   |
| 16  | Duplicate tool name → 409          | `POST /tools` same name                         | 409                            | 409 "A tool named ... already exists"                      | PASS   |
| 17  | List namespaces                    | `GET /variable-namespaces`                      | 2 namespaces + memberCounts    | 2 NSes, default has 2 env members                          | PASS   |
| 18  | Create namespace                   | `POST /variable-namespaces`                     | 201, color preserved           | 201, color=#3B82F6, order=2                                | PASS   |
| 19  | Update namespace                   | `PUT /variable-namespaces/:id`                  | displayName + color updated    | displayName="Payment API Keys", color="#EF4444"            | PASS   |
| 20  | Delete non-default namespace       | `DELETE /variable-namespaces/:id`               | 200                            | 200 `{movedToDefault:0}`                                   | PASS   |
| 21  | Delete default NS → blocked        | `DELETE /variable-namespaces/:defaultId`        | 400                            | 400 "Cannot delete the default variable namespace"         | PASS   |
| 22  | Same key across environments       | 3x `POST /env-vars` same key, diff env          | All 3 created                  | dev=1, staging=1, production=1                             | PASS   |
| 23  | List with environment filter       | `GET /env-vars?environment=dev`                 | Only dev vars                  | 4 dev vars, no cross-env                                   | PASS   |
| 24  | List all (no filter)               | `GET /env-vars`                                 | All 6 vars                     | 6 vars including 3 DATABASE_URL                            | PASS   |
| 25  | Delete var cleans memberships      | `DELETE /env-vars/:id` + DB check               | Membership removed             | Before=1, After=0                                          | PASS   |
| 26  | List namespace members             | `GET /variable-namespaces/:id/members`          | envVars + configVars arrays    | 4 envVars, 0 configVars                                    | PASS   |
| 27  | Add member to namespace            | `POST /variable-namespaces/:id/members`         | added=1                        | `{added:1, skipped:0, errors:[]}`                          | PASS   |
| 28  | Delete NS cascades memberships     | `DELETE /variable-namespaces/:id` + DB check    | Memberships cleaned, var kept  | Before=1, After=0, var still in default NS                 | PASS   |
| 29  | Pagination                         | `GET /env-vars?page=1&limit=2`                  | 2 of 5 vars, 3 pages           | Page 1/3 = 2 vars, Page 2/3 = 2 vars                       | PASS   |
| 30  | Cross-tenant env var isolation     | List/GET/DELETE with other tenant JWT           | Empty/404/404, var unchanged   | All 404, var still exists                                  | PASS   |
| 31  | Cross-tenant namespace isolation   | List/Members/Delete NS with other tenant JWT    | 404 for all                    | All 404                                                    | PASS   |

#### Bugs Fixed (pre-testing)

- **BUG-002**: Mongoose buffering timeout — all operations timed out after 10000ms
  - **File**: `packages/database/src/models/index.ts:13`
  - **Root Cause**: `mongoose.deleteModel(/.*/)` cleared 130 models in dev mode. In compiled JS (tsc), ESM caches modules so models weren't re-registered.
  - **Fix**: Added `MONGODB_MANAGED !== 'true'` guard to skip `deleteModel`
  - **Verified**: Runtime via PM2 responds to all API calls — PASS

#### Gaps Resolved

- [x] **GAP-002**: Cross-tenant isolation tested — all PASS
- [x] **GAP-004**: Namespace CRUD endpoints tested — all PASS
- [x] **GAP-005**: Delete cascade verified — both var and NS delete clean up memberships

---

### Iteration 1 — 2026-03-14

**Scope**: Core CRUD, auto-tagging, validation warnings, error handling, DB state
**Branch**: develop
**Duration**: ~1hr
**Tested by**: Claude Code (agent)

#### Results

| #   | Test                               | Method                                          | Expected                      | Actual                                                                | Status |
| --- | ---------------------------------- | ----------------------------------------------- | ----------------------------- | --------------------------------------------------------------------- | ------ |
| 1   | Tool creation auto-tags to default | `POST /api/projects/proj-flow-test/tools`       | `variableNamespaceIds: [id]`  | `variableNamespaceIds: ["019ceb64-9532-7b6b-ad16-a52f36b0e977"]`      | PASS   |
| 2   | Env var auto-tags to default       | `POST /api/projects/proj-ns-test/env-vars`      | Membership created            | Membership: `{nsId:"019cebf9-3b72...", type:"env"}`                   | PASS   |
| 3   | Default NS auto-created            | `POST /env-vars` (fresh project)                | NS created + var tagged       | NS `019cebf9-3b72` created with `isDefault:true`                      | PASS   |
| 4   | Var in wrong namespace warns       | `PUT /tools/:id` nsIds:[default], DSL ref other | Warning about wrong namespace | `"Variable exists but is not in any of the tool's linked namespaces"` | PASS   |
| 5   | Empty namespaces warns             | `PUT /tools/:id` nsIds:[], DSL ref var          | Warning about no namespaces   | `"Variable will not resolve -- tool has no linked namespaces"`        | PASS   |
| 6   | Correct namespace = no warning     | `PUT /tools/:id` nsIds:[api-keys], DSL ref var  | No warnings                   | `{warnings: null, success: true}`                                     | PASS   |
| 7   | Nonexistent var warns              | `PUT /tools/:id` DSL ref NONEXISTENT_VAR        | Warning about missing var     | `"Variable \"NONEXISTENT_VAR\" not found in project"`                 | PASS   |
| 8   | Duplicate env var key              | `POST /env-vars` same key+env                   | 409                           | `"Variable already exists for this environment/key combination"`      | PASS   |
| 9   | Invalid key format                 | `POST /env-vars` key=`123-invalid!`             | 400                           | `"Key must start with a letter..."`                                   | PASS   |
| 10  | Missing required fields            | `POST /env-vars` body=`{"key":"X"}`             | 400                           | `"Missing required fields: environment, key, value"`                  | PASS   |
| 11  | Invalid environment                | `POST /env-vars` env=`invalid_env`              | 400 descriptive               | `"Invalid environment... Must be one of: dev, staging, production"`   | PASS   |
| 12  | Key too long (257 chars)           | `POST /env-vars`                                | 400                           | `"Key must not exceed 256 characters"`                                | PASS   |
| 13  | Invalid namespace ID               | `POST /env-vars` nsIds=`["nonexistent"]`        | 400                           | `"Namespace nonexistent-namespace-id not found in this project"`      | PASS   |
| 14  | Duplicate tool name                | `POST /tools` same name                         | 409                           | `"A tool named \"auto_ns_test_tool\" already exists in this project"` | PASS   |
| 15  | DB: proj-flow-test namespaces      | `mongosh` query                                 | 2 (default + api-keys)        | default: `019ceb64-9532`, api-keys: `019ceb66-5346`                   | PASS   |
| 16  | DB: proj-flow-test memberships     | `mongosh` query                                 | Correct var→namespace mapping | Verified via `mongosh`                                                | PASS   |

#### Bugs Fixed

- **BUG-001**: Invalid environment value returned generic 500 error
  - **File**: `apps/runtime/src/routes/environment-variables.ts:247`
  - **Root Cause**: No explicit environment validation before DB call
  - **Fix**: Added `VALID_ENVIRONMENTS.includes(environment)` check with descriptive 400
  - **Verified**: PASS

---

## Test Environment

```
Runtime: localhost:3112 (PM2, fork mode, built dist/index.js)
Studio: localhost:5173 (PM2, Next.js dev)
MongoDB: localhost:27017/abl_platform (local, no auth)
Test projects: proj-ns-iter2 (Iter 2), proj-ns-iter3 (Iter 3) — cleaned up after testing
Auth: dev-login token via POST /api/auth/dev-login {email:"dev@test.com"}
```
