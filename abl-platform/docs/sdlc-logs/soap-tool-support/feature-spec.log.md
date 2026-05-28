# SDLC Log — Feature Spec — SOAP Tool Support

**Feature**: SOAP Tool Support (sub-feature of Tool Invocations)
**Slug**: `soap-tool-support`
**Phase**: Feature Spec
**Date**: 2026-04-27
**Author**: Claude Code (Opus 4.7) on behalf of `karthikeya.andhoju@kore.com`

---

## 1. Driver

- **Origin**: Proactive enterprise enablement (user-confirmed via clarification dialog).
- **Customer / Jira anchor**: None at the time of writing. Tracked as Open Question #5 in the feature spec.
- **Doc placement**: Sub-feature under [Tool Invocations](../../features/tool-invocations.md), per user selection.

---

## 2. Clarifying Questions — Product Oracle Output

The oracle was spawned with 15 questions across Scope, Requirements, and Architecture. Decisions were grounded in code reads (file paths cited inline in the spec).

### Scope & Problem

| #   | Classification                       | Decision                                                                                                                                                                                    |
| --- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1  | DECIDED                              | Use a `protocol: 'rest' \| 'soap'` discriminator on the existing `http` tool type — not a new top-level `toolType: 'soap'`. Reuses executor, wizard, DSL serializer, observability surface. |
| S2  | DECIDED                              | Support both SOAP 1.1 and 1.2 via a `soap_version` field. Cost is a header + namespace switch.                                                                                              |
| S3  | DECIDED                              | WSDL import is **out of scope** for v1. v1 = manual envelope authoring.                                                                                                                     |
| S4  | DECIDED                              | WS-\* extensions beyond UsernameToken / X.509 BinarySecurityToken are out of scope (no XML-DSig, XML-Enc, WS-Trust, WS-RM, WS-Policy, WS-AT).                                               |
| S5  | AMBIGUOUS → user-confirmed proactive | No customer / Jira ticket found; proactive enterprise enablement.                                                                                                                           |

### User Stories & Requirements

| #   | Classification | Decision                                                                                                                                                                                       |
| --- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | DECIDED        | Primary persona: agent builder authoring envelope manually. WSDL import is a future no-code persona.                                                                                           |
| R2  | INFERRED       | All transport-level auth types (`bearer`, `api_key`, `basic`, `oauth2`, `mtls`) compose with `ws_security` (which lives in the SOAP `<Header>`). No XML-DSig/XML-Enc.                          |
| R3  | DECIDED        | SOAP faults default to structured `ToolExecutionError`; opt-in to fault-as-data via per-tool `on_soap_fault: 'error' \| 'data'` flag. _(Refinement contributed by user during clarification.)_ |
| R4  | DECIDED        | Parse SOAP responses to JSON via hardened `fast-xml-parser`; strip envelope and Body.                                                                                                          |
| R5  | INFERRED       | Tool result compaction works on parsed JSON; existing `HTTP_TOOL_MAX_RESPONSE_BYTES` cap protects ingress.                                                                                     |

### Technical & Architecture

| #   | Classification | Decision                                                                                                                                                                                                          |
| --- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T1  | ANSWERED       | Affected packages: `packages/compiler`, `packages/shared`, `packages/shared-kernel`, `apps/studio`. Read-only consumers: `packages/auth-enterprise` (for `applyWsSecurity`), `apps/runtime`, `packages/database`. |
| T2  | INFERRED       | No DB migration. `dslContent` is the source of truth. Defaults: `protocol = 'rest'`, `on_soap_fault = 'error'`. Existing tools' behavior is byte-for-byte unchanged.                                              |
| T3  | DECIDED        | XXE / billion-laughs / DTD attacks defended via hardened `fast-xml-parser` config: `processEntities: false`, `allowBooleanAttributes: false`, no DTD. SSRF protection inherits from REST.                         |
| T4  | DECIDED        | WS-Security injection lives in the executor (consumes `wsSecurityCredentials` from the auth-profile middleware result and assembles into `<soap:Header>`). Middleware stays protocol-agnostic.                    |
| T5  | DECIDED        | Studio test endpoint wraps envelope server-side so the test fidelity matches runtime behavior. Test response includes the rendered envelope for the request preview.                                              |

---

## 3. User-Confirmed Refinements

After reviewing the oracle's DECIDED items, the user confirmed:

1. Accept all 8 oracle defaults (protocol discriminator, both SOAP versions, no WSDL v1, only UsernameToken/X.509 WS-Sec, faults as structured errors, XML→JSON parse, executor-side WS-Sec injection, server-side test envelope wrapping).
2. **Add a per-tool `on_soap_fault: 'error' | 'data'` IR flag** so legacy SOAP services that use faults as a business-outcome channel can opt in to fault-as-data semantics without compromising the safe default for everyone else.

---

## 4. Files Created

| File                                                   | Purpose                                                                       |
| ------------------------------------------------------ | ----------------------------------------------------------------------------- |
| `docs/features/sub-features/soap-tool-support.md`      | Feature spec, status PLANNED.                                                 |
| `docs/testing/sub-features/soap-tool-support.md`       | Testing guide placeholder with 7 E2E + 7 integration scenarios + manual plan. |
| `docs/sdlc-logs/soap-tool-support/feature-spec.log.md` | This log.                                                                     |

## 5. Files Updated

| File                                   | Change                                                       |
| -------------------------------------- | ------------------------------------------------------------ |
| `docs/features/sub-features/README.md` | Added "SOAP Tool Support" row to focused sub-features table. |
| `docs/testing/sub-features/README.md`  | Added "SOAP Tool Support" row to testing sub-features table. |

---

## 6. Open Questions (carry forward to /test-spec and /hld)

1. Should `{{input.X}}` placeholders inside SOAP body templates be XML-escaped automatically, or via a `{{xml(input.X)}}` helper?
2. One-way SOAP operations: return `null`, `{}`, or `{ oneWay: true }`?
3. Should an opt-in `rawXmlResponse: true` flag exist for niche cases that need both parsed JSON and raw XML?
4. Should the test endpoint always return the rendered SOAP envelope, or only with `?debug=true`?
5. Is there a customer/Jira ticket to anchor priority? (No — proactive.)
6. Backport SOAP support to connector-bound tool path in a follow-up?

These items are suitable for resolution during HLD.

---

## 7. Quality Gate Notes

- All 18 spec sections were addressed.
- 7 user stories (≥3 required).
- 12 functional requirements (≥4 required).
- Integration matrix lists 6 related features (≥2 required).
- Project / tenant / user isolation covered explicitly in §12.
- Delivery plan has 6 parent tasks with numbered subtasks.
- 6 open questions logged.
- Testing guide covers 7 E2E + 7 integration scenarios + 5 manual + production wiring verification.
- All claims grounded in cited file:line evidence.

---

## 8. Phase-Auditor Rounds

### Round 1 — NEEDS_REVISION

- **CRITICAL [FS-2]**: Non-goal claimed `auth-profile-tool-middleware.ts` needed no changes, but `wsSecurityCredentials` is dropped at the `ToolAuthResult` boundary (`resolve-tool-auth.ts:93-106`). Resolved by adding **FR-13** mandating the propagation extension and updating §10 + §13.
- **HIGH [XP-5]**: `packages/compiler/agents.md` (2026-03-24) lockstep learning for new DSL tool properties — three sites must be updated. Resolved by adding `compiler.ts:compileHttpBinding`, `dsl-property-parser.ts`, and `agent-based-parser.ts` (denylist) to §10 + §13 subtask 1.5.
- **HIGH [FS-2]**: Header `Package(s)` omitted `packages/core` and `apps/runtime`. Resolved.
- **MEDIUM [FS-9]**: §17 row 10 conflated existing-pass with new-regression-needed. Resolved by splitting into 10a + 10b.
- **MEDIUM [FS-3]**: FR-5 was a dense paragraph. Resolved by splitting into FR-5a..FR-5d.

### Round 2 — APPROVED

Round-1 fixes verified. Two HIGH polish items addressed inline:

- Clarified that the merge-block at `compiler.ts:135` does NOT need changes (SOAP fields live inside `http_binding` and are preserved by the resolved-tool spread).
- Explicitly listed snake_case DSL names (`'protocol'`, `'soap_version'`, `'soap_action'`, `'on_soap_fault'`) for the `TOOL_IMPLEMENTATION_PROPERTIES` denylist update.

### Round-2 MEDIUM findings (carried forward, non-blocking)

- `fast-xml-parser` version was claimed as "v5"; pin / verify exact version in HLD.
- No Jira ticket exists yet (Open Question #5). Create one before HLD/LLD.

---

## 9. Next Phase

Run `/test-spec soap-tool-support` to expand the testing guide into a full test specification with detailed assertions, fixtures, and coverage tracking.

After test-spec audit completes, run `/hld soap-tool-support`.
