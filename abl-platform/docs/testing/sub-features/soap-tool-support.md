# Test Specification: SOAP Tool Support

**Feature Spec**: [`docs/features/sub-features/soap-tool-support.md`](../../features/sub-features/soap-tool-support.md)
**HLD**: [`docs/specs/soap-tool-support.hld.md`](../../specs/soap-tool-support.hld.md)
**LLD**: [`docs/plans/2026-04-27-soap-tool-support-impl-plan.md`](../../plans/2026-04-27-soap-tool-support-impl-plan.md)
**Status**: ALPHA
**Last Updated**: 2026-04-28

---

## 1. Coverage Matrix

Every functional requirement (FR-1 through FR-13) appears below. Status will track per FR as implementation proceeds.

| FR    | Description                                                                                           | Unit | Integration | E2E | Manual | Status                                                           |
| ----- | ----------------------------------------------------------------------------------------------------- | :--: | :---------: | :-: | :----: | ---------------------------------------------------------------- |
| FR-1  | Extend `HttpBindingIR` with `protocol`, `soap_version`, `soap_action`, `on_soap_fault`                |  ✅  |     ✅      |  —  |   —    | ✅ PASSING (U-1/2 + INT-7)                                       |
| FR-2  | Extend `CreateHttpToolSchema` Zod fields + cross-field validation (FR-12)                             |  ✅  |      —      |  —  |   —    | ✅ PASSING (U-20..22)                                            |
| FR-3  | Extend `HttpToolFormData` form types (validated transitively via INT-7 DSL round-trip)                |  ✅  |     ✅      |  —  |   —    | ✅ PASSING (INT-7 round-trip)                                    |
| FR-4  | DSL round-trip for new fields (serialize + parse)                                                     |  ✅  |     ✅      |  —  |   —    | ✅ PASSING (U-17..19 + INT-7)                                    |
| FR-5a | SOAP envelope wrapping (1.1 + 1.2 namespaces, double-wrap detection incl. XML declaration prefix)     |  ✅  |     ✅      | ✅  |   —    | ✅ PASSING (U-1, U-5, INT-1, E2E-1/2) — XML decl fix 04-28       |
| FR-5b | Content-Type override (1.1 `text/xml`; 1.2 `application/soap+xml`)                                    |  ✅  |     ✅      | ✅  |   —    | ✅ PASSING (U-3, INT-1/2, E2E-1/2)                               |
| FR-5c | SOAPAction header (1.1, RFC-quoted) / `action=` media-type parameter (1.2)                            |  ✅  |     ✅      | ✅  |   —    | ✅ PASSING (U-4, U-4b, U-4c, INT-1/2, E2E-7) — quoting fix 04-28 |
| FR-5d | WS-Security `<wsse:Security>` injection into envelope `<Header>`                                      |  ✅  |     ✅      | ✅  |   —    | ✅ PASSING (U-6, INT-2/3, E2E-1)                                 |
| FR-6  | Hardened XML response parsing (XXE/DTD blocking) + Body unwrap                                        |  ✅  |     ✅      | ✅  |   —    | ✅ PASSING (U-7/11..13, INT-1/2, E2E-1/2)                        |
| FR-7  | `<soap:Fault>` detection (1.1 + 1.2; HTTP 200 + 5xx) + `on_soap_fault` semantics                      |  ✅  |     ✅      | ✅  |   —    | ✅ PASSING (U-8..10, INT-6, E2E-3/4)                             |
| FR-8  | SSRF, proxy, retry, circuit-breaker, rate-limiter applied uniformly to SOAP                           |  ✅  |     ✅      | ✅  |   —    | ✅ PASSING (SEC-9, INT-4, E2E-5/5b/6)                            |
| FR-9  | Studio Protocol toggle + SOAP-specific fields in `HttpConfigForm` and wizard                          |  ✅  |      —      |  —  |   ✅   | ✅ PASSING (U-23..26)                                            |
| FR-10 | Trace / audit / log emit `protocol`, `soap_version`, `soap_action`                                    |  —   |     ✅      | ✅  |   —    | ✅ PASSING (log.debug verified in INT-1/2)                       |
| FR-11 | `ws_security` profile bound to REST tool emits warning, no injection                                  |  ✅  |     ✅      |  —  |   —    | ✅ PASSING (INT-4)                                               |
| FR-12 | Cross-field validation: `soap_action` only when SOAP, `soap_version` required when SOAP               |  ✅  |      —      |  —  |   —    | ✅ PASSING (U-21)                                                |
| FR-13 | Auth resolver propagates `wsSecurityCredentials` from `ApplyAuthResult` → `ToolAuthResult` → executor |  ✅  |     ✅      | ✅  |   —    | PARTIAL — INT-3 type-contract only; DB integration deferred      |

> Promotion thresholds (per [`docs/sdlc/pipeline.md`](../../sdlc/pipeline.md)):
>
> - **PLANNED → ALPHA**: at least 3 E2E + 5 integration + every FR has at least one ✅. Unit tests for FR-5a..FR-5d, FR-6, FR-7, FR-13 all green.
> - **ALPHA → BETA**: all 7 E2E + all 7 integration scenarios green. Manual M-1..M-5 walkthroughs complete.
> - **BETA → STABLE**: nightly integration against a real third-party SOAP service (closes GAP-007); no open CRITICAL/HIGH gaps; one production / staging soak week.

---

## 2. E2E Test Scenarios (MANDATORY)

CRITICAL: E2E tests exercise the real system through its HTTP API. **No `vi.mock` of `@agent-platform/*`, `@abl/*`, or relative imports. No direct DB access. Real Express + MongoMemoryServer + Redis (subprocess), full middleware chain.** Only the SOAP backend itself (a local Express stub) is "external" in the dependency-injection sense; everything internal is real.

> **One permitted exception**: `vi.mock('server-only', () => ({}))` at the top of the file. This stubs Next.js's [`server-only`](https://nextjs.org/docs/app/building-your-application/rendering/composition-patterns#keeping-server-only-code-out-of-the-client-environment) marker module so route handlers can run inside Vitest. This is _not_ a platform-component mock; it mirrors the parent E2E pattern at `tool-invocations-api.e2e.test.ts:19` and is honored by the `e2e-test-quality-lint.sh` hook.

The full harness mirrors `apps/studio/src/__tests__/e2e/tool-invocations-api.e2e.test.ts:198-237` — same `MongoMemoryServer` + `redis-server` subprocess + Express wrapping Next.js route handlers + dev-login auth + real encryption (`@agent-platform/shared/crypto`).

**Test file**: `apps/studio/src/__tests__/e2e/soap-tool.e2e.test.ts` (new)

**Stub SOAP server fixture**: `apps/studio/src/__tests__/e2e/fixtures/soap-stub-server.ts` (new). Two Express servers on random ports — one for SOAP 1.1 (`text/xml`), one for SOAP 1.2 (`application/soap+xml`). Both expose:

- `POST /Echo` → returns the inner `<Body>` content wrapped in a canned response envelope.
- `POST /PolicyService/LookupPolicy` → returns a canned policy payload, or a `<soap:Fault>` if input contains `FAULT`.
- `POST /Slow` → sleeps `delayMs` from a query parameter (used for retry/timeout/circuit-breaker tests).
- `POST /Malformed` → returns malformed XML (used for parser failure tests).
- `POST /XXE` → returns XML containing an external entity reference (used to verify XXE-blocking parser config).
- `POST /BillionLaughs` → returns an exponentially nested entity payload.
- `POST /Big` → returns a response just over `HTTP_TOOL_MAX_RESPONSE_BYTES`.
- `GET /captured-requests` → returns the list of captured raw request bodies + headers (test inspection).

The stub records every inbound request to enable assertion of headers, content-type, body shape, and `<wsse:Security>` injection.

---

### E2E-1: Create and execute a SOAP 1.1 tool with WS-Security UsernameToken (happy path)

- **FR Coverage**: FR-1, FR-2, FR-3, FR-5a, FR-5b, FR-5c, FR-5d, FR-6, FR-10, FR-13
- **Preconditions**: Authenticated project admin (via dev-login), project P1 in tenant A, `ws_security` auth profile created (`secrets: { username: 'svc-acct', password: 'p@ss' }`, `config: { mustUnderstand: true }`), SOAP 1.1 stub running on a random port.
- **Steps**:
  1. `POST /api/projects/:pid/auth-profiles` with `{ name: 'insurer-ws-security', authType: 'ws_security', scope: 'project', visibility: 'shared', config: { mustUnderstand: true }, secrets: { username: 'svc-acct', password: 'p@ss' } }`. Capture the returned `authProfileId`. Assert 201.
  2. `POST /api/projects/:pid/tools` with body:
     ```json
     {
       "name": "lookup_policy",
       "description": "Look up an insurance policy by number",
       "toolType": "http",
       "endpoint": "<stub URL>/PolicyService/LookupPolicy",
       "method": "POST",
       "protocol": "soap",
       "soapVersion": "1.1",
       "soapAction": "http://example.com/PolicyService/LookupPolicy",
       "onSoapFault": "error",
       "authProfileRef": "insurer-ws-security",
       "bodyType": "xml",
       "body": "<ns:LookupPolicy xmlns:ns=\"http://example.com/policy\"><ns:PolicyNumber>{{input.policy_number}}</ns:PolicyNumber></ns:LookupPolicy>",
       "parameters": [
         {
           "name": "policy_number",
           "type": "string",
           "description": "The policy number to look up",
           "required": true
         }
       ]
     }
     ```
     Assert 201; capture `toolId`.
  3. `POST /api/projects/:pid/tools/:toolId/test` with `{ "input": { "policy_number": "P-12345" } }`. Assert 200.
  4. Inspect the stub's `GET /captured-requests`:
     - Method: `POST`
     - `Content-Type`: `text/xml; charset=utf-8`
     - `SOAPAction`: `"http://example.com/PolicyService/LookupPolicy"` (with surrounding quotes — SOAP 1.1 spec)
     - Body envelope namespace: `http://schemas.xmlsoap.org/soap/envelope/`
     - Body contains `<wsse:Security soap:mustUnderstand="1">` under `<soap:Header>` with `<wsse:UsernameToken>`, `<wsse:Username>svc-acct</wsse:Username>`, `<wsse:Password Type=".../PasswordDigest">` (digest, not cleartext), `<wsse:Nonce>`, `<wsu:Created>`, `<wsu:Timestamp>`
     - Body contains `<ns:PolicyNumber>P-12345</ns:PolicyNumber>` inside `<soap:Body>` (input placeholder resolved)
  5. Inspect the test response: `success: true`; `data` is the parsed JSON payload with envelope and `<Body>` stripped. Specific assertion on a known field from the canned response.
  6. Inspect the trace event log: a `tool_call` event with `protocol: 'soap'`, `soap_version: '1.1'`, `soap_action: 'http://example.com/PolicyService/LookupPolicy'`, `success: true`.
- **Expected Result**: SOAP envelope wrapped server-side; WS-Security header injected; outbound call goes out to the stub; response parsed to JSON.
- **Auth Context**: Project admin, tenant A, project P1.
- **Isolation Check**: `tenantId` and `projectId` enforced on tool, profile, and trace event.

### E2E-2: SOAP 1.2 framing with `application/soap+xml; action=...`

- **FR Coverage**: FR-1, FR-5a, FR-5b, FR-5c
- **Preconditions**: Same as E2E-1 (auth profile already created) but using the SOAP 1.2 stub on its own random port.
- **Steps**:
  1. Reuse the `ws_security` auth profile from E2E-1 (or recreate it).
  2. `POST /api/projects/:pid/tools` with the same body as E2E-1 except `soapVersion: '1.2'` and `endpoint: '<soap-1.2-stub>/PolicyService/LookupPolicy'`. Capture `toolId`.
  3. `POST /api/projects/:pid/tools/:toolId/test` with `{ "input": { "policy_number": "P-67890" } }`. Assert 200.
  4. Inspect the SOAP 1.2 stub's `GET /captured-requests`.
- **Assertions** (additive to E2E-1):
  - `Content-Type`: `application/soap+xml; charset=utf-8; action="http://example.com/PolicyService/LookupPolicy"`
  - **No** standalone `SOAPAction` header is sent (1.2 puts action inside Content-Type only)
  - Envelope namespace: `http://www.w3.org/2003/05/soap-envelope`
  - Trace event has `protocol: 'soap'`, `soap_version: '1.2'`.
- **Expected Result**: Correct 1.2 framing; happy path response.
- **Auth Context**: Project admin, tenant A, project P1.
- **Isolation Check**: `tenantId` and `projectId` enforced on tool, profile, and trace event.

### E2E-3: SOAP fault returned with HTTP 200 → structured error by default

- **FR Coverage**: FR-7, FR-8, FR-10
- **Preconditions**: SOAP 1.1 tool from E2E-1; stub returns HTTP 200 with body:
  ```xml
  <soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
    <soap:Body>
      <soap:Fault>
        <faultcode>Client</faultcode>
        <faultstring>Policy not found</faultstring>
      </soap:Fault>
    </soap:Body>
  </soap:Envelope>
  ```
- **Steps**:
  1. Create the tool as in E2E-1 (default `onSoapFault: 'error'`).
  2. `POST .../test` with input that triggers the fault (e.g., `policy_number: 'FAULT'`).
  3. Assert response: `success: false`, `error.code: 'TOOL_SOAP_FAULT'`, `error.message` contains `'Policy not found'`.
  4. Assert `tool.execution` log entry has `protocol: 'soap'`, `success: false`, `errorCode: 'TOOL_SOAP_FAULT'`.
  5. Verify the circuit-breaker counter for the tool incremented (via the resilience-factory state inspector helper used by other tests).
- **Expected Result**: Fault classified as a tool failure regardless of HTTP status; observability captures it; breaker arms.
- **Auth Context**: Project admin, tenant A, project P1.
- **Isolation Check**: Circuit-breaker key includes `tenantId` + `toolId` so an armed breaker for tenant A's tool does not affect tenant B (verified separately in SEC-12 / INT-1).

### E2E-4: SOAP fault with `onSoapFault: 'data'` returns parsed fault as success

- **FR Coverage**: FR-7
- **Preconditions**: Same stub as E2E-3 returning a `<soap:Fault>`.
- **Steps**:
  1. Create the same tool but with `onSoapFault: 'data'`.
  2. `POST .../test` with `policy_number: 'FAULT'`.
  3. Assert response: `success: true`; `data` is a parsed JSON representation of the fault: `{ Fault: { faultcode: 'Client', faultstring: 'Policy not found' } }` (or 1.2 `Code` + `Reason` for the SOAP 1.2 variant).
  4. Assert circuit breaker counter is **not** incremented.
  5. Assert `tool.execution` log entry includes a `soap_fault: true` discriminator field for observability even though `success: true`.
- **Expected Result**: Fault data passed through; opt-in semantics work.
- **Auth Context**: Project admin, tenant A, project P1.
- **Isolation Check**: Trace and audit entries scoped to `tenantId` + `projectId` even on the success-with-fault-body path.

### E2E-5: Cross-tenant access to a SOAP tool returns 404

- **FR Coverage**: FR-8 (isolation), platform invariant: cross-tenant access returns 404 not 403
- **Preconditions**: Two tenants (A, B). Project P1 in tenant A with SOAP tool from E2E-1. Authenticated user in tenant B (separate dev-login).
- **Steps**:
  1. As tenant B user, `GET /api/projects/:pidA/tools/:toolIdA`. Assert **404** (not 403).
  2. As tenant B user, `POST /api/projects/:pidA/tools/:toolIdA/test`. Assert **404**.
  3. As tenant B user, `PUT /api/projects/:pidA/tools/:toolIdA`. Assert **404**.
  4. As tenant B user, `DELETE /api/projects/:pidA/tools/:toolIdA`. Assert **404**.
- **Expected Result**: Cross-tenant access uniformly returns 404 — no information leakage.
- **Auth Context**: Both tenants' admins authenticated via dev-login.
- **Isolation Check**: The 404 response _is_ the isolation verification — no tool metadata, existence signal, or auth-profile reference leaks across tenants.

### E2E-5b: Cross-project access to a SOAP tool returns 404 (SEC-2)

- **FR Coverage**: FR-8 (project isolation invariant)
- **Preconditions**: Single tenant A. Two projects P1 and P2, both owned by the same admin. SOAP tool from E2E-1 exists in P1.
- **Steps**:
  1. As tenant A admin, `GET /api/projects/:pidP2/tools/:toolIdP1` (using P2's path but P1's tool ID). Assert **404**.
  2. `POST /api/projects/:pidP2/tools/:toolIdP1/test`. Assert **404**.
  3. `PUT /api/projects/:pidP2/tools/:toolIdP1`. Assert **404**.
  4. `DELETE /api/projects/:pidP2/tools/:toolIdP1`. Assert **404**.
- **Expected Result**: A user with admin rights in _both_ projects cannot leak a tool from one project into the other via path manipulation. Cross-project access uniformly returns 404.
- **Auth Context**: Tenant A admin (legitimate access to both projects).
- **Isolation Check**: Project isolation is enforced at the route level even when the caller has rights to both projects.

### E2E-5c: Missing auth returns 401 on every SOAP tool route (SEC-4)

- **FR Coverage**: FR-8 (centralized auth invariant)
- **Preconditions**: SOAP tool from E2E-1 exists in P1. The HTTP client used for this scenario sends no `Authorization` header / no session cookie.
- **Steps**:
  1. `POST /api/projects/:pid/tools` with a valid SOAP tool body but no auth. Assert **401**.
  2. `GET /api/projects/:pid/tools/:toolId` with no auth. Assert **401**.
  3. `PUT /api/projects/:pid/tools/:toolId` with no auth. Assert **401**.
  4. `DELETE /api/projects/:pid/tools/:toolId` with no auth. Assert **401**.
  5. `POST /api/projects/:pid/tools/:toolId/test` with no auth. Assert **401**.
- **Expected Result**: Every SOAP-related tool route is protected by `createUnifiedAuthMiddleware` / `requireAuth`; missing auth returns 401 (not 403, not 200).
- **Auth Context**: Unauthenticated request.
- **Isolation Check**: No tool / profile data is returned in the 401 response body.

### E2E-5d: Insufficient permissions returns 403 on tool mutation (SEC-5)

- **FR Coverage**: FR-8 (RBAC invariant)
- **Preconditions**: Project P1 in tenant A. Two members in P1: a project admin (with `tool:write`) and a project member (read-only role, no `tool:write`). SOAP tool from E2E-1 exists.
- **Steps**:
  1. As project member, `GET /api/projects/:pid/tools/:toolId`. Assert **200** (read is allowed).
  2. As project member, `POST /api/projects/:pid/tools` with a valid SOAP body. Assert **403**.
  3. As project member, `PUT /api/projects/:pid/tools/:toolId`. Assert **403**.
  4. As project member, `DELETE /api/projects/:pid/tools/:toolId`. Assert **403**.
- **Expected Result**: RBAC for SOAP tools matches REST tools — read is permitted, mutation is denied with 403.
- **Auth Context**: Project member (no `tool:write` permission), tenant A, project P1.
- **Isolation Check**: 403 message does not leak the existence of a tool the caller could not otherwise see (since GET is allowed, this is moot here, but applies if read permission is later restricted).

### E2E-6: SSRF protection blocks SOAP endpoints on private IPs and cloud metadata

- **FR Coverage**: FR-8 (security)
- **Preconditions**: SSRF in production mode (`ALLOW_SSRF_PRIVATE_RANGES=false`).
- **Steps**:
  1. Attempt to create a SOAP tool with `endpoint: 'http://169.254.169.254/latest/meta-data'` (cloud metadata). Assert 400 with SSRF rejection.
  2. Repeat with `endpoint: 'http://10.0.0.5/SoapService'` (RFC 1918 Class A). Assert 400.
  3. Repeat with `endpoint: 'http://127.0.0.1:8080/SoapService'` (loopback). Assert 400.
  4. Repeat with `endpoint: 'http://[::1]/SoapService'` (IPv6 loopback). Assert 400.
  5. Repeat with `endpoint: 'http://2130706433/SoapService'` (decimal-encoded loopback). Assert 400.
  6. Repeat with `endpoint: 'http://example.com@10.0.0.1/SoapService'` (userinfo bypass). Assert 400.
- **Expected Result**: SSRF rules apply uniformly to SOAP endpoints; no protocol-specific bypass.
- **Auth Context**: Project admin, tenant A, project P1.
- **Isolation Check**: SSRF rejection is tenant-agnostic (infrastructure-level); the 400 response body must not contain tenant or project identifiers.

### E2E-7: Agent invokes a SOAP tool through a real session (gold-standard cross-feature)

- **FR Coverage**: FR-1, FR-5, FR-6, FR-7, FR-10, FR-13 — and parent feature integration
- **Preconditions**: Same harness as E2E-1, plus a model connection (LLM) seeded for the project, plus an agent DSL bound to the SOAP tool. Mirrors `tool-invocations-api.e2e.test.ts` REST/MCP/sandbox patterns. **The LLM stub must be configured to return a deterministic tool call for `lookup_policy` with `policy_number: 'P-12345'`** (canned function-call response), so the test does not depend on real model behavior. This matches the parent E2E's deterministic-LLM-stub pattern and is a hard prerequisite to avoid flake.
- **Steps**:
  1. Seed model connection (`POST /api/projects/:pid/model-connections`) and agent (`POST /api/projects/:pid/agents` with DSL referencing `lookup_policy`).
  2. Open a session via the runtime entrypoint and send a user message that should cause the LLM to call the SOAP tool (e.g., "What's the status of policy P-12345?").
  3. The runtime executes the SOAP tool through `HttpToolExecutor` → stub server.
  4. Assert the stub captured a SOAP 1.1 request with WS-Security header.
  5. Assert the agent receives a JSON tool result (envelope stripped) and produces a coherent reply.
  6. Assert the conversation history contains a tool call entry with `protocol: 'soap'`.
- **Expected Result**: SOAP tool executes through the same dispatcher as REST/MCP/sandbox tools; cross-feature integration intact; trace correlation works end-to-end.
- **Auth Context**: Project admin, tenant A, project P1, real session attribution.
- **Isolation Check**: Session, trace events, audit log entries, and tool-execution results are scoped to `tenantId` + `projectId`; session attribution tracks the authenticated user across the LLM tool-call cycle.

---

## 3. Integration Test Scenarios (MANDATORY)

Integration tests exercise real service boundaries inside a single process. **No `vi.mock` of `@agent-platform/*` or `@abl/*`. Mock only third-party externals via dependency injection.**

**Test files**:

- `packages/compiler/src/__tests__/constructs/http-tool-executor-soap.test.ts` (new)
- `apps/runtime/src/__tests__/auth/auth-profile/resolve-tool-auth-soap.test.ts` (new)
- `packages/compiler/src/__tests__/constructs/tool-lifecycle-e2e.test.ts` (extend with SOAP)

### INT-1: Envelope wrapping (1.1 + 1.2) and Content-Type framing

- **Boundary**: `HttpToolExecutor.buildRequest()` → outbound HTTP request
- **FR Coverage**: FR-5a, FR-5b, FR-5c
- **Setup**: Spin up an Express stub on `{ port: 0 }`, instantiate `HttpToolExecutor` with the project resilience factory (real `InMemoryCircuitBreaker` + `InMemoryRateLimiter`).
- **Steps**:
  1. Dispatch a SOAP 1.1 request; capture outbound headers and body.
  2. Dispatch a SOAP 1.2 request with the same input; capture again.
  3. Dispatch a SOAP 1.1 request with `soap_action` undefined; assert no `SOAPAction` header.
  4. Dispatch a request where the user-authored body already contains a `<soap:Envelope>` root; assert no double-wrapping.
- **Expected Result**:
  - 1.1: `Content-Type: text/xml; charset=utf-8`, `SOAPAction: "..."` header, envelope namespace `http://schemas.xmlsoap.org/soap/envelope/`.
  - 1.2: `Content-Type: application/soap+xml; charset=utf-8; action="..."`, no separate `SOAPAction` header, namespace `http://www.w3.org/2003/05/soap-envelope`.
- **Failure Mode**: If stub is unreachable, executor surfaces transport error — verify retry policy applies before failing.

### INT-2: WS-Security header injection from `wsSecurityCredentials`

- **Boundary**: `HttpToolExecutor` → `applyWsSecurity()` → outbound XML
- **FR Coverage**: FR-5d, FR-13
- **Setup**: Construct an `ApplyAuthResult` with `wsSecurityCredentials = { username: 'u', password: 'p', mustUnderstand: true }`. Pass it through the executor's auth context (via the same shape `patchToolWithResolvedAuth` will use post-FR-13).
- **Steps**:
  1. Dispatch a SOAP 1.1 request and capture the body.
  2. Repeat with `wsSecurityCredentials.certificate` set (X.509 PEM); capture the body.
  3. Dispatch the same tool with no `wsSecurityCredentials`; capture the body.
- **Expected Result**:
  - With credentials: body contains `<wsse:Security soap:mustUnderstand="1" xmlns:wsse="..." xmlns:wsu="...">` with `<wsse:UsernameToken>`, password digest format (NOT cleartext), nonce, created timestamp.
  - With certificate: a `<wsse:BinarySecurityToken EncodingType=".../Base64Binary" ValueType=".../X509v3">` element is present (raw base64, no PEM headers).
  - Without credentials: no `<wsse:Security>` element; body is the user-authored envelope unchanged.
- **Failure Mode**: If `applyWsSecurity()` throws (e.g., empty username), the executor surfaces a `TOOL_AUTH_FAILED` error before dispatch.

### INT-3: `wsSecurityCredentials` propagation across `resolveToolAuth` → executor

- **Boundary**: `resolveToolAuth()` → `ToolAuthResult` → `patchToolWithResolvedAuth()` → executor
- **FR Coverage**: FR-13
- **Setup**: Real MongoDB (MongoMemoryServer). Create a `ws_security` auth profile via the production code path (encryption included). Build a tool IR with `auth_profile_ref` pointing to it. Build a tool call context.
- **Steps**:
  1. Call `resolveToolAuth(tool, tenantId, env, options)` directly.
  2. Assert the returned `ToolAuthResult` contains `wsSecurityCredentials` with the decrypted username, password, and `mustUnderstand` config (post-FR-13 shape).
  3. Pass the result through `patchToolWithResolvedAuth()` (or the equivalent context-passing mechanism chosen during LLD).
  4. Construct an `HttpToolExecutor` and execute a SOAP tool; verify the `<wsse:Security>` element appears in the outbound body.
- **Expected Result**: Credentials flow uninterrupted from `apply-auth.ts:290-301` → `ToolAuthResult` → executor → SOAP envelope. Today's gap is closed.
- **Failure Mode**: If the propagation regresses (credentials dropped at `ToolAuthResult` boundary), the assertion in step 2 fails before reaching the executor.

### INT-4: WS-Security profile bound to a REST tool emits warning, no injection

- **Boundary**: `HttpToolExecutor` decision branch
- **FR Coverage**: FR-11
- **Setup**: REST tool (`protocol: 'rest'`) with auth context containing `wsSecurityCredentials`. Test logger sink configured to capture log entries.
- **Steps**:
  1. Dispatch the REST tool to a stub server.
  2. Capture outbound request body.
  3. Inspect the test logger.
- **Expected Result**:
  - Outbound body is the REST JSON/text body unchanged — no XML injected.
  - A structured warning log entry with code `WS_SECURITY_BOUND_TO_REST_TOOL` is emitted (assertable via the logger sink).
  - Tool execution still succeeds (warning is non-fatal).
- **Failure Mode**: If injection happens silently, integrity assertion fails (XML in JSON body).

### INT-5: Hardened parser configuration blocks XXE and DTD attacks

- **Boundary**: `HttpToolExecutor` response handler → `fast-xml-parser` factory
- **FR Coverage**: FR-6
- **Setup**: Direct unit-style integration on the parser factory (no HTTP). Feed three canned response bodies:
  1. `<!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><soap:Envelope ...>...&xxe;...</soap:Envelope>` — XXE.
  2. Billion-laughs payload (recursive entity declarations expanding to ~1 GB).
  3. Deeply nested element tree exceeding `HTTP_TOOL_SOAP_PARSER_MAX_DEPTH` (default 64).
- **Steps**:
  1. Parse each via the executor's response handler.
  2. Inspect the parsed result and any thrown errors.
- **Expected Result**:
  - Payload (1): external entity is **not** resolved; element value is empty or literal `&xxe;`. No file disclosure. No out-of-band fetch (test runs in a sandbox; an unexpected network call would fail it).
  - Payload (2): expansion is refused or capped — the parser does not allocate the full expanded payload.
  - Payload (3): parsing throws `TOOL_RESPONSE_PARSE_FAILED` due to depth limit.
  - Parser config introspection: `processEntities: false`, no DTD allowlist.
- **Failure Mode**: If the parser config drifts (e.g., a refactor enables `processEntities: true`), this test fails fast.

### INT-6: SOAP fault detection across both versions and HTTP statuses

- **Boundary**: `HttpToolExecutor` response handler → fault detector → `ToolExecutionError`
- **FR Coverage**: FR-7
- **Setup**: Feed the executor four canned responses:
  - SOAP 1.1 fault with HTTP 200
  - SOAP 1.1 fault with HTTP 500
  - SOAP 1.2 fault with HTTP 200 (uses `<env:Code>`/`<env:Reason>`)
  - SOAP 1.2 fault with HTTP 500
  - HTTP 500 with non-fault XML body (transport error, NOT SOAP fault)
  - HTTP 500 with non-XML body (transport error)
- **Steps**:
  1. With `on_soap_fault: 'error'`: dispatch each canned response.
  2. Repeat with `on_soap_fault: 'data'`.
- **Expected Result**:
  - With `'error'`: all four fault payloads produce `ToolExecutionError({ code: 'TOOL_SOAP_FAULT' })`. The two non-fault HTTP 500 responses produce a transport error (`TOOL_HTTP_ERROR` or equivalent), NOT `TOOL_SOAP_FAULT`.
  - With `'data'`: all four fault payloads produce a successful result with the parsed fault body. Non-fault HTTP 500 still produces a transport error.
- **Failure Mode**: If detection misses a 1.2 namespace prefix variation (`<env:Code>` vs `<soap:Code>`), this test catches it.

### INT-7: DSL → IR lockstep round-trip

- **Boundary**: `dsl-property-parser.ts` → `compileHttpBinding()` → `HttpBindingIR`
- **FR Coverage**: FR-1, FR-4
- **Setup**: Author a SOAP tool DSL string with all four new fields populated. Run it through the project tool ingestion pipeline.
- **Steps**:
  1. Parse the DSL via `dsl-property-parser.ts`.
  2. Compile the AST via `compileHttpBinding()` (and the agent DSL parser via `agent-based-parser.ts` denylist check).
  3. Inspect the resulting `HttpBindingIR`.
  4. Reverse: serialize the form data back to DSL via `serialize-tool-form-to-dsl.ts:serializeHttpProperties`.
- **Expected Result**: All four fields (`protocol`, `soap_version`, `soap_action`, `on_soap_fault`) round-trip with no loss. A REST tool (no `protocol` field) compiles to an `HttpBindingIR` with `protocol === undefined` (or default `'rest'`) and serializes back to DSL with no SOAP-specific lines (byte-identical to today's REST DSL output).
- **Failure Mode**: If any of the three lockstep sites are missed, this test fails — pinpoints which site needs the field added.

---

## 4. Unit Test Scenarios

**File**: `packages/compiler/src/__tests__/constructs/http-tool-executor-soap.test.ts` (new)

- **U-1**: Envelope wrapping for SOAP 1.1 produces correct namespace and root element ordering.
- **U-2**: Envelope wrapping for SOAP 1.2 differs only in namespace and Content-Type.
- **U-3**: Double-wrap detection: user body containing `<soap:Envelope>` is dispatched as-is (with WS-Security still injected into the existing `<Header>` if present, or `<Header>` synthesized if absent).
- **U-4**: Namespace-prefix tolerance: parsed responses using `soapenv:`, `SOAP-ENV:`, or `soap:` prefixes are all unwrapped correctly.
- **U-5**: SOAPAction header omitted when `soap_action` is null/undefined.
- **U-6**: Header CRLF injection in `soap_action` is stripped by `sanitizeHeaderValue`.
- **U-7**: WS-Security header is injected idempotently — calling the build twice produces equivalent output (modulo the per-call Nonce/Created).
- **U-8**: Hardened parser config: `processEntities: false`, `allowBooleanAttributes: false`, no DTD.
- **U-9**: One-way SOAP response (no `<Body>`) — executor returns the agreed-upon shape (per HLD decision on Open Question #2).
- **U-10**: Response unwrap for 1.1: `<soap:Envelope><soap:Body><SomeElement>...</SomeElement></soap:Body></soap:Envelope>` returns the parsed JSON of `<SomeElement>...`.
- **U-11**: Response unwrap for 1.2 with the 1.2 namespace.
- **U-12**: Fault detection: `<faultcode>`/`<faultstring>` for 1.1, `<Code>`/`<Reason>` for 1.2.
- **U-13**: Fault classification with `on_soap_fault: 'error'` throws structured `ToolExecutionError`.
- **U-14**: Fault classification with `on_soap_fault: 'data'` returns success result with parsed fault body.
- **U-15**: Existing REST tool path unchanged when `protocol` field is absent (regression).
- **U-16**: Tool with explicit `protocol: 'rest'` produces byte-identical request to a tool without `protocol`.
- **U-4b** (added 2026-04-28): `{{input.X}}` placeholder resolution in `soap_action` — verifies the action value is resolved before being sent as the SOAPAction header.
- **U-4c** (added 2026-04-28): `{{secrets.X}}` placeholder resolution in `soap_action` — verifies secret values are resolved in the action field.
- **Pre-wrap XML declaration** (added 2026-04-28): Body starting with `<?xml version="1.0"?>` followed by `<soap:Envelope>` is correctly detected as pre-wrapped (no double-wrapping).

**File**: `packages/shared/src/__tests__/serialize-tool-form-to-dsl-soap.test.ts` (new)

- **U-17**: `serializeHttpProperties` emits `protocol: soap`, `soap_version: 1.1`, `soap_action: ...`, `on_soap_fault: error` lines when SOAP fields are set.
- **U-18**: Omits SOAP lines when `protocol === 'rest'` (no diff vs. existing REST DSL output).
- **U-19**: `parseDslToToolForm` round-trips the four fields back to form state.

**File**: `packages/shared/src/__tests__/project-tool-schemas-soap.test.ts` (new)

- **U-20**: Defaults: missing `protocol` resolves to `'rest'`; missing `onSoapFault` resolves to `'error'`.
- **U-21**: Cross-field validation per FR-12:
  - `protocol: 'rest'` + `soapAction: '...'` → reject with descriptive ZodError.
  - `protocol: 'soap'` without `soapVersion` → reject (or default applied per LLD decision).
  - `protocol: 'soap'` with `soapVersion: '1.1'` and `soapAction: '...'` → accept.
- **U-22**: `protocol` enum rejects unknown values like `'graphql'`.

**File**: `apps/studio/src/__tests__/components/tools/HttpConfigForm-soap.test.tsx` (new)

- **U-23**: Selecting "Protocol: SOAP" reveals SOAP version radio, SOAPAction field, fault selector.
- **U-24**: Selecting "Protocol: REST" hides SOAP fields and clears `soapVersion` / `soapAction` from the emitted config.
- **U-25**: SOAP body template prefilled with envelope skeleton when SOAP is first selected; user-edited body is preserved on subsequent toggles.
- **U-26**: When SOAP is selected, method selector forces POST and body type selector is locked to XML.

**File**: `packages/auth-enterprise/src/__tests__/ws-security-auth.test.ts` (existing — no change required for v1; already covers `applyWsSecurity()` shape).

---

## 5. Security & Isolation Tests

These are **not** checkboxes — each is a concrete test scenario that must pass before BETA.

| #      | Scenario                                                                                                                         | Coverage Type    | File                                                                          |
| ------ | -------------------------------------------------------------------------------------------------------------------------------- | ---------------- | ----------------------------------------------------------------------------- |
| SEC-1  | Cross-tenant SOAP tool access returns 404                                                                                        | E2E (E2E-5)      | `apps/studio/src/__tests__/e2e/soap-tool.e2e.test.ts`                         |
| SEC-2  | Cross-project SOAP tool access returns 404 (project A in tenant A vs project B in tenant A)                                      | E2E (E2E-5b)     | same                                                                          |
| SEC-3  | Cross-user `personal` `ws_security` profile invisible across users in same project                                               | Integration      | `apps/runtime/src/__tests__/auth/auth-profile/resolve-tool-auth-soap.test.ts` |
| SEC-4  | Missing auth → 401 on tool create / read / update / delete / test                                                                | E2E (E2E-5c)     | `apps/studio/src/__tests__/e2e/soap-tool.e2e.test.ts`                         |
| SEC-5  | Insufficient permissions (project member without `tool:write`) → 403 on create/update/delete                                     | E2E (E2E-5d)     | same                                                                          |
| SEC-6  | SSRF: private IPs, cloud metadata, IPv6 loopback, decimal/octal IP encoding, userinfo bypass                                     | E2E (E2E-6)      | same                                                                          |
| SEC-7  | XXE: external entity references in SOAP responses are not resolved                                                               | Integration      | `packages/compiler/.../http-tool-executor-soap.test.ts` (INT-5)               |
| SEC-8  | Billion-laughs / deep-nesting parser DoS is refused                                                                              | Integration      | same (INT-5)                                                                  |
| SEC-9  | Header injection: CRLF in `soap_action` is stripped                                                                              | Unit (U-6)       | same                                                                          |
| SEC-10 | Credentials never leak: `<wsse:Password>` is digested (not cleartext); secrets never appear in API responses or trace events     | E2E              | `apps/studio/src/__tests__/e2e/soap-tool.e2e.test.ts` + assertions            |
| SEC-11 | Input validation: malformed SOAP version, unknown `protocol` value, oversized body — rejected at API boundary                    | Unit (U-21,U-22) | `packages/shared/src/__tests__/project-tool-schemas-soap.test.ts`             |
| SEC-12 | Circuit-breaker keys include `tenantId` so a misbehaving SOAP endpoint in tenant A does NOT trip the breaker for tenant B's tool | Integration      | `packages/compiler/.../http-tool-executor-soap.test.ts`                       |

---

## 5b. Surface Semantics & Design-Time vs Runtime Verification

The feature has a clear control-plane / runtime split (feature spec §8). The test spec verifies both halves end-to-end:

| Surface                           | What's verified                                                                                                                                                                            | Coverage                                       |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------- |
| **Design-time**                   | Studio Protocol toggle reveals SOAP fields (version, action, fault handling); body type forces XML; method forces POST; SOAP envelope skeleton prefilled; user edits preserved on toggles. | U-23..U-26 (`HttpConfigForm-soap.test.tsx`)    |
| **Design-time**                   | DSL serializer emits SOAP lines only when `protocol === 'soap'`; absent fields produce a REST-identical DSL output.                                                                        | U-17..U-19, INT-7                              |
| **Design-time**                   | API validation rejects `soap_action` on REST tools and missing `soap_version` on SOAP tools (FR-12).                                                                                       | U-20..U-22                                     |
| **Design-time**                   | Studio Test endpoint (`POST /tools/:id/test`) renders the envelope server-side and (when debug allows) returns the rendered request for the preview panel.                                 | E2E-1 step 5 (response inspection); M-2 manual |
| **Runtime**                       | `HttpToolExecutor` wraps the resolved body template into a SOAP envelope keyed by `soap_version`; double-wraps detected; correct namespace for 1.1 vs 1.2.                                 | INT-1, U-1..U-3, E2E-1, E2E-2                  |
| **Runtime**                       | `applyWsSecurity()` output is injected into the envelope `<Header>` at request time, not at definition time. Credentials never appear at design-time surfaces.                             | INT-2, INT-3, E2E-1                            |
| **Runtime**                       | Response envelope and `<Body>` are stripped before the result reaches the LLM; tool-result compaction operates on JSON.                                                                    | U-10, U-11, E2E-1                              |
| **Runtime**                       | Trace event includes `protocol`, `soap_version`, `soap_action` discriminators (FR-10).                                                                                                     | E2E-1 step 6, E2E-3 step 4                     |
| **Author-name → IR-name mapping** | `Protocol` ↔ `protocol`; `SOAP Version` ↔ `soap_version`; `SOAP Action` ↔ `soap_action`; `Fault Handling` ↔ `on_soap_fault`. Camel-case in API/UI; snake-case in DSL/IR.                   | INT-7                                          |

Cross-references to the feature spec's surface semantics matrix (§8) and design-time-vs-runtime narrative are intentional — the test spec is the contract that those design choices actually ship.

---

## 5c. Critical Feature Gate Coverage

SOAP support introduces three security-sensitive gates that must remain stable across refactors. These are tracked explicitly so a future change cannot silently weaken them.

| Gate                              | What it protects                                                                                                                                                   | Verification                                                                                                                  | Fail-closed?                                                            |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| **XML parser hardening**          | XXE (external entities), billion-laughs (entity expansion), DTD-based attacks, deep-nesting DoS                                                                    | INT-5 (XXE, billion-laughs, deep nesting); SEC-7, SEC-8; parser config introspection asserts `processEntities: false`         | Yes — parse fails closed; payload is rejected, never partially expanded |
| **Header injection sanitizer**    | CRLF in `soap_action` or custom headers — prevents HTTP request smuggling / response splitting                                                                     | U-6; existing `sanitizeHeaderValue` regression continues to apply                                                             | Yes — CRLF stripped; request still dispatched without header injection  |
| **WS-Security credential gating** | WS-Security `<wsse:Security>` injected only when the resolved auth profile is `ws_security` AND the tool's `protocol === 'soap'`. Never injected into REST bodies. | INT-4 (REST tool with `wsSecurityCredentials` → no injection, warning emitted); FR-11; SEC-10                                 | Yes — silent no-op + warning log on REST tool; no XML in JSON body      |
| **SSRF**                          | Outbound SOAP requests blocked from private IPs, cloud metadata, IPv6 loopback, encoded-IP bypass, userinfo bypass                                                 | E2E-6 (six SSRF variants); SEC-6; existing `safeFetch` / `assertUrlSafeForFetch` regression                                   | Yes — request rejected with `SSRF_BLOCKED`                              |
| **Credential exposure**           | WS-Security `<wsse:Password>` is digested (never cleartext); secrets never returned in API responses or stored in trace event payloads                             | E2E-1 step 4 (digest assertion); SEC-10; existing audit log redaction                                                         | Yes — digest is non-reversible; cleartext password is never serialized  |
| **Terminology stability**         | `protocol` / `soap_version` / `soap_action` / `on_soap_fault` names match across DSL ↔ IR ↔ API ↔ UI ↔ trace event                                                 | INT-7 (round-trip across all three lockstep sites); §5b mapping table; coverage matrix                                        | N/A (compile-time invariant, type-checked)                              |
| **Rollout / rollback**            | Existing REST tools must behave identically to today when no `protocol` field is present                                                                           | U-15, U-16 (regression); existing `http-tool-executor.test.ts` suite must remain green; coverage matrix row 10a EXISTING PASS | N/A — feature is purely additive                                        |

> A regression in any of these gates is a **release blocker**, not a deferred fix. The audit log keyword `WS_SECURITY_BOUND_TO_REST_TOOL` (FR-11) gives operators a tripwire if a misconfiguration silently disables WS-Security injection.

---

## 6. Performance & Load Tests

**Not in scope for the test spec.** SOAP support reuses the existing REST resilience stack (keep-alive socket pool, retry, circuit breaker, rate limiter), which is already load-tested at the parent feature level. WS-Security header generation is sub-millisecond (Node `crypto` SHA-1 + base64).

If a SOAP-specific load profile is needed (e.g., to validate XML parsing overhead under throughput), it should be tracked as a follow-up effort under the `load-test-analysis` and `saturation-finder` skills, not duplicated in this test spec.

A per-test circuit-breaker arming behavior IS covered as part of INT-6 (fault detection arms the breaker) and SEC-12 (tenant isolation of breaker keys).

---

## 7. Test Infrastructure

### Required services

| Service           | Mechanism                                           | Notes                                                                                                              |
| ----------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| MongoDB           | `MongoMemoryServer` (`mongodb-memory-server`)       | Real, in-process. Same as `tool-invocations-api.e2e.test.ts:198-237`.                                              |
| Redis             | `redis-server` subprocess on a random port          | Same as parent E2E. Required by Studio's initialized `redis-client`. **Not** required by SOAP-specific resilience. |
| Studio Express    | Wraps Next.js route handlers; full middleware chain | Same as parent E2E. Auth, tenant isolation, validation, audit middleware all execute.                              |
| SOAP stub server  | Local Express on `{ port: 0 }`                      | New fixture: `apps/studio/src/__tests__/e2e/fixtures/soap-stub-server.ts`. Two instances (1.1 + 1.2).              |
| Encryption        | Real `@agent-platform/shared/crypto` (AES-256-GCM)  | No mock. Auth profile secrets encrypted at rest exactly like production.                                           |
| Trace / audit log | In-memory test sink                                 | Captures `tool_call` events and `tool.execution` log entries for assertion. No mock of the trace manager.          |

### Data seeding (per E2E test setup)

1. Dev-login session for tenant A admin (and tenant B admin for isolation tests).
2. Project P1 in tenant A.
3. Model connection (LLM) seeded for E2E-7 only.
4. `ws_security` auth profile (with real-encrypted secrets).
5. SOAP tool DSL referencing the auth profile and `{{input.X}}` placeholders.
6. Agent DSL bound to the SOAP tool (E2E-7 only).
7. Stub SOAP servers running on random ports (1.1 + 1.2).

### Environment variables (test runner)

| Variable                           | Value              | Purpose                                                                     |
| ---------------------------------- | ------------------ | --------------------------------------------------------------------------- |
| `MONGOMS_VERSION`                  | `7.0.20` (default) | MongoMemoryServer binary version (matches parent E2E).                      |
| `REDIS_SERVER_BIN`                 | path / fallback    | Redis binary; matches parent E2E candidate list.                            |
| `ALLOW_SSRF_PRIVATE_RANGES`        | `false`            | Required for SSRF tests (E2E-6) to behave like production.                  |
| `HTTP_TOOL_MAX_RESPONSE_BYTES`     | default            | Use default (10 MB); the `Big` stub endpoint exercises the cap.             |
| `HTTP_TOOL_SOAP_PARSER_MAX_DEPTH`  | default (`64`)     | Used by INT-5 deep-nesting test.                                            |
| `HTTP_TOOL_SOAP_DEBUG_RAW_REQUEST` | unset / `false`    | Off for security-sensitive tests; on only when verifying the debug surface. |

### CI configuration

- Suite runs in the existing `apps/studio` test pipeline alongside `tool-invocations-api.e2e.test.ts`.
- Suite + hook timeouts mirror parent E2E: `TEST_TIMEOUT_MS = 120_000`, `SUITE_HOOK_TIMEOUT_MS = 300_000`.
- Pre-commit hook `.claude/hooks/e2e-test-quality-lint.sh` will block any `vi.mock` of platform packages or direct DB access in this file — verified at commit time.

---

## 8. Test File Mapping

| Test File                                                                           | Type        | Covers                                                                                                            |
| ----------------------------------------------------------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------- |
| `apps/studio/src/__tests__/e2e/soap-tool.e2e.test.ts` (new)                         | E2E         | E2E-1..E2E-7; SEC-1, SEC-2, SEC-4, SEC-5, SEC-6, SEC-10                                                           |
| `apps/studio/src/__tests__/e2e/fixtures/soap-stub-server.ts` (new)                  | Fixture     | Stub SOAP 1.1 + 1.2 servers; canned responses; fault payloads; XXE / billion-laughs payloads; capture endpoint    |
| `packages/compiler/src/__tests__/constructs/http-tool-executor-soap.test.ts` (new)  | Integration | INT-1, INT-2, INT-4, INT-5, INT-6; U-1..U-16; SEC-7, SEC-8, SEC-9, SEC-12                                         |
| `apps/runtime/src/__tests__/auth/auth-profile/resolve-tool-auth-soap.test.ts` (new) | Integration | INT-3 (FR-13 propagation), SEC-3                                                                                  |
| `packages/compiler/src/__tests__/constructs/tool-lifecycle-e2e.test.ts` (extend)    | Integration | INT-7 (DSL → IR lockstep round-trip)                                                                              |
| `packages/shared/src/__tests__/serialize-tool-form-to-dsl-soap.test.ts` (new)       | Unit        | U-17, U-18, U-19; FR-4                                                                                            |
| `packages/shared/src/__tests__/project-tool-schemas-soap.test.ts` (new)             | Unit        | U-20, U-21, U-22; FR-2, FR-12; SEC-11                                                                             |
| `apps/studio/src/__tests__/components/tools/HttpConfigForm-soap.test.tsx` (new)     | Unit (UI)   | U-23, U-24, U-25, U-26; FR-9                                                                                      |
| `apps/studio/src/__tests__/tool-test-service.test.ts` (extended)                    | Unit        | SOAPAction display (quoted), `{{session.X}}` display, HTTP status mapping (TOOL_TIMEOUT→504, TOOL_SOAP_FAULT→200) |
| `packages/auth-enterprise/src/__tests__/ws-security-auth.test.ts` (existing)        | Unit        | `applyWsSecurity()` helper — no change required                                                                   |
| `packages/shared/src/__tests__/auth-profile/apply-auth-phase3.test.ts` (existing)   | Unit        | `ws_security` case in `applyAuth()` — no change required                                                          |
| `packages/compiler/src/__tests__/constructs/http-tool-executor.test.ts` (existing)  | Unit        | Existing REST coverage — must remain green (regression baseline)                                                  |
| `packages/compiler/src/__tests__/constructs/tool-binding-executor.test.ts` (extend) | Unit        | Verify dispatcher routes SOAP tools through `HttpToolExecutor` (no protocol-aware dispatch)                       |

---

## 9. Manual Test Plan

| #   | Scenario                                                                              | Validation Approach                                                                                                      |
| --- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| M-1 | Author a SOAP 1.1 tool against a public test SOAP service (e.g., a calculator WSDL)   | Create tool in Studio, run **Test** with sample input, verify response renders as JSON in `ToolTestPanel`.               |
| M-2 | Bind a `ws_security` auth profile and re-run M-1                                      | Verify the request preview shows the rendered envelope with `<wsse:Security>` injected (when debug mode is enabled).     |
| M-3 | Trigger a SOAP fault by sending invalid input                                         | Verify `ToolTestPanel` shows the structured error with `TOOL_SOAP_FAULT` code and `faultstring` content.                 |
| M-4 | Toggle Protocol back to REST                                                          | Verify SOAP fields disappear, body type returns to JSON, method selector unlocks.                                        |
| M-5 | Bind the SOAP tool to an agent and exercise it through a Studio session               | Verify the agent receives a JSON tool result, references fields normally, and the trace explorer shows `protocol: soap`. |
| M-6 | Author a SOAP 1.2 tool, validate the Content-Type and namespace differences via debug | Same as M-1 but with `soapVersion: '1.2'`. Confirm `application/soap+xml` Content-Type in the debug request preview.     |

---

## 10. Production Wiring Verification

| Surface                                                                        | Verification                                                                                           |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `apps/studio/src/app/api/projects/[id]/tools/route.ts` (POST/GET)              | Accepts and persists the four new fields; rejects per FR-12.                                           |
| `apps/studio/src/app/api/projects/[id]/tools/[toolId]/route.ts` (PUT/DELETE)   | Updates accept the new fields; existing tools without them keep REST behavior.                         |
| `apps/studio/src/app/api/projects/[id]/tools/[toolId]/test/route.ts`           | Renders SOAP envelope server-side; returns parsed response and (when debug enabled) rendered request.  |
| `apps/runtime/src/tools/load-project-tools-as-ir.ts`                           | Compiles `protocol`/`soap_version`/`soap_action`/`on_soap_fault` into `HttpBindingIR`.                 |
| `apps/runtime/src/services/execution/llm-wiring.ts`                            | Wires the executor with the resilience factory; no SOAP-specific wiring required (verified per INT-1). |
| `apps/runtime/src/services/auth-profile/auth-profile-tool-middleware.ts`       | `patchToolWithResolvedAuth` (or equivalent) surfaces `wsSecurityCredentials` to the executor.          |
| `apps/runtime/src/services/auth-profile/resolve-tool-auth.ts`                  | `ToolAuthResult` includes `wsSecurityCredentials` (post-FR-13).                                        |
| `packages/compiler/src/platform/constructs/executors/tool-binding-executor.ts` | Continues to dispatch HTTP tools to `HttpToolExecutor` regardless of `protocol`.                       |

---

## 11. Open Testing Questions

1. **Stub server fidelity vs. real third-party SOAP**. The stub gives deterministic test coverage but cannot validate quirks of real services. Should we add a nightly-only suite hitting a public SOAP service (e.g., `http://www.dneonline.com/calculator.asmx`)? Tracked as feature spec GAP-007.
2. ~~**One-way SOAP operations**~~ **RESOLVED (D-12)**: Returns `{ oneWay: true }`. Covered by `parseSoapResponse` empty-Body path in `http-tool-executor-soap.test.ts`.
3. ~~**Auto-XML-escaping of `{{input.X}}` placeholders**~~ **RESOLVED (D-11)**: Auto-escape is the v1 default. `escapeForXmlBodyTemplate` flag threaded through all 6 placeholder resolvers; covered by XML-escaping placeholder test in `http-tool-executor-soap.test.ts`.
4. ~~**Test-endpoint envelope visibility**~~ **RESOLVED (D-9/D-10)**: `?debug=true` gated behind `tool:write`; nonce/timestamp redacted. Covered by `apps/studio/src/app/api/projects/[id]/tools/[toolId]/test/route.ts` implementation.
5. **Connector-tool SOAP backports** — if a future sub-feature lets connector tools call SOAP backends, INT-6 (fault detection) and INT-1 (envelope wrapping) should extend through the connector executor. Pending feature spec Open Question #6.

---

## 12. Status

**ALPHA (2026-04-28).** All 4 LLD phases implemented. SOAP stub server fixture (`soap-stub-server.ts`), E2E test suite (`soap-tool.e2e.test.ts`) with 8 scenarios (E2E-1 through E2E-7 + E2E-5b/5c; E2E-5d is missing — RBAC 403 for tool:execute-only user), and INT-7 DSL round-trip extended in `tool-lifecycle-e2e.test.ts`. Feature promoted to ALPHA.

**Post-ALPHA fixes (2026-04-28)**:

- SOAPAction header now RFC-quoted (GAP-008 closed). All SOAPAction test assertions updated.
- XML declaration pre-wrap detection fixed (GAP-009 closed). New unit test added.
- Full placeholder resolution for `soap_action` (`{{_context.X}}`, `{{session.X}}` now resolved). Unit tests U-4b, U-4c added.
- Studio tool-test-service: SOAPAction display shows quoted form; `{{session.X}}` display support; HTTP status helpers added.
- New flat Studio route `apps/studio/src/app/api/tool-test/[projectId]/[toolId]/route.ts` for Turbopack workaround.

**Deviation — E2E-7**: As implemented, `soap-tool.e2e.test.ts` labels "E2E-7" as a SOAPAction header verification test (FR-5c), not the agent-bound session integration scenario documented in §2. The agent-session integration scenario (full LLM tool-call loop) is deferred to BETA. FR-5c SOAPAction coverage is satisfied; FR-10/FR-13 cross-feature agent-session coverage remains open (GAP-007 adjacent).

> Full implementation file mapping: feature spec [`§10 Key Implementation Files`](../../features/sub-features/soap-tool-support.md#10-key-implementation-files).
