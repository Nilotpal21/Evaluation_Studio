# HLD: SOAP Tool Support

**Feature Spec**: [`docs/features/sub-features/soap-tool-support.md`](../features/sub-features/soap-tool-support.md)
**Test Spec**: [`docs/testing/sub-features/soap-tool-support.md`](../testing/sub-features/soap-tool-support.md)
**Parent HLD**: [`tool-invocations.hld.md`](tool-invocations.hld.md)
**Status**: APPROVED (implementation complete — ALPHA)
**Author**: Platform team (drafted by Claude Opus 4.7 on behalf of `karthikeya.andhoju@kore.com`)
**Date**: 2026-04-27

---

## 1. Problem Statement

The HTTP tool type currently supports only REST-style invocations: a JSON / form / text / XML body is sent to an endpoint, transport-level auth (Bearer, API key, OAuth, mTLS) is applied, and the response is returned to the agent. Enterprise customers — particularly in banking, insurance, telco, and government — still operate large catalogs of SOAP / WSDL services. Today, an agent builder who needs to call a SOAP endpoint must either:

- (a) hand-craft the SOAP envelope inside the `xml` body template, manually compute the WS-Security `<wsse:Security>` header, set `SOAPAction` and `Content-Type` via custom headers, and parse the response XML downstream, or
- (b) build a sandbox tool to wrap the call.

Both paths are error-prone, leak SOAP knowledge into every tool definition, defeat result compaction (which expects JSON), and bypass first-class observability for SOAP-specific failure modes (`<soap:Fault>`).

The goal is to add SOAP 1.1 and SOAP 1.2 protocol support to the existing `http` tool type so an agent builder can declare a SOAP-bound tool — endpoint, SOAP version, action, body template, and an existing `ws_security` auth profile — and have the runtime construct the envelope, inject WS-Security headers, dispatch through the same SSRF / proxy / retry / circuit-breaker pipeline as REST tools, parse the response into JSON, and surface SOAP faults as first-class structured errors. **Reuse the existing executor, wizard, DSL serializer, auth profile system, and observability surface; do not introduce a new `toolType`.**

Full requirements (FR-1..FR-13) and scope are in the feature spec. This HLD focuses on the architecture, alternatives, the 12 architectural concerns, and the API / data model deltas required to ship the feature.

---

## 2. Alternatives Considered

Four credible options were evaluated; none are strawmen. The chosen approach is Alternative A.

### Alternative A — `protocol` discriminator with branch in `HttpToolExecutor` (SELECTED)

**Description**: Add `protocol: 'rest' | 'soap'` to `HttpBindingIR`. Keep the existing `tool_type: 'http'` taxonomy unchanged. Inside `HttpToolExecutor.buildRequest()` and the response handler, branch on `binding.protocol`. The SOAP path adds envelope wrapping, WS-Security header injection, hardened XML response parsing, and `<soap:Fault>` detection — all gated behind `protocol === 'soap'`.

**Pros**:

- Reuses every shared concern: SSRF, proxy resolver, retry, circuit breaker, rate limiter, header injection sanitizer, max-response-size cap, observability.
- Zero change to `ToolBindingExecutor.dispatch()` (`tool-binding-executor.ts:605`) — SOAP tools dispatch through the same `tool_type === 'http'` branch.
- DSL serializer / parser, Studio wizard, agent IR compilation, A2A bundle export, and project import / export all extend additively.
- Smallest blast radius: existing REST tools' behavior is byte-identical; existing `HttpBindingIR` consumers don't break.

**Cons**:

- Adds protocol-specific branching inside `HttpToolExecutor.buildRequest()` — readers must know that `protocol === 'soap'` materially changes outbound shape.
- The SOAP path adds ~150 lines to a file that is already ~2,000 lines.

**Effort**: M (initial development), S (incremental future work, e.g., WS-Addressing, MTOM).

### Alternative B — `SoapToolExecutor` subclass that wraps `HttpToolExecutor`

**Description**: Add `toolType: 'soap'` to `PROJECT_TOOL_TYPES`. Add a new executor that composes `HttpToolExecutor` (or extends it) and adds SOAP wrapping / unwrapping at the input / output boundary.

**Pros**:

- Cleanest separation of SOAP from REST in source code.
- New executor is independently testable without touching `HttpToolExecutor`'s 3000-line test suite.
- Matches the parent HLD's "type-specific executor per type" pattern.

**Cons**:

- "Type-specific executor per type" was meant for **transport** types (`http` vs `mcp` vs `sandbox` vs `connector`), not protocol-level variants of the same transport. Forcing SOAP into the same axis violates the conceptual model.
- Requires a new `toolType` enum value and a DB migration (or at least a model-enum extension).
- Subclassing or composition of a ~2,000-line executor either creates fragile inheritance or duplicates transport setup (keep-alive sockets, proxy resolver, retry config).
- Studio wizard, DSL serializer, agent IR compilation, A2A bundle export must each treat SOAP as a peer of HTTP — two parallel code paths going forward.
- Cross-cutting changes to HTTP transport (e.g., a new SSRF rule, a proxy auth scheme) must be replicated across both executors.

**Effort**: L (initial development including dispatcher, executor, wizard, DSL, IR, DB enum), L (long-term maintenance burden with parallel code paths).

### Alternative C — SOAP wrapping as a tool middleware in the existing chain

**Description**: Implement SOAP envelope wrapping (request) and unwrapping + fault detection (response) as a `ToolMiddleware` (`packages/compiler/src/platform/constructs/executors/tool-middleware.ts:28`) inserted into the chain after `auth-profile-tool-middleware`. The middleware mutates the tool call context's body before dispatch and the result after the executor returns.

**Pros**:

- Strongest separation of concerns — SOAP framing is a cross-cutting transformation, not executor-internal logic.
- Could in principle apply to non-HTTP tool types (e.g., a future `WsdlOverMcp` if one ever existed).
- Aligns with the platform's onion-model middleware narrative.

**Cons**:

- The middleware contract operates on `LLMToolCall` / `LLMToolResult` shapes — it does not have direct access to the outbound `Request` object (Content-Type, headers) that the executor builds. Forcing the middleware to also patch headers and Content-Type would smear executor responsibilities into middleware.
- Middleware runs before _and_ after the executor. Pre-dispatch wrapping is fine, but post-dispatch unwrapping needs the raw response bytes, which the executor parses. The middleware would have to either subscribe to a "raw response" hook (which doesn't exist today) or duplicate parsing logic.
- WS-Security header injection requires inserting XML into the envelope's `<Header>` — coupling a middleware to envelope structure conflates protocol framing with cross-cutting concerns (auth-profile injection, audit, PII).
- Middleware ordering becomes load-bearing: SOAP wrapping must sit between auth-profile resolution and dispatch but must not interfere with header sanitization.

**Effort**: M (middleware implementation), M (response handler hook), M-L (post-dispatch raw-response coupling).

### Alternative D — New top-level `toolType: 'soap'`

**Description**: Add `'soap'` to `PROJECT_TOOL_TYPES` (`packages/database/src/models/project-tool.model.ts:18`). Build a new schema, new wizard, new DSL surface, new executor, new IR binding (`SoapBindingIR`).

**Pros**:

- Most "discoverable" for builders — the type badge says SOAP.
- SOAP-specific concerns can have first-class IR fields without cluttering `HttpBindingIR`.

**Cons**:

- Duplicates ~80% of the HTTP authoring + execution surface (endpoint, headers, query params, retry, circuit breaker, rate limit, SSRF, proxy, body templates, auth profiles, variable resolution, observability).
- Requires migrating the `project_tools.toolType` enum (DB schema change) — the only alternative that does.
- Diverges further from the platform's conceptual model: SOAP is a framing on top of HTTP, not a peer of HTTP.
- Future improvements to HTTP tools (proxy auth, new headers, etc.) would need to be replicated for SOAP tools.

**Effort**: L (initial development), L (ongoing maintenance burden for parallel code paths).

### Recommendation

**Alternative A is selected.** SOAP-over-HTTP is, definitionally, HTTP with a specific Content-Type, an optional `SOAPAction` header, an XML body in a known framing, and a known response framing. The platform already has the entire HTTP transport stack; SOAP is a 150-line branch on top of it. The other three alternatives either duplicate the HTTP stack (B, D), or stretch the middleware abstraction past where it cleanly fits (C). The trade-off accepted: a small amount of protocol-specific branching inside `HttpToolExecutor`, gated behind `binding.protocol === 'soap'`, in exchange for zero duplication of the resilience / security stack and zero change to existing REST behavior.

---

## 3. Architecture

### System Context

```
                                 ┌──────────────────────────┐
                                 │  Studio UI                │
                                 │  - HttpConfigForm         │
                                 │  - Protocol toggle (NEW)  │
                                 │  - SOAP fields (NEW)      │
                                 └──────────┬───────────────┘
                                            │ Studio API
                                 ┌──────────▼───────────────┐
                                 │  Studio API Routes        │
                                 │  POST /tools, /test, ...  │
                                 │  (extended Zod schema)    │
                                 └──────────┬───────────────┘
                                            │ persists DSL → MongoDB
                                 ┌──────────▼───────────────┐
                                 │  project_tools            │
                                 │  toolType: 'http'         │
                                 │  dslContent contains      │
                                 │    protocol: soap         │
                                 │    soap_version: 1.1|1.2  │
                                 │    soap_action: ...       │
                                 │    on_soap_fault: ...     │
                                 └──────────────────────────┘

                          ┌──────────────────────────────────┐
                          │  Runtime (apps/runtime)           │
                          │                                    │
                          │  Conversation loop                 │
                          │       │                            │
                          │       ▼                            │
                          │  ToolBindingExecutor               │
                          │  ── dispatches by tool_type ──     │
                          │       │  (tool_type === 'http')    │
                          │       ▼                            │
                          │  Auth-profile middleware           │
                          │  - resolveToolAuth()               │
                          │  - applyAuth() → wsSecurityCreds   │
                          │  - patchToolWithResolvedAuth()     │
                          │       │                            │
                          │       ▼                            │
                          │  HttpToolExecutor                  │
                          │  ── branch on binding.protocol ──  │
                          │       │                            │
                          │   REST path     SOAP path (NEW)    │
                          │   (existing)         │             │
                          │                      ▼             │
                          │              wrap envelope         │
                          │              inject WS-Sec         │
                          │              set Content-Type      │
                          │              set SOAPAction        │
                          │       │              │             │
                          │       └──────┬───────┘             │
                          │              ▼                      │
                          │  safeFetch() → outbound HTTP        │
                          │       │                              │
                          │       ▼                              │
                          │  Response handler                    │
                          │  ── branch on binding.protocol ──    │
                          │       │                              │
                          │   REST path     SOAP path (NEW)      │
                          │   (existing)         │               │
                          │                      ▼               │
                          │              hardened XML parse      │
                          │              strip envelope+Body     │
                          │              detect <soap:Fault>     │
                          │       │              │               │
                          │       └──────┬───────┘               │
                          │              ▼                        │
                          │  LLMToolResult                        │
                          │  + trace event (protocol: soap)       │
                          │  + audit log (protocol: soap)         │
                          │  + tool.execution log                 │
                          └────────────────────────────────────┘

                                            │
                                            ▼
                                 ┌──────────────────────────┐
                                 │  External SOAP service    │
                                 │  (enterprise backend)     │
                                 └──────────────────────────┘
```

### Component Diagram

```
┌──────────────────────────────────────────────────────────────────┐
│                                                                  │
│   apps/studio (control plane)                                    │
│   ┌─────────────────────────────────────────────────────────┐   │
│   │  HttpConfigForm.tsx        Protocol toggle (NEW)        │   │
│   │  HttpToolWizard.tsx        SOAP version radio (NEW)     │   │
│   │  ToolTestPanel.tsx         SOAP request preview (NEW)   │   │
│   │  form-adapters.ts          form↔API mapping             │   │
│   │  shared-types.ts           BodyType, Protocol types     │   │
│   └────────────────────┬────────────────────────────────────┘   │
│                        │                                         │
│   ┌────────────────────▼────────────────────────────────────┐   │
│   │  Studio API routes (extended schema, no new routes)     │   │
│   │  POST /api/projects/:pid/tools  (Zod validation)         │   │
│   │  POST /api/projects/:pid/tools/:id/test                  │   │
│   └────────────────────┬────────────────────────────────────┘   │
└────────────────────────┼─────────────────────────────────────────┘
                         │
┌────────────────────────┼─────────────────────────────────────────┐
│  packages/shared (validation + DSL serialization)                │
│   ┌────────────────────▼────────────────────────────────────┐   │
│   │  CreateHttpToolSchema    +protocol, +soap_*, FR-12 check │   │
│   │  serializeHttpProperties +SOAP DSL emission              │   │
│   │  parseDslToToolForm      +SOAP DSL ingestion             │   │
│   │  dsl-property-parser     +HTTP property branch (FR-1.5)  │   │
│   └────────────────────┬────────────────────────────────────┘   │
└────────────────────────┼─────────────────────────────────────────┘
                         │
┌────────────────────────┼─────────────────────────────────────────┐
│  packages/core + packages/shared-kernel                          │
│   ┌────────────────────▼────────────────────────────────────┐   │
│   │  agent-based-parser     +SOAP names in denylist          │   │
│   │  HttpToolFormData       +protocol, +soap_*               │   │
│   └─────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────┘
                         │
┌────────────────────────┼─────────────────────────────────────────┐
│  packages/compiler (IR + executor)                               │
│   ┌────────────────────▼────────────────────────────────────┐   │
│   │  HttpBindingIR          +protocol, soap_version,         │   │
│   │                          soap_action, on_soap_fault      │   │
│   │  compiler:compileHttpBinding  +map AST→IR fields         │   │
│   │  HttpToolExecutor       +SOAP branch in buildRequest +   │   │
│   │                          response handler + parser factory│   │
│   └────────────────────┬────────────────────────────────────┘   │
└────────────────────────┼─────────────────────────────────────────┘
                         │
┌────────────────────────┼─────────────────────────────────────────┐
│  apps/runtime (auth resolution + middleware)                     │
│   ┌────────────────────▼────────────────────────────────────┐   │
│   │  ToolAuthResult        +wsSecurityCredentials  (FR-13)   │   │
│   │  resolveToolAuth       propagate from ApplyAuthResult    │   │
│   │  patchToolWithResolved attach to tool.http_binding       │   │
│   │                        (transient _wsSecurityCredentials) │   │
│   └────────────────────┬────────────────────────────────────┘   │
└────────────────────────┼─────────────────────────────────────────┘
                         │
┌────────────────────────▼─────────────────────────────────────────┐
│  packages/auth-enterprise (read-only)                            │
│   applyWsSecurity()  ← consumed by executor at envelope assembly │
└──────────────────────────────────────────────────────────────────┘
```

### Data Flow — SOAP tool call (request path)

1. Conversation loop produces a `LLMToolCall` for a SOAP tool.
2. `ToolBindingExecutor.dispatch()` selects the executor by `tool_type === 'http'` (no SOAP-specific dispatch — `tool_binding-executor.ts:605`).
3. The auth-profile tool middleware runs:
   - `resolveToolAuth(tool, tenantId, env, options)` invokes `applyAuth()`. The `ws_security` branch (`apply-auth.ts:290-301`) sets `wsSecurityCredentials` on `ApplyAuthResult`.
   - `resolveToolAuth()` returns `ToolAuthResult` **including the new optional `wsSecurityCredentials` field** (FR-13).
   - The middleware then propagates the credentials to the executor. The current `patchToolWithResolvedAuth(tool, headers, queryParams?, tlsOptions?)` (`auth-profile-tool-middleware.ts:401-425`) only mutates `tool.http_binding` (headers, query params, TLS options, and resets `auth.type` to `'none'`). The terminal middleware callback at `tool-binding-executor.ts:335-340` forwards `ctx.toolName`, `ctx.tool`, `ctx.params`, and `ctx.timeoutMs` to `dispatch()` — **`ctx.metadata` is NOT forwarded** to `HttpToolExecutor.execute()` (`http-tool-executor.ts:388`, signature `(toolName, params, timeoutMs?, overrideTool?)`). The credentials must therefore travel on the `tool` object that _is_ forwarded.
   - **Recommendation**: Extend `patchToolWithResolvedAuth()`'s signature with an optional `wsSecurityCredentials` argument and carry them on the patched `tool.http_binding` as a transient runtime-only property (e.g., `_wsSecurityCredentials`, prefix-marked to signal it is not part of the persisted IR). Pros: works with the existing dispatch path with no `composeMiddleware` / `dispatch` / `execute` signature changes. Cons: introduces a runtime-only field on the IR-shaped binding — must be explicitly stripped from any IR serialization (e.g., A2A bundle export, DSL emit, source-hash computation). The LLD must enumerate every IR consumer and verify the transient field is filtered out.
   - **Rejected alternative** (`ctx.metadata` carrier): writing `ctx.metadata.wsSecurityCredentials` in the middleware would be cleaner conceptually but requires adding `metadata` to the dispatch terminal callback and to `HttpToolExecutor.execute()`'s signature, which expands the change surface. Documented here so the LLD has the context if it later chooses to make that broader change.
4. `HttpToolExecutor.buildRequest(call, ctx)`:
   - Resolves `{{input.X}}`, `{{secrets.X}}`, `{{env.X}}`, `{{config.X}}` placeholders in `body_template` and `soap_action` (existing resolver).
   - **Branch on `binding.protocol`**:
     - `'rest'` (or undefined): existing path.
     - `'soap'`: build envelope skeleton from `soap_version`, render placeholder-resolved body inside `<soap:Body>`, read `wsSecurityCredentials` from `binding._wsSecurityCredentials` (transient field set by `patchToolWithResolvedAuth`), call `applyWsSecurity()` (`packages/auth-enterprise/src/ws-security-auth.ts`), inject `<wsse:Security>` into `<soap:Header>`. Set Content-Type (`text/xml; charset=utf-8` for 1.1, `application/soap+xml; charset=utf-8` for 1.2) and `SOAPAction` header as an RFC-compliant quoted-string (1.1, e.g., `"http://example.com/Action"`) or media-type `action=` parameter (1.2). Detect existing `<soap:Envelope>` in the user-authored body to avoid double-wrap; detection strips any leading `<?xml ...?>` declaration before checking for the envelope root element.
5. `safeFetch()` runs the existing SSRF check and dispatches the request through the existing keep-alive socket pool / proxy resolver.
6. Retry policy and circuit-breaker arming behave identically to REST. Tenant-scoped breaker keys (existing) provide cross-tenant isolation.

### Data Flow — SOAP tool response (response path)

1. Response received with `Content-Type` header indicating XML (`text/xml`, `application/soap+xml`, or generic).
2. Existing `HTTP_TOOL_MAX_RESPONSE_BYTES` cap applies before parsing.
3. **Branch on `binding.protocol === 'soap'`**:
   - REST: existing JSON / form / text / XML handling.
   - SOAP: pass response bytes to a hardened `fast-xml-parser` factory configured with `processEntities: false`, `allowBooleanAttributes: false`, no DTD, `maxDepth = HTTP_TOOL_SOAP_PARSER_MAX_DEPTH` (default 64). On parse failure, surface `ToolExecutionError({ code: 'TOOL_RESPONSE_PARSE_FAILED' })`.
   - Detect `<soap:Fault>` (1.1: `<faultcode>`/`<faultstring>`; 1.2: `<env:Code>`/`<env:Reason>`) regardless of HTTP status. Tolerate prefix variations (`soap:`, `soapenv:`, `SOAP-ENV:`, `env:`).
   - On fault:
     - `on_soap_fault === 'error'` (default): throw `ToolExecutionError({ code: 'TOOL_SOAP_FAULT', message: <faultstring or Reason> })`. Circuit breaker arms via the existing `success: false` path.
     - `on_soap_fault === 'data'`: return the parsed fault body as `LLMToolResult.success`. Audit log includes `soap_fault: true` discriminator even on the success path so operators retain visibility.
   - On non-fault: strip `<soap:Envelope>` and `<soap:Body>`; return the inner payload as JSON.
4. Trace event (`tool_call`), audit entry, and `tool.execution` log line emit with `protocol: 'soap'`, `soap_version`, and `soap_action` (when set) — same shape as REST otherwise.

> **Implementation notes (2026-04-28)**: (a) SOAP 1.1 SOAPAction header is now emitted as an RFC-compliant quoted-string (e.g., `"http://example.com/Action"`) per the SOAP 1.1 specification. (b) Pre-wrap detection strips any leading `<?xml ...?>` declaration before checking for an existing `<soap:Envelope>` root — prevents double-wrapping when users prepend XML declarations to full envelopes. (c) Full placeholder resolution (`resolveContextPlaceholders`, `resolveSessionPlaceholders`) is now applied to `soap_action` in addition to `resolvePlaceholders` — all 5 namespaces (`input`, `secrets`, `env`, `_context`, `session`) are resolved consistently.

### Sequence Diagram — SOAP request with WS-Security UsernameToken

```
Conversation    ToolBindingExec   AuthMiddleware   resolveToolAuth   applyAuth      HttpToolExecutor   safeFetch    SOAP service
     │                │                  │                │              │                  │              │              │
     │── tool call ──▶│                  │                │              │                  │              │              │
     │                │── dispatch ─────▶│                │              │                  │              │              │
     │                │                  │── resolve ────▶│              │                  │              │              │
     │                │                  │                │── apply ────▶│                  │              │              │
     │                │                  │                │              │ ws_security:     │              │              │
     │                │                  │                │              │   set wsSecCreds │              │              │
     │                │                  │                │◀─ result ────│                  │              │              │
     │                │                  │ ToolAuthResult │                                  │              │              │
     │                │                  │  +wsSecCreds   │ (FR-13)                          │              │              │
     │                │                  │◀───────────────│                                  │              │              │
     │                │                  │── patchTool ──────────────────────────────────────▶              │              │
     │                │                  │   attach wsSecCreds to tool.http_binding          │              │              │
     │                │                  │   (transient _wsSecurityCredentials field)        │              │              │
     │                │── execute ────────────────────────────────────────────────────────────▶              │              │
     │                │                                                                       │ build req:   │              │
     │                │                                                                       │ - resolve   │              │
     │                │                                                                       │   placeholdrs│              │
     │                │                                                                       │ - wrap env   │              │
     │                │                                                                       │ - inject WS  │              │
     │                │                                                                       │ - set CT/SA  │              │
     │                │                                                                       │── fetch ────▶│              │
     │                │                                                                       │              │── POST ────▶│
     │                │                                                                       │              │              │ process
     │                │                                                                       │              │◀── 200 OR ──│
     │                │                                                                       │              │   <Fault>    │
     │                │                                                                       │◀─ response ─│              │
     │                │                                                                       │ parse XML    │              │
     │                │                                                                       │ detect fault │              │
     │                │                                                                       │ unwrap Body  │              │
     │                │                                                                       │ emit trace   │              │
     │                │◀── LLMToolResult ───────────────────────────────────────────────────────              │              │
     │◀── result ─────│                                                                                                       │
```

---

## 4. The 12 Architectural Concerns

### Structural Concerns

| #   | Concern                 | Design Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Tenant Isolation**    | SOAP tools are persisted in the existing `project_tools` collection with the existing `tenantIsolationPlugin` enforcing `tenantId` on every Mongo query. WS-Security credentials live in `auth_profiles` under `tenantId`. Circuit-breaker keys include `tenantId` (verified by SEC-12 in the test spec). Cross-tenant access returns 404 (E2E-5). No new isolation scope.                                                                                                                                                                                                                   |
| 2   | **Data Access Pattern** | No new collections, no caching layer, no new repositories. SOAP-specific configuration (`protocol`, `soap_version`, `soap_action`, `on_soap_fault`) lives in `project_tools.dslContent` — a string blob — and is mirrored into `HttpBindingIR` at compile time via the existing `loadProjectToolsAsIR()` path. Auth-profile decryption stays AES-256-GCM with tenant-scoped keys.                                                                                                                                                                                                            |
| 3   | **API Contract**        | No new endpoints. Existing tool CRUD / test / export / import accept four new optional camelCase fields (`protocol`, `soapVersion`, `soapAction`, `onSoapFault`) in the JSON body. Existing payloads continue to work because the fields are optional with defaults. The Studio test endpoint optionally returns the rendered envelope when `?debug=true` (resolves Open Question #4). Error envelope shape is unchanged (`{ success, data?, error?: { code, message } }`).                                                                                                                  |
| 4   | **Security Surface**    | Three new gates: (a) hardened `fast-xml-parser` factory (XXE / DTD / billion-laughs blocked); (b) `<wsse:Security>` injection happens only when `protocol === 'soap'` AND the resolved auth profile is `ws_security` — REST tools with a `ws_security` profile get a structured warning log and no injection (FR-11); (c) existing SSRF, header-injection sanitizer (CRLF strip on `soap_action`), max-response-size cap, OAuth HTTPS enforcement all apply uniformly. Credentials never appear at design-time surfaces; the `<wsse:Password>` is digested (non-reversible) when serialized. |

### Behavioral Concerns

| #   | Concern           | Design Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 5   | **Error Model**   | Three distinct error codes: `TOOL_SOAP_FAULT` (SOAP fault detected, default `on_soap_fault: 'error'`), `TOOL_RESPONSE_PARSE_FAILED` (malformed XML), `TOOL_AUTH_FAILED` (WS-Security generation failed pre-dispatch — e.g., empty username). Faults can opt-in to `success: true` via `on_soap_fault: 'data'` for legacy services. Existing `TOOL_HTTP_ERROR`, `TOOL_TIMEOUT`, `SSRF_BLOCKED` propagate unchanged. User-visible error messages stay sanitized (no tenant IDs, no internal remediation hints) per the platform-wide sanitization rule in `CLAUDE.md`.                                                                                          |
| 6   | **Failure Modes** | Existing per-tenant per-tool circuit breaker (3 failures → open, 30s reset). SOAP faults route through the same `success: false` path so they arm the breaker exactly like HTTP 5xx. Retry policy applies at the request level only (no SOAP message-level idempotency — caller must ensure operation safety). Network errors, timeouts, and parser failures all propagate as structured `ToolExecutionError`s. The `WS_SECURITY_BOUND_TO_REST_TOOL` warning provides a tripwire for misconfiguration without failing the tool call.                                                                                                                          |
| 7   | **Idempotency**   | Idempotency is a property of the SOAP operation, not of this feature. The platform retries at the HTTP transport level only (identical request re-sent via the existing `retry` / `retryDelay` policy); it does **not** implement SOAP-message-level reliability (no WS-ReliableMessaging, no WS-Trust). Tool authors who need idempotency guarantees for side-effecting SOAP operations opt into the existing `confirmation.require: 'when_side_effects'` mechanism, which gates the call behind user approval and an immutable parameter snapshot — preventing parameter-tampering retries. **N/A for the SOAP layer itself.**                              |
| 8   | **Observability** | Trace event (`tool_call`), audit entry, and `tool.execution` log entry are emitted with three new structured fields: `protocol: 'soap'`, `soap_version`, and `soap_action` (when set). A new audit discriminator `soap_fault: true` is set on both error-path and data-path fault outcomes, so operators can filter / count fault rates regardless of `on_soap_fault` setting. The hardened parser config is logged once at module init for runbook visibility. The optional `HTTP_TOOL_SOAP_DEBUG_RAW_REQUEST=true` env flag includes the rendered envelope in trace payload for debugging (off by default — the envelope contains digest-form credentials). |

### Operational Concerns

| #   | Concern                | Design Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 9   | **Performance Budget** | SOAP shares the same per-tool circuit breaker / rate limiter / keep-alive socket pool budget as REST tools — **no SOAP-specific scaling**. XML parsing is bounded by `HTTP_TOOL_MAX_RESPONSE_BYTES` (10 MB) and `HTTP_TOOL_SOAP_PARSER_MAX_DEPTH` (64). `applyWsSecurity()` cost is sub-millisecond (Node `crypto` SHA-1 + base64). Tool result compaction operates on the parsed JSON payload, so structured / truncate / summarize strategies all apply. Latency target: parity with REST tools at p95 (the only added cost is XML parse, which `fast-xml-parser` v5 keeps under 50 ms for typical enterprise payloads).                                                                                                                                                                                                                                                                                      |
| 10  | **Migration Path**     | **No data migration required.** Zero SOAP tools exist today. Existing REST tools have no `protocol` field; the executor and Zod treat absent `protocol` as `'rest'` — byte-identical behavior to today (verified by INT-6 + U-15 + U-16 regression). The `ToolAuthResult` extension is additive (new optional field). Authoring is opt-in (the builder must explicitly toggle Protocol to SOAP). No backward-compat shims, no strangler.                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 11  | **Rollback Plan**      | Rollback = revert the runtime / compiler / shared / studio commits. Any SOAP tool authored during the rollout window orphans (older parser doesn't recognize `protocol: soap` line in DSL) but does not break other tools or the runtime. **No feature flag** — opt-in authoring + per-tenant circuit breaker isolation provide adequate gating. The orphaned SOAP tools become usable again when the code is redeployed. Acceptable trade-off given the small expected rollout-window authoring volume.                                                                                                                                                                                                                                                                                                                                                                                                        |
| 12  | **Test Strategy**      | Per the test spec: 10 E2E scenarios (7 top-level scenarios E2E-1..E2E-7 plus 3 isolation sub-scenarios E2E-5b/5c/5d), all running against real Express + MongoMemoryServer + Redis subprocess + local SOAP stub fixture; no mocks of `@agent-platform/*` or `@abl/*`. Coverage: happy paths (1.1 + 1.2), fault detection, opt-in fault-as-data, cross-tenant 404, cross-project 404, missing-auth 401, RBAC 403, SSRF, agent-bound session integration. Plus 7 integration scenarios (explicit service boundaries: envelope wrap, WS-Sec injection, credential propagation, REST-with-WS-Sec warning, hardened parser, fault detection across versions, DSL-IR lockstep round-trip); 26 unit scenarios; 12 security tests. Promotion thresholds: PLANNED→ALPHA on 3 top-level E2E + 5 INT green; ALPHA→BETA on all 7 top-level E2E + all 7 INT + manual; BETA→STABLE on nightly real-third-party-SOAP coverage. |

---

## 5. Data Model

### New Collections / Tables

**None.**

### Modified Collections / Tables

| Collection / Table | Change                                                                                                                                                                                                                                                                                                                         |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `project_tools`    | None at the schema / index level. The `dslContent` blob now optionally contains four new lines (`protocol:`, `soap_version:`, `soap_action:`, `on_soap_fault:`). `sourceHash` reflects them when present; existing tools' hashes are unchanged. `toolType` enum stays at `['http', 'mcp', 'sandbox', 'searchai', 'workflow']`. |

### IR / In-Memory Schema Additions

```typescript
// packages/compiler/src/platform/ir/schema.ts
interface HttpBindingIR {
  // ... existing fields ...
  protocol?: 'rest' | 'soap'; // default 'rest'
  soap_version?: '1.1' | '1.2'; // required when protocol === 'soap'; default '1.1'
  soap_action?: string; // optional
  on_soap_fault?: 'error' | 'data'; // default 'error'
}
```

```typescript
// apps/runtime/src/services/auth-profile/resolve-tool-auth.ts (FR-13)
interface ToolAuthResult {
  headers: Record<string, string>;
  queryParams?: Record<string, string>;
  source: 'auth_profile' | 'inline' | 'none';
  authType?: string;
  secrets?: Record<string, unknown>;
  tlsOptions?: { cert: string; key: string; ca?: string; rejectUnauthorized: true };
  wsSecurityCredentials?: {
    // NEW (FR-13)
    username: string;
    password: string;
    certificate?: string;
    mustUnderstand: boolean;
  };
}
```

The transient `_wsSecurityCredentials` field on `tool.http_binding` (set by `patchToolWithResolvedAuth`) carries credentials from the auth-profile middleware to the executor at runtime. **This field must be stripped from every IR serialization path** — DSL emit (`serialize-tool-form-to-dsl.ts`), A2A bundle export, project export, `sourceHash` computation in `loadProjectToolsAsIR()`, and any agent IR snapshot stored in `agent_versions`. The LLD must enumerate each consumer and verify the strip.

### Key Relationships

- A SOAP tool may reference a `ws_security` auth profile via `auth_profile_ref` (existing relationship, new use-case).
- A SOAP tool's `body` template participates in the same variable-resolution chain as REST tools (`{{input.X}}`, `{{secrets.X}}`, `{{env.X}}`, `{{config.X}}`).
- SOAP tool execution traces are correlated to sessions through the existing `sessionId` / `tenantId` on `tool_call` events.

---

## 6. API Design

### New Endpoints

**None.**

### Modified Endpoints

| Method | Path                                     | Change                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------ | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/api/projects/:id/tools`                | Accepts new optional fields: `protocol`, `soapVersion`, `soapAction`, `onSoapFault`. Zod cross-field validation (FR-12) returns 400 on conflicts.                                                                                                                                                                                                                                                                            |
| PUT    | `/api/projects/:id/tools/:toolId`        | Same.                                                                                                                                                                                                                                                                                                                                                                                                                        |
| POST   | `/api/projects/:id/tools/:toolId/test`   | When `protocol === 'soap'`: server-side envelope wrap + WS-Security injection. With `?debug=true` (gated behind `tool:write` — same RBAC bar as editing the tool): response includes `renderedRequest` field showing the dispatched envelope. The LLD must decide whether `<wsse:Nonce>` and `<wsu:Timestamp>` are redacted from the debug response (replay-attack-adjacent metadata, even though the password is digested). |
| GET    | `/api/projects/:id/tools/:toolId/export` | Export now includes the four new fields when set on the source DSL.                                                                                                                                                                                                                                                                                                                                                          |
| POST   | `/api/projects/:id/tools/import`         | Recognizes the four new fields and validates per FR-12.                                                                                                                                                                                                                                                                                                                                                                      |

### Request / Response Shape

**Tool create / update (request)** — additions to existing `CreateHttpToolSchema`:

```jsonc
{
  "toolType": "http",
  "endpoint": "https://soap.insurer.example/PolicyService",
  "method": "POST",
  "protocol": "soap", // NEW (default "rest")
  "soapVersion": "1.1", // NEW (required when soap)
  "soapAction": "http://example.com/PolicyService/LookupPolicy", // NEW (optional)
  "onSoapFault": "error", // NEW (default "error")
  "authProfileRef": "insurer-ws-security",
  "bodyType": "xml",
  "body": "<ns:LookupPolicy ...>...</ns:LookupPolicy>",
  // ...
}
```

**Tool test (response)** — when `protocol === 'soap'` and `?debug=true`:

```jsonc
{
  "success": true,
  "data": { "PolicyNumber": "P-12345", "Status": "ACTIVE" }, // parsed JSON, envelope+Body stripped
  "renderedRequest": {
    // NEW (debug only)
    "method": "POST",
    "url": "https://soap.insurer.example/PolicyService",
    "headers": {
      "Content-Type": "text/xml; charset=utf-8",
      "SOAPAction": "\"http://example.com/PolicyService/LookupPolicy\"",
    },
    "body": "<soap:Envelope xmlns:soap=\"...\"><soap:Header><wsse:Security ...>...</wsse:Security></soap:Header><soap:Body>...</soap:Body></soap:Envelope>",
  },
  "trace": { "protocol": "soap", "soap_version": "1.1", "soap_action": "..." },
}
```

### Error Responses

| Code                         | Trigger                                                                          | HTTP                                    |
| ---------------------------- | -------------------------------------------------------------------------------- | --------------------------------------- |
| `TOOL_SOAP_FAULT`            | `<soap:Fault>` returned, `on_soap_fault === 'error'`                             | tool result `success: false`            |
| `TOOL_RESPONSE_PARSE_FAILED` | Malformed XML, XXE / billion-laughs / depth refused                              | tool result `success: false`            |
| `TOOL_AUTH_FAILED`           | `applyWsSecurity()` failed (e.g., empty username after secret resolution)        | tool result `success: false`            |
| Zod 400                      | FR-12 violation: `soapAction` set on REST tool, or `soapVersion` missing on SOAP | HTTP 400 with descriptive msg           |
| `SSRF_BLOCKED`               | SOAP endpoint resolves to private IP / metadata / encoded-bypass                 | HTTP 400 on create; failure on dispatch |

---

## 7. Cross-Cutting Concerns

- **Audit Logging**: every SOAP tool execution emits the existing `tool.execution` audit entry shape with three new fields (`protocol`, `soap_version`, `soap_action`) plus the `soap_fault` discriminator. Stored via the platform `AuditStore` (ClickHouse → MongoDB → in-memory fallback). No new audit collection.
- **Rate Limiting**: existing per-tool Redis-backed sliding window applies unchanged. SOAP tools share the budget with REST tools at the same `auth_profile_ref` / `tool_name` granularity.
- **Caching**: no caching of SOAP responses. Existing tool-result compaction (`tool-result-compressor.ts`) operates on the parsed JSON; structured / truncate / summarize all apply.
- **Encryption**: WS-Security secrets are AES-256-GCM encrypted at rest in `auth_profiles` (existing). They appear in the rendered envelope only at request time and never in API responses or trace events. The `<wsse:Password>` digest is non-reversible by spec.
- **i18n**: error messages user-visible at the test panel use existing locale keys; SOAP-specific copy goes through the standard `i18n` pipeline (not a SOAP-only mechanism).
- **CORS**: no impact — Studio is an admin surface and runtime endpoints don't change.

---

## 8. Dependencies

### Upstream (this feature depends on)

| Dependency                                                                          | Type                  | Risk                                                                                                           |
| ----------------------------------------------------------------------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------- |
| `packages/auth-enterprise:applyWsSecurity()`                                        | Code (read-only)      | Low — already implemented + unit tested.                                                                       |
| `packages/shared/src/services/auth-profile/apply-auth.ts:ws_security` case          | Code (read-only)      | Low — already implemented + integration tested.                                                                |
| `apps/runtime/src/services/auth-profile/resolve-tool-auth.ts:ToolAuthResult`        | Code (extend)         | Medium — must add `wsSecurityCredentials` propagation (FR-13). Top risk in the project.                        |
| `apps/runtime/src/services/auth-profile/auth-profile-tool-middleware.ts:patchTool…` | Code (extend)         | Medium — must attach credentials to `tool.http_binding._wsSecurityCredentials` (transient field).              |
| `packages/compiler/src/platform/constructs/executors/http-tool-executor.ts`         | Code (extend)         | Medium — adds branching paths in `buildRequest()` and response handler.                                        |
| `packages/compiler/src/platform/constructs/tool-binding-executor.ts`                | Code (no change)      | Low — dispatch by `tool_type === 'http'` is unchanged.                                                         |
| `packages/shared-kernel/security/safe-fetch:safeFetch` + `assertUrlSafeForFetch`    | Code (no change)      | Low — SSRF guards apply uniformly.                                                                             |
| `fast-xml-parser` (>= 5.5.6, root override)                                         | NPM (already in tree) | Medium — must verify exact version + harden parser config; confirm `processEntities: false` is the v5 default. |
| Variable-resolution placeholder resolver                                            | Code (no change)      | Low — same path as REST tools; XML-escaping behavior is OQ #1.                                                 |
| `TraceStore`, `tool-audit-logger.ts`, `tool.execution` log shape                    | Code (no change)      | Low — extends with three additional structured fields.                                                         |

### Downstream (depends on this feature)

| Consumer                | Impact                                                                                                                                      |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent builder authoring | Direct — gains a new Protocol toggle and SOAP-specific fields.                                                                              |
| Conversation / runtime  | Indirect — agents bound to SOAP tools execute through the same dispatcher; no consumer-facing API change.                                   |
| Project import / export | Schema additive — older exports without SOAP fields still import; SOAP exports import correctly.                                            |
| A2A bundle export       | No change — A2A bundles tool IR which is backward-compatible.                                                                               |
| MCP discovery           | Unaffected — MCP uses `mcp_binding`, not `http_binding`.                                                                                    |
| Connectors              | Adjacent — connector tools route through the connector executor; SOAP support does not affect connectors. Open Question #6 covers backport. |

---

## 9. Open Questions & Decisions Needed

### Decisions made in this HLD (carry forward to LLD as starting position)

- **Studio test endpoint envelope visibility**: rendered envelope returned only with `?debug=true`, gated behind `tool:write` permission (same bar as editing the tool). Rationale: the envelope contains the WS-Security `<wsse:Password>` digest (non-reversible by spec) plus `<wsse:Nonce>` and `<wsu:Timestamp>`; nonce + timestamp are replay-attack-adjacent metadata. Default response is the parsed JSON body. Documented in §4 concern #3 and §6 API design. _LLD must decide whether to additionally redact nonce/timestamp from the debug response and may revisit the RBAC bar if a UX need arises, but should not regress to "always return"._
- **Auth credential propagation vehicle (FR-13)**: the HLD recommends carrying `wsSecurityCredentials` on the patched `tool.http_binding` as a transient `_wsSecurityCredentials` field. Documented in §3 data flow step 3. The alternative — writing to `ctx.metadata` and propagating it through the dispatcher — was rejected because the terminal middleware callback at `tool-binding-executor.ts:335-340` and `HttpToolExecutor.execute()` (`http-tool-executor.ts:388`) do not take `ToolCallContext`; that path would require expanding the dispatch contract. _LLD must verify every IR consumer (DSL emit, A2A bundle export, `sourceHash` computation, project export) strips the transient field._

### Resolved in LLD (post-implementation)

1. ~~**`{{input.X}}` placeholders inside SOAP body templates**~~ **RESOLVED (D-11)**: Auto-XML-escape is the v1 default. `xmlEscape()` in `soap-envelope.ts` handles `&`, `<`, `>`, `"`, `'`. Flag `escapeForXmlBodyTemplate` threaded through all 6 placeholder resolvers.
2. ~~**One-way SOAP operations**~~ **RESOLVED (D-12)**: Returns `{ oneWay: true }`. Discriminable, non-empty, self-documenting.
3. ~~**`fast-xml-parser` exact version pin**~~ **RESOLVED (D-13)**: Pinned at `>=5.5.6` in `packages/compiler/package.json`. `fast-xml-parser` 5.6.0 confirmed in `pnpm-lock.yaml`. `processEntities: false` is the safe default in v5.
4. ~~**Jira ticket creation**~~ **RESOLVED**: Implementation committed without a ticket (user decision — no ABLP ticket). Commits reference the design docs instead.
5. **Connector-tool SOAP backport** — deferred to a future sub-feature. Flagged for the connectors team. `soap-envelope.ts` is designed to be reusable.

### Implementation constraint (carries into LLD)

- **Commit-scope-guard limit**: the affected packages are `packages/compiler`, `packages/core`, `packages/shared`, `packages/shared-kernel`, `apps/studio`, `apps/runtime` (six packages). A `.claude/hooks/commit-scope-guard.sh` PreToolUse hook hard-blocks commits touching more than 3 packages. The LLD's phased breakdown must produce **at least two sequential commits** for the DSL lockstep work (e.g., split between IR/compiler/shared and core/shared-kernel/studio). Reference: `packages/compiler/agents.md` 2026-04-18 learning.

---

## 10. References

- Feature spec: [`docs/features/sub-features/soap-tool-support.md`](../features/sub-features/soap-tool-support.md)
- Test spec: [`docs/testing/sub-features/soap-tool-support.md`](../testing/sub-features/soap-tool-support.md)
- Parent HLD: [`tool-invocations.hld.md`](tool-invocations.hld.md)
- IR schema: `packages/compiler/src/platform/ir/schema.ts:1075` (`HttpBindingIR`)
- Executor: `packages/compiler/src/platform/constructs/executors/http-tool-executor.ts:146` (Content-Type map), `:459` (`buildRequest`)
- Dispatcher: `packages/compiler/src/platform/constructs/executors/tool-binding-executor.ts:605` (dispatch by `tool_type`)
- Middleware: `packages/compiler/src/platform/constructs/executors/tool-middleware.ts:19` (`ToolCallContext.metadata`)
- Auth resolver: `apps/runtime/src/services/auth-profile/resolve-tool-auth.ts:93-106` (`ToolAuthResult` shape — pre-FR-13)
- Auth middleware: `apps/runtime/src/services/auth-profile/auth-profile-tool-middleware.ts:401-425` (`patchToolWithResolvedAuth`)
- WS-Security helper: `packages/auth-enterprise/src/ws-security-auth.ts` (`applyWsSecurity()`)
- WS-Security auth case: `packages/shared/src/services/auth-profile/apply-auth.ts:290-301`
- Specs (SOAP): SOAP 1.1 (W3C Note 2000-05-08), SOAP 1.2 (W3C Recommendation 2007-04-27), WS-Security 1.1 (OASIS Standard)
- Design quality gate: [`.claude/skills/design-quality-gate.md`](../../.claude/skills/design-quality-gate.md) (12 concerns)
