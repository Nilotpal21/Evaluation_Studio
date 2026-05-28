# Arch AI In-Project — 20 Tool Creation Scenario UI Contract Test Results

**Date**: 2026-05-14
**Mode**: CLI-driven Studio SSE + proposal approval contract
**Scenario Set**: tools
**Projects tested**: CarrierCare Round2 5-001619, ClaimFlow Round2 5-001619, JourneyBuilder Round2 5-001018, TenantLaunch Round2 5-001018, CareTriage Round2 5-000414
**Total**: 20 | **Passed**: 2 | **Failed**: 18 | **Errors**: 0
**Pass Rate**: 10.0%

## **Contract Findings**: Event/order failures 0 | Busy/streaming 0 | Pending proposal 0 | Approval failures 0

## Category Summary

| Category                        | Pass | Fail | Error | Rate |
| ------------------------------- | ---- | ---- | ----- | ---- |
| Tool Implied By Agent           | 0    | 5    | 0     | 0%   |
| Tool Suggested From Diagnosis   | 1    | 4    | 0     | 20%  |
| Tool Suggested From Read Agent  | 1    | 4    | 0     | 20%  |
| Direct Tool Creation Assistance | 0    | 5    | 0     | 0%   |

---

## UI/Backend Contract Summary

| Check                                              | Count |
| -------------------------------------------------- | ----- |
| Event ordering / turn completion / protocol issues | 0     |
| Busy or already-streaming errors                   | 0     |
| Pending proposal errors                            | 0     |
| Approval failures                                  | 0     |
| Tool-call limit risks                              | 0     |

---

## Full Results

| #   | Category                        | Description                              | Project              | Status | Duration | Events | Tool Calls | Turn End | Artifacts | Approval | Error                                             |
| --- | ------------------------------- | ---------------------------------------- | -------------------- | ------ | -------- | ------ | ---------- | -------- | --------- | -------- | ------------------------------------------------- |
| 1   | Tool Implied By Agent           | Agent creation implies warranty_lookup   | CarrierCare Round2 5 | FAIL   | 43.6s    | 21     | 7          | yes      | 0         | -        | pass criteria not met                             |
| 2   | Tool Suggested From Diagnosis   | Diagnose tools for CarrierCare Round2 5- | CarrierCare Round2 5 | PASS   | 19.1s    | 789    | 3          | yes      | 0         | -        | -                                                 |
| 3   | Tool Suggested From Read Agent  | Read BillingHistoryRetriever tool contex | CarrierCare Round2 5 | PASS   | 11.9s    | 454    | 3          | yes      | 0         | -        | -                                                 |
| 4   | Direct Tool Creation Assistance | Plan HTTP tool for DisputeResolutionSpec | CarrierCare Round2 5 | FAIL   | 21.7s    | 16     | 4          | yes      | 0         | -        | pass criteria not met                             |
| 5   | Tool Implied By Agent           | Agent creation implies shipment_eta_look | ClaimFlow Round2 5-0 | FAIL   | 2.8s     | 4      | 0          | yes      | 0         | -        | pass criteria not met; error codes: MODEL_BILLING |
| 6   | Tool Suggested From Diagnosis   | Diagnose tools for ClaimFlow Round2 5-00 | ClaimFlow Round2 5-0 | FAIL   | 2.8s     | 4      | 0          | yes      | 0         | -        | pass criteria not met; error codes: MODEL_BILLING |
| 7   | Tool Suggested From Read Agent  | Read ClaimIntakeAgent tool context       | ClaimFlow Round2 5-0 | FAIL   | 2.7s     | 4      | 0          | yes      | 0         | -        | pass criteria not met; error codes: MODEL_BILLING |
| 8   | Direct Tool Creation Assistance | Plan HTTP tool for ClaimServiceAgent     | ClaimFlow Round2 5-0 | FAIL   | 2.0s     | 4      | 0          | yes      | 0         | -        | pass criteria not met; error codes: MODEL_BILLING |
| 9   | Tool Implied By Agent           | Agent creation implies customer_status_l | JourneyBuilder Round | FAIL   | 2.6s     | 4      | 0          | yes      | 0         | -        | pass criteria not met; error codes: MODEL_BILLING |
| 10  | Tool Suggested From Diagnosis   | Diagnose tools for JourneyBuilder Round2 | JourneyBuilder Round | FAIL   | 2.5s     | 4      | 0          | yes      | 0         | -        | pass criteria not met; error codes: MODEL_BILLING |
| 11  | Tool Suggested From Read Agent  | Read BookingManager tool context         | JourneyBuilder Round | FAIL   | 2.7s     | 4      | 0          | yes      | 0         | -        | pass criteria not met; error codes: MODEL_BILLING |
| 12  | Direct Tool Creation Assistance | Plan HTTP tool for HumanTravelEscalation | JourneyBuilder Round | FAIL   | 2.6s     | 4      | 0          | yes      | 0         | -        | pass criteria not met; error codes: MODEL_BILLING |
| 13  | Tool Implied By Agent           | Agent creation implies appointment*slot* | TenantLaunch Round2  | FAIL   | 4.7s     | 4      | 0          | yes      | 0         | -        | pass criteria not met; error codes: MODEL_BILLING |
| 14  | Tool Suggested From Diagnosis   | Diagnose tools for TenantLaunch Round2 5 | TenantLaunch Round2  | FAIL   | 2.6s     | 4      | 0          | yes      | 0         | -        | pass criteria not met; error codes: MODEL_BILLING |
| 15  | Tool Suggested From Read Agent  | Read ActivationSpecialist tool context   | TenantLaunch Round2  | FAIL   | 2.1s     | 4      | 0          | yes      | 0         | -        | pass criteria not met; error codes: MODEL_BILLING |
| 16  | Direct Tool Creation Assistance | Plan HTTP tool for HumanEscalationSpecia | TenantLaunch Round2  | FAIL   | 2.6s     | 4      | 0          | yes      | 0         | -        | pass criteria not met; error codes: MODEL_BILLING |
| 17  | Tool Implied By Agent           | Agent creation implies policy_article_se | CareTriage Round2 5- | FAIL   | 3.7s     | 4      | 0          | yes      | 0         | -        | pass criteria not met; error codes: MODEL_BILLING |
| 18  | Tool Suggested From Diagnosis   | Diagnose tools for CareTriage Round2 5-0 | CareTriage Round2 5- | FAIL   | 2.9s     | 4      | 0          | yes      | 0         | -        | pass criteria not met; error codes: MODEL_BILLING |
| 19  | Tool Suggested From Read Agent  | Read AppointmentBooking tool context     | CareTriage Round2 5- | FAIL   | 2.9s     | 4      | 0          | yes      | 0         | -        | pass criteria not met; error codes: MODEL_BILLING |
| 20  | Direct Tool Creation Assistance | Plan HTTP tool for EmergencyEscalation   | CareTriage Round2 5- | FAIL   | 6.5s     | 19     | 5          | yes      | 0         | -        | pass criteria not met; error codes: MODEL_BILLING |

---

## Failures & Errors

- **[1] Tool Implied By Agent**: Agent creation implies warranty_lookup
  - Project: CarrierCare Round2 5-001619
  - Status: FAIL
  - Error: pass criteria not met

- **[4] Direct Tool Creation Assistance**: Plan HTTP tool for DisputeResolutionSpecialist
  - Project: CarrierCare Round2 5-001619
  - Status: FAIL
  - Error: pass criteria not met

- **[5] Tool Implied By Agent**: Agent creation implies shipment_eta_lookup
  - Project: ClaimFlow Round2 5-001619
  - Status: FAIL
  - Error: pass criteria not met; error codes: MODEL_BILLING
  - Error codes: MODEL_BILLING

- **[6] Tool Suggested From Diagnosis**: Diagnose tools for ClaimFlow Round2 5-001619
  - Project: ClaimFlow Round2 5-001619
  - Status: FAIL
  - Error: pass criteria not met; error codes: MODEL_BILLING
  - Error codes: MODEL_BILLING

- **[7] Tool Suggested From Read Agent**: Read ClaimIntakeAgent tool context
  - Project: ClaimFlow Round2 5-001619
  - Status: FAIL
  - Error: pass criteria not met; error codes: MODEL_BILLING
  - Error codes: MODEL_BILLING

- **[8] Direct Tool Creation Assistance**: Plan HTTP tool for ClaimServiceAgent
  - Project: ClaimFlow Round2 5-001619
  - Status: FAIL
  - Error: pass criteria not met; error codes: MODEL_BILLING
  - Error codes: MODEL_BILLING

- **[9] Tool Implied By Agent**: Agent creation implies customer_status_lookup
  - Project: JourneyBuilder Round2 5-001018
  - Status: FAIL
  - Error: pass criteria not met; error codes: MODEL_BILLING
  - Error codes: MODEL_BILLING

- **[10] Tool Suggested From Diagnosis**: Diagnose tools for JourneyBuilder Round2 5-001018
  - Project: JourneyBuilder Round2 5-001018
  - Status: FAIL
  - Error: pass criteria not met; error codes: MODEL_BILLING
  - Error codes: MODEL_BILLING

- **[11] Tool Suggested From Read Agent**: Read BookingManager tool context
  - Project: JourneyBuilder Round2 5-001018
  - Status: FAIL
  - Error: pass criteria not met; error codes: MODEL_BILLING
  - Error codes: MODEL_BILLING

- **[12] Direct Tool Creation Assistance**: Plan HTTP tool for HumanTravelEscalation
  - Project: JourneyBuilder Round2 5-001018
  - Status: FAIL
  - Error: pass criteria not met; error codes: MODEL_BILLING
  - Error codes: MODEL_BILLING

- **[13] Tool Implied By Agent**: Agent creation implies appointment_slot_lookup
  - Project: TenantLaunch Round2 5-001018
  - Status: FAIL
  - Error: pass criteria not met; error codes: MODEL_BILLING
  - Error codes: MODEL_BILLING

- **[14] Tool Suggested From Diagnosis**: Diagnose tools for TenantLaunch Round2 5-001018
  - Project: TenantLaunch Round2 5-001018
  - Status: FAIL
  - Error: pass criteria not met; error codes: MODEL_BILLING
  - Error codes: MODEL_BILLING

- **[15] Tool Suggested From Read Agent**: Read ActivationSpecialist tool context
  - Project: TenantLaunch Round2 5-001018
  - Status: FAIL
  - Error: pass criteria not met; error codes: MODEL_BILLING
  - Error codes: MODEL_BILLING

- **[16] Direct Tool Creation Assistance**: Plan HTTP tool for HumanEscalationSpecialist
  - Project: TenantLaunch Round2 5-001018
  - Status: FAIL
  - Error: pass criteria not met; error codes: MODEL_BILLING
  - Error codes: MODEL_BILLING

- **[17] Tool Implied By Agent**: Agent creation implies policy_article_search
  - Project: CareTriage Round2 5-000414
  - Status: FAIL
  - Error: pass criteria not met; error codes: MODEL_BILLING
  - Error codes: MODEL_BILLING

- **[18] Tool Suggested From Diagnosis**: Diagnose tools for CareTriage Round2 5-000414
  - Project: CareTriage Round2 5-000414
  - Status: FAIL
  - Error: pass criteria not met; error codes: MODEL_BILLING
  - Error codes: MODEL_BILLING

- **[19] Tool Suggested From Read Agent**: Read AppointmentBooking tool context
  - Project: CareTriage Round2 5-000414
  - Status: FAIL
  - Error: pass criteria not met; error codes: MODEL_BILLING
  - Error codes: MODEL_BILLING

- **[20] Direct Tool Creation Assistance**: Plan HTTP tool for EmergencyEscalation
  - Project: CareTriage Round2 5-000414
  - Status: FAIL
  - Error: pass criteria not met; error codes: MODEL_BILLING
  - Error codes: MODEL_BILLING
