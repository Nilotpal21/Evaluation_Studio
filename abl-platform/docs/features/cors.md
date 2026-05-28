# Feature: CORS

**Doc Type**: MAJOR FEATURE
**Parent Feature**: N/A
**Status**: BETA
**Feature Area(s)**: `customer experience`, `integrations`, `governance`, `enterprise`
**Package(s)**: `packages/config`, `apps/runtime`, `apps/studio`
**Owner(s)**: `Platform team`
**Testing Guide**: [docs/testing/cors.md](../testing/cors.md)
**Last Updated**: 2026-03-21

---

## 1. Introduction / Overview

### Problem Statement

Browser-based clients need a predictable cross-origin policy for calling the Runtime API. Without a shared CORS feature, Studio, embedded SDK widgets, and browser-based OAuth or popup flows would fail unpredictably, while operators would have no central place to control which origins, methods, and headers are allowed.

### Goal Statement

The goal of this feature is to provide a single Runtime-wide cross-origin policy that can be configured centrally, validated for production safety, and applied consistently before feature-specific origin checks such as SDK key allowlists or OAuth redirect validation.

### Summary

CORS is the platform feature that controls which browser origins may call the Runtime HTTP API and which headers and methods are permitted on those cross-origin requests. The central configuration lives in `packages/config/src/schemas/cors.schema.ts`, and the Runtime applies it early in `apps/runtime/src/server.ts` via Express `cors` middleware.

This is a narrow but important infrastructure feature. It is separate from other origin checks that happen deeper in the stack, such as SDK public-key `allowedOrigins` enforcement and OAuth redirect allowlists. Those adjacent controls are complementary: global CORS answers "may this browser origin call the Runtime API at all?", while feature-specific allowlists answer "may this specific SDK key or OAuth flow accept this origin?"

The current implementation is strongest as a configuration feature and weakest as a directly tested runtime behavior. The schema, env mapping, and production validation are in place, but the global middleware path does not yet have a dedicated black-box test suite.

---

## 2. Scope

### Goals

- Centralize Runtime CORS policy in shared config and apply it consistently through global Express middleware.
- Validate production posture so wildcard or localhost-heavy origin settings are rejected or flagged before unsafe deployment.
- Support browser callers such as Studio, SDK widgets, and OAuth popup flows with a predictable allowlist of origins, methods, and headers.

### Non-Goals (Out of Scope)

- This feature does not provide a dedicated Studio or admin UI for editing global CORS settings.
- This feature does not replace feature-specific origin enforcement such as SDK-key `allowedOrigins` or OAuth redirect allowlists.
- This feature does not own WebSocket origin policy; those flows use separate custom logic.

---

## 3. User Stories

1. As a platform operator, I want one shared CORS configuration surface so that I can control browser access without editing individual routes.
2. As a Studio or SDK browser client, I want Runtime to return the expected cross-origin headers so that requests succeed consistently across environments.
3. As a security-conscious deployer, I want production guardrails on origin posture so that dangerous wildcard or localhost settings are caught before rollout.

---

## 4. Functional Requirements

1. **FR-1**: The system must expose a central CORS configuration schema covering origins, methods, credentials, allowed headers, and exposed headers.
2. **FR-2**: The system must apply Runtime-wide Express CORS middleware early in the HTTP request pipeline.
3. **FR-3**: The system must validate production CORS posture and reject wildcard origin settings in production.
4. **FR-4**: The system must include default allowed headers needed for SDK/bootstrap traffic.
5. **FR-5**: The system must allow adjacent features such as channel OAuth flows to reuse configured CORS origins as a fallback allowlist where appropriate.
6. **FR-6**: The system must support additional, stricter feature-specific origin checks on top of global CORS.

---

## 5. Feature Classification & Integration Matrix

### Lifecycle / Platform Impact

| Area                       | Impact Level | Notes                                                                                                     |
| -------------------------- | ------------ | --------------------------------------------------------------------------------------------------------- |
| Project lifecycle          | NONE         | The feature is deployment-config driven rather than project-lifecycle specific.                           |
| Agent lifecycle            | NONE         | CORS does not directly affect agent compilation or execution lifecycle.                                   |
| Customer experience        | SECONDARY    | Browser-based customers feel CORS failures immediately even though the feature is infrastructure-focused. |
| Integrations / channels    | PRIMARY      | SDK widgets and OAuth/browser popup flows depend on this policy to reach Runtime over HTTP.               |
| Observability / tracing    | SECONDARY    | Failures surface indirectly through browser errors, HTTP inspection, and adjacent feature logs.           |
| Governance / controls      | PRIMARY      | Production validation and centralized origin policy are governance controls on exposed browser surfaces.  |
| Enterprise / compliance    | SECONDARY    | Multi-origin production posture and public API exposure are enterprise deployment concerns.               |
| Admin / operator workflows | SECONDARY    | Operators manage the feature through env/config rather than a dedicated portal.                           |

### Related Feature Integration Matrix

| Related Feature             | Relationship Type | Why It Matters                                                                     | Key Touchpoints                                    | Current State                                                  |
| --------------------------- | ----------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------- | -------------------------------------------------------------- |
| [SDK](sdk.md)               | depends on        | SDK widgets need both global Runtime CORS and per-key `allowedOrigins`.            | `server.ts`, `sdk-auth.ts`, `/api/v1/sdk/*` routes | Layered enforcement is implemented today                       |
| [Channels](channels.md)     | depends on        | Browser-facing channel setup and channel OAuth flows rely on valid origin posture. | `channel-oauth.ts`, Runtime browser flows          | CORS origins are reused as a fallback allowlist in OAuth flows |
| [Connectors](connectors.md) | tested with       | Connector browser/OAuth setup can inherit origin validation requirements.          | channel OAuth and browser callback handling        | Related but not owned by the global CORS control plane         |

---

## 6. Design Considerations (Optional)

- There is no dedicated management UI; the feature is intentionally deployment-config driven.
- The feature is implemented as one global middleware layer plus stricter feature-specific allowlists where needed.
- Browser-facing flows should be documented carefully because a request can pass global CORS and still fail on downstream SDK or OAuth origin checks.

---

## 7. Technical Considerations (Optional)

- Runtime currently uses `config.server.frontendUrl` as the `origin` setting in production middleware rather than the full `config.cors.origins` array.
- `exposedHeaders` exist in the config schema but are not currently mapped from `CORS_*` env vars through `env-mapping.ts`.
- WebSocket and feature-specific origin validation are deliberately separate from the HTTP CORS middleware path.

---

## 8. How to Consume

### Studio UI

There is no dedicated Studio page for CORS. The feature is configured through service config/environment and consumed by browser clients such as Studio itself, embedded SDK widgets, and OAuth/browser popup flows.

### API (Runtime)

| Method     | Path                                                      | Purpose                                                                  |
| ---------- | --------------------------------------------------------- | ------------------------------------------------------------------------ |
| middleware | global Runtime middleware in `apps/runtime/src/server.ts` | Apply origin/method/header/credential policy to Runtime HTTP requests    |
| GET/POST   | `/api/v1/channel-oauth/:channelType/*`                    | Use CORS origins as a fallback redirect-origin allowlist for OAuth flows |
| GET        | `/api/v1/sdk/config/:projectId`                           | Adds origin-aware response headers after per-key origin validation       |

### API (Studio)

Studio does not currently expose a dedicated CORS management namespace. Its concern here is mainly as a browser caller of the Runtime API and as a feature-specific consumer of origin allowlists.

### Admin Portal

There is no dedicated admin portal for CORS. Operators manage it through deployment config, env vars, and production config validation.

### Channel / SDK / Voice / A2A / MCP Integration

- **SDK widgets** rely on both Runtime CORS and SDK-key `allowedOrigins`.
- **OAuth/browser popups** use related redirect-origin validation that falls back to configured CORS origins.
- **Regular Studio browser traffic** depends on Runtime CORS when Studio and Runtime are on different origins.
- **Voice, A2A, and MCP** are not direct browser CORS consumers, though adjacent browser setup flows may still depend on origin posture.

---

## 9. Data Model

### Collections / Tables

This feature is config-driven and does not persist MongoDB records of its own.

```text
Config object: cors
Fields:
  - origins: string[]
  - credentials: boolean
  - methods: string[]
  - allowedHeaders: string[]
  - exposedHeaders: string[]
Source:
  - packages/config/src/schemas/cors.schema.ts
```

### Key Relationships

- `packages/config/src/env-mapping.ts` maps selected `CORS_*` env vars into the shared config object.
- `packages/config/src/validation/production-checks.ts` validates `cors.origins` for production safety.
- Runtime reads the resolved config and applies it globally in `server.ts`.
- Channel OAuth and SDK origin enforcement consume related origin settings but are not the same control plane.

---

## 10. Key Implementation Files

### Domain / Core Logic

| File                                                  | Purpose                                        |
| ----------------------------------------------------- | ---------------------------------------------- |
| `packages/config/src/schemas/cors.schema.ts`          | Canonical CORS config schema and defaults      |
| `packages/config/src/env-mapping.ts`                  | Maps `CORS_*` env vars into config             |
| `packages/config/src/validation/production-checks.ts` | Production guardrails for unsafe CORS settings |

### Routes / Handlers

| File                                       | Purpose                                                            |
| ------------------------------------------ | ------------------------------------------------------------------ |
| `apps/runtime/src/server.ts`               | Applies global Express CORS middleware                             |
| `apps/runtime/src/routes/channel-oauth.ts` | Falls back to configured CORS origins for redirect allowlists      |
| `apps/runtime/src/routes/sdk.ts`           | Adds origin-aware response headers after SDK key origin validation |
| `apps/runtime/src/middleware/sdk-auth.ts`  | Enforces SDK-key `allowedOrigins` for bootstrap/auth flows         |

### UI Components

| File                                                | Purpose                                                       |
| --------------------------------------------------- | ------------------------------------------------------------- |
| `apps/studio/src/components/deploy/DeployPanel.tsx` | Allows per-key SDK origin allowlist entry in deployment flows |
| `apps/studio/src/app/api/sdk/keys/route.ts`         | Stores and returns SDK public-key origin allowlists           |

### Jobs / Workers / Background Processes

| File                         | Purpose                                                                                                    |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `apps/runtime/src/server.ts` | Applies the middleware during Runtime bootstrap; there is no standalone background worker for this feature |

### Tests

| File                                                                 | Type        | Coverage Focus                                     |
| -------------------------------------------------------------------- | ----------- | -------------------------------------------------- |
| `packages/config/src/__tests__/env-mapping.test.ts`                  | unit        | Env parsing and config mapping                     |
| `packages/config/src/__tests__/validation/production-checks.test.ts` | unit        | Production wildcard and localhost guardrails       |
| `apps/runtime/src/__tests__/middleware/sdk-auth.test.ts`             | unit        | SDK public-key origin allowlists                   |
| `apps/runtime/src/__tests__/middleware-sdk-auth.test.ts`             | unit        | Additional SDK origin-allowlist regressions        |
| `apps/runtime/src/__tests__/sdk-bootstrap-auth.integration.test.ts`  | integration | Runtime bootstrap path with SDK origin enforcement |

---

## 11. Configuration

### Environment Variables

| Variable               | Default                             | Description                                            |
| ---------------------- | ----------------------------------- | ------------------------------------------------------ |
| `CORS_ORIGINS`         | local-dev origins                   | Comma-separated origin allowlist                       |
| `CORS_CREDENTIALS`     | `true`                              | Whether credentialed cross-origin requests are allowed |
| `CORS_METHODS`         | `GET,POST,PUT,PATCH,DELETE,OPTIONS` | Allowed methods                                        |
| `CORS_ALLOWED_HEADERS` | built-in header list                | Allowed request headers                                |

### Runtime Configuration

- The Runtime global middleware uses `config.cors.*` values.
- In production, the current middleware implementation uses `config.server.frontendUrl` as the `origin` setting instead of the full `config.cors.origins` array.
- `allowedHeaders` defaults include SDK/bootstrap headers such as `X-SDK-Token` and `X-Public-Key`.
- `exposedHeaders` exist in the schema but are not currently mapped from env vars through `env-mapping.ts`.

### DSL / Agent IR / Schema

CORS is not expressed in ABL. It is deployment/runtime configuration only.

---

## 12. Non-Functional Concerns

### Isolation & Multitenancy

| Concern           | Requirement / Expectation                                                                                                                          |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Project isolation | This feature is not project-scoped; the global Runtime policy applies across projects within the deployment.                                       |
| Tenant isolation  | Tenant/browser callers share the same global policy surface, so unsafe tenant-specific assumptions must not be encoded into the global CORS layer. |
| User isolation    | The feature does not key decisions by user identity; stricter user or API-key controls must be enforced in downstream auth/origin checks.          |

### Security & Compliance

- Production validation rejects wildcard origins and warns on localhost origins.
- Default allowed headers explicitly cover SDK auth headers instead of relying on ad hoc browser exceptions.
- Feature-specific origin controls can further narrow access beyond the global CORS policy.

### Performance & Scalability

- The feature is lightweight because the policy is computed once per request from already-loaded config and then handled by the standard Express middleware.
- Because CORS is config-only, it scales trivially across pods as long as all instances load the same config.

### Reliability & Failure Modes

- The biggest failure mode is silent browser rejection caused by incorrect header or origin posture.
- Separate WebSocket or feature-specific origin checks can still reject requests even when global CORS succeeds, which can complicate debugging.

### Observability

- There is no dedicated CORS metric set today.
- Operational debugging relies on browser errors, request/response inspection, and adjacent SDK/OAuth logs.

### Data Lifecycle

This feature is config-driven and does not own persisted tenant, project, or user data.

---

## 13. Delivery Plan / Work Breakdown

1. Close the global middleware correctness gaps
   1.1 Add black-box Runtime tests for preflight handling
   1.2 Add black-box Runtime tests for `Access-Control-Allow-*` response headers
2. Align configuration behavior with documented posture
   2.1 Reconcile production middleware behavior with `cors.origins`
   2.2 Decide whether `exposedHeaders` should be env-mapped and surfaced operationally
3. Improve operational clarity
   3.1 Document the separation between global CORS and SDK/OAuth-specific origin controls
   3.2 Add debugging guidance or telemetry for browser-facing origin failures

---

## 14. Success Metrics

| Metric                                | Baseline                                     | Target                                                            | How Measured                                             |
| ------------------------------------- | -------------------------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------- |
| Direct Runtime CORS endpoint coverage | Missing                                      | Runtime preflight and response-header behavior covered            | Checked-in integration tests                             |
| Unsafe production posture             | Guardrails exist but behavior nuance remains | No wildcard production configs and explicit multi-origin behavior | Config validation plus deployment review                 |
| Browser-origin regressions            | Indirectly detected                          | Fewer unexplained CORS failures in Studio/SDK flows               | Support/debug trend review and targeted regression tests |

---

## 15. Open Questions

1. Should Runtime production middleware accept the full `cors.origins` list instead of `server.frontendUrl`?
2. Should `exposedHeaders` be env-mapped and documented as part of the supported operator surface?
3. Do we want dedicated telemetry for browser-side CORS failures, or is adjacent SDK/OAuth logging sufficient?

---

## 16. Gaps, Known Issues & Limitations

| ID      | Description                                                                                                                                                  | Severity | Status |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- | ------ |
| GAP-001 | Runtime production middleware currently uses `server.frontendUrl` instead of the full `cors.origins` list, which limits true multi-origin production policy. | High     | Open   |
| GAP-002 | `exposedHeaders` exist in the schema but are not currently mapped from `CORS_*` env vars.                                                                    | Medium   | Open   |
| GAP-003 | There is no dedicated black-box test suite for global Runtime preflight and response-header behavior.                                                        | Medium   | Open   |
| GAP-004 | CORS is HTTP-only; WebSocket and feature-specific origin policies are enforced through separate custom logic.                                                | Low      | Open   |

---

## 17. Testing & Validation

### Required Test Coverage

| #   | Scenario                                                        | Coverage Type | Status     | Test File / Note                                                                                                   |
| --- | --------------------------------------------------------------- | ------------- | ---------- | ------------------------------------------------------------------------------------------------------------------ |
| 1   | SDK bootstrap rejects disallowed origins                        | integration   | PASS       | `apps/runtime/src/__tests__/sdk-bootstrap-auth.integration.test.ts`                                                |
| 2   | Global Runtime preflight handling                               | integration   | NOT TESTED | Missing black-box Runtime test                                                                                     |
| 3   | Global Runtime response headers for cross-origin browser calls  | integration   | NOT TESTED | Missing black-box Runtime test                                                                                     |
| 4   | `CORS_ORIGINS` env mapping splits comma-separated values        | unit          | PASS       | `packages/config/src/__tests__/env-mapping.test.ts`                                                                |
| 5   | Production validation rejects wildcard/localhost origin posture | unit          | PASS       | `packages/config/src/__tests__/validation/production-checks.test.ts`                                               |
| 6   | SDK-key exact and wildcard origin allowlists are enforced       | unit          | PASS       | `apps/runtime/src/__tests__/middleware/sdk-auth.test.ts`, `apps/runtime/src/__tests__/middleware-sdk-auth.test.ts` |

### Testing Notes

Current automated coverage proves config parsing, production guardrails, and SDK-specific origin restrictions. It does not yet prove the global Runtime Express CORS middleware from the outside, which is why the matching testing guide still marks the feature as partial.

> Full testing details: [docs/testing/cors.md](../testing/cors.md)

---

## 18. References

- Enterprise readiness: `docs/enterprise-readiness.md`
- Testing guide: [docs/testing/cors.md](../testing/cors.md)
- Related features: [SDK](sdk.md), [Channels](channels.md), [Connectors](connectors.md)
