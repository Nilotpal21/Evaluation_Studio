# Testing Guide: Workflow Integration Node

**Feature**: [Workflow Integration Node](../features/workflow-integration-node.md)
**Status**: IN PROGRESS
**Last Updated**: 2026-04-11

---

## 1. Feature Summary

The Workflow Integration Node promotes the `integration` node from a stub to a fully functional canvas node that lets users select a connector, pick an action, and configure action inputs through a dynamically generated form. Users browse integrations in a tile-grid modal, select an action, pick a connection filtered to the chosen connector, and fill action inputs rendered from the action's `ConnectorProperty[]` schema. String fields natively accept `{{expression}}` syntax inline; non-string fields (boolean, dropdown, number, date, array) have an explicit expression mode toggle. At execution time, the workflow engine resolves expressions, looks up credentials via `ConnectionResolver` (including OAuth grant resolution for `oauth2_app` profiles), and delegates to `ConnectorToolExecutor`. The feature spans `apps/studio`, `apps/workflow-engine`, `packages/shared`, `packages/shared-kernel`, and `packages/connectors`.

---

## 2. Current Test State

**Existing tests:**

- **3 Playwright `test()` blocks** in `apps/studio/e2e/workflows/workflow-integration-node.spec.ts` covering 7 scenarios:
  1. _API: Connector catalog and connections_ (3 tests) — verifies Gmail connector is in the catalog with actions, action schemas include props, and the project has an active Gmail connection.
  2. _UI: Integration node configuration_ (1 comprehensive test) — adds Integration node, selects Gmail action via modal, verifies connection picker, dynamic action form, config persistence, and the "Change" re-selection flow.
  3. _UI: Empty state_ (1 test) — verifies the "Select Integration" button appears before any integration is selected and no connection section is shown.
  4. _UI: Modal navigation_ (1 test) — verifies search, "No integrations found" empty state, drill-down to action list, back button, and action search input.

- **1 unit test update** in `packages/connectors/src/__tests__/activepieces-importer.test.ts` — the `mapPropertyType` test `'maps ARRAY -> array'` validates the type mapping change from `'json'` to `'array'`.

- **232/232 connector package tests pass** (all existing tests in `packages/connectors/` remain green).

---

## 3. Coverage Matrix

| #   | Scenario                                                           | FR Reference | Type        | Status     | Test File                                                                                          |
| --- | ------------------------------------------------------------------ | ------------ | ----------- | ---------- | -------------------------------------------------------------------------------------------------- |
| 1   | Connector catalog API returns connectors with actions              | FR-1         | E2E         | PASS       | `workflow-integration-node.spec.ts` — "Gmail connector is in the catalog with actions"             |
| 2   | Action schemas API returns props for a connector                   | FR-5         | E2E         | PASS       | `workflow-integration-node.spec.ts` — "Gmail action schemas include props"                         |
| 3   | Connection picker shows project connections                        | FR-6         | E2E         | PASS       | `workflow-integration-node.spec.ts` — "Project has an active Gmail connection"                     |
| 4   | Full UI flow: add node, select integration, configure, save        | FR-1 to FR-9 | E2E         | PASS       | `workflow-integration-node.spec.ts` — "Add Integration node, select Gmail action, configure, save" |
| 5   | Empty state shows "Select Integration" button                      | FR-1, FR-6   | E2E         | PASS       | `workflow-integration-node.spec.ts` — "Integration node shows Select Integration button initially" |
| 6   | Picker modal search and back navigation                            | FR-2, FR-3   | E2E         | PASS       | `workflow-integration-node.spec.ts` — "IntegrationPickerModal search and navigation"               |
| 7   | ARRAY type maps to `'array'` (not `'json'`)                        | FR-12        | Unit        | PASS       | `activepieces-importer.test.ts` — "maps ARRAY -> array"                                            |
| 8   | Dynamic form renders correct controls per property type            | FR-9         | Unit        | NOT TESTED | Needs component-level tests for `DynamicActionForm`                                                |
| 9   | Static/dynamic mode toggle persists correctly                      | FR-11        | Unit        | NOT TESTED | Needs component-level tests for expression toggle in `DynamicField`                                |
| 10  | Expression insertion from ContextExplorer                          | FR-10        | E2E         | NOT TESTED | Requires interaction with ContextExplorer popover and `{{` auto-trigger                            |
| 11  | `coerceParams()` parses JSON arrays, objects, numbers, booleans    | FR-15        | Unit        | NOT TESTED | Pure function in `context-translator.ts` (GAP-009)                                                 |
| 12  | OAuth grant resolution and token refresh                           | —            | Unit        | NOT TESTED | Blocked by GAP-005 (inline code in `index.ts`, not unit-testable)                                  |
| 13  | Full workflow execution with integration node                      | FR-15, FR-16 | E2E         | NOT TESTED | Requires running workflow with live connector                                                      |
| 14  | Config persistence across save/reload                              | FR-14        | E2E         | PASS       | `workflow-integration-node.spec.ts` — verifies config in Zustand store after save                  |
| 15  | Validation: required fields missing shows error                    | FR-13        | Unit        | NOT TESTED | Needs `IntegrationNodeConfigSchema` Zod validation tests                                           |
| 16  | Action schemas API returns 404 for unknown connector               | FR-5         | Integration | NOT TESTED | `GET /:connectorName/actions` with non-existent connector                                          |
| 17  | Connection picker: no-connections empty state                      | FR-8         | E2E         | NOT TESTED | Verify "No connections found" message and "Create connection" link                                 |
| 18  | Connection picker: "Create new connection" navigates to catalog    | FR-7         | E2E         | NOT TESTED | Verify navigation to `/projects/:projectId/integrations`                                           |
| 19  | ChipInput: add, remove, keyboard handling                          | FR-12        | Unit        | NOT TESTED | Test Enter/comma to add, Backspace to remove last, `X` button                                      |
| 20  | `ConnectionResolver.resolveAuth()` delegates to OAuthGrantResolver | —            | Integration | NOT TESTED | Verify OAuth grant lookup for `oauth2_app` profiles                                                |
| 21  | Config reset on integration/action change                          | FR-4         | Unit        | NOT TESTED | `handleSelectIntegration` resets params, paramModes, connectionId                                  |

---

## 4. E2E Test Scenarios (minimum 5)

All E2E tests live in `apps/studio/e2e/workflows/workflow-integration-node.spec.ts` and use Playwright. They require all services running (Studio :5173, Runtime :3112, Workflow Engine :9081) and a Gmail connection on the first project.

### E2E-1: Happy path — select integration, pick action, configure, save (EXISTS)

**Description**: Full lifecycle: add Integration node, select Gmail via modal, pick an action, verify connection picker, verify dynamic form, save workflow, verify persistence.

**Preconditions**: Gmail connector in catalog with at least one action; an active Gmail connection on the project.

**Steps**:

1. `loginAndSetup(page)` to get `projectId` and `token`.
2. Pre-check: `GET /api/projects/:projectId/connectors` — verify Gmail is present.
3. Pre-check: `GET /api/projects/:projectId/connections` — verify Gmail connection exists.
4. `navigateToWorkflows(page)`, `createWorkflowViaUI(page, name)`, `waitForCanvasReady(page)`.
5. `addNodeViaHandleMenu(page, 'integration')` — verify `[data-node-type="integration"]` is visible.
6. `selectNodeByName(page, 'Integration0001')` — verify `[data-testid="config-panel"]` visible.
7. Click `[data-testid="integration-select-button"]` — verify `[role="dialog"]` opens.
8. Fill search input with "Gmail", click Gmail tile.
9. On action list screen, click first action — verify dialog closes.
10. Verify `[data-testid="integration-selection-button"]` shows text containing "gmail" (case-insensitive).
11. Verify connection select or create-connection link is visible.
12. Verify "Action Inputs" header or "no input parameters" message is visible.
13. `saveWorkflow(page)` — read Zustand store and verify `config.connectorId` and `config.actionName` are truthy.
14. Click selection button to re-open modal, then Escape — verify picker close/reopen flow.
15. Cleanup: `DELETE /api/projects/:projectId/workflows/:workflowId`.

**Expected results**: Config panel shows selected integration and action. Connection picker displays Gmail connections. Dynamic form renders input fields. Config persists after save.

**Test file**: `workflow-integration-node.spec.ts` — "Add Integration node, select Gmail action, configure, save"

### E2E-2: Empty state — no integration selected (EXISTS)

**Description**: Verify the initial state of an Integration node before any integration is selected.

**Preconditions**: None beyond running services.

**Steps**:

1. `loginAndSetup(page)`, `navigateToWorkflows(page)`, `createWorkflowViaUI(page, name)`.
2. `addNodeViaHandleMenu(page, 'integration')`.
3. `selectNodeByName(page, 'Integration0001')`.
4. Verify `[data-testid="integration-select-button"]` is visible with text "Select Integration".
5. Verify no connection label or "No connections found" message is visible inside `[data-testid="integration-node-config"]`.
6. Take screenshot.

**Expected results**: Only the "Select Integration & Action" button is shown. No connection picker, no action inputs.

**Test file**: `workflow-integration-node.spec.ts` — "Integration node shows Select Integration button initially"

### E2E-3: Modal navigation — search, back, drill-down (EXISTS)

**Description**: Verify the IntegrationPickerModal's search filtering, "No integrations found" empty state, drill-down to action list, back button, and action search input.

**Preconditions**: At least 2 connectors in the catalog.

**Steps**:

1. `loginAndSetup(page)`, create workflow, add Integration node, open config panel.
2. Click `[data-testid="integration-select-button"]` to open modal.
3. Verify tile grid has more than 1 tile (buttons with `.w-10.h-10` icon).
4. Search for "xyznonexistent" — verify "No integrations found" message appears.
5. Clear search, type "Gmail" — verify Gmail tile appears.
6. Click Gmail tile — verify action list screen with `button[aria-label="Back to integrations"]`.
7. Verify `input[placeholder*="Search actions"]` is visible.
8. Click back button — verify tile grid reappears with multiple tiles.
9. Escape to close modal.

**Expected results**: Search filters tiles. Non-matching query shows empty state. Drill-down shows action list with back navigation.

**Test file**: `workflow-integration-node.spec.ts` — "IntegrationPickerModal search and navigation"

### E2E-4: Connection picker — no-connections empty state

**Description**: Verify the "No connections found" empty state and "Create connection" link when the selected connector has no connections.

**Preconditions**: A connector in the catalog that has zero connections in the project (e.g., if Jira connector exists but no Jira connection is configured).

**Steps**:

1. `loginAndSetup(page)`, create workflow, add Integration node.
2. `GET /api/projects/:projectId/connectors` — find a connector with no matching connections. If all connectors have connections, skip test.
3. Open picker modal, select the zero-connection connector, select an action.
4. In config panel, verify text "No connections found" is visible.
5. Verify `[data-testid="create-connection-link"]` is visible with text "Create a connection".
6. Click the link — verify navigation to `/projects/:projectId/integrations`.

**Expected results**: Empty state shows descriptive message and actionable "Create a connection" link that navigates to the Connector Catalog page.

**Test file**: NOT YET CREATED

### E2E-5: Config persistence — save, reload, verify

**Description**: Verify that the full integration node config (connectorId, actionName, connectionId, params) survives a save and page reload.

**Preconditions**: Gmail connector with connection.

**Steps**:

1. `loginAndSetup(page)`, create workflow, add Integration node.
2. Select Gmail integration and an action via the modal.
3. Select a connection from the dropdown.
4. Fill at least one action input field with a value (e.g., `receiver` = `test@example.com`).
5. `saveWorkflow(page)`.
6. Navigate away from the workflow and back (or reload page).
7. Click the Integration node to open config panel.
8. Verify `[data-testid="integration-selection-button"]` shows Gmail.
9. Verify connection dropdown has the previously selected connection.
10. Verify the action input field retains the value `test@example.com`.

**Expected results**: All config values persist across save/reload: connector, action, connection, and params.

**Test file**: NOT YET CREATED

### E2E-6: Error handling — catalog fetch failure

**Description**: Verify the UI handles a catalog fetch failure gracefully with an error message.

**Preconditions**: Ability to intercept network requests (Playwright `page.route()`).

**Steps**:

1. `loginAndSetup(page)`, create workflow, add Integration node.
2. Use `page.route('**/api/projects/*/connectors', route => route.abort())` before opening the config panel (or intercept with a 500 response).
3. Click the Integration node to open config panel.
4. Verify an error message appears (e.g., "Failed to load integrations").
5. Verify the "Select Integration" button is disabled or shows a loading state.

**Expected results**: The `catalogError` state renders a `text-error` message. The button shows "Loading integrations..." or is disabled.

**Test file**: NOT YET CREATED

---

## 5. Integration Test Scenarios (minimum 5)

Integration tests exercise real service boundaries via HTTP API without mocking codebase components.

### INT-1: Connector catalog API returns connectors with actions

**Description**: Verify `GET /connectors` on the workflow-engine returns all registered connectors with their action lists.

**Steps**:

1. Start workflow-engine on a random port.
2. `GET /connectors` with valid auth headers.
3. Assert response: `{ success: true, data: [...] }`.
4. Assert each connector has `name`, `displayName`, and `actions` array.
5. Assert at least one connector has `actions.length > 0`.

**Expected results**: Response contains the full connector catalog with action metadata.

**Test file**: NOT YET CREATED

### INT-2: Action schemas API returns props for valid connector

**Description**: Verify `GET /connectors/:connectorName/actions` returns action schemas with `ConnectorProperty[]` props.

**Steps**:

1. Start workflow-engine on a random port.
2. `GET /connectors/gmail/actions` (or any known connector name).
3. Assert response: `{ success: true, data: [...] }`.
4. Assert each action has `name`, `displayName`, `description`, `props`.
5. Assert at least one action has `props.length > 0`.
6. Assert each prop has `name`, `displayName`, `type`, `required`.

**Expected results**: Action schemas include full property definitions usable by the dynamic form.

**Test file**: NOT YET CREATED

### INT-3: Action schemas API returns 404 for unknown connector

**Description**: Verify `GET /connectors/:connectorName/actions` returns 404 with structured error for a non-existent connector.

**Steps**:

1. Start workflow-engine on a random port.
2. `GET /connectors/nonexistent_connector_xyz/actions`.
3. Assert response status: 404.
4. Assert response body: `{ success: false, error: { code: 'CONNECTOR_NOT_FOUND', message: 'Connector not found: nonexistent_connector_xyz' } }`.

**Expected results**: Structured 404 error with `CONNECTOR_NOT_FOUND` code.

**Test file**: NOT YET CREATED

### INT-4: Connection resolver resolves OAuth grants for `oauth2_app` profiles

**Description**: Verify that `ConnectionResolver.resolveAuth()` delegates to `OAuthGrantResolver` when the auth profile has `clientId`/`clientSecret` but no `access_token`.

**Steps**:

1. Create a `ConnectionResolver` instance with a mock `OAuthGrantResolver` (dependency injection, not `vi.mock`).
2. Provide an `AuthProfileResolverLike` that returns `{ clientId: 'id', clientSecret: 'secret' }` (no `access_token`).
3. Configure the `OAuthGrantResolver` to return `{ access_token: 'grant_token', refresh_token: 'refresh' }`.
4. Call `resolveAuth(connection)`.
5. Assert the result is `{ access_token: 'grant_token', refresh_token: 'refresh' }`.

**Expected results**: When an auth profile has app credentials but no access token, the resolver delegates to the OAuth grant resolver and returns the grant's tokens.

**Test file**: NOT YET CREATED

### INT-5: `coerceParams()` correctly parses JSON arrays, objects, numbers, booleans

**Description**: Verify the `coerceParams()` pure function in `context-translator.ts` correctly coerces string-encoded values to their native types.

**Steps**:

1. Import `coerceParams` (requires exporting it or testing via `translateActionContext`).
2. Call with input: `{ arr: '["a","b"]', obj: '{"k":"v"}', num: '42', bool: 'true', str: 'hello', empty: '', boolFalse: 'false', float: '3.14', nested: '{"a":[1,2]}', badJson: '[invalid', spaces: '  true  ' }`.
3. Assert: `arr` is `["a","b"]`, `obj` is `{"k":"v"}`, `num` is `42`, `bool` is `true`, `str` is `"hello"`, `empty` is `""`, `boolFalse` is `false`, `float` is `3.14`, `nested` is `{"a":[1,2]}`, `badJson` is `"[invalid"`, `spaces` is `true` (trimmed then parsed).

**Expected results**: JSON arrays, objects, numbers, and booleans are parsed to native types. Invalid JSON and plain strings are kept as strings.

**Test file**: NOT YET CREATED

### INT-6: `ConnectionResolver.resolveAuth()` returns profile auth when no OAuth grant resolver configured

**Description**: Verify that without an `OAuthGrantResolver`, `resolveAuth()` returns the raw profile auth (for non-OAuth connectors like API key auth).

**Steps**:

1. Create a `ConnectionResolver` without an `OAuthGrantResolver` (third constructor arg omitted).
2. Provide an `AuthProfileResolverLike` that returns `{ apiKey: 'secret-key' }`.
3. Call `resolveAuth(connection)`.
4. Assert the result is `{ apiKey: 'secret-key' }`.

**Expected results**: For non-OAuth connectors, the profile auth is returned directly without grant resolution.

**Test file**: NOT YET CREATED

---

## 6. Unit Test Scenarios

### UNIT-1: `coerceParams()` pure function

**Target**: `packages/connectors/src/adapters/activepieces/context-translator.ts` — `coerceParams()`

**Test cases**:

| Input Value                   | Expected Output       | Type    |
| ----------------------------- | --------------------- | ------- |
| `'["a","b"]'`                 | `["a","b"]`           | array   |
| `'[]'`                        | `[]`                  | array   |
| `'{"key":"val"}'`             | `{key:"val"}`         | object  |
| `'{}'`                        | `{}`                  | object  |
| `'42'`                        | `42`                  | number  |
| `'3.14'`                      | `3.14`                | number  |
| `'0'`                         | `0`                   | number  |
| `'true'`                      | `true`                | boolean |
| `'false'`                     | `false`               | boolean |
| `'hello world'`               | `"hello world"`       | string  |
| `''`                          | `""`                  | string  |
| `'[invalid json'`             | `"[invalid json"`     | string  |
| `'  true  '`                  | `true`                | boolean |
| `'  ["a"]  '`                 | `["a"]`               | array   |
| Non-string value (e.g., `42`) | `42` (passed through) | number  |

**Note**: `coerceParams` is currently not exported. To test it, either export it or test indirectly via `translateActionContext`. GAP-009 tracks this.

### UNIT-2: ARRAY to array type mapping

**Target**: `packages/connectors/src/adapters/activepieces/type-mapper.ts` — `mapPropertyType()`

**Status**: PASS — covered by `activepieces-importer.test.ts` assertion `expect(mapPropertyType('ARRAY')).toBe('array')`.

### UNIT-3: `IntegrationNodeConfigSchema` validation

**Target**: `packages/shared/src/types/workflow-schemas.ts` — `IntegrationNodeConfigSchema`

**Test cases**:

| Input                                                | Expected Result                                                                             |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `{}`                                                 | Pass (all fields optional, defaults applied: `params: {}`, `paramModes: {}`, `timeout: 60`) |
| `{ connectorId: 'gmail', actionName: 'send_email' }` | Pass                                                                                        |
| `{ connectorId: '' }`                                | Fail (`min(1)` constraint)                                                                  |
| `{ actionName: '' }`                                 | Fail (`min(1)` constraint)                                                                  |
| `{ connectionId: '' }`                               | Fail (`min(1)` constraint)                                                                  |
| `{ params: { receiver: 'test@example.com' } }`       | Pass                                                                                        |
| `{ params: { receiver: 123 } }`                      | Fail (params values must be strings)                                                        |
| `{ paramModes: { priority: 'expression' } }`         | Pass                                                                                        |
| `{ paramModes: { priority: 'invalid' } }`            | Fail (enum allows only `'static'` or `'expression'`)                                        |
| `{ timeout: 4 }`                                     | Fail (`min(5)`)                                                                             |
| `{ timeout: 301 }`                                   | Fail (`max(300)`)                                                                           |
| `{ timeout: 60 }`                                    | Pass                                                                                        |
| `{ timeout: 5.5 }`                                   | Fail (`int()`)                                                                              |

### UNIT-4: ChipInput component — add, remove, keyboard handling

**Target**: `apps/studio/src/components/workflows/canvas/config/DynamicActionForm.tsx` — `ChipInput`

**Test cases**:

- Type "a@gmail.com" + press Enter: chip appears, input clears.
- Type "b@gmail.com" + press comma: chip appears, input clears.
- Press `X` button on a chip: chip is removed from the list.
- Press Backspace with empty input and existing chips: last chip is removed.
- `onBlur` with non-empty input: chip is added (auto-commit on blur).
- Empty input + Enter: no chip added.
- Initial value `'["a","b"]'`: two chips rendered ("a" and "b").
- Invalid JSON initial value: renders empty chip list (fallback to `[]`).
- `onChange` callback receives JSON array string: e.g., after adding "x", callback receives `'["x"]'`.

### UNIT-5: `DynamicActionForm` renders correct control per property type

**Target**: `apps/studio/src/components/workflows/canvas/config/DynamicActionForm.tsx`

**Test cases**:

| Property Type      | Expected UI Control           | Expression Mode         |
| ------------------ | ----------------------------- | ----------------------- |
| `string`           | `ExpressionInput` (inline)    | Always inline           |
| `dynamic_dropdown` | `ExpressionInput` (inline)    | Always inline           |
| `file`             | `ExpressionInput` (inline)    | Always inline           |
| `json`             | `ExpressionInput` (multiline) | Always inline           |
| `number`           | `<Input type="number">`       | Toggle: `Braces` button |
| `boolean`          | `<Toggle>`                    | Toggle: `Braces` button |
| `dropdown`         | `<Select>` with options       | Toggle: `Braces` button |
| `date`             | `<Input type="date">`         | Toggle: `Braces` button |
| `array`            | `ChipInput`                   | Toggle: `Braces` button |

- Empty props array: renders "This action has no input parameters." message.
- Required field: shows red asterisk (`*`) next to label.
- Props with `body`/`content`/`message` in name or `html`/`multiline` in description: renders multiline `ExpressionInput`.

### UNIT-6: `DynamicField` expression mode toggle

**Target**: `apps/studio/src/components/workflows/canvas/config/DynamicActionForm.tsx` — `DynamicField`

**Test cases**:

- Number field in static mode: renders `<Input type="number">`.
- Click `Braces` toggle: `onModeChange` called with `'expression'`.
- Number field in expression mode: renders `ExpressionInput` instead of number input.
- Click `Braces` toggle again: `onModeChange` called with `'static'`.
- String field: no toggle button rendered (always inline expression).

---

## 7. Known Gaps & Blockers

| ID      | Description                                                                                  | Severity | Impact on Testing                                                                                                                               |
| ------- | -------------------------------------------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| GAP-005 | OAuth grant resolver is inline in `index.ts` (~140 lines) — not extractable for unit testing | High     | Blocks unit testing of token lookup, refresh, and persistence logic. Must be extracted to a dedicated module before comprehensive auth testing. |
| GAP-006 | Action props and connection fetch errors silently swallowed in `IntegrationNodeConfig.tsx`   | Medium   | Cannot write E2E tests for action/connection fetch error states — only catalog fetch errors surface.                                            |
| GAP-007 | Old `IntegrationConfig` stub remains as dead code in `GenericNodeConfig.tsx`                 | Low      | No testing impact — dead code should be removed for clarity.                                                                                    |
| GAP-008 | `(connection as any).userId` cast in `connection-resolver.ts:128`                            | Low      | No testing impact — type safety issue only.                                                                                                     |
| GAP-009 | `coerceParams()` is not exported from `context-translator.ts`                                | Medium   | Cannot directly unit test the pure function. Must either export it or test indirectly via `translateActionContext`.                             |
| GAP-010 | Connector catalog route imports from `packages/connectors/src/generated/` (source path)      | Low      | No testing impact — may break in production builds.                                                                                             |
| GAP-011 | No timeout/AbortController on catalog and connection fetch calls                             | Low      | Long-running fetches cannot be tested for timeout behavior.                                                                                     |
| GAP-012 | Timeout units mismatch: config stores seconds, `DEFAULT_STEP_TIMEOUT_MS` is milliseconds     | Medium   | Integration tests for execution timeout behavior may produce incorrect results if units are not aligned.                                        |

---

## 8. Troubleshooting

For debugging integration node execution failures, connection/auth issues, and parameter formatting problems, see:

**[Workflow Integration Node Troubleshooting Checklist](./workflow-integration-node-troubleshooting.md)**

The troubleshooting doc covers:

- Connection and auth profile setup verification
- OAuth grant (EndUserOAuthToken) validation
- Google Cloud Console configuration for Google connectors
- Token refresh debugging
- Parameter formatting issues (array coercion, dropdown values, required fields)
- Connector infrastructure (build, restart, timeout)
- Encryption and Mongoose plugin edge cases
- Error code taxonomy (25 structured error codes across 5 categories)
