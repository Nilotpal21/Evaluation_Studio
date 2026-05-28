# Arch AI In-Project — 50 Scenario UI Contract Test Results

**Date**: 2026-05-14
**Mode**: CLI-driven Studio SSE + proposal approval contract
**Projects tested**: AppointmentHub, OrderHelp, DispatchOps Round2 isorflow, DispatchOps Round2 -topthen, DispatchOps Round2 nsuccess
**Total**: 50 | **Passed**: 8 | **Failed**: 42 | **Errors**: 0
**Pass Rate**: 16.0%

**Contract Findings**: Event/order failures 42 | Busy/streaming 20 | Pending proposal 0 | Approval failures 20

## Key Observations

- The plan is directionally right, but the current IN_PROJECT review/apply experience is not ready to be considered reliable. Only 8 of 50 CLI scenarios passed the stricter UI/backend contract.
- The largest protocol issue is non-monotonic event sequencing. Artifact updates can arrive after hundreds of text deltas with `seq` reset to `1` while using the same `turnId`; the UI dispatcher dedupes by `(turnId, seq)`, so those artifact updates are at risk of being dropped.
- Proposal approvals are still race-prone. 20 approval attempts returned `409 SESSION_BUSY` with `A response is already streaming for this session. Please wait.` even though the initial proposal stream had closed at the HTTP level.
- Topology and health-check flows were consistently weak under user-facing review expectations: 0 of 3 topology reads and 0 of 3 health checks passed.
- No scenario crossed the added tool-call pressure threshold. The failures are event lifecycle, artifact/review state, and approval readiness issues, not raw tool-call-limit breaches.
- PM2 Studio logs during the run show repeated `arch_ai.session_busy` entries immediately after proposal turns, repeated `temperature is not supported for reasoning models` warnings for `gpt-5.4`, and runtime audit warnings for unsupported `arch_payload` audit stream messages.

---

## Category Summary

| Category           | Pass | Fail | Error | Rate |
| ------------------ | ---- | ---- | ----- | ---- |
| Read Agent         | 7    | 4    | 0     | 64%  |
| Read Topology      | 0    | 3    | 0     | 0%   |
| Health Check       | 0    | 3    | 0     | 0%   |
| Modify PERSONA     | 0    | 6    | 0     | 0%   |
| Modify LIMITATIONS | 0    | 6    | 0     | 0%   |
| Modify GOAL        | 0    | 5    | 0     | 0%   |
| Add Agent          | 0    | 4    | 0     | 0%   |
| Modify CONSTRAINTS | 0    | 4    | 0     | 0%   |
| Topology Verify    | 0    | 4    | 0     | 0%   |
| Mixed              | 1    | 3    | 0     | 25%  |

---

## UI/Backend Contract Summary

| Check                                              | Count |
| -------------------------------------------------- | ----- |
| Event ordering / turn completion / protocol issues | 42    |
| Busy or already-streaming errors                   | 20    |
| Pending proposal errors                            | 0     |
| Approval failures                                  | 20    |
| Tool-call limit risks                              | 0     |

---

## Full Results

| #   | Category           | Description                              | Project              | Status | Duration | Events | Tool Calls | Turn End | Artifacts | Approval | Error                                                        |
| --- | ------------------ | ---------------------------------------- | -------------------- | ------ | -------- | ------ | ---------- | -------- | --------- | -------- | ------------------------------------------------------------ |
| 1   | Read Agent         | Read AvailabilityBookingSpecialist       | AppointmentHub       | FAIL   | 21.1s    | 536    | 2          | yes      | 0         | -        | non-monotonic seq for turn_019e26a8-511e-7cc9-a9cc-96ee1f1cb |
| 2   | Read Agent         | Read BookingChangeSpecialist             | AppointmentHub       | FAIL   | 12.0s    | 640    | 2          | yes      | 0         | -        | non-monotonic seq for turn_019e26a8-8946-7ce1-90a7-e897edf33 |
| 3   | Read Agent         | Read HumanEscalationSpecialist           | AppointmentHub       | FAIL   | 10.3s    | 562    | 2          | yes      | 0         | -        | non-monotonic seq for turn_019e26a8-b807-7d1d-80ef-a7ddc7bf2 |
| 4   | Read Agent         | Read SchedulingFaqSpecialist             | AppointmentHub       | FAIL   | 16.5s    | 588    | 2          | yes      | 0         | -        | non-monotonic seq for turn_019e26a8-e077-7eb8-8226-f9873981a |
| 5   | Read Topology      | Topology of AppointmentHub               | AppointmentHub       | FAIL   | 9.4s     | 380    | 1          | yes      | 0         | -        | non-monotonic seq for turn_019e26a9-20e2-73db-b911-6246b4ad1 |
| 6   | Health Check       | Health of AppointmentHub                 | AppointmentHub       | FAIL   | 13.7s    | 716    | 2          | yes      | 0         | -        | non-monotonic seq for turn_019e26a9-45b0-7ad6-b5e1-929e4cde2 |
| 7   | Modify PERSONA     | AvailabilityBookingSpecialist persona →  | AppointmentHub       | FAIL   | 20.9s    | 14     | 3          | no       | 1         | ERROR    | non-monotonic seq for turn_019e26a9-7b12-7d65-85c2-1b6ffb395 |
| 8   | Modify PERSONA     | BookingChangeSpecialist persona → warm   | AppointmentHub       | FAIL   | 15.8s    | 14     | 3          | no       | 1         | ERROR    | non-monotonic seq for turn_019e26a9-ccce-7ffc-b8b0-98f4e6260 |
| 9   | Modify LIMITATIONS | Add limitation to BookingChangeSpecialis | AppointmentHub       | FAIL   | 21.0s    | 16     | 4          | no       | 1         | ERROR    | non-monotonic seq for turn_019e26aa-0a93-7400-bdf7-2c0e4583f |
| 10  | Modify LIMITATIONS | Add limitation to HumanEscalationSpecial | AppointmentHub       | FAIL   | 17.2s    | 14     | 3          | no       | 1         | ERROR    | non-monotonic seq for turn_019e26aa-5c6e-7d31-89ae-8975398d8 |
| 11  | Modify GOAL        | Update goal of AvailabilityBookingSpecia | AppointmentHub       | FAIL   | 18.5s    | 14     | 3          | no       | 1         | ERROR    | non-monotonic seq for turn_019e26aa-9f82-7305-979c-7ab4b56b7 |
| 12  | Modify GOAL        | Update goal of BookingChangeSpecialist   | AppointmentHub       | FAIL   | 17.3s    | 14     | 3          | no       | 1         | ERROR    | non-monotonic seq for turn_019e26aa-e7d4-7457-a069-8d9f20658 |
| 13  | Add Agent          | Add FeedbackCollector to AppointmentHub  | AppointmentHub       | FAIL   | 26.0s    | 21     | 7          | no       | 1         | -        | non-monotonic seq for turn_019e26ab-2baa-7951-b724-7944c6321 |
| 14  | Add Agent          | Add ComplianceMonitor to AppointmentHub  | AppointmentHub       | FAIL   | 35.2s    | 182    | 8          | yes      | 1         | -        | non-monotonic seq for turn_019e26ab-914f-7d47-9dc3-6175051bd |
| 15  | Modify CONSTRAINTS | Add constraint to AvailabilityBookingSpe | AppointmentHub       | FAIL   | 20.8s    | 20     | 6          | no       | 1         | ERROR    | non-monotonic seq for turn_019e26ac-1af1-7de7-8604-9a2a1cd68 |
| 16  | Modify CONSTRAINTS | Add constraint to BookingChangeSpecialis | AppointmentHub       | FAIL   | 21.4s    | 18     | 5          | no       | 1         | ERROR    | non-monotonic seq for turn_019e26ac-6c70-79a1-92e6-1eada2053 |
| 17  | Topology Verify    | Verify topology #1 of AppointmentHub     | AppointmentHub       | FAIL   | 7.5s     | 325    | 1          | yes      | 0         | -        | non-monotonic seq for turn_019e26ac-c051-74c1-a104-fef63bd81 |
| 18  | Topology Verify    | Verify topology #2 of AppointmentHub     | AppointmentHub       | FAIL   | 8.3s     | 260    | 6          | yes      | 0         | -        | non-monotonic seq for turn_019e26ac-ddb6-7b3f-8e87-990159d3b |
| 19  | Mixed              | What agents does this project have and w | AppointmentHub       | FAIL   | 7.2s     | 201    | 1          | yes      | 0         | -        | non-monotonic seq for turn_019e26ac-fe2d-7ace-afd8-c254bff95 |
| 20  | Mixed              | Are there any issues with the current ag | AppointmentHub       | FAIL   | 8.9s     | 381    | 1          | yes      | 0         | -        | non-monotonic seq for turn_019e26ad-1a6f-75b3-8723-462746f3c |
| 21  | Read Agent         | Read HumanEscalationSpecialist           | OrderHelp            | PASS   | 8.9s     | 338    | 1          | yes      | 0         | -        | -                                                            |
| 22  | Read Agent         | Read OrderStatusSpecialist               | OrderHelp            | PASS   | 8.4s     | 380    | 1          | yes      | 0         | -        | -                                                            |
| 23  | Read Agent         | Read ProductAccountFAQSpecialist         | OrderHelp            | PASS   | 8.3s     | 368    | 1          | yes      | 0         | -        | -                                                            |
| 24  | Read Agent         | Read ReturnsRefundsSpecialist            | OrderHelp            | PASS   | 10.0s    | 445    | 1          | yes      | 0         | -        | -                                                            |
| 25  | Read Topology      | Topology of OrderHelp                    | OrderHelp            | FAIL   | 11.0s    | 432    | 1          | yes      | 0         | -        | non-monotonic seq for turn_019e26ad-c7e3-7c45-88e0-c6b7fa6e2 |
| 26  | Health Check       | Health of OrderHelp                      | OrderHelp            | FAIL   | 30.2s    | 415    | 1          | yes      | 0         | -        | non-monotonic seq for turn_019e26ad-f2b0-7dd5-9aaa-e11459a96 |
| 27  | Modify PERSONA     | HumanEscalationSpecialist persona → form | OrderHelp            | FAIL   | 19.8s    | 14     | 3          | no       | 1         | ERROR    | non-monotonic seq for turn_019e26ae-68df-7166-a559-fe4858904 |
| 28  | Modify PERSONA     | OrderStatusSpecialist persona → casual   | OrderHelp            | FAIL   | 21.9s    | 14     | 3          | no       | 1         | ERROR    | non-monotonic seq for turn_019e26ae-b5df-7d96-845c-eb32aaf29 |
| 29  | Modify LIMITATIONS | Add limitation to OrderStatusSpecialist  | OrderHelp            | FAIL   | 38.1s    | 18     | 5          | no       | 1         | ERROR    | non-monotonic seq for turn_019e26af-0b87-7c25-8f51-b64bb6415 |
| 30  | Modify LIMITATIONS | Add limitation to ProductAccountFAQSpeci | OrderHelp            | FAIL   | 6.4s     | 101    | 2          | yes      | 0         | SKIP     | non-monotonic seq for turn_019e26af-a051-7952-b2ad-24d6dd5a8 |
| 31  | Modify GOAL        | Update goal of HumanEscalationSpecialist | OrderHelp            | FAIL   | 17.6s    | 14     | 3          | no       | 1         | ERROR    | non-monotonic seq for turn_019e26af-b94a-7269-8363-e96b247ab |
| 32  | Modify GOAL        | Update goal of OrderStatusSpecialist     | OrderHelp            | FAIL   | 17.8s    | 14     | 3          | no       | 1         | ERROR    | non-monotonic seq for turn_019e26af-fdf9-7ee9-9cf0-65dfaa9b3 |
| 33  | Add Agent          | Add KnowledgeHelper to OrderHelp         | OrderHelp            | FAIL   | 41.1s    | 29     | 10         | yes      | 1         | -        | non-monotonic seq for turn_019e26b0-438c-774e-9751-022aa1f80 |
| 34  | Add Agent          | Add EscalationHandler to OrderHelp       | OrderHelp            | FAIL   | 35.9s    | 223    | 8          | yes      | 1         | -        | non-monotonic seq for turn_019e26b0-e421-79d7-af27-a084df731 |
| 35  | Modify CONSTRAINTS | Add constraint to HumanEscalationSpecial | OrderHelp            | FAIL   | 22.5s    | 16     | 4          | no       | 1         | ERROR    | non-monotonic seq for turn_019e26b1-7066-7308-86ab-4e5868a98 |
| 36  | Modify CONSTRAINTS | Add constraint to OrderStatusSpecialist  | OrderHelp            | FAIL   | 26.3s    | 18     | 5          | no       | 1         | ERROR    | non-monotonic seq for turn_019e26b1-c812-706f-8d7e-050b436cd |
| 37  | Topology Verify    | Verify topology #1 of OrderHelp          | OrderHelp            | FAIL   | 13.4s    | 376    | 1          | yes      | 0         | -        | non-monotonic seq for turn_019e26b2-2ef4-7033-ab5e-c7246971f |
| 38  | Topology Verify    | Verify topology #2 of OrderHelp          | OrderHelp            | FAIL   | 6.3s     | 231    | 1          | yes      | 0         | -        | non-monotonic seq for turn_019e26b2-633d-78c5-9a39-31a42cf7c |
| 39  | Mixed              | Suggest improvements for the supervisor  | OrderHelp            | FAIL   | 24.5s    | 1045   | 3          | yes      | 0         | -        | non-monotonic seq for turn_019e26b2-7bdc-7f3d-b7c3-3f8c0fa64 |
| 40  | Mixed              | Which agent handles the most critical us | OrderHelp            | PASS   | 5.8s     | 285    | 0          | yes      | 0         | -        | -                                                            |
| 41  | Read Agent         | Read DispatchOpsRound2IsorflowIntakeAgen | DispatchOps Round2 i | PASS   | 9.8s     | 438    | 1          | yes      | 0         | -        | -                                                            |
| 42  | Read Agent         | Read DispatchOpsRound2IsorflowProcessorA | DispatchOps Round2 i | PASS   | 11.5s    | 462    | 1          | yes      | 0         | -        | -                                                            |
| 43  | Read Agent         | Read DispatchOpsRound2IsorflowReviewerAg | DispatchOps Round2 i | PASS   | 9.7s     | 479    | 1          | yes      | 0         | -        | -                                                            |
| 44  | Read Topology      | Topology of DispatchOps Round2 isorflow  | DispatchOps Round2 i | FAIL   | 8.6s     | 364    | 1          | yes      | 0         | -        | non-monotonic seq for turn_019e26b3-6b62-7244-be5b-ebde70fa8 |
| 45  | Health Check       | Health of DispatchOps Round2 isorflow    | DispatchOps Round2 i | FAIL   | 11.9s    | 466    | 2          | yes      | 0         | -        | non-monotonic seq for turn_019e26b3-8cf4-791e-9260-7f6215bb6 |
| 46  | Modify PERSONA     | DispatchOpsRound2IsorflowIntakeAgent per | DispatchOps Round2 i | FAIL   | 29.6s    | 20     | 5          | no       | 1         | ERROR    | non-monotonic seq for turn_019e26b3-bb50-7a58-a921-a0acdb97a |
| 47  | Modify PERSONA     | DispatchOpsRound2IsorflowProcessorAgent  | DispatchOps Round2 i | FAIL   | 16.1s    | 17     | 4          | no       | 1         | ERROR    | non-monotonic seq for turn_019e26b4-2f48-7026-84e7-65d67f8f6 |
| 48  | Modify LIMITATIONS | Add limitation to DispatchOpsRound2Isorf | DispatchOps Round2 i | FAIL   | 14.9s    | 14     | 3          | no       | 1         | ERROR    | non-monotonic seq for turn_019e26b4-6da5-783d-98e6-071a197f0 |
| 49  | Modify LIMITATIONS | Add limitation to DispatchOpsRound2Isorf | DispatchOps Round2 i | FAIL   | 22.1s    | 20     | 5          | no       | 1         | ERROR    | non-monotonic seq for turn_019e26b4-a7fa-76eb-aee1-a33a89dd2 |
| 50  | Modify GOAL        | Update goal of DispatchOpsRound2Isorflow | DispatchOps Round2 i | FAIL   | 11.9s    | 14     | 3          | no       | 1         | ERROR    | non-monotonic seq for turn_019e26b4-fe56-7891-8235-9a3a518c0 |

---

## Failures & Errors

- **[1] Read Agent**: Read AvailabilityBookingSpecialist
  - Project: AppointmentHub
  - Status: FAIL
  - Error: non-monotonic seq for turn_019e26a8-511e-7cc9-a9cc-96ee1f1cbacc: 2 after 529
  - Event contract: non-monotonic seq for turn_019e26a8-511e-7cc9-a9cc-96ee1f1cbacc: 2 after 529

- **[2] Read Agent**: Read BookingChangeSpecialist
  - Project: AppointmentHub
  - Status: FAIL
  - Error: non-monotonic seq for turn_019e26a8-8946-7ce1-90a7-e897edf33a13: 2 after 633
  - Event contract: non-monotonic seq for turn_019e26a8-8946-7ce1-90a7-e897edf33a13: 2 after 633

- **[3] Read Agent**: Read HumanEscalationSpecialist
  - Project: AppointmentHub
  - Status: FAIL
  - Error: non-monotonic seq for turn_019e26a8-b807-7d1d-80ef-a7ddc7bf28da: 2 after 555
  - Event contract: non-monotonic seq for turn_019e26a8-b807-7d1d-80ef-a7ddc7bf28da: 2 after 555

- **[4] Read Agent**: Read SchedulingFaqSpecialist
  - Project: AppointmentHub
  - Status: FAIL
  - Error: non-monotonic seq for turn_019e26a8-e077-7eb8-8226-f9873981a19c: 2 after 581
  - Event contract: non-monotonic seq for turn_019e26a8-e077-7eb8-8226-f9873981a19c: 2 after 581

- **[5] Read Topology**: Topology of AppointmentHub
  - Project: AppointmentHub
  - Status: FAIL
  - Error: non-monotonic seq for turn_019e26a9-20e2-73db-b911-6246b4ad17a7: 1 after 375
  - Event contract: non-monotonic seq for turn_019e26a9-20e2-73db-b911-6246b4ad17a7: 1 after 375

- **[6] Health Check**: Health of AppointmentHub
  - Project: AppointmentHub
  - Status: FAIL
  - Error: non-monotonic seq for turn_019e26a9-45b0-7ad6-b5e1-929e4cde22b4: 1 after 709
  - Event contract: non-monotonic seq for turn_019e26a9-45b0-7ad6-b5e1-929e4cde22b4: 1 after 709

- **[7] Modify PERSONA**: AvailabilityBookingSpecialist persona → professional
  - Project: AppointmentHub
  - Status: FAIL
  - Error: non-monotonic seq for turn_019e26a9-7b12-7d65-85c2-1b6ffb395c5b: 2 after 3; assistant turn did not emit turn_ended/done; approval error: Proposal accept failed (409): {"success":false,"errors":[{"msg":"A response is already streaming for this session. Please wait.","code":"SESSION_BUSY"}]}
  - Event contract: non-monotonic seq for turn_019e26a9-7b12-7d65-85c2-1b6ffb395c5b: 2 after 3; assistant turn did not emit turn_ended/done; approval error: Proposal accept failed (409): {"success":false,"errors":[{"msg":"A response is already streaming for this session. Please wait.","code":"SESSION_BUSY"}]}
  - Approval: ERROR — Proposal accept failed (409): {"success":false,"errors":[{"msg":"A response is already streaming for this session. Please wait.","code":"SESSION_BUSY"}]}

- **[8] Modify PERSONA**: BookingChangeSpecialist persona → warm
  - Project: AppointmentHub
  - Status: FAIL
  - Error: non-monotonic seq for turn_019e26a9-ccce-7ffc-b8b0-98f4e6260ef1: 2 after 3; assistant turn did not emit turn_ended/done; approval error: Proposal accept failed (409): {"success":false,"errors":[{"msg":"A response is already streaming for this session. Please wait.","code":"SESSION_BUSY"}]}
  - Event contract: non-monotonic seq for turn_019e26a9-ccce-7ffc-b8b0-98f4e6260ef1: 2 after 3; assistant turn did not emit turn_ended/done; approval error: Proposal accept failed (409): {"success":false,"errors":[{"msg":"A response is already streaming for this session. Please wait.","code":"SESSION_BUSY"}]}
  - Approval: ERROR — Proposal accept failed (409): {"success":false,"errors":[{"msg":"A response is already streaming for this session. Please wait.","code":"SESSION_BUSY"}]}

- **[9] Modify LIMITATIONS**: Add limitation to BookingChangeSpecialist
  - Project: AppointmentHub
  - Status: FAIL
  - Error: non-monotonic seq for turn_019e26aa-0a93-7400-bdf7-2c0e4583f373: 2 after 3; assistant turn did not emit turn_ended/done; approval error: Proposal accept failed (409): {"success":false,"errors":[{"msg":"A response is already streaming for this session. Please wait.","code":"SESSION_BUSY"}]}
  - Event contract: non-monotonic seq for turn_019e26aa-0a93-7400-bdf7-2c0e4583f373: 2 after 3; assistant turn did not emit turn_ended/done; approval error: Proposal accept failed (409): {"success":false,"errors":[{"msg":"A response is already streaming for this session. Please wait.","code":"SESSION_BUSY"}]}
  - Approval: ERROR — Proposal accept failed (409): {"success":false,"errors":[{"msg":"A response is already streaming for this session. Please wait.","code":"SESSION_BUSY"}]}

- **[10] Modify LIMITATIONS**: Add limitation to HumanEscalationSpecialist
  - Project: AppointmentHub
  - Status: FAIL
  - Error: non-monotonic seq for turn_019e26aa-5c6e-7d31-89ae-8975398d85e5: 2 after 3; assistant turn did not emit turn_ended/done; approval error: Proposal accept failed (409): {"success":false,"errors":[{"msg":"A response is already streaming for this session. Please wait.","code":"SESSION_BUSY"}]}
  - Event contract: non-monotonic seq for turn_019e26aa-5c6e-7d31-89ae-8975398d85e5: 2 after 3; assistant turn did not emit turn_ended/done; approval error: Proposal accept failed (409): {"success":false,"errors":[{"msg":"A response is already streaming for this session. Please wait.","code":"SESSION_BUSY"}]}
  - Approval: ERROR — Proposal accept failed (409): {"success":false,"errors":[{"msg":"A response is already streaming for this session. Please wait.","code":"SESSION_BUSY"}]}

- **[11] Modify GOAL**: Update goal of AvailabilityBookingSpecialist
  - Project: AppointmentHub
  - Status: FAIL
  - Error: non-monotonic seq for turn_019e26aa-9f82-7305-979c-7ab4b56b7a57: 2 after 3; assistant turn did not emit turn_ended/done; approval error: Proposal accept failed (409): {"success":false,"errors":[{"msg":"A response is already streaming for this session. Please wait.","code":"SESSION_BUSY"}]}
  - Event contract: non-monotonic seq for turn_019e26aa-9f82-7305-979c-7ab4b56b7a57: 2 after 3; assistant turn did not emit turn_ended/done; approval error: Proposal accept failed (409): {"success":false,"errors":[{"msg":"A response is already streaming for this session. Please wait.","code":"SESSION_BUSY"}]}
  - Approval: ERROR — Proposal accept failed (409): {"success":false,"errors":[{"msg":"A response is already streaming for this session. Please wait.","code":"SESSION_BUSY"}]}

- **[12] Modify GOAL**: Update goal of BookingChangeSpecialist
  - Project: AppointmentHub
  - Status: FAIL
  - Error: non-monotonic seq for turn_019e26aa-e7d4-7457-a069-8d9f2065809f: 2 after 3; assistant turn did not emit turn_ended/done; approval error: Proposal accept failed (409): {"success":false,"errors":[{"msg":"A response is already streaming for this session. Please wait.","code":"SESSION_BUSY"}]}
  - Event contract: non-monotonic seq for turn_019e26aa-e7d4-7457-a069-8d9f2065809f: 2 after 3; assistant turn did not emit turn_ended/done; approval error: Proposal accept failed (409): {"success":false,"errors":[{"msg":"A response is already streaming for this session. Please wait.","code":"SESSION_BUSY"}]}
  - Approval: ERROR — Proposal accept failed (409): {"success":false,"errors":[{"msg":"A response is already streaming for this session. Please wait.","code":"SESSION_BUSY"}]}

- **[13] Add Agent**: Add FeedbackCollector to AppointmentHub
  - Project: AppointmentHub
  - Status: FAIL
  - Error: non-monotonic seq for turn_019e26ab-2baa-7951-b724-7944c63219e7: 1 after 2; assistant turn did not emit turn_ended/done
  - Event contract: non-monotonic seq for turn_019e26ab-2baa-7951-b724-7944c63219e7: 1 after 2; assistant turn did not emit turn_ended/done

- **[14] Add Agent**: Add ComplianceMonitor to AppointmentHub
  - Project: AppointmentHub
  - Status: FAIL
  - Error: non-monotonic seq for turn_019e26ab-914f-7d47-9dc3-6175051bd464: 1 after 163
  - Event contract: non-monotonic seq for turn_019e26ab-914f-7d47-9dc3-6175051bd464: 1 after 163

- **[15] Modify CONSTRAINTS**: Add constraint to AvailabilityBookingSpecialist
  - Project: AppointmentHub
  - Status: FAIL
  - Error: non-monotonic seq for turn_019e26ac-1af1-7de7-8604-9a2a1cd68949: 2 after 3; assistant turn did not emit turn_ended/done; approval error: Proposal accept failed (409): {"success":false,"errors":[{"msg":"A response is already streaming for this session. Please wait.","code":"SESSION_BUSY"}]}
  - Event contract: non-monotonic seq for turn_019e26ac-1af1-7de7-8604-9a2a1cd68949: 2 after 3; assistant turn did not emit turn_ended/done; approval error: Proposal accept failed (409): {"success":false,"errors":[{"msg":"A response is already streaming for this session. Please wait.","code":"SESSION_BUSY"}]}
  - Approval: ERROR — Proposal accept failed (409): {"success":false,"errors":[{"msg":"A response is already streaming for this session. Please wait.","code":"SESSION_BUSY"}]}

- **[16] Modify CONSTRAINTS**: Add constraint to BookingChangeSpecialist
  - Project: AppointmentHub
  - Status: FAIL
  - Error: non-monotonic seq for turn_019e26ac-6c70-79a1-92e6-1eada2053bfb: 2 after 3; assistant turn did not emit turn_ended/done; approval error: Proposal accept failed (409): {"success":false,"errors":[{"msg":"A response is already streaming for this session. Please wait.","code":"SESSION_BUSY"}]}
  - Event contract: non-monotonic seq for turn_019e26ac-6c70-79a1-92e6-1eada2053bfb: 2 after 3; assistant turn did not emit turn_ended/done; approval error: Proposal accept failed (409): {"success":false,"errors":[{"msg":"A response is already streaming for this session. Please wait.","code":"SESSION_BUSY"}]}
  - Approval: ERROR — Proposal accept failed (409): {"success":false,"errors":[{"msg":"A response is already streaming for this session. Please wait.","code":"SESSION_BUSY"}]}

- **[17] Topology Verify**: Verify topology #1 of AppointmentHub
  - Project: AppointmentHub
  - Status: FAIL
  - Error: non-monotonic seq for turn_019e26ac-c051-74c1-a104-fef63bd81f1a: 1 after 320
  - Event contract: non-monotonic seq for turn_019e26ac-c051-74c1-a104-fef63bd81f1a: 1 after 320

- **[18] Topology Verify**: Verify topology #2 of AppointmentHub
  - Project: AppointmentHub
  - Status: FAIL
  - Error: non-monotonic seq for turn_019e26ac-ddb6-7b3f-8e87-990159d3b644: 1 after 245
  - Event contract: non-monotonic seq for turn_019e26ac-ddb6-7b3f-8e87-990159d3b644: 1 after 245

- **[19] Mixed**: What agents does this project have and what are th
  - Project: AppointmentHub
  - Status: FAIL
  - Error: non-monotonic seq for turn_019e26ac-fe2d-7ace-afd8-c254bff9570c: 1 after 196
  - Event contract: non-monotonic seq for turn_019e26ac-fe2d-7ace-afd8-c254bff9570c: 1 after 196

- **[20] Mixed**: Are there any issues with the current agent config
  - Project: AppointmentHub
  - Status: FAIL
  - Error: non-monotonic seq for turn_019e26ad-1a6f-75b3-8723-462746f3c79c: 1 after 376
  - Event contract: non-monotonic seq for turn_019e26ad-1a6f-75b3-8723-462746f3c79c: 1 after 376

- **[25] Read Topology**: Topology of OrderHelp
  - Project: OrderHelp
  - Status: FAIL
  - Error: non-monotonic seq for turn_019e26ad-c7e3-7c45-88e0-c6b7fa6e2b16: 1 after 427
  - Event contract: non-monotonic seq for turn_019e26ad-c7e3-7c45-88e0-c6b7fa6e2b16: 1 after 427

- **[26] Health Check**: Health of OrderHelp
  - Project: OrderHelp
  - Status: FAIL
  - Error: non-monotonic seq for turn_019e26ad-f2b0-7dd5-9aaa-e11459a96257: 1 after 410
  - Event contract: non-monotonic seq for turn_019e26ad-f2b0-7dd5-9aaa-e11459a96257: 1 after 410

- **[27] Modify PERSONA**: HumanEscalationSpecialist persona → formal
  - Project: OrderHelp
  - Status: FAIL
  - Error: non-monotonic seq for turn_019e26ae-68df-7166-a559-fe48589045da: 2 after 3; assistant turn did not emit turn_ended/done; approval error: Proposal accept failed (409): {"success":false,"errors":[{"msg":"A response is already streaming for this session. Please wait.","code":"SESSION_BUSY"}]}
  - Event contract: non-monotonic seq for turn_019e26ae-68df-7166-a559-fe48589045da: 2 after 3; assistant turn did not emit turn_ended/done; approval error: Proposal accept failed (409): {"success":false,"errors":[{"msg":"A response is already streaming for this session. Please wait.","code":"SESSION_BUSY"}]}
  - Approval: ERROR — Proposal accept failed (409): {"success":false,"errors":[{"msg":"A response is already streaming for this session. Please wait.","code":"SESSION_BUSY"}]}

- **[28] Modify PERSONA**: OrderStatusSpecialist persona → casual
  - Project: OrderHelp
  - Status: FAIL
  - Error: non-monotonic seq for turn_019e26ae-b5df-7d96-845c-eb32aaf29a3f: 2 after 3; assistant turn did not emit turn_ended/done; approval error: Proposal accept failed (409): {"success":false,"errors":[{"msg":"A response is already streaming for this session. Please wait.","code":"SESSION_BUSY"}]}
  - Event contract: non-monotonic seq for turn_019e26ae-b5df-7d96-845c-eb32aaf29a3f: 2 after 3; assistant turn did not emit turn_ended/done; approval error: Proposal accept failed (409): {"success":false,"errors":[{"msg":"A response is already streaming for this session. Please wait.","code":"SESSION_BUSY"}]}
  - Approval: ERROR — Proposal accept failed (409): {"success":false,"errors":[{"msg":"A response is already streaming for this session. Please wait.","code":"SESSION_BUSY"}]}

- **[29] Modify LIMITATIONS**: Add limitation to OrderStatusSpecialist
  - Project: OrderHelp
  - Status: FAIL
  - Error: non-monotonic seq for turn_019e26af-0b87-7c25-8f51-b64bb6415678: 2 after 3; assistant turn did not emit turn_ended/done; approval error: Proposal accept failed (409): {"success":false,"errors":[{"msg":"A response is already streaming for this session. Please wait.","code":"SESSION_BUSY"}]}
  - Event contract: non-monotonic seq for turn_019e26af-0b87-7c25-8f51-b64bb6415678: 2 after 3; assistant turn did not emit turn_ended/done; approval error: Proposal accept failed (409): {"success":false,"errors":[{"msg":"A response is already streaming for this session. Please wait.","code":"SESSION_BUSY"}]}
  - Approval: ERROR — Proposal accept failed (409): {"success":false,"errors":[{"msg":"A response is already streaming for this session. Please wait.","code":"SESSION_BUSY"}]}

- **[30] Modify LIMITATIONS**: Add limitation to ProductAccountFAQSpecialist
  - Project: OrderHelp
  - Status: FAIL
  - Error: non-monotonic seq for turn_019e26af-a051-7952-b2ad-24d6dd5a86e9: 2 after 94
  - Event contract: non-monotonic seq for turn_019e26af-a051-7952-b2ad-24d6dd5a86e9: 2 after 94
  - Approval: SKIP

- **[31] Modify GOAL**: Update goal of HumanEscalationSpecialist
  - Project: OrderHelp
  - Status: FAIL
  - Error: non-monotonic seq for turn_019e26af-b94a-7269-8363-e96b247ababe: 2 after 3; assistant turn did not emit turn_ended/done; approval error: Proposal accept failed (409): {"success":false,"errors":[{"msg":"A response is already streaming for this session. Please wait.","code":"SESSION_BUSY"}]}
  - Event contract: non-monotonic seq for turn_019e26af-b94a-7269-8363-e96b247ababe: 2 after 3; assistant turn did not emit turn_ended/done; approval error: Proposal accept failed (409): {"success":false,"errors":[{"msg":"A response is already streaming for this session. Please wait.","code":"SESSION_BUSY"}]}
  - Approval: ERROR — Proposal accept failed (409): {"success":false,"errors":[{"msg":"A response is already streaming for this session. Please wait.","code":"SESSION_BUSY"}]}

- **[32] Modify GOAL**: Update goal of OrderStatusSpecialist
  - Project: OrderHelp
  - Status: FAIL
  - Error: non-monotonic seq for turn_019e26af-fdf9-7ee9-9cf0-65dfaa9b3b8d: 2 after 3; assistant turn did not emit turn_ended/done; approval error: Proposal accept failed (409): {"success":false,"errors":[{"msg":"A response is already streaming for this session. Please wait.","code":"SESSION_BUSY"}]}
  - Event contract: non-monotonic seq for turn_019e26af-fdf9-7ee9-9cf0-65dfaa9b3b8d: 2 after 3; assistant turn did not emit turn_ended/done; approval error: Proposal accept failed (409): {"success":false,"errors":[{"msg":"A response is already streaming for this session. Please wait.","code":"SESSION_BUSY"}]}
  - Approval: ERROR — Proposal accept failed (409): {"success":false,"errors":[{"msg":"A response is already streaming for this session. Please wait.","code":"SESSION_BUSY"}]}

- **[33] Add Agent**: Add KnowledgeHelper to OrderHelp
  - Project: OrderHelp
  - Status: FAIL
  - Error: non-monotonic seq for turn_019e26b0-438c-774e-9751-022aa1f8025c: 1 after 6
  - Event contract: non-monotonic seq for turn_019e26b0-438c-774e-9751-022aa1f8025c: 1 after 6

- **[34] Add Agent**: Add EscalationHandler to OrderHelp
  - Project: OrderHelp
  - Status: FAIL
  - Error: non-monotonic seq for turn_019e26b0-e421-79d7-af27-a084df7311ad: 1 after 204
  - Event contract: non-monotonic seq for turn_019e26b0-e421-79d7-af27-a084df7311ad: 1 after 204

- **[35] Modify CONSTRAINTS**: Add constraint to HumanEscalationSpecialist
  - Project: OrderHelp
  - Status: FAIL
  - Error: non-monotonic seq for turn_019e26b1-7066-7308-86ab-4e5868a98206: 2 after 3; assistant turn did not emit turn_ended/done; approval error: Proposal accept failed (409): {"success":false,"errors":[{"msg":"A response is already streaming for this session. Please wait.","code":"SESSION_BUSY"}]}
  - Event contract: non-monotonic seq for turn_019e26b1-7066-7308-86ab-4e5868a98206: 2 after 3; assistant turn did not emit turn_ended/done; approval error: Proposal accept failed (409): {"success":false,"errors":[{"msg":"A response is already streaming for this session. Please wait.","code":"SESSION_BUSY"}]}
  - Approval: ERROR — Proposal accept failed (409): {"success":false,"errors":[{"msg":"A response is already streaming for this session. Please wait.","code":"SESSION_BUSY"}]}

- **[36] Modify CONSTRAINTS**: Add constraint to OrderStatusSpecialist
  - Project: OrderHelp
  - Status: FAIL
  - Error: non-monotonic seq for turn_019e26b1-c812-706f-8d7e-050b436cd866: 2 after 3; assistant turn did not emit turn_ended/done; approval error: Proposal accept failed (409): {"success":false,"errors":[{"msg":"A response is already streaming for this session. Please wait.","code":"SESSION_BUSY"}]}
  - Event contract: non-monotonic seq for turn_019e26b1-c812-706f-8d7e-050b436cd866: 2 after 3; assistant turn did not emit turn_ended/done; approval error: Proposal accept failed (409): {"success":false,"errors":[{"msg":"A response is already streaming for this session. Please wait.","code":"SESSION_BUSY"}]}
  - Approval: ERROR — Proposal accept failed (409): {"success":false,"errors":[{"msg":"A response is already streaming for this session. Please wait.","code":"SESSION_BUSY"}]}

- **[37] Topology Verify**: Verify topology #1 of OrderHelp
  - Project: OrderHelp
  - Status: FAIL
  - Error: non-monotonic seq for turn_019e26b2-2ef4-7033-ab5e-c7246971f259: 1 after 371
  - Event contract: non-monotonic seq for turn_019e26b2-2ef4-7033-ab5e-c7246971f259: 1 after 371

- **[38] Topology Verify**: Verify topology #2 of OrderHelp
  - Project: OrderHelp
  - Status: FAIL
  - Error: non-monotonic seq for turn_019e26b2-633d-78c5-9a39-31a42cf7c26b: 1 after 226
  - Event contract: non-monotonic seq for turn_019e26b2-633d-78c5-9a39-31a42cf7c26b: 1 after 226

- **[39] Mixed**: Suggest improvements for the supervisor agent rout
  - Project: OrderHelp
  - Status: FAIL
  - Error: non-monotonic seq for turn_019e26b2-7bdc-7f3d-b7c3-3f8c0fa641c9: 2 after 1036
  - Event contract: non-monotonic seq for turn_019e26b2-7bdc-7f3d-b7c3-3f8c0fa641c9: 2 after 1036

- **[44] Read Topology**: Topology of DispatchOps Round2 isorflow
  - Project: DispatchOps Round2 isorflow
  - Status: FAIL
  - Error: non-monotonic seq for turn_019e26b3-6b62-7244-be5b-ebde70fa8d45: 1 after 359
  - Event contract: non-monotonic seq for turn_019e26b3-6b62-7244-be5b-ebde70fa8d45: 1 after 359

- **[45] Health Check**: Health of DispatchOps Round2 isorflow
  - Project: DispatchOps Round2 isorflow
  - Status: FAIL
  - Error: non-monotonic seq for turn_019e26b3-8cf4-791e-9260-7f6215bb68b2: 1 after 459
  - Event contract: non-monotonic seq for turn_019e26b3-8cf4-791e-9260-7f6215bb68b2: 1 after 459

- **[46] Modify PERSONA**: DispatchOpsRound2IsorflowIntakeAgent persona → patient
  - Project: DispatchOps Round2 isorflow
  - Status: FAIL
  - Error: non-monotonic seq for turn_019e26b3-bb50-7a58-a921-a0acdb97a7af: 2 after 7; assistant turn did not emit turn_ended/done; approval error: Proposal accept failed (409): {"success":false,"errors":[{"msg":"A response is already streaming for this session. Please wait.","code":"SESSION_BUSY"}]}
  - Event contract: non-monotonic seq for turn_019e26b3-bb50-7a58-a921-a0acdb97a7af: 2 after 7; assistant turn did not emit turn_ended/done; approval error: Proposal accept failed (409): {"success":false,"errors":[{"msg":"A response is already streaming for this session. Please wait.","code":"SESSION_BUSY"}]}
  - Approval: ERROR — Proposal accept failed (409): {"success":false,"errors":[{"msg":"A response is already streaming for this session. Please wait.","code":"SESSION_BUSY"}]}

- **[47] Modify PERSONA**: DispatchOpsRound2IsorflowProcessorAgent persona → new
  - Project: DispatchOps Round2 isorflow
  - Status: FAIL
  - Error: non-monotonic seq for turn_019e26b4-2f48-7026-84e7-65d67f8f6d03: 2 after 6; assistant turn did not emit turn_ended/done; approval error: Proposal accept failed (409): {"success":false,"errors":[{"msg":"A response is already streaming for this session. Please wait.","code":"SESSION_BUSY"}]}
  - Event contract: non-monotonic seq for turn_019e26b4-2f48-7026-84e7-65d67f8f6d03: 2 after 6; assistant turn did not emit turn_ended/done; approval error: Proposal accept failed (409): {"success":false,"errors":[{"msg":"A response is already streaming for this session. Please wait.","code":"SESSION_BUSY"}]}
  - Approval: ERROR — Proposal accept failed (409): {"success":false,"errors":[{"msg":"A response is already streaming for this session. Please wait.","code":"SESSION_BUSY"}]}

- **[48] Modify LIMITATIONS**: Add limitation to DispatchOpsRound2IsorflowProcessorAgent
  - Project: DispatchOps Round2 isorflow
  - Status: FAIL
  - Error: non-monotonic seq for turn_019e26b4-6da5-783d-98e6-071a197f0b11: 2 after 5; assistant turn did not emit turn_ended/done; approval error: Proposal accept failed (409): {"success":false,"errors":[{"msg":"A response is already streaming for this session. Please wait.","code":"SESSION_BUSY"}]}
  - Event contract: non-monotonic seq for turn_019e26b4-6da5-783d-98e6-071a197f0b11: 2 after 5; assistant turn did not emit turn_ended/done; approval error: Proposal accept failed (409): {"success":false,"errors":[{"msg":"A response is already streaming for this session. Please wait.","code":"SESSION_BUSY"}]}
  - Approval: ERROR — Proposal accept failed (409): {"success":false,"errors":[{"msg":"A response is already streaming for this session. Please wait.","code":"SESSION_BUSY"}]}

- **[49] Modify LIMITATIONS**: Add limitation to DispatchOpsRound2IsorflowReviewerAgent
  - Project: DispatchOps Round2 isorflow
  - Status: FAIL
  - Error: non-monotonic seq for turn_019e26b4-a7fa-76eb-aee1-a33a89dd2b0a: 2 after 7; assistant turn did not emit turn_ended/done; approval error: Proposal accept failed (409): {"success":false,"errors":[{"msg":"A response is already streaming for this session. Please wait.","code":"SESSION_BUSY"}]}
  - Event contract: non-monotonic seq for turn_019e26b4-a7fa-76eb-aee1-a33a89dd2b0a: 2 after 7; assistant turn did not emit turn_ended/done; approval error: Proposal accept failed (409): {"success":false,"errors":[{"msg":"A response is already streaming for this session. Please wait.","code":"SESSION_BUSY"}]}
  - Approval: ERROR — Proposal accept failed (409): {"success":false,"errors":[{"msg":"A response is already streaming for this session. Please wait.","code":"SESSION_BUSY"}]}

- **[50] Modify GOAL**: Update goal of DispatchOpsRound2IsorflowIntakeAgent
  - Project: DispatchOps Round2 isorflow
  - Status: FAIL
  - Error: non-monotonic seq for turn_019e26b4-fe56-7891-8235-9a3a518c0f2f: 2 after 5; assistant turn did not emit turn_ended/done; approval error: Proposal accept failed (409): {"success":false,"errors":[{"msg":"A response is already streaming for this session. Please wait.","code":"SESSION_BUSY"}]}
  - Event contract: non-monotonic seq for turn_019e26b4-fe56-7891-8235-9a3a518c0f2f: 2 after 5; assistant turn did not emit turn_ended/done; approval error: Proposal accept failed (409): {"success":false,"errors":[{"msg":"A response is already streaming for this session. Please wait.","code":"SESSION_BUSY"}]}
  - Approval: ERROR — Proposal accept failed (409): {"success":false,"errors":[{"msg":"A response is already streaming for this session. Please wait.","code":"SESSION_BUSY"}]}
