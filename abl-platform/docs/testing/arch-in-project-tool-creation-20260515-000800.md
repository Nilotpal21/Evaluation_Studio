# Arch AI In-Project — 20 Tool Creation Scenario UI Contract Test Results

**Date**: 2026-05-14
**Mode**: CLI-driven Studio SSE + proposal approval contract
**Scenario Set**: tools
**Projects tested**: CareTriage Round2 5-000414, CarrierCare Round2 5-000414, ClaimFlow Round2 5-000414, CarrierCare Round2 4-235241, ClaimFlow Round2 4-235241
**Total**: 20 | **Passed**: 19 | **Failed**: 1 | **Errors**: 0
**Pass Rate**: 95.0%

## **Contract Findings**: Event/order failures 1 | Busy/streaming 0 | Pending proposal 0 | Approval failures 0

## Category Summary

| Category                        | Pass | Fail | Error | Rate |
| ------------------------------- | ---- | ---- | ----- | ---- |
| Tool Implied By Agent           | 5    | 0    | 0     | 100% |
| Tool Suggested From Diagnosis   | 5    | 0    | 0     | 100% |
| Tool Suggested From Read Agent  | 5    | 0    | 0     | 100% |
| Direct Tool Creation Assistance | 4    | 1    | 0     | 80%  |

---

## UI/Backend Contract Summary

| Check                                              | Count |
| -------------------------------------------------- | ----- |
| Event ordering / turn completion / protocol issues | 1     |
| Busy or already-streaming errors                   | 0     |
| Pending proposal errors                            | 0     |
| Approval failures                                  | 0     |
| Tool-call limit risks                              | 0     |

---

## Full Results

| #   | Category                        | Description                              | Project              | Status | Duration | Events | Tool Calls | Turn End | Artifacts | Approval | Error                                                        |
| --- | ------------------------------- | ---------------------------------------- | -------------------- | ------ | -------- | ------ | ---------- | -------- | --------- | -------- | ------------------------------------------------------------ |
| 1   | Tool Implied By Agent           | Agent creation implies warranty_lookup   | CareTriage Round2 5- | PASS   | 47.2s    | 22     | 7          | yes      | 1         | -        | -                                                            |
| 2   | Tool Suggested From Diagnosis   | Diagnose tools for CareTriage Round2 5-0 | CareTriage Round2 5- | PASS   | 19.5s    | 796    | 3          | yes      | 0         | -        | -                                                            |
| 3   | Tool Suggested From Read Agent  | Read AppointmentBooking tool context     | CareTriage Round2 5- | PASS   | 10.6s    | 526    | 3          | yes      | 0         | -        | -                                                            |
| 4   | Direct Tool Creation Assistance | Plan HTTP tool for EmergencyEscalation   | CareTriage Round2 5- | PASS   | 39.1s    | 25     | 7          | yes      | 1         | -        | -                                                            |
| 5   | Tool Implied By Agent           | Agent creation implies shipment_eta_look | CarrierCare Round2 5 | PASS   | 43.8s    | 28     | 9          | yes      | 1         | -        | -                                                            |
| 6   | Tool Suggested From Diagnosis   | Diagnose tools for CarrierCare Round2 5- | CarrierCare Round2 5 | PASS   | 16.8s    | 805    | 3          | yes      | 0         | -        | -                                                            |
| 7   | Tool Suggested From Read Agent  | Read AuthenticateAndIntake tool context  | CarrierCare Round2 5 | PASS   | 13.2s    | 563    | 3          | yes      | 0         | -        | -                                                            |
| 8   | Direct Tool Creation Assistance | Plan HTTP tool for CallRouter            | CarrierCare Round2 5 | PASS   | 34.9s    | 31     | 9          | yes      | 1         | -        | -                                                            |
| 9   | Tool Implied By Agent           | Agent creation implies customer_status_l | ClaimFlow Round2 5-0 | PASS   | 43.5s    | 22     | 7          | yes      | 1         | -        | -                                                            |
| 10  | Tool Suggested From Diagnosis   | Diagnose tools for ClaimFlow Round2 5-00 | ClaimFlow Round2 5-0 | PASS   | 15.9s    | 781    | 4          | yes      | 0         | -        | -                                                            |
| 11  | Tool Suggested From Read Agent  | Read AdjusterRoutingAgent tool context   | ClaimFlow Round2 5-0 | PASS   | 13.5s    | 499    | 3          | yes      | 0         | -        | -                                                            |
| 12  | Direct Tool Creation Assistance | Plan HTTP tool for ClaimFilingAgent      | ClaimFlow Round2 5-0 | PASS   | 49.2s    | 27     | 8          | yes      | 1         | -        | -                                                            |
| 13  | Tool Implied By Agent           | Agent creation implies appointment*slot* | CarrierCare Round2 4 | PASS   | 37.0s    | 22     | 7          | yes      | 1         | -        | -                                                            |
| 14  | Tool Suggested From Diagnosis   | Diagnose tools for CarrierCare Round2 4- | CarrierCare Round2 4 | PASS   | 16.6s    | 710    | 3          | yes      | 0         | -        | -                                                            |
| 15  | Tool Suggested From Read Agent  | Read CarrierCareRouter tool context      | CarrierCare Round2 4 | PASS   | 11.0s    | 517    | 3          | yes      | 0         | -        | -                                                            |
| 16  | Direct Tool Creation Assistance | Plan HTTP tool for DisputeResolutionSpec | CarrierCare Round2 4 | PASS   | 24.2s    | 25     | 7          | yes      | 1         | -        | -                                                            |
| 17  | Tool Implied By Agent           | Agent creation implies policy_article_se | ClaimFlow Round2 4-2 | PASS   | 39.7s    | 25     | 8          | yes      | 1         | -        | -                                                            |
| 18  | Tool Suggested From Diagnosis   | Diagnose tools for ClaimFlow Round2 4-23 | ClaimFlow Round2 4-2 | PASS   | 21.4s    | 759    | 3          | yes      | 0         | -        | -                                                            |
| 19  | Tool Suggested From Read Agent  | Read AdjusterAssignmentAgent tool contex | ClaimFlow Round2 4-2 | PASS   | 11.5s    | 492    | 3          | yes      | 0         | -        | -                                                            |
| 20  | Direct Tool Creation Assistance | Plan HTTP tool for ClaimIntakeAgent      | ClaimFlow Round2 4-2 | FAIL   | 21.4s    | 19     | 5          | yes      | 0         | -        | pass criteria not met; blocking error event: MODEL_TOOL_PROT |

---

## Failures & Errors

- **[20] Direct Tool Creation Assistance**: Plan HTTP tool for ClaimIntakeAgent
  - Project: ClaimFlow Round2 4-235241
  - Status: FAIL
  - Error: pass criteria not met; blocking error event: MODEL_TOOL_PROTOCOL_ERROR; error codes: MODEL_TOOL_PROTOCOL_ERROR
  - Event contract: blocking error event: MODEL_TOOL_PROTOCOL_ERROR
  - Error codes: MODEL_TOOL_PROTOCOL_ERROR
