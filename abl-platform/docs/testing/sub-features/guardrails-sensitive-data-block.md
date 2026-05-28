# Testing Guide: Guardrails — Sensitive Data Block

**Status**: PARTIAL
**Feature**: [Guardrails Sensitive Data Block](../../features/sub-features/guardrails-sensitive-data-block.md)
**Last Updated**: 2026-05-18
**Phase**: 7 (Post-Impl Sync)

> Authoring note: This is the canonical test spec. Implementation phase will track each scenario from `PLANNED` → `IMPLEMENTED` → `PASSING` in the Coverage Matrix and the per-scenario Status field.

---

## 0. Context & Scope

This document is the testing companion to [`guardrails-sensitive-data-block.md`](../../features/sub-features/guardrails-sensitive-data-block.md). It is the **canonical reference** for every test that must exist before this feature can transition from PLANNED → ALPHA → BETA → STABLE.

**Coverage philosophy** (from the test-spec Oracle pass on 2026-05-15):

- **DEEP coverage** (8-10+ scenarios): Activation gate (FR-7), Rule enable gate + `validateRule()` (FR-8), Post-detection entity filter (FR-6.4)
- **MEDIUM-DEEP coverage** (5-7 scenarios): Entity catalog endpoint (FR-10), `actionMessage` validation (FR-6.6, FR-6.9)
- **MEDIUM coverage** (3-5 scenarios): Schema fields + `failMode` (FR-5), Telemetry (FR-4), Decision matrix modal (FR-3)
- **LIGHT coverage** (2-3 scenarios): Preset rename (FR-1), Cross-link banner (FR-2), Policy list chips (FR-9), Entity multiselect UI (FR-6.1/6.2/6.3/6.5/6.7/6.8)

**Test architecture (mandatory per CLAUDE.md)**:

- E2E tests interact via HTTP API only (no Mongoose model imports; no direct DB)
- No `vi.mock` / `jest.mock` of `@agent-platform/*` or `@abl/*` or relative imports
- Only external third-party services (mock LLM, mock Stripe) may be mocked, and only via DI/separate HTTP server
- Real Express servers on random ports (`{ port: 0 }`) via `RuntimeApiHarness`
- Real MongoDB via `MongoMemoryServer` (in-process; no Docker)
- Pure functions (e.g. `validateRule()`) tested with zero mocks via `test.each` table-driven matrices

---

## 1. Coverage Matrix

Every FR in the feature spec has at least one test of the appropriate level. Type codes:

- **U** — unit / pure function
- **I** — integration / route + DB
- **E** — E2E / HTTP only via runtime
- **EP** — E2E via Studio Playwright
- **C** — component / React Testing Library

| FR      | Title                                                                               | Required Coverage          | Status   |
| ------- | ----------------------------------------------------------------------------------- | -------------------------- | -------- |
| FR-1.1  | Preset key rename `pii_protection` → `sensitive_data_block`                         | U + C + I                  | PASS     |
| FR-1.2  | Action enum restricted to `block`/`warn`/`escalate` for this preset                 | C + I (server passthrough) | PASS     |
| FR-1.3  | Default action = `block`, default `enabled = false`                                 | C + U                      | PASS     |
| FR-1.4  | Inline helper text + cross-link nav                                                 | C                          | PASS     |
| FR-2.1  | Settings → PII Protection cross-link banner rendered                                | C                          | it.todo  |
| FR-2.2  | Banner CTA opens Create Policy with SDB pre-expanded                                | EP                         | it.todo  |
| FR-2.3  | Banner 90-day TTL re-surface                                                        | U + C                      | it.todo  |
| FR-3.1  | Decision matrix first-run auto-open via localStorage                                | C + EP                     | it.todo  |
| FR-3.2  | "?" icon repeat access to matrix                                                    | C                          | it.todo  |
| FR-3.3  | WCAG APG dialog compliance (focus trap, Escape, role, aria)                         | C                          | it.todo  |
| FR-3.4  | i18n key resolution for matrix content                                              | U                          | it.todo  |
| FR-4.1  | Trace tag rename to `sensitive_data_block`                                          | I                          | PASS     |
| FR-4.2  | Analytics dashboards updated                                                        | Manual                     | DEFERRED |
| FR-5.1  | Action enum semantics (Studio string, schema Mixed, persistence)                    | I (round-trip)             | PASS     |
| FR-5.2  | `entities?: string[]` field added                                                   | U + I (round-trip)         | PASS     |
| FR-5.3  | `enabled?`, `presetKey?`, `actionMessage?` fields added; `kind` unchanged           | U + I                      | PASS     |
| FR-5.4  | `failMode` default flip + per-policy override                                       | U + I                      | PASS     |
| FR-6.1  | EntityMultiselect renders catalog + quick-preset radio                              | C                          | PASS     |
| FR-6.2  | `High-risk only` preset pre-selects SSN only                                        | C + U                      | PASS     |
| FR-6.3  | `All PII` preset selects all enabled-pack entities                                  | C + U                      | PASS     |
| FR-6.4  | Post-detection entity filter narrows results                                        | U + I + E                  | PASS     |
| FR-6.5  | Applies To + Confidence threshold + Action message exposed                          | C                          | PASS     |
| FR-6.6  | Default action message copy (channel-neutral)                                       | U + C                      | PASS     |
| FR-6.7  | `failMode` selector with consequence disclosure                                     | C + I                      | PASS     |
| FR-6.8  | Provider field read-only label when `builtin-pii` is only option                    | C                          | PASS     |
| FR-6.9  | Action message 500-char limit + HTML strip + null-byte rejection                    | U + I + C                  | PASS     |
| FR-7.1  | Activation requires >=1 enabled rule                                                | I + E                      | PASS     |
| FR-7.2  | Activation toggle disabled when policy empty                                        | C                          | it.todo  |
| FR-7.3  | Server returns `NO_ENABLED_RULES` on direct activate                                | E                          | PASS     |
| FR-7.4  | Auto-deactivation on last rule disable + Undo                                       | I + E                      | PASS     |
| FR-7.5  | Telemetry: `guardrail_activation_blocked`, `guardrail_auto_deactivation`            | I                          | PASS     |
| FR-8.1  | `validateRule()` per-checkType required fields                                      | U (~51 cases)              | PASS     |
| FR-8.2  | `validateRule()` exported from `packages/shared`                                    | U (import resolution)      | PASS     |
| FR-8.3  | Rule enable toggle disabled + tooltip lists missing fields                          | C                          | it.todo  |
| FR-8.4  | Server returns `RULE_INCOMPLETE` with `missingFields[]`                             | E                          | PASS     |
| FR-9.1  | Green-dot chips rendered per enabled rule                                           | C                          | it.todo  |
| FR-9.2  | "No rules enabled" muted text for empty policies                                    | C                          | it.todo  |
| FR-9.3  | SDB chip shows first 2 entities + `+N more`                                         | C                          | it.todo  |
| FR-9.4  | Chip click deep-links via `?ruleId=<id>`                                            | EP                         | it.todo  |
| FR-9.5  | >4 chips first 3 + `+N more`; hover reveals full                                    | C                          | it.todo  |
| FR-9.6  | Responsive >=1024px / <1024px                                                       | C (viewport tests)         | it.todo  |
| FR-10.1 | `GET /api/projects/:projectId/pii-entities` returns project's enabled-pack entities | I + E                      | PASS     |
| FR-10.2 | Studio SWR proxy caches catalog per project session                                 | C                          | it.todo  |
| FR-10.3 | Endpoint requires auth + project permission; cross-project returns 404              | I + E                      | PASS     |
| FR-10.4 | Disabled-pack entity warning on rule re-open                                        | C + E                      | it.todo  |

---

## 2. E2E Test Scenarios (Runtime HTTP-only)

**Count**: 14 executable E2E scenarios (E2E-1 through E2E-12, E2E-14, E2E-15) + 1 threat-model cross-reference (E2E-13 — coverage is at INT-4). Exceeds test-spec-playbook minimum of 5.

**Architecture**: Each `describe` block uses `startRuntimeApiHarness()` from `apps/runtime/src/__tests__/helpers/runtime-api-harness.ts`, bootstraps a project via `bootstrapProject()`, and where messages must flow through the LLM, spawns a mock LLM via `startMockLLM()` from `tools/agents/e2e-functional/mock-llm-server.js`. No `vi.mock`. No Mongoose model imports.

**Auth context for every scenario**: tenant `t-{nanoid}`, project `p-{nanoid}`, user `u-{nanoid}` with `guardrail:read`, `guardrail:write`, `pii-pattern:read` permissions (unless otherwise specified for isolation tests). Note: `guardrail:write` covers create / update / activate / delete in v1 — the `guardrail:activate` split is deferred (HLD §4 concern #4).

**File mapping** (canonical — Section 12 is the authoritative duplicate):

- `apps/runtime/src/__tests__/e2e/sensitive-data-block.e2e.test.ts` — E2E-1, E2E-2, E2E-3, E2E-4, E2E-7, E2E-8, E2E-14
- `apps/runtime/src/__tests__/e2e/sensitive-data-block-catalog.e2e.test.ts` — E2E-5, E2E-6, E2E-15
- `apps/runtime/src/__tests__/e2e/sensitive-data-block-tenant-scope.e2e.test.ts` — E2E-9
- `apps/runtime/src/__tests__/e2e/sensitive-data-block-api-bypass.e2e.test.ts` — E2E-11, E2E-12
- `apps/studio/e2e/guardrails-sensitive-data-block.spec.ts` — E2E-10 (Studio Playwright)
- E2E-13 is a cross-reference to INT-4 (no separate test file).

---

### E2E-1: Compliance lead blocks SSN-only messages (User Story #1, Journey E)

**Preconditions**:

- Tenant + project bootstrapped via `bootstrapProject()`
- `us` recognizer pack enabled via `PUT /api/projects/:projectId/runtime-config` with `pii_redaction.enabled_recognizer_packs: ['us', 'core']`
- Mock LLM started via `startMockLLM()` with `PII_ECHO_AGENT_DSL` from `pii-e2e-helpers.ts`
- Agent imported via `importProjectFiles()`

**Steps**:

1. `POST /api/projects/:projectId/guardrail-policies` with body:
   ```json
   {
     "name": "ssn-block",
     "scope": { "type": "project", "projectId": "<projectId>" },
     "rules": [
       {
         "guardrailName": "ssn_block_rule",
         "presetKey": "sensitive_data_block",
         "enabled": true,
         "kind": "input",
         "category": "pii",
         "provider": "builtin-pii",
         "override": "action",
         "action": "block",
         "threshold": 0.7,
         "entities": ["ssn"],
         "actionMessage": "This message contains an SSN and cannot be processed."
       }
     ],
     "settings": { "failMode": "open" }
   }
   ```
   Expect `201 { success: true, data: { id: <policyId>, status: 'draft' } }`.
2. `POST /api/projects/:projectId/guardrail-policies/:id/activate`. Expect `200 { success: true, data: { isActive: true, status: 'active' } }`.
3. Send a user message: `POST /api/projects/:projectId/agents/:agentId/messages` with body containing `"My SSN is 123-45-6789"`.
4. Send a user message with email only: `"My email is alice@example.com"`.

**Expected Result**:

- Step 3 returns the configured `actionMessage` and an envelope indicating the request was blocked by guardrails. The runtime emits a `guardrail_input_blocked` trace event (existing event type at `apps/runtime/src/services/execution/reasoning-executor.ts` L1904) with data extended to include `{ presetKey: 'sensitive_data_block', entities: ['ssn'], confidence: >=0.7, guardrailName: 'ssn_block_rule', action: 'block' }`.
- Step 4 passes through to the LLM (no block; the rule's `entities: ['ssn']` does not match `email`).

> **HTTP status code TBD**: The exact HTTP status code for a guardrail block depends on implementation (likely `200` with a `blocked: true` response body — matching how existing Content Safety / Prompt Injection blocks surface — OR `403`/`422` with the standard error envelope). The implementation phase must decide and the test must assert the chosen code + `actionMessage` content. Tracked in §13 Open Question 6.

**Isolation Check**: Use a second user from a different project to send the same SSN message — assert no policy applies (404 on policy lookup; message is not blocked by `ssn-block`).

**Threat-model coverage**: T1 (misconfigured policy), T4 (API bypass — server-side enforcement).

---

### E2E-2: Empty policy activation rejection (User Story #4, Journey D)

**Preconditions**: Project bootstrapped. No mock LLM needed (no message flow).

**Steps**:

1. `POST /api/projects/:projectId/guardrail-policies` with `rules: []`. Expect `201`.
2. `POST /api/projects/:projectId/guardrail-policies/:id/activate`.
3. Retrieve policy: `GET /api/projects/:projectId/guardrail-policies/:id`.

**Expected Result**:

- Step 2: `400 { success: false, error: { code: 'NO_ENABLED_RULES', message: <i18n string> } }`. No stack trace in response.
- Step 3: `policy.isActive === false`, `policy.status === 'draft'` (unchanged).
- Trace event `guardrail_activation_blocked` emitted with `{ policyId, reason: 'no_enabled_rules' }`.

**Auth Context**: User with `guardrail:write` (today; covers activate per v1 bundled-permission model).

**Isolation Check**: Cross-tenant activate of same policy ID → `404`.

**Threat-model coverage**: T4 (API bypass of UI gates).

---

### E2E-3: Incomplete rule rejection (FR-8.4)

**Preconditions**: Project bootstrapped. Catalog endpoint accessible.

**Steps**:

1. `POST /api/projects/:projectId/guardrail-policies` with a rule where `enabled: true`, `kind: 'input'`, `category: 'pii'`, `provider: 'builtin-pii'`, but **missing** `actionMessage`, and `entities: []`.
2. Variant: `PUT /api/projects/:projectId/guardrail-policies/:id` with the same invalid rule body against an existing valid policy.

**Expected Result**:

- Both calls return `400 { success: false, error: { code: 'RULE_INCOMPLETE', message: <i18n>, missingFields: ['actionMessage', 'entities'] } }`.
- The policy state in MongoDB is unchanged (verified via subsequent `GET` returning the prior valid state for the PUT case).
- The same `missingFields` array is produced by the pure-function `validateRule()` unit test for the same input (validates server-client validation symmetry per FR-8.2).

**Threat-model coverage**: T4.

---

### E2E-4: Auto-deactivation on last rule disable + Undo (FR-7.4)

**Preconditions**: Project bootstrapped. Policy `abc` created with exactly one enabled rule, then activated.

**Steps**:

1. Confirm initial state via `GET`: `policy.isActive === true`, `policy.rules.length === 1`, `policy.rules[0].enabled === true`.
2. `PUT /api/projects/:projectId/guardrail-policies/:id` with `rules[0].enabled = false`.
3. `GET /api/projects/:projectId/guardrail-policies/:id`.
4. `PUT` again with `rules[0].enabled = true`.
5. `POST /api/projects/:projectId/guardrail-policies/:id/activate`.
6. `GET` final state.

**Expected Result**:

- Step 2: `200 { success: true, data: { policy: <updated>, autoDeactivated: true, originalRuleId: <ruleId> } }`.
- Step 3: `policy.isActive === false`, `policy.status === 'draft'`.
- Trace event `guardrail_auto_deactivation` emitted with `{ policyId, ruleId, undone: false }`.
- Step 5: `200 { success: true }`.
- Step 6: `policy.isActive === true`.
- Trace event `guardrail_auto_deactivation` emitted with `{ policyId, ruleId, undone: true }`.

**Isolation Check**: A user from a different project attempting to undo the deactivation → `404`.

**Threat-model coverage**: T6 (race) is covered in INT-4; this scenario covers the happy-path auto-deactivation.

---

### E2E-5: Entity catalog endpoint filters by enabled packs (FR-10.1)

**Preconditions**: Two projects in the same tenant:

- Project A: `enabled_recognizer_packs: ['us', 'core']`
- Project B: `enabled_recognizer_packs: ['eu', 'apac']`

**Steps**:

1. `GET /api/projects/<A-id>/pii-entities` with Project A token.
2. `GET /api/projects/<B-id>/pii-entities` with Project B token.

**Expected Result**:

- Step 1: `200 { success: true, data: { entities: [...] } }`. Array includes `ssn`, `credit_card`, `email`, `phone`, `ip_address` (from `core`), `us_passport`, `us_drivers_license`, `us_itin`, `us_bank_account`, `us_aba_routing` (from `us`). Excludes `eu_iban`, `sg_nric` (not in core/us packs).
- Step 2: Array includes `eu_iban`, `eu_uk_passport`, `sg_nric`. Excludes `ssn`.
- Each entity has shape: `{ id: string, label: string, pack: string, tier: 1|2|3, description?: string }`.
- Entities are sorted by `(pack, tier, label)` ascending.

---

### E2E-6: Cross-project entity catalog isolation (FR-10.3)

**Preconditions**: Two projects in the same tenant. User authenticated for Project A only.

**Steps**:

1. `GET /api/projects/<B-id>/pii-entities` with Project A's token.

**Expected Result**:

- `404 { success: false, error: { code: 'NOT_FOUND', message: 'Project not found' } }`.
- **NOT** 403 — per CLAUDE.md Core Invariant 1, cross-project access returns 404, never 403.
- No leak of Project B's existence in the error message.

**Threat-model coverage**: T5 (cross-project catalog leak).

---

### E2E-7: failMode opt-in fail-closed behavior (FR-5.4, FR-6.7)

**Preconditions**:

- Project bootstrapped. Mock LLM running. Agent imported.
- Test harness configured to inject a `BuiltinPIIProvider` failure (e.g., a rule referencing an entity ID whose recognizer-pack file has been swapped for a fixture that throws on `recognize()`). Implementation note: this requires a test-only seam in the runtime — either an env-var-gated fault injector or a registered "failing-recognizer" recognizer-pack fixture loaded only in tests.

**Steps**:

1. Create policy `closed-policy` with `settings.failMode: 'closed'`, one SDB rule, activate.
2. Send a user message that would normally trigger detection.
3. Create policy `open-policy` with `settings.failMode: 'open'`, same rule, activate (deactivating `closed-policy` first since only one policy can be active per project).
4. Repeat the same message.

**Expected Result**:

- Step 2 (closed): message blocked with the rule's `actionMessage`. Trace event with `reason: 'detector_failure'`.
- Step 4 (open): message passes through to the LLM (no block).

**Threat-model coverage**: §C.2 Fail-Closed Contract row 1 (detector throws / times out).

---

### E2E-8: Schema-additive backward compatibility (FR-5.3, §C.4 Rollout)

**Preconditions**: Project bootstrapped.

**Steps**:

1. `POST /api/projects/:projectId/guardrail-policies` with a rule that has **none** of the new fields: no `entities`, no `presetKey`, no `enabled`, no `actionMessage`. Use only legacy fields: `guardrailName`, `override`, `kind: 'input'`, `category: 'hate'`, `action: 'block'`, `threshold: 0.5`, `message: 'legacy message'`.
2. `GET` the policy.
3. Send a message that would trigger the rule (using the existing content-safety pipeline).

**Expected Result**:

- Step 1: `201`. Policy saves successfully.
- Step 2: Returns the rule. New fields are `undefined` (NOT `null`, NOT empty array): `policy.rules[0].entities === undefined`, `policy.rules[0].enabled === undefined`, `policy.rules[0].presetKey === undefined`, `policy.rules[0].actionMessage === undefined`.
- The rule behaves as today: no entity filter applied; activation gate treats `enabled: undefined` as `false` (so this policy is not eligible for activation — verifying backward-compat for old test fixtures that don't set `enabled`).

**Note**: A separate variant test should verify that legacy rules created BEFORE this feature can still be loaded and evaluated. Since this is pre-launch (no real legacy data), this is a synthetic test of the optional-field contract.

---

### E2E-9: Tenant-scoped policy inheritance with SDB (User Story #5)

**Preconditions**: Tenant `T1` with two projects `P1` and `P2`. Tenant admin user `admin@T1`.

> **Route-path verification needed** (Open Q-7): The exact HTTP route for tenant-scoped policy creation must be verified during implementation. The runtime mounts the same router at both `/api/projects/:projectId/guardrail-policies` and `/api/guardrail-policies` (per `apps/runtime/src/server.ts` L1248-1249). Tenant-scoped policy creation uses the `/api/guardrail-policies` mount with `scope: { type: 'tenant' }` in the body. If the runtime requires a different path for tenant scope, adjust this test.

**Steps**:

1. `POST /api/guardrail-policies` (tenant-scoped mount; not project-mounted) with `scope: { type: 'tenant' }` and an SDB rule blocking SSN. Activate.
2. With a regular project user from `P1`, send a message containing an SSN to an agent in `P1`.
3. Same with a user from `P2`.

**Expected Result**:

- Both step 2 and step 3 messages are blocked by the tenant-scoped policy.
- Trace events tagged with `{ scope: 'tenant', policyId: <id> }`.
- The tenant-scoped policy applies to projects without their own active SDB policy.

**Auth Context**: Tenant admin for step 1; project users for steps 2-3.

---

### E2E-10: Studio Create Policy via UI (Playwright EP-1)

**File**: `apps/studio/e2e/guardrails-sensitive-data-block.spec.ts`

**Preconditions**:

- Runtime running on `localhost:3002` (or `3112`)
- Studio running on `localhost:5173`
- Test user logged in (use existing Playwright auth fixture from `apps/studio/e2e/`)

**Steps**:

1. Navigate to `/projects/:projectId/guardrails-config`.
2. Click "Add Policy".
3. In the dialog, enter `name: "Test SDB Policy"`.
4. Toggle the "Sensitive Data Block" preset row (FR-1.1 — verify the row label is "Sensitive Data Block", not "PII Protection").
5. Verify the action dropdown shows only `block`, `warn`, `escalate` (FR-1.2 — `redact` MUST NOT appear).
6. Click "High-risk only" preset radio (FR-6.2 — verify SSN is the only pre-selected entity).
7. Set `actionMessage: "Test block message."` (FR-6.6, FR-6.9 — character counter visible).
8. Click "Save". Verify the policy appears in the list with `status: 'draft'`.
9. Verify the policy row shows a chip `● Sensitive Data Block · SSN` (FR-9.3).
10. Click the activation toggle. Verify status changes to `active` (green dot).
11. Verify a MongoDB record exists (via runtime API call: `GET /api/projects/:projectId/guardrail-policies/:id`).

**Expected Result**: All assertions pass. Inline helper text under the SDB row is visible (FR-1.4). Cross-link to Settings is present.

**Auth Context**: Project owner.

---

### E2E-11: Direct API bypass — invalid rule enable (T4 threat)

**Preconditions**: Project bootstrapped. Token with `guardrail:write`.

**Steps**:

1. Direct `PUT /api/projects/:projectId/guardrail-policies/:id` (bypassing Studio) with a rule body where `enabled: true` but `actionMessage` is missing.

**Expected Result**: `400 RULE_INCOMPLETE` with `missingFields: ['actionMessage']` (and possibly more). Same response as if submitted through Studio (validation symmetry).

**Threat-model coverage**: T4 (API bypass — same `validateRule()` runs server-side).

---

### E2E-12: Direct API bypass — XSS in actionMessage (T3 threat)

**Preconditions**: Project bootstrapped.

**Steps**:

1. `POST /api/projects/:projectId/guardrail-policies` with `actionMessage: "<script>alert('xss')</script>Hello"`.
2. `GET` the policy.

**Expected Result**:

- Step 1: `201` or `400` depending on the chosen strategy:
  - If the strategy is **strip-on-save**: `201` and `policy.rules[0].actionMessage === 'Hello'` (or `'alert(\\'xss\\')Hello'` depending on the stripper used). The HTML tags are removed server-side.
  - If the strategy is **reject-on-save**: `400 { error: { code: 'INVALID_ACTION_MESSAGE', message: '...' } }`.
- Author's note: feature spec FR-6.9 says "server-side HTML strip" (option a). The chosen implementation must match.

**Variant**: Same test with null bytes (`\x00`) — must reject with `400`.

**Variant**: Same test with a 501-char message — must reject with `400`.

**Threat-model coverage**: T3 (XSS in `actionMessage`).

---

### E2E-13: Auto-deactivation race condition (T6 threat) — **CROSS-REFERENCE, NOT A STANDALONE TEST**

**Status**: Coverage is at the integration level (INT-4). Listed here only so the threat-model mapping table at §8.3 has a contiguous numbering. No separate test file. No HTTP-level steps.

**Why integration not E2E**: The property under test (no observable state where `isActive: true && enabledRules.count === 0`) is server-side transactional correctness, not observable through a single API call. Race conditions need direct boundary-level orchestration via `Promise.all`, which is INT-4's pattern.

---

### E2E-14: Telemetry tag rename (FR-4.1)

**Preconditions**: Mock LLM, agent, project with SDB policy active.

**Steps**:

1. Send a message that triggers an SDB rule.
2. Query the trace store (via runtime trace API or test-only seam) for the most recent `guardrail_input_blocked` or `guardrail_output_blocked` event tagged with `presetKey: 'sensitive_data_block'`.

**Expected Result**:

- The event has `ruleCategory: 'sensitive_data_block'` (NOT `'pii'`).
- No `ruleCategory: 'pii'` event was emitted by this evaluation (clean cutover per FR-4.1).

---

### E2E-15: Catalog rate-limit middleware integration (T8 threat — LOW priority)

**Preconditions**: Default rate-limit middleware enabled on the project routes (per CLAUDE.md "Tier 1 latency budget" + existing route guards).

**Steps**:

1. Burst `N+1` requests to `GET /api/projects/:projectId/pii-entities` where `N` is the configured rate-limit window count (or use a low test-only limit via env var override).

**Expected Result**: The `N+1`-th request returns `429 Too Many Requests`. Existing rate-limit middleware (`tenantRateLimit('request')`) applies to the new route.

**Threat-model coverage**: T8.

---

## 3. Integration Test Scenarios

**File mapping** (canonical — §12 is the authoritative duplicate):

- `apps/runtime/src/__tests__/integration/guardrails/validate-rule-integration.test.ts` — INT-1 (route-level use of `validateRule`)
- `apps/runtime/src/__tests__/integration/guardrails/entity-filter.test.ts` — INT-2
- `apps/runtime/src/__tests__/integration/guardrails/auto-deactivation-race.test.ts` — INT-4
- `apps/runtime/src/__tests__/integration/guardrails/pii-entities-catalog.test.ts` — INT-3, INT-5
- `apps/runtime/src/__tests__/integration/guardrails/telemetry-rename.test.ts` — INT-6
- `apps/runtime/src/__tests__/integration/guardrails/trace-events-activation.test.ts` — INT-7
- `apps/runtime/src/__tests__/integration/guardrails/cross-tenant-isolation.test.ts` — INT-8
- `apps/runtime/src/__tests__/integration/guardrails/action-message-sanitization.test.ts` — INT-9
- `apps/runtime/src/__tests__/integration/guardrails/failmode-default.test.ts` — INT-10
- `apps/runtime/src/__tests__/execution/guardrails/policy-rbac.integration.test.ts` (EXTENDED) — INT-11

---

### INT-1: Route handler uses shared `validateRule()` (FR-8.2 symmetry)

**Boundary**: Runtime route handler ↔ `@abl/shared` validation function.

**Setup**: `RuntimeApiHarness` + MongoMemoryServer.

**Steps**:

1. Pure-function call: `validateRule({ enabled: true, checkType: 'provider', category: 'pii', /* missing actionMessage and entities */ })`.
2. HTTP call: `PUT /api/projects/:projectId/guardrail-policies/:id` with the same rule body.

**Expected Result**:

- The function returns `{ valid: false, missingFields: ['actionMessage', 'entities'] }`.
- The HTTP response is `400` with `error.missingFields` matching the function output exactly (same array, same order, same strings).
- This proves the route handler uses the same shared function as the client (validation symmetry).

**Failure Mode**: If the route handler has its own validation logic (drift from `validateRule`), this test fails because the `missingFields` arrays differ.

---

### INT-2: Post-detection entity filter (FR-6.4)

**Boundary**: Guardrail pipeline ↔ `BuiltinPIIProvider` ↔ post-detection filter.

**Setup**: Real `BuiltinPIIProvider` (no mock). Recognizer packs `us` and `core` enabled. Test fixture message containing SSN, email, and credit card.

**Steps** (for each configuration):

| Test Case | rule.entities                                 | Message contains                                           | Expected match?                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --------- | --------------------------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1         | `['ssn']`                                     | SSN                                                        | YES                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 2         | `['ssn']`                                     | email only                                                 | NO                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 3         | `['email']`                                   | email only                                                 | YES                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 4         | `['ssn', 'credit_card']`                      | both SSN and CC                                            | YES (one or both)                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 5         | `['ssn', 'email']`                            | SSN + email (irrelevant to rule but detected)              | YES (SSN match)                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 6         | `[]` (empty)                                  | SSN                                                        | NO (defensive default)                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 7         | `undefined`                                   | SSN                                                        | YES (backward-compat: no filter = match all)                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 8         | `['eu_passport']` (pack disabled)             | EU passport in message                                     | NO (silently skip; other entities in rule would still match)                                                                                                                                                                                                                                                                                                                                                                                                      |
| 9         | `['us_bank_account']` (no matching detection) | SSN + email in message (neither matches `us_bank_account`) | NO — rule allowlist contains an entity ID that has zero matching detections. Proves the filter is **exercised** rather than bypassed (LLD R3-F1 mitigation: `result.detections.filter(d => allowSet.has(d.type))` returns `[]`, so `filteredDetections.length === 0`, so the rule does NOT fire). Without this case, a typo like `f.entityType` (undefined) instead of `d.type` would silently pass every detection through and INT-2 cases 1-8 would still pass. |

**Failure Mode**: If the filter is implemented before detection instead of after, the test for case 8 would also block the runtime cost (detection still runs); the test asserts the rule does NOT trigger.

---

### INT-3: Entity catalog pack-enable state cache invalidation

**Boundary**: Studio API proxy ↔ Runtime catalog endpoint ↔ Runtime config.

**Setup**: `RuntimeApiHarness` + MongoMemoryServer. Studio API proxy mocked via MSW for the Studio side; runtime catalog endpoint is real.

**Steps**:

1. `PUT /api/projects/:projectId/runtime-config` to set `pii_redaction.enabled_recognizer_packs: ['us', 'core']`.
2. `GET /api/projects/:projectId/pii-entities` — capture entity list (should include `ssn` from `core` and `us_passport` from `us`).
3. `PUT /api/projects/:projectId/runtime-config` to remove `'us'` from packs.
4. `GET /api/projects/:projectId/pii-entities` — should exclude `us_passport` (us-pack entities removed; `ssn` remains since it is in `core`).

**Expected Result**: The catalog reflects the latest pack-enable state on every request. There is no server-side cache (the runtime-config read is fresh per request, or stale ≤ 60s per the spec's optional memoization).

**Failure Mode**: If a memoization layer is added without invalidation, step 4 may still return the stale list — this is the regression to catch.

---

### INT-4: Auto-deactivation race condition (T6 threat, FR-7.4)

**Boundary**: Runtime route handler ↔ MongoDB findOneAndUpdate atomicity.

**Setup**: `RuntimeApiHarness`. Policy created with exactly 2 enabled rules, then activated.

**Steps**:

1. Issue two concurrent `PUT` requests using `Promise.all`:
   - Request A: `rules: [{ ...rule1, enabled: false }, rule2]`
   - Request B: `rules: [rule1, { ...rule2, enabled: false }]`
2. After both complete, `GET /api/projects/:projectId/guardrail-policies/:id`.

**Expected Result**:

- Both requests return `200`.
- Final state: at most one rule is enabled (the one not disabled by the "winning" request) OR both are disabled.
- **Invariant**: If both rules are disabled in the final state, `policy.isActive === false` (auto-deactivated). There must be **no observable state where `isActive === true && enabledRules.count === 0`**.
- The `autoDeactivated: true` flag MUST appear in at least one response if the final state has both rules disabled.

**Failure Mode**: A non-atomic update sequence could leave the policy `isActive: true` with zero enabled rules — the failure mode this test is designed to catch.

**Pattern reference**: `import-idempotent.e2e.test.ts` L564 (`Promise.all` pattern).

---

### INT-5: Entity catalog reads from recognizer registry (FR-10.1)

**Boundary**: Catalog route handler ↔ `packages/compiler/src/platform/security/recognizer-packs/index.ts`.

**Setup**: Real recognizer-packs (no fixture). Real runtime config.

**Steps**:

1. `GET /api/projects/:projectId/pii-entities` for a project with all 8 packs enabled.
2. Assert: response includes exactly the entities exported by the recognizer registry, with each entity's `tier`, `label`, `pack`, and (optional) `description` matching the registry's metadata.

**Expected Result**: The catalog endpoint returns the canonical 37 entities (8 packs total). Each entity object matches the registry's source-of-truth.

**Failure Mode**: If the catalog endpoint maintains its own static list of entities (instead of reading from the registry), it can drift from the registry. This test catches that drift.

---

### INT-6: Telemetry tag clean cutover (FR-4.1)

**Boundary**: Runtime evaluator ↔ trace store.

**Setup**: Real evaluator. Real trace store.

**Steps**:

1. Trigger a Sensitive Data Block rule evaluation (any message that matches).
2. Inspect the most recent trace events.

**Expected Result**:

- Exactly one `guardrail_input_blocked` (or `guardrail_output_blocked`, depending on whether the rule was input- or output-kind) event with `presetKey: 'sensitive_data_block'`.
- Zero events with `ruleCategory: 'pii'`.

**Failure Mode**: If dual-emit logic was accidentally left in for one release cycle, both events would appear — the test would catch that.

---

### INT-7: Activation gate trace events (FR-7.5)

**Boundary**: Activation route ↔ trace store.

**Steps**:

1. Attempt to activate an empty policy. Assert `400 NO_ENABLED_RULES`. Inspect trace store for `guardrail_activation_blocked` event with `reason: 'no_enabled_rules'`.
2. Disable the last rule on an active policy. Assert `200` with `autoDeactivated: true`. Inspect trace store for `guardrail_auto_deactivation` event with `undone: false`.
3. Re-enable + activate. Inspect trace store for `guardrail_auto_deactivation` event with `undone: true`.
4. **`presetKey` full-chain assertion (LLD R3-F2)**: Create an SDB policy with `presetKey: 'sensitive_data_block'`, activate it, send a message that triggers a block. Inspect the trace store for the `guardrail_input_blocked` event. Assert `event.data.presetKey === 'sensitive_data_block'`. Repeat with an output-side rule (triggers `guardrail_output_blocked`) and assert the same field on that event. This verifies the 4-site propagation chain: IR `Guardrail.presetKey` → `GuardrailViolation.presetKey` → `OutputGuardrailResult.violation.presetKey` → trace event `data.presetKey`. If any site drops the field, the assertion fails — proving the field actually traverses the full chain rather than being set at one site and lost at another.

**Expected Result**: All four trace event assertions pass with correct payloads.

---

### INT-8: Cross-tenant policy isolation (Core Invariant 1)

**Boundary**: Runtime route ↔ MongoDB tenant-isolation plugin.

**Setup**: Two tenants `T1` and `T2`, each with a project and a policy.

**Steps**:

1. Tenant `T1` user calls `GET /api/projects/<T2-project-id>/guardrail-policies/<T2-policy-id>`.
2. Tenant `T1` user calls `PUT` on the same path.
3. Tenant `T1` user calls `POST .../activate`.
4. Tenant `T1` user calls `GET /api/projects/<T2-project-id>/pii-entities`.

**Expected Result**: All four return `404`, never `403`. No leak of `T2`'s data in error messages.

**Pattern reference**: `pii-cross-project-isolation.e2e.test.ts` (3 projects × 2 tenants).

---

### INT-9: Action message HTML strip + length + null-byte rejection (FR-6.9)

**Boundary**: Runtime PUT route ↔ message sanitizer.

**Steps** (each case is a separate request):

1. `actionMessage: '<script>alert(1)</script>Hello'` → strip → persisted as `Hello`. `200`.
2. `actionMessage: 'Hi <b>there</b>!'` → strip → `Hi there!`. `200`.
3. `actionMessage: ` (empty string) → `400 INVALID_ACTION_MESSAGE` (when rule is `enabled: true` for an SDB preset).
4. `actionMessage: <501-char string>` → `400 ACTION_MESSAGE_TOO_LONG`.
5. `actionMessage: 'Hello\x00World'` → `400 INVALID_ACTION_MESSAGE`.
6. `actionMessage: 'Hello\nMultiline\nMessage'` → `200` (newlines allowed; FR-6.9 does NOT prohibit them).
7. `actionMessage: 'Hello 你好 مرحبا'` → `200` (UTF-8 multi-byte allowed).

**Failure Mode**: Inconsistent rejection between server and client UI would surface drift.

---

### INT-12: PUT lifecycle precedence — body `status: 'active'` + all rules disabled → auto-deactivation wins (LLD R1-F9)

**Boundary**: Runtime PUT route ↔ lifecycle update logic (`apps/runtime/src/routes/guardrail-policies.ts:1132`).

**Setup**: `RuntimeApiHarness`. Create a policy with 1 enabled rule; activate it.

**Steps**:

1. `PUT /api/projects/:projectId/guardrail-policies/:id` with body `{ status: 'active', rules: [{ ...rule, enabled: false }] }`.
2. `GET /api/projects/:projectId/guardrail-policies/:id`.

**Expected Result**:

- Step 1: `200` with `autoDeactivated: true` in response.
- Step 2: `policy.isActive === false`, `policy.status === 'draft'`. Auto-deactivation takes precedence over the client-supplied `status: 'active'` via the lifecycleUpdate spread.

**Why it's an INT not E2E**: This tests the `$set` spread ordering in the PUT handler — auto-deactivation update MUST be the LAST spread to override `lifecycleUpdate`. The contract is internal to the route handler's atomic `findOneAndUpdate` shape.

**File**: `apps/runtime/src/__tests__/integration/guardrails/auto-deactivation-race.test.ts` (extended).

---

### INT-13: Reactivate sibling-deactivation — deactivate A when B activates, then reactivate A (LLD R2-F1)

**Boundary**: Runtime reactivate route ↔ `deactivateSiblingPolicies()` + cache invalidation.

**Setup**: `RuntimeApiHarness`. Create policies A and B in the same project, each with 1 enabled rule.

**Steps**:

1. Activate policy A. Assert `200`; A is active.
2. Activate policy B. Assert `200`; B is active; A is now inactive (sibling deactivation by `/:id/activate`).
3. `POST /api/projects/:projectId/guardrail-policies/:idA/reactivate` with `{ guardrailName: '<A's rule>' }`. Assert `200`.
4. `GET` both policies. Assert A is active, B is now inactive.
5. Send a chat message that triggers A's rule but not B's. Assert the blocked response uses A's `actionMessage` (proves runtime cache invalidated and re-loaded the active policy).

**Expected Result**: Reactivate is symmetric to activate — preserves single-active-policy invariant, calls `bumpAffectedPolicyEpochs` + `invalidateGuardrailEvalCache` + `invalidateTenantProviderCache`.

**Failure Mode**: Without the cache invalidations (R2-F1), the runtime would continue evaluating against the stale policy B until an unrelated cache flush.

**File**: `apps/runtime/src/__tests__/integration/guardrails/auto-deactivation-race.test.ts` (extended).

---

### INT-11: SDB-specific RBAC — `guardrail:read` vs `guardrail:write`, `pii-pattern:read` (FR-10.3, Section 7)

> **Permission-strings reality check**: The actual codebase permissions are `guardrail:read`, `guardrail:write`, `pii-pattern:read`, `pii-pattern:write` (defined at `packages/shared-auth/src/rbac/role-permissions.ts` and seeded by migration `20260509_029`). The earlier draft of this scenario referenced `guardrail-policy:read/update/activate` — those strings exist only as **audit-log action names** in the route handlers, NOT as RBAC permissions. They have been corrected here.
>
> **Activate-vs-write split is deferred** (HLD §4 concern #4). Today, `POST /:id/activate` and `PUT /:id` both check `guardrail:write`. A future `guardrail:activate` permission split would enable maker-checker workflows; the test cases below mark which assertions are TODAY vs. FUTURE.

**Boundary**: Runtime route ↔ `requireRouteScopePermission` middleware.

**Setup**: `RuntimeApiHarness`. Bootstrap project. Create test users in the same project with these permission sets:

- User R: `guardrail:read` only
- User W: `guardrail:read` + `guardrail:write`
- User PII: `pii-pattern:read` only (no guardrail permissions)
- User None: no guardrail or PII permissions

**Steps** (each case is a separate HTTP request):

| #   | User | Route                                                 | Expected (today)                                      | Notes                                                                                       |
| --- | ---- | ----------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| 1   | R    | `PUT /api/projects/:projectId/guardrail-policies/:id` | `403 { error: { code: 'INSUFFICIENT_PERMISSIONS' } }` | read only — write denied                                                                    |
| 2   | W    | `PUT .../guardrail-policies/:id`                      | `200`                                                 | succeeds                                                                                    |
| 3   | W    | `POST .../guardrail-policies/:id/activate`            | `200` (today)                                         | **FUTURE**: when `guardrail:activate` lands, this returns `403` if user W lacks `:activate` |
| 4   | None | `GET /api/projects/:projectId/pii-entities`           | `403`                                                 | lacks `pii-pattern:read`                                                                    |
| 5   | PII  | `GET /api/projects/:projectId/pii-entities`           | `200`                                                 | distinct permission boundary verified                                                       |
| 6   | PII  | `PUT .../guardrail-policies/:id`                      | `403`                                                 | `pii-pattern:read` is not `guardrail:write`                                                 |
| 7   | R    | `POST .../guardrail-policies/:id/activate`            | `403`                                                 | read-only cannot activate (covered by `guardrail:write` requirement)                        |

**Future test case (not implementable today)** — preserved here for the maker-checker rollout:

| #   | User                        | Route                                      | Expected (after `guardrail:activate` split) | Status                                               |
| --- | --------------------------- | ------------------------------------------ | ------------------------------------------- | ---------------------------------------------------- |
| F-1 | W (has write, NOT activate) | `POST .../guardrail-policies/:id/activate` | `403`                                       | **DEFERRED** — implement when HLD §4 extension lands |

**Failure Mode**: If `pii-entities` route is incorrectly gated on `guardrail:read` (instead of `pii-pattern:read`), case 5 fails. If `PUT` route does not require `guardrail:write`, case 1 fails.

**File**: `apps/runtime/src/__tests__/execution/guardrails/policy-rbac.integration.test.ts` (EXTENDED — adds these cases to the existing file).

### INT-10: `failMode` schema default flip (FR-5.4)

**Boundary**: Runtime POST route ↔ Mongoose schema default.

**Steps**:

1. `POST /api/projects/:projectId/guardrail-policies` with body **omitting** `settings.failMode`.
2. `GET` the policy.

**Expected Result**: `policy.settings.failMode === 'open'` (post-feature default).

**Variant**:

- `POST` with explicit `settings.failMode: 'closed'`. `GET`. Assert persisted as `'closed'`.
- `POST` with explicit `settings.failMode: 'open'`. `GET`. Assert persisted as `'open'`.

**Failure Mode**: If the schema default flip was not applied, the test catches it (default would still be `'closed'`).

---

## 4. Unit Test Scenarios

**File**: `packages/shared/src/__tests__/validation/guardrail-rule-validation.test.ts`

### UT-1: `validateRule()` per-checkType matrix (FR-8.1, ~35 cases)

Implemented as `test.each` table-driven cases organized by `checkType`. The matrix structure:

#### Group A — `checkType: 'provider'` with `category: 'pii'` (SDB-specific) — 11 cases

| #   | Input variation                                           | `enabled` | Expected `valid` | Expected `missingFields`            |
| --- | --------------------------------------------------------- | --------- | ---------------- | ----------------------------------- |
| A1  | All fields populated, `entities: ['ssn']`                 | `true`    | `true`           | `[]`                                |
| A2  | Missing `name`                                            | `true`    | `false`          | `['name']`                          |
| A3  | Missing `kind`                                            | `true`    | `false`          | `['kind']`                          |
| A4  | Missing `provider`                                        | `true`    | `false`          | `['provider']`                      |
| A5  | Missing `category`                                        | `true`    | `false`          | `['category']`                      |
| A6  | Missing `action`                                          | `true`    | `false`          | `['action']`                        |
| A7  | Missing `severityThreshold` (Studio name for `threshold`) | `true`    | `false`          | `['severityThreshold']`             |
| A8  | Missing `actionMessage`                                   | `true`    | `false`          | `['actionMessage']`                 |
| A9  | `entities: []` (empty)                                    | `true`    | `false`          | `['entities']`                      |
| A10 | `entities: undefined`                                     | `true`    | `false`          | `['entities']`                      |
| A11 | `enabled: false` with multiple missing fields             | `false`   | `true`           | `[]` (gate only fires when enabled) |

#### Group B — `checkType: 'provider'` with non-PII category — 3 cases

| #   | Input variation                                   | `enabled` | Expected                                    | Notes                 |
| --- | ------------------------------------------------- | --------- | ------------------------------------------- | --------------------- |
| B1  | Valid (entities not required for non-PII)         | `true`    | `valid: true`                               |                       |
| B2  | Missing `action`                                  | `true`    | `valid: false`, `missingFields: ['action']` |                       |
| B3  | `entities` present (silently ignored for non-PII) | `true`    | `valid: true`                               | No spurious rejection |

#### Group C — `checkType: 'cel'` — 5 cases

| #   | Input variation                  | Expected                                           |
| --- | -------------------------------- | -------------------------------------------------- |
| C1  | All fields populated             | `valid: true`                                      |
| C2  | Missing `name`                   | `valid: false`, `missingFields: ['name']`          |
| C3  | Missing `check` (CEL expression) | `valid: false`, `missingFields: ['check']`         |
| C4  | Missing `action`                 | `valid: false`, `missingFields: ['action']`        |
| C5  | Missing `actionMessage`          | `valid: false`, `missingFields: ['actionMessage']` |

#### Group D — `checkType: 'llm'` — 5 cases

| #   | Input variation             | Expected                                           |
| --- | --------------------------- | -------------------------------------------------- |
| D1  | All fields populated        | `valid: true`                                      |
| D2  | Missing `llmCheck` (prompt) | `valid: false`, `missingFields: ['llmCheck']`      |
| D3  | Missing `name`              | `valid: false`, `missingFields: ['name']`          |
| D4  | Missing `action`            | `valid: false`, `missingFields: ['action']`        |
| D5  | Missing `actionMessage`     | `valid: false`, `missingFields: ['actionMessage']` |

#### Group E — Cross-cutting edge cases — ~10 cases

| #   | Input                             | Expected                                                                                              |
| --- | --------------------------------- | ----------------------------------------------------------------------------------------------------- |
| E1  | Multiple missing fields           | All listed in `missingFields` (order: stable schema order)                                            |
| E2  | Whitespace-only `name` (`'   '`)  | `valid: false`, `missingFields: ['name']`                                                             |
| E3  | `action: 'redact'` for SDB preset | `valid: true` at validation level (UI restricts; `validateRule` does not)                             |
| E4  | `entities: ['unknown_entity_id']` | `valid: true` at validation level (catalog check is separate concern)                                 |
| E5  | `threshold: 0.0`                  | `valid: true` (boundary)                                                                              |
| E6  | `threshold: 1.0`                  | `valid: true` (boundary)                                                                              |
| E7  | `threshold: undefined`            | `valid: false`, `missingFields: ['severityThreshold']`                                                |
| E8  | `actionMessage: 'x'.repeat(500)`  | `valid: true` (boundary)                                                                              |
| E9  | `actionMessage: 'x'.repeat(501)`  | `valid: false`, `missingFields: ['actionMessage']` (over-length treated as invalid by `validateRule`) |
| E10 | `actionMessage: ''` (empty)       | `valid: false`, `missingFields: ['actionMessage']`                                                    |

#### Group F — `actionMessage` sanitization edge cases (LLD R2-F3) — 6 cases

| #   | Input `actionMessage`          | `enabled` | Expected `valid`   | Notes                                                                                                   |
| --- | ------------------------------ | --------- | ------------------ | ------------------------------------------------------------------------------------------------------- |
| F1  | `'Hello\x00World'` (null byte) | `true`    | `false`            | `missingFields: ['actionMessage']` — null bytes rejected                                                |
| F2  | `'x'.repeat(501)` (>500 chars) | `true`    | `false`            | `missingFields: ['actionMessage']` — over-length                                                        |
| F3  | `'<script>alert(1)</script>'`  | `true`    | `true` (sanitized) | `validateRule()` strips HTML via `sanitize-html` with `allowedTags: []`; returns sanitized `'alert(1)'` |
| F4  | `'Valid plain text message.'`  | `true`    | `true`             | Happy path; returned unchanged                                                                          |
| F5  | `''` (empty string)            | `true`    | `false`            | `missingFields: ['actionMessage']`                                                                      |
| F6  | `undefined`                    | `true`    | `false`            | `missingFields: ['actionMessage']`                                                                      |

**Total: ~40 test cases.** Implemented as 6 `test.each` blocks (one per group) with shared assertion helper.

---

### UT-2: `validateRule()` is exported from `packages/shared`

**Module**: `packages/shared/src/validation/guardrail-rule-validation.ts`.

**Input**: Type-only import test: `import { validateRule } from '@abl/shared/validation/guardrail-rule-validation';`.

**Expected Output**: The import resolves; the function signature is `(rule: GuardrailRuleInput) => { valid: boolean; missingFields: string[] }`. Verified at compile time via `tsc --noEmit`.

---

### UT-3: 90-day TTL banner logic (FR-2.3)

**Module**: `apps/studio/src/lib/banner-ttl.ts` (or wherever the TTL helper lives).

**Cases**:
| # | Input (`now - dismissedAt`) | Expected `shouldShow` |
|---|---|---|
| 1 | `0` (just dismissed) | `false` |
| 2 | `89 days in ms` | `false` |
| 3 | `90 days exactly` | `false` (strictly greater than, per FR-2.3) |
| 4 | `90 days + 1 ms` | `true` |
| 5 | `dismissedAt` is malformed (`'invalid'`) | `true` (fall-open: show banner on bad data) |
| 6 | `dismissedAt` is missing | `true` |

---

### UT-4: SSN-only default entity preset (FR-6.2, Q-PRD-1)

**Module**: `apps/studio/src/components/guardrails/EntityMultiselect.tsx` (preset → entities helper).

**Input**: `getDefaultEntitiesForPreset('high-risk-only', catalog)` where `catalog` includes `ssn`, `credit_card`, `us_bank_account`, `us_passport`, `us_drivers_license`, `eu_iban`.

**Expected Output**: `['ssn']` exactly (NOT all 6 high-risk entities, per Q-PRD-1 user decision).

**Variant**: `getDefaultEntitiesForPreset('all-pii', catalog)` → returns ALL entities in `catalog` (project-scoped).

**Variant**: `getDefaultEntitiesForPreset('custom', catalog)` → returns `[]`.

---

### UT-5: Default action message copy (FR-6.6)

**Module**: i18n string lookup.

**Input**: `t('guardrails.sensitiveDataBlock.defaultActionMessage')`.

**Expected Output**: `"This message contains information that cannot be processed in this channel. Please contact us through an alternative channel for further assistance."`. Channel-neutral (per Q-FS-4 user decision); does NOT imply user error; works in chat AND voice.

---

## 5. Component Test Scenarios

**File mapping**:

- `apps/studio/src/__tests__/components/guardrails/EntityMultiselect.test.tsx`
- `apps/studio/src/__tests__/components/guardrails/DecisionMatrixModal.test.tsx`
- `apps/studio/src/__tests__/components/guardrails/FailModeSelector.test.tsx`
- `apps/studio/src/__tests__/components/guardrails/RuleCard.test.tsx` (extended)
- `apps/studio/src/__tests__/components/guardrails/GuardrailsConfigPage.test.tsx` (extended)
- `apps/studio/src/__tests__/components/settings/PIIProtectionTab.test.tsx` (extended)

### CT-1: `EntityMultiselect` — quick-preset radio behavior (FR-6.1, FR-6.2, FR-6.3)

**Setup**: Render `<EntityMultiselect catalog={[ssn, credit_card, email, ...]} onChange={spy} />`.

**Cases**:

1. Initial render: "High-risk only" radio selected; only SSN is checked in the entity list.
2. Click "All PII": all entities from the (filtered-by-enabled-pack) catalog are checked. `onChange` called with all entity IDs.
3. Click "Custom": no entities checked; user can pick.
4. Click "Custom", check `ssn` and `credit_card`: `onChange` called with `['ssn', 'credit_card']`.
5. Each entity has a tier badge (1/2/3) and is grouped by pack.

### CT-1b: `GuardrailPolicyForm` — `kind: 'both'` expands to two rules on save (FR-5.3 surface-semantics contract)

**Setup**: Render `<GuardrailPolicyForm />`. Open the SDB preset row. In "Applies To", check **both** Input and Output checkboxes. Configure the rest of the rule with valid values, click Save.

**Cases**:

1. Spy on the `onSubmit` callback (or the API request via MSW). Verify the payload's `rules` array contains **two** rule objects derived from the single UI row:
   - One with `kind: 'input'`
   - One with `kind: 'output'`
2. Both rules share the same other fields (entities, action, actionMessage, threshold, presetKey).
3. Re-open the policy in the form (round-trip): the two persisted rules should be **collapsed back** to a single UI row with both Input and Output checkboxes checked. (Verifies the deserialization inverse of `serializeRule()` for the form.)

**File mapping**: `apps/studio/src/__tests__/components/guardrails/GuardrailPolicyForm.test.tsx` (extended).

**Why this matters**: The Round 4 audit on the feature spec caught that `kind: 'both'` is form-level only — `serializeRule()` (Studio L504-508) and `normalizeRules()` (runtime L538-543) expand it before persistence. This test pins that contract.

### CT-1c: `GuardrailPolicyForm` — serializer round-trip with `enabled: false` for SDB-preset rules (LLD R1-F7)

**Setup**: Render `<GuardrailPolicyForm />`. Open the SDB preset row. Configure a valid SDB rule (entities, actionMessage, threshold) but leave the rule's enable toggle **off** so `rule.enabled === false`. Click Save.

**Cases**:

1. Spy on the `onSubmit` callback. Verify the payload's `rules` array contains the disabled rule with `{ enabled: false, presetKey: 'sensitive_data_block', entities: [...], actionMessage: '...' }` (NOT filtered to `[]`). This proves `serializeRule()` serializes disabled SDB-preset rules rather than stripping them — the existing serializer behavior at `GuardrailPolicyForm.tsx:459-462` (which returns `[]` for `!rule.enabled`) is amended for the SDB preset branch.
2. Re-open the policy in the form (round-trip): the disabled rule should appear with the enable toggle off, all previously configured fields intact.

**File mapping**: `apps/studio/src/__tests__/components/guardrails/GuardrailPolicyForm.test.tsx` (extended — same file as CT-1b).

**Why this matters**: The activation gate (FR-7.1) and auto-deactivation (FR-7.4) require the server to see disabled rules with `enabled: false` to count them. If `serializeRule()` strips disabled rules, the server cannot distinguish "zero rules configured" from "all rules explicitly disabled."

### CT-2: `EntityMultiselect` — pack-disabled entity warning (FR-10.4)

**Setup**: Pass `catalog` excluding `eu_passport`, but `value: ['eu_passport', 'ssn']` (a rule that referenced an entity from a now-disabled pack).

**Expected**: Yellow warning text rendered: _"This rule references entities from a disabled pack: eu_passport. Re-enable the pack in Settings → PII Protection or remove them from this rule."_ `ssn` checkbox is still rendered and checked.

### CT-3: `DecisionMatrixModal` — WCAG APG dialog pattern (FR-3.3)

**Setup**: `<DecisionMatrixModal open onClose={onClose} />`.

**Cases**:

1. `screen.getByRole('dialog')` returns the modal. `aria-modal="true"` and `aria-labelledby` are set.
2. Focus is trapped inside the dialog (Tab cycles through focusable elements inside; Shift+Tab cycles back).
3. `userEvent.keyboard('{Escape}')` calls `onClose`.
4. Click outside the dialog (on the backdrop) calls `onClose`.
5. The modal title is rendered and `aria-labelledby` points to its id.
6. Body scroll is locked while the modal is open (CSS class on `<body>`).

### CT-4: `DecisionMatrixModal` — first-run auto-open via localStorage (FR-3.1)

**Setup**: Mock `localStorage`. Render the parent component that hosts the modal.

**Cases**:

1. `localStorage.getItem('decision-matrix-dismissed')` returns `null` → modal opens automatically.
2. `localStorage.getItem(...)` returns a recent epoch_ms → modal does NOT open automatically.
3. Click "Dismiss": `localStorage.setItem('decision-matrix-dismissed', Date.now().toString())` is called.
4. Click "?" icon: modal opens (repeat access; not blocked by localStorage).

### CT-5: `FailModeSelector` (FR-6.7)

**Setup**: `<FailModeSelector value="open" onChange={spy} />`.

**Cases**:

1. Two radio options: `Open` (selected) and `Closed`.
2. When `Closed` is selected, disclosure text appears: _"Fail-closed means requests are blocked if PII detection fails. Recommended for text channels. May disrupt voice calls."_
3. Default is `Open` (matches schema default flip).

### CT-6: `RuleCard` — enable toggle disabled when rule incomplete (FR-8.3)

**Setup**: `<RuleCard rule={{ name: 'sdb', enabled: false, /* missing actionMessage */ }} />`.

**Cases**:

1. Enable toggle is `disabled` (greyed; cursor `not-allowed`).
2. Tooltip on the toggle: lists missing fields by i18n-keyed name (`'Action message'`).
3. Inline compact hint adjacent: `"1 field missing"` (or `"N fields missing"`).
4. When all required fields populated, toggle is enabled and no hint is shown.

### CT-7: `GuardrailsConfigPage` — policy list chips (FR-9.1–FR-9.6)

**Setup**: Mock policy list with various rule configurations.

**Cases**:

1. Policy with 2 enabled rules (one SDB, one Content Safety) → row shows two green-dot chips: `● Sensitive Data Block · SSN, CC` and `● Content Safety`.
2. Policy with 5 enabled rules → first 3 chips + `+2 more` chip; hover reveals tooltip with full list.
3. Policy with 0 enabled rules → muted text: `⚠ No rules enabled — open editor to add`. Activation toggle is disabled with tooltip _"Enable at least one rule to activate this policy."_
4. SDB chip with 1 entity: `● Sensitive Data Block · SSN`. With 3 entities: `● Sensitive Data Block · SSN, CC +1 more`.
5. Chip click navigates to `/projects/:projectId/guardrails-config?ruleId=<id>` (deep link).
6. Responsive: at viewport ≥1024px chips are inline-right of the name; <1024px chips wrap below the name.

### CT-9: `EntityMultiselect` — catalog endpoint failure (FR-10.4, §C.2 fail-closed row 2)

**Setup**: Render `<EntityMultiselect />` with MSW (Mock Service Worker) intercepting `GET /api/projects/:projectId/pii-entities`. Each case configures the interceptor differently.

**Cases**:

1. **Pending state**: MSW delays the response. Skeleton or "Loading entities…" placeholder shown. Save button on the parent form is `disabled`.
2. **5xx error**: MSW returns `500`. Error message: _"Failed to load entity catalog. Retry"_ with a retry button. Save remains `disabled`.
3. **Retry success**: Click retry → second fetch resolves with entities. List populates; Save becomes `enabled`.
4. **Network error**: MSW throws on the request. Same UX as case 2 (error message + retry).

**File mapping**: Extends `apps/studio/src/__tests__/components/guardrails/EntityMultiselect.test.tsx` (same file as CT-1, CT-2).

### CT-8: `PIIProtectionTab` — cross-link banner (FR-2.1, FR-2.3)

**Setup**: Mock `localStorage`. Render the Settings PII Protection tab.

**Cases**:

1. No prior dismissal → banner renders with copy: _"Need to block requests containing PII outright? Create a Guardrail Policy with a Sensitive Data Block rule. → Configure now"_.
2. Click "Configure now" → navigates to `/projects/:projectId/guardrails-config?preset=sensitive_data_block&open=true`.
3. Click dismiss → `localStorage.setItem('settings-pii-banner-dismissed', Date.now())`. Banner hides.
4. Re-render after 91 days simulated → banner shows again.

---

## 6. Surface Semantics & Design-Time vs Runtime Verification

| Asset / Entity                                              | Design-time surface                                       | Runtime materialization                                                             | Test coverage                                                                                                    |
| ----------------------------------------------------------- | --------------------------------------------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `IGuardrailRule.entities[]`                                 | Sensitive Data Block multiselect (Studio)                 | Post-detection entity filter (runtime evaluator)                                    | INT-2, E2E-1                                                                                                     |
| Entity catalog (37 entities, 8 packs)                       | `EntityMultiselect` consumes the project-scoped catalog   | Recognizer registry resolves IDs to runtime recognizer functions                    | INT-5, E2E-5, E2E-6                                                                                              |
| SDB preset definition (`presetKey: 'sensitive_data_block'`) | Hidden from user; the form generates a rule with this key | Rule is a normal `IGuardrailRule` at runtime; preset key is metadata only           | E2E-1 step 1 (preset key persisted)                                                                              |
| Decision matrix content                                     | `DecisionMatrixModal` rendered from i18n keys             | Not runtime-relevant                                                                | CT-3, CT-4                                                                                                       |
| `failMode` (per-policy)                                     | `FailModeSelector` in form                                | Consumed by `packages/compiler/src/platform/guardrails/pipeline.ts` L597-598        | CT-5, E2E-7, INT-10                                                                                              |
| `kind: 'both'` (form-only)                                  | Studio checkboxes "Input + Output"                        | NEVER persisted — expanded to two rules in `serializeRule()` and `normalizeRules()` | CT-1b (verifies serialize → two rules + deserialize round-trip), INT-2 case 4 (runtime evaluator sees two rules) |

**Local-only surfaces** (not exposed via runtime API):

- `localStorage` keys: `decision-matrix-dismissed`, `settings-pii-banner-dismissed`, `guardrails-banner-dismissed` — purely client-side.

**Unsupported asset classes** (must remain absent):

- Mobile/tablet entity multiselect (<768px viewport) — GAP-001 accepted limitation.
- Third-party PII provider entries in the multiselect — out of scope v1; schema supports namespaced IDs (`presidio.person`) but UI does not.

---

## 7. Security & Isolation Tests

All scenarios below are mandatory before promotion past ALPHA. Each maps to a specific E2E or integration scenario above.

- [ ] **Cross-tenant access returns 404** (not 403) — INT-8, E2E-6.
- [ ] **Cross-project access returns 404** — INT-8, E2E-6.
- [ ] **Cross-user access**: N/A. Guardrail policies are project-scoped resources, not user-owned. Tested via project isolation.
- [ ] **Missing auth returns 401** — Standard middleware test, not duplicated here; relies on `createUnifiedAuthMiddleware` baseline coverage.
- [ ] **Insufficient permissions returns 403** — INT-11 (new):
  - User with `guardrail:read` but not `guardrail:write` attempting `PUT` → 403.
  - User with `:update` but not `:activate` attempting `POST .../activate` → 403.
  - User without `pii-pattern:read` attempting `GET /pii-entities` → 403.

  **Implementation**: Extend the existing `apps/runtime/src/__tests__/execution/guardrails/policy-rbac.integration.test.ts` with three new SDB-specific RBAC cases following the existing pattern (token-with-scope ↔ route ↔ expected status table). The new `pii-entities` route is the only entirely new boundary; the other two extend coverage of existing routes for the new permission semantics.

- [ ] **Input validation rejects malformed data** — INT-9 (actionMessage XSS / null / length), INT-1 (rule structure).

---

## 8. Critical Feature Gate Coverage

Per `docs/sdlc/feature-spec-playbook.md` §C requirements for privacy/compliance features.

### 8.1 Terminology Coverage

- Implicit through functional tests. The terms `block`, `warn`, `escalate`, `NO_ENABLED_RULES`, `RULE_INCOMPLETE`, `failMode`, `sensitive_data_block`, `entities`, `enabled`, `actionMessage` all appear as assertion values in E2E and integration tests. Drift in any of these would cause test failure.
- No dedicated snapshot test in v1 (DECIDED per Q-TS-16). May be added post-launch if drift is observed.

### 8.2 Fail-Closed Coverage

| Failure Mode                    | Coverage                                                                           |
| ------------------------------- | ---------------------------------------------------------------------------------- |
| Detector throws / times out     | E2E-7 (failMode open vs closed)                                                    |
| Catalog endpoint unavailable    | CT-9 (component test in §5: pending state, 5xx error with retry UI, network error) |
| Unknown entity ID in saved rule | INT-2 case 8 + CT-2 (UI warning on re-open)                                        |
| Activation gate violation       | E2E-2 + INT-7                                                                      |
| Rule incomplete                 | E2E-3 + INT-1                                                                      |

Error envelope universal shape `{ success: false, error: { code, message, missingFields? } }` asserted in every error-path test.

### 8.3 Threat Model Coverage

Every threat in §C.3 has a corresponding test scenario:

| Threat                                        | Coverage                                             | Priority |
| --------------------------------------------- | ---------------------------------------------------- | -------- |
| T1: Misconfigured policy (zero entities)      | UT-1 group A (cases A9, A10), INT-2 case 6           | HIGH     |
| T2: Pack-disabled entity → silent never-match | INT-2 case 8 + CT-2                                  | MEDIUM   |
| T3: Stored XSS in `actionMessage`             | E2E-12 + INT-9                                       | HIGH     |
| T4: API bypass of UI gates                    | E2E-11 + E2E-2 + E2E-3 + INT-1                       | HIGH     |
| T5: Cross-project catalog leak                | E2E-6 + INT-8                                        | HIGH     |
| T6: Race on auto-deactivation                 | INT-4                                                | MEDIUM   |
| T7: Telemetry leak (PII in trace)             | INT-6 (assert no matched substring in event payload) | MEDIUM   |
| T8: Catalog rate-limit enumeration            | E2E-15                                               | LOW      |
| T9: Log injection via `actionMessage`         | INT-9 cases 5, 6 (null bytes + newlines)             | MEDIUM   |

### 8.4 Rollout / Rollback Coverage

- Schema-additive guarantee: E2E-8 (legacy rule without new fields saves and behaves as today).
- `failMode` default flip: INT-10 (new policies default to `'open'`; explicit `'closed'` and `'open'` round-trip).
- No feature-flag coverage needed (no feature flag per PRD §6.1, feature spec §7).
- No migration-script coverage needed (no migration script).
- Pre-deploy cleanup script (`tools/cleanup-pii-guardrail-presets.ts`) is tested separately as a CLI tool — covered in §9 below.

---

## 9. Performance & Load Tests

- **Tier 1 latency**: `BuiltinPIIProvider` p95 ≤ 5ms, p99 ≤ 10ms per `GUARDRAILS_SPEC.md` §10.1. This is **inherited coverage** — already tested in the ABLP-921 PII tiered recognizers test suite. No new perf test required for v1; the post-detection entity filter is O(n) over ≤37 entities (sub-millisecond) and adds negligible overhead.
- **Catalog endpoint**: a single `GET /pii-entities` should respond in <50ms for the median request (project with all 8 packs). Optional in v1; track in monitoring post-launch.
- **Policy list chip rendering**: at most ~10 policies × ~4 chips each = 40 chips. Negligible. No perf test in v1.

---

## 10. Pre-deploy Cleanup Script Tests

**File**: `tools/__tests__/cleanup-pii-guardrail-presets.test.ts` (or co-located with the script).

### CL-1: Dry-run mode

- Input: MongoDB containing 5 policies, 2 of which have a rule with `presetKey: 'pii_protection'` and `action: 'redact'`.
- Run: `tsx tools/cleanup-pii-guardrail-presets.ts --dry-run`.
- Expected output: Prints a list of 2 affected policies and the rules that would be removed. No DB writes.

### CL-2: Confirmed run

- Input: same as above.
- Run: `tsx tools/cleanup-pii-guardrail-presets.ts --confirm`.
- Expected: The 2 `pii_protection`/`redact` rules are removed. DB write timestamped in audit log.

### CL-3: Idempotency

- Run `--confirm` twice in succession on the same DB.
- Expected: Second run reports `0 policies affected`. No double-deletion errors.

### CL-4: Safety guard

- Run without `--confirm` or `--dry-run` flags.
- Expected: Error message: `Refusing to run without explicit --confirm or --dry-run flag.` Exit code 1.

---

## 11. Test Infrastructure

| Need                                         | Provider                                                                          | Notes                                                                               |
| -------------------------------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Real MongoDB                                 | `MongoMemoryServer` (in-process, no Docker)                                       | Started by `RuntimeApiHarness`                                                      |
| Real Express + middleware                    | `RuntimeApiHarness`                                                               | Random port via `{ port: 0 }`                                                       |
| Mock LLM                                     | `startMockLLM()` from `tools/agents/e2e-functional/mock-llm-server.js`            | Real HTTP server; mimics OpenAI API; for E2E tests that send chat messages          |
| Real recognizer-packs                        | Source-controlled at `packages/compiler/src/platform/security/recognizer-packs/`  | Used in-process; no mock                                                            |
| Project bootstrap                            | `bootstrapProject()` from `apps/runtime/src/__tests__/helpers/`                   | Creates tenant + project + user + permissions                                       |
| PII echo agent DSL                           | `PII_ECHO_AGENT_DSL` from `apps/runtime/src/__tests__/helpers/pii-e2e-helpers.ts` | Reusable agent for PII E2E tests                                                    |
| Studio Playwright runtime                    | Studio on `localhost:5173`, Runtime on `localhost:3002` (or `3112`)               | Started externally before Playwright run; existing fixtures from `apps/studio/e2e/` |
| MSW for Studio component tests               | `msw` package (existing dependency)                                               | For mocking the catalog endpoint in component tests                                 |
| Faulty recognizer fixture for failMode tests | NEW: `apps/runtime/src/__tests__/fixtures/failing-recognizer-pack.ts`             | Test-only recognizer that throws on `recognize()` to exercise the failMode path     |

### Directory creation needed during implementation

Three test subdirectories proposed by the file mapping in §12 do not exist yet and must be created on first test commit:

- `apps/studio/src/__tests__/components/guardrails/` — new subdirectory. Existing Studio guardrail component tests live in the flat parent directory (`guardrail-policy-form.test.tsx`, `guardrails-config-page.test.tsx`). The subdirectory grouping is justified by the higher number of new SDB components (`EntityMultiselect`, `DecisionMatrixModal`, `FailModeSelector` + extensions to `RuleCard`, `GuardrailPolicyForm`, `GuardrailsConfigPage`).
- `apps/studio/src/__tests__/components/settings/` — new subdirectory for `PIIProtectionTab.test.tsx`.
- `apps/runtime/src/__tests__/integration/guardrails/` — new subdirectory for the new integration test files. Existing guardrail tests live in `apps/runtime/src/__tests__/execution/guardrails/`; the `/integration/` split is justified because these are pure-route + boundary tests, not pipeline execution tests.

Implementers may instead choose to adopt the existing flat-naming convention (e.g., `guardrails-entity-multiselect.test.tsx`) — this is a style decision for the first commit and should be applied consistently thereafter.

### `packages/shared/src/__tests__/validation/` directory

Does not exist yet (`packages/shared/src/__tests__/` is currently flat). On first commit, either create the `validation/` subdirectory to mirror the source directory (`packages/shared/src/validation/`), OR place `guardrail-rule-validation.test.ts` at the flat root. Recommended: mirror the source directory for navigability — `packages/shared/src/validation/pii-pack-names.ts` is the precedent file, so `packages/shared/src/__tests__/validation/pii-pack-names.test.ts` and `guardrail-rule-validation.test.ts` co-located is the cleanest layout.

### Environment Variables

- `TEST_MONGO_URL`: omitted — `RuntimeApiHarness` uses `MongoMemoryServer`.
- `MOCK_LLM_BASE_URL`: set by `startMockLLM()` per test.
- `NODE_ENV=test`: required by `RuntimeApiHarness`.

### CI Configuration

- Existing `pnpm test:report` invocation covers the unit + integration + E2E suites.
- Studio Playwright tests run via `pnpm test:e2e --filter @abl/studio` (separate CI step; requires Studio + Runtime running).
- The CL-\* cleanup script tests run as part of the `tools/` test scope.

---

## 12. Test File Mapping

| Test File                                                                                    | Type              | Covers                                                                                                                                                                                                                                                        |
| -------------------------------------------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared/src/__tests__/validation/guardrail-rule-validation.test.ts`                 | Unit              | UT-1 (~40 cases incl. Group F actionMessage sanitization), UT-2                                                                                                                                                                                               |
| `apps/runtime/src/__tests__/e2e/sensitive-data-block.e2e.test.ts`                            | E2E               | E2E-1, E2E-2, E2E-3, E2E-4, E2E-7, E2E-8, E2E-14                                                                                                                                                                                                              |
| `apps/runtime/src/__tests__/e2e/sensitive-data-block-catalog.e2e.test.ts`                    | E2E               | E2E-5, E2E-6, E2E-15                                                                                                                                                                                                                                          |
| `apps/runtime/src/__tests__/e2e/sensitive-data-block-tenant-scope.e2e.test.ts`               | E2E               | E2E-9                                                                                                                                                                                                                                                         |
| `apps/runtime/src/__tests__/e2e/sensitive-data-block-api-bypass.e2e.test.ts`                 | E2E               | E2E-11, E2E-12                                                                                                                                                                                                                                                |
| `apps/runtime/src/__tests__/integration/guardrails/validate-rule-integration.test.ts`        | Integration       | INT-1                                                                                                                                                                                                                                                         |
| `apps/runtime/src/__tests__/integration/guardrails/entity-filter.test.ts`                    | Integration       | INT-2                                                                                                                                                                                                                                                         |
| `apps/runtime/src/__tests__/integration/guardrails/pii-entities-catalog.test.ts`             | Integration       | INT-3, INT-5                                                                                                                                                                                                                                                  |
| `apps/runtime/src/__tests__/integration/guardrails/auto-deactivation-race.test.ts`           | Integration       | INT-4, INT-12 (PUT lifecycle precedence), INT-13 (reactivate sibling-deactivation)                                                                                                                                                                            |
| `apps/runtime/src/__tests__/integration/guardrails/telemetry-rename.test.ts`                 | Integration       | INT-6                                                                                                                                                                                                                                                         |
| `apps/runtime/src/__tests__/integration/guardrails/trace-events-activation.test.ts`          | Integration       | INT-7 (incl. `presetKey` 4-site full-chain assertion)                                                                                                                                                                                                         |
| `apps/runtime/src/__tests__/integration/guardrails/cross-tenant-isolation.test.ts`           | Integration       | INT-8                                                                                                                                                                                                                                                         |
| `apps/runtime/src/__tests__/integration/guardrails/action-message-sanitization.test.ts`      | Integration       | INT-9                                                                                                                                                                                                                                                         |
| `apps/runtime/src/__tests__/integration/guardrails/failmode-default.test.ts`                 | Integration       | INT-10                                                                                                                                                                                                                                                        |
| `apps/runtime/src/__tests__/execution/guardrails/policy-rbac.integration.test.ts` (EXTENDED) | Integration       | INT-11 (SDB-specific RBAC cases added to existing file)                                                                                                                                                                                                       |
| `apps/studio/src/__tests__/components/guardrails/GuardrailPolicyForm.test.tsx`               | Component         | CT-1, CT-1b (`kind: 'both'` two-rule expansion + round-trip), CT-1c (serializer round-trip with `enabled: false`), CT-2, CT-5, CT-9 (consolidated into the single PolicyForm spec — implementation chose one component-host file over per-subcomponent files) |
| _NOT YET CREATED (deferred)_ — would be `EntityMultiselect.test.tsx`                         | Component         | covered by `GuardrailPolicyForm.test.tsx` rows above; no standalone file shipped                                                                                                                                                                              |
| _NOT YET CREATED (deferred)_ — would be `DecisionMatrixModal.test.tsx`                       | Component         | CT-3, CT-4 — DEFERRED (subcomponent extraction never landed; logic exercised via Playwright E2E-10)                                                                                                                                                           |
| _NOT YET CREATED (deferred)_ — would be `FailModeSelector.test.tsx`                          | Component         | CT-5 covered inline in `GuardrailPolicyForm.test.tsx`                                                                                                                                                                                                         |
| _NOT YET CREATED (deferred)_ — would be `RuleCard.test.tsx`                                  | Component         | CT-6 — DEFERRED via GAP-009 (RuleCard toggle gate)                                                                                                                                                                                                            |
| _NOT YET CREATED (deferred)_ — would be `GuardrailsConfigPage.test.tsx`                      | Component         | CT-7 — DEFERRED via GAP-007 (GuardrailsConfigPage SDB chips)                                                                                                                                                                                                  |
| _NOT YET CREATED (deferred)_ — would be `PIIProtectionTab.test.tsx`                          | Component         | CT-8 — DEFERRED via GAP-006 (PIIProtectionTab cross-link banner)                                                                                                                                                                                              |
| `apps/studio/src/__tests__/lib/banner-ttl.test.ts` (scaffold)                                | Unit              | UT-3 — file present with `it.todo` markers only; implementation deferred via GAP-006                                                                                                                                                                          |
| `apps/studio/src/__tests__/components/guardrails/preset-defaults.test.ts`                    | Unit              | UT-4, UT-5                                                                                                                                                                                                                                                    |
| `apps/studio/e2e/guardrails-sensitive-data-block.spec.ts`                                    | Studio Playwright | E2E-10                                                                                                                                                                                                                                                        |
| `tools/__tests__/cleanup-guardrail-traces.test.ts`                                           | Tool / CLI        | CL-1, CL-2, CL-3, CL-4                                                                                                                                                                                                                                        |

**Test files: 25 new / extended.** Roughly: 1 unit file (`validateRule`) × ~34 cases + 5 E2E files × 14 scenarios + 10 integration file rows × 11 scenarios (INT-3 + INT-5 share one file) + 8 component file rows × 10 scenarios (CT-1, CT-1b, CT-2 through CT-9) + 1 Studio Playwright file × 1 comprehensive scenario + 1 cleanup-tool test file × 4 scenarios.

---

## 13. Open Testing Questions

These are not blockers for the test spec but should be resolved during the implementation phase:

1. **Studio Playwright fixture for localStorage isolation**: Playwright tests share a browser context by default. The `DecisionMatrixModal` first-run test relies on a clean `localStorage`. The fixture pattern needs to be: per-test `context.clearStorage()` OR `test.use({ storageState: undefined })`. Final decision deferred to implementation.

2. **Faulty-recognizer fixture for failMode tests (E2E-7)**: How to inject a recognizer failure? Options: (a) env-var-gated fault injector inside `BuiltinPIIProvider`, (b) a test-only recognizer pack that throws, (c) a Vitest spy via DI. Per CLAUDE.md "no `vi.mock` of platform components," option (b) is preferred. Implementation should add `apps/runtime/src/__tests__/fixtures/failing-recognizer-pack.ts` and a test-only registration mechanism.

3. **Performance benchmark threshold for entity multiselect**: With all 8 packs enabled (37 entities), what's the acceptable render time threshold? Not blocking; track post-launch via monitoring if regression observed.

4. **Auto-deactivation Undo HTTP shape**: Is Undo a separate route (`POST .../:id/undo-deactivation`) or does it leverage the existing PUT + activate flow? The current test spec assumes the existing flow (PUT to re-enable + POST to activate). Implementation may choose to add a sugar route — if so, the relevant E2E scenarios should be updated.

5. **Trace store query API**: INT-6, INT-7, and E2E-14 require querying the trace store for emitted events. Does the runtime expose a test-only `GET /api/__test__/trace-events` endpoint, or do tests subscribe to a trace event emitter via DI? Implementation phase to clarify and document.

6. **HTTP status code for guardrail block** (E2E-1, E2E-14): Does a `block` action surface as `200 { blocked: true, actionMessage }` (matching existing Content Safety pattern) or as `403`/`422` with the standard error envelope? Resolution gates the assertion in E2E-1 and E2E-7. Likely `200` with a structured body, since the request was _processed_ successfully — it's the _response_ that was rejected. Verify against `apps/runtime/src/services/guardrails/` evaluator output handling during implementation.

7. **E2E-9 tenant-scoped route path** (LOW): The feature spec asserts tenant-scoped policy inheritance as an existing preserved capability. The tenant-level route mount is assumed to be at `/api/guardrail-policies` (alongside the project-scoped mount at `/api/projects/:projectId/guardrail-policies`). Verify the route exists during implementation. If no tenant-level HTTP route exists, the test reduces to: create policy with `scope: { type: 'tenant' }` via the project-scoped route + verify cross-project inheritance via runtime evaluation.

---

## 14. Test Architecture Compliance Checklist (per CLAUDE.md)

- [x] No `vi.mock` of `@agent-platform/*` or `@abl/*` in any test file (UT-1, INT-1 use real imports)
- [x] No `vi.mock` of relative imports in E2E tests
- [x] E2E tests do not import Mongoose models directly (all E2E uses HTTP API)
- [x] E2E tests start real Express servers on `{ port: 0 }` via `RuntimeApiHarness`
- [x] No TODO stubs in test setup — every fixture is concrete
- [x] `validateRule()` is tested as a pure function with zero mocks (UT-1)
- [x] Entity catalog filtering tests use real MongoDB (`MongoMemoryServer`) and real pack-enable state (E2E-5, INT-3)
- [x] Only external services (mock LLM) may be mocked; mocked via separate HTTP server (not `vi.mock`)
- [x] Race condition tests use `Promise.all` (INT-4) per established codebase pattern
- [x] WCAG dialog tests use `@testing-library/user-event` for keyboard simulation (CT-3)

---

## 15. References

- **Feature spec**: [`guardrails-sensitive-data-block.md`](../../features/sub-features/guardrails-sensitive-data-block.md) — 45 FRs across §4.1-4.10
- **Clarifying questions**: [`docs/sdlc-logs/guardrails-sensitive-data-block/clarifying-questions.md`](../../sdlc-logs/guardrails-sensitive-data-block/clarifying-questions.md) — 12 user decisions
- **Phase-1 SDLC log**: [`docs/sdlc-logs/guardrails-sensitive-data-block/feature-spec.log.md`](../../sdlc-logs/guardrails-sensitive-data-block/feature-spec.log.md)
- **Test architecture rules**: `CLAUDE.md` — "Test Architecture — Fix the Code, Not the Test"
- **Existing test patterns**: `apps/runtime/src/__tests__/execution/guardrails/policy-routes.test.ts`, `apps/runtime/src/__tests__/e2e/pii-confidence-threshold.e2e.test.ts`, `apps/runtime/src/__tests__/e2e/pii-cross-project-isolation.e2e.test.ts`
- **Playwright patterns**: `apps/studio/e2e/model-guardrails-e2e.spec.ts`, `apps/studio/e2e/guardrails-comprehensive-e2e.spec.ts`
