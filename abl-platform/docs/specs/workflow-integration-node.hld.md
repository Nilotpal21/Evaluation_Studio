# HLD: Workflow Integration Node

**Feature**: [Workflow Integration Node](../features/workflow-integration-node.md)
**Status**: ALPHA (as-built)
**Date**: 2026-04-11

---

## 1. Overview & Context

The Workflow Integration Node promotes the previously stubbed `integration` node type into a fully functional canvas node. It allows workflow builders to invoke third-party connector actions (Gmail Send Email, GitHub Create Issue, Slack Send Message, etc.) directly from the workflow canvas without writing raw HTTP requests.

The node bridges the Studio workflow canvas to the platform's `ConnectorRegistry` and Activepieces piece ecosystem. Users select an integration and action via a two-screen modal picker, choose a connection for authentication, and configure action inputs through a dynamically generated form. At execution time, the workflow engine resolves expressions, looks up credentials via `ConnectionResolver`, and delegates to the existing `ConnectorToolExecutor`.

---

## 2. Architecture Diagram

### Design-Time Flow (Studio UI)

```
Studio UI (React)
  |
  |  IntegrationNodeConfig
  |    |-- IntegrationPickerModal (connector + action selection)
  |    |-- Connection Picker (Select dropdown)
  |    |-- DynamicActionForm
  |         |-- ExpressionInput (string fields, inline {{expr}})
  |         |-- NativeControl + toggle (non-string fields)
  |
  v
Next.js API Routes (Studio BFF)
  |
  |  GET /api/projects/:id/connectors
  |    -> Static connector-catalog.json (pre-generated at build time)
  |
  |  GET /api/projects/:id/connectors/:connectorName/actions
  |    -> proxyToWorkflowEngine('/api/v1/connectors/:name/actions')
  |
  |  GET /api/projects/:id/connections
  |    -> Existing connections API (project-scoped)
  |
  v
Workflow Engine (Express)
  |
  |  GET /api/v1/connectors/:connectorName/actions
  |    -> ConnectorListingService -> ConnectorRegistry
  |         Returns action schemas with ConnectorProperty[] props
```

### Execution-Time Flow

```
Workflow Execution
  |
  v
canvas-to-steps.ts
  |  Maps integration node config -> connector_action step
  |
  v
connector-action-executor.ts
  |  1. resolveExpressionTyped() on each param value
  |  2. ConnectionResolver.resolve(connectorName, tenantId, projectId, connectionId)
  |  3. ConnectionResolver.resolveAuth(connection)
  |       |
  |       v
  |     AuthProfileResolver.resolve(authProfileId, tenantId, projectId)
  |       |
  |       v  (for OAuth2 app profiles without access_token)
  |     OAuthGrantResolver.resolveGrant(authProfileId, tenantId, userId?)
  |       |-- Lookup EndUserOAuthToken (user-scoped -> tenant-shared fallback)
  |       |-- Proactive refresh if expired (5-min buffer)
  |       |-- Persist refreshed tokens via raw collection.updateOne
  |       |-- Return { access_token, refresh_token? }
  |
  v
context-translator.ts
  |  translateActionContext(ctx)
  |    -> coerceParams(): JSON arrays/objects/numbers/booleans parsed from strings
  |    -> Wrap store, auth, server context into AP shape
  |
  v
Activepieces Piece Action.run(APActionContext)
  |  Third-party API call (Gmail, GitHub, Slack, etc.)
  |
  v
Step result -> steps.<nodeId>.output / steps.<nodeId>.error
```

---

## 3. Component Decomposition

### UI Components (apps/studio)

| Component                | File                                | Responsibility                                                                                                                                                                                                                                                 |
| ------------------------ | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `IntegrationNodeConfig`  | `config/IntegrationNodeConfig.tsx`  | Orchestrator: manages integration summary display, connection picker dropdown, and dynamic form. Fetches catalog, action props, and connections. Wired into `GenericNodeConfig.tsx` via `case 'integration'`.                                                  |
| `IntegrationPickerModal` | `config/IntegrationPickerModal.tsx` | Two-screen modal dialog. Screen 1: searchable tile grid of connectors with action count badges. Screen 2: searchable action list for selected connector. Closes on action selection.                                                                           |
| `DynamicActionForm`      | `config/DynamicActionForm.tsx`      | Renders form fields from `ConnectorProperty[]`. String-like fields use `ExpressionInput` (inline `{{expr}}`). Non-string fields render native controls (Toggle, Select, NumberInput, DateInput, ChipInput) with a `{...}` toggle to switch to expression mode. |
| `ExpressionInput`        | `config/ExpressionInput.tsx`        | Text input (single or multi-line) with `{...}` button to open `ContextExplorer` popover. Auto-opens explorer when user types `{{`. Inserts expression at cursor position.                                                                                      |

### API Routes

| Route                                                     | Location                                   | Behavior                                                                                                                                                           |
| --------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /api/projects/:id/connectors`                        | Studio: `connectors/route.ts`              | Serves pre-generated `connector-catalog.json` directly. Requires `WORKFLOW_READ` + `CONNECTION_READ`/`WRITE` permissions. Static JSON, no runtime registry needed. |
| `GET /api/projects/:id/connectors/:connectorName/actions` | Studio: `[connectorName]/actions/route.ts` | Proxies to workflow-engine via `proxyToWorkflowEngine`. Requires `WORKFLOW_READ` + `CONNECTION_READ`. Validates `connectorName` param.                             |
| `GET /api/v1/connectors/:connectorName/actions`           | Engine: `routes/connectors.ts`             | Returns action schemas with full `ConnectorProperty[]` props via `ConnectorListingService.getConnector()`. 404 if connector not found.                             |

### Engine Additions

| Component                     | Location                                                     | Purpose                                                                                                                                               |
| ----------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OAuthGrantResolver` (inline) | `workflow-engine/src/index.ts:429-566`                       | Resolves durable OAuth grants from `EndUserOAuthToken` collection. Proactively refreshes expired tokens. Wired into `ConnectionResolver` constructor. |
| `ConnectionResolver`          | `connectors/src/auth/connection-resolver.ts`                 | Resolves connections (user-scoped -> tenant-scoped fallback) and credentials. Delegates to `AuthProfileResolver` + optional `OAuthGrantResolver`.     |
| `coerceParams()`              | `connectors/src/adapters/activepieces/context-translator.ts` | Converts string-encoded JSON values back to native types for Activepieces pieces.                                                                     |

---

## 4. Data Flow

### 4a. Design-Time

1. **Catalog fetch**: `IntegrationNodeConfig` mounts -> fetches `GET /api/projects/:id/connectors` -> receives `CatalogConnector[]` (name, displayName, description, category, actions[{name, displayName, description}]). Stored in component state.

2. **Action schema fetch**: User selects connector + action in `IntegrationPickerModal` -> `IntegrationNodeConfig` fetches `GET /api/projects/:id/connectors/:connectorName/actions` -> receives `ActionWithProps[]` including `props: ConnectorProperty[]`. Stored in component state.

3. **Connection fetch**: When `connectorId` is set, fetches `GET /api/projects/:id/connections` -> filters client-side by `connectorName === connectorId`. Displayed in `Select` dropdown.

4. **Config save**: `onUpdate()` callback propagates to `useWorkflowCanvasStore` -> persisted as `IntegrationNodeConfigSchema` shape in workflow document.

### 4b. Execution-Time

1. **Canvas-to-steps**: `canvas-to-steps.ts` maps integration node to `connector_action` step. `params` passed as-is (plain `Record<string, string>`). `paramModes` is UI-only, not passed to executor.

2. **Expression resolution**: `resolveExpressionTyped()` replaces `{{trigger.payload.X}}` and `{{steps.Y.output.Z}}` with actual values from workflow context.

3. **Parameter coercion**: `coerceParams()` in `context-translator.ts` parses JSON-encoded arrays (`'["a","b"]'` -> `["a","b"]`), objects, booleans (`'true'` -> `true`), and numbers from string params.

4. **Connection resolution**: `ConnectionResolver.resolve()` finds the connection by `connectionId + tenantId + projectId`. Falls back from user-scoped to tenant-scoped if no `connectionId` provided.

5. **OAuth grant resolution**: `ConnectionResolver.resolveAuth()` delegates to `AuthProfileResolver`. For OAuth2 app profiles (has `clientId`/`clientSecret` but no `access_token`), the `OAuthGrantResolver` looks up `EndUserOAuthToken` records (user-specific -> `__tenant__` fallback), refreshes expired tokens with 5-minute buffer, and persists refreshed tokens via raw `collection.updateOne`.

6. **Connector action execution**: `ConnectorToolExecutor` calls the Activepieces piece action's `run()` with the translated `APActionContext`.

---

## 5. Data Model

### IntegrationNodeConfigSchema (Zod)

```typescript
// packages/shared/src/types/workflow-schemas.ts
export const IntegrationNodeConfigSchema = z.object({
  connectorId: z.string().min(1).optional(), // connector name (e.g., 'gmail')
  actionName: z.string().min(1).optional(), // action name (e.g., 'send_email')
  connectionId: z.string().min(1).optional(), // selected connection ID
  params: z.record(z.string(), z.string()).default({}), // field values, may contain {{expressions}}
  paramModes: z.record(z.string(), z.enum(['static', 'expression'])).default({}), // UI toggle state for non-string fields
  timeout: z.number().int().min(5).max(300).default(60), // seconds
});
```

**No new database collections.** The node config is stored as part of the workflow document's `nodes[].config` field (`Schema.Types.Mixed`).

### Key Design Decisions

- **`params` is `Record<string, string>`**: All values are plain strings, whether static or containing `{{expressions}}`. This keeps the shape flat and directly compatible with the existing `connector_action` executor.
- **`paramModes` is UI-only metadata**: Tracks which non-string fields are toggled to expression mode so the form renders correctly when re-opened. Not passed to the executor.
- **`connectorId`, `actionName`, `connectionId` are optional**: Allows saving partially configured nodes (e.g., integration selected but no connection yet).

---

## 6. API Contracts

### GET /api/projects/:projectId/connectors

Returns the static connector catalog.

**Auth**: Project-scoped. Requires `WORKFLOW_READ` + `CONNECTION_READ` or `CONNECTION_WRITE`.

**Response**:

```json
{
  "success": true,
  "data": [
    {
      "name": "gmail",
      "displayName": "Gmail",
      "description": "...",
      "category": "communication",
      "actions": [{ "name": "send_email", "displayName": "Send Email", "description": "..." }]
    }
  ]
}
```

### GET /api/projects/:projectId/connectors/:connectorName/actions

Returns action schemas with full `ConnectorProperty[]` props for a connector. Proxied to workflow-engine.

**Auth**: Project-scoped. Requires `WORKFLOW_READ` + `CONNECTION_READ`.

**Response**:

```json
{
  "success": true,
  "data": [
    {
      "name": "send_email",
      "displayName": "Send Email",
      "description": "Send an email through Gmail",
      "props": [
        { "name": "receiver", "displayName": "Receiver Email", "type": "string", "required": true },
        { "name": "cc", "displayName": "CC", "type": "array", "required": false }
      ]
    }
  ]
}
```

**Error (404)**:

```json
{
  "success": false,
  "error": { "code": "CONNECTOR_NOT_FOUND", "message": "Connector not found: unknown" }
}
```

### GET /api/v1/connectors/:connectorName/actions (Workflow Engine)

Internal engine endpoint. Same response shape as above. Accessed by the Studio proxy route.

---

## 7. Security & Isolation

### Tenant Isolation

- All `ConnectionResolver.resolve()` queries include `tenantId` in the filter. No `findById` usage.
- `OAuthGrantResolver.resolveGrant()` queries `EndUserOAuthToken` with `tenantId` filter.
- Studio API routes use `withRouteHandler({ requireProject: true })` which enforces tenant context.

### Project Isolation

- Connection lookups include `projectId` in the filter.
- Auth profile resolution includes `projectId`.
- Studio routes are scoped under `/api/projects/:id/`.

### User Isolation

- `ConnectionResolver` tries user-scoped connections first (filtered by `userId`), then falls back to tenant-scoped.
- OAuth grant resolution checks user-specific grants before `__tenant__` shared grants.

### Credential Security

- Credentials are **never** sent to the UI. The config stores only `connectionId`. All credential resolution happens server-side at execution time.
- Auth profile secrets are stored encrypted (`encryptedSecrets`). OAuth grant tokens are stored encrypted (`encryptedAccessToken`, `encryptedRefreshToken`).
- Token refresh uses `encryptForTenantAuto` before persisting back to the store.
- Expression values in `params` are resolved server-side by `resolveExpressionTyped` -- no client-side credential injection possible.
- The action schema endpoint returns property definitions only, never credential or auth data.

---

## 8. Performance

- **Catalog**: Static pre-generated JSON (`connector-catalog.json`) served directly from the Studio API. No runtime registry lookup needed for browsing.
- **Action schemas**: O(1) registry lookup via `ConnectorListingService.getConnector()`. The registry is loaded once at engine startup.
- **Connections**: Fetched once when config panel mounts, cached in React component state. Client-side filtered by `connectorName`.
- **Action props**: Fetched when `connectorId + actionName` change, cached in component state per selection.
- **OAuth grant resolution**: Single MongoDB query per execution. Token refresh adds one HTTP round-trip to the OAuth provider (only when token is within 5 minutes of expiry).

No pagination concerns: connector catalogs are typically small (tens of connectors, not thousands).

---

## 9. Reliability & Error Handling

### Design-Time Errors

- **Catalog fetch failure**: Error state displayed in `IntegrationNodeConfig` via `catalogError` state. User sees "Failed to load integrations" message.
- **Action props fetch failure**: Silently falls back to empty props array. **GAP-006**: No error state shown to the user -- should be added before BETA.
- **Connection fetch failure**: Silently falls back to empty connections. **GAP-006**: Same concern.

### Execution-Time Errors

- **Connection not found**: `ConnectionResolver.resolve()` throws `"Connection not found"` or `"No connection configured for this connector"`. Routed to `on_failure` handle.
- **Connector not found**: Engine returns 404; executor propagates error to step result.
- **OAuth token refresh failure**: `refreshGrantToken()` throws with HTTP status. Error propagates through `resolveAuth()` to the executor.
- **Provider API errors**: Activepieces piece `run()` throws. Caught by `ConnectorToolExecutor`, captured in execution trace.
- **Timeout**: Enforced by existing `ConnectorToolExecutor` timeout mechanism.

### Verified in Code

- `ConnectionResolver.resolve()` throws descriptive errors (line 71, 99 of `connection-resolver.ts`).
- `refreshGrantToken()` validates response (`res.ok`, `access_token` presence) at lines 469-475 of `index.ts`.
- `coerceParams()` has a try-catch around JSON.parse -- invalid JSON keeps the value as a string (line 83 of `context-translator.ts`).

---

## 10. Observability

- **Execution tracing**: The existing `ConnectorToolExecutor.execute()` emits OpenTelemetry spans covering connector action execution, including duration, success/failure, and error details.
- **Step results**: Captured in workflow execution traces as `steps.<nodeId>.output` (success) or `steps.<nodeId>.error` (failure).
- **No additional trace events added**: The existing connector executor instrumentation covers the execution path. The feature spec confirms no new observability was needed.
- **Token refresh**: Not currently instrumented with dedicated spans. The OAuth grant resolver in `index.ts` does not emit trace events for refresh operations. This is acceptable for ALPHA but may warrant spans at BETA if refresh failures need debugging.

---

## 11. Alternatives Considered

### Static Catalog with Full Props vs. Runtime Registry Lookup

**Considered**: Enrich the static `connector-catalog.json` with full `ConnectorProperty[]` at build time to avoid the proxy-to-engine round-trip for action schemas.

**Rejected**: Props can contain runtime-only logic (e.g., `dynamic_dropdown` refreshers). The catalog is designed to be lightweight (name + description + action count). The runtime registry is the source of truth for full action schemas.

**Implemented**: Static catalog for browsing (fast, no engine dependency), separate endpoint for action schemas (proxied to engine where registry lives).

### Inline OAuth Grant Resolver vs. Extracted Module

**Considered**: Extract the OAuth grant resolver (~140 lines in `index.ts`) into a dedicated module in `packages/connectors/src/auth/`.

**Decision**: Implemented inline for speed in ALPHA. Extraction to a dedicated module is planned before BETA for testability and separation of concerns (**GAP-005**).

### `{ mode, value }` Params vs. Plain Strings

**Considered**: Store each param as `{ mode: 'static' | 'expression', value: string }` to explicitly track whether a value contains expressions.

**Rejected**: The expression resolver (`resolveExpressionTyped`) already handles both static strings and embedded expressions uniformly. A `{ mode, value }` shape would require flattening in canvas-to-steps and add unnecessary complexity.

**Implemented**: `params: Record<string, string>` with a separate `paramModes` record that only tracks UI toggle state for non-string fields. String fields always accept expressions inline.

### Universal Toggle vs. Type-Aware Expression Support

**Considered**: A single static/dynamic toggle for all field types.

**Implemented**: Type-aware approach. String-like fields (`string`, `dynamic_dropdown`, `file`, `json`) accept `{{expressions}}` inline with no toggle. Non-string fields (`number`, `boolean`, `dropdown`, `date`, `array`) have a `{...}` toggle because their native controls cannot accept expression text. This reduces friction for the common case (most fields are strings).

---

## 12. Open Issues & Risks

| ID       | Description                                                                                                                                                                                                         | Severity | Notes                                                                        |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------- |
| GAP-005  | OAuth grant resolver is inline in `index.ts` (~140 lines). Should be extracted to a dedicated module for testability.                                                                                               | High     | Recommended before BETA. Currently untestable in isolation.                  |
| GAP-006  | Action props and connection fetch errors are silently swallowed in `IntegrationNodeConfig.tsx` (`.catch(() => { ... })` sets empty state but shows no error). Only catalog fetch has error state.                   | Medium   | Verified in code: lines 149, 179 catch with no error message.                |
| GAP-008  | `(connection as any).userId` cast in `connection-resolver.ts:133`. The `IConnectorConnection` interface should include a `userId` field.                                                                            | Low      | Type safety gap.                                                             |
| GAP-009  | No unit tests for `coerceParams()` pure function in `context-translator.ts`. High-value test target (pure function, multiple edge cases).                                                                           | Medium   | Easy to add.                                                                 |
| GAP-010  | Catalog route imports from `packages/connectors/src/generated/connector-catalog.json` (source path) rather than package exports. Fragile in production builds.                                                      | Low      | Works but bypasses package boundary.                                         |
| GAP-011  | No timeout/AbortController on catalog and connection fetch calls in `IntegrationNodeConfig.tsx`.                                                                                                                    | Low      | Relies on browser default timeouts.                                          |
| GAP-012  | Timeout units mismatch: `IntegrationNodeConfigSchema` stores seconds (5-300), `DEFAULT_STEP_TIMEOUT_MS` is milliseconds. `canvas-to-steps.ts` passes raw value -- executor may interpret incorrectly.               | Medium   | Needs verification of executor expectation.                                  |
| RISK-001 | `connector-catalog.json` freshness: catalog is generated at build time. If connectors are added/updated at runtime (hot-loaded), the catalog becomes stale until the next build.                                    | Low      | Acceptable for ALPHA; catalog changes rarely.                                |
| RISK-002 | `coerceParams()` aggressively parses numeric strings. A param value like `"123"` intended as a string will be coerced to number `123`. This could cause unexpected behavior for connectors expecting string inputs. | Medium   | Mitigated by: most string fields stay as strings unless they look like JSON. |
