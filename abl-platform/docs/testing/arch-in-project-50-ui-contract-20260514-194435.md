# Arch AI In-Project — 50 Scenario UI Contract Test Results

**Date**: 2026-05-14
**Mode**: CLI-driven Studio SSE + proposal approval contract
**Projects tested**: AppointmentHub, OrderHelp, DispatchOps Round2 isorflow, DispatchOps Round2 -topthen, DispatchOps Round2 nsuccess
**Total**: 50 | **Passed**: 47 | **Failed**: 3 | **Errors**: 0
**Pass Rate**: 94.0%

## **Contract Findings**: Event/order failures 2 | Busy/streaming 2 | Pending proposal 0 | Approval failures 2

## Category Summary

| Category           | Pass | Fail | Error | Rate |
| ------------------ | ---- | ---- | ----- | ---- |
| Read Agent         | 11   | 0    | 0     | 100% |
| Read Topology      | 3    | 0    | 0     | 100% |
| Health Check       | 3    | 0    | 0     | 100% |
| Modify PERSONA     | 4    | 2    | 0     | 67%  |
| Modify LIMITATIONS | 5    | 1    | 0     | 83%  |
| Modify GOAL        | 5    | 0    | 0     | 100% |
| Add Agent          | 4    | 0    | 0     | 100% |
| Modify CONSTRAINTS | 4    | 0    | 0     | 100% |
| Topology Verify    | 4    | 0    | 0     | 100% |
| Mixed              | 4    | 0    | 0     | 100% |

---

## UI/Backend Contract Summary

| Check                                              | Count |
| -------------------------------------------------- | ----- |
| Event ordering / turn completion / protocol issues | 2     |
| Busy or already-streaming errors                   | 2     |
| Pending proposal errors                            | 0     |
| Approval failures                                  | 2     |
| Tool-call limit risks                              | 0     |

---

## Full Results

| #   | Category           | Description                              | Project              | Status | Duration | Events | Tool Calls | Turn End | Artifacts | Approval | Error                                                        |
| --- | ------------------ | ---------------------------------------- | -------------------- | ------ | -------- | ------ | ---------- | -------- | --------- | -------- | ------------------------------------------------------------ |
| 1   | Read Agent         | Read AvailabilityBookingSpecialist       | AppointmentHub       | PASS   | 13.8s    | 437    | 1          | yes      | 0         | -        | -                                                            |
| 2   | Read Agent         | Read BookingChangeSpecialist             | AppointmentHub       | PASS   | 9.9s     | 496    | 1          | yes      | 0         | -        | -                                                            |
| 3   | Read Agent         | Read HumanEscalationSpecialist           | AppointmentHub       | PASS   | 9.0s     | 427    | 1          | yes      | 0         | -        | -                                                            |
| 4   | Read Agent         | Read SchedulingFaqSpecialist             | AppointmentHub       | PASS   | 10.9s    | 373    | 1          | yes      | 0         | -        | -                                                            |
| 5   | Read Topology      | Topology of AppointmentHub               | AppointmentHub       | PASS   | 9.6s     | 423    | 1          | yes      | 0         | -        | -                                                            |
| 6   | Health Check       | Health of AppointmentHub                 | AppointmentHub       | PASS   | 11.4s    | 532    | 1          | yes      | 0         | -        | -                                                            |
| 7   | Modify PERSONA     | AvailabilityBookingSpecialist persona →  | AppointmentHub       | PASS   | 18.9s    | 14     | 3          | yes      | 1         | PASS     | -                                                            |
| 8   | Modify PERSONA     | BookingChangeSpecialist persona → warm   | AppointmentHub       | PASS   | 27.9s    | 23     | 6          | yes      | 1         | PASS     | -                                                            |
| 9   | Modify LIMITATIONS | Add limitation to BookingChangeSpecialis | AppointmentHub       | PASS   | 45.4s    | 25     | 8          | yes      | 1         | PASS     | -                                                            |
| 10  | Modify LIMITATIONS | Add limitation to HumanEscalationSpecial | AppointmentHub       | FAIL   | 10.2s    | 476    | 0          | yes      | 0         | SKIP     | pass criteria not met                                        |
| 11  | Modify GOAL        | Update goal of AvailabilityBookingSpecia | AppointmentHub       | PASS   | 18.7s    | 16     | 4          | yes      | 1         | PASS     | -                                                            |
| 12  | Modify GOAL        | Update goal of BookingChangeSpecialist   | AppointmentHub       | PASS   | 18.4s    | 16     | 4          | yes      | 1         | PASS     | -                                                            |
| 13  | Add Agent          | Add FeedbackCollector to AppointmentHub  | AppointmentHub       | PASS   | 27.3s    | 107    | 5          | yes      | 1         | PASS     | -                                                            |
| 14  | Add Agent          | Add ComplianceMonitor to AppointmentHub  | AppointmentHub       | PASS   | 25.3s    | 18     | 5          | yes      | 1         | PASS     | -                                                            |
| 15  | Modify CONSTRAINTS | Add constraint to AvailabilityBookingSpe | AppointmentHub       | PASS   | 40.9s    | 31     | 11         | yes      | 1         | PASS     | -                                                            |
| 16  | Modify CONSTRAINTS | Add constraint to BookingChangeSpecialis | AppointmentHub       | PASS   | 10.3s    | 25     | 9          | yes      | 0         | SKIP     | -                                                            |
| 17  | Topology Verify    | Verify topology #1 of AppointmentHub     | AppointmentHub       | PASS   | 8.0s     | 311    | 1          | yes      | 0         | -        | -                                                            |
| 18  | Topology Verify    | Verify topology #2 of AppointmentHub     | AppointmentHub       | PASS   | 6.7s     | 233    | 1          | yes      | 0         | -        | -                                                            |
| 19  | Mixed              | What agents does this project have and w | AppointmentHub       | PASS   | 7.3s     | 237    | 1          | yes      | 0         | -        | -                                                            |
| 20  | Mixed              | Are there any issues with the current ag | AppointmentHub       | PASS   | 11.7s    | 456    | 1          | yes      | 0         | -        | -                                                            |
| 21  | Read Agent         | Read HumanEscalationSpecialist           | OrderHelp            | PASS   | 12.2s    | 376    | 1          | yes      | 0         | -        | -                                                            |
| 22  | Read Agent         | Read OrderStatusSpecialist               | OrderHelp            | PASS   | 9.3s     | 364    | 1          | yes      | 0         | -        | -                                                            |
| 23  | Read Agent         | Read ProductAccountFAQSpecialist         | OrderHelp            | PASS   | 8.6s     | 384    | 1          | yes      | 0         | -        | -                                                            |
| 24  | Read Agent         | Read ReturnsRefundsSpecialist            | OrderHelp            | PASS   | 9.2s     | 437    | 1          | yes      | 0         | -        | -                                                            |
| 25  | Read Topology      | Topology of OrderHelp                    | OrderHelp            | PASS   | 12.8s    | 698    | 7          | yes      | 0         | -        | -                                                            |
| 26  | Health Check       | Health of OrderHelp                      | OrderHelp            | PASS   | 10.8s    | 599    | 1          | yes      | 0         | -        | -                                                            |
| 27  | Modify PERSONA     | HumanEscalationSpecialist persona → form | OrderHelp            | PASS   | 19.3s    | 14     | 3          | yes      | 1         | PASS     | -                                                            |
| 28  | Modify PERSONA     | OrderStatusSpecialist persona → casual   | OrderHelp            | PASS   | 33.1s    | 20     | 6          | yes      | 1         | PASS     | -                                                            |
| 29  | Modify LIMITATIONS | Add limitation to OrderStatusSpecialist  | OrderHelp            | PASS   | 25.7s    | 21     | 6          | yes      | 1         | PASS     | -                                                            |
| 30  | Modify LIMITATIONS | Add limitation to ProductAccountFAQSpeci | OrderHelp            | PASS   | 34.7s    | 21     | 6          | yes      | 1         | PASS     | -                                                            |
| 31  | Modify GOAL        | Update goal of HumanEscalationSpecialist | OrderHelp            | PASS   | 25.2s    | 116    | 6          | yes      | 1         | PASS     | -                                                            |
| 32  | Modify GOAL        | Update goal of OrderStatusSpecialist     | OrderHelp            | PASS   | 20.8s    | 94     | 5          | yes      | 1         | PASS     | -                                                            |
| 33  | Add Agent          | Add KnowledgeHelper to OrderHelp         | OrderHelp            | PASS   | 8.4s     | 164    | 4          | yes      | 0         | SKIP     | -                                                            |
| 34  | Add Agent          | Add EscalationHandler to OrderHelp       | OrderHelp            | PASS   | 28.8s    | 118    | 6          | yes      | 1         | PASS     | -                                                            |
| 35  | Modify CONSTRAINTS | Add constraint to HumanEscalationSpecial | OrderHelp            | PASS   | 10.9s    | 307    | 4          | yes      | 0         | SKIP     | -                                                            |
| 36  | Modify CONSTRAINTS | Add constraint to OrderStatusSpecialist  | OrderHelp            | PASS   | 15.1s    | 285    | 4          | yes      | 0         | SKIP     | -                                                            |
| 37  | Topology Verify    | Verify topology #1 of OrderHelp          | OrderHelp            | PASS   | 10.8s    | 375    | 1          | yes      | 0         | -        | -                                                            |
| 38  | Topology Verify    | Verify topology #2 of OrderHelp          | OrderHelp            | PASS   | 6.5s     | 243    | 1          | yes      | 0         | -        | -                                                            |
| 39  | Mixed              | Suggest improvements for the supervisor  | OrderHelp            | PASS   | 27.7s    | 950    | 4          | yes      | 0         | -        | -                                                            |
| 40  | Mixed              | Which agent handles the most critical us | OrderHelp            | PASS   | 6.1s     | 281    | 0          | yes      | 0         | -        | -                                                            |
| 41  | Read Agent         | Read DispatchOpsRound2IsorflowIntakeAgen | DispatchOps Round2 i | PASS   | 16.4s    | 658    | 2          | yes      | 0         | -        | -                                                            |
| 42  | Read Agent         | Read DispatchOpsRound2IsorflowProcessorA | DispatchOps Round2 i | PASS   | 13.6s    | 713    | 2          | yes      | 0         | -        | -                                                            |
| 43  | Read Agent         | Read DispatchOpsRound2IsorflowReviewerAg | DispatchOps Round2 i | PASS   | 13.3s    | 674    | 2          | yes      | 0         | -        | -                                                            |
| 44  | Read Topology      | Topology of DispatchOps Round2 isorflow  | DispatchOps Round2 i | PASS   | 8.0s     | 367    | 1          | yes      | 0         | -        | -                                                            |
| 45  | Health Check       | Health of DispatchOps Round2 isorflow    | DispatchOps Round2 i | PASS   | 10.5s    | 470    | 2          | yes      | 0         | -        | -                                                            |
| 46  | Modify PERSONA     | DispatchOpsRound2IsorflowIntakeAgent per | DispatchOps Round2 i | FAIL   | 19.8s    | 209    | 5          | yes      | 0         | ERROR    | approval error: Proposal accept failed (409): {"success":fal |
| 47  | Modify PERSONA     | DispatchOpsRound2IsorflowProcessorAgent  | DispatchOps Round2 i | FAIL   | 13.4s    | 16     | 4          | yes      | 0         | ERROR    | approval error: Proposal accept failed (409): {"success":fal |
| 48  | Modify LIMITATIONS | Add limitation to DispatchOpsRound2Isorf | DispatchOps Round2 i | PASS   | 26.5s    | 16     | 4          | yes      | 1         | PASS     | -                                                            |
| 49  | Modify LIMITATIONS | Add limitation to DispatchOpsRound2Isorf | DispatchOps Round2 i | PASS   | 33.9s    | 24     | 8          | yes      | 1         | PASS     | -                                                            |
| 50  | Modify GOAL        | Update goal of DispatchOpsRound2Isorflow | DispatchOps Round2 i | PASS   | 22.3s    | 20     | 6          | yes      | 1         | PASS     | -                                                            |

---

## Failures & Errors

- **[10] Modify LIMITATIONS**: Add limitation to HumanEscalationSpecialist
  - Project: AppointmentHub
  - Status: FAIL
  - Error: pass criteria not met
  - Approval: SKIP

- **[46] Modify PERSONA**: DispatchOpsRound2IsorflowIntakeAgent persona → patient
  - Project: DispatchOps Round2 isorflow
  - Status: FAIL
  - Error: approval error: Proposal accept failed (409): {"success":false,"errors":[{"msg":"A response is already streaming for this session. Please wait.","code":"SESSION_BUSY"}]}
  - Event contract: approval error: Proposal accept failed (409): {"success":false,"errors":[{"msg":"A response is already streaming for this session. Please wait.","code":"SESSION_BUSY"}]}
  - Approval: ERROR — Proposal accept failed (409): {"success":false,"errors":[{"msg":"A response is already streaming for this session. Please wait.","code":"SESSION_BUSY"}]}

- **[47] Modify PERSONA**: DispatchOpsRound2IsorflowProcessorAgent persona → new
  - Project: DispatchOps Round2 isorflow
  - Status: FAIL
  - Error: approval error: Proposal accept failed (409): {"success":false,"errors":[{"msg":"A response is already streaming for this session. Please wait.","code":"SESSION_BUSY"}]}
  - Event contract: approval error: Proposal accept failed (409): {"success":false,"errors":[{"msg":"A response is already streaming for this session. Please wait.","code":"SESSION_BUSY"}]}
  - Approval: ERROR — Proposal accept failed (409): {"success":false,"errors":[{"msg":"A response is already streaming for this session. Please wait.","code":"SESSION_BUSY"}]}
