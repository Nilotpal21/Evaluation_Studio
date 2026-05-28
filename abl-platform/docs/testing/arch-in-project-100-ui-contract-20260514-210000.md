# Arch AI In-Project — 100 Scenario UI Contract Test Results

**Date**: 2026-05-14
**Mode**: CLI-driven Studio SSE + proposal approval contract
**Projects tested**: AppointmentHub, OrderHelp, DispatchOps Round2 isorflow, DispatchOps Round2 -topthen, DispatchOps Round2 nsuccess
**Total**: 100 | **Passed**: 99 | **Failed**: 1 | **Errors**: 0
**Pass Rate**: 99.0%

## **Contract Findings**: Event/order failures 0 | Busy/streaming 0 | Pending proposal 0 | Approval failures 0

## Category Summary

| Category           | Pass | Fail | Error | Rate |
| ------------------ | ---- | ---- | ----- | ---- |
| Read Agent         | 20   | 0    | 0     | 100% |
| Read Topology      | 5    | 0    | 0     | 100% |
| Health Check       | 5    | 0    | 0     | 100% |
| Modify PERSONA     | 10   | 0    | 0     | 100% |
| Modify LIMITATIONS | 10   | 0    | 0     | 100% |
| Modify GOAL        | 10   | 0    | 0     | 100% |
| Add Agent          | 10   | 0    | 0     | 100% |
| Modify CONSTRAINTS | 10   | 0    | 0     | 100% |
| Topology Verify    | 10   | 0    | 0     | 100% |
| Mixed              | 9    | 1    | 0     | 90%  |

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

| #   | Category           | Description                              | Project              | Status | Duration | Events | Tool Calls | Turn End | Artifacts | Approval | Error                 |
| --- | ------------------ | ---------------------------------------- | -------------------- | ------ | -------- | ------ | ---------- | -------- | --------- | -------- | --------------------- |
| 1   | Read Agent         | Read AvailabilityBookingSpecialist       | AppointmentHub       | PASS   | 24.5s    | 495    | 2          | yes      | 0         | -        | -                     |
| 2   | Read Agent         | Read BookingChangeSpecialist             | AppointmentHub       | PASS   | 10.6s    | 477    | 1          | yes      | 0         | -        | -                     |
| 3   | Read Agent         | Read ComplianceMonitor                   | AppointmentHub       | PASS   | 8.1s     | 290    | 1          | yes      | 0         | -        | -                     |
| 4   | Read Agent         | Read FeedbackCollector                   | AppointmentHub       | PASS   | 8.1s     | 319    | 1          | yes      | 0         | -        | -                     |
| 5   | Read Topology      | Topology of AppointmentHub               | AppointmentHub       | PASS   | 12.8s    | 535    | 1          | yes      | 0         | -        | -                     |
| 6   | Health Check       | Health of AppointmentHub                 | AppointmentHub       | PASS   | 16.9s    | 941    | 2          | yes      | 0         | -        | -                     |
| 7   | Modify PERSONA     | AvailabilityBookingSpecialist persona →  | AppointmentHub       | PASS   | 16.6s    | 14     | 3          | yes      | 1         | PASS     | -                     |
| 8   | Modify PERSONA     | BookingChangeSpecialist persona → warm   | AppointmentHub       | PASS   | 34.8s    | 23     | 6          | yes      | 1         | PASS     | -                     |
| 9   | Modify LIMITATIONS | Add limitation to BookingChangeSpecialis | AppointmentHub       | PASS   | 5.5s     | 117    | 2          | yes      | 0         | SKIP     | -                     |
| 10  | Modify LIMITATIONS | Add limitation to ComplianceMonitor      | AppointmentHub       | PASS   | 19.2s    | 135    | 4          | yes      | 1         | PASS     | -                     |
| 11  | Modify GOAL        | Update goal of AvailabilityBookingSpecia | AppointmentHub       | PASS   | 16.1s    | 129    | 4          | yes      | 0         | SKIP     | -                     |
| 12  | Modify GOAL        | Update goal of BookingChangeSpecialist   | AppointmentHub       | PASS   | 13.6s    | 117    | 4          | yes      | 0         | SKIP     | -                     |
| 13  | Add Agent          | Add FeedbackCollector to AppointmentHub  | AppointmentHub       | PASS   | 9.5s     | 230    | 3          | yes      | 0         | SKIP     | -                     |
| 14  | Add Agent          | Add ComplianceMonitor to AppointmentHub  | AppointmentHub       | PASS   | 6.8s     | 218    | 2          | yes      | 0         | SKIP     | -                     |
| 15  | Modify CONSTRAINTS | Add constraint to AvailabilityBookingSpe | AppointmentHub       | PASS   | 27.2s    | 26     | 9          | yes      | 1         | PASS     | -                     |
| 16  | Modify CONSTRAINTS | Add constraint to BookingChangeSpecialis | AppointmentHub       | PASS   | 51.5s    | 35     | 12         | yes      | 1         | PASS     | -                     |
| 17  | Topology Verify    | Verify topology #1 of AppointmentHub     | AppointmentHub       | PASS   | 10.3s    | 407    | 2          | yes      | 0         | -        | -                     |
| 18  | Topology Verify    | Verify topology #2 of AppointmentHub     | AppointmentHub       | PASS   | 8.7s     | 322    | 2          | yes      | 0         | -        | -                     |
| 19  | Mixed              | What agents does this project have and w | AppointmentHub       | PASS   | 9.8s     | 375    | 2          | yes      | 0         | -        | -                     |
| 20  | Mixed              | Are there any issues with the current ag | AppointmentHub       | PASS   | 18.1s    | 877    | 3          | yes      | 0         | -        | -                     |
| 21  | Read Agent         | Read EscalationHandler                   | OrderHelp            | PASS   | 8.7s     | 329    | 1          | yes      | 0         | -        | -                     |
| 22  | Read Agent         | Read HumanEscalationSpecialist           | OrderHelp            | PASS   | 11.9s    | 420    | 2          | yes      | 0         | -        | -                     |
| 23  | Read Agent         | Read OrderStatusSpecialist               | OrderHelp            | PASS   | 14.3s    | 465    | 1          | yes      | 0         | -        | -                     |
| 24  | Read Agent         | Read ProductAccountFAQSpecialist         | OrderHelp            | PASS   | 10.3s    | 409    | 1          | yes      | 0         | -        | -                     |
| 25  | Read Topology      | Topology of OrderHelp                    | OrderHelp            | PASS   | 10.5s    | 579    | 1          | yes      | 0         | -        | -                     |
| 26  | Health Check       | Health of OrderHelp                      | OrderHelp            | PASS   | 15.4s    | 730    | 2          | yes      | 0         | -        | -                     |
| 27  | Modify PERSONA     | EscalationHandler persona → formal       | OrderHelp            | PASS   | 33.2s    | 25     | 7          | yes      | 1         | PASS     | -                     |
| 28  | Modify PERSONA     | HumanEscalationSpecialist persona → casu | OrderHelp            | PASS   | 19.0s    | 14     | 3          | yes      | 1         | PASS     | -                     |
| 29  | Modify LIMITATIONS | Add limitation to HumanEscalationSpecial | OrderHelp            | PASS   | 11.8s    | 119    | 4          | yes      | 0         | SKIP     | -                     |
| 30  | Modify LIMITATIONS | Add limitation to OrderStatusSpecialist  | OrderHelp            | PASS   | 5.8s     | 140    | 2          | yes      | 0         | SKIP     | -                     |
| 31  | Modify GOAL        | Update goal of EscalationHandler         | OrderHelp            | PASS   | 13.1s    | 199    | 3          | yes      | 1         | PASS     | -                     |
| 32  | Modify GOAL        | Update goal of HumanEscalationSpecialist | OrderHelp            | PASS   | 13.9s    | 215    | 3          | yes      | 0         | SKIP     | -                     |
| 33  | Add Agent          | Add KnowledgeHelper to OrderHelp         | OrderHelp            | PASS   | 32.1s    | 191    | 8          | yes      | 2         | PASS     | -                     |
| 34  | Add Agent          | Add EscalationHandler to OrderHelp       | OrderHelp            | PASS   | 11.7s    | 458    | 2          | yes      | 0         | SKIP     | -                     |
| 35  | Modify CONSTRAINTS | Add constraint to EscalationHandler      | OrderHelp            | PASS   | 37.8s    | 28     | 9          | yes      | 1         | PASS     | -                     |
| 36  | Modify CONSTRAINTS | Add constraint to HumanEscalationSpecial | OrderHelp            | PASS   | 24.7s    | 18     | 5          | yes      | 1         | PASS     | -                     |
| 37  | Topology Verify    | Verify topology #1 of OrderHelp          | OrderHelp            | PASS   | 10.1s    | 495    | 1          | yes      | 0         | -        | -                     |
| 38  | Topology Verify    | Verify topology #2 of OrderHelp          | OrderHelp            | PASS   | 11.3s    | 415    | 9          | yes      | 0         | -        | -                     |
| 39  | Mixed              | Suggest improvements for the supervisor  | OrderHelp            | PASS   | 25.4s    | 1617   | 5          | yes      | 0         | -        | -                     |
| 40  | Mixed              | Which agent handles the most critical us | OrderHelp            | PASS   | 7.7s     | 271    | 2          | yes      | 0         | -        | -                     |
| 41  | Read Agent         | Read AnalyticsReporter                   | DispatchOps Round2 i | PASS   | 8.1s     | 319    | 1          | yes      | 0         | -        | -                     |
| 42  | Read Agent         | Read DispatchOpsRound2IsorflowIntakeAgen | DispatchOps Round2 i | PASS   | 13.6s    | 595    | 2          | yes      | 0         | -        | -                     |
| 43  | Read Agent         | Read DispatchOpsRound2IsorflowProcessorA | DispatchOps Round2 i | PASS   | 10.5s    | 509    | 2          | yes      | 0         | -        | -                     |
| 44  | Read Agent         | Read DispatchOpsRound2IsorflowReviewerAg | DispatchOps Round2 i | PASS   | 16.0s    | 566    | 2          | yes      | 0         | -        | -                     |
| 45  | Read Topology      | Topology of DispatchOps Round2 isorflow  | DispatchOps Round2 i | PASS   | 11.7s    | 396    | 1          | yes      | 0         | -        | -                     |
| 46  | Health Check       | Health of DispatchOps Round2 isorflow    | DispatchOps Round2 i | PASS   | 12.3s    | 657    | 4          | yes      | 0         | -        | -                     |
| 47  | Modify PERSONA     | AnalyticsReporter persona → patient      | DispatchOps Round2 i | PASS   | 19.9s    | 14     | 3          | yes      | 1         | PASS     | -                     |
| 48  | Modify PERSONA     | DispatchOpsRound2IsorflowIntakeAgent per | DispatchOps Round2 i | PASS   | 20.5s    | 193    | 5          | yes      | 0         | SKIP     | -                     |
| 49  | Modify LIMITATIONS | Add limitation to DispatchOpsRound2Isorf | DispatchOps Round2 i | PASS   | 20.1s    | 155    | 3          | yes      | 1         | PASS     | -                     |
| 50  | Modify LIMITATIONS | Add limitation to DispatchOpsRound2Isorf | DispatchOps Round2 i | PASS   | 21.5s    | 19     | 5          | yes      | 0         | SKIP     | -                     |
| 51  | Modify GOAL        | Update goal of AnalyticsReporter         | DispatchOps Round2 i | PASS   | 22.0s    | 117    | 6          | yes      | 0         | SKIP     | -                     |
| 52  | Modify GOAL        | Update goal of DispatchOpsRound2Isorflow | DispatchOps Round2 i | PASS   | 29.4s    | 182    | 6          | yes      | 1         | PASS     | -                     |
| 53  | Add Agent          | Add AnalyticsReporter to DispatchOps Rou | DispatchOps Round2 i | PASS   | 10.5s    | 181    | 2          | yes      | 0         | SKIP     | -                     |
| 54  | Add Agent          | Add OnboardingGuide to DispatchOps Round | DispatchOps Round2 i | PASS   | 11.3s    | 222    | 2          | yes      | 0         | SKIP     | -                     |
| 55  | Modify CONSTRAINTS | Add constraint to AnalyticsReporter      | DispatchOps Round2 i | PASS   | 23.1s    | 18     | 5          | yes      | 1         | PASS     | -                     |
| 56  | Modify CONSTRAINTS | Add constraint to DispatchOpsRound2Isorf | DispatchOps Round2 i | PASS   | 25.0s    | 18     | 5          | yes      | 1         | PASS     | -                     |
| 57  | Topology Verify    | Verify topology #1 of DispatchOps Round2 | DispatchOps Round2 i | PASS   | 8.5s     | 366    | 2          | yes      | 0         | -        | -                     |
| 58  | Topology Verify    | Verify topology #2 of DispatchOps Round2 | DispatchOps Round2 i | PASS   | 9.3s     | 230    | 2          | yes      | 0         | -        | -                     |
| 59  | Mixed              | Are there any missing capabilities in th | DispatchOps Round2 i | PASS   | 18.7s    | 789    | 3          | yes      | 0         | -        | -                     |
| 60  | Mixed              | How could we improve error handling acro | DispatchOps Round2 i | FAIL   | 40.5s    | 43     | 14         | yes      | 1         | -        | pass criteria not met |
| 61  | Read Agent         | Read DispatchRouter                      | DispatchOps Round2 - | PASS   | 19.0s    | 674    | 2          | yes      | 0         | -        | -                     |
| 62  | Read Agent         | Read HumanEscalation                     | DispatchOps Round2 - | PASS   | 11.9s    | 581    | 1          | yes      | 0         | -        | -                     |
| 63  | Read Agent         | Read IntakeAndDispatch                   | DispatchOps Round2 - | PASS   | 14.3s    | 630    | 2          | yes      | 0         | -        | -                     |
| 64  | Read Agent         | Read RescheduleManager                   | DispatchOps Round2 - | PASS   | 13.7s    | 593    | 2          | yes      | 0         | -        | -                     |
| 65  | Read Topology      | Topology of DispatchOps Round2 -topthen  | DispatchOps Round2 - | PASS   | 14.7s    | 448    | 1          | yes      | 0         | -        | -                     |
| 66  | Health Check       | Health of DispatchOps Round2 -topthen    | DispatchOps Round2 - | PASS   | 12.4s    | 703    | 2          | yes      | 0         | -        | -                     |
| 67  | Modify PERSONA     | DispatchRouter persona → new             | DispatchOps Round2 - | PASS   | 22.5s    | 206    | 3          | yes      | 1         | PASS     | -                     |
| 68  | Modify PERSONA     | HumanEscalation persona → new            | DispatchOps Round2 - | PASS   | 39.7s    | 23     | 6          | yes      | 1         | PASS     | -                     |
| 69  | Modify LIMITATIONS | Add limitation to HumanEscalation        | DispatchOps Round2 - | PASS   | 10.0s    | 76     | 1          | yes      | 0         | SKIP     | -                     |
| 70  | Modify LIMITATIONS | Add limitation to IntakeAndDispatch      | DispatchOps Round2 - | PASS   | 23.4s    | 10     | 2          | yes      | 0         | SKIP     | -                     |
| 71  | Modify GOAL        | Update goal of DispatchRouter            | DispatchOps Round2 - | PASS   | 16.7s    | 245    | 3          | yes      | 1         | PASS     | -                     |
| 72  | Modify GOAL        | Update goal of HumanEscalation           | DispatchOps Round2 - | PASS   | 37.5s    | 261    | 6          | yes      | 1         | PASS     | -                     |
| 73  | Add Agent          | Add BillingAssistant to DispatchOps Roun | DispatchOps Round2 - | PASS   | 32.2s    | 211    | 6          | yes      | 2         | PASS     | -                     |
| 74  | Add Agent          | Add TechDiagnostic to DispatchOps Round2 | DispatchOps Round2 - | PASS   | 6.7s     | 213    | 2          | yes      | 0         | SKIP     | -                     |
| 75  | Modify CONSTRAINTS | Add constraint to DispatchRouter         | DispatchOps Round2 - | PASS   | 25.7s    | 22     | 7          | yes      | 1         | PASS     | -                     |
| 76  | Modify CONSTRAINTS | Add constraint to HumanEscalation        | DispatchOps Round2 - | PASS   | 22.6s    | 20     | 6          | yes      | 1         | PASS     | -                     |
| 77  | Topology Verify    | Verify topology #1 of DispatchOps Round2 | DispatchOps Round2 - | PASS   | 12.4s    | 413    | 2          | yes      | 0         | -        | -                     |
| 78  | Topology Verify    | Verify topology #2 of DispatchOps Round2 | DispatchOps Round2 - | PASS   | 9.0s     | 262    | 2          | yes      | 0         | -        | -                     |
| 79  | Mixed              | What guardrails should we add to improve | DispatchOps Round2 - | PASS   | 34.1s    | 2038   | 3          | yes      | 0         | -        | -                     |
| 80  | Mixed              | Analyze the handoff patterns between age | DispatchOps Round2 - | PASS   | 27.6s    | 1483   | 6          | yes      | 0         | -        | -                     |
| 81  | Read Agent         | Read DispatchRouter                      | DispatchOps Round2 n | PASS   | 12.3s    | 639    | 1          | yes      | 0         | -        | -                     |
| 82  | Read Agent         | Read EtaUpdateManager                    | DispatchOps Round2 n | PASS   | 15.4s    | 456    | 1          | yes      | 0         | -        | -                     |
| 83  | Read Agent         | Read HumanEscalationDesk                 | DispatchOps Round2 n | PASS   | 12.3s    | 590    | 2          | yes      | 0         | -        | -                     |
| 84  | Read Agent         | Read RescheduleManager                   | DispatchOps Round2 n | PASS   | 14.4s    | 661    | 2          | yes      | 0         | -        | -                     |
| 85  | Read Topology      | Topology of DispatchOps Round2 nsuccess  | DispatchOps Round2 n | PASS   | 16.2s    | 597    | 1          | yes      | 0         | -        | -                     |
| 86  | Health Check       | Health of DispatchOps Round2 nsuccess    | DispatchOps Round2 n | PASS   | 15.4s    | 813    | 2          | yes      | 0         | -        | -                     |
| 87  | Modify PERSONA     | DispatchRouter persona → new             | DispatchOps Round2 n | PASS   | 28.0s    | 101    | 5          | yes      | 1         | PASS     | -                     |
| 88  | Modify PERSONA     | EtaUpdateManager persona → new           | DispatchOps Round2 n | PASS   | 30.4s    | 18     | 5          | yes      | 1         | PASS     | -                     |
| 89  | Modify LIMITATIONS | Add limitation to EtaUpdateManager       | DispatchOps Round2 n | PASS   | 6.7s     | 89     | 2          | yes      | 0         | SKIP     | -                     |
| 90  | Modify LIMITATIONS | Add limitation to HumanEscalationDesk    | DispatchOps Round2 n | PASS   | 31.1s    | 173    | 5          | yes      | 1         | PASS     | -                     |
| 91  | Modify GOAL        | Update goal of DispatchRouter            | DispatchOps Round2 n | PASS   | 15.9s    | 90     | 4          | yes      | 0         | SKIP     | -                     |
| 92  | Modify GOAL        | Update goal of EtaUpdateManager          | DispatchOps Round2 n | PASS   | 20.0s    | 145    | 3          | yes      | 1         | PASS     | -                     |
| 93  | Add Agent          | Add AppointmentScheduler to DispatchOps  | DispatchOps Round2 n | PASS   | 28.7s    | 23     | 7          | yes      | 1         | PASS     | -                     |
| 94  | Add Agent          | Add ReturnProcessor to DispatchOps Round | DispatchOps Round2 n | PASS   | 8.5s     | 199    | 6          | yes      | 0         | SKIP     | -                     |
| 95  | Modify CONSTRAINTS | Add constraint to DispatchRouter         | DispatchOps Round2 n | PASS   | 20.0s    | 20     | 6          | yes      | 1         | PASS     | -                     |
| 96  | Modify CONSTRAINTS | Add constraint to EtaUpdateManager       | DispatchOps Round2 n | PASS   | 41.9s    | 33     | 10         | yes      | 2         | PASS     | -                     |
| 97  | Topology Verify    | Verify topology #1 of DispatchOps Round2 | DispatchOps Round2 n | PASS   | 9.1s     | 464    | 1          | yes      | 0         | -        | -                     |
| 98  | Topology Verify    | Verify topology #2 of DispatchOps Round2 | DispatchOps Round2 n | PASS   | 6.9s     | 276    | 2          | yes      | 0         | -        | -                     |
| 99  | Mixed              | Which agents could benefit from adding G | DispatchOps Round2 n | PASS   | 26.3s    | 1149   | 8          | yes      | 0         | -        | -                     |
| 100 | Mixed              | Suggest a better conversation flow for t | DispatchOps Round2 n | PASS   | 23.6s    | 1047   | 3          | yes      | 0         | -        | -                     |

---

## Failures & Errors

- **[60] Mixed**: How could we improve error handling across all age
  - Project: DispatchOps Round2 isorflow
  - Status: FAIL
  - Error: pass criteria not met
