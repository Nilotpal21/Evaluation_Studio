# LLD: Attachment Settings Browser E2E (Playwright)

**Feature Spec**: `docs/features/sub-features/attachment-settings-ui.md`
**HLD**: `docs/specs/attachment-settings-ui.hld.md`
**Test Spec**: `docs/testing/sub-features/attachment-settings-ui.md`
**Parent LLD**: `docs/plans/2026-03-22-attachment-settings-ui-impl-plan.md`
**Status**: APPROVED
**Date**: 2026-03-22

**Purpose**: Close GAP-003 from the attachment-settings-ui feature spec by adding Playwright browser E2E tests that exercise the real Studio UI in a real browser against the real backend.

---

## 1. Design Decisions

### Decision Log

| #    | Decision                                      | Rationale                                                                                              | Alternatives Rejected                                                                  |
| ---- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| D-1  | Inline helpers per spec (no shared fixture)   | All existing Playwright specs use inline helpers; two login patterns not yet reconciled                | Shared fixture — would require reconciling login patterns first                        |
| D-2  | 6 browser E2E scenarios (UI-specific gaps)    | API E2E already covers runtime round-trip; browser E2E adds form interaction, visual indicators, etc   | All 10 FRs — redundant with API E2E                                                    |
| D-3  | Reuse first available project                 | Simpler; attachment config starts with platform defaults; cleanup via API reset                        | Fresh project creation — heavier, unnecessary                                          |
| D-4  | API-based login (model-guardrails pattern)    | More robust than button-click; includes cookie fallback and token extraction                           | Button-click login — fragile with hydration timing                                     |
| D-5  | Prefer aria-label selectors (getByLabel)      | Component has comprehensive aria-labels; resilient to Tailwind class changes                           | CSS class selectors — fragile with Tailwind                                            |
| D-6  | Hybrid seeding: UI primary, API setup/cleanup | UI interaction is the point; API for deterministic setup/teardown                                      | UI-only — slow and harder to reset state                                               |
| D-7  | Full save→reload→verify round-trip            | Primary value of browser E2E; catches state management bugs in `computeDiff`/`pendingNulls`            | Verify API only — misses UI rendering bugs                                             |
| D-8  | Use default `playwright.config.ts`            | All existing specs use the default config; using a different config creates discoverability problems   | `e2e-playwright.config.ts` — different reporter, no other spec uses it                 |
| D-9  | No visual regression baselines                | Dedicated `apps/studio/e2e/visual-regression/visual-baseline.spec.ts` exists; mixing adds complexity   | Include baselines — separate concern, adds flakiness                                   |
| D-10 | `test.describe.serial` with `test.setTimeout` | Tests share state (projectId, token) and depend on sequential execution; matches git-bitbucket pattern | Single `test()` with `test.step()` — valid but less readable for independent scenarios |

### FR Coverage Delegation

| FR    | Description                      | Browser E2E  | API E2E      | Rationale                                                           |
| ----- | -------------------------------- | ------------ | ------------ | ------------------------------------------------------------------- |
| FR-1  | Settings tab accessible via nav  | BRW-1        | —            | UI-specific: sidebar navigation, page rendering                     |
| FR-2  | Load resolved config             | BRW-1        | E2E-1        | UI rendering of resolved values; API verifies data                  |
| FR-3  | Override vs inherited indicators | BRW-2        | —            | UI-specific: visual badges and reset icons                          |
| FR-4  | Edit all 5 config fields + 1 RO  | BRW-3, BRW-4 | E2E-2, E2E-4 | UI form interaction + save-reload; API verifies persistence         |
| FR-5  | Per-field reset to default       | BRW-5        | E2E-3        | UI reset flow; API verifies null fallthrough                        |
| FR-6  | Save changes via PUT             | BRW-3        | E2E-2        | UI save button + toast; API verifies PUT round-trip                 |
| FR-7  | Toast on success/failure         | BRW-6        | —            | UI-specific: sonner toast display                                   |
| FR-8  | MIME type format validation      | BRW-4        | E2E-10       | Client-side validation UX; server-side validation by API E2E        |
| FR-9  | 50 MIME type entry cap           | —            | E2E-10       | Server-side validation; client-side cap covered by unit test UT-18  |
| FR-10 | Permission gating (proxy + RBAC) | —            | E2E-5, E2E-8 | RBAC enforcement not browser-testable without multi-user auth infra |

### Key Interfaces & Types

No new TypeScript interfaces. The test interacts with the UI through Playwright selectors and validates state through:

- Visual assertions (`expect(locator).toHaveText(...)`, `expect(locator).toBeVisible()`)
- API assertions (`page.request.get()` to verify persisted config)

### Module Boundaries

| Module                            | Responsibility                                       | Depends On                               |
| --------------------------------- | ---------------------------------------------------- | ---------------------------------------- |
| `attachment-settings-e2e.spec.ts` | Browser E2E test: 6 scenarios for UI interaction     | Running Studio (5173), Runtime (3112)    |
| `devLogin()` (inline helper)      | API-based auth via `/api/auth/dev-login`             | Studio auth endpoint                     |
| `getToken()` (inline helper)      | Extract access token for API seeding/teardown        | Studio auth endpoint                     |
| `resetConfig()` (inline helper)   | PUT all nulls via API to clean up after tests        | Studio proxy route                       |
| AttachmentSettingsTab (existing)  | React component under test                           | `apiFetch`, `navigation-store`, `sonner` |
| Studio proxy route (existing)     | `/api/projects/[id]/attachment-config` GET/PUT proxy | Runtime API                              |
| Runtime route (existing)          | `attachment-config.ts` with Zod validation + upsert  | MongoDB, config resolver                 |

---

## 2. File-Level Change Map

### New Files

| File                                              | Purpose                     | LOC Estimate |
| ------------------------------------------------- | --------------------------- | ------------ |
| `apps/studio/e2e/attachment-settings-e2e.spec.ts` | Playwright browser E2E test | ~350         |

### Modified Files

| File                                                   | Change Description                   | Risk |
| ------------------------------------------------------ | ------------------------------------ | ---- |
| `docs/features/sub-features/attachment-settings-ui.md` | Update GAP-003 status to Resolved    | Low  |
| `docs/testing/sub-features/attachment-settings-ui.md`  | Add browser E2E section to test spec | Low  |

### Deleted Files

None.

---

## 3. Implementation Phases

### Phase 1: Browser E2E Test Spec

**Goal**: Create the Playwright browser E2E test file with 6 scenarios that exercise the real Studio Attachment Settings UI.

**Tasks**:

1.1. Create `apps/studio/e2e/attachment-settings-e2e.spec.ts` with the following structure:

**Header comment:**

```typescript
/**
 * Browser E2E: Attachment Settings UI
 *
 * Exercises the real AttachmentSettingsTab component in a Chromium browser
 * against running Studio (5173) and Runtime (3112). Closes GAP-003 from the
 * attachment-settings-ui feature spec.
 *
 * Scenarios:
 *   BRW-1 — Navigate to Settings > Attachments, verify page loads with resolved config
 *   BRW-2 — Override vs inherited indicators render correctly
 *   BRW-3 — Toggle enabled, change PII policy, save, reload, verify persistence
 *   BRW-4 — MIME type chip editor: add valid, reject invalid, remove chip
 *   BRW-5 — Per-field reset to default: override → save → reset → save → verify inherited
 *   BRW-6 — Save success toast appears on save
 *
 * Run: cd apps/studio && npx playwright test e2e/attachment-settings-e2e.spec.ts --headed
 * Requires: Studio on 5173, Runtime on 3112 (pnpm dev or PM2)
 */
```

**Inline helpers (following model-guardrails-e2e.spec.ts pattern):**

- `devLogin(page)` — API-based login via `page.evaluate(fetch('/api/auth/dev-login', ...))`. **Implementation MUST copy the full ~70-line devLogin pattern from model-guardrails-e2e.spec.ts (lines 77-148)**, including: hydration wait via `waitForFunction` with 3 conditions, Zustand localStorage setup for `kore-auth-storage`, cookie verification, redirect detection, `page.request.post()` cookie fallback with `addCookies()`, and post-login navigation with 5s settle. The description here is abbreviated for readability.

- `getToken(page)` — `page.request.post('/api/auth/dev-login', { data: { email: 'dev@kore.ai', name: 'Developer' } })` and extract `accessToken` from response JSON.

- `getProjectId(page)` — Navigate to projects page, click first project card, extract `projectId` from URL via regex `/\/projects\/([^/?#]+)/`.

- `resetConfig(page, projectId, token)` — `page.request.put(\`/api/projects/${projectId}/attachment-config\`, { headers: { Authorization: \`Bearer ${token}\`, 'Content-Type': 'application/json' }, data: { enabled: null, maxFileSizeBytes: null, allowedMimeTypes: null, piiPolicy: null, defaultProcessingMode: null } })` to reset all overrides to platform defaults.

- `navigateToAttachmentSettings(page, projectId)` — `page.goto(\`${STUDIO_URL}/projects/${projectId}/settings/attachments\`)`+`page.waitForLoadState('networkidle')` + wait for the page title to be visible.

**Test structure (serial mode with explicit timeout, matching git-bitbucket-e2e.spec.ts pattern):**

```typescript
test.describe.serial('Attachment Settings Browser E2E', () => {
  test.setTimeout(120_000); // 2 min per test — settings page is fast

  let page: Page;
  let projectId: string;
  let token: string;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    await devLogin(page);
    token = await getToken(page);
    projectId = await getProjectId(page);
    // Reset config to clean slate (all defaults)
    await resetConfig(page, projectId, token);
  });
  // NOTE: page is kept OPEN and shared across all BRW tests.
  // Each test() uses the shared `page` variable, NOT the fixture { page }.
  // Cookies and localStorage persist across tests within the same BrowserContext.

  test.afterAll(async () => {
    await resetConfig(page, projectId, token);
    await page.close();
  });

  // ... BRW-1 through BRW-6 tests use the shared `page` ...
});
```

**BRW-1: Navigate to Settings > Attachments, verify page loads with resolved config**

- Navigate to `/projects/${projectId}/settings/attachments`
- Wait for the title "Attachment Settings" to be visible
- Verify all 6 field labels are visible:
  - "Enable Attachments" (`page.getByText('Enable Attachments')`)
  - "Maximum File Size" (`page.getByText('Maximum File Size')`)
  - "Allowed File Types" (`page.getByText('Allowed File Types')`)
  - "PII Policy" (`page.getByText('PII Policy')`)
  - "Default Processing Mode" (`page.getByText('Default Processing Mode')`)
  - "Max Files Per Session" (`page.getByText('Max Files Per Session')`)
- Verify the enabled toggle exists and is checked: `await expect(page.getByRole('switch')).toHaveAttribute('aria-checked', 'true')`
- Verify the PII policy dropdown shows "Redact" by default: `await expect(page.getByLabel('PII Policy')).toHaveValue('redact')`
- Verify the Save button is visible but disabled: `await expect(page.getByRole('button', { name: /Save/ })).toBeDisabled()`
- FR Coverage: FR-1, FR-2

**BRW-2: Override vs inherited indicators render correctly**

- Precondition: Use API to set `piiPolicy: 'block'` override via `page.request.put()`
- Navigate to attachment settings page
- Scope badge assertions to each field's container to avoid false positives (use semantic selectors, no Tailwind class fragments):
  - Locate PII Policy container: `page.locator('div').filter({ hasText: 'PII Policy' }).filter({ has: page.locator('select') }).first()` — `.first()` selects the most specific matching container
  - Verify "Custom override" badge within PII Policy container: `await expect(piiContainer.getByText('Custom override')).toBeVisible()`
  - Verify reset icon within PII Policy container: `await expect(piiContainer.getByLabel(/Reset.*to default/)).toBeVisible()`
  - Locate Enabled container: `page.locator('div').filter({ hasText: 'Enable Attachments' }).filter({ has: page.getByRole('switch') }).first()`
  - Verify "Inherited from defaults" badge within Enabled container: `await expect(enabledContainer.getByText('Inherited from defaults')).toBeVisible()`
  - Verify NO reset icon within Enabled container: `await expect(enabledContainer.getByLabel(/Reset.*to default/)).not.toBeVisible()`
- Cleanup: reset config via API
- FR Coverage: FR-3

**BRW-3: Toggle enabled, change PII policy, change file size, save, reload, verify persistence**

- Navigate to attachment settings page
- Click the enabled toggle to turn it OFF (`page.getByRole('switch').click()`)
- Verify the toggle's aria-checked: `await expect(page.getByRole('switch')).toHaveAttribute('aria-checked', 'false')`
- Change PII policy to "Block" (`page.getByLabel('PII Policy').selectOption('block')`)
- Change max file size to 10 MB: clear the file size input (`page.getByLabel('Maximum File Size').fill('10')`) — this tests the MB-to-bytes conversion (10 _ 1024 _ 1024 = 10485760 stored)
- Verify Save button is now enabled: `await expect(page.getByRole('button', { name: /Save/ })).toBeEnabled()`
- Click Save (`page.getByRole('button', { name: /Save/ }).click()`)
- Wait for success toast: `await expect(page.getByText('Attachment settings saved')).toBeVisible({ timeout: 5000 })`
- Reload the page (`page.reload()`)
- Wait for the page to load (title "Attachment Settings" visible)
- Verify the enabled toggle is OFF: `await expect(page.getByRole('switch')).toHaveAttribute('aria-checked', 'false')`
- Verify PII policy dropdown shows "Block": `await expect(page.getByLabel('PII Policy')).toHaveValue('block')`
- Verify file size shows "10": `await expect(page.getByLabel('Maximum File Size')).toHaveValue('10')`
- Verify all three changed fields now show "Custom override" badge
- Cleanup: reset config via API, reload
- FR Coverage: FR-4, FR-6

**BRW-4: MIME type chip editor: add valid, reject invalid, remove chip**

- Navigate to attachment settings page
- Locate the MIME type input (`page.getByLabel('Add MIME type')`)
- Type "application/json" and press Enter
- Verify the "application/json" chip appears (`page.getByText('application/json')`)
- Verify the remove button exists for the chip (`page.getByLabel('Remove MIME type application/json')`)
- Clear the input, type "not-a-mime" and press Enter
- Verify error message appears (`page.getByText(/Invalid MIME type format/)`)
- Verify "not-a-mime" chip does NOT appear
- Click the remove button for "application/json" (`page.getByLabel('Remove MIME type application/json').click()`)
- Verify the "application/json" chip is gone
- Note: No save in this scenario — tests UI interaction only. Persistence of MIME changes is covered by API E2E-6 (falsy-but-valid round-trip with `allowedMimeTypes: []`) and E2E-10 (valid MIME acceptance round-trip). BRW-3 verifies the save-reload pattern for other field types.
- FR Coverage: FR-4, FR-8

**BRW-5: Per-field reset to default: override → save → reset → save → verify inherited**

- Use API to set `piiPolicy: 'block'` override
- Navigate to attachment settings page
- Verify "Custom override" badge for PII Policy
- Verify PII Policy shows "Block"
- Click the reset icon next to PII Policy (`page.getByLabel(/Reset.*to default/).first().click()`)
- Verify Save button is enabled (dirty state from reset)
- Click Save
- Wait for success toast
- Reload the page
- Verify PII Policy shows "Redact" (platform default)
- Verify PII Policy shows "Inherited from defaults" badge
- FR Coverage: FR-5

**BRW-6: Save success toast appears on save**

- Navigate to attachment settings page
- Change the processing mode dropdown to "Metadata Only" (`page.getByLabel('Default Processing Mode').selectOption('metadata_only')`)
- Click Save
- Wait for toast notification: assert `page.getByText('Attachment settings saved')` is visible within 5s
- Cleanup: reset config via API
- FR Coverage: FR-7

  1.2. Verify the test runs locally:

```bash
cd apps/studio && npx playwright test e2e/attachment-settings-e2e.spec.ts --headed
```

**Files Touched**:

- `apps/studio/e2e/attachment-settings-e2e.spec.ts` — NEW Playwright browser E2E test

**Exit Criteria**:

- [ ] Test file exists at `apps/studio/e2e/attachment-settings-e2e.spec.ts`
- [ ] All 6 browser E2E scenarios (BRW-1 through BRW-6) pass with `--headed` against running Studio + Runtime
- [ ] BRW-1: All 6 field labels visible, toggle checked, PII shows "Redact", Save disabled
- [ ] BRW-2: "Custom override" badge visible for overridden field, "Inherited from defaults" for non-overridden
- [ ] BRW-3: Toggle OFF + PII "Block" → Save → Reload → values persist + "Custom override" badges appear
- [ ] BRW-4: Valid MIME chip added, invalid MIME rejected with error, chip removal works
- [ ] BRW-5: Override → Save → Reset → Save → Reload → "Inherited from defaults" + platform default value
- [ ] BRW-6: Save triggers success toast "Attachment settings saved"
- [ ] `afterAll` cleanup resets config to platform defaults
- [ ] No flaky behavior on 3 consecutive runs

**Test Strategy**:

- Browser E2E: Real Chromium browser, real Studio UI, real Studio proxy, real Runtime API, real MongoDB
- Selectors: aria-labels as primary, text as fallback
- Data: API seeding for preconditions, UI interaction for test flows, API cleanup for teardown

**Rollback**: Delete the test file. No production code affected.

---

### Phase 2: Documentation Updates

**Goal**: Update the feature spec and test spec to reflect GAP-003 closure and add browser E2E scenarios.

**Tasks**:

2.1. In `docs/features/sub-features/attachment-settings-ui.md`, update GAP-003:

| ID      | Description                                                                                                           | Severity | Status       |
| ------- | --------------------------------------------------------------------------------------------------------------------- | -------- | ------------ |
| GAP-003 | Playwright browser E2E tests added for Studio settings — 6 scenarios covering UI interaction, indicators, MIME, reset | Medium   | **Resolved** |

2.2. In `docs/testing/sub-features/attachment-settings-ui.md`, add a new section **"10. Browser E2E Test Scenarios"** after the existing E2E section:

Add 6 browser E2E scenarios (BRW-1 through BRW-6) with the following fields: preconditions, steps, expected result, FR coverage. Also update the coverage matrix to show browser E2E coverage for FR-1, FR-3, FR-4, FR-5, FR-7, FR-8.

2.3. Update the test spec Section 9 (Open Testing Questions) to mark Q1 as resolved:

> 1. ~~**Browser E2E**~~: **Resolved** — `apps/studio/e2e/attachment-settings-e2e.spec.ts` adds 6 Playwright browser E2E scenarios (BRW-1 through BRW-6).

2.4. Update the test file mapping table to include the new browser E2E test file.

**Files Touched**:

- `docs/features/sub-features/attachment-settings-ui.md` — Update GAP-003 status
- `docs/testing/sub-features/attachment-settings-ui.md` — Add browser E2E section + update coverage matrix

**Exit Criteria**:

- [ ] GAP-003 status is "Resolved" in the feature spec
- [ ] Test spec includes Browser E2E section (BRW-1 through BRW-6) with FR coverage mapping
- [ ] Coverage matrix updated with browser E2E column or notes
- [ ] Test file mapping table includes `attachment-settings-e2e.spec.ts`

**Test Strategy**: N/A (documentation-only phase)

**Rollback**: Revert documentation changes. No code impact.

---

## 4. Wiring Checklist

CRITICAL: Every new component must be wired into its callers.

- [x] N/A — New service registered in DI container / module exports (no new services)
- [x] N/A — New routes registered in router file (no new routes)
- [x] N/A — New models added to `packages/database/src/models/index.ts` (no new models)
- [x] N/A — New types exported from package index (no new types)
- [x] N/A — New middleware added to middleware chain (no new middleware)
- [x] N/A — New workers registered in worker startup (no workers)
- [x] N/A — UI components imported and rendered in parent components (no new UI components)
- [x] N/A — New API endpoints documented in OpenAPI spec (no new endpoints)
- [ ] **Test file discoverable by Playwright config** — `apps/studio/e2e/attachment-settings-e2e.spec.ts` is in the `e2e/` directory which is the `testDir` in both Playwright configs
- [ ] **Run command documented in header comment** — `cd apps/studio && npx playwright test e2e/attachment-settings-e2e.spec.ts --headed`

---

## 5. Cross-Phase Concerns

### Database Migrations

None. Test uses existing collections via the running runtime.

### Feature Flags

None.

### Configuration Changes

No new environment variables. The test uses `STUDIO_URL` (hardcoded `http://localhost:5173`) and relies on the running Studio + Runtime stack.

---

## 6. Acceptance Criteria (Whole Feature)

- [ ] All 6 browser E2E scenarios (BRW-1 through BRW-6) pass against running Studio + Runtime
- [ ] No regressions in existing 51 tests (23 unit + 4 proxy integration + 14 runtime integration + 10 runtime E2E)
- [ ] GAP-003 updated to "Resolved" in feature spec
- [ ] Test spec updated with browser E2E scenarios and coverage mapping
- [ ] `pnpm build --filter=studio` succeeds with 0 errors (no type changes)
- [ ] Test cleanup restores config to platform defaults (idempotent)
- [ ] 3 consecutive headless runs pass without flakiness

---

## 7. Open Questions

1. **Shared Playwright fixture**: All 10 existing specs duplicate `devLogin`/`getToken` helpers. Extracting a shared fixture is a separate effort that should be done when the login patterns are reconciled. Not blocking for this LLD.
2. **Visual regression baseline**: Adding the attachment settings page to `visual-baseline.spec.ts` is a one-line addition that can be done as a follow-up. Not in scope for this LLD.
3. **CI integration**: No existing Playwright tests run in CI. CI integration for Playwright is a separate infrastructure initiative.
