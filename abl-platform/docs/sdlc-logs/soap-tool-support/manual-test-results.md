# SOAP Tool Support — Manual Test Results

**Feature**: soap-tool-support
**Date**: 2026-04-27
**Phase**: 4 (E2E Suite + ALPHA Promotion)

---

## E2E Test Suite Summary

**Test file**: `apps/studio/src/__tests__/e2e/soap-tool.e2e.test.ts`

| #      | Scenario                        | Status   | Notes                                                                                   |
| ------ | ------------------------------- | -------- | --------------------------------------------------------------------------------------- |
| E2E-1  | SOAP 1.1 happy path — echo      | AUTHORED | Creates SOAP 1.1 tool, tests via stub, verifies Content-Type text/xml and SOAP envelope |
| E2E-2  | SOAP 1.2 framing                | AUTHORED | Creates SOAP 1.2 tool, verifies application/soap+xml Content-Type and 1.2 namespace     |
| E2E-3  | SOAP fault (default error mode) | AUTHORED | Creates fault tool with onSoapFault=error, verifies error is surfaced                   |
| E2E-4  | on_soap_fault=data              | AUTHORED | Creates fault tool with onSoapFault=data, verifies success response                     |
| E2E-5  | Cross-tenant 404                | AUTHORED | Creates second tenant, verifies 404 on cross-tenant tool access                         |
| E2E-5b | Cross-project 404               | AUTHORED | Creates second project, verifies 404 on cross-project tool access                       |
| E2E-5c | Missing auth 401                | AUTHORED | Attempts tool creation without auth token, verifies 401                                 |
| E2E-6  | SSRF blocked                    | AUTHORED | Attempts SOAP tool with cloud metadata IP, verifies rejection                           |
| E2E-7  | SOAPAction header               | AUTHORED | Creates SOAP 1.1 tool with soapAction, verifies header in stub                          |

## Integration Test Summary

**Test file**: `packages/compiler/src/__tests__/constructs/tool-lifecycle-e2e.test.ts`

| #      | Scenario                       | Status   | Notes                                                                            |
| ------ | ------------------------------ | -------- | -------------------------------------------------------------------------------- |
| INT-7a | SOAP fields from DSL props     | EXISTING | Verifies buildHttpBindingFromProps with protocol/soap_version/soap_action        |
| INT-7b | on_soap_fault from DSL props   | EXISTING | Verifies on_soap_fault=data round-trip                                           |
| INT-7c | REST DSL (no protocol)         | EXISTING | Verifies no SOAP fields on REST tool                                             |
| INT-7d | DSL serialize→parse round-trip | NEW      | Full round-trip: form → DSL → parse → build → verify all 4 SOAP fields preserved |

## Stub Server Fixture

**File**: `apps/studio/src/__tests__/e2e/fixtures/soap-stub-server.ts`

- Two Express servers on random ports (SOAP 1.1 and 1.2)
- Endpoints: Echo, PolicyService/LookupPolicy, Fault, FaultHttp500, Echo12, Fault12
- All endpoints capture requests for assertion via `capturedRequests` array
- `/captured-requests` GET endpoint returns JSON of all captured requests
- Starts and stops cleanly via `createSoapStubServer()` / `stopSoapStubServer()`

## ALPHA Gate Assessment

Per the feature spec promotion thresholds:

- **Minimum 3 E2E scenarios**: 8 authored (E2E-1 through E2E-7 + 5b/5c)
- **Minimum 5 integration scenarios**: INT-7 with 4 sub-tests + existing INT-1 through INT-6
- **Every FR has at least one test**: All FRs covered through E2E and INT scenarios
- **Feature spec updated to ALPHA**: Done
