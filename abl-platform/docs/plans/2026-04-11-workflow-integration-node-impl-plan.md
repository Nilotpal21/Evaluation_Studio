# LLD: Workflow Integration Node

**Feature Spec**: ../features/workflow-integration-node.md
**HLD**: ../specs/workflow-integration-node.hld.md
**Test Spec**: ../testing/workflow-integration-node.md
**Status**: COMPLETE (as-built)
**Date**: 2026-04-11
**Branch**: `KI081/feat/workflows-integration-node`

---

## 1. Implementation Summary

The Workflow Integration Node promotes the previously stubbed `integration` node type into a fully functional canvas node. Users select a connector and action via a two-screen modal picker, choose a connection for authentication, and configure action inputs through a dynamically generated form driven by `ConnectorProperty[]` schemas. String fields accept `{{expression}}` syntax inline; non-string fields (boolean, dropdown, number, date, array) have an explicit expression mode toggle.

The implementation spans five packages: `apps/studio` (UI components + BFF routes), `apps/workflow-engine` (connector actions endpoint + OAuth grant resolver extraction), `packages/shared` (Zod schema), `packages/shared-kernel` (stub removal), and `packages/connectors` (type additions, auth fixes, coercion logic). No new database collections were introduced -- the node config is stored as part of the workflow document's `nodes[].config` field.

---

## 2. Phase Breakdown

### Phase 1: Schema & Type Foundation

**Goal**: Establish the data model and type system changes required before any UI or API work.

| File                                                                      | Change                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/shared-kernel/src/types/workflow-types.ts`                      | Removed `'integration'` from `STUB_NODE_TYPES` array (line 31). The type was already in the `NodeType` union -- this makes it a live node.                                                                                                                                                                                                                                                                         |
| `packages/shared/src/types/workflow-schemas.ts` (line 140)                | Added `IntegrationNodeConfigSchema` Zod object: `connectorId`, `actionName`, `connectionId` (all `z.string().min(1).optional()`), `params` (`z.record(z.string(), z.string()).default({})`), `paramModes` (`z.record(z.string(), z.enum(['static','expression'])).default({})`), `timeout` (`z.number().int().min(5).max(300).default(60)`). Wired into `NodeConfigSchemas` map at key `'integration'` (line 252). |
| `packages/connectors/src/types.ts` (line 39)                              | Added `'array'` to the `ConnectorPropertyType` union. Previously, Activepieces ARRAY mapped to `'json'` which caused the UI to render a JSON textarea instead of a chip input.                                                                                                                                                                                                                                     |
| `packages/connectors/src/adapters/activepieces/type-mapper.ts` (line 172) | Changed `mapPropertyType('ARRAY')` return from `'json'` to `'array'`. This is a build-time mapping used during `pnpm connectors:import`.                                                                                                                                                                                                                                                                           |

**Exit criteria**: `pnpm build --filter=@agent-platform/shared --filter=@agent-platform/shared-kernel --filter=@agent-platform/connectors` succeeds. `IntegrationNodeConfigSchema` parses `{}` with defaults applied. `mapPropertyType('ARRAY')` returns `'array'`.

---

### Phase 2: Backend API Endpoints

**Goal**: Expose connector catalog and action schema data to the Studio UI via BFF proxy routes and a new workflow-engine endpoint.

| File                                                                                | Change                                                                                                                                                                                                                                                            |
| ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/workflow-engine/src/routes/connectors.ts` (line 44-57)                        | Added `GET /:connectorName/actions` route. Looks up connector via `ConnectorListingService.getConnector()`, returns `{ success: true, data: connector.actions }` with full `ConnectorProperty[]` props. Returns 404 with `CONNECTOR_NOT_FOUND` code if not found. |
| `apps/studio/src/app/api/projects/[id]/connectors/route.ts`                         | New file. Serves static `connector-catalog.json` (pre-generated at build time) with `{ success: true, data }` envelope. Requires project-scoped auth via `withRouteHandler({ requireProject: true })`.                                                            |
| `apps/studio/src/app/api/projects/[id]/connectors/[connectorName]/actions/route.ts` | New file. Proxies to `GET /api/v1/connectors/:connectorName/actions` on the workflow engine via `proxyToWorkflowEngine()`. Validates `connectorName` param. Requires project-scoped auth.                                                                         |

**Data flow**: Studio UI fetches `GET /api/projects/:id/connectors` for browsing (static JSON, fast). When a connector is selected, Studio fetches `GET /api/projects/:id/connectors/:name/actions` which proxies to the engine where the `ConnectorRegistry` lives and returns full action schemas with `ConnectorProperty[]` props.

**Exit criteria**: `GET /api/v1/connectors/gmail/actions` returns action schemas with props. `GET /api/v1/connectors/nonexistent/actions` returns 404 with structured error. Studio BFF routes require auth and proxy correctly.

---

### Phase 3: Studio UI Components

**Goal**: Build the complete design-time UI: picker modal, connection selector, dynamic form, and expression input.

| File                                                                                      | Lines | Responsibility                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------------------------------------------------------------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/studio/src/components/workflows/canvas/config/IntegrationPickerModal.tsx`           | ~250  | Two-screen modal dialog. Screen 1: searchable tile grid of connectors with action count badges. Screen 2: searchable action list for the selected connector. Exports `CatalogConnector` and `ActionWithProps` types used by sibling components.                                                                                                                                                    |
| `apps/studio/src/components/workflows/canvas/config/DynamicActionForm.tsx`                | ~300  | Renders form fields from `ConnectorProperty[]`. String-like fields (`string`, `dynamic_dropdown`, `file`, `json`) use `ExpressionInput` with inline `{{expr}}`. Non-string fields render native controls (`Toggle`, `Select`, `Input[type=number]`, `Input[type=date]`, `ChipInput`) with a `{...}` toggle to switch to expression mode. Includes internal `ChipInput` component for array fields. |
| `apps/studio/src/components/workflows/canvas/config/ExpressionInput.tsx`                  | ~150  | Text input (single or multi-line) with a `{...}` button that opens the `ContextExplorer` popover. Auto-opens explorer when user types `{{`. Inserts expression at cursor position. Receives `triggerPayload` and `previousSteps` for context.                                                                                                                                                      |
| `apps/studio/src/components/workflows/canvas/config/IntegrationNodeConfig.tsx`            | 397   | Orchestrator component. Manages three data fetches (catalog, action props, connections) with loading/error states. Computes expression context from canvas graph (upstream nodes via BFS edge walk). Wires picker, connection `Select`, and `DynamicActionForm`.                                                                                                                                   |
| `apps/studio/src/components/workflows/canvas/config/GenericNodeConfig.tsx` (line 540-541) | 2     | Added `case 'integration': return <IntegrationNodeConfig nodeId={nodeId} config={config} onUpdate={handleUpdate} />;` to the node type switch.                                                                                                                                                                                                                                                     |

**Key UI behaviors**:

- **Config reset**: `handleSelectIntegration()` clears `params`, `paramModes`, and `connectionId` when the integration or action changes (lines 201-214 of IntegrationNodeConfig.tsx).
- **Expression context**: Upstream nodes are discovered via BFS backwards from the current node through `edges` (lines 79-109). The `triggerPayload` is derived from the start node's `inputSchema`.
- **Connection filtering**: Connections are fetched for the entire project, then filtered client-side by `connectorName === connectorId` (line 182).
- **Empty states**: "Select Integration & Action" button when no integration selected. "No connections found" with "Create a connection" link when connector has zero connections.

**Exit criteria**: Integration node renders in config panel. Picker modal opens, searches, drills into actions. Connection picker shows filtered connections. Dynamic form renders controls per property type. Config persists to Zustand store.

---

### Phase 4: Auth & Execution Wiring

**Goal**: Fix auth-layer issues and extract the OAuth grant resolver for testability.

| File                                                                            | Change                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/connectors/src/auth/connection-resolver.ts` (line 132)                | Fixed unsafe `(connection as any).userId` cast. Now accesses `connection.userId` after the `scope === 'user'` guard, which guarantees `userId` is present. Resolves GAP-008.                                                                                                                                  |
| `packages/connectors/src/adapters/activepieces/context-translator.ts` (line 65) | Exported `coerceParams()` function (was module-private). Enables direct unit testing. Resolves GAP-009 (export prerequisite).                                                                                                                                                                                 |
| `apps/workflow-engine/src/services/oauth-grant-resolver.ts`                     | New file (~120 lines). Extracted from `apps/workflow-engine/src/index.ts` into a standalone module with typed interfaces (`OAuthTokenModel`, `AuthProfileModel`, `OAuthTokenRecord`, `EncryptionService`). Implements the `OAuthGrantResolver` interface from `@agent-platform/connectors`. Resolves GAP-005. |
| `packages/connectors/src/auth/index.ts`                                         | Re-exports `OAuthGrantResolver` interface so the workflow engine can import it cleanly.                                                                                                                                                                                                                       |
| `packages/connectors/src/index.ts`                                              | Re-exports auth types including `OAuthGrantResolver`.                                                                                                                                                                                                                                                         |

**OAuth grant resolution flow** (as extracted):

1. `ConnectionResolver.resolveAuth()` detects an `oauth2_app` profile (has `clientId`/`clientSecret` but no `access_token`).
2. Delegates to `OAuthGrantResolver.resolveGrant()` which queries `EndUserOAuthToken` collection with `tenantId` filter.
3. Tries user-specific grant first (`userId`), then falls back to `__tenant__` shared grant.
4. If token is expired or within 5-minute buffer, proactively refreshes via HTTP POST to the OAuth provider's token URL.
5. Persists refreshed tokens (encrypted) via raw `collection.updateOne`.
6. Returns `{ access_token, refresh_token? }` to the caller.

**Exit criteria**: `connection-resolver.ts` has no `as any` casts. `coerceParams` is importable. `oauth-grant-resolver.ts` compiles and implements the `OAuthGrantResolver` interface. The workflow engine wires the extracted resolver at startup.

---

### Phase 5: Code Quality & Testing

**Goal**: Add tests, remove dead code, add error state handling.

| File                                                                                         | Change                                                                                                                                                                                                                                                                                                                |
| -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/connectors/src/__tests__/coerce-params.test.ts`                                    | New file. 12 pure-function test cases for `coerceParams()`: non-string passthrough, JSON arrays, JSON objects, numeric strings, boolean strings, plain strings, invalid JSON, empty strings, whitespace-padded JSON, Infinity string, mixed params, empty input. Resolves GAP-009.                                    |
| `apps/studio/e2e/workflows/workflow-integration-node.spec.ts`                                | New file (556 lines). 3 `test.describe` blocks with 7 test scenarios: (1) API: catalog, action schemas, connections -- 3 assertions. (2) UI: full happy path -- add node, select Gmail, verify connection picker, dynamic form, config persistence, change flow. (3) UI: empty state and modal navigation -- 2 tests. |
| `apps/studio/src/components/workflows/canvas/config/GenericNodeConfig.tsx`                   | Removed dead `IntegrationConfig` stub function that was orphaned when `IntegrationNodeConfig` was introduced. Resolves GAP-007.                                                                                                                                                                                       |
| `apps/studio/src/components/workflows/canvas/config/IntegrationNodeConfig.tsx` (lines 65-69) | Added `propsError` and `connectionsError` state variables with error rendering in the template (lines 328, 375). Previously, action props and connection fetch errors were silently swallowed. Partially resolves GAP-006.                                                                                            |

**Test coverage summary**:

| Category   | Count | Location                                        |
| ---------- | ----- | ----------------------------------------------- |
| Unit tests | 12    | `coerce-params.test.ts`                         |
| Unit tests | 1     | `activepieces-importer.test.ts` (ARRAY mapping) |
| E2E tests  | 7     | `workflow-integration-node.spec.ts`             |

**Exit criteria**: All 232 existing connector tests pass. 12 new coerceParams tests pass. E2E tests pass against running services (Studio, Runtime, Workflow Engine).

---

## 3. Key Design Decisions

1. **`params` is `Record<string, string>`, not `Record<string, { mode, value }>`**: All param values are plain strings. The expression resolver (`resolveExpressionTyped`) handles both static and `{{expression}}` strings uniformly. A separate `paramModes` record tracks UI toggle state for non-string fields only. This keeps the data shape flat and directly compatible with the existing `connector_action` executor -- no adapter layer needed in `canvas-to-steps.ts`.

2. **Static catalog for browsing, runtime registry for schemas**: The connector catalog (`connector-catalog.json`) is pre-generated at build time and served as static JSON from the Studio BFF. Action schemas with full `ConnectorProperty[]` props are fetched from the workflow engine at runtime, where the `ConnectorRegistry` lives. This avoids bloating the catalog with prop definitions (which can include runtime-only `refreshers` logic) while keeping browsing fast and engine-independent.

3. **Type-aware expression support instead of universal toggle**: String-like fields (`string`, `dynamic_dropdown`, `file`, `json`) accept `{{expression}}` inline with no toggle. Non-string fields (`number`, `boolean`, `dropdown`, `date`, `array`) have a `{...}` toggle because their native controls cannot accept expression text. This reduces friction for the common case (most action fields are strings).

4. **OAuth grant resolver extracted to standalone module**: The OAuth grant resolution logic (~140 lines dealing with `EndUserOAuthToken` lookup, token refresh, and encrypted persistence) was extracted from the monolithic `index.ts` into `apps/workflow-engine/src/services/oauth-grant-resolver.ts` with typed interfaces. This enables unit testing without starting the full engine and clarifies the dependency boundary (`OAuthGrantResolver` interface in `@agent-platform/connectors`).

5. **Client-side connection filtering**: Connections are fetched for the entire project via `GET /api/projects/:id/connections`, then filtered client-side by `connectorName === connectorId`. This reuses the existing connections API without requiring a new server-side filter parameter. Acceptable because project connection counts are small (tens, not thousands).

---

## 4. Remaining Work

### Open Gaps

| ID      | Description                                                                                                                                                                                              | Severity | Status                                                     |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ---------------------------------------------------------- |
| GAP-001 | Dynamic dropdown props (`refreshers`) not resolved at design time -- rendered as text inputs                                                                                                             | Medium   | Open -- planned follow-up feature                          |
| GAP-002 | File property type only supports URL references, not direct upload                                                                                                                                       | Low      | Open                                                       |
| GAP-003 | No connector icon/logo display (catalog has no icon URLs)                                                                                                                                                | Low      | Open                                                       |
| GAP-004 | Stale workflow configs if connector actions change (fields renamed/removed)                                                                                                                              | Medium   | Open -- runtime handles gracefully via expression resolver |
| GAP-010 | `DynamicActionForm` lacks loading/error boundary for individual field rendering failures                                                                                                                 | Low      | Open                                                       |
| GAP-011 | No retry on transient connector API failures (catalog, action schemas, connections)                                                                                                                      | Low      | Open                                                       |
| GAP-012 | Timeout units mismatch: `IntegrationNodeConfigSchema` stores seconds (5-300), `DEFAULT_STEP_TIMEOUT_MS` is milliseconds. `canvas-to-steps.ts` passes the raw value -- executor may interpret incorrectly | Medium   | Open -- verify executor expectation and align units        |

### Resolved Gaps (in this implementation)

| ID      | Resolution                                                                                    |
| ------- | --------------------------------------------------------------------------------------------- |
| GAP-005 | OAuth grant resolver extracted to `apps/workflow-engine/src/services/oauth-grant-resolver.ts` |
| GAP-006 | Error states added for `propsError` and `connectionsError` in `IntegrationNodeConfig.tsx`     |
| GAP-007 | Dead `IntegrationConfig` stub removed from `GenericNodeConfig.tsx`                            |
| GAP-008 | Unsafe `(connection as any).userId` cast fixed in `connection-resolver.ts`                    |
| GAP-009 | `coerceParams()` exported and covered by 12 unit tests in `coerce-params.test.ts`             |

---

## 5. Wiring Checklist

Verification that all layers connect end-to-end:

| Layer                        | Wiring Point                                                                                                       | Verified |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------ | -------- |
| Schema -> Node type switch   | `IntegrationNodeConfigSchema` registered at key `'integration'` in `NodeConfigSchemas` (workflow-schemas.ts:252)   | Yes      |
| Stub removal -> Palette      | `'integration'` removed from `STUB_NODE_TYPES` (workflow-types.ts:31), not in `HIDDEN_NODE_TYPES`                  | Yes      |
| GenericNodeConfig -> Config  | `case 'integration'` delegates to `IntegrationNodeConfig` (GenericNodeConfig.tsx:540)                              | Yes      |
| Studio BFF -> Engine proxy   | `[connectorName]/actions/route.ts` proxies to `GET /api/v1/connectors/:name/actions`                               | Yes      |
| Engine -> Registry           | `connectors.ts` route uses `ConnectorListingService.getConnector()` -> `connector.actions` with full props         | Yes      |
| Type mapper -> Array support | `mapPropertyType('ARRAY')` returns `'array'` (type-mapper.ts:172), `'array'` is in `ConnectorPropertyType` union   | Yes      |
| UI -> DynamicForm -> Array   | `DynamicActionForm` renders `ChipInput` for `type === 'array'` fields                                              | Yes      |
| Auth -> Grant resolver       | `ConnectionResolver` accepts optional `OAuthGrantResolver` via constructor DI (connection-resolver.ts:51)          | Yes      |
| Grant resolver -> Engine     | `oauth-grant-resolver.ts` implements `OAuthGrantResolver` interface, wired at engine startup                       | Yes      |
| coerceParams -> Execution    | `translateActionContext()` calls `coerceParams()` before passing to Activepieces piece `run()`                     | Yes      |
| Config -> Execution          | `params` stored as `Record<string, string>` in workflow doc, passed through `canvas-to-steps.ts` to executor       | Yes      |
| Expression context -> UI     | `IntegrationNodeConfig` computes `triggerPayload` + `previousSteps` from canvas graph, passes to `ExpressionInput` | Yes      |
