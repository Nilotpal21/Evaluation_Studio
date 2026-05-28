---
name: testing-toolkit
description: Use when performing live end-to-end testing — API, UI browser automation, MongoDB, PM2 logs. Tests real user workflows. Zero assumptions — verify everything. Fix bugs immediately. Maintains ONE persistent doc per feature in docs/testing/ that evolves across iterations.
---

# Testing Toolkit

Live end-to-end testing for the ABL platform. Tests real user workflows against running services. **Not for unit tests.**

## ZERO ASSUMPTIONS POLICY

**These rules are non-negotiable. Violating any one of them invalidates the test session.**

1. **Never trust a response you didn't inspect.** If `jq` returns `null`, the field doesn't exist — don't assume success. Print the full response and read it.
2. **Never assume a side effect happened.** If you create an env var that should auto-tag to a namespace, query MongoDB and prove it. No "it probably worked."
3. **If any output is unexpected, STOP and investigate.** Don't proceed to the next test. Read the source code, check logs, find the root cause.
4. **Fix every bug immediately — no exceptions.** When you find a bug during testing, fix it right then. Read the source, understand the issue, edit the file, rebuild, restart, and re-verify. Never log a bug and move on. Never defer a bug to a future iteration. The test session cannot end with any observed-but-unfixed bugs.
5. **Verify the fix worked.** After fixing a bug, re-run the exact same test that found it. The fix isn't done until the test passes.
6. **Check logs after every failure.** `pm2 logs runtime --lines 30 --nostream` — the actual error is usually in the logs, not the API response.
7. **Check DB state after every write operation.** API said `{success: true}`? Prove it with a `mongosh` query. The response could be lying (stale cache, wrong serialization, silent error swallowed in catch block).
8. **If a response is HTML instead of JSON, you have the wrong URL.** Don't retry — figure out the correct route path by reading the server source.
9. **If a response is `null` or `undefined` for a field you expected, the field name is wrong.** Read the route handler source to see the actual response shape.
10. **Use a dedicated test project per feature.** This avoids cross-feature interference without needing cleanup. Test data can stay — it serves as reference for future iterations.

---

## MANDATORY: One Doc Per Feature — Living Test Guide

**Every feature gets exactly ONE document in `docs/testing/` that persists across all test iterations.** This document is the single source of truth for what works, what doesn't, what's been tested, and what's pending. Anyone reading it can understand the full testing history and current state of the feature at a glance.

### File Convention

```
docs/testing/
  <feature-name>.md          ← ONE file, updated every iteration
```

Examples: `variable-namespaces.md`, `tool-auto-tagging.md`, `deployment-snapshots.md`

**No date prefixes in filenames.** Dates go inside the document as iteration timestamps.

### Document Structure

The document has these sections, maintained in order:

```markdown
# Feature Test Guide: <Feature Name>

**Feature**: <one-line description of the feature>
**Owner**: <who owns this feature>
**Branch**: <current branch>
**First tested**: <date of first iteration>
**Last updated**: <date of most recent iteration>
**Overall status**: NOT STARTED | IN PROGRESS | STABLE | REGRESSION

---

## Current State (as of <latest iteration date>)

A short paragraph (3-5 sentences) summarizing the current health of this feature.
What works end-to-end? What's broken? What hasn't been tested yet?
This section is REWRITTEN every iteration — it always reflects the latest state.

### Quick Health Dashboard

| Area                     | Status  | Last Verified | Notes                          |
| ------------------------ | ------- | ------------- | ------------------------------ |
| API CRUD                 | PASS    | 2026-03-14    | All endpoints working          |
| Validation / Errors      | PASS    | 2026-03-14    | Specific error messages        |
| DB State Consistency     | PASS    | 2026-03-14    | All records match API          |
| Cross-Tenant Isolation   | —       | Not tested    | Planned for next iteration     |
| UI Rendering             | PARTIAL | 2026-03-14    | List works, edit form untested |
| UI Interactions          | —       | Not tested    |                                |
| Namespace Integration    | PASS    | 2026-03-14    |                                |
| Performance / Edge Cases | —       | Not tested    |                                |

Status values: PASS | FAIL | PARTIAL | REGRESSION | — (not tested)

---

## Test Coverage Map

A comprehensive list of EVERY testable behavior for this feature.
Each item is checked off when verified, with the iteration it was tested in.

### API Tests

- [x] Create basic resource — `Iteration 1 (2026-03-14) PASS`
- [x] Create with all optional fields — `Iteration 1 (2026-03-14) PASS`
- [x] List with pagination — `Iteration 2 (2026-03-15) PASS`
- [ ] List with namespace filter — `Not tested`
- [x] Update single field — `Iteration 1 (2026-03-14) PASS`
- [ ] Update with invalid data — `Not tested`
- [x] Delete and verify cascade — `Iteration 2 (2026-03-15) PASS`
- [ ] Bulk operations — `Not tested`

### Validation & Error Handling

- [x] Missing required fields → 400 — `Iteration 1 (2026-03-14) PASS`
- [x] Invalid format → 400 with specific message — `Iteration 1 (2026-03-14) PASS`
- [ ] Payload too large → 413 — `Not tested`

### DB State Verification

- [x] Record created with correct fields — `Iteration 1 (2026-03-14) PASS`
- [x] Cascade delete cleans up related records — `Iteration 2 (2026-03-15) PASS`
- [ ] Index performance on large datasets — `Not tested`

### Security & Isolation

- [ ] Cross-tenant access returns 404 — `Not tested`
- [ ] Cross-project access returns 404 — `Not tested`

### UI Tests

- [ ] Page renders with correct data — `Not tested`
- [ ] Create form works end-to-end — `Not tested`
- [ ] Edit form pre-fills and saves — `Not tested`
- [ ] Delete with confirmation dialog — `Not tested`
- [ ] No console errors throughout — `Not tested`

### Integration / Edge Cases

- [ ] Works with deployment snapshots — `Not tested`
- [ ] Concurrent create doesn't duplicate — `Not tested`

---

## Open Gaps

Areas not yet tested. **This section is ONLY for untested areas, NEVER for observed bugs.** If you observe a bug during testing, you MUST fix it immediately (see Section 4). A bug that was seen and not fixed is a skill violation.

- **GAP-003**: Cross-tenant isolation not tested
  - **Severity**: High
  - **Reason**: No second tenant JWT set up

- **GAP-004**: UI edit form not verified
  - **Severity**: Medium
  - **Blocked by**: Browser automation setup

---

## Pending / Future Work

Items that are out of scope for current iterations but should be tested eventually.

- [ ] Performance testing with 1000+ variables
- [ ] Concurrent multi-user editing
- [ ] Webhook/event emission on CRUD
- [ ] Import/export round-trip with namespaces
- [ ] Rate limiting on bulk operations

---

## Enhancement Ideas

Improvements discovered during testing that would make the feature better (not bugs — product ideas).

- **ENH-001** (Iteration 1): Bulk variable create endpoint would reduce N+1 API calls for project setup
- **ENH-002** (Iteration 2): Namespace color picker in UI should preview the tag appearance

---

## Iteration Log

Reverse chronological — newest first. Each iteration is a snapshot of one test session.

### Iteration 2 — 2026-03-15

**Scope**: Pagination, delete cascade, namespace filtering
**Branch**: feature/environment-variables-namespaces
**Duration**: ~45min
**Tested by**: Claude Code (agent)

#### Results

| #   | Test                               | Method                         | Expected           | Actual                   | Status |
| --- | ---------------------------------- | ------------------------------ | ------------------ | ------------------------ | ------ |
| 7   | List with pagination               | `GET /env-vars?page=2&limit=5` | Page 2 results     | 5 results, correct total | PASS   |
| 8   | Delete cascade removes memberships | `DELETE /env-vars/:id`         | Membership cleaned | Verified via mongosh     | PASS   |

#### Bugs Fixed

- **BUG-002**: Delete endpoint didn't clean up namespace memberships
  - **File**: `apps/runtime/src/routes/environment-variables.ts:480`
  - **Root Cause**: Missing `removeVariableNamespaceMembership` call in delete handler
  - **Fix**: Added membership cleanup before delete
  - **Verified**: Re-ran delete test, memberships gone

#### Gaps Resolved

- [x] GAP-002 (from Iteration 1): Pagination returned wrong total count — fixed

#### New Gaps Found

- **GAP-003**: Cross-tenant isolation not tested (see Open Gaps)

---

### Iteration 1 — 2026-03-14

**Scope**: Core CRUD, validation, auto-tagging, DB state
**Branch**: develop
**Duration**: ~1hr
**Tested by**: Claude Code (agent)

#### Results

| #   | Test                          | Method                                     | Expected                  | Actual                             | Status |
| --- | ----------------------------- | ------------------------------------------ | ------------------------- | ---------------------------------- | ------ |
| 1   | Create env var                | `POST /env-vars`                           | 201, success=true         | 201, success=true                  | PASS   |
| 2   | Auto-tag to default namespace | DB query after create                      | Membership record created | Membership: {nsId:..., type:"env"} | PASS   |
| 3   | Duplicate key+env             | `POST /env-vars` same key+env              | 409                       | 409 "Variable already exists..."   | PASS   |
| 4   | Invalid key format            | `POST /env-vars` key=`123bad`              | 400                       | 400 "Key must start with a letter" | PASS   |
| 5   | Missing fields                | `POST /env-vars` body=`{"key":"X"}`        | 400                       | 400 "Missing required fields..."   | PASS   |
| 6   | Invalid environment           | `POST /env-vars` environment=`development` | 400 descriptive           | 400 "Invalid environment..."       | PASS   |

#### Bugs Fixed

- **BUG-001**: Invalid environment value returned generic 500 error
  - **File**: `apps/runtime/src/routes/environment-variables.ts:247`
  - **Root Cause**: No explicit environment validation before DB call; Mongoose error caught by generic handler
  - **Fix**: Added `VALID_ENVIRONMENTS.includes(environment)` check with descriptive 400
  - **Verified**: Re-ran test, got specific error message

#### Gaps Found

- **GAP-001** [FIXED in this iteration]: Generic error for invalid environment
- **GAP-002**: Pagination total count wrong when namespace filter active

---

## Test Environment

Runtime: localhost:3112 (PM2, fork mode)
Studio: localhost:5173 (PM2, Next.js dev)
MongoDB: localhost:27017/abl_platform (local, no auth)
Test project: <updated per iteration>
```

### Rules for Maintaining the Document

1. **Before starting a test session**, READ the existing doc for this feature (if it exists). Understand what's already been tested.
2. **"Current State" section**: REWRITE completely every iteration. Always reflects the latest truth.
3. **"Quick Health Dashboard"**: UPDATE status and "Last Verified" date for areas you tested. Don't change rows you didn't test.
4. **"Test Coverage Map"**: CHECK OFF items you verified. Add new items if you discover untested behaviors. Never uncheck a previously passing item unless it regressed — instead mark it `REGRESSION` with the iteration.
5. **"Open Gaps"**: ADD new gaps. REMOVE gaps when fixed (reference which iteration fixed them).
6. **"Pending / Future Work"**: ADD ideas as you discover them. CHECK OFF when tested in a future iteration.
7. **"Enhancement Ideas"**: ADD product improvement ideas discovered during testing.
8. **"Iteration Log"**: PREPEND a new iteration block at the top (newest first). Never edit past iterations.
9. **"Test Environment"**: UPDATE if anything changed (ports, project IDs, etc).
10. **If a feature doc doesn't exist yet**, create it using the template above. Fill in Iteration 1.
11. **If a feature doc already exists**, read it, add a new iteration, and update all living sections.

### What Each Section Answers

| Section           | Question it answers                                          |
| ----------------- | ------------------------------------------------------------ |
| Current State     | "Is this feature working right now?"                         |
| Health Dashboard  | "At a glance, what areas are green/red/untested?"            |
| Test Coverage Map | "What exactly has been tested and what hasn't?"              |
| Open Gaps         | "What's broken or missing that needs attention?"             |
| Pending / Future  | "What should we test next?"                                  |
| Enhancement Ideas | "What product improvements did we discover?"                 |
| Iteration Log     | "What happened in each test session? What was the timeline?" |
| Test Environment  | "How do I reproduce these results?"                          |

### README Index Update

After creating or updating a feature doc, update `docs/testing/README.md`:

```markdown
# Testing Results

Living test guides for ABL platform features. Each file tracks one feature across all test iterations.

## Feature Index

| Feature              | Status      | Last Tested | Iterations | Gaps Open |
| -------------------- | ----------- | ----------- | ---------- | --------- |
| Variable Namespaces  | STABLE      | 2026-03-15  | 3          | 1         |
| Tool Auto-Tagging    | IN PROGRESS | 2026-03-14  | 1          | 2         |
| Deployment Snapshots | NOT STARTED | —           | 0          | —         |
```

---

## Prerequisites

```bash
pm2 list                                                          # Services running?
curl -s http://localhost:3112/health | jq .                        # Runtime up?
curl -s http://localhost:5173 -o /dev/null -w "%{http_code}\n"     # Studio up?
mongosh --quiet mongodb://localhost:27017/abl_platform --eval "db.runCommand({ping:1})"  # DB up?
```

After code changes:

```bash
# Runtime: MUST build + restart (no HMR)
pnpm build --filter=@agent-platform/runtime && pm2 restart runtime

# Studio: HMR auto-picks up API route changes. If stale: pm2 restart studio
```

---

## 1. Authentication

### Access Token

```bash
STUDIO_RESP=$(curl -s -X POST http://localhost:5173/api/auth/dev-login \
  -H 'Content-Type: application/json' \
  -d '{"email":"test@example.com","name":"Test User"}')
TOKEN=$(echo "$STUDIO_RESP" | jq -r '.accessToken')
REFRESH_TOKEN=$(echo "$STUDIO_RESP" | jq -r '.refreshToken')

# VERIFY — don't assume token is valid
echo "$TOKEN" | cut -d. -f1-2 | base64 -d 2>/dev/null | jq .
```

- Rate limited: 10/15min. Restart the service and retry.
- Expires 15 min. Refresh: `curl -s -X POST http://localhost:5173/api/auth/refresh -H 'Content-Type: application/json' -d "{\"refreshToken\":\"$REFRESH_TOKEN\"}" | jq -r '.accessToken'`

Runtime checks `tenant_members`. Ensure it exists:

```bash
mongosh --quiet mongodb://localhost:27017/abl_platform --eval "
  if (!db.tenant_members.findOne({tenantId:'tenant-dev-001',userId:'test-user-001'})) {
    db.tenant_members.insertOne({tenantId:'tenant-dev-001', userId:'test-user-001', email:'test@example.com', role:'OWNER', status:'active', createdAt:new Date()});
  }
"
```

### Auth Errors — Diagnose, Don't Guess

| Error                           | Root Cause                      | Action                                                        |
| ------------------------------- | ------------------------------- | ------------------------------------------------------------- |
| `401`                           | Expired/invalid token           | Get fresh token. Don't retry old one.                         |
| `"Not a member of this tenant"` | No `tenant_members` record      | Insert record (see above). Don't change the JWT.              |
| `"Too many login attempts"`     | Rate limit                      | Restart the service and retry.                                |
| `404` on valid resource         | Wrong tenantId/projectId in JWT | Check JWT payload. Don't assume isolation bug.                |
| HTML response                   | Wrong URL                       | Read server source for correct route path. Don't add headers. |

---

## 2. Practical Use-Case Scenarios

**Test what real users do, not abstract CRUD.** Each scenario below simulates a real user workflow end-to-end.

### Use Case 1: Developer Sets Up a New Project with Secrets

_A developer creates a project, adds API keys as env vars, and expects them to be organized in namespaces._

```
STEPS:
1. Create a project (or use existing)
2. POST /env-vars with key=OPENAI_API_KEY, environment=dev
   → VERIFY API: success=true, variable.id exists
   → VERIFY DB: env var record exists with correct key (uppercased)
   → VERIFY DB: default namespace was auto-created (if first var in project)
   → VERIFY DB: membership record links var to default namespace
3. POST /env-vars with key=STRIPE_SECRET_KEY, environment=dev, isSecret=true
   → VERIFY API: success=true
   → VERIFY DB: isSecret=true on the record
4. GET /env-vars?environment=dev
   → VERIFY: both vars in response
   → VERIFY: secret values are NOT in the list response (metadata only)
5. Create a second namespace "payment-keys" via POST /variable-namespaces
   → VERIFY API: namespace created with correct name
   → VERIFY DB: namespace record exists
6. Move STRIPE_SECRET_KEY to "payment-keys" namespace via PUT /env-vars/:id
   → VERIFY API: success=true
   → VERIFY DB: old membership deleted, new membership in payment-keys namespace
   → VERIFY DB: OPENAI_API_KEY still in default namespace (unchanged)

```

### Use Case 2: Developer Creates an HTTP Tool That Uses Secrets

_A developer creates a tool that calls an external API using a secret key, then links it to the right namespace._

```
STEPS:
1. Ensure env var OPENAI_API_KEY exists in namespace "default"
2. POST /tools to create an HTTP tool:
   name: "openai_completion", toolType: "http", endpoint: "https://api.openai.com/v1/chat/completions"
   method: "POST", headers: [{name:"Authorization", value:"Bearer {{secrets.OPENAI_API_KEY}}"}]
   → VERIFY API: tool created, variableNamespaceIds contains default namespace ID
   → VERIFY DB: project_tools record has variableNamespaceIds: [defaultNsId]
3. PUT /tools/:id to update DSL and link to specific namespace
   → VERIFY: no warnings (OPENAI_API_KEY is in the linked namespace)
4. PUT /tools/:id with variableNamespaceIds: [] (remove all namespaces)
   → VERIFY: warning "Variable OPENAI_API_KEY will not resolve — tool has no linked namespaces"
5. PUT /tools/:id with variableNamespaceIds: [wrong-namespace-id]
   → VERIFY: warning "Variable OPENAI_API_KEY exists but is not in any of the tool's linked namespaces"
6. DELETE /tools/:id
   → VERIFY API: deleted
   → VERIFY DB: no project_tools record

```

### Use Case 3: Admin Manages Environment Variables Across Environments

_An admin sets up config for dev, staging, and production with different values per environment._

```
STEPS:
1. POST /env-vars: key=DATABASE_URL, environment=dev, value="mongodb://localhost/dev"
2. POST /env-vars: key=DATABASE_URL, environment=staging, value="mongodb://staging-host/db"
3. POST /env-vars: key=DATABASE_URL, environment=production, value="mongodb://prod-host/db"
   → VERIFY: all three created (same key, different environments)
4. GET /env-vars?environment=dev → only dev value
5. GET /env-vars?environment=staging → only staging value
6. GET /env-vars?environment=production → only production value
   → VERIFY: no cross-environment leakage
7. PUT /env-vars/:devId with new value
   → VERIFY: only dev record updated, staging and production unchanged
8. DELETE /env-vars/:devId
   → VERIFY: dev deleted, staging and production still exist

```

### Use Case 4: Namespace-Scoped Variable Resolution (Isolation)

_Two tools in the same project have access to different secrets based on namespace._

```
STEPS:
1. Create namespace "frontend-keys" and "backend-keys"
2. Create env var STRIPE_PUBLIC → tag to "frontend-keys"
3. Create env var STRIPE_SECRET → tag to "backend-keys"
4. Create tool "payment_widget" → link to "frontend-keys" only
5. Create tool "payment_processor" → link to "backend-keys" only
6. PUT payment_widget DSL with {{secrets.STRIPE_SECRET}}
   → VERIFY: warning "STRIPE_SECRET exists but is not in any of the tool's linked namespaces"
   (frontend tool can't see backend secrets — isolation working)
7. PUT payment_processor DSL with {{secrets.STRIPE_SECRET}}
   → VERIFY: no warnings (backend tool can see backend secrets)
8. PUT payment_widget DSL with {{secrets.STRIPE_PUBLIC}}
   → VERIFY: no warnings (frontend tool can see frontend secrets)

```

### Use Case 5: Error Handling — Every Invalid Input Gets a Clear Message

_Test that the system never returns generic errors. Every bad input must get a specific, actionable error message._

```
STEPS (env vars):
1. POST with missing fields → 400 "Missing required fields: environment, key, value"
2. POST with key="123bad" → 400 "Key must start with a letter..."
3. POST with key=257 chars → 400 "Key must not exceed 256 characters"
4. POST with environment="development" → 400 "Invalid environment... Must be one of: dev, staging, production"
5. POST duplicate key+env → 409 "Variable already exists for this environment/key combination"
6. POST with invalid namespace ID → 400 "Namespace X not found in this project"
   → FOR EACH: if error message is generic (e.g., "Failed to create"), that's a BUG. Fix immediately.

STEPS (tools):
7. POST with duplicate name → 409 "A tool named X already exists..."
8. POST with endpoint="http://169.254.169.254/" → 400 "Endpoint blocked by SSRF protection"
9. POST with headers: {} (object) → 400 validation error (must be array [])
   → FOR EACH: if error message is unclear or generic, that's a BUG. Fix immediately.
```

### Use Case 6: Cross-Tenant Isolation

_No tenant should ever see another tenant's data, even with valid auth._

```
STEPS:
1. Create env var as tenant-dev-001
2. Generate JWT with tenantId="tenant-other-002"
3. GET /env-vars with tenant-other-002 token
   → VERIFY: 404 or empty list (NEVER tenant-dev-001's data)
   → If any data leaks, this is a CRITICAL security bug. Stop everything and fix.
4. Try PUT/DELETE on tenant-dev-001's var with tenant-other-002 token
   → VERIFY: 404 (not 403 — don't reveal existence)

```

---

## 3. UI Testing via Browser Automation

### Using Next DevTools MCP

```
mcp__next-devtools__browser_eval action="start"
mcp__next-devtools__browser_eval action="navigate" url="http://localhost:5173"
mcp__next-devtools__browser_eval action="screenshot"
mcp__next-devtools__browser_eval action="click" selector="[data-testid='create-tool-btn']"
mcp__next-devtools__browser_eval action="type" selector="input[name='key']" text="MY_VAR"
mcp__next-devtools__browser_eval action="evaluate" script="document.querySelectorAll('table tbody tr').length"
mcp__next-devtools__browser_eval action="console_messages"
```

### UI Use Case Scenarios

**After every UI action, check:** (1) no console errors, (2) correct data displayed, (3) DB state matches.

#### UC-UI-1: Developer Creates and Edits a Tool

```
1. Navigate to project tools page
2. Screenshot: verify tools list renders
3. Click "Create Tool" button
4. Fill: name, type=http, endpoint, method
5. Submit → screenshot → verify tool appears in list
6. Click new tool → verify detail page loads with correct data
7. Edit name inline → save → verify name updated in header and DB
8. Check namespace checkboxes → save → verify variableNamespaceIds in DB
9. Click delete → confirm → verify tool removed from list and DB
10. Check console_messages → verify zero errors throughout
```

#### UC-UI-2: Admin Manages Environment Variables

```
1. Navigate to admin env vars page
2. Screenshot: verify environment tabs visible (dev/staging/production)
3. Click "Create" → fill key/value/environment → save
4. Verify var appears in correct environment tab
5. Click "Reveal" on secret value → verify decryption shows actual value
6. Switch to different environment tab → verify no cross-env data
7. Assign namespace via tag popover → verify tag appears
8. Query DB: verify membership record created
9. Delete var → confirm → verify removed from list and DB
10. Check console_messages → verify zero errors throughout
```

#### UC-UI-3: Namespace Management

```
1. Open namespace management panel
2. Create namespace: name, displayName, color → save
3. Verify namespace appears in list with correct color
4. Edit displayName → save → verify updated
5. Verify namespace appears in dropdown filters on config vars page
6. Delete namespace → confirm → verify removed
7. Attempt to delete default namespace → verify blocked (should show error or disable button)
8. Query DB: verify namespace records match UI state
```

#### UC-UI-4: Config Variables with Namespace Filtering

```
1. Navigate to project config variables
2. Create variable "API_BASE_URL" with value
3. Verify appears in list
4. Open namespace dropdown → select specific namespace
5. Verify list filters to only vars in that namespace
6. Select "All Variables" → verify full list returns
7. Click namespace tag on variable → assign to new namespace
8. Verify tag popover shows correct checkbox state
9. Query DB: verify membership records match assignments
```

---

## 4. Bug-Fix Workflow (Mandatory)

When a test fails, follow this exact sequence:

```
1. STOP testing. Do not proceed to next test.
2. Print full API response: echo "$RESP" | jq .
3. Check PM2 logs: pm2 logs runtime --lines 30 --nostream
4. Check MongoDB state: mongosh query for relevant records
5. Read the source code of the failing route/handler
6. Identify the root cause (not symptoms)
7. Fix the code
8. Build: pnpm build --filter=@agent-platform/runtime (or studio)
9. Restart: pm2 restart runtime (or studio)
10. Re-run the EXACT same test that failed
11. Verify it passes
12. Update feature doc: mark gap as resolved, add bug to iteration log
13. Resume testing
```

**Never:**

- Skip a failing test ("I'll come back to it")
- Assume a fix worked without re-testing
- Log a bug as a gap and defer it to a future iteration
- End a test session with any observed-but-unfixed bugs
- Accept a generic error message ("Failed to create") when a specific one should exist

---

## 5. Route Reference

**Runtime (port 3112):**

| Method     | Path                                                   | Purpose                 |
| ---------- | ------------------------------------------------------ | ----------------------- |
| POST       | `/api/projects/:pid/env-vars`                          | Create env var          |
| GET        | `/api/projects/:pid/env-vars?environment=dev`          | List env vars           |
| PUT        | `/api/projects/:pid/env-vars/:id`                      | Update env var          |
| DELETE     | `/api/projects/:pid/env-vars/:id`                      | Delete env var          |
| GET/POST   | `/api/projects/:pid/variable-namespaces`               | List/Create namespaces  |
| PUT/DELETE | `/api/projects/:pid/variable-namespaces/:nsId`         | Update/Delete namespace |
| GET/POST   | `/api/projects/:pid/variable-namespaces/:nsId/members` | List/Add members        |
| POST       | `/api/projects/:pid/deployments`                       | Create deployment       |

**Studio (port 5173):**

| Method         | Path                                    | Purpose           |
| -------------- | --------------------------------------- | ----------------- |
| POST           | `/api/auth/dev-login`                   | Auth              |
| GET/POST       | `/api/projects/:id/tools`               | List/Create tools |
| GET/PUT/DELETE | `/api/projects/:id/tools/:toolId`       | Tool CRUD         |
| GET/POST       | `/api/projects/:id/config-variables`    | Config vars       |
| GET/POST       | `/api/projects/:id/variable-namespaces` | Namespaces        |

---

## 6. MongoDB Verification

```bash
# Check .env for correct port — 27017 (local) or 27018 (Docker)
mongosh --quiet mongodb://localhost:27017/abl_platform --eval "
  const pid = 'YOUR_PROJECT_ID';
  print('=== Namespaces ===');
  db.variable_namespaces.find({projectId:pid}).forEach(n =>
    print(JSON.stringify({name:n.name, isDefault:n.isDefault, _id:String(n._id)})));
  print('=== Memberships ===');
  db.variable_namespace_memberships.find({projectId:pid}).forEach(m =>
    print(JSON.stringify({varId:m.variableId, nsId:m.namespaceId, type:m.variableType})));
  print('=== Env Vars ===');
  db.environment_variables.find({projectId:pid}).forEach(v =>
    print(JSON.stringify({key:v.key, env:v.environment, _id:v._id})));
  print('=== Tools ===');
  db.project_tools.find({projectId:pid}).forEach(t =>
    print(JSON.stringify({name:t.name, nsIds:t.variableNamespaceIds})));
"
```

IDs are UUID v7 strings (`019ceb64-9532-...`), stored as strings in MongoDB (not ObjectId). Test data can stay — it serves as reference for future iterations. Use a dedicated test project per feature to avoid cross-feature interference.

---

## 7. PM2 Logs

```bash
pm2 logs runtime --lines 50 --nostream                              # Recent logs
pm2 logs runtime --lines 100 --nostream 2>&1 | grep ERROR            # Errors only
pm2 logs runtime --lines 100 --nostream 2>&1 | grep "\[MODULE\]"     # Specific module
```

**Always check logs after a failure.** The API response often hides the real error behind a generic message. The log has the actual stack trace or validation error.

---

## 8. Common Pitfalls

| Pitfall                          | Symptom                        | Action (not "fix" — investigate first)                                                       |
| -------------------------------- | ------------------------------ | -------------------------------------------------------------------------------------------- |
| Wrong MongoDB port               | Connection refused             | Read `.env` for the actual port. Don't guess.                                                |
| Studio route returns HTML        | `<!DOCTYPE html>`              | Read `apps/studio/src/app/api/` for the correct file-based route path.                       |
| `"development"` as environment   | 400 or Mongoose error          | Valid values: `dev`, `staging`, `production`. Read `VALID_ENVIRONMENTS`.                     |
| Token expired                    | 401                            | Regenerate. Studio: 15min expiry. Runtime self-signed: set 1hr.                              |
| `headers: {}` in tool create     | Validation error               | Schema requires array `[]`. Read `CreateProjectToolSchema`.                                  |
| PATCH for tool update            | 404                            | Only GET/PUT/DELETE exist. Read route file.                                                  |
| Build not picked up              | Old behavior after code change | Must `pnpm build --filter=PACKAGE && pm2 restart SERVICE`.                                   |
| Generic "Failed to create" error | 500 catch-all                  | Read the catch block in the route. The real error is in logs. This is a bug — fix it.        |
| `null` for expected field        | Wrong field name               | Read the route handler's `res.json()` call. The field name may differ from what you assumed. |
| Membership query returns empty   | Type mismatch                  | IDs are strings, not ObjectId. Verify exact string match in query.                           |

---

## 9. Test Data Conventions

| Entity       | Convention                     | Notes                                  |
| ------------ | ------------------------------ | -------------------------------------- |
| Tenant       | `tenant-dev-001`               | Default dev tenant                     |
| Environment  | `dev`, `staging`, `production` | NEVER `development`                    |
| Key format   | `UPPER_SNAKE_CASE`             | Auto-uppercased on create              |
| IDs          | UUID v7 strings                | `019ceb64-9532-7b6b-ad16-a52f36b0e977` |
| Tool headers | Array `[]`                     | Not object `{}`                        |
| Tool update  | PUT only                       | No PATCH endpoint                      |

**No cleanup needed.** Test data can persist — use a dedicated test project per feature to keep things isolated.
