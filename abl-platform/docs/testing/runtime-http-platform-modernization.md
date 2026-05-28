# Runtime HTTP Platform Modernization — Regression Test Manifest

**Date:** 2026-03-30  
**Status:** In Progress  
**Purpose:** list the regression-heavy tests we expect to add and keep updating as slices land.

---

## Slice 1: Regression Foundation + OpenAPI Helper Async Wrapper

### Landed or Landing in This Slice

| File                                                          | Coverage Goal                                                                    |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `tools/agents/e2e-smoke/__tests__/manifest-generator.test.ts` | Lock critical runtime route discovery and a realistic runtime route-count floor. |
| `apps/runtime/src/__tests__/openapi-router-helper.test.ts`    | Verify OpenAPI helper registration behavior and opt-in async error forwarding.   |

### Required Cases

1. Critical runtime routes remain present with expected auth, methods, and source files.
2. Runtime manifest still covers the broad route surface after route-helper changes.
3. `createOpenAPIRouter` keeps default registration behavior intact.
4. `createOpenAPIRouter` forwards rejected async handlers into Express error middleware when `wrapAsyncHandlers` is enabled.
5. Route-specific tags still override default router tags.

---

## Slice 2: Shared Error Middleware

### Landed or Landing in This Slice

| File                                                             | Coverage Goal                                                                                                             |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared/src/__tests__/middleware/error-handler.test.ts` | Verify shared normalization, serializer overrides, and logging hooks for centralized Express error handling.              |
| `apps/runtime/src/__tests__/shared-error-middleware.test.ts`     | Verify `AppError`, `ValidationError`, `ZodError`, and unknown errors map correctly without changing the runtime envelope. |

### Required Cases

1. `AppError` maps to expected status and runtime envelope.
2. Validation failures map to stable client-error responses.
3. Unknown errors stay 500 and do not leak internals.
4. Existing runtime response shape remains unchanged for non-migrated routes.
5. Shared error logging receives normalized metadata without changing response behavior.

---

## Slice 3: OpenAPI Validation Plumbing

### Landed or Landing in This Slice

| File                                                           | Coverage Goal                                                                                              |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `apps/runtime/src/__tests__/openapi-validation-helper.test.ts` | Verify opt-in parsing for `params`, `query`, and `body`, and prove that non-opted-in routes are unchanged. |

### Required Cases

1. Valid `params`/`query`/`body` reach handlers through the shared validated payload.
2. Invalid request payloads fail before handler logic runs.
3. Validation failures flow through centralized error handling.
4. Non-opted-in routes still behave exactly as before.
5. Existing `res.locals.openapi` state is preserved when validated payloads are attached.

---

## Slice 4: Pilot Route Contracts

### Landed or Landing in This Slice

| File                                                                         | Coverage Goal                                                                            |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `apps/runtime/src/__tests__/routes/projects.openapi-contract.test.ts`        | Preserve the pilot route contract during helper adoption.                                |
| `apps/runtime/src/__tests__/routes/auth.openapi-contract.test.ts`            | Preserve auth/dev-login behavior during helper adoption.                                 |
| `apps/runtime/src/__tests__/routes/nl-analytics.openapi-contract.test.ts`    | Preserve NL analytics request validation and SQL error contracts during helper adoption. |
| `apps/runtime/src/__tests__/routes/agents.openapi-contract.test.ts`          | Preserve status codes and envelopes for the pilot agent routes.                          |
| `apps/runtime/src/__tests__/routes/evaluation-tags.openapi-contract.test.ts` | Preserve evaluation-tag validation messages and write envelopes during helper adoption.  |
| `apps/runtime/src/__tests__/routes/sdk.openapi-contract.test.ts`             | Preserve SDK response contracts on migrated routes.                                      |

### Required Cases

1. Status-code parity before and after helper adoption.
2. Response-envelope parity before and after helper adoption.
3. Existing auth and isolation behavior preserved.
4. Validation errors standardized where helper validation now owns the boundary.

---

## Slice 5: Wave 1 Manual-Router Contracts

### Landed or Landing in This Slice

| File                                                                                 | Coverage Goal                                                                                                                                            |
| ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/runtime/src/__tests__/routes/tenant-usage.openapi-contract.test.ts`            | Preserve tenant-usage query validation, permission, and ClickHouse failure envelopes during helper adoption.                                             |
| `apps/runtime/src/__tests__/routes/validate.openapi-contract.test.ts`                | Preserve preflight validation success/failure paths while adding helper-owned body validation.                                                           |
| `apps/runtime/src/__tests__/routes/diagnostics-route.test.ts`                        | Preserve diagnostics agent/session envelopes, depth fallback behavior, and concealment responses during router migration.                                |
| `apps/runtime/src/__tests__/channels/email/feedback-endpoint.test.ts`                | Preserve public feedback HTML responses and token-before-rating validation order during router migration.                                                |
| `apps/runtime/src/__tests__/routes/platform-admin-usage.openapi-contract.test.ts`    | Preserve platform-admin usage summary envelopes, date/grouping filters, malformed-query handling, and middleware short-circuits during router migration. |
| `apps/runtime/src/__tests__/routes/voice-analytics.openapi-contract.test.ts`         | Preserve hourly/summary voice analytics envelopes, hours parsing, malformed-query handling, and ClickHouse failure behavior during router migration.     |
| `apps/runtime/src/__tests__/routes/agent-transfer-settings.openapi-contract.test.ts` | Preserve agent-transfer settings header, tenant, invalid-body, and persistence envelopes during router migration.                                        |
| `apps/runtime/src/__tests__/tools-deployment/attachment-config.e2e.test.ts`          | Preserve attachment-config resolver, permission, isolation, and attachment-blocking behavior during router migration.                                    |
| `apps/runtime/src/__tests__/tools-deployment/attachment-config-validation.test.ts`   | Preserve attachment-config validation envelope and upsert semantics while helper validation becomes authoritative.                                       |
| `apps/runtime/src/__tests__/tools-deployment/attachment-pii.e2e.test.ts`             | Preserve downstream attachment redaction behavior when config lookup flows through the migrated route.                                                   |
| `apps/runtime/src/__tests__/routes/memory-api.openapi-contract.test.ts`              | Preserve sandbox JWT, session lookup, tenant mismatch, and memory action envelopes during router migration.                                              |

### Required Cases

1. Success responses preserve the current usage summary envelope.
2. Malformed query shapes return the `Invalid query parameters` 400 envelope before aggregation runs.
3. Permission middleware still short-circuits before store initialization.
4. ClickHouse initialization failures remain 503.
5. Query execution failures remain 500.
6. Route-manifest regression is rerun after the first Wave 1 conversion.
7. Project validation routes keep default “discover all agents” behavior when no body is supplied.
8. Voice analytics hourly and summary routes preserve hours parsing and their existing success envelopes.
9. Voice analytics malformed query shapes fail before ClickHouse work begins.

---

## Slice 6+: Wave-Based Regression Expectations

Every subsequent route-conversion slice must add:

1. At least one route-contract test file per wave.
2. At least one negative-path validation test per converted route family.
3. Explicit auth/isolation assertions for project-scoped or tenant-scoped routes.
4. Route-manifest verification after each wave.

---

## Ongoing Checklist

- [x] Slice 1 test manifest created.
- [x] Slice 1 landed tests are implemented and passing.
- [x] Slice 2 test cases are implemented before runtime error middleware becomes authoritative.
- [x] Slice 3 helper validation tests are implemented and passing before pilot route migration starts.
- [x] Slice 4 SDK contract suite landed before the first pilot route migration.
- [x] Slice 4 projects contract suite landed before the `projects.ts` pilot migration.
- [x] Slice 4 auth contract suite landed before the `auth.ts` migration decision.
- [x] `auth.ts` now uses helper-backed request validation while preserving its existing validation envelope.
- [x] Slice 4 NL analytics contract suite landed before the `nl-analytics.ts` migration.
- [x] Slice 4 agents contract suite landed before the `agents.ts` pilot migration.
- [x] Slice 4 evaluation-tags contract suite landed before the `evaluation-tags.ts` pilot migration.
- [x] Pilot route contract suites exist before route conversion starts.
- [x] Slice 5 tenant-usage contract suite landed before the first manual-router conversion.
- [x] `tenant-usage.ts` now uses helper-backed query validation while preserving its existing envelopes.
- [x] Slice 5 validate contract suite landed before the `validate.ts` conversion.
- [x] `validate.ts` now uses helper-backed body validation while preserving its success and failure envelopes.
- [x] Slice 5 diagnostics regression suite was tightened before the `diagnostics.ts` conversion.
- [x] `diagnostics.ts` now uses helper-backed param parsing while preserving depth fallback and concealment envelopes.
- [x] Slice 5 feedback endpoint regression suite was tightened before the `feedback.ts` conversion.
- [x] `feedback.ts` now uses OpenAPI registration while preserving public HTML responses and invalid-token precedence over rating validation.
- [x] Slice 5 platform-admin-usage contract suite landed before the `platform-admin-usage.ts` conversion.
- [x] `platform-admin-usage.ts` now uses helper-backed query validation and async wrapping while preserving usage-summary, malformed-query, permission, and aggregation-failure envelopes.
- [x] Slice 5 voice-analytics contract suite landed before the `voice-analytics.ts` conversion.
- [x] `voice-analytics.ts` now uses helper-backed params/query validation while preserving hourly/summary success envelopes, malformed-query handling, and ClickHouse availability/failure responses.
- [x] Slice 5 agent-transfer-settings contract suite landed before the `agent-transfer-settings.ts` conversion.
- [x] `agent-transfer-settings.ts` now uses OpenAPI registration plus Zod-backed body parsing while preserving header, tenant, and invalid-body envelopes.
- [x] Slice 5 attachment-config E2E and validation suites were rerun before the `attachment-config.ts` conversion.
- [x] `attachment-config.ts` now uses helper-backed params/body validation while preserving `VALIDATION_ERROR` envelopes, resolver fallbacks, and downstream attachment behavior.
- [x] Slice 5 memory-api contract suite landed before the `memory-api.ts` conversion.
- [x] `memory-api.ts` now uses helper-backed body validation while preserving sandbox JWT, session concealment, and action-specific response envelopes.
- [x] Route-manifest regression reran after the first Slice 5 conversion.
- [x] Route-manifest regression reran after the final Slice 5 Wave 1 conversion.
- [ ] Every later slice updates this manifest with landed coverage.
