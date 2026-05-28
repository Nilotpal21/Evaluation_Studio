# Arch AI In-Project — 100 Scenario UI Contract Test Results

**Date**: 2026-05-14
**Mode**: CLI-driven Studio SSE + proposal approval contract
**Projects tested**: AppointmentHub, OrderHelp, DispatchOps Round2 isorflow, DispatchOps Round2 -topthen, DispatchOps Round2 nsuccess
**Total**: 100 | **Passed**: 98 | **Failed**: 2 | **Errors**: 0
**Pass Rate**: 98.0%

## **Contract Findings**: Event/order failures 2 | Busy/streaming 0 | Pending proposal 0 | Approval failures 0

## Category Summary

| Category           | Pass | Fail | Error | Rate |
| ------------------ | ---- | ---- | ----- | ---- |
| Read Agent         | 19   | 0    | 0     | 100% |
| Read Topology      | 5    | 0    | 0     | 100% |
| Health Check       | 5    | 0    | 0     | 100% |
| Modify PERSONA     | 10   | 0    | 0     | 100% |
| Modify LIMITATIONS | 10   | 0    | 0     | 100% |
| Modify GOAL        | 10   | 0    | 0     | 100% |
| Add Agent          | 10   | 0    | 0     | 100% |
| Modify CONSTRAINTS | 9    | 1    | 0     | 90%  |
| Topology Verify    | 10   | 0    | 0     | 100% |
| Mixed              | 10   | 1    | 0     | 91%  |

---

## UI/Backend Contract Summary

| Check                                              | Count |
| -------------------------------------------------- | ----- |
| Event ordering / turn completion / protocol issues | 2     |
| Busy or already-streaming errors                   | 0     |
| Pending proposal errors                            | 0     |
| Approval failures                                  | 0     |
| Tool-call limit risks                              | 0     |

---

## Full Results

| #   | Category           | Description                              | Project              | Status | Duration | Events | Tool Calls | Turn End | Artifacts | Approval | Error                                                        |
| --- | ------------------ | ---------------------------------------- | -------------------- | ------ | -------- | ------ | ---------- | -------- | --------- | -------- | ------------------------------------------------------------ |
| 1   | Read Agent         | Read AvailabilityBookingSpecialist       | AppointmentHub       | PASS   | 11.5s    | 460    | 1          | yes      | 0         | -        | -                                                            |
| 2   | Read Agent         | Read BookingChangeSpecialist             | AppointmentHub       | PASS   | 12.3s    | 641    | 1          | yes      | 0         | -        | -                                                            |
| 3   | Read Agent         | Read ComplianceMonitor                   | AppointmentHub       | PASS   | 8.3s     | 278    | 1          | yes      | 0         | -        | -                                                            |
| 4   | Read Agent         | Read FeedbackCollector                   | AppointmentHub       | PASS   | 13.6s    | 394    | 2          | yes      | 0         | -        | -                                                            |
| 5   | Read Topology      | Topology of AppointmentHub               | AppointmentHub       | PASS   | 11.0s    | 458    | 1          | yes      | 0         | -        | -                                                            |
| 6   | Health Check       | Health of AppointmentHub                 | AppointmentHub       | PASS   | 17.4s    | 1077   | 3          | yes      | 0         | -        | -                                                            |
| 7   | Modify PERSONA     | AvailabilityBookingSpecialist persona →  | AppointmentHub       | PASS   | 20.7s    | 227    | 5          | yes      | 0         | SKIP     | -                                                            |
| 8   | Modify PERSONA     | BookingChangeSpecialist persona → warm   | AppointmentHub       | PASS   | 29.3s    | 190    | 3          | yes      | 1         | PASS     | -                                                            |
| 9   | Modify LIMITATIONS | Add limitation to BookingChangeSpecialis | AppointmentHub       | PASS   | 6.6s     | 154    | 2          | yes      | 0         | SKIP     | -                                                            |
| 10  | Modify LIMITATIONS | Add limitation to ComplianceMonitor      | AppointmentHub       | PASS   | 40.6s    | 18     | 5          | yes      | 1         | PASS     | -                                                            |
| 11  | Modify GOAL        | Update goal of AvailabilityBookingSpecia | AppointmentHub       | PASS   | 29.9s    | 20     | 5          | yes      | 1         | PASS     | -                                                            |
| 12  | Modify GOAL        | Update goal of BookingChangeSpecialist   | AppointmentHub       | PASS   | 36.7s    | 93     | 5          | yes      | 1         | PASS     | -                                                            |
| 13  | Add Agent          | Add FeedbackCollector to AppointmentHub  | AppointmentHub       | PASS   | 35.3s    | 29     | 9          | yes      | 1         | PASS     | -                                                            |
| 14  | Add Agent          | Add ComplianceMonitor to AppointmentHub  | AppointmentHub       | PASS   | 8.7s     | 198    | 2          | yes      | 0         | SKIP     | -                                                            |
| 15  | Modify CONSTRAINTS | Add constraint to AvailabilityBookingSpe | AppointmentHub       | PASS   | 24.0s    | 25     | 8          | yes      | 1         | PASS     | -                                                            |
| 16  | Modify CONSTRAINTS | Add constraint to BookingChangeSpecialis | AppointmentHub       | PASS   | 30.7s    | 27     | 9          | yes      | 1         | PASS     | -                                                            |
| 17  | Topology Verify    | Verify topology #1 of AppointmentHub     | AppointmentHub       | PASS   | 8.1s     | 425    | 1          | yes      | 0         | -        | -                                                            |
| 18  | Topology Verify    | Verify topology #2 of AppointmentHub     | AppointmentHub       | PASS   | 7.9s     | 276    | 2          | yes      | 0         | -        | -                                                            |
| 19  | Mixed              | What agents does this project have and w | AppointmentHub       | PASS   | 10.2s    | 454    | 2          | yes      | 0         | -        | -                                                            |
| 20  | Mixed              | Are there any issues with the current ag | AppointmentHub       | PASS   | 13.4s    | 685    | 3          | yes      | 0         | -        | -                                                            |
| 21  | Read Agent         | Read EscalationHandler                   | OrderHelp            | PASS   | 8.4s     | 324    | 1          | yes      | 0         | -        | -                                                            |
| 22  | Read Agent         | Read HumanEscalationSpecialist           | OrderHelp            | PASS   | 12.7s    | 405    | 1          | yes      | 0         | -        | -                                                            |
| 23  | Read Agent         | Read OrderStatusSpecialist               | OrderHelp            | PASS   | 10.1s    | 454    | 1          | yes      | 0         | -        | -                                                            |
| 24  | Read Agent         | Read ProductAccountFAQSpecialist         | OrderHelp            | PASS   | 10.8s    | 477    | 1          | yes      | 0         | -        | -                                                            |
| 25  | Read Topology      | Topology of OrderHelp                    | OrderHelp            | PASS   | 10.4s    | 543    | 1          | yes      | 0         | -        | -                                                            |
| 26  | Health Check       | Health of OrderHelp                      | OrderHelp            | PASS   | 11.9s    | 465    | 2          | yes      | 0         | -        | -                                                            |
| 27  | Modify PERSONA     | EscalationHandler persona → formal       | OrderHelp            | PASS   | 31.9s    | 68     | 6          | yes      | 0         | SKIP     | -                                                            |
| 28  | Modify PERSONA     | HumanEscalationSpecialist persona → casu | OrderHelp            | PASS   | 36.1s    | 172    | 6          | yes      | 1         | PASS     | -                                                            |
| 29  | Modify LIMITATIONS | Add limitation to HumanEscalationSpecial | OrderHelp            | PASS   | 20.1s    | 14     | 3          | yes      | 1         | PASS     | -                                                            |
| 30  | Modify LIMITATIONS | Add limitation to OrderStatusSpecialist  | OrderHelp            | PASS   | 26.8s    | 146    | 5          | yes      | 1         | PASS     | -                                                            |
| 31  | Modify GOAL        | Update goal of EscalationHandler         | OrderHelp            | PASS   | 29.0s    | 196    | 6          | yes      | 1         | PASS     | -                                                            |
| 32  | Modify GOAL        | Update goal of HumanEscalationSpecialist | OrderHelp            | PASS   | 29.9s    | 231    | 5          | yes      | 1         | PASS     | -                                                            |
| 33  | Add Agent          | Add KnowledgeHelper to OrderHelp         | OrderHelp            | PASS   | 30.0s    | 21     | 7          | yes      | 1         | PASS     | -                                                            |
| 34  | Add Agent          | Add EscalationHandler to OrderHelp       | OrderHelp            | PASS   | 24.2s    | 532    | 5          | yes      | 1         | PASS     | -                                                            |
| 35  | Modify CONSTRAINTS | Add constraint to EscalationHandler      | OrderHelp            | PASS   | 24.1s    | 26     | 8          | yes      | 1         | PASS     | -                                                            |
| 36  | Modify CONSTRAINTS | Add constraint to HumanEscalationSpecial | OrderHelp            | PASS   | 28.3s    | 20     | 6          | yes      | 1         | PASS     | -                                                            |
| 37  | Topology Verify    | Verify topology #1 of OrderHelp          | OrderHelp            | PASS   | 12.8s    | 488    | 1          | yes      | 0         | -        | -                                                            |
| 38  | Topology Verify    | Verify topology #2 of OrderHelp          | OrderHelp            | PASS   | 10.5s    | 362    | 2          | yes      | 0         | -        | -                                                            |
| 39  | Mixed              | Suggest improvements for the supervisor  | OrderHelp            | PASS   | 33.7s    | 1409   | 11         | yes      | 0         | -        | -                                                            |
| 40  | Mixed              | Which agent handles the most critical us | OrderHelp            | PASS   | 9.2s     | 273    | 2          | yes      | 0         | -        | -                                                            |
| 41  | Read Agent         | Read DispatchOpsRound2IsorflowIntakeAgen | DispatchOps Round2 i | PASS   | 14.7s    | 486    | 1          | yes      | 0         | -        | -                                                            |
| 42  | Read Agent         | Read DispatchOpsRound2IsorflowProcessorA | DispatchOps Round2 i | PASS   | 9.6s     | 333    | 1          | yes      | 0         | -        | -                                                            |
| 43  | Read Agent         | Read DispatchOpsRound2IsorflowReviewerAg | DispatchOps Round2 i | PASS   | 13.5s    | 472    | 1          | yes      | 0         | -        | -                                                            |
| 44  | Read Topology      | Topology of DispatchOps Round2 isorflow  | DispatchOps Round2 i | PASS   | 8.1s     | 338    | 1          | yes      | 0         | -        | -                                                            |
| 45  | Health Check       | Health of DispatchOps Round2 isorflow    | DispatchOps Round2 i | PASS   | 8.5s     | 364    | 2          | yes      | 0         | -        | -                                                            |
| 46  | Modify PERSONA     | DispatchOpsRound2IsorflowIntakeAgent per | DispatchOps Round2 i | PASS   | 29.2s    | 212    | 5          | yes      | 0         | SKIP     | -                                                            |
| 47  | Modify PERSONA     | DispatchOpsRound2IsorflowProcessorAgent  | DispatchOps Round2 i | PASS   | 30.4s    | 23     | 6          | yes      | 1         | PASS     | -                                                            |
| 48  | Modify LIMITATIONS | Add limitation to DispatchOpsRound2Isorf | DispatchOps Round2 i | PASS   | 30.1s    | 21     | 6          | yes      | 1         | PASS     | -                                                            |
| 49  | Modify LIMITATIONS | Add limitation to DispatchOpsRound2Isorf | DispatchOps Round2 i | PASS   | 7.3s     | 126    | 2          | yes      | 0         | SKIP     | -                                                            |
| 50  | Modify GOAL        | Update goal of DispatchOpsRound2Isorflow | DispatchOps Round2 i | PASS   | 19.0s    | 238    | 3          | yes      | 1         | PASS     | -                                                            |
| 51  | Modify GOAL        | Update goal of DispatchOpsRound2Isorflow | DispatchOps Round2 i | PASS   | 19.8s    | 22     | 6          | yes      | 0         | SKIP     | -                                                            |
| 52  | Add Agent          | Add AnalyticsReporter to DispatchOps Rou | DispatchOps Round2 i | PASS   | 30.5s    | 24     | 7          | yes      | 2         | PASS     | -                                                            |
| 53  | Add Agent          | Add OnboardingGuide to DispatchOps Round | DispatchOps Round2 i | PASS   | 39.1s    | 287    | 5          | yes      | 2         | PASS     | -                                                            |
| 54  | Modify CONSTRAINTS | Add constraint to DispatchOpsRound2Isorf | DispatchOps Round2 i | PASS   | 34.1s    | 18     | 6          | yes      | 0         | SKIP     | -                                                            |
| 55  | Modify CONSTRAINTS | Add constraint to DispatchOpsRound2Isorf | DispatchOps Round2 i | PASS   | 27.9s    | 20     | 6          | yes      | 1         | PASS     | -                                                            |
| 56  | Topology Verify    | Verify topology #1 of DispatchOps Round2 | DispatchOps Round2 i | PASS   | 15.0s    | 351    | 2          | yes      | 0         | -        | -                                                            |
| 57  | Topology Verify    | Verify topology #2 of DispatchOps Round2 | DispatchOps Round2 i | PASS   | 9.3s     | 330    | 2          | yes      | 0         | -        | -                                                            |
| 58  | Mixed              | Are there any missing capabilities in th | DispatchOps Round2 i | PASS   | 17.8s    | 662    | 4          | yes      | 0         | -        | -                                                            |
| 59  | Mixed              | How could we improve error handling acro | DispatchOps Round2 i | PASS   | 26.8s    | 1374   | 9          | yes      | 0         | -        | -                                                            |
| 60  | Read Agent         | Read DispatchRouter                      | DispatchOps Round2 - | PASS   | 18.7s    | 670    | 2          | yes      | 0         | -        | -                                                            |
| 61  | Read Agent         | Read HumanEscalation                     | DispatchOps Round2 - | PASS   | 15.3s    | 597    | 2          | yes      | 0         | -        | -                                                            |
| 62  | Read Agent         | Read IntakeAndDispatch                   | DispatchOps Round2 - | PASS   | 16.2s    | 614    | 2          | yes      | 0         | -        | -                                                            |
| 63  | Read Agent         | Read RescheduleManager                   | DispatchOps Round2 - | PASS   | 24.8s    | 672    | 2          | yes      | 0         | -        | -                                                            |
| 64  | Read Topology      | Topology of DispatchOps Round2 -topthen  | DispatchOps Round2 - | PASS   | 10.6s    | 513    | 1          | yes      | 0         | -        | -                                                            |
| 65  | Health Check       | Health of DispatchOps Round2 -topthen    | DispatchOps Round2 - | PASS   | 13.0s    | 737    | 2          | yes      | 0         | -        | -                                                            |
| 66  | Modify PERSONA     | DispatchRouter persona → new             | DispatchOps Round2 - | PASS   | 36.9s    | 227    | 6          | yes      | 1         | PASS     | -                                                            |
| 67  | Modify PERSONA     | HumanEscalation persona → new            | DispatchOps Round2 - | PASS   | 19.9s    | 14     | 3          | yes      | 1         | PASS     | -                                                            |
| 68  | Modify LIMITATIONS | Add limitation to HumanEscalation        | DispatchOps Round2 - | PASS   | 27.9s    | 159    | 3          | yes      | 1         | PASS     | -                                                            |
| 69  | Modify LIMITATIONS | Add limitation to IntakeAndDispatch      | DispatchOps Round2 - | PASS   | 30.9s    | 16     | 4          | yes      | 0         | SKIP     | -                                                            |
| 70  | Modify GOAL        | Update goal of DispatchRouter            | DispatchOps Round2 - | PASS   | 25.6s    | 23     | 6          | yes      | 1         | PASS     | -                                                            |
| 71  | Modify GOAL        | Update goal of HumanEscalation           | DispatchOps Round2 - | PASS   | 18.9s    | 177    | 3          | yes      | 1         | PASS     | -                                                            |
| 72  | Add Agent          | Add BillingAssistant to DispatchOps Roun | DispatchOps Round2 - | PASS   | 23.8s    | 17     | 5          | yes      | 1         | PASS     | -                                                            |
| 73  | Add Agent          | Add TechDiagnostic to DispatchOps Round2 | DispatchOps Round2 - | PASS   | 32.0s    | 26     | 8          | yes      | 2         | PASS     | -                                                            |
| 74  | Modify CONSTRAINTS | Add constraint to DispatchRouter         | DispatchOps Round2 - | PASS   | 28.9s    | 31     | 10         | yes      | 1         | PASS     | -                                                            |
| 75  | Modify CONSTRAINTS | Add constraint to HumanEscalation        | DispatchOps Round2 - | PASS   | 25.2s    | 20     | 6          | yes      | 1         | PASS     | -                                                            |
| 76  | Topology Verify    | Verify topology #1 of DispatchOps Round2 | DispatchOps Round2 - | PASS   | 8.3s     | 364    | 1          | yes      | 0         | -        | -                                                            |
| 77  | Topology Verify    | Verify topology #2 of DispatchOps Round2 | DispatchOps Round2 - | PASS   | 8.2s     | 270    | 2          | yes      | 0         | -        | -                                                            |
| 78  | Mixed              | What guardrails should we add to improve | DispatchOps Round2 - | FAIL   | 34.9s    | 1970   | 7          | yes      | 0         | -        | blocking error event: MODEL_TOOL_PROTOCOL_ERROR; error codes |
| 79  | Mixed              | Analyze the handoff patterns between age | DispatchOps Round2 - | PASS   | 33.5s    | 1654   | 10         | yes      | 0         | -        | -                                                            |
| 80  | Read Agent         | Read DispatchRouter                      | DispatchOps Round2 n | PASS   | 16.3s    | 695    | 2          | yes      | 0         | -        | -                                                            |
| 81  | Read Agent         | Read EtaUpdateManager                    | DispatchOps Round2 n | PASS   | 12.2s    | 478    | 2          | yes      | 0         | -        | -                                                            |
| 82  | Read Agent         | Read HumanEscalationDesk                 | DispatchOps Round2 n | PASS   | 15.0s    | 517    | 2          | yes      | 0         | -        | -                                                            |
| 83  | Read Agent         | Read RescheduleManager                   | DispatchOps Round2 n | PASS   | 13.9s    | 548    | 2          | yes      | 0         | -        | -                                                            |
| 84  | Read Topology      | Topology of DispatchOps Round2 nsuccess  | DispatchOps Round2 n | PASS   | 9.2s     | 458    | 1          | yes      | 0         | -        | -                                                            |
| 85  | Health Check       | Health of DispatchOps Round2 nsuccess    | DispatchOps Round2 n | PASS   | 15.7s    | 892    | 3          | yes      | 0         | -        | -                                                            |
| 86  | Modify PERSONA     | DispatchRouter persona → new             | DispatchOps Round2 n | PASS   | 33.6s    | 144    | 6          | yes      | 1         | PASS     | -                                                            |
| 87  | Modify PERSONA     | EtaUpdateManager persona → new           | DispatchOps Round2 n | PASS   | 28.6s    | 264    | 6          | yes      | 0         | SKIP     | -                                                            |
| 88  | Modify LIMITATIONS | Add limitation to EtaUpdateManager       | DispatchOps Round2 n | PASS   | 29.2s    | 60     | 6          | yes      | 1         | PASS     | -                                                            |
| 89  | Modify LIMITATIONS | Add limitation to HumanEscalationDesk    | DispatchOps Round2 n | PASS   | 18.8s    | 183    | 5          | yes      | 0         | SKIP     | -                                                            |
| 90  | Modify GOAL        | Update goal of DispatchRouter            | DispatchOps Round2 n | PASS   | 20.6s    | 175    | 3          | yes      | 1         | PASS     | -                                                            |
| 91  | Modify GOAL        | Update goal of EtaUpdateManager          | DispatchOps Round2 n | PASS   | 20.9s    | 16     | 4          | yes      | 1         | PASS     | -                                                            |
| 92  | Add Agent          | Add AppointmentScheduler to DispatchOps  | DispatchOps Round2 n | PASS   | 40.0s    | 28     | 10         | yes      | 0         | SKIP     | -                                                            |
| 93  | Add Agent          | Add ReturnProcessor to DispatchOps Round | DispatchOps Round2 n | PASS   | 30.3s    | 19     | 5          | yes      | 2         | PASS     | -                                                            |
| 94  | Modify CONSTRAINTS | Add constraint to DispatchRouter         | DispatchOps Round2 n | PASS   | 17.4s    | 18     | 5          | yes      | 1         | PASS     | -                                                            |
| 95  | Modify CONSTRAINTS | Add constraint to EtaUpdateManager       | DispatchOps Round2 n | FAIL   | 28.9s    | 22     | 7          | yes      | 0         | SKIP     | blocking error event: MODEL_TOOL_PROTOCOL_ERROR; error codes |
| 96  | Topology Verify    | Verify topology #1 of DispatchOps Round2 | DispatchOps Round2 n | PASS   | 9.4s     | 433    | 1          | yes      | 0         | -        | -                                                            |
| 97  | Topology Verify    | Verify topology #2 of DispatchOps Round2 | DispatchOps Round2 n | PASS   | 9.2s     | 322    | 2          | yes      | 0         | -        | -                                                            |
| 98  | Mixed              | Which agents could benefit from adding G | DispatchOps Round2 n | PASS   | 27.0s    | 1262   | 8          | yes      | 0         | -        | -                                                            |
| 99  | Mixed              | Suggest a better conversation flow for t | DispatchOps Round2 n | PASS   | 17.7s    | 907    | 2          | yes      | 0         | -        | -                                                            |
| 100 | Mixed              | Summarize tools and responsibilities for | AppointmentHub       | PASS   | 16.7s    | 750    | 2          | yes      | 0         | -        | -                                                            |

---

## Failures & Errors

- **[78] Mixed**: What guardrails should we add to improve safety?
  - Project: DispatchOps Round2 -topthen
  - Status: FAIL
  - Error: blocking error event: MODEL_TOOL_PROTOCOL_ERROR; error codes: MODEL_TOOL_PROTOCOL_ERROR
  - Event contract: blocking error event: MODEL_TOOL_PROTOCOL_ERROR
  - Error codes: MODEL_TOOL_PROTOCOL_ERROR

- **[95] Modify CONSTRAINTS**: Add constraint to EtaUpdateManager
  - Project: DispatchOps Round2 nsuccess
  - Status: FAIL
  - Error: blocking error event: MODEL_TOOL_PROTOCOL_ERROR; error codes: MODEL_TOOL_PROTOCOL_ERROR
  - Event contract: blocking error event: MODEL_TOOL_PROTOCOL_ERROR
  - Error codes: MODEL_TOOL_PROTOCOL_ERROR
  - Approval: SKIP
