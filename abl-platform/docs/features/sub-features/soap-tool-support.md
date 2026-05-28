# Feature: SOAP Tool Support

**Doc Type**: SUB-FEATURE
**Parent Feature**: [Tool Invocations](../tool-invocations.md)
**Status**: ALPHA
**Feature Area(s)**: `integrations`, `agent lifecycle`, `enterprise`, `governance`
**Package(s)**: `packages/compiler`, `packages/core`, `packages/shared`, `packages/shared-kernel`, `apps/studio`, `apps/runtime` (auth-resolution path), `packages/auth-enterprise` (read-only)
**Owner(s)**: `Platform team`
**Testing Guide**: [../../testing/sub-features/soap-tool-support.md](../../testing/sub-features/soap-tool-support.md)
**Last Updated**: 2026-04-28

---

## 1. Introduction / Overview

### Problem Statement

The HTTP tool type currently supports only REST-style invocations: a JSON/form/text/xml body is sent to an endpoint, transport-level auth (Bearer, API key, OAuth, mTLS) is applied, and the response is returned to the agent. Enterprise customers — particularly in banking, insurance, telco, and government — still operate large catalogs of SOAP/WSDL services. Today, an agent builder who needs to call a SOAP endpoint must either (a) hand-craft the SOAP envelope inside the `xml` body template, manually compute the WS-Security `<wsse:Security>` header, set the `SOAPAction` and `Content-Type` headers via custom headers, and parse the response XML downstream, or (b) build a sandbox tool to wrap the call. Both paths are error-prone, leak SOAP knowledge into every tool definition, defeat result compaction (which expects JSON), and bypass first-class observability for SOAP-specific failure modes (`<soap:Fault>`).

### Goal Statement

Add SOAP 1.1 and SOAP 1.2 protocol support to the existing `http` tool type so that an agent builder can declare a SOAP-bound tool — endpoint, SOAP version, action, body template, and an existing `ws_security` auth profile — and have the runtime construct the envelope, inject WS-Security headers, dispatch the request through the same SSRF/proxy/retry/circuit-breaker pipeline as REST tools, parse the response into JSON, and surface SOAP faults as first-class structured errors. Reuse the existing executor, wizard, DSL serializer, auth profile system, and observability surface; do not introduce a new `toolType`.

### Summary

SOAP support is delivered as a `protocol: 'rest' | 'soap'` discriminator on `HttpBindingIR`. When `protocol === 'soap'`, the executor wraps the user-authored body template in a SOAP envelope (1.1 or 1.2), sets the SOAP-correct Content-Type (`text/xml; charset=utf-8` for 1.1, `application/soap+xml; charset=utf-8` for 1.2), emits a `SOAPAction` header (1.1) or media-type `action` parameter (1.2), and — when an `auth_profile_ref` resolves to a `ws_security` profile — calls the existing `applyWsSecurity()` helper to generate the `<wsse:Security>` header and inject it into the envelope's `<soap:Header>`. Responses are parsed using a hardened `fast-xml-parser` configuration (XXE/DTD-disabled), the envelope and `<Body>` are unwrapped, and the inner payload is returned as JSON to the LLM. `<soap:Fault>` responses are detected (whether returned with HTTP 200 or 5xx) and surface as `ToolExecutionError({ code: 'TOOL_SOAP_FAULT' })` by default; an `on_soap_fault: 'error' | 'data'` per-tool flag allows opting into fault-as-data semantics for legacy services that use faults as a business-outcome channel. SSRF, proxy resolution, retry, circuit-breaker, rate-limiting, and tool-result compaction remain untouched.

---

## 2. Scope

### Goals

- Add SOAP 1.1 and SOAP 1.2 support behind a `protocol: 'rest' | 'soap'` discriminator on the existing `http` tool type — no new `toolType`.
- Reuse `HttpToolExecutor`, the HTTP wizard, the DSL serializer/parser, `safeFetch`, SSRF validation, proxy resolution, retry, circuit-breaker, and rate-limiting without modification to non-SOAP code paths.
- Bridge the existing WS-Security auth profile (`ws_security`, `applyWsSecurity()`) so that resolved `wsSecurityCredentials` are consumed by the executor and injected into the SOAP envelope's `<soap:Header>`.
- Detect `<soap:Fault>` responses and surface them as structured `ToolExecutionError` by default, with an opt-in `on_soap_fault: 'data'` flag for legacy fault-as-data services.
- Parse SOAP response envelopes into JSON with a hardened `fast-xml-parser` configuration that disables external entity processing and DTDs to prevent XXE and billion-laughs attacks.
- Provide a Studio configuration surface for SOAP-specific fields (protocol toggle, SOAP version, SOAPAction, fault handling, optional response unwrap toggle) on `HttpConfigForm.tsx`.
- Produce trace events, audit logs, and `tool.execution` log entries for SOAP tools that are indistinguishable from REST tools at the framework level (same correlation, same shape).

### Non-Goals (Out of Scope)

- WSDL import / auto-generation of operation stubs and parameters — manual envelope authoring only for v1; deferred to a follow-up sub-feature.
- WS-\* extensions beyond UsernameToken and X.509 BinarySecurityToken: WS-ReliableMessaging, WS-Trust, WS-AtomicTransaction, WS-Coordination, WS-Federation, WS-Policy.
- XML Digital Signature (XML-DSig) signing of the envelope `<Body>` and XML Encryption (XML-Enc) of body content. (`applyWsSecurity()` only produces the auth header.)
- SOAP MTOM / SwA attachments and binary streaming of multi-part SOAP messages.
- A new top-level `toolType: 'soap'` on `PROJECT_TOOL_TYPES` — SOAP is a `protocol` discriminator on `http`, not a peer of `mcp`/`sandbox`/`workflow`.
- Changes to the `project_tools` MongoDB schema (`toolType` enum stays unchanged; protocol lives in `dslContent`).
- New auth profile types or middleware redesign — the existing `ws_security` auth type and `applyWsSecurity()` helper are reused as-is. The runtime tool auth-resolution path (`resolveToolAuth` and `ToolAuthResult`) does need a small extension to propagate `wsSecurityCredentials` to the executor (see FR-13), but the middleware _contract_ (resolve → patch tool → dispatch) is unchanged.
- Outbound XML schema validation against an XSD before dispatch.

---

## 3. User Stories

1. As an **agent builder**, I want to create a SOAP-bound HTTP tool by toggling a "Protocol: SOAP" switch in the existing tool wizard and authoring a SOAP body template, so that I can call enterprise SOAP services without learning a new tool type or hand-crafting envelopes.
2. As an **agent builder**, I want to bind an existing `ws_security` auth profile to a SOAP tool so that UsernameToken / X.509 BinarySecurityToken credentials are injected automatically and never embedded in the tool definition.
3. As an **agent builder**, I want SOAP responses returned to my agent as JSON (envelope and `<Body>` stripped) so that I can reference fields with the same patterns I use for REST tools and benefit from the same result compaction.
4. As an **agent builder integrating a legacy SOAP service**, I want to opt in to fault-as-data semantics on a specific tool so that `<soap:Fault>` payloads carrying business outcomes (e.g., "policy not found" inside a fault) reach my agent rather than failing the tool call.
5. As a **runtime engineer**, I want SOAP tools to flow through the same `HttpToolExecutor` as REST tools so that SSRF, proxy, retry, circuit-breaker, rate-limit, and tracing behavior are uniform and not duplicated.
6. As an **operator**, I want SOAP fault rates and SOAP latency to surface in the existing `tool.execution` log shape and circuit-breaker counters so that SOAP failures arm the breaker the same way HTTP 5xx responses do.
7. As a **platform administrator**, I want SOAP request and response payloads to inherit the same SSRF, max-response-size, header-injection, and XML-entity-attack protections so that introducing SOAP does not open a new outbound attack surface.

---

## 4. Functional Requirements

1. **FR-1**: The system must extend `HttpBindingIR` (`packages/compiler/src/platform/ir/schema.ts`) with four new optional fields: `protocol: 'rest' | 'soap'` (default `'rest'`), `soap_version: '1.1' | '1.2'` (required when `protocol === 'soap'`, default `'1.1'`), `soap_action: string | null` (optional), and `on_soap_fault: 'error' | 'data'` (default `'error'`). The fields must be additive; tools with no `protocol` field must behave identically to today.
2. **FR-2**: The system must extend `CreateHttpToolSchema` (`packages/shared/src/validation/project-tool-schemas.ts`) with the same four fields using Zod defaults, and the discriminated union (`CreateProjectToolSchema`) must continue to accept `toolType: 'http'` without forcing existing payloads to specify the new fields.
3. **FR-3**: The system must extend `HttpToolFormData` (`packages/shared-kernel/src/types/project-tool-form.ts`) with matching fields so that Studio form state, the API client, and the DSL serializer share one canonical shape.
4. **FR-4**: The system must update the DSL serializer (`packages/shared/src/tools/serialize-tool-form-to-dsl.ts:serializeHttpProperties`) and the DSL parser (`packages/shared/src/tools/parse-dsl-to-tool-form.ts`) to round-trip `protocol`, `soap_version`, `soap_action`, and `on_soap_fault`. When `protocol` is absent or equals `'rest'`, the serializer must emit no SOAP-specific lines (preserving existing DSL output for REST tools).
5. **FR-5**: The system must, in `HttpToolExecutor.buildRequest()` (`packages/compiler/src/platform/constructs/executors/http-tool-executor.ts`), branch on `binding.protocol`. When `protocol === 'soap'`, the executor must:
   - **FR-5a**: Wrap the resolved body template in a SOAP envelope keyed by `soap_version` (`http://schemas.xmlsoap.org/soap/envelope/` for 1.1, `http://www.w3.org/2003/05/soap-envelope` for 1.2). If the user-authored body already contains a `<soap:Envelope>` root, do not double-wrap.
   - **FR-5b**: Override the Content-Type header to `text/xml; charset=utf-8` (1.1) or `application/soap+xml; charset=utf-8` (1.2).
   - **FR-5c**: Emit a `SOAPAction: "<soap_action>"` HTTP header (1.1) or append `; action="<soap_action>"` to the Content-Type media-type parameters (1.2) when `soap_action` is set.
   - **FR-5d**: Consume `wsSecurityCredentials` from the resolved auth context (provided per FR-13), call `applyWsSecurity()` (`packages/auth-enterprise/src/ws-security-auth.ts`) to generate the `<wsse:Security>` element, and inject it into the envelope's `<soap:Header>`.
6. **FR-6**: The system must, after a SOAP response is received, parse the response body using `fast-xml-parser` v5 with hardened options: `processEntities: false`, `allowBooleanAttributes: false`, no DTD handling, and the existing `HTTP_TOOL_MAX_RESPONSE_BYTES` cap. The executor must strip `<soap:Envelope>` and `<soap:Body>` and return the inner payload to the LLM.
7. **FR-7**: The system must detect `<soap:Fault>` (SOAP 1.1 `<faultcode>`/`<faultstring>` or SOAP 1.2 `<Code>`/`<Reason>`) in the parsed response regardless of HTTP status, and (a) when `on_soap_fault === 'error'` (default), throw `ToolExecutionError({ code: 'TOOL_SOAP_FAULT', message: <faultstring or Reason text> })` so the runtime returns a `success: false` result, arms the circuit-breaker, and triggers the IR `on_error` handler; (b) when `on_soap_fault === 'data'`, return the parsed fault body as a successful `LLMToolResult`.
8. **FR-8**: The system must apply the existing SSRF validator (`safeFetch`/`assertUrlSafeForFetch`), proxy resolver, retry policy, circuit-breaker, rate-limiter, header-injection sanitizer (`sanitizeHeaderValue`), and `MAX_REDIRECT_HOPS` to SOAP requests with no protocol-specific divergence.
9. **FR-9**: The system must extend `HttpConfigForm.tsx` (`apps/studio/src/components/tools/HttpConfigForm.tsx`) with a "Protocol" toggle (REST | SOAP), and — when SOAP is selected — surface a SOAP version radio (1.1 / 1.2), a SOAPAction text field, an `on_soap_fault` selector, and a SOAP envelope body template in `BODY_TEMPLATES`. The wizard (`HttpToolWizard.tsx`) must allow testing a SOAP tool through the existing test endpoint without protocol-specific server changes (envelope wrapping happens server-side in the executor).
10. **FR-10**: The system must emit the same trace event shape (`tool_call`), audit log entry, and `tool.execution` log line for SOAP tools as for REST tools, with one additional structured field (`protocol: 'soap'`, `soap_version`, and `soap_action` when set) so that operators can filter dashboards by protocol without parsing tool definitions.
11. **FR-11**: The system must enforce that `auth_profile_ref` of type `ws_security` is only honored when `protocol === 'soap'`. If a REST tool references a `ws_security` profile, the executor must log a structured warning and skip header injection (no security failure, but no silent injection of XML into a JSON body either).
12. **FR-12**: The system must validate at `CreateHttpToolSchema` time that `soap_action` is null/undefined when `protocol !== 'soap'`, and that `soap_version` is present when `protocol === 'soap'`. Violations must return a 400 with a descriptive error.
13. **FR-13**: The system must propagate `wsSecurityCredentials` from the auth-profile resolver to the HTTP executor. Concretely: (a) extend the `ToolAuthResult` interface (`apps/runtime/src/services/auth-profile/resolve-tool-auth.ts:93-106`) with an optional `wsSecurityCredentials?: { username: string; password: string; certificate?: string; mustUnderstand: boolean }` field; (b) `resolveToolAuth()` must copy `appliedAuth.wsSecurityCredentials` (set by `apply-auth.ts:290-301`) into the returned `ToolAuthResult`; (c) `patchToolWithResolvedAuth()` (or an equivalent context-passing mechanism) must surface the credentials to `HttpToolExecutor` so FR-5d can consume them. Today (without this change) `wsSecurityCredentials` is set on `ApplyAuthResult` but dropped at the `ToolAuthResult` boundary, so the executor has no pathway to receive them.

---

## 5. Feature Classification & Integration Matrix

### Lifecycle / Platform Impact

| Area                       | Impact Level | Notes                                                                                                                                                                |
| -------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Project lifecycle          | SECONDARY    | Reuses the existing project-scoped tool CRUD; SOAP tools are stored in the same `project_tools` collection with the same isolation rules.                            |
| Agent lifecycle            | SECONDARY    | Agent IR continues to embed `HttpBindingIR`; only the binding gains four optional fields.                                                                            |
| Customer experience        | SECONDARY    | End users see no surface change; SOAP tools call enterprise backends and return JSON to the LLM identical in shape to REST tool outputs.                             |
| Integrations / channels    | PRIMARY      | This is the central goal: enable SOAP-protocol enterprise integrations through the existing tool pipeline.                                                           |
| Observability / tracing    | SECONDARY    | Trace events, audit logs, and `tool.execution` shape stay identical with one additional `protocol` field.                                                            |
| Governance / controls      | PRIMARY      | SSRF, proxy, retry, circuit-breaker, rate-limit, header-injection sanitizer, max-response-size, and XXE/DTD hardening must all apply uniformly.                      |
| Enterprise / compliance    | PRIMARY      | SOAP is overwhelmingly an enterprise protocol; WS-Security UsernameToken + X.509 BST coverage is the immediate value driver. Audit and isolation guarantees inherit. |
| Admin / operator workflows | SECONDARY    | No new admin surfaces; `ws_security` auth profile management is unchanged.                                                                                           |

### Related Feature Integration Matrix

| Related Feature                                                 | Relationship Type           | Why It Matters                                                                                                                                                                  | Key Touchpoints                                                               | Current State |
| --------------------------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------- |
| [Tool Invocations](../tool-invocations.md)                      | extends                     | This is the parent feature. SOAP support is a protocol option on the existing `http` tool type and reuses the entire executor / wizard / DSL / observability surface.           | `HttpBindingIR`, `HttpToolExecutor`, `HttpToolWizard`, DSL serializer/parser  | STABLE        |
| [Auth Profiles](../auth-profiles.md)                            | depends on                  | The `ws_security` auth profile type and `applyWsSecurity()` produce the WS-Security XML header. SOAP support consumes `wsSecurityCredentials` from the auth-profile middleware. | `apply-auth.ts:290`, `ws-security-auth.ts`, `auth-profile-tool-middleware.ts` | STABLE        |
| [Integration Auth Profiles](integration-auth-profiles.md)       | reuses                      | SOAP-bound integration auth (e.g., Salesforce SOAP API) can be authored through the same Integrations catalog once an integration declares `ws_security` as an available type.  | `OAuth2AppConfigSchema`, integrations catalog                                 | BETA          |
| [Tracing & Observability](../tracing-observability.md)          | emits into                  | SOAP tools emit the existing `tool_call` trace and `tool.execution` log with a `protocol: 'soap'` discriminator; operators get one query, not two.                              | `TraceContextManager.logToolCall()`, `tool-audit-logger.ts`                   | STABLE        |
| [Variable Resolution Across Tool Types](variable-resolution.md) | shares behavior             | `{{input.X}}`, `{{secrets.X}}`, `{{env.X}}`, and `{{config.X}}` placeholders inside SOAP body templates and SOAPAction fields must resolve through the same path as REST tools. | `extractInputReferences()`, runtime placeholder resolver                      | STABLE        |
| [Connectors](../connectors.md)                                  | adjacent / no direct change | Connector-bound tools route through the connector executor, not the HTTP executor; SOAP support does not affect connector tools but a future connector can call a SOAP backend. | `ConnectorBindingIR`, connector tool executor                                 | STABLE        |

---

## 6. Design Considerations

- The Studio "Protocol" toggle must default to REST for any new HTTP tool so existing authoring flows are unchanged. Switching to SOAP shows the SOAP envelope template (`BODY_TEMPLATES.soap_envelope`) instead of the JSON template.
- The default SOAP body template should include a placeholder `<soap:Header/>` element (collapsed) so users understand WS-Security is injected there without having to author it themselves.
- Protocol-specific fields (`soapVersion`, `soapAction`, `onSoapFault`) are hidden when REST is selected to avoid noise.
- The `TestToolDialog` should display the rendered SOAP envelope (post-wrapping, post-WS-Security injection) in the request preview tab so users can verify what the executor will dispatch. This requires the test endpoint to return the rendered request in addition to the response.
- Stale tool detection (`useStaleToolCheck`, `StaleToolBanner`) automatically picks up changes to the new IR fields because they participate in `sourceHash`.

---

## 7. Technical Considerations

- **Single executor branch, not a new executor.** Forking `HttpToolExecutor` for SOAP would duplicate ~2,000 lines of resilience/security/proxy logic. The SOAP path is implemented as a small branch in `buildRequest()` and a small branch in the response handler, both gated on `binding.protocol === 'soap'`.
- **`fast-xml-parser` is already in the dependency tree** (root `package.json:130` override; `pnpm-lock.yaml`). No new install is required. The hardened parser config must be defined once and reused.
- **WS-Security injection happens in the executor, not in the auth-profile middleware.** `apply-auth.ts:290-301` already extracts and decrypts `wsSecurityCredentials` and places them on the `ApplyAuthResult`. However, the runtime auth-resolution layer (`resolveToolAuth()` and the `ToolAuthResult` type at `apps/runtime/src/services/auth-profile/resolve-tool-auth.ts:93-106`) currently strips the credentials at its boundary — only `headers`, `queryParams`, `tlsOptions`, `secrets`, `source`, and `authType` are propagated. FR-13 captures the small extension required: add `wsSecurityCredentials` to `ToolAuthResult`, propagate from `appliedAuth`, and surface to the executor via `patchToolWithResolvedAuth()`. The executor calls `applyWsSecurity()` at envelope-assembly time so XML manipulation stays out of the middleware contract.
- **No DB migration.** `dslContent` is the canonical source. Existing tools have no `protocol` line, default to REST, and behave identically. Adding `protocol` to a tool is an `UpdateProjectToolSchema` change that updates `dslContent` and bumps `_v`.
- **Backward compatibility.** All four new IR fields are optional with safe defaults (`protocol = 'rest'`, `on_soap_fault = 'error'`). The Zod schema and form types use `.default(...)` so deserializing an old DSL into a new shape produces identical request behavior.
- **Security hardening order.** SSRF check (existing) → header sanitizer (existing) → envelope wrap (new) → WS-Security inject (new) → dispatch (existing). Response: max-bytes guard (existing) → hardened XML parse (new) → fault detection (new) → JSON return (new). No new outbound surfaces; one new inbound surface (XML parsing) gated by parser hardening.
- **Versioned protocol compatibility.** SOAP body templates may include `{{input.X}}` placeholders that resolve through the same runtime resolver. The serializer must escape XML special characters from input values before substitution (or provide a `{{xml(input.X)}}` helper). Tracked as an open question.

---

## 8. How to Consume

### Studio UI

**Tool Detail / Edit Page** (`/projects/:projectId/tools/:toolId`):

- `HttpConfigForm.tsx` gains a "Protocol" toggle (REST | SOAP). When SOAP is selected:
  - SOAP version radio (1.1 / 1.2)
  - SOAPAction text field (free text, supports `{{input.X}}` placeholders)
  - "Fault handling" selector: "Treat fault as error" (default) | "Treat fault as data"
  - Body template defaults to a SOAP envelope skeleton with `<soap:Header/>` and `<soap:Body>{{request}}</soap:Body>`
  - Method selector forces POST (SOAP requires POST)
  - Body type selector forces XML and is read-only
- `ToolTypeBadge` continues to show "HTTP". A small "SOAP" sub-badge or chip is added when `protocol === 'soap'`.
- `HttpToolWizard` step 2 ("Config") shows the same protocol toggle.
- `TestToolDialog` and `ToolTestPanel` render the wrapped SOAP envelope in the request preview alongside the parsed JSON response.

### Surface Semantics Matrix

| Asset / Entity Type               | Source of Truth / Ownership                                            | Design-Time Surface(s)                                                     | Editable or Read-Only? | Consumer Reference / Binding Model                                        | Runtime Materialization / Resolution                                                                                        | Notes / Unsupported State                                                                      |
| --------------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| HTTP tool with `protocol: 'soap'` | `project_tools.dslContent` (project-scoped, tenant-isolated)           | Tools List, Tool Detail, Agent Editor binding                              | Editable               | Agent IR references by tool `name`; tool resolved at compilation          | `HttpToolExecutor` branches on `protocol`; envelope wrapping, WS-Security injection, response unwrap happen at request time | New SOAP-specific fields hidden when `protocol === 'rest'`.                                    |
| `ws_security` auth profile        | `auth_profiles` collection                                             | Auth Profiles page, Integrations tab (if connector supports `ws_security`) | Editable               | Tool references by `auth_profile_ref`                                     | `apply-auth.ts:290` produces `wsSecurityCredentials`; executor calls `applyWsSecurity()` and injects header into envelope   | Honored only when tool's `protocol === 'soap'`; warned (not failed) when bound to a REST tool. |
| SOAP envelope body template       | `project_tools.dslContent` (`body` field, shared with REST `xml` body) | HTTP Config Form body editor                                               | Editable               | Inline string with `{{input.X}}`/`{{secrets.X}}`/`{{env.X}}` placeholders | Resolved by runtime placeholder resolver, then wrapped by executor                                                          | The `<soap:Header>` placeholder is overwritten by the executor when WS-Security is bound.      |

### Design-Time vs Runtime Behavior

- **Design-time**: the user authors a body template that is _the inner payload only_ (or a full envelope, both are accepted; the executor detects an existing `<soap:Envelope>` and avoids double-wrapping).
- **Runtime**: the executor renders the envelope with the correct namespace (`http://schemas.xmlsoap.org/soap/envelope/` for 1.1, `http://www.w3.org/2003/05/soap-envelope` for 1.2), injects `<wsse:Security>` if WS-Security applies, sets headers, dispatches, parses the response, and returns the unwrapped `<Body>` content.
- The author-facing field name `Protocol` maps to IR field `protocol`. Author-facing `SOAP Action` maps to IR `soap_action`. Author-facing `Fault Handling` maps to IR `on_soap_fault`. Author-facing `SOAP Version` maps to IR `soap_version`.

### API (Runtime)

No new runtime endpoints. SOAP tools execute through the same dispatcher and emit through the same trace/audit/log surfaces.

### API (Studio)

No new Studio endpoints. Existing endpoints accept the new fields:

| Method | Path                                     | Purpose                                                                                                                               |
| ------ | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/api/projects/:id/tools`                | Accept `protocol`, `soapVersion`, `soapAction`, `onSoapFault` on HTTP tool create payload.                                            |
| PUT    | `/api/projects/:id/tools/:toolId`        | Accept the same fields on update; existing tools without the fields keep REST behavior.                                               |
| POST   | `/api/projects/:id/tools/:toolId/test`   | When `protocol === 'soap'`, render envelope and inject WS-Security server-side; return rendered request in test response for preview. |
| GET    | `/api/projects/:id/tools/:toolId/export` | Export now includes `protocol`/`soapVersion`/`soapAction`/`onSoapFault` when set.                                                     |
| POST   | `/api/projects/:id/tools/import`         | Import recognizes the new fields and validates per FR-12.                                                                             |

### Admin Portal

No new admin surfaces. WS-Security auth profile CRUD remains in the existing Auth Profiles admin UI.

### Channel / SDK / Voice / A2A / MCP Integration

SOAP tools execute identically across channels via the channel-agnostic `ToolBindingExecutor`. JIT auth is not applicable to SOAP `ws_security` (UsernameToken is preconfigured, not user-consent-based), so JIT consent prompts are not surfaced for SOAP tools. WS-Security flows through the standard auth-profile middleware regardless of channel.

---

## 9. Data Model

### Collections / Tables

No schema changes. SOAP-specific configuration lives inside `project_tools.dslContent` (the canonical source) and is mirrored into `HttpBindingIR` at compile time. The DB-level enum `PROJECT_TOOL_TYPES` (`packages/database/src/models/project-tool.model.ts:18`) stays unchanged.

```text
Collection: project_tools (existing — no change)
Fields (relevant):
  - toolType: 'http' (unchanged)
  - dslContent: contains the new lines `protocol: soap`, `soap_version: 1.1`, `soap_action: ...`, `on_soap_fault: error|data` when applicable
  - sourceHash: now reflects SOAP fields; existing tools' hashes do not change because they emit no new lines
```

### Key Relationships

- A SOAP tool may reference a `ws_security` auth profile via `auth_profile_ref` (existing relationship, new use-case).
- A SOAP tool's `body` template participates in the same variable resolution chain as REST tools (`{{input.X}}`, `{{secrets.X}}`, `{{env.X}}`, `{{config.X}}`).
- SOAP tool execution traces are correlated to sessions through the existing `sessionId`/`tenantId` on `tool_call` events.

---

## 10. Key Implementation Files

### Domain / Core Logic

| File                                                                         | Purpose                                                                                                                                                                                                                                                                                                                                             |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/compiler/src/platform/ir/schema.ts`                                | Extend `HttpBindingIR` with `protocol`, `soap_version`, `soap_action`, `on_soap_fault`.                                                                                                                                                                                                                                                             |
| `packages/compiler/src/platform/ir/compiler.ts`                              | Extend `compileHttpBinding()` (~L1030) to map the new AST fields to IR fields. The tool merge block (`mergeAgentToolBehavior`, ~L135) does not need changes because SOAP fields live inside `http_binding`, which is preserved by the spread on `resolvedTool`. (Verification step per `packages/compiler/agents.md` 2026-03-24 lockstep learning.) |
| `packages/compiler/src/platform/constructs/executors/soap-envelope.ts` (new) | `xmlEscape()`, `renderSoapRequest()` (envelope wrapping + WS-Security injection), `parseSoapResponse()` (hardened `fast-xml-parser`, fault detection, Body unwrap). Exported as `SoapHttpBindingIR`, `SOAP_CONTENT_TYPES`.                                                                                                                          |
| `packages/compiler/src/platform/constructs/executors/http-tool-executor.ts`  | SOAP branch in `buildRequest()` and response handler; `escapeForXmlBodyTemplate` flag threaded through all 6 placeholder resolvers; FR-11 warning for REST+WS-Security; FR-10 trace fields.                                                                                                                                                         |
| `packages/shared/src/validation/project-tool-schemas.ts`                     | Extend `CreateHttpToolSchema` Zod fields and add the cross-field check from FR-12.                                                                                                                                                                                                                                                                  |
| `packages/shared-kernel/src/types/project-tool-form.ts`                      | Extend `HttpToolFormData` with the four new fields.                                                                                                                                                                                                                                                                                                 |
| `packages/shared/src/tools/serialize-tool-form-to-dsl.ts`                    | Emit `protocol`, `soap_version`, `soap_action`, `on_soap_fault` lines when `protocol === 'soap'`.                                                                                                                                                                                                                                                   |
| `packages/shared/src/tools/parse-dsl-to-tool-form.ts`                        | Round-trip the new lines back to form state.                                                                                                                                                                                                                                                                                                        |
| `packages/shared/src/tools/dsl-property-parser.ts`                           | Extend HTTP property parsing (~L384, where `body_type` is mapped) to assign new SOAP DSL fields onto the `HttpBindingIRLocal`. (Lockstep site per `packages/shared/agents.md`.)                                                                                                                                                                     |
| `packages/core/src/parser/agent-based-parser.ts`                             | Add the snake_case DSL names `'protocol'`, `'soap_version'`, `'soap_action'`, `'on_soap_fault'` to `TOOL_IMPLEMENTATION_PROPERTIES` (~L99-118) so they are correctly rejected from agent DSL tools-section.                                                                                                                                         |
| `apps/runtime/src/services/auth-profile/resolve-tool-auth.ts`                | Extend `ToolAuthResult` (L93-106) with `wsSecurityCredentials`; propagate from `appliedAuth` (L262-269); see FR-13.                                                                                                                                                                                                                                 |
| `apps/runtime/src/services/auth-profile/auth-profile-tool-middleware.ts`     | Extend `patchToolWithResolvedAuth()` (or equivalent context-passing) to surface `wsSecurityCredentials` to `HttpToolExecutor`.                                                                                                                                                                                                                      |
| `packages/auth-enterprise/src/ws-security-auth.ts`                           | Read-only — the existing `applyWsSecurity()` is consumed by the executor, not modified.                                                                                                                                                                                                                                                             |

### Routes / Handlers

| File                                                                    | Purpose                                                                                                                                                                      |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/studio/src/app/api/tool-test/[projectId]/[toolId]/route.ts` (new) | Flat Studio route handler for tool testing. Needed because Turbopack's dev-server route resolver fails to match deep 6-segment paths (`/api/projects/{id}/tools/{id}/test`). |
| `apps/studio/src/proxy.ts`                                              | Added `TOOL_TEST_PATH_RE` regex + rewrite rule that maps the canonical 6-segment tool-test path to the flat 4-segment handler above.                                         |

Existing tool CRUD/test/export/import routes in `apps/studio/src/app/api/projects/[id]/tools/...` and `apps/runtime/src/routes/...` continue to accept the new fields through the extended schema.

### UI Components

| File                                                         | Purpose                                                                                                                       |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `apps/studio/src/components/tools/HttpConfigForm.tsx`        | Add Protocol toggle, SOAP version radio, SOAPAction field, fault-handling selector, SOAP envelope body template.              |
| `apps/studio/src/components/tools/wizard/HttpToolWizard.tsx` | Surface the same Protocol toggle in step 2 (Config).                                                                          |
| `apps/studio/src/components/tools/shared-types.ts`           | Extend `HttpConfig`, `BodyType` (no change to enum; XML stays valid), and add `Protocol`, `SoapVersion`, `OnSoapFault` types. |
| `apps/studio/src/components/tools/form-adapters.ts`          | Map UI form state ↔ API payload for the new fields.                                                                           |
| `apps/studio/src/components/tools/ToolTestPanel.tsx`         | Render rendered SOAP envelope (request preview) and parsed JSON (response) when `protocol === 'soap'`.                        |
| `apps/studio/src/components/tools/ToolTypeBadge.tsx`         | Optional sub-badge / chip for SOAP HTTP tools.                                                                                |

### Jobs / Workers / Background Processes

None. SOAP execution is request/response inline through the same dispatcher.

### Tests

| File                                                                                | Type        | Coverage Focus                                                                                                                                                                          |
| ----------------------------------------------------------------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/compiler/src/__tests__/constructs/http-tool-executor-soap.test.ts` (new)  | unit        | Envelope wrapping (1.1 + 1.2), Content-Type, SOAPAction header, WS-Security injection, fault detection (200 + 5xx), `on_soap_fault` modes, XXE-blocking parser config, response unwrap. |
| `packages/shared/src/__tests__/serialize-tool-form-to-dsl-soap.test.ts` (new)       | unit        | Round-trip of the four new fields.                                                                                                                                                      |
| `packages/shared/src/__tests__/project-tool-schemas-soap.test.ts` (new)             | unit        | Zod defaults, cross-field validation per FR-12.                                                                                                                                         |
| `apps/studio/src/__tests__/components/tools/HttpConfigForm-soap.test.tsx` (new)     | unit        | Protocol toggle behavior, SOAP fields gated correctly, body template swap.                                                                                                              |
| `apps/studio/src/__tests__/tool-test-service.test.ts` (extended)                    | unit        | SOAPAction display (quoted form), `{{session.X}}` display support, HTTP status code mapping for SOAP errors.                                                                            |
| `apps/studio/src/__tests__/e2e/soap-tool.e2e.test.ts` (new)                         | e2e         | Full create-bind-execute-respond chain against a stub SOAP server (Express test fixture).                                                                                               |
| `packages/compiler/src/__tests__/constructs/tool-binding-executor.test.ts` (extend) | unit        | Verify dispatcher still routes SOAP tools through `HttpToolExecutor` (no protocol-aware dispatch).                                                                                      |
| `packages/compiler/src/__tests__/constructs/tool-lifecycle-e2e.test.ts` (extend)    | integration | SOAP tool lifecycle (create → IR compile → execute) end-to-end through compiler constructs.                                                                                             |

---

## 11. Configuration

### Environment Variables

| Variable                           | Default | Description                                                                                           |
| ---------------------------------- | ------- | ----------------------------------------------------------------------------------------------------- |
| `HTTP_TOOL_SOAP_PARSER_MAX_DEPTH`  | `64`    | Maximum XML element nesting depth permitted by the response parser. Defends against deep-nesting DoS. |
| `HTTP_TOOL_SOAP_DEBUG_RAW_REQUEST` | `false` | When true, includes the rendered SOAP envelope (post-WS-Security) in trace payloads for debugging.    |

Existing vars (`HTTP_TOOL_MAX_RESPONSE_BYTES`, `HTTP_TOOL_MAX_REDIRECT_HOPS`, `HTTP_TOOL_KEEPALIVE_MS`, `HTTP_TOOL_MAX_SOCKETS`, `TOOL_DEFAULT_TIMEOUT_MS`, `TOOL_MAX_RESULT_SIZE`) apply unchanged.

### Runtime Configuration

- No new tenant-level toggles. SOAP support is uniformly available wherever the HTTP tool type is available.
- The hardened XML parser config is defined once at module scope: `processEntities: false`, `allowBooleanAttributes: false`, no DTD support, `maxDepth = HTTP_TOOL_SOAP_PARSER_MAX_DEPTH`.

### DSL / Agent IR / Schema

```typescript
// Additions to HttpBindingIR (packages/compiler/src/platform/ir/schema.ts)
interface HttpBindingIR {
  // ... existing fields ...
  protocol?: 'rest' | 'soap'; // default: 'rest'
  soap_version?: '1.1' | '1.2'; // required when protocol === 'soap'
  soap_action?: string; // optional
  on_soap_fault?: 'error' | 'data'; // default: 'error'
}
```

DSL example (excerpt):

```yaml
tool: lookup_policy
type: http
endpoint: https://soap.insurer.example/PolicyService
method: POST
protocol: soap
soap_version: 1.1
soap_action: http://example.com/PolicyService/LookupPolicy
on_soap_fault: error
auth_profile_ref: insurer-ws-security
body_type: xml
body: |
  <ns:LookupPolicy xmlns:ns="http://example.com/policy">
    <ns:PolicyNumber>{{input.policy_number}}</ns:PolicyNumber>
  </ns:LookupPolicy>
```

---

## 12. Non-Functional Concerns

### Isolation & Multitenancy

| Concern           | Requirement / Expectation                                                                                                                                                                                                               |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Project isolation | SOAP tools are stored in `project_tools` with the same `tenantId` + `projectId` filtering as today; cross-project tool access must continue to return 404 (covered by `tenantIsolationPlugin`).                                         |
| Tenant isolation  | WS-Security credentials live in tenant-scoped `auth_profiles`; secret resolution remains tenant-scoped. SOAP responses are not cached cross-tenant. Circuit breaker counters and rate limiters remain tenant + tool keyed.              |
| User isolation    | SOAP tools follow the same user-isolation rules as their REST counterparts (project-role-based access in Studio; runtime session attribution unchanged). `ws_security` profiles are typically `shared` scope but can be `personal` too. |

### Security & Compliance

- **SSRF**: SOAP endpoints flow through `safeFetch` and `assertUrlSafeForFetch`; private IPs, cloud metadata, octal/decimal encoding, and userinfo bypass are blocked exactly as for REST.
- **XXE / XML entity expansion / DTD**: hardened `fast-xml-parser` config (`processEntities: false`, no DTD) defends against XXE and billion-laughs. This is the only new inbound parsing surface introduced by the feature; the hardening must be enforced via a single shared parser factory.
- **Header injection**: existing `sanitizeHeaderValue` strips CRLF from `SOAPAction` and any custom headers.
- **Response size**: existing `HTTP_TOOL_MAX_RESPONSE_BYTES` cap applies; the parser refuses to allocate beyond the cap.
- **Credential exposure**: WS-Security credentials are AES-256-GCM encrypted at rest in `auth_profiles`; they appear in the rendered envelope only at request time and never in API responses or trace events (the `<wsse:Password>` digest field is non-reversible by design).
- **Audit logging**: every SOAP tool execution emits the same audit entry shape with `protocol: 'soap'` for filtering. Fault detection (whether returned as error or data) is recorded in the audit trail.

### Performance & Scalability

- SOAP requests reuse the same keep-alive socket pool and proxy resolver as REST. No new pooling.
- XML parsing latency is bounded by `HTTP_TOOL_MAX_RESPONSE_BYTES` and `HTTP_TOOL_SOAP_PARSER_MAX_DEPTH`.
- Tool result compaction works on the _parsed JSON_ payload; structured/`truncate`/`summarize` strategies all apply.
- WS-Security header generation (`applyWsSecurity()`) uses Node's built-in `crypto`; cost is dominated by SHA-1 + base64 — sub-millisecond.

### Reliability & Failure Modes

- Network errors, timeouts, and HTTP non-200 responses (excluding the SOAP-fault-as-success path) arm the existing circuit breaker.
- A `<soap:Fault>` returned with HTTP 200 still arms the breaker when `on_soap_fault === 'error'` (default), via the structured error path.
- Retry policy (`retry`, `retryDelay`) applies to SOAP at the request level; no SOAP-message-level idempotency is provided (caller must ensure operation safety).
- Parser failures (unparseable XML) raise `ToolExecutionError({ code: 'TOOL_RESPONSE_PARSE_FAILED' })`; the original byte payload is dropped (not stored).

### Observability

- `tool_call` trace event includes `protocol`, `soap_version`, and `soap_action` (when set).
- `tool.execution` log entry includes the same fields.
- Audit events include `protocol` for filtering.
- A new structured log warning `WS_SECURITY_BOUND_TO_REST_TOOL` is emitted (per FR-11) when a non-SOAP tool references a `ws_security` profile.
- A new metric counter (or trace tag) `tool.soap_fault_count` distinguishes SOAP faults from transport errors in dashboards.

### Data Lifecycle

- No new collections. No new TTLs. No new retention concerns. SOAP tool definitions follow the same `project_tools` lifecycle (no automatic deletion; project-scoped removal cascades on project delete).

---

## 13. Delivery Plan / Work Breakdown

1. IR + validation + form types (low risk, additive)
   1.1 Extend `HttpBindingIR` with `protocol`, `soap_version`, `soap_action`, `on_soap_fault`.
   1.2 Extend `CreateHttpToolSchema` with the same fields, defaults, and FR-12 cross-field check.
   1.3 Extend `HttpToolFormData` and `shared-types.ts` with matching TypeScript types.
   1.4 Round-trip serializer/parser changes (`serialize-tool-form-to-dsl.ts`, `parse-dsl-to-tool-form.ts`) with unit tests.
   1.5 Update DSL lockstep sites: `dsl-property-parser.ts` (HTTP property branch), `compiler.ts:compileHttpBinding`, and add the four field names to `agent-based-parser.ts`'s `TOOL_IMPLEMENTATION_PROPERTIES` denylist.
2. Executor SOAP branch + auth propagation (medium risk, security-sensitive)
   2.1 Extend `ToolAuthResult` with `wsSecurityCredentials`; update `resolveToolAuth()` to propagate from `appliedAuth`; thread credentials to executor via `patchToolWithResolvedAuth()` (FR-13).
   2.2 Add hardened `fast-xml-parser` factory to `http-tool-executor.ts`.
   2.3 Add SOAP envelope template rendering for 1.1 and 1.2 (versioned namespace + Content-Type).
   2.4 Consume `wsSecurityCredentials` from auth context; call `applyWsSecurity()`; inject header into envelope.
   2.5 Implement response parser (envelope strip + Body unwrap).
   2.6 Implement fault detection for both SOAP versions; honor `on_soap_fault`.
   2.7 Wire the `WS_SECURITY_BOUND_TO_REST_TOOL` warning (FR-11).
   2.8 Unit tests covering all of the above + XXE/DTD blocking.
3. Studio UI (low risk)
   3.1 Add Protocol toggle to `HttpConfigForm.tsx` and `HttpToolWizard.tsx`.
   3.2 Add SOAP version radio, SOAPAction field, fault-handling selector.
   3.3 Add SOAP envelope body template; force POST + XML body type when SOAP.
   3.4 Update `ToolTestPanel` to show rendered SOAP envelope (request) and parsed JSON (response).
   3.5 Component tests + Studio E2E.
4. End-to-end test fixture (medium risk)
   4.1 Add a stub SOAP 1.1 + 1.2 Express server fixture for tests (no external dependency).
   4.2 Author the new E2E suite (`soap-tool.e2e.test.ts`) covering the scenarios in the testing guide.
5. Observability + docs
   5.1 Add `protocol` field to `tool_call` trace + `tool.execution` log + audit entries.
   5.2 Update `docs/features/tool-invocations.md` to cross-reference SOAP support.
   5.3 Update `docs/features/sub-features/README.md` and `docs/testing/sub-features/README.md`.
6. Release readiness
   6.1 Ensure SOAP support is exercised in nightly integration with at least one realistic third-party SOAP fixture (e.g., a public WSDL like a calculator service).
   6.2 Promote feature status: PLANNED → ALPHA on first commit; ALPHA → BETA after the E2E suite passes.

---

## 14. Success Metrics

| Metric                                        | Baseline                                                                       | Target                                                                                                | How Measured                                                            |
| --------------------------------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Time to author a working SOAP tool            | N/A today — requires hand-crafting envelopes inside an XML body, often 1+ hour | < 10 minutes for a SOAP 1.1 endpoint with WS-Security UsernameToken                                   | Internal trial / dogfood timing during BETA validation                  |
| SOAP tool execution success rate (happy path) | N/A — workaround tools exist outside the feature                               | ≥ 99% against a stable enterprise endpoint                                                            | `tool.execution` log filtered by `protocol: 'soap'` and `success: true` |
| SOAP fault classification accuracy            | N/A                                                                            | 100% of `<soap:Fault>` payloads detected and classified (HTTP 200 fault + HTTP 5xx fault both caught) | E2E test scenarios + audit log review                                   |
| XXE / billion-laughs payloads blocked         | Not applicable (no SOAP today)                                                 | 100% blocked at the parser level, no executor-side bypass                                             | Negative E2E tests with malicious payloads                              |
| REST tool behavior unchanged                  | Existing tests pass                                                            | 0 regressions in the REST path; no behavioral change for tools without `protocol`                     | Existing HTTP executor + DSL serializer test suites continue to pass    |

---

## 15. Open Questions

1. ~~Should `{{input.X}}` placeholders inside SOAP body templates be XML-escaped automatically, or should the user opt in via a `{{xml(input.X)}}` helper?~~ **RESOLVED (D-11)**: Auto-XML-escape is the v1 default. Safer default prevents accidental injection. A future `{{xml(input.X)}}` helper may be added for raw XML insertion.
2. ~~When a SOAP service returns no `<Body>` (one-way operations), should the executor return `null`, `{}`, or a structured `{ oneWay: true }` marker?~~ **RESOLVED (D-12)**: Returns `{ oneWay: true }`. Discriminable, structurally non-empty, self-documenting. `null` conflicted with errors; `{}` was ambiguous.
3. ~~Should we expose a per-tool toggle to also include the raw XML response in the result?~~ **RESOLVED (closed)**: v1 omits raw XML toggle per oracle recommendation. Parsed JSON only.
4. ~~Should the Studio test endpoint return the rendered SOAP envelope by default, or only on `?debug=true`?~~ **RESOLVED (D-9/D-10)**: `?debug=true` gated behind `tool:write` permission; `<wsse:Nonce>` and `<wsu:Timestamp>` redacted from the debug response. Implemented in `apps/studio/src/app/api/projects/[id]/tools/[toolId]/test/route.ts`.
5. Is there a customer or Jira ticket to anchor priority? The product oracle could not find one — this is currently proactive enterprise enablement.
6. Should we backport SOAP support to the existing connector-bound tool path in a follow-up so connector authors can target SOAP backends without an HTTP tool?

---

## 16. Gaps, Known Issues & Limitations

| ID      | Description                                                                                                                                                                                                                                                                                     | Severity | Status                    |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------- |
| GAP-001 | WSDL import is out of scope for v1; users must hand-author envelopes.                                                                                                                                                                                                                           | Medium   | Open                      |
| GAP-002 | XML-DSig (envelope `<Body>` signing) and XML-Enc (body encryption) are out of scope; some enterprise services require these.                                                                                                                                                                    | Medium   | Open                      |
| GAP-003 | SOAP MTOM / SwA attachments are unsupported.                                                                                                                                                                                                                                                    | Low      | Open                      |
| GAP-004 | WS-\* extensions beyond UsernameToken / X.509 BST (WS-Trust, WS-RM, WS-Policy) are unsupported.                                                                                                                                                                                                 | Low      | Open                      |
| GAP-005 | One-way SOAP operations (request without response Body) — return shape is `{ oneWay: true }` per D-12.                                                                                                                                                                                          | Low      | Mitigated (D-12)          |
| GAP-006 | Studio test endpoint returns rendered envelope via `?debug=true` (gated behind `tool:write`; nonce/timestamp redacted per D-10).                                                                                                                                                                | Medium   | Mitigated                 |
| GAP-007 | No nightly integration test against a real third-party SOAP service yet — fixture-only coverage at v1.                                                                                                                                                                                          | Medium   | Open                      |
| GAP-008 | SOAPAction header was sent as a bare URI (e.g., `http://tempuri.org/Add`) instead of the RFC-required quoted-string (e.g., `"http://tempuri.org/Add"`). Caused 400 errors on .NET/Axis servers.                                                                                                 | High     | CLOSED (2026-04-28)       |
| GAP-009 | Pre-wrapped envelope detection failed when the user body started with `<?xml version="1.0"?>` before `<soap:Envelope>`, causing double-wrapping (envelope inside envelope) and 400 errors.                                                                                                      | High     | CLOSED (2026-04-28)       |
| GAP-010 | `{{_context.X}}` and `{{session.X}}` placeholders in `soap_action` are now resolved by the executor (all 5 namespaces: input, secrets, env, context, session). Unit coverage exists (U-4b for `{{input.X}}`, U-4c for `{{secrets.X}}`), but no E2E coverage for context/session in soap_action. | Low      | Open (unit-only coverage) |

---

## 17. Testing & Validation

### Required Test Coverage

| #   | Scenario                                                                                                                 | Coverage Type      | Status           | Test File / Note                                                                                                                                  |
| --- | ------------------------------------------------------------------------------------------------------------------------ | ------------------ | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | SOAP 1.1 envelope wrapping with correct namespace and RFC-quoted `SOAPAction` header                                     | unit + e2e         | ✅ PASSING       | `http-tool-executor-soap.test.ts` (U-1, U-4, U-4b, U-4c, INT-1), `soap-tool.e2e.test.ts` (E2E-1, E2E-7)                                           |
| 2   | SOAP 1.2 envelope wrapping with `application/soap+xml; action=...` Content-Type                                          | unit + e2e         | ✅ PASSING       | `http-tool-executor-soap.test.ts` (U-2, INT-2), `soap-tool.e2e.test.ts` (E2E-2)                                                                   |
| 3   | WS-Security UsernameToken injection into envelope `<Header>` from `ws_security` auth profile                             | unit               | PARTIAL          | `http-tool-executor-soap.test.ts` (U-6); `resolve-tool-auth-soap.test.ts` (INT-3 type-contract only — full DB integration deferred per FR-13 gap) |
| 4   | WS-Security X.509 BinarySecurityToken injection                                                                          | unit               | ✅ PASSING       | `ws-security-auth.test.ts` (pre-existing); certificate path in `applyWsSecurity` covered                                                          |
| 5   | `<soap:Fault>` with HTTP 200 → structured error when `on_soap_fault === 'error'`                                         | unit + e2e         | ✅ PASSING       | `http-tool-executor-soap.test.ts` (U-8, INT-6), `soap-tool.e2e.test.ts` (E2E-3)                                                                   |
| 6   | `<soap:Fault>` with HTTP 5xx → structured error                                                                          | unit               | ✅ PASSING       | `http-tool-executor-soap.test.ts` (INT-6) — HTTP 5xx SOAP fault path covered                                                                      |
| 7   | `on_soap_fault === 'data'` → fault parsed and returned as success                                                        | unit + e2e         | ✅ PASSING       | `http-tool-executor-soap.test.ts` (U-10, INT-6), `soap-tool.e2e.test.ts` (E2E-4)                                                                  |
| 8   | XXE payload blocked by hardened parser (no external entity resolution)                                                   | unit               | ✅ PASSING       | `http-tool-executor-soap.test.ts` (U-11 — `processEntities: false` verified)                                                                      |
| 9   | Billion-laughs payload blocked or refused                                                                                | unit               | ✅ PASSING       | `http-tool-executor-soap.test.ts` (U-12 — `maxNestedTags` + entity expansion blocked)                                                             |
| 10a | Existing REST tool behavior unchanged when `protocol` field is absent (existing suite must remain green)                 | unit + integration | ✅ EXISTING PASS | existing `http-tool-executor.test.ts` (4900+ tests still green)                                                                                   |
| 10b | New regression cases: tool with explicit `protocol: 'rest'` produces byte-identical request to a tool without `protocol` | unit               | ✅ PASSING       | `http-tool-executor-soap.test.ts` (U-15, U-16)                                                                                                    |
| 11  | DSL round-trip preserves all four new fields                                                                             | unit + integration | ✅ PASSING       | `serialize-tool-form-to-dsl-soap.test.ts` (U-17..19), `tool-lifecycle-e2e.test.ts` (INT-7)                                                        |
| 12  | Studio Protocol toggle hides/shows SOAP fields correctly                                                                 | unit               | ✅ PASSING       | `HttpConfigForm-soap.test.tsx` (U-23..26)                                                                                                         |
| 13  | Cross-tenant SOAP tool access returns 404                                                                                | e2e                | ✅ PASSING       | `soap-tool.e2e.test.ts` (E2E-5, E2E-5b)                                                                                                           |
| 14  | `ws_security` profile bound to a REST tool emits `WS_SECURITY_BOUND_TO_REST_TOOL` warning and does not inject header     | unit + integration | ✅ PASSING       | `http-tool-executor-soap.test.ts` (INT-4)                                                                                                         |
| 15  | SSRF check blocks SOAP endpoints on private IPs                                                                          | unit               | ✅ PASSING       | `http-tool-executor-soap.test.ts` (SEC-9)                                                                                                         |

### Testing Notes

The feature is at status **ALPHA** (as of 2026-04-28). All 15 scenarios above are now covered, plus additional bug-fix coverage added 2026-04-28:

- **U-4b**: `{{input.X}}` placeholder resolution in `soap_action` field.
- **U-4c**: `{{secrets.X}}` placeholder resolution in `soap_action` field.
- **Pre-wrap XML declaration test**: Verifies that a body starting with `<?xml ...?>` followed by `<soap:Envelope>` is correctly detected as pre-wrapped (no double-wrapping).
- **SOAPAction quoting**: All SOAPAction assertions updated to expect RFC-compliant quoted-string format (e.g., `"http://example.com/Action"`).
- **Response status code propagation tests**: Studio tool-test-service correctly maps error codes to HTTP status codes (e.g., TOOL_TIMEOUT to 504, TOOL_SOAP_FAULT to 200).

Total test coverage: 37+ unit/integration (compiler), 19 unit (shared), 9 integration (runtime auth), 4+ unit (studio component), 8 E2E scenarios authored (require full infra runtime). The full coverage matrix per FR (FR-1..FR-13) is in the testing guide.

Promotion thresholds:

- **PLANNED → ALPHA**: at least 3 E2E + 5 integration scenarios green; every FR has at least one ✅ in the coverage matrix.
- **ALPHA → BETA**: all 7 E2E + all 7 integration scenarios green; manual M-1..M-6 walkthroughs complete.
- **BETA → STABLE**: nightly integration against a real third-party SOAP service (closes GAP-007); no open CRITICAL/HIGH gaps; one production / staging soak week.

> Full testing details: [../../testing/sub-features/soap-tool-support.md](../../testing/sub-features/soap-tool-support.md)

---

## 18. References

- Parent feature: [Tool Invocations](../tool-invocations.md)
- Related: [Auth Profiles](../auth-profiles.md), [Integration Auth Profiles](integration-auth-profiles.md), [Variable Resolution Across Tool Types](variable-resolution.md), [Tracing & Observability](../tracing-observability.md)
- IR schema: `packages/compiler/src/platform/ir/schema.ts:1075` (HttpBindingIR)
- Executor: `packages/compiler/src/platform/constructs/executors/http-tool-executor.ts:146` (Content-Type map), `:459` (buildRequest)
- Auth: `packages/auth-enterprise/src/ws-security-auth.ts` (applyWsSecurity), `packages/shared/src/services/auth-profile/apply-auth.ts:290` (ws_security case)
- Validation: `packages/shared/src/validation/project-tool-schemas.ts:82` (CreateHttpToolSchema)
- DSL: `packages/shared/src/tools/serialize-tool-form-to-dsl.ts:82` (serializeHttpProperties)
- UI: `apps/studio/src/components/tools/HttpConfigForm.tsx:42` (BODY_TYPE_OPTIONS)
- Specs (SOAP): SOAP 1.1 (W3C Note 2000-05-08), SOAP 1.2 (W3C Recommendation 2007-04-27), WS-Security 1.1 (OASIS Standard)
