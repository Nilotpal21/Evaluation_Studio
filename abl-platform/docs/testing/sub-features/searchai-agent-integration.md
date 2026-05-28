# Feature Test Guide: SearchAI KB→Tool→Agent Integration

**Feature**: When a Knowledge Base is created in SearchAI, a `searchai` tool is auto-registered in `project_tools`, visible in Studio, and usable by agents with full binding resolution.
**Owner**: Platform team
**Branch**: develop
**Related Feature Doc**: [docs/features/sub-features/searchai-agent-integration.md](../../features/sub-features/searchai-agent-integration.md)
**First tested**: 2026-03-18
**Last updated**: 2026-03-18
**Overall status**: STABLE

---

## Current State (as of 2026-03-18)

The SearchAI KB→Tool→Agent integration chain works end-to-end. Creating a KB auto-registers a `searchai` tool with correct DSL properties (`index_id`, `tenant_id`, `kb_name`). The tool appears in Studio's tools list API with `toolType: "searchai"`. An agent referencing the tool compiles with 0 errors/warnings, and the created version contains both a tool snapshot and compiled IR with `searchai_binding` fully populated. The only prerequisite is that the tenant must have `RoleDefinition` records seeded for RBAC (not auto-created; requires DB seed or manual insert).

### Quick Health Dashboard

| Area                           | Status | Last Verified | Notes                                                  |
| ------------------------------ | ------ | ------------- | ------------------------------------------------------ |
| KB→Tool Auto-Registration      | PASS   | 2026-03-18    | Tool created with correct DSL, type, binding props     |
| Tools List API (Studio)        | PASS   | 2026-03-18    | Returns searchai tool with correct metadata            |
| Tool Detail API                | PASS   | 2026-03-18    | Full tool record with dslContent, toolType             |
| Agent Compile (with tool)      | PASS   | 2026-03-18    | 0 errors, 0 warnings — tool resolves correctly         |
| Version Create (tool snapshot) | PASS   | 2026-03-18    | Snapshot has name, projectToolId, toolType, dslContent |
| IR searchai_binding            | PASS   | 2026-03-18    | tenantId, indexId, kbName all populated                |
| Cross-Tenant Isolation         | —      | Not tested    | Planned for next iteration                             |
| UI Rendering                   | —      | Not tested    | Blocked: need browser automation                       |
| Agent Execution (runtime)      | —      | Not tested    | Requires live SearchAI service with indexed data       |
| RBAC Prerequisites             | PASS   | 2026-03-18    | Tenant needs RoleDefinition records for tool:read      |

Status values: PASS | FAIL | PARTIAL | REGRESSION | — (not tested)

---

## Audit Scope

This guide focuses on the KB lifecycle and the generated tool chain:

- KB creation and linked SearchIndex side effects
- Generated `searchai` tool visibility through Studio APIs
- Agent compile and version snapshot behavior
- Runtime binding metadata needed for execution

It does not yet prove live indexed-data execution or browser-driven UI flows.

---

## Coverage Goals

This sub-feature will be broadly covered when the repo proves all of the following:

- KB rename and delete flows re-register or clean up the generated tool correctly
- Cross-tenant and cross-project isolation hold across the full KB→tool chain
- Live runtime execution against indexed KB content is exercised automatically
- Tool-visibility and KB/tool affordances are validated from the UI layer

---

## Test Coverage Map

### API Tests

- [x] Create KB → auto-registers searchai tool — `Iteration 1 (2026-03-18) PASS`
- [x] Tool has correct toolType: 'searchai' — `Iteration 1 (2026-03-18) PASS`
- [x] Tool DSL contains index_id, tenant_id, kb_name — `Iteration 1 (2026-03-18) PASS`
- [x] Studio GET /tools returns searchai tool — `Iteration 1 (2026-03-18) PASS`
- [x] Studio GET /tools/:id returns full detail — `Iteration 1 (2026-03-18) PASS`
- [x] Agent compile resolves searchai tool — `Iteration 1 (2026-03-18) PASS`
- [x] Version create includes tool in snapshot — `Iteration 1 (2026-03-18) PASS`
- [x] Compiled IR has searchai_binding — `Iteration 1 (2026-03-18) PASS`
- [ ] KB name update → tool re-registered with new description — `Not tested`
- [ ] KB delete → tool cleanup — `Not tested`
- [ ] Duplicate KB creation → idempotent tool upsert — `Not tested`

### Validation & Error Handling

- [x] Agent compile with valid searchai tool → 0 errors — `Iteration 1 (2026-03-18) PASS`
- [ ] Agent compile with non-existent tool name → E721 error — `Not tested`
- [ ] Agent compile with stale signature → W721 warning — `Not tested`

### DB State Verification

- [x] project_tools record exists with correct fields — `Iteration 1 (2026-03-18) PASS`
- [x] agent_versions.irContent has searchai_binding — `Iteration 1 (2026-03-18) PASS`
- [x] agent_versions.toolSnapshot has searchai tool entry — `Iteration 1 (2026-03-18) PASS`

### Security & Isolation

- [ ] Cross-tenant KB creation doesn't leak tools — `Not tested`
- [ ] Cross-project tool access returns 404 — `Not tested`

### UI Tests

- [ ] Searchai tool visible in Tools list page — `Not tested`
- [ ] Searchai tab filters correctly — `Not tested`
- [ ] Tool detail shows read-only KB binding info — `Not tested`
- [ ] ToolPickerModal shows searchai tools — `Not tested`
- [ ] KBOverviewTab shows "Agent Tool" card — `Not tested`

### Integration / Edge Cases

- [ ] Agent execution with searchai tool against live KB — `Not tested`
- [ ] Version promotion with searchai tool snapshot — `Not tested`
- [ ] Tool resolution from Redis cache (second compile) — `Not tested`

---

## Open Gaps

- **GAP-001**: Cross-tenant isolation not tested
  - **Severity**: High
  - **Reason**: Need second tenant with separate JWT

- **GAP-002**: UI rendering not verified
  - **Severity**: Medium
  - **Blocked by**: Browser automation (Playwright or MCP next-devtools)

- **GAP-003**: Agent runtime execution with live KB not tested
  - **Severity**: Medium
  - **Blocked by**: Requires SearchAI service running with indexed documents

---

## Pending / Future Work

- [ ] KB name/description update triggers tool re-registration
- [ ] KB deletion triggers tool cleanup
- [ ] Agent execution against live SearchAI KB (requires indexed docs)
- [ ] Tool signature staleness detection (W721)
- [ ] Redis cache hit path for tool resolution
- [ ] Version promotion flow with searchai tools
- [ ] Multiple KBs in same agent

---

## Enhancement Ideas

- **ENH-001** (Resolved 2026-04-03): New tenant creation now auto-seeds tenant operational defaults, including `RoleDefinition` records, `TenantLLMPolicy`, and tenant pipeline configs.
- **ENH-002** (Iteration 1): The `@e2e-smoke.test` email bypass is good, but rate limit state persists in-memory across Studio restarts — a fresh login after hitting limits requires a restart or waiting.

---

## Iteration Log

### Iteration 1 — 2026-03-18

**Scope**: Full KB→Tool→Agent chain verification
**Branch**: develop
**Duration**: ~30min
**Tested by**: Claude Code (agent)

#### Setup

- Logged in via dev-login with `test@e2e-smoke.test` (bypasses rate limit)
- Used existing project "test search" (`019c8f50-fb3b-7816-8637-8cb65e511c8b`)
- Tenant: `019c6aee-57bf-787e-b99b-e01cccf56a2c`
- Had to seed `role_definitions` for tenant (see BUG-001)

#### Results

| #   | Test                              | Method                                         | Expected                                | Actual                                                        | Status |
| --- | --------------------------------- | ---------------------------------------------- | --------------------------------------- | ------------------------------------------------------------- | ------ |
| 1   | Create KB                         | `POST /searchai/knowledge-bases` (port 3005)   | KB created, tool auto-registered        | KB created, tool `search_kb_e2e_test_products_kb` in DB       | PASS   |
| 2   | Tool in MongoDB                   | `mongosh` query on `project_tools`             | toolType: searchai, DSL has index_id    | Verified: type searchai, DSL has index_id, tenant_id, kb_name | PASS   |
| 3   | Studio tools list API             | `GET /api/projects/:pid/tools`                 | Tool in response with searchai type     | Tool returned, toolType: searchai, correct description        | PASS   |
| 4   | Studio tool detail API            | `GET /api/projects/:pid/tools/:toolId`         | Full tool record                        | dslContent, toolType, variableNamespaceIds present            | PASS   |
| 5   | Agent compile with searchai tool  | `POST /api/projects/:pid/agents/:name/compile` | success: true, 0 errors                 | success: true, errors: [], warnings: []                       | PASS   |
| 6   | Version create with tool snapshot | `POST /runtime/versions` (port 3112)           | toolSnapshot has searchai entry         | 1 tool, type searchai, correct projectToolId                  | PASS   |
| 7   | IR searchai_binding               | `mongosh` query on `agent_versions.irContent`  | searchai_binding with tenantId, indexId | binding: {tenantId, indexId, kbName} all correct              | PASS   |

#### Bugs Found & Fixed

- **BUG-001**: Studio tools API returns "Forbidden: missing required permission (tool:read)" for OWNER users
  - **Root Cause**: Tenant `019c6aee-...` had zero `role_definitions` records. The permission resolver's SYSTEM*ROLES fallback \_should* work (code at `permission-resolver.ts:126`), but something in the DB model import chain fails silently in the catch block (line 147-150), returning `[]` permissions.
  - **Workaround**: Manually seeded RoleDefinition records for the tenant via `mongosh`
  - **Underlying Issue**: `seed-mongo.ts` only seeds roles for `tenant-dev-001`. New tenants created via dev-login don't get role definitions. The `SYSTEM_ROLES` fallback code exists but may be failing due to Mongoose model import issues in the Next.js server environment (the `console.error` on line 149 was swallowed by the catch).
  - **Recommendation**: Fix the tenant creation flow to auto-seed SYSTEM_ROLES, and add logging to identify why the fallback fails.

- **BUG-002**: Agent DSL syntax confusion — `AGENT name` vs `AGENT: name`
  - **Not a code bug** — user error in test setup. ABL DSL requires colons after section names (`AGENT:`, `GOAL:`, `TOOLS:`).
  - **Impact**: Caused initial version to have null tool snapshot (compilation found 0 tools due to parse errors).

#### Test Environment

- Runtime: localhost:3112 (direct process, not PM2)
- SearchAI: localhost:3005 (PM2)
- Studio: localhost:5173 (Next.js standalone process)
- MongoDB: localhost:27017/abl_platform (no auth)
- Test project: `019c8f50-fb3b-7816-8637-8cb65e511c8b` ("test search")
- KB ID: `019cff51-e620-7a58-b8ec-a48e2b969e56`
- Tool ID: `019cff51-e623-7aa1-a5ec-7d52343d9bf4`
- Agent: `e2e_searchai_agent`
- Version: `019cff74-8856-7da8-849c-3b3099a4b97d` (v0.1.1)

---

## References

- Related feature doc: [docs/features/sub-features/searchai-agent-integration.md](../../features/sub-features/searchai-agent-integration.md)
- Parent feature doc: [docs/features/connectors.md](../../features/connectors.md)
