# Workflow Integration Node — Troubleshooting Checklist & Error Handling Spec

**Feature**: Workflow Integration Node (connector_action step type)
**Date**: 2026-04-10
**Status**: ALPHA

---

## Part 1: Troubleshooting Checklist

Use this checklist when a workflow integration node execution fails. Errors surface as `STEP_FAILED` with an inner message — work through the categories below to diagnose.

### 1. Connection & Auth Profile Setup

- [ ] **Connection exists and is active**: The integration node's `connectionId` must reference an active `ConnectorConnection` record. An empty or stale connectionId produces `invalid_request` or `No connection configured for this connector`.
- [ ] **Auth profile linked**: The connection's `authProfileId` points to a valid `AuthProfile` with `status: 'active'`.
- [ ] **Auth profile type is `oauth2_app`**: For OAuth connectors (Gmail, Slack, etc.), the linked auth profile must be type `oauth2_app` with `encryptedSecrets` containing `clientId` and `clientSecret`.
- [ ] **Auth profile scopes configured**: The auth profile's `config.defaultScopes` must include the scopes required by the connector action (e.g., `gmail.send` for Gmail send_email).

### 2. OAuth Grant (EndUserOAuthToken)

- [ ] **Grant exists**: An `EndUserOAuthToken` record must exist with `provider: 'auth-profile:<authProfileId>'` and matching `tenantId`. If missing, the user hasn't completed the OAuth consent flow.
- [ ] **Grant not revoked**: `revokedAt` must be `null`.
- [ ] **Grant has correct scopes**: The `scope` field must include the scopes required by the action. Google silently drops scopes not registered on the OAuth consent screen — check Google Cloud Console.
- [ ] **Grant token not expired**: If `expiresAt` is in the past and no refresh token exists, the user must re-authorize.
- [ ] **Refresh token present**: `encryptedRefreshToken` must be non-null for token refresh to work. Google only issues refresh tokens when `access_type=offline` and `prompt=consent` are set.
- [ ] **Grant userId matches**: For tenant-scoped connections, `userId` should be `__tenant__`. For user-scoped, it should match the executing user's ID.

### 3. Google Cloud Console (for Google connectors)

- [ ] **API enabled**: The specific Google API (Gmail API, Sheets API, etc.) must be enabled in the Google Cloud project.
- [ ] **OAuth consent screen scopes**: The required scopes must be added to the OAuth consent screen's scope list. Google drops scopes not registered there.
- [ ] **Consent screen publish status**: If "Testing", the executing user's email must be in the test users list (max 100 lifetime).
- [ ] **HTTPS restriction**: Adding scopes to the consent screen is blocked if OAuth client has non-HTTPS redirect URIs. Temporarily switch to HTTPS, add scopes, switch back.
- [ ] **Consent form scope selection**: When the consent popup appears, the user must actually check/select the requested permission scopes. Missing selections result in partial scope grants.

### 4. Token Refresh

- [ ] **Token refresh works**: Expired tokens should auto-refresh via `refreshGrantToken()` in the workflow engine. Check for `Token refresh failed with status <N>` errors.
- [ ] **App credentials accessible**: Token refresh requires decrypting the auth profile's `encryptedSecrets` to get `clientId`/`clientSecret`. Decryption failures produce `OAuth app profile missing clientId, clientSecret, or tokenUrl`.
- [ ] **Token URL correct**: The auth profile's `config.tokenUrl` must be set (e.g., `https://oauth2.googleapis.com/token` for Google).
- [ ] **Refresh token not rotated**: Some providers rotate refresh tokens. After refresh, the new refresh token is persisted. If persistence fails, subsequent refreshes break.

### 5. Parameter Formatting

- [ ] **Array parameters**: ChipInput stores arrays as JSON strings (e.g., `'["a@gmail.com"]'`). The `coerceParams()` function in context-translator.ts parses these. If a piece calls `.filter()` on a string, you get `_b.filter is not a function`.
- [ ] **Dropdown values**: Some AP pieces expect specific string values for dropdowns (e.g., `body_type: "plain_text"`). Check the piece's property definition for valid values.
- [ ] **Required fields**: Missing required fields may produce cryptic errors from the AP piece. Check the connector action's property schema.

### 6. Connector Infrastructure

- [ ] **Connectors package built**: Changes to `packages/connectors/src/` require `pnpm build --filter=@agent-platform/connectors` — the package exports from `./dist/`, not source.
- [ ] **Workflow engine restarted**: After rebuilding connectors, touch `apps/workflow-engine/src/index.ts` to trigger tsx watch reload.
- [ ] **Timeout**: Default connector action timeout may be too short for slow APIs. Check for `Connector action "<tool>" timed out after <N>ms`.

### 7. Encryption & Mongoose

- [ ] **Encryption facade**: The workflow engine uses `decryptForTenantAuto()` with `.lean()` queries (bypasses Mongoose encryption plugin). Do NOT use `Model.findOne()` without `.lean()` expecting auto-decrypt — WE doesn't call `setEncryptionFacade()`.
- [ ] **Mongoose plugin blocks updateOne**: The encryption plugin rejects `updateOne`/`findOneAndUpdate` on encrypted fields. Use `Model.collection.updateOne()` (raw MongoDB driver) with manual encryption via `encryptForTenantAuto()`.

---

## Part 2: Error Handling Spec — Integration Node Error Codes

### Current Problem

Integration node failures surface as generic `STEP_FAILED` with the raw error message from the connector/provider. Examples:

- `"invalid_request"` — could mean expired token, missing credentials, wrong grant type, or provider rejection
- `"Insufficient Permission"` — could mean wrong scopes, API disabled, or account restriction
- `"_b.filter is not a function"` — internal JS error leaking to the user

### Goal

Map every failure point in the integration node execution pipeline to a specific error code with an actionable message. The user should understand what went wrong and how to fix it from the error alone.

### Error Code Taxonomy

All integration node errors use the prefix `INTEGRATION_` to distinguish from other workflow step errors.

#### Connection Resolution Errors

| Error Code                                | HTTP-like Status | Message Template                                                                                     | Trigger Condition                                                  |
| ----------------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `INTEGRATION_CONNECTION_NOT_FOUND`        | 404              | `Connection "{connectionId}" not found or inactive for this project`                                 | connectionId provided but no matching active connection in project |
| `INTEGRATION_CONNECTION_MISSING`          | 400              | `No connection configured for connector "{connectorName}". Create a connection in project settings.` | No connectionId on node AND no auto-resolved connection            |
| `INTEGRATION_CONNECTION_EMPTY_ID`         | 400              | `Integration node "{nodeName}" has no connection selected. Edit the node and select a connection.`   | connectionId is empty string                                       |
| `INTEGRATION_AUTH_PROFILE_NOT_FOUND`      | 404              | `Auth profile for connection "{connectionId}" not found or inactive`                                 | connection.authProfileId points to missing/inactive profile        |
| `INTEGRATION_AUTH_PROFILE_DECRYPT_FAILED` | 500              | `Failed to decrypt auth profile credentials. The encryption key may have changed.`                   | decryptForTenantAuto fails on encryptedSecrets                     |

#### OAuth Grant Errors

| Error Code                               | HTTP-like Status | Message Template                                                                                              | Trigger Condition                          |
| ---------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `INTEGRATION_OAUTH_GRANT_MISSING`        | 401              | `No OAuth authorization found for connector "{connectorName}". Authorize the connection in project settings.` | No EndUserOAuthToken for the auth profile  |
| `INTEGRATION_OAUTH_GRANT_REVOKED`        | 401              | `OAuth authorization has been revoked. Re-authorize the connection in project settings.`                      | grant.revokedAt is set                     |
| `INTEGRATION_OAUTH_TOKEN_EXPIRED`        | 401              | `OAuth token expired and no refresh token available. Re-authorize the connection.`                            | token expired AND no encryptedRefreshToken |
| `INTEGRATION_OAUTH_GRANT_DECRYPT_FAILED` | 500              | `Failed to decrypt OAuth tokens. The encryption key may have changed.`                                        | decryptForTenantAuto fails on grant tokens |

#### Token Refresh Errors

| Error Code                                          | HTTP-like Status | Message Template                                                                                   | Trigger Condition                              |
| --------------------------------------------------- | ---------------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `INTEGRATION_TOKEN_REFRESH_FAILED`                  | 502              | `Token refresh failed: {providerError}. Re-authorize the connection.`                              | Token endpoint returns non-200                 |
| `INTEGRATION_TOKEN_REFRESH_INVALID_RESPONSE`        | 502              | `Token refresh response missing access_token. The refresh token may be revoked.`                   | Token endpoint returns 200 but no access_token |
| `INTEGRATION_TOKEN_REFRESH_APP_PROFILE_MISSING`     | 500              | `OAuth app profile not found for token refresh. The auth profile may have been deleted.`           | App profile lookup fails during refresh        |
| `INTEGRATION_TOKEN_REFRESH_APP_CREDENTIALS_MISSING` | 500              | `OAuth app profile missing clientId, clientSecret, or tokenUrl. Check auth profile configuration.` | Decrypted app profile missing required fields  |

#### Provider API Errors

| Error Code                              | HTTP-like Status | Message Template                                                                                  | Trigger Condition         |
| --------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------- | ------------------------- |
| `INTEGRATION_PROVIDER_AUTH_ERROR`       | 401              | `Provider rejected credentials: {providerError}. The token may be expired or revoked.`            | Provider returns 401      |
| `INTEGRATION_PROVIDER_PERMISSION_ERROR` | 403              | `Insufficient permissions for "{connectorName}.{actionName}". Check OAuth scopes and API access.` | Provider returns 403      |
| `INTEGRATION_PROVIDER_NOT_FOUND`        | 404              | `Resource not found on "{connectorName}": {providerError}`                                        | Provider returns 404      |
| `INTEGRATION_PROVIDER_RATE_LIMIT`       | 429              | `Rate limited by "{connectorName}". Retry after {retryAfter} seconds.`                            | Provider returns 429      |
| `INTEGRATION_PROVIDER_SERVER_ERROR`     | 502              | `"{connectorName}" service error: {providerError}`                                                | Provider returns 5xx      |
| `INTEGRATION_PROVIDER_TIMEOUT`          | 504              | `"{connectorName}.{actionName}" timed out after {timeoutMs}ms`                                    | Execution exceeds timeout |
| `INTEGRATION_PROVIDER_UNKNOWN_ERROR`    | 502              | `"{connectorName}.{actionName}" failed: {errorMessage}`                                           | Any other provider error  |

#### Parameter & Execution Errors

| Error Code                      | HTTP-like Status | Message Template                                                                      | Trigger Condition                      |
| ------------------------------- | ---------------- | ------------------------------------------------------------------------------------- | -------------------------------------- |
| `INTEGRATION_INVALID_TOOL_NAME` | 400              | `Invalid integration action "{toolName}": expected format "connector.action"`         | toolName missing dot separator         |
| `INTEGRATION_ACTION_NOT_FOUND`  | 404              | `Action "{actionName}" not found on connector "{connectorName}"`                      | Registry lookup fails                  |
| `INTEGRATION_PARAM_TYPE_ERROR`  | 400              | `Parameter "{paramName}" has invalid type: expected {expectedType}, got {actualType}` | Type coercion/validation fails         |
| `INTEGRATION_PARAM_PARSE_ERROR` | 400              | `Failed to parse parameter "{paramName}": {parseError}`                               | JSON.parse fails on a string parameter |
| `INTEGRATION_EXECUTION_ERROR`   | 500              | `Connector action execution failed: {errorMessage}`                                   | Unhandled error from action.run()      |

### Implementation Points

Each layer in the execution pipeline should catch errors and wrap them with the appropriate code:

1. **`connector-action-executor.ts`** — catches step-level errors, wraps with INTEGRATION\_ codes
2. **`ConnectorToolExecutor.execute()`** — catches connection/auth resolution errors
3. **`ConnectionResolver.resolve()`** — throws typed errors for connection lookup failures
4. **`ConnectionResolver.resolveAuth()`** — throws typed errors for auth profile/grant failures
5. **`oauthGrantResolver.resolveGrant()`** — throws typed errors for grant/refresh failures
6. **`context-translator.ts`** — catches parameter coercion errors

### Error Response Structure

Integration node errors should follow the existing step error format but with richer detail:

```typescript
interface IntegrationStepError {
  code: string; // e.g., "INTEGRATION_PROVIDER_PERMISSION_ERROR"
  message: string; // Human-readable, actionable message
  httpStatus: number | null; // Provider HTTP status if applicable
  providerError: string | null; // Raw provider error message
  responseBody: unknown | null; // Provider response body (truncated to 4KB)
  suggestion: string | null; // Actionable fix suggestion
}
```

### Example Error Transformations

| Raw Error                              | Current Output                                         | Proposed Output                                                                                                                                                                                                                 |
| -------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Google 401 `"invalid_request"`         | `STEP_FAILED: invalid_request`                         | `INTEGRATION_PROVIDER_AUTH_ERROR: Provider rejected credentials: invalid_request. The token may be expired or revoked. Suggestion: Re-authorize the connection in project settings.`                                            |
| Google 403 `"Insufficient Permission"` | `STEP_FAILED: Insufficient Permission`                 | `INTEGRATION_PROVIDER_PERMISSION_ERROR: Insufficient permissions for "gmail.send_email". Check OAuth scopes and API access. Suggestion: Verify Gmail API is enabled and the OAuth consent screen includes the required scopes.` |
| `_b.filter is not a function`          | `STEP_FAILED: _b.filter is not a function`             | `INTEGRATION_PARAM_TYPE_ERROR: Parameter "receiver" has invalid type: expected array, got string. Suggestion: This may be a platform bug — please report it.`                                                                   |
| Empty connectionId                     | `STEP_FAILED: invalid_request`                         | `INTEGRATION_CONNECTION_EMPTY_ID: Integration node "Integration0001" has no connection selected. Edit the node and select a connection.`                                                                                        |
| No grant exists                        | `STEP_FAILED: No access, refresh token...`             | `INTEGRATION_OAUTH_GRANT_MISSING: No OAuth authorization found for connector "gmail". Authorize the connection in project settings.`                                                                                            |
| Encryption plugin blocks update        | `STEP_FAILED: [encryption-plugin] Cannot updateOne...` | _(This was a code bug, now fixed — should never surface to user)_                                                                                                                                                               |
| Token refresh 400                      | `STEP_FAILED: Token refresh failed`                    | `INTEGRATION_TOKEN_REFRESH_FAILED: Token refresh failed: invalid_grant. Re-authorize the connection. Suggestion: The refresh token may have been revoked by the user or expired.`                                               |

### Priority

**P0 (immediate)**: Empty connectionId detection, missing grant detection, provider 401/403 classification
**P1 (next sprint)**: Token refresh error classification, parameter type errors
**P2 (backlog)**: Rate limit handling with retry-after, response body truncation, suggestion engine
