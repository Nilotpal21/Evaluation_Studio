# SDLC Log: SOAP Tool Support — Post-Implementation Sync (2026-04-28)

**Feature**: soap-tool-support
**Phase**: POST-IMPL-SYNC
**Date**: 2026-04-28

---

## Changes in This Session

### Bug Fixes (packages/compiler)

1. **SOAPAction quoting (GAP-008 CLOSED)**: `soap-envelope.ts:renderSoapRequest()` now wraps the SOAPAction value in double quotes per the SOAP 1.1 RFC. Previously sent bare URI, causing 400 errors on .NET/Axis servers.

2. **XML declaration pre-wrap detection (GAP-009 CLOSED)**: Added `bodyForDetection = trimmedBody.replace(/^<\?xml[^?]*\?>\s*/i, '')` before the `isPreWrapped` check in `soap-envelope.ts`. Users who prepend `<?xml version="1.0"?>` to a full `<soap:Envelope>` body were getting double-wrapping.

3. **Full placeholder resolution for `soap_action`** in `http-tool-executor.ts`: Added `resolveContextPlaceholders` and `resolveSessionPlaceholders` calls after `resolvePlaceholders` for the `soap_action` field. All 5 namespaces (`input`, `secrets`, `env`, `_context`, `session`) now work consistently.

4. **Improved error messages**: Added `safeUrlOrigin()` helper in `http-tool-executor.ts` for better timeout/network error messages that include the endpoint origin.

### Infrastructure (apps/studio)

5. **Turbopack workaround**: Added `TOOL_TEST_PATH_RE` regex in `proxy.ts` and new flat route handler at `apps/studio/src/app/api/tool-test/[projectId]/[toolId]/route.ts` to work around Turbopack's failure to match deep 6-segment paths.

### Studio Service Improvements

6. **SOAPAction display (tool-test-service.ts)**: Display now shows the quoted form matching wire format.
7. **`{{session.X}}` display support**: `resolveDisplayPlaceholders` now renders `{{session.X}}` as `[session.key]`.
8. **HTTP status helpers**: Added `httpStatusText()` and `resolveDisplayStatus()` for mapping error codes to display statuses.

### Test Updates

- `http-tool-executor-soap.test.ts`: Fixed 3 assertions to expect quoted SOAPAction; added U-4b (`{{input.X}}` in soap_action), U-4c (`{{secrets.X}}` in soap_action), pre-wrap with XML declaration test.
- `tool-test-service.test.ts`: Updated SOAPAction display assertions to quoted form; added SOAP display header tests; added response status code propagation tests.

## Docs Updated

| Document                              | Changes                                                                                                                                                                 |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Feature spec (`soap-tool-support.md`) | §10 added new route files; §16 closed GAP-008/009, added GAP-010; §17 updated test coverage notes; Last Updated → 04-28                                                 |
| Test spec (`soap-tool-support.md`)    | FR-5a/5c rows updated with fix notes; U-4b/U-4c/XML decl test added to unit list; tool-test-service added to file mapping; status section updated; Last Updated → 04-28 |
| HLD (`soap-tool-support.hld.md`)      | Implementation notes added re: SOAPAction quoting, XML declaration strip, full placeholder resolution                                                                   |
| LLD (`impl-plan.md`)                  | §7b post-implementation notes added with all 5 changes                                                                                                                  |
| Testing index (`README.md`)           | Last Updated for soap-tool-support → 04-28; description updated                                                                                                         |
| `packages/compiler/agents.md`         | SOAP post-ALPHA learnings appended                                                                                                                                      |
| `apps/studio/agents.md`               | Turbopack workaround + tool-test-service learnings appended                                                                                                             |
