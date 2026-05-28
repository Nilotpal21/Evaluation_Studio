# LLD: SOAP Tool Support — Implementation Plan

**Feature Spec**: [`docs/features/sub-features/soap-tool-support.md`](../features/sub-features/soap-tool-support.md)
**HLD**: [`docs/specs/soap-tool-support.hld.md`](../specs/soap-tool-support.hld.md)
**Test Spec**: [`docs/testing/sub-features/soap-tool-support.md`](../testing/sub-features/soap-tool-support.md)
**Status**: DONE (all 4 phases implemented — ALPHA)
**Date**: 2026-04-27
**Author**: Platform team (drafted by Claude Opus 4.7 on behalf of `karthikeya.andhoju@kore.com`)

---

## 1. Design Decisions

### Decision Log

| #    | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Rationale                                                                                                                                                                                                                                                                                                                                                                         | Alternatives Rejected                                                                                                                                                                                                                                                        |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D-1  | Phase 1 = additive scaffolding only (IR + Zod + DSL + form types + denylist). Phase 2 = FR-13 + executor SOAP branch.                                                                                                                                                                                                                                                                                                                                                | FR-13 cannot be end-to-end tested without its executor consumer. Splitting it earlier creates dead code. Phase 1 stays low-risk and independently mergeable.                                                                                                                                                                                                                      | Land FR-13 in Phase 1: rejected — would commit untested propagation code with no consumer.                                                                                                                                                                                   |
| D-2  | Commit split for the implementation: **6 commits across 4 phases** to honor commit-scope-guard (max 3 packages each). Phase 1a (3 pkg) + Phase 1b (1 pkg) + Phase 2 split into 2 commits (1 pkg each) + Phase 3 (1 pkg) + Phase 4 (2 pkg).                                                                                                                                                                                                                           | Hook hard-blocks > 3 packages per commit. Six packages affected (`compiler`, `core`, `shared`, `shared-kernel`, `runtime`, `studio`). Multiple small commits keep each commit reviewable, bisectable, and revertable. (D-2 was originally "3 commits" — refined during round-2/4 audits as Phase 1 split into 1a+1b and Phase 2 split into runtime-only + compiler-only commits.) | One mega-commit: blocked by hook. Two commits at ~3 packages each: would force `runtime` + `studio` into one bundle, mixing concerns.                                                                                                                                        |
| D-3  | Extract SOAP-specific helpers into a sibling module `packages/compiler/src/platform/constructs/executors/soap-envelope.ts`.                                                                                                                                                                                                                                                                                                                                          | `http-tool-executor.ts` is already 1,959 lines. Inlining ~150 SOAP lines would push it past 2,100 lines and harm readability. The sibling module mirrors the existing `safeParseJson`/`sanitizeHeaderValue` helper pattern.                                                                                                                                                       | Inline in `http-tool-executor.ts`: rejected — file is already large, harder to test in isolation, harder to reason about.                                                                                                                                                    |
| D-4  | FR-13 carrier: extend `patchToolWithResolvedAuth(tool, headers, queryParams?, tlsOptions?, wsSecurityCredentials?)` and attach as **transient** `tool.http_binding._wsSecurityCredentials`.                                                                                                                                                                                                                                                                          | The dispatch terminal callback at `tool-binding-executor.ts:335-340` forwards `ctx.tool` but **not** `ctx.metadata` to `dispatch()`; `HttpToolExecutor.execute()` (`http-tool-executor.ts:388`) has no `ToolCallContext` parameter. Credentials must travel on the `tool` object.                                                                                                 | `ctx.metadata` carrier: rejected — would require expanding the dispatch terminal callback and `execute()` signatures, broadening the change surface.                                                                                                                         |
| D-5  | Typed `SoapHttpBindingIR` accessor: `interface SoapHttpBindingIR extends HttpBindingIR { _wsSecurityCredentials?: ... }`.                                                                                                                                                                                                                                                                                                                                            | One typed cast at the executor read site; full typing throughout `soap-envelope.ts`. Honors CLAUDE.md type-safety rule "no `any` where structured types exist."                                                                                                                                                                                                                   | Inline `as HttpBindingIR & { _wsSecurityCredentials?: ... }` casts: rejected — repeated boilerplate, no documentation of the field's shape for future maintainers.                                                                                                           |
| D-6  | INT-3 (FR-13 propagation) is **test-first**: write the failing test before extending `ToolAuthResult`.                                                                                                                                                                                                                                                                                                                                                               | FR-13 is the #1 implementation risk per HLD. Test-first proves the gap exists, then proves the fix closes it.                                                                                                                                                                                                                                                                     | Test-after for FR-13: rejected — the gap is silent (auth either succeeds with no header or fails inscrutably); a deferred test risks rediscovering the bug.                                                                                                                  |
| D-7  | No feature flag.                                                                                                                                                                                                                                                                                                                                                                                                                                                     | HLD §4 concern #11. Opt-in authoring + per-tenant circuit breaker isolation provide adequate gating. Zero SOAP tools exist today; rollback = revert commits.                                                                                                                                                                                                                      | Per-tenant `enableSoapTools` flag: rejected — overhead with no clear benefit given opt-in surface.                                                                                                                                                                           |
| D-8  | No benchmark gate in v1.                                                                                                                                                                                                                                                                                                                                                                                                                                             | HLD §4 concern #9. Parsing bounded by `HTTP_TOOL_MAX_RESPONSE_BYTES` (10 MB) + `HTTP_TOOL_SOAP_PARSER_MAX_DEPTH` (default 64). `fast-xml-parser` 5.6.0 is high-performance. Parity with REST p95 is the target.                                                                                                                                                                   | Mandatory load-test gate: rejected — cost outweighs benefit pre-customer. Tracked as a follow-up via `saturation-finder` if a real customer surfaces concerns.                                                                                                               |
| D-9  | `?debug=true` test endpoint gated behind `tool:write` (same RBAC bar as editing the tool).                                                                                                                                                                                                                                                                                                                                                                           | Rendered envelope contains `<wsse:Password>` digest + `<wsse:Nonce>` + `<wsu:Timestamp>`. Even though digest is non-reversible, nonce+timestamp are replay-attack-adjacent metadata and warrant elevated permission.                                                                                                                                                              | Always return rendered envelope: rejected — privacy regression. Project-admin only: rejected — unnecessary RBAC narrowing; `tool:write` already gates authoring.                                                                                                             |
| D-10 | `<wsse:Nonce>` + `<wsu:Timestamp>` redacted from `?debug=true` response.                                                                                                                                                                                                                                                                                                                                                                                             | Replay-attack-adjacent metadata. Redaction in the test surface is harmless because the user already knows the request shape (they authored it). Production trace events are gated by `HTTP_TOOL_SOAP_DEBUG_RAW_REQUEST=false` (default off).                                                                                                                                      | Return un-redacted envelope: rejected — leaks replay metadata for marginal debugging benefit.                                                                                                                                                                                |
| D-11 | Auto-XML-escape `{{input.X}}` placeholder values in SOAP body templates (resolves HLD Open Question #1).                                                                                                                                                                                                                                                                                                                                                             | Safer default. Most SOAP templates expect a textual value; escaping prevents accidental injection (`<` / `>` / `&` / `"` / `'` in user input breaking the envelope). Template authors who need raw XML can use a future `{{xml(input.X)}}` helper.                                                                                                                                | Explicit-only escaping: rejected — too easy for builders to forget and ship a broken or vulnerable tool.                                                                                                                                                                     |
| D-12 | One-way SOAP operation return shape (no response Body): `{ oneWay: true }` (resolves HLD Open Question #2).                                                                                                                                                                                                                                                                                                                                                          | Discriminable, structurally non-empty (so downstream consumers can check `result.oneWay === true`), self-documenting. `null` would conflict with errors; `{}` would be ambiguous with empty success.                                                                                                                                                                              | `null`: rejected — ambiguous with error. `{}`: rejected — ambiguous with "empty success." `void`: rejected — harder to log/audit.                                                                                                                                            |
| D-13 | Pin `fast-xml-parser` at `5.6.0` (resolves HLD Open Question #3).                                                                                                                                                                                                                                                                                                                                                                                                    | Already resolved by `pnpm-lock.yaml`. Verified that v5.x has `processEntities: false` as the safe default. Pinning prevents an unannounced minor bump from changing parser-security defaults under us.                                                                                                                                                                            | Float to `>= 5.5.6`: rejected — minor bumps could change defaults silently.                                                                                                                                                                                                  |
| D-14 | Refactor `patchToolWithResolvedAuth` to an options-object signature now (Phase 2). Acknowledge that 6 other enterprise auth credential fields on `ApplyAuthResult` (`awsCredentials`, `azureCredentials`, `sshCredentials`, `digestCredentials`, `kerberosCredentials`, `samlCredentials`, `hawkCredentials`) have the **same systemic propagation gap** as `wsSecurityCredentials` — they're set on `ApplyAuthResult` but dropped at the `ToolAuthResult` boundary. | Generalizing the propagation now (touching all 7 credential types) would explode scope. Refactoring the function signature now (so adding the next type is a one-line change) is the pragmatic middle ground. Documented as a follow-up in §7.                                                                                                                                    | Generalize all 7 propagations now: rejected — out of v1 scope. Keep positional signature: rejected — would force the same refactor on the next auth-type addition.                                                                                                           |
| D-15 | Auto-XML-escape integration: add a third boolean flag `escapeForXmlBodyTemplate` to `formatPlaceholderValue()` and `resolveInputPlaceholders()` (`http-tool-executor.ts:582-599, 765-835`). Set it `true` when `bodyType === 'xml'` AND `protocol === 'soap'` (or strictly when `protocol === 'soap'` since SOAP bodies are always XML).                                                                                                                             | Mirrors the existing `escapeForJsonBodyTemplate` and `encodeForFormBodyTemplate` flags that already gate per-body-type escaping. One additional boolean flag is the minimum-disruption integration.                                                                                                                                                                               | New escape mode parameter (discriminated union): rejected — refactoring the existing flag pattern is out of scope. Escape outside `formatPlaceholderValue` (in `soap-envelope.ts`): rejected — placeholder values would be double-escaped if the resolver also touches them. |

### Key Interfaces & Types

```typescript
// packages/compiler/src/platform/ir/schema.ts — extend HttpBindingIR
export interface HttpBindingIR {
  // ... existing fields ...
  protocol?: 'rest' | 'soap'; // default 'rest'
  soap_version?: '1.1' | '1.2'; // required when protocol === 'soap'; default '1.1'
  soap_action?: string; // optional
  on_soap_fault?: 'error' | 'data'; // default 'error'
}

// packages/compiler/src/platform/constructs/executors/soap-envelope.ts — NEW
export interface WsSecurityCredentialsForExec {
  username: string;
  password: string;
  certificate?: string;
  mustUnderstand: boolean;
}

/** Transient runtime-only extension. NOT persisted, NOT serialized. */
export interface SoapHttpBindingIR extends HttpBindingIR {
  _wsSecurityCredentials?: WsSecurityCredentialsForExec;
}

export type SoapVersion = '1.1' | '1.2';

export const SOAP_CONTENT_TYPES: Record<SoapVersion, string> = {
  '1.1': 'text/xml; charset=utf-8',
  '1.2': 'application/soap+xml; charset=utf-8',
};

export interface RenderedSoapRequest {
  body: string; // full envelope post WS-Security injection
  contentType: string;
  soapActionHeader?: string; // 1.1 only
}

export function renderSoapRequest(args: {
  binding: SoapHttpBindingIR;
  resolvedBody: string; // {{input.X}}-resolved, XML-escaped
  resolvedSoapAction?: string;
}): RenderedSoapRequest;

export interface ParsedSoapResponse {
  payload: unknown; // Body content unwrapped, JSON-shaped
  isFault: boolean;
  fault?: { code: string; reason: string };
}

export function parseSoapResponse(args: {
  bytes: Uint8Array;
  contentType: string | null;
  soapVersion: SoapVersion;
}): ParsedSoapResponse;

// apps/runtime/src/services/auth-profile/resolve-tool-auth.ts — extend ToolAuthResult (FR-13)
export interface ToolAuthResult {
  // ... existing fields ...
  /** WS-Security credentials propagated from applyAuth's ws_security branch. */
  wsSecurityCredentials?: {
    username: string;
    password: string;
    certificate?: string;
    mustUnderstand: boolean;
  };
}
```

### Module Boundaries

| Module                                                                      | Responsibility                                                                                                  | Depends On                                                                                             |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `packages/compiler/src/platform/ir/schema.ts`                               | Defines `HttpBindingIR` IR shape — gains 4 optional fields.                                                     | None (leaf module).                                                                                    |
| `packages/compiler/src/platform/ir/compiler.ts`                             | `compileHttpBinding()` AST→IR mapping — gains 4 field passthroughs.                                             | `schema.ts`.                                                                                           |
| `packages/compiler/src/platform/constructs/executors/soap-envelope.ts`      | NEW — envelope rendering, WS-Security injection, hardened XML parser factory, fault detection, response unwrap. | `applyWsSecurity` from `@agent-platform/auth-enterprise`; `fast-xml-parser` v5.6.0; `schema.ts` types. |
| `packages/compiler/src/platform/constructs/executors/http-tool-executor.ts` | Branches on `binding.protocol` in `buildRequest` (request) and response handler. Calls into `soap-envelope.ts`. | `soap-envelope.ts`.                                                                                    |
| `packages/shared/src/validation/project-tool-schemas.ts`                    | Zod schema for HTTP tool — gains 4 fields with FR-12 cross-field validation.                                    | None (leaf module).                                                                                    |
| `packages/shared/src/tools/dsl-property-parser.ts`                          | `buildHttpBindingFromProps` — gains 4 field reads onto `HttpBindingIRLocal`.                                    | None (leaf module).                                                                                    |
| `packages/shared/src/tools/serialize-tool-form-to-dsl.ts`                   | `serializeHttpProperties` — emits SOAP lines when `protocol === 'soap'`.                                        | `HttpToolFormData` from `@agent-platform/shared-kernel`.                                               |
| `packages/shared/src/tools/parse-dsl-to-tool-form.ts`                       | Parses SOAP DSL lines back to form state.                                                                       | `HttpToolFormData`.                                                                                    |
| `packages/shared-kernel/src/types/project-tool-form.ts`                     | `HttpToolFormData` — gains 4 fields.                                                                            | None.                                                                                                  |
| `packages/core/src/parser/agent-based-parser.ts`                            | Adds SOAP DSL names to `TOOL_IMPLEMENTATION_PROPERTIES` denylist.                                               | None.                                                                                                  |
| `apps/runtime/src/services/auth-profile/resolve-tool-auth.ts`               | Propagates `wsSecurityCredentials` from `appliedAuth` onto `ToolAuthResult`.                                    | `apply-auth.ts` (no change).                                                                           |
| `apps/runtime/src/services/auth-profile/auth-profile-tool-middleware.ts`    | `patchToolWithResolvedAuth` gains `wsSecurityCredentials?` parameter and writes the transient field.            | `resolve-tool-auth.ts`.                                                                                |
| `apps/studio/src/components/tools/HttpConfigForm.tsx`                       | Protocol toggle, SOAP version radio, SOAPAction field, fault-handling selector, SOAP body template.             | `shared-types.ts`.                                                                                     |
| `apps/studio/src/components/tools/wizard/HttpToolWizard.tsx`                | Surfaces the protocol toggle in step 2.                                                                         | `HttpConfigForm.tsx`.                                                                                  |
| `apps/studio/src/components/tools/ToolTestPanel.tsx`                        | Renders rendered SOAP envelope (request) and parsed JSON (response) when `protocol === 'soap'`.                 | API response shape.                                                                                    |
| `apps/studio/src/components/tools/{shared-types.ts, form-adapters.ts}`      | TypeScript types + form↔API mapping for new fields.                                                             | None.                                                                                                  |

---

## 2. File-Level Change Map

### New Files

| File                                                                          | Purpose                                                                                                         | LOC Estimate |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------ |
| `packages/compiler/src/platform/constructs/executors/soap-envelope.ts`        | Envelope rendering, WS-Security injection, hardened parser factory, fault detector, response unwrapper.         | ~280         |
| `packages/compiler/src/__tests__/constructs/http-tool-executor-soap.test.ts`  | INT-1, INT-2, INT-4, INT-5, INT-6 + U-1..U-16; SEC-7, SEC-8, SEC-9, SEC-12.                                     | ~700         |
| `packages/shared/src/__tests__/serialize-tool-form-to-dsl-soap.test.ts`       | U-17..U-19 round-trip.                                                                                          | ~140         |
| `packages/shared/src/__tests__/project-tool-schemas-soap.test.ts`             | U-20..U-22; FR-12 cross-field validation.                                                                       | ~150         |
| `apps/runtime/src/__tests__/auth/auth-profile/resolve-tool-auth-soap.test.ts` | INT-3 (FR-13 propagation), SEC-3.                                                                               | ~220         |
| `apps/studio/src/__tests__/components/tools/HttpConfigForm-soap.test.tsx`     | U-23..U-26; FR-9.                                                                                               | ~200         |
| `apps/studio/src/__tests__/e2e/fixtures/soap-stub-server.ts`                  | Stub SOAP 1.1 + 1.2 Express servers; canned responses; XXE / billion-laughs / fault payloads; capture endpoint. | ~280         |
| `apps/studio/src/__tests__/e2e/soap-tool.e2e.test.ts`                         | E2E-1..E2E-7 + E2E-5b/5c/5d; SEC-1, SEC-2, SEC-4, SEC-5, SEC-6, SEC-10.                                         | ~900         |

**Total new LOC**: ~2,870

### Modified Files

| File                                                                        | Change Description                                                                                                                                                                    | Risk   |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| `packages/compiler/src/platform/ir/schema.ts`                               | Extend `HttpBindingIR` interface with `protocol`, `soap_version`, `soap_action`, `on_soap_fault` (all optional).                                                                      | Low    |
| `packages/compiler/src/platform/ir/compiler.ts`                             | `compileHttpBinding()` (~L1030) maps the new AST fields to IR fields. Verify `mergeAgentToolBehavior` (~L135) preserves `http_binding` (already does via spread; no change needed).   | Low    |
| `packages/compiler/src/platform/ir/tool-schema-validator.ts`                | Add SOAP-specific validation: `soap_version` required when `protocol === 'soap'`; `soap_action` rejected when `protocol === 'rest'`.                                                  | Low    |
| `packages/compiler/src/platform/constructs/executors/http-tool-executor.ts` | In `buildRequest()` (~L459) and the response handler: branch on `binding.protocol` and delegate to `soap-envelope.ts` helpers. Emit `WS_SECURITY_BOUND_TO_REST_TOOL` warning (FR-11). | Medium |
| `packages/compiler/src/__tests__/constructs/tool-binding-executor.test.ts`  | Add a regression case asserting SOAP tools route through `HttpToolExecutor` (no protocol-aware dispatch).                                                                             | Low    |
| `packages/compiler/src/__tests__/constructs/tool-lifecycle-e2e.test.ts`     | Extend with one SOAP lifecycle test (create → IR compile → execute against stub).                                                                                                     | Low    |
| `packages/shared/src/validation/project-tool-schemas.ts`                    | Extend `CreateHttpToolSchema` (L82-123): add 4 fields with defaults; add `.superRefine` for FR-12 cross-field validation.                                                             | Low    |
| `packages/shared/src/tools/dsl-property-parser.ts`                          | `HttpBindingIRLocal` (L27-39) gains 4 fields. `buildHttpBindingFromProps` (L312, body_type branch ~L384) reads them.                                                                  | Low    |
| `packages/shared/src/tools/serialize-tool-form-to-dsl.ts`                   | `serializeHttpProperties` (L82, L131) emits new lines when `protocol === 'soap'`.                                                                                                     | Low    |
| `packages/shared/src/tools/parse-dsl-to-tool-form.ts`                       | Parse SOAP DSL lines back to `HttpToolFormData`.                                                                                                                                      | Low    |
| `packages/shared-kernel/src/types/project-tool-form.ts`                     | Extend `HttpToolFormData` (L57-78) with 4 fields.                                                                                                                                     | Low    |
| `packages/core/src/parser/agent-based-parser.ts`                            | Add `'protocol'`, `'soap_version'`, `'soap_action'`, `'on_soap_fault'` to `TOOL_IMPLEMENTATION_PROPERTIES` (L99-118).                                                                 | Low    |
| `apps/runtime/src/services/auth-profile/resolve-tool-auth.ts`               | Extend `ToolAuthResult` (L93-106) with optional `wsSecurityCredentials`. Propagate `appliedAuth.wsSecurityCredentials` (L262-269 return site).                                        | Medium |
| `apps/runtime/src/services/auth-profile/auth-profile-tool-middleware.ts`    | `patchToolWithResolvedAuth` (L401-425) gains `wsSecurityCredentials?` param; writes `tool.http_binding._wsSecurityCredentials`. Both call sites (L116-121, L376) pass the new arg.    | Medium |
| `apps/studio/src/components/tools/HttpConfigForm.tsx`                       | Protocol toggle, SOAP version radio, SOAPAction field, fault selector, SOAP envelope body template; force POST + XML body type when SOAP.                                             | Low    |
| `apps/studio/src/components/tools/wizard/HttpToolWizard.tsx`                | Surface the protocol toggle in step 2 (Config).                                                                                                                                       | Low    |
| `apps/studio/src/components/tools/shared-types.ts`                          | Extend `HttpConfig`, add `Protocol`, `SoapVersion`, `OnSoapFault` types.                                                                                                              | Low    |
| `apps/studio/src/components/tools/form-adapters.ts`                         | Map UI form state ↔ API payload for the 4 new fields.                                                                                                                                 | Low    |
| `apps/studio/src/components/tools/ToolTestPanel.tsx`                        | Render rendered SOAP envelope (request) when debug response includes it; render parsed JSON response.                                                                                 | Low    |
| `apps/studio/src/components/tools/ToolTypeBadge.tsx`                        | Add a small "SOAP" sub-badge / chip when `protocol === 'soap'` (cosmetic, last).                                                                                                      | Low    |
| `apps/studio/src/app/api/projects/[id]/tools/[toolId]/test/route.ts`        | Accept `?debug=true`, gate behind `tool:write`; include rendered request (with nonce/timestamp redacted per D-10) on debug responses.                                                 | Medium |
| `docs/features/sub-features/soap-tool-support.md`                           | Status update PLANNED → ALPHA after Phase 4 commit lands; resolve OQs #1, #2, #3 by linking decisions D-11/12/13.                                                                     | Low    |
| `docs/testing/sub-features/soap-tool-support.md`                            | Status update PLANNED → IN PROGRESS during implementation; PARTIAL after E2E green; STABLE after BETA gate.                                                                           | Low    |

### Deleted Files

**None.**

---

## 3. Implementation Phases

CRITICAL: Each phase ends in an independently mergeable commit. No phase leaves the system broken. Every phase respects the commit-scope-guard (≤3 packages) and deletion-ratio-guard (feat commits ≤30% deletions).

### Phase 1 — Additive scaffolding (IR + Zod + DSL + form types)

**Goal**: Land the four new fields end-to-end through DSL → IR → form types → Zod validation, with no executor or runtime changes. Zero behavior change for existing REST tools.

**Tasks**:

1.1 Extend `HttpBindingIR` in `packages/compiler/src/platform/ir/schema.ts` with `protocol?: 'rest' | 'soap'`, `soap_version?: '1.1' | '1.2'`, `soap_action?: string`, `on_soap_fault?: 'error' | 'data'`. Defaults documented in TSDoc.
1.2 **Phase 1 splits into two commits to honor the 3-package commit-scope-guard limit.** `HttpBindingAST` lives at `packages/core/src/types/agent-based.ts:654-678` (verified — NOT in `packages/compiler`), so its extension forces `core` into the same commit if combined with `compiler` work. Rather than expanding the package count, split:

- **Phase 1a** (Commit A1): `core` + `shared` + `shared-kernel` — extend `HttpBindingAST` (core), add `agent-based-parser` denylist names (core, moved up from Phase 2), extend Zod schema + DSL serializer/parser + `HttpBindingIRLocal` (shared), extend `HttpToolFormData` (shared-kernel), plus the unit tests under `packages/shared`. Three packages exactly.
- **Phase 1b** (Commit A2): `compiler` only — extend `HttpBindingIR` (schema), extend `compileHttpBinding()` (`compiler.ts:~L1030`) to map AST→IR (snake_case `protocol: ast.protocol, soap_version: ast.soapVersion, soap_action: ast.soapAction, on_soap_fault: ast.onSoapFault` following the `body_type: ast.bodyType` convention at L1050), extend `tool-schema-validator` for FR-12, extend `tool-binding-executor.test.ts` regression. One package.
- This restructures Phase 2's task 2.6 (denylist) — it moves to Phase 1a, eliminating the inter-phase gap entirely. Phase 2 remains `compiler` + `runtime` (2 packages). See updated commit plan in §3 Phase 2.
  1.3 Extend `tool-schema-validator.ts` to validate `soap_version` presence when `protocol === 'soap'` and `soap_action` absence when `protocol === 'rest'`.
  1.4 Extend `HttpToolFormData` in `packages/shared-kernel/src/types/project-tool-form.ts` (L57-78) with `protocol?`, `soapVersion?`, `soapAction?`, `onSoapFault?` (camelCase).
  1.5 Extend `CreateHttpToolSchema` in `packages/shared/src/validation/project-tool-schemas.ts` (L82-123): add 4 Zod fields with `.default(...)`. Add `.superRefine` implementing FR-12 (`soapAction` only when `protocol === 'soap'`; `soapVersion` required when `protocol === 'soap'`; `protocol` enum rejects unknowns).
  1.6 Extend `HttpBindingIRLocal` in `packages/shared/src/tools/dsl-property-parser.ts` (L27-39) with the 4 fields. Extend `buildHttpBindingFromProps` (L312, body_type branch ~L384) to read `props.protocol`, `props.soap_version`, `props.soap_action`, `props.on_soap_fault`.
  1.7 Extend `serializeHttpProperties` in `packages/shared/src/tools/serialize-tool-form-to-dsl.ts` (~L82, L131) to emit `protocol: soap`, `soap_version: ...`, `soap_action: ...`, `on_soap_fault: ...` lines **only when `protocol === 'soap'`** (REST DSL output stays byte-identical).
  1.8 Extend `parse-dsl-to-tool-form.ts` to round-trip the 4 fields back to form state.
  1.9 Write unit tests:
- `packages/shared/src/__tests__/serialize-tool-form-to-dsl-soap.test.ts` covering U-17, U-18, U-19.
- `packages/shared/src/__tests__/project-tool-schemas-soap.test.ts` covering U-20, U-21, U-22 (FR-12 cross-field).
- Extend existing `tool-binding-executor.test.ts` with a regression case asserting SOAP tools route through `HttpToolExecutor` (no protocol-aware dispatch).

**Files Touched**:

_Phase 1a (commit A1, packages: `core` + `shared` + `shared-kernel`)_

- `packages/core/src/types/agent-based.ts` — extend `HttpBindingAST` (L654-678) with `protocol?`, `soapVersion?`, `soapAction?`, `onSoapFault?` (camelCase AST convention).
- `packages/core/src/parser/agent-based-parser.ts` — add `'protocol'`, `'soap_version'`, `'soap_action'`, `'on_soap_fault'` to `TOOL_IMPLEMENTATION_PROPERTIES` (L99-118; moved from former task 2.6).
- `packages/shared/src/validation/project-tool-schemas.ts`
- `packages/shared/src/tools/dsl-property-parser.ts`
- `packages/shared/src/tools/serialize-tool-form-to-dsl.ts`
- `packages/shared/src/tools/parse-dsl-to-tool-form.ts`
- `packages/shared/src/__tests__/serialize-tool-form-to-dsl-soap.test.ts` (new)
- `packages/shared/src/__tests__/project-tool-schemas-soap.test.ts` (new)
- `packages/shared-kernel/src/types/project-tool-form.ts`

_Phase 1b (commit A2, package: `compiler` only)_

- `packages/compiler/src/platform/ir/schema.ts`
- `packages/compiler/src/platform/ir/compiler.ts`
- `packages/compiler/src/platform/ir/tool-schema-validator.ts`
- `packages/compiler/src/__tests__/constructs/tool-binding-executor.test.ts`
- `packages/compiler/src/__tests__/constructs/tool-lifecycle-e2e.test.ts` — extend with INT-7 DSL→IR round-trip for SOAP fields.

**Packages**: split per task 1.2 — Phase 1a = `core` + `shared` + `shared-kernel` (3, within limit); Phase 1b = `compiler` only (1, within limit). Two sequential commits.

**Exit Criteria**:

- [ ] `pnpm build --filter=@abl/core --filter=@abl/compiler --filter=@agent-platform/shared --filter=@agent-platform/shared-kernel` succeeds with 0 type errors.
- [ ] `pnpm test --filter=@agent-platform/shared` passes; 6 new test cases (U-17..U-22) green; existing test suite green.
- [ ] `pnpm test --filter=@abl/compiler` passes; new dispatcher regression case green; existing 1,000+ tests green.
- [ ] DSL round-trip: a SOAP DSL string parses to form data, serializes back to DSL, and the result equals the input byte-for-byte.
- [ ] A REST tool with no `protocol` field continues to serialize to a DSL with no `protocol:` line (verified by U-18).
- [ ] FR-12 violations produce 400-level Zod errors with descriptive messages (verified by U-21).

**Test Strategy** (Phase 1):

- Unit: U-17..U-22 (DSL round-trip + Zod cross-field). All run inside the package; no Express, no Mongo, no Redis.
- Integration: **INT-7** (DSL→IR lockstep round-trip) lands in Phase 1b alongside `compileHttpBinding`. The test exercises `dsl-property-parser` → AST → `compileHttpBinding` → `HttpBindingIR` → `serializeHttpProperties` → DSL string → byte-identical equality for SOAP tools, and confirms a REST tool with no `protocol` field round-trips with no SOAP-specific lines. Add to `packages/compiler/src/__tests__/constructs/tool-lifecycle-e2e.test.ts` (extend the existing file rather than a new file — the existing lifecycle test is the natural home for end-to-end IR round-trips).
- E2E: none in Phase 1.

**Rollback**: revert the single commit. Existing REST tools are byte-identical, so revert is a no-op for users.

**Commits**:

- A1 — `[ABLP-XXX] feat(tools): SOAP DSL types + Zod + form types + parser denylist for HTTP tools` (core + shared + shared-kernel; additive).
- A2 — `[ABLP-XXX] feat(compiler): SOAP fields on HttpBindingIR + compileHttpBinding mapping` (compiler only; additive).

---

### Phase 2 — Executor SOAP branch + FR-13 auth propagation

**Goal**: Land the runtime executor SOAP branch (envelope wrapping, WS-Security injection, hardened parser, fault detection) and the FR-13 propagation that feeds it. INT-3 leads (test-first per D-6).

**Tasks**:

2.1 **Test-first** for FR-13 (development-workflow methodology, NOT a separate failing-test commit). Locally: write `apps/runtime/src/__tests__/auth/auth-profile/resolve-tool-auth-soap.test.ts` with INT-3 (assert `ToolAuthResult.wsSecurityCredentials` is populated for a `ws_security` auth profile) and SEC-3 (cross-user personal-profile invisibility). Run it against develop **without** the FR-13 fix in place to verify it fails (proves the gap exists). Then implement tasks 2.2-2.4 to make the test pass. **Commit the test and the fix together** — never push a known-failing test to CI. The "test-first" is methodological, not a commit boundary.
2.2 Extend `ToolAuthResult` in `apps/runtime/src/services/auth-profile/resolve-tool-auth.ts` (L93-106) with optional `wsSecurityCredentials?: { username; password; certificate?; mustUnderstand }`.
2.3 In `resolveToolAuth()` (L262-269 return site for `auth_profile` source), copy `appliedAuth.wsSecurityCredentials` onto the returned `ToolAuthResult`.
2.4 **Refactor `patchToolWithResolvedAuth` to an options-object signature** (`auth-profile-tool-middleware.ts:401-425`). The current 4-positional signature would grow to 5 with this change; with 6 other enterprise auth credential types in `ApplyAuthResult` (`hawkCredentials`, `digestCredentials`, `kerberosCredentials`, `samlCredentials`, etc. — see I3 systemic-gap note in §1) eventually needing the same propagation, the positional pattern does not scale. Refactor now:

```typescript
function patchToolWithResolvedAuth(
  tool: NonNullable<ToolCallContext['tool']>,
  opts: {
    headers: Record<string, string>;
    queryParams?: Record<string, string>;
    tlsOptions?: { cert: string; key: string; ca?: string; rejectUnauthorized: true };
    wsSecurityCredentials?: {
      username: string;
      password: string;
      certificate?: string;
      mustUnderstand: boolean;
    };
  },
): NonNullable<ToolCallContext['tool']>;
```

Update **both** call sites:

- L116-121: `patchToolWithResolvedAuth(tool, { headers: authResult.headers, queryParams: authResult.queryParams, tlsOptions: authResult.tlsOptions, wsSecurityCredentials: authResult.wsSecurityCredentials })`.
- L376 (variable in scope is `freshResult` per `auth-profile-tool-middleware.ts:368`): same shape using `freshResult` properties.
- When `opts.wsSecurityCredentials` is present and `tool.http_binding` exists, set `tool.http_binding._wsSecurityCredentials` on the returned spread.
  2.5 Verify INT-3 passes after 2.2-2.4. Re-run; assert green.
  2.6 (Moved to Phase 1a per round-2 audit fix.) The denylist update for `TOOL_IMPLEMENTATION_PROPERTIES` in `packages/core/src/parser/agent-based-parser.ts` ships with Phase 1a's `core` work, eliminating the inter-phase gap.
  2.7 Create `packages/compiler/src/platform/constructs/executors/soap-envelope.ts` with:
- `SOAP_CONTENT_TYPES: Record<NonNullable<HttpBindingIR['soap_version']>, string>` map (1.1 + 1.2) — typing matches the existing `BODY_TYPE_CONTENT_TYPES` pattern at `http-tool-executor.ts:146`.
- `SOAP_ENVELOPE_NAMESPACES: Record<NonNullable<HttpBindingIR['soap_version']>, string>` map.
- Hardened `fast-xml-parser` factory: `processEntities: false`, `allowBooleanAttributes: false`, no DTD, `maxDepth = safeParseInt(process.env.HTTP_TOOL_SOAP_PARSER_MAX_DEPTH, 64)` (matching existing `safeParseInt` pattern at `http-tool-executor.ts:118-144`). Log resolved config once at module init via `createLogger('soap-envelope')` for runbook visibility (matches `http-tool-executor.ts:36` logger pattern).
- `xmlEscape(value: unknown): string` — escapes `&`, `<`, `>`, `"`, `'` (D-11 auto-escape) — used internally by `renderSoapRequest` AND consumed by the placeholder resolver (see task 2.8 integration with `formatPlaceholderValue`).
- `renderSoapRequest(args)` — builds envelope, injects WS-Security if credentials present, sets Content-Type + SOAPAction. Detection of an existing `<soap:Envelope>` in the user body uses a **simple case-sensitive prefix check** (no XML parse): `body.trimStart().startsWith('<soap:Envelope') || body.trimStart().startsWith('<soapenv:Envelope') || body.trimStart().startsWith('<SOAP-ENV:Envelope') || body.trimStart().startsWith('<env:Envelope')`. If detected, do not double-wrap; if WS-Security credentials are present, inject `<wsse:Security>` into the existing `<soap:Header>` element (or synthesize one if absent).
- `parseSoapResponse(args)` — parses bytes, strips envelope/Body, detects `<soap:Fault>` (1.1 + 1.2 with prefix tolerance: `soap:`, `soapenv:`, `SOAP-ENV:`, `env:`).
- `SoapHttpBindingIR` typed accessor (D-5) and `WsSecurityCredentialsForExec` interface — exported.
- One-way operation handling per D-12 returns `{ oneWay: true }`.
- **No re-export of `sanitizeHeaderValue`** — that function is module-private to `http-tool-executor.ts` (L160) and not exported. The CRLF-strip on `soap_action` happens **inside `buildRequest()`** (where `sanitizeHeaderValue` is in scope) before the value is passed to `renderSoapRequest`. The "mirror" of D-3 is the structural pattern (sibling helper module), not function reuse.
- The module's API is narrow and self-contained: no platform-component imports beyond `@agent-platform/auth-enterprise:applyWsSecurity()`, `@abl/compiler/platform:createLogger`, and `fast-xml-parser`. Pure transformation functions, no side effects, no I/O.
  2.8 Branch in `HttpToolExecutor.buildRequest()` (`http-tool-executor.ts:~L459`):
- **Placeholder resolution integration (D-15)**: extend the **complete** flag-threading chain with a new boolean `escapeForXmlBodyTemplate` (alongside the existing `escapeForJsonBodyTemplate` and `encodeForFormBodyTemplate`). All call sites that touch placeholder values inside body templates must receive the flag — missing any one of them creates an injection vector for unescaped values. The full list (verified against `http-tool-executor.ts`):
  - `formatPlaceholderValue` (L949-967) — positional flag arg.
  - `resolveInputPlaceholders` (L934) — positional flag arg.
  - `resolveContextPlaceholders` (L762) — positional flag arg.
  - `resolveSessionPlaceholders` (L785) — positional flag arg.
  - `resolveSecrets` (L800) — positional flag arg. **Critical**: a `{{secrets.X}}` value containing `<` would break the envelope without this.
  - `resolveEnvVars` (L849) — positional flag arg. Same reasoning for `{{env.X}}`.
  - `resolvePlaceholders` orchestrator (L897-928) — uses an **options-object** parameter pattern (existing flags at L900-904); add `escapeForXmlBodyTemplate?: boolean` to that object for consistency with the existing pattern (do NOT convert it to positional).
  - Internally, `formatPlaceholderValue` calls `xmlEscape` from `soap-envelope.ts` when this flag is set.
- In `buildRequest()`: at the existing flag-setting block (L582-585), add `const escapeForXmlBodyTemplate = binding.protocol === 'soap';`. Pass through to all six resolver calls + the orchestrator's options object. The existing branching by `bodyType === 'json'` etc. is unchanged.
- When `binding.protocol === 'soap'`: after placeholder resolution (now with XML-escaped values), call `renderSoapRequest({ binding: binding as SoapHttpBindingIR, resolvedBody, resolvedSoapAction: sanitizeHeaderValue(resolvedSoapAction) })`. Set the returned `contentType` on the request headers (overriding `BODY_TYPE_CONTENT_TYPES.xml`) and emit `SOAPAction` header (1.1) from `renderSoapRequest`'s return.
- When `binding.protocol === 'rest'` (or undefined): existing path unchanged. The new `escapeForXmlBodyTemplate` flag is `false` for REST tools — zero behavior change.
  2.9 Branch in the response handler:
- When `binding.protocol === 'soap'`: call `parseSoapResponse`. If `isFault`: branch on `on_soap_fault` (`'error'` → throw `ToolExecutionError({ code: 'TOOL_SOAP_FAULT', message: fault.reason })`; `'data'` → return parsed fault as `LLMToolResult` with `soap_fault: true` audit discriminator). Else: return parsed `payload`. On parse failure: throw `ToolExecutionError({ code: 'TOOL_RESPONSE_PARSE_FAILED' })`.
- When `binding.protocol === 'rest'`: existing path.
  2.10 Wire FR-11 warning: in the executor, when a tool has `auth_profile_ref` resolving to `ws_security` AND `binding.protocol !== 'soap'`, emit a structured warning log `WS_SECURITY_BOUND_TO_REST_TOOL` (no failure, no injection).
  2.11 Emit FR-10 trace fields: `tool_call` trace, audit entry, `tool.execution` log all gain `protocol`, `soap_version`, `soap_action` (when set). `soap_fault: true` discriminator on both error-path and data-path fault outcomes. **Note re feature spec §12 `tool.soap_fault_count` metric counter**: the LLD does NOT emit a dedicated platform metric counter. Instead, the `soap_fault: true` audit/trace discriminator subsumes the counter — operators aggregate fault rates from filtered trace queries (`protocol = 'soap' AND soap_fault = true`) using the existing trace-event aggregation pipeline. The metric-counter bullet in feature spec §12 should be updated during Phase 4 task 4.5 to reflect this implementation choice. If a dedicated pre-aggregated counter is required later, it can be added as a follow-up without changing this LLD's surface.
  2.12 Write `packages/compiler/src/__tests__/constructs/http-tool-executor-soap.test.ts` covering U-1..U-16 + INT-1, INT-2, INT-4, INT-5, INT-6 + SEC-7, SEC-8, SEC-9, SEC-12.

**Files Touched**:

- `packages/compiler/src/platform/constructs/executors/soap-envelope.ts` (new)
- `packages/compiler/src/platform/constructs/executors/http-tool-executor.ts`
- `packages/compiler/src/__tests__/constructs/http-tool-executor-soap.test.ts` (new)
- `apps/runtime/src/services/auth-profile/resolve-tool-auth.ts`
- `apps/runtime/src/services/auth-profile/auth-profile-tool-middleware.ts`
- `apps/runtime/src/__tests__/auth/auth-profile/resolve-tool-auth-soap.test.ts` (new)
- (Note: `packages/core/src/parser/agent-based-parser.ts` denylist update has moved to Phase 1a per round-2 audit fix.)

**Packages**: `compiler` + `runtime` (2 — within hook limit; `core`'s denylist moved to Phase 1a).

**Exit Criteria**:

- [ ] `pnpm build --filter=@abl/compiler --filter=apps/runtime` succeeds with 0 type errors.
- [ ] INT-3 (FR-13 propagation) green; SEC-3 green.
- [ ] All 16 unit cases (U-1..U-16) green: envelope wrapping (1.1 + 1.2), Content-Type, SOAPAction, double-wrap detection, namespace prefix tolerance, response unwrap, fault detection (1.1 + 1.2; HTTP 200 + 5xx), `on_soap_fault` modes, XXE blocking, billion-laughs blocking, deep-nesting blocking, REST regression (U-15, U-16).
- [ ] All 5 integration cases (INT-1, INT-2, INT-4, INT-5, INT-6) green: envelope framing, WS-Sec injection, REST-with-WS-Sec warning, hardened parser, fault detection across versions.
- [ ] FR-11 warning log assertable via test logger sink.
- [ ] Existing `http-tool-executor.test.ts` suite (3,000 lines, ~90 tests) remains green — zero regressions in REST path.
- [ ] FR-10 fields (`protocol`, `soap_version`, `soap_action`) appear in trace and audit log for SOAP executions; absent for REST executions.

**Test Strategy** (Phase 2):

- Unit: U-1..U-16 (envelope, parser, fault, regression). Run in-process; no Express, no Mongo.
- Integration: INT-1..INT-6 with a tiny in-process Express stub server on `{ port: 0 }` (real `safeFetch` + real resilience factory + real auth context construction). INT-3 also runs against `MongoMemoryServer` for real auth-profile encryption.
- E2E: deferred to Phase 4.

**Rollback**: revert the Phase 2 commits. Phase 1 scaffolding is harmless without the executor branch (no consumer reads the IR fields). The runtime auth-profile change is additive — `wsSecurityCredentials` becomes a no-op stripped at the boundary again.

**Commits**: split into two if size requires:

- `[ABLP-XXX] feat(runtime): propagate WS-Security credentials to HTTP tool executor (FR-13)` (`runtime` only).
- `[ABLP-XXX] feat(compiler): SOAP envelope wrapping + WS-Sec injection in HttpToolExecutor` (`compiler` only).

---

### Phase 3 — Studio UI

**Goal**: Surface the Protocol toggle and SOAP-specific fields in `HttpConfigForm` and `HttpToolWizard`. Wire the `?debug=true` test endpoint to return the rendered envelope (nonce/timestamp redacted per D-10).

**Tasks**:

3.1 Extend `apps/studio/src/components/tools/shared-types.ts`: add `Protocol`, `SoapVersion`, `OnSoapFault` types; extend `HttpConfig` interface.
3.2 Extend `apps/studio/src/components/tools/form-adapters.ts`: bidirectional mapping for the 4 new fields between UI form state and API payload (camelCase API ↔ snake_case DSL is handled by serializer in Phase 1).
3.3 Update `apps/studio/src/components/tools/HttpConfigForm.tsx`:

- Add Protocol toggle (REST | SOAP).
- When SOAP selected: show SOAP version radio (1.1 / 1.2), SOAPAction text field (supports `{{input.X}}`), Fault Handling selector (Treat fault as error | Treat fault as data).
- When SOAP selected: force method to POST (lock selector); force body type to XML (lock selector).
- When SOAP selected: prefill body with envelope skeleton template (preserve user edits on subsequent toggles).
- When REST selected: hide SOAP fields and clear `soapVersion`/`soapAction` from the emitted config.
  3.4 Update `apps/studio/src/components/tools/wizard/HttpToolWizard.tsx`: surface the same Protocol toggle in step 2 (Config). No new wizard steps.
  3.5 Update `apps/studio/src/components/tools/ToolTestPanel.tsx`:
- The current panel reads `toolType?: string` (`ToolTestPanel.tsx:31`). The SOAP discriminator is the tool config's `protocol` field, NOT `toolType` (which stays `'http'` for SOAP tools). Extend the panel's props to carry the resolved `protocol` from the tool config, OR have the test response carry `trace.protocol === 'soap'` and branch on that.
- When the test API response contains `renderedRequest` (debug mode), render the envelope in a "Request preview" tab.
- When the response indicates SOAP (via `trace.protocol === 'soap'` or the protocol prop), render the parsed JSON response in the "Response" tab (no XML hex dump).
  3.6 Update `apps/studio/src/components/tools/ToolTypeBadge.tsx`: add a small "SOAP" sub-badge / chip for `protocol === 'soap'` HTTP tools (cosmetic — last task in Phase 3, can defer to a follow-up if pressed for time).
  3.7 Update `apps/studio/src/app/api/projects/[id]/tools/[toolId]/test/route.ts`:
- Keep the existing declarative gate: `permissions: StudioPermission.TOOL_EXECUTE` on `withRouteHandler` (route-level base permission unchanged).
- Inside the handler body (`{ request, user, params, tenantId, project, body }` callback per `route-handler.ts:278`), check `request.nextUrl.searchParams.get('debug') === 'true'`. When debug is requested, perform a **conditional second check** by importing `hasPermission` from `@/lib/permission-resolver` and `StudioPermission.TOOL_WRITE` from `@/lib/permissions` (verified: `TOOL_WRITE = 'tool:write'`, `TOOL_EXECUTE = 'tool:execute'` at `permissions.ts:18,20`). If `!hasPermission(user.permissions, StudioPermission.TOOL_WRITE)`, return `403` with `ErrorCode.INSUFFICIENT_PERMISSIONS` and a sanitized message ("Debug mode requires tool:write permission"). This is a same-scope RBAC denial — **403, not 404** — because the caller already has access to the tool via `tool:execute`; they only lack the elevated permission for the debug surface.
- When `protocol === 'soap'` AND debug is authorized: invoke the executor in a "render-only" mode that returns the rendered SOAP envelope alongside the parsed response. Redact `<wsse:Nonce>` and `<wsu:Timestamp>` from the rendered envelope per D-10 (replace inner text with `***`).
- When debug not requested: existing response shape (no `renderedRequest`).
- Document the deviation: this is the only Studio route that performs a conditional permission check inside the handler body. The declarative pattern (single permission gate) does not support per-feature elevated checks, so the in-handler call is the established workaround (similar to project-owner override at `route-handler.ts:212`).
  3.8 Add i18n translation keys to the existing studio i18n locale files (the `HttpConfigForm` already uses `useTranslations` from `next-intl` per `HttpConfigForm.tsx:9`). Add under `tools.soap.*` namespace: `protocol`, `protocolRest`, `protocolSoap`, `soapVersion`, `soapVersion11`, `soapVersion12`, `soapAction`, `soapActionPlaceholder`, `faultHandling`, `faultHandlingError`, `faultHandlingData`, `bodyTemplateSoap`, `debugRequestPreview`, `debugForbidden`, `methodLockedSoap`, `bodyTypeLockedSoap`. The badge label goes under the existing `tools.type_badge.*` namespace as `tools.type_badge.soap_protocol` (matching the existing `TYPE_KEYS` pattern at `ToolTypeBadge.tsx:29-35`). Wire all new user-visible strings in `HttpConfigForm.tsx`, `HttpToolWizard.tsx`, `ToolTestPanel.tsx`, `ToolTypeBadge.tsx` through their respective `t('tools.X')` namespaces. The existing `i18n-guide` skill governs locale-key authoring.

  3.9 Write `apps/studio/src/__tests__/components/tools/HttpConfigForm-soap.test.tsx` covering U-23..U-26.

**Files Touched**:

- `apps/studio/src/components/tools/HttpConfigForm.tsx`
- `apps/studio/src/components/tools/wizard/HttpToolWizard.tsx`
- `apps/studio/src/components/tools/shared-types.ts`
- `apps/studio/src/components/tools/form-adapters.ts`
- `apps/studio/src/components/tools/ToolTestPanel.tsx`
- `apps/studio/src/components/tools/ToolTypeBadge.tsx`
- `apps/studio/src/app/api/projects/[id]/tools/[toolId]/test/route.ts`
- `apps/studio/src/__tests__/components/tools/HttpConfigForm-soap.test.tsx` (new)
- `packages/i18n/locales/en/studio.json` — i18n keys per task 3.8 (`tools.soap.*` namespace + `tools.type_badge.soap_protocol`).

**Packages**: `studio` + `i18n` (2 — within hook limit; `i18n` is a peer package per `packages/i18n/package.json`).

**Exit Criteria**:

- [ ] `pnpm build --filter=apps/studio` succeeds with 0 type errors.
- [ ] All 4 component unit tests (U-23..U-26) green: protocol toggle reveals/hides SOAP fields, body template swap, method/bodyType locked when SOAP, edits preserved across toggles.
- [ ] `?debug=true` test endpoint returns **403** (same-scope RBAC denial — caller has `tool:execute` and can already invoke the tool, but lacks the elevated `tool:write`) when caller lacks `tool:write`. **Not** 404 — the 404 invariant applies to cross-scope access (cross-tenant, cross-project), which is a different case. Verified via test using a project-member role with `tool:execute` only.
- [ ] `?debug=true` test endpoint returns `renderedRequest` with redacted nonce/timestamp; response body shows `<wsse:Nonce>***</wsse:Nonce>` and `<wsu:Created>***</wsu:Created>`.
- [ ] Studio dev mode: manually create a SOAP tool in the UI, verify the form behaves correctly, switch back to REST and verify SOAP fields disappear.

**Test Strategy** (Phase 3):

- Unit: U-23..U-26 component tests via React Testing Library.
- Integration: route handler test for `?debug=true` RBAC gating (real auth middleware, real Mongo).
- E2E: deferred to Phase 4.

**Rollback**: revert the Phase 3 commit. The Studio UI returns to REST-only authoring; existing SOAP tools created in Phase 1-2 testing become uneditable through the form (DSL editor still works).

**Commit**: `[ABLP-XXX] feat(studio): SOAP protocol toggle + debug envelope preview in HTTP tool form` (`studio` only).

---

### Phase 4 — End-to-end test fixture + E2E suite

**Goal**: Land the SOAP stub server fixture and the 10-scenario E2E suite. This validates the entire system end-to-end and clears the ALPHA → BETA gate.

**Tasks**:

4.1 Create `apps/studio/src/__tests__/e2e/fixtures/soap-stub-server.ts`:

- Two Express servers on random ports (1.1 + 1.2).
- Endpoints per test spec §2: `POST /Echo`, `POST /PolicyService/LookupPolicy`, `POST /Slow`, `POST /Malformed`, `POST /XXE`, `POST /BillionLaughs`, `POST /Big`, `GET /captured-requests`.
- Canned responses + fault payloads + XXE payload + billion-laughs payload.
- Capture all inbound requests (headers + body) for assertion.
  4.2 Create `apps/studio/src/__tests__/e2e/soap-tool.e2e.test.ts`:
- Mirror the harness pattern from `tool-invocations-api.e2e.test.ts:198-237` (MongoMemoryServer + Redis subprocess + Express wrapping Next.js routes + dev-login).
- Implement E2E-1 (1.1 happy path with WS-Security UsernameToken).
- Implement E2E-2 (1.2 framing).
- Implement E2E-3 (HTTP 200 fault → structured error).
- Implement E2E-4 (`onSoapFault: 'data'` opt-in).
- Implement E2E-5 (cross-tenant 404).
- Implement E2E-5b (cross-project 404).
- Implement E2E-5c (missing auth 401).
- Implement E2E-5d (insufficient permissions 403).
- Implement E2E-6 (SSRF for SOAP endpoints).
- Implement E2E-7 (agent-bound session integration with deterministic LLM stub returning canned tool call).
  4.3 Extend `packages/compiler/src/__tests__/constructs/tool-lifecycle-e2e.test.ts` with one SOAP lifecycle test (create → IR compile → execute against stub).
  4.4 Run the manual test plan M-1..M-6 once locally; document results in `docs/sdlc-logs/soap-tool-support/manual-test-results.md`.
  4.5 Update `docs/features/sub-features/soap-tool-support.md`: status PLANNED → ALPHA. Resolve feature spec **Open Question #1** (XML escaping) via D-11 link. Resolve feature spec **Open Question #2** (one-way return shape) via D-12 link. Close feature spec **Open Question #3** (raw XML response toggle) as "v1 omits per HLD recommendation". Close feature spec **Open Question #4** (debug envelope visibility) by linking to HLD §4 concern #3 and LLD D-9/D-10. _Note_: HLD Open Question #3 (`fast-xml-parser` version pin) is resolved by LLD D-13 but is not a feature-spec open question — no feature-spec edit needed for that. Update FR-13 description with the chosen mechanism (typed `_wsSecurityCredentials` field on `tool.http_binding`, set via the options-object refactor of `patchToolWithResolvedAuth` per D-14).
  4.6 Update `docs/testing/sub-features/soap-tool-support.md`: status PLANNED → IN PROGRESS, then PARTIAL once 7 E2E + 7 INT green. Update coverage matrix rows from NOT TESTED → ✅ PASSING per FR.
  4.7 Append package-learning entries to `packages/compiler/agents.md`, `packages/shared/agents.md`, `apps/runtime/agents.md`, `apps/studio/agents.md` documenting: the SOAP envelope sibling-module pattern, the transient `_wsSecurityCredentials` IR convention, the FR-13 propagation pathway, and the auto-XML-escape default (D-11).

**Files Touched**:

- `apps/studio/src/__tests__/e2e/fixtures/soap-stub-server.ts` (new)
- `apps/studio/src/__tests__/e2e/soap-tool.e2e.test.ts` (new)
- `packages/compiler/src/__tests__/constructs/tool-lifecycle-e2e.test.ts`
- `docs/features/sub-features/soap-tool-support.md`
- `docs/testing/sub-features/soap-tool-support.md`
- `docs/sdlc-logs/soap-tool-support/manual-test-results.md` (new)
- `packages/compiler/agents.md`
- `packages/shared/agents.md`
- `apps/runtime/agents.md`
- `apps/studio/agents.md`

**Packages**: `studio` + `compiler` (2 — within hook limit; agents.md changes are doc-only and don't count toward the package limit per CLAUDE.md scope-guard rules).

**Exit Criteria**:

- [ ] All 7 top-level E2E scenarios + 3 sub-scenarios green (E2E-1..E2E-7, E2E-5b/5c/5d).
- [ ] Stub SOAP servers (1.1 + 1.2) start and stop cleanly per suite; no leaked processes.
- [ ] Pre-commit hook `e2e-test-quality-lint.sh` does NOT block the new E2E test file (no `vi.mock` of platform components, no direct DB access, no stubbed servers in place of platform middleware).
- [ ] Manual test plan M-1..M-6 results documented; no "blocker" findings.
- [ ] Feature spec status updated to ALPHA; testing guide status updated to IN PROGRESS / PARTIAL based on green count.

**Test Strategy** (Phase 4):

- Unit: covered by Phases 1-3.
- Integration: covered by Phase 2.
- E2E: 10 scenarios against real Express + MongoMemoryServer + Redis subprocess + local SOAP stub. No platform mocks. Full middleware chain executes.
- Manual: M-1..M-6 against a public SOAP service (calculator WSDL or similar) to validate against real-world quirks before BETA promotion.

**Rollback**: revert the Phase 4 commit. The runtime + compiler + Studio code from Phases 1-3 stays in place; only the test fixture and E2E suite disappear. (However, this scenario is unlikely — Phase 4 is purely additive test code.)

**Commit**: `[ABLP-XXX] test(studio): SOAP tool E2E suite + stub fixture; promote feature to ALPHA` (`studio` + `compiler`).

---

## 4. Wiring Checklist

CRITICAL: Every new component must be wired into its callers. This section prevents the #1 agent failure mode: writing code that nothing calls.

- [ ] `HttpBindingIR` extension imported by `compiler.ts`'s `compileHttpBinding()` and reflected in the IR output.
- [ ] `CreateHttpToolSchema` extension consumed by the existing tool create/update API routes (no route registration change — they already use the schema).
- [ ] `HttpToolFormData` extension consumed by `HttpConfigForm.tsx`, `HttpToolWizard.tsx`, `form-adapters.ts`.
- [ ] `dsl-property-parser.ts` SOAP fields read by `buildHttpBindingFromProps` and surfaced in `HttpBindingIRLocal` → flows to runtime via `loadProjectToolsAsIR()` (no change needed there — it calls the existing builder).
- [ ] `serialize-tool-form-to-dsl.ts` SOAP emission triggered by Studio's tool save flow (calls existing serializer).
- [ ] `parse-dsl-to-tool-form.ts` SOAP parsing triggered when Studio loads an existing tool (calls existing parser).
- [ ] `agent-based-parser.ts` denylist entries automatically rejected from agent DSL `tools:` blocks (existing parser logic).
- [ ] `ToolAuthResult.wsSecurityCredentials` consumed by the runtime middleware (`auth-profile-tool-middleware.ts:108-121` and `:368-376` call sites both updated to pass through).
- [ ] `patchToolWithResolvedAuth`'s 5th parameter wired at both call sites; the patched tool's `_wsSecurityCredentials` flows into `ctx.tool` → `dispatch()` → `HttpToolExecutor`.
- [ ] `soap-envelope.ts` exports imported by `http-tool-executor.ts`'s `buildRequest()` and response handler.
- [ ] `HttpToolExecutor` SOAP branch reads `binding._wsSecurityCredentials` via `SoapHttpBindingIR` cast and consumes it in `renderSoapRequest`.
- [ ] Trace events, audit entries, `tool.execution` log entries all include `protocol`, `soap_version`, `soap_action` (where set) — wired in `HttpToolExecutor` post-dispatch logging.
- [ ] Studio test endpoint `?debug=true` returns the rendered envelope when SOAP; the response shape is consumed by `ToolTestPanel.tsx`'s preview tab.
- [ ] No new routes to register. No new workers. No new middleware.

---

## 5. Cross-Phase Concerns

### Database Migrations

**None.** No schema changes. `dslContent` carries the new lines; `toolType` enum unchanged; no new collections.

### Feature Flags

**None.** Per HLD §4 concern #11 and D-7. Opt-in authoring + per-tenant circuit breaker isolation provide adequate gating.

### Configuration Changes

| Variable                           | Default | Description                                                                                                          |
| ---------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------- |
| `HTTP_TOOL_SOAP_PARSER_MAX_DEPTH`  | `64`    | Maximum XML element nesting depth permitted by the SOAP response parser (defends against deep-nesting DoS).          |
| `HTTP_TOOL_SOAP_DEBUG_RAW_REQUEST` | `false` | When `true`, includes the rendered SOAP envelope (post-WS-Security) in trace payloads for debugging. Off by default. |

Existing vars (`HTTP_TOOL_MAX_RESPONSE_BYTES`, `HTTP_TOOL_MAX_REDIRECT_HOPS`, `HTTP_TOOL_KEEPALIVE_MS`, `HTTP_TOOL_MAX_SOCKETS`, `TOOL_DEFAULT_TIMEOUT_MS`, `TOOL_MAX_RESULT_SIZE`, `ALLOW_SSRF_PRIVATE_RANGES`) apply unchanged to SOAP tools.

### `_wsSecurityCredentials` Strip-List

The transient field is set in `patchToolWithResolvedAuth` and consumed by `HttpToolExecutor.buildRequest` within the same request lifecycle. Verified that no IR-serialization path touches the live request `tool` object:

- `serialize-tool-form-to-dsl.ts` operates on `HttpToolFormData`, not `HttpBindingIR` — the transient field doesn't exist there.
- `apps/studio/src/app/api/projects/[id]/tools/[toolId]/export/route.ts` operates on the DB record via `sanitizeProjectTool`, not on compiled IR.
- `loadProjectToolsAsIR.ts` reads `dslContent` from MongoDB and rebuilds IR via `buildHttpBindingFromProps` — it never sees a request-time tool object.
- `sourceHash` is computed from `dslContent` (a string blob), not from compiled IR.
- A2A bundle export and agent IR snapshots serialize the persisted `ToolDefinition`, not the live request-time tool.
- Audit middleware reads `auth.type` and `endpoint` only.

**Conclusion**: no explicit strip is needed because the transient field never enters any persistence or serialization path. The LLD reviewer should verify this claim during round 1 audit. If any newly-discovered serializer reaches the live `tool.http_binding` (e.g., a future feature adds in-flight tool serialization), this section must be updated.

---

## 6. Acceptance Criteria (Whole Feature)

- [ ] All 4 phases complete with their exit criteria met.
- [ ] All 13 FRs (FR-1..FR-13) have at least one ✅ in the test spec coverage matrix.
- [ ] All 7 top-level E2E scenarios + 3 sub-scenarios green (E2E-1..E2E-7, E2E-5b/c/d).
- [ ] All 7 integration scenarios green (INT-1..INT-7).
- [ ] All 12 security tests pass (SEC-1..SEC-12).
- [ ] No regressions in existing test suites: `pnpm build && pnpm test` clean across `compiler`, `shared`, `shared-kernel`, `core`, `runtime`, `studio`.
- [ ] Manual test plan M-1..M-6 walkthroughs complete with results documented.
- [ ] Feature spec updated to ALPHA, then BETA after E2E green.
- [ ] Testing guide coverage matrix updated with actual coverage status (NOT TESTED → ✅ PASSING).
- [ ] Package learnings appended to `packages/compiler/agents.md`, `packages/shared/agents.md`, `apps/runtime/agents.md`, `apps/studio/agents.md`.
- [ ] Promotion BETA → STABLE deferred to a follow-up after nightly real-third-party-SOAP soak (closes feature spec GAP-007).

---

## 7. Open Questions

1. **Jira ticket creation** — no ABLP ticket exists yet (proactive enterprise enablement). The user has indicated they want to handle this separately; the LLD references `[ABLP-XXX]` placeholders that will be filled in at commit time.
2. **`<wsse:Nonce>` redaction strategy** — D-10 redacts both Nonce and Timestamp in the `?debug=true` response. Implementation can either: (a) redact at the executor's debug-render mode, or (b) redact at the route layer post-render. Decision deferred to Phase 3 implementer; both produce the same observable behavior.
3. **Connector-tool SOAP backport** — out of v1 scope, flagged for the connectors team. No LLD action.
4. **Nightly real-third-party-SOAP CI** — closes GAP-007 and gates BETA → STABLE. Will be tracked as a follow-up effort once the feature reaches BETA. Likely target: a public calculator WSDL or a Salesforce SOAP API sandbox.
5. **Future: WSDL import** — explicitly out of v1 scope. If/when added in v2, it should land as a new sub-feature and reuse the envelope rendering + parser hardening from `soap-envelope.ts`.
6. **Systemic auth-credential propagation gap** (round-2 audit finding). `ApplyAuthResult` defines 7+ enterprise credential fields (`awsCredentials`, `azureCredentials`, `sshCredentials`, `digestCredentials`, `kerberosCredentials`, `samlCredentials`, `hawkCredentials`, `wsSecurityCredentials`); `ToolAuthResult` propagates only `headers` / `queryParams` / `tlsOptions` / `secrets`. SOAP support fixes `wsSecurityCredentials` only. A follow-up should generalize the propagation pattern (e.g., a discriminated `enterpriseCredentials` field on `ToolAuthResult`) so adding the next enterprise auth type to a tool consumer doesn't require yet another point fix. Tracked separately; out of v1 SOAP scope.
7. **Inline E2E mock-server pattern → `fixtures/` directory** — Phase 4's `apps/studio/src/__tests__/e2e/fixtures/soap-stub-server.ts` is the first E2E fixture file extracted into a separate module. The existing E2E (`tool-invocations-api.e2e.test.ts`) defines mock servers inline. This is an intentional improvement (separation of concerns; reusable across future SOAP tests) but a deviation from the inline pattern. Future E2E tests may adopt the fixture-directory pattern; the LLD documents this so reviewers don't flag it as inconsistent.

---

## 7b. Post-Implementation Notes (2026-04-28)

Three bug fixes and one infrastructure workaround were applied post-ALPHA:

1. **SOAPAction quoting (GAP-008)**: SOAP 1.1 SOAPAction header was sent as a bare URI (`http://tempuri.org/Add`) instead of the RFC-required quoted-string (`"http://tempuri.org/Add"`). Fixed in `soap-envelope.ts:renderSoapRequest()`. All existing test assertions updated; new tests U-4b and U-4c added for placeholder resolution in `soap_action`.

2. **XML declaration pre-wrap detection (GAP-009)**: `isPreWrapped` check in `soap-envelope.ts` failed when the user body started with `<?xml version="1.0"?>` before `<soap:Envelope>`. Added `bodyForDetection = trimmedBody.replace(/^<\?xml[^?]*\?>\s*/i, '')` before the prefix check. New unit test added.

3. **Full placeholder resolution for `soap_action`**: The executor applied only `resolvePlaceholders` (covers `{{input.X}}`, `{{secrets.X}}`, `{{env.X}}`), but not `resolveContextPlaceholders` (`{{_context.X}}`) or `resolveSessionPlaceholders` (`{{session.X}}`). Now all 5 namespaces are resolved — consistent with how regular headers are resolved. Added `safeUrlOrigin()` helper for improved timeout/network error messages.

4. **Turbopack workaround for tool-test route**: Turbopack's dev-server route resolver fails to match deep 6-segment paths. Added `TOOL_TEST_PATH_RE` regex in `apps/studio/src/proxy.ts` and a flat route handler at `apps/studio/src/app/api/tool-test/[projectId]/[toolId]/route.ts`.

5. **Studio tool-test-service improvements**: SOAPAction display now shows the quoted form (matching wire format). `resolveDisplayPlaceholders` handles `{{session.X}}` as `[session.key]`. Added `httpStatusText()` and `resolveDisplayStatus()` helpers for mapping error codes to HTTP display statuses.

---

## 8. References

- Feature spec: [`docs/features/sub-features/soap-tool-support.md`](../features/sub-features/soap-tool-support.md)
- HLD: [`docs/specs/soap-tool-support.hld.md`](../specs/soap-tool-support.hld.md)
- Test spec: [`docs/testing/sub-features/soap-tool-support.md`](../testing/sub-features/soap-tool-support.md)
- Parent feature: [`docs/features/tool-invocations.md`](../features/tool-invocations.md)
- Parent HLD: [`docs/specs/tool-invocations.hld.md`](../specs/tool-invocations.hld.md)
- Reference E2E: `apps/studio/src/__tests__/e2e/tool-invocations-api.e2e.test.ts`
- Reference unit (HTTP executor): `packages/compiler/src/__tests__/constructs/http-tool-executor.test.ts`
- Reference unit (WS-Sec helper): `packages/auth-enterprise/src/__tests__/ws-security-auth.test.ts`
- Pipeline: [`docs/sdlc/pipeline.md`](../sdlc/pipeline.md)
- Design quality gate: [`.claude/skills/design-quality-gate.md`](../../.claude/skills/design-quality-gate.md)
